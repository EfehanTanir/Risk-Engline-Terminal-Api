"""TEFAS data access.

Price history + portfolio allocation come through the official `tefas-crawler`
library (which merges BindHistoryInfo and BindHistoryAllocation into one
DataFrame with English column names). TEFAS caps each query at ~3 months, so
long ranges are fetched in 60-day chunks.

The searchable fund universe (with period returns) comes from the
BindComparisonFundReturns endpoint, which tefas-crawler does not wrap.
"""
from __future__ import annotations

import concurrent.futures
import datetime as dt
import math
import threading
import time
from typing import Optional

import pandas as pd
import requests
from tefas import Crawler

# One Crawler per thread: tefas-crawler shares a requests.Session, which is not
# thread-safe, and serverless timeouts force us to fetch chunks in parallel.
_tls = threading.local()


def _get_crawler() -> Crawler:
    if not hasattr(_tls, "crawler"):
        _tls.crawler = Crawler()
    return _tls.crawler

INFO_COLUMNS = {
    "date", "price", "code", "title", "market_cap",
    "number_of_shares", "number_of_investors",
}

TEFAS_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": "https://www.tefas.gov.tr",
    "Referer": "https://www.tefas.gov.tr/KarsilastirmaliAnaliz.aspx",
}


def _tr_upper(s: str) -> str:
    return s.replace("i", "İ").replace("ı", "I").upper()


def _fetch_chunk(code: str, start: dt.date, end: dt.date) -> Optional[pd.DataFrame]:
    try:
        df = _get_crawler().fetch(start=start.isoformat(), end=end.isoformat(), name=code)
        return df if df is not None and len(df) else None
    except Exception:
        return None  # transient TEFAS hiccups: keep whatever chunks succeed


def fund_history(code: str, days: int = 380) -> Optional[pd.DataFrame]:
    """1Y-ish merged info+allocation history, fetched as parallel 60-day chunks
    to respect TEFAS's ~3-month query limit while staying fast on serverless."""
    code = _tr_upper(code.strip())
    end = dt.date.today()
    start = end - dt.timedelta(days=days)
    windows = []
    cur = start
    while cur <= end:
        chunk_end = min(cur + dt.timedelta(days=59), end)
        windows.append((cur, chunk_end))
        cur = chunk_end + dt.timedelta(days=1)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda w: _fetch_chunk(code, w[0], w[1]), windows))
    frames = [df for df in results if df is not None]
    if not frames:
        return None
    df = pd.concat(frames, ignore_index=True)
    df = df.drop_duplicates(subset="date").sort_values("date").reset_index(drop=True)
    df = df[pd.to_numeric(df["price"], errors="coerce") > 0]
    return df if len(df) else None


# Columns tefas-crawler returns that are NOT asset-class percentages
NON_ALLOCATION = INFO_COLUMNS | {
    "category_total", "category_rank", "rank", "market_share",
    "periodic_return", "tmm",
}

# TEFAS BindHistoryAllocation short codes -> human labels (direct-endpoint fallback)
ALLOCATION_LABELS = {
    "BB": "Bank Bills", "BYF": "ETFs", "D": "Other", "DB": "FX Bills",
    "DT": "Government Bonds", "DÖT": "FX-Payable Bonds", "EUT": "Eurobonds",
    "FB": "Fund Participation", "FKB": "Lease Certificates (Foreign)",
    "GAS": "Real Estate Certificates", "GSYKB": "Venture Capital Inv.",
    "GYKB": "Real Estate Inv.", "HB": "Treasury Bills", "HS": "Equities",
    "KBA": "Precious Metal Bills", "KH": "Public Lease Certificates",
    "KKS": "Private Lease Certificates", "KM": "Precious Metals",
    "KMKB": "Precious Metal Lease Cert.", "OSA": "Private Sector Lease Cert.",
    "OST": "Corporate Bonds", "R": "Repo", "T": "Bills",
    "TPP": "FX Deposit/Participation", "TR": "Reverse Repo", "VM": "Term Deposit",
    "VDM": "Term Deposit", "Vİ": "Derivatives", "YBA": "Foreign Bank Bills",
    "YBOSB": "Foreign Corporate Debt", "YHS": "Foreign Equities",
    "YMK": "Foreign Securities", "YYF": "Foreign Funds", "TDÖT": "Gov. FX Bonds",
}


def _valid_slices(pairs) -> Optional[list[dict]]:
    """Keep 0–100% values; accept the row only if they sum to roughly 100%."""
    slices, total = [], 0.0
    for code, label, value in pairs:
        try:
            pct = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(pct) and 0.01 < pct <= 100.0:
            slices.append({"code": code, "label": label, "pct": pct})
            total += pct
    if slices and 50.0 <= total <= 150.0:
        slices.sort(key=lambda s: -s["pct"])
        return slices
    return None


def _allocation_direct(code: str) -> Optional[dict]:
    """Fallback: query BindHistoryAllocation directly (short Turkish codes)."""
    end = dt.date.today()
    start = end - dt.timedelta(days=30)
    resp = requests.post(
        "https://www.tefas.gov.tr/api/DB/BindHistoryAllocation",
        data={
            "fontip": "YAT", "sfontur": "", "fonkod": code, "fongrup": "",
            "bastarih": start.strftime("%d.%m.%Y"),
            "bittarih": end.strftime("%d.%m.%Y"),
            "fonturkod": "", "fonunvantip": "",
        },
        headers=TEFAS_HEADERS, timeout=20,
    )
    resp.raise_for_status()
    rows = resp.json().get("data", [])
    rows.sort(key=lambda r: int(r.get("TARIH") or 0))
    skip = {"TARIH", "FONKODU", "FONUNVAN", "BilFiyat"}
    for row in reversed(rows):
        slices = _valid_slices(
            (k, ALLOCATION_LABELS.get(k, k), v) for k, v in row.items() if k not in skip
        )
        if slices:
            date = dt.datetime.fromtimestamp(int(row["TARIH"]) / 1000, dt.timezone.utc).date()
            return {"date": str(date), "slices": slices}
    return None


def latest_allocation(df: pd.DataFrame, code: Optional[str] = None) -> Optional[dict]:
    """Asset-class percentages from the most recent row that has a valid
    breakdown. TEFAS publishes the breakdown with a lag (and tefas-crawler's
    merged frame sometimes lacks it entirely), so walk backwards through the
    crawler data first, then fall back to the raw TEFAS endpoint."""
    alloc_cols = [c for c in df.columns if c not in NON_ALLOCATION]
    for idx in range(len(df) - 1, max(len(df) - 20, -1), -1):
        row = df.iloc[idx]
        slices = _valid_slices(
            (col, col.replace("_", " ").title(), row[col]) for col in alloc_cols
        )
        if slices:
            return {"date": str(pd.Timestamp(row["date"]).date()), "slices": slices}
    if code:
        try:
            return _allocation_direct(_tr_upper(code.strip()))
        except Exception:
            return None
    return None


# ---- Fund universe (cached ~6h) -----------------------------------------

_fund_list_cache: dict = {"t": 0.0, "data": None}
_fund_list_lock = threading.Lock()


def _num_or_none(v):
    try:
        f = float(v)
        return f if f == f else None  # NaN check
    except (TypeError, ValueError):
        return None


def fund_list() -> list[dict]:
    now = time.time()
    if _fund_list_cache["data"] is not None and now - _fund_list_cache["t"] < 6 * 3600:
        return _fund_list_cache["data"]
    with _fund_list_lock:
        if _fund_list_cache["data"] is not None and now - _fund_list_cache["t"] < 6 * 3600:
            return _fund_list_cache["data"]
        end = dt.date.today()
        start = end - dt.timedelta(days=7)
        body = {
            "calismatipi": "2", "fontip": "YAT", "sfontur": "", "kurucukod": "",
            "fongrup": "", "bastarih": start.strftime("%d.%m.%Y"),
            "bittarih": end.strftime("%d.%m.%Y"), "fonturkod": "",
            "fonunvantip": "", "strperiod": "1,1,1,1,1,1,1", "islemdurum": "1",
        }
        resp = requests.post(
            "https://www.tefas.gov.tr/api/DB/BindComparisonFundReturns",
            data=body, headers=TEFAS_HEADERS, timeout=20,
        )
        resp.raise_for_status()
        rows = resp.json().get("data", [])
        data = []
        for r in rows:
            if not r.get("FONKODU"):
                continue
            data.append({
                "code": r["FONKODU"],
                "title": r.get("FONUNVAN"),
                "category": r.get("FONTURACIKLAMA"),
                "returns": {
                    "1m": _num_or_none(r.get("GETIRI1A")),
                    "3m": _num_or_none(r.get("GETIRI3A")),
                    "6m": _num_or_none(r.get("GETIRI6A")),
                    "ytd": _num_or_none(r.get("GETIRIYB", r.get("GETIRIYIL"))),
                    "1y": _num_or_none(r.get("GETIRI1Y")),
                    "3y": _num_or_none(r.get("GETIRI3Y")),
                    "5y": _num_or_none(r.get("GETIRI5Y")),
                },
            })
        _fund_list_cache.update(t=now, data=data)
        return data


def search_funds(q: str, limit: int = 12) -> list[dict]:
    qq = _tr_upper(q)
    funds = fund_list()
    code_hits = [f for f in funds if f["code"].startswith(qq)]
    name_hits = [
        f for f in funds
        if f not in code_hits and qq in _tr_upper(f.get("title") or "")
    ]
    return (code_hits + name_hits)[:limit]
