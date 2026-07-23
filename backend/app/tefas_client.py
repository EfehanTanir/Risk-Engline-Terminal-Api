"""TEFAS data access.

Price history comes through the official `tefas-crawler` library. Everything
else uses TEFAS's current JSON API (https://www.tefas.gov.tr/api/funds/...),
which replaced the old /api/DB form endpoints in 2026:

  fonGetiriBazliBilgiGetir  -> fund universe with period returns (search)
  fonBilgiGetir             -> live AUM / investors / shares / category
  dagilimSiraliGetirT       -> portfolio asset-class breakdown (allocation)

TEFAS caps history queries at ~3 months, so long ranges are fetched in
parallel 60-day chunks.
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

API_BASE = "https://www.tefas.gov.tr/api/funds"

JSON_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "*/*",
    "Origin": "https://www.tefas.gov.tr",
    "Referer": "https://www.tefas.gov.tr/tr/fon-verileri",
}


def _api_post(endpoint: str, payload: dict) -> list[dict]:
    resp = requests.post(f"{API_BASE}/{endpoint}", json=payload,
                         headers=JSON_HEADERS, timeout=25)
    resp.raise_for_status()
    data = resp.json()
    if data.get("errorMessage"):
        raise RuntimeError(f"TEFAS {endpoint}: {data['errorMessage']}")
    return data.get("resultList") or []


def _tr_upper(s: str) -> str:
    return s.replace("i", "İ").replace("ı", "I").upper()


def _num_or_none(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


# ---- Price history (tefas-crawler) --------------------------------------

def _fetch_chunk(code: str, start: dt.date, end: dt.date) -> Optional[pd.DataFrame]:
    try:
        df = _get_crawler().fetch(start=start.isoformat(), end=end.isoformat(), name=code)
        return df if df is not None and len(df) else None
    except Exception:
        return None  # transient TEFAS hiccups: keep whatever chunks succeed


def fund_history(code: str, days: int = 380) -> Optional[pd.DataFrame]:
    """1Y-ish price history, fetched as parallel 60-day chunks to respect
    TEFAS's ~3-month query limit while staying fast on serverless."""
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


# ---- Live fund info (AUM, investors, category) ---------------------------

def fund_info(code: str) -> Optional[dict]:
    rows = _api_post("fonBilgiGetir", {"fonKodu": _tr_upper(code.strip()), "dil": "TR"})
    if not rows:
        return None
    r = rows[0]
    return {
        "title": r.get("fonUnvan"),
        "price": _num_or_none(r.get("sonFiyat")),
        "dailyReturn": _num_or_none(r.get("gunlukGetiri")),
        "aum": _num_or_none(r.get("portBuyukluk")),
        "investors": _num_or_none(r.get("yatirimciSayi")),
        "shares": _num_or_none(r.get("payAdet")),
        "category": r.get("fonKategori"),
        "categoryRank": _num_or_none(r.get("kategoriDerece")),
        "categoryCount": _num_or_none(r.get("kategoriFonSay")),
        "marketShare": _num_or_none(r.get("pazarPayi")),
    }


# ---- Portfolio allocation ------------------------------------------------

# dagilimSiraliGetirT column codes -> human labels (codes arrive lowercase)
ALLOCATION_LABELS = {
    "BB": "Bank Bills", "BPP": "Exchange Money Market", "BYF": "ETFs",
    "D": "Other", "DB": "FX Bills", "DT": "Government Bonds",
    "DOT": "FX-Payable Gov. Bonds", "EUT": "Eurobonds", "FB": "Fund Participation",
    "FKB": "Foreign Lease Certificates", "GAS": "Real Estate Certificates",
    "GSYKB": "Venture Capital Funds", "GSYY": "Venture Capital Trusts",
    "GYKB": "Real Estate Funds", "GYY": "Real Estate Trusts",
    "HB": "Treasury Bills", "HS": "Equities", "KBA": "Precious Metal Bills",
    "KH": "Public Lease Certificates", "KHAU": "Public Lease Cert. (Gold)",
    "KHD": "Public Lease Cert. (FX)", "KHTL": "Public Lease Cert. (TL)",
    "KKS": "Private Lease Certificates", "KKSD": "Private Lease Cert. (FX)",
    "KKSTL": "Private Lease Cert. (TL)", "KKSYD": "Private Lease Cert. (Foreign)",
    "KM": "Precious Metals", "KMBYF": "Precious Metal ETFs",
    "KMKBA": "Precious Metal Bills", "KMKKS": "Precious Metal Lease Cert.",
    "OSKS": "Private Sector Lease Cert.", "OST": "Corporate Bonds",
    "OSDB": "Private Sector Foreign Debt", "R": "Repo", "T": "Bills",
    "TPP": "FX Deposit/Participation", "TR": "Reverse Repo",
    "VDM": "Term Deposit", "VM": "Term Deposit", "VMAU": "Term Deposit (Gold)",
    "VMD": "Term Deposit (FX)", "VMTL": "Term Deposit (TL)",
    "VINT": "Futures Cash Collateral", "YBA": "Foreign Bank Bills",
    "YBKB": "Foreign Public Debt", "YBOSB": "Foreign Corporate Debt",
    "YBYF": "Foreign ETFs", "YHS": "Foreign Equities",
    "YMK": "Foreign Securities", "YYF": "Foreign Funds",
}

# Columns tefas-crawler returns that are NOT asset-class percentages
NON_ALLOCATION = INFO_COLUMNS | {
    "category_total", "category_rank", "rank", "market_share",
    "periodic_return", "tmm",
}


def _valid_slices(pairs) -> Optional[list[dict]]:
    """Keep 0–100% values; accept the row only if they sum to roughly 100%."""
    slices, total = [], 0.0
    for code, label, value in pairs:
        pct = _num_or_none(value)
        if pct is not None and 0.01 < pct <= 100.0:
            slices.append({"code": code, "label": label, "pct": pct})
            total += pct
    if slices and 50.0 <= total <= 150.0:
        slices.sort(key=lambda s: -s["pct"])
        return slices
    return None


def _allocation_direct(code: str) -> Optional[dict]:
    """Query dagilimSiraliGetirT for the fund's latest asset-class breakdown."""
    end = dt.date.today()
    start = end - dt.timedelta(days=9)
    payload = {
        "fonTipi": "YAT", "fonKodu": None, "aramaMetni": None,
        "fonTurKod": None, "fonGrubu": None, "sfonTurKod": None,
        "fonTurAciklama": None, "kurucuKod": None,
        "basTarih": start.strftime("%Y%m%d"), "bitTarih": end.strftime("%Y%m%d"),
        "basSira": 1, "bitSira": 100000, "dil": "TR",
        "fonKod": code, "fonGrup": "", "fonUnvanTip": "",
    }
    rows = [r for r in _api_post("dagilimSiraliGetirT", payload)
            if r.get("fonKodu") == code]
    rows.sort(key=lambda r: r.get("tarih") or "")
    skip = {"fonKodu", "fonUnvan", "tarih", "bilFiyat"}
    for row in reversed(rows):
        slices = _valid_slices(
            (k.upper(), ALLOCATION_LABELS.get(k.upper(), k.upper()), v)
            for k, v in row.items() if k not in skip
        )
        if slices:
            return {"date": str(row.get("tarih")), "slices": slices}
    return None


def latest_allocation(df: pd.DataFrame, code: Optional[str] = None) -> Optional[dict]:
    """Asset-class percentages: try tefas-crawler's merged frame first (older
    library versions include breakdown columns), then the direct endpoint."""
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


def fund_list() -> list[dict]:
    now = time.time()
    if _fund_list_cache["data"] is not None and now - _fund_list_cache["t"] < 6 * 3600:
        return _fund_list_cache["data"]
    with _fund_list_lock:
        if _fund_list_cache["data"] is not None and now - _fund_list_cache["t"] < 6 * 3600:
            return _fund_list_cache["data"]
        payload = {
            "dil": "TR", "fonTipi": "YAT", "kurucuKodu": None,
            "sfonTurKod": None, "fonTurAciklama": None, "islem": 1,
            "fonTurKod": None, "fonGrubu": None,
            "donemGetiri1a": "1", "donemGetiri3a": "1", "donemGetiri6a": "1",
            "donemGetiri1y": "1", "donemGetiriyb": "1", "donemGetiri3y": "1",
            "donemGetiri5y": "1", "basTarih": None, "bitTarih": None,
            "calismaTipi": 2, "getiriOrani": "1",
        }
        rows = _api_post("fonGetiriBazliBilgiGetir", payload)
        data = []
        for r in rows:
            if not r.get("fonKodu"):
                continue
            data.append({
                "code": r["fonKodu"],
                "title": r.get("fonUnvan"),
                "category": r.get("fonTurAciklama"),
                "riskValue": r.get("riskDegeri"),
                "returns": {
                    "1m": _num_or_none(r.get("getiri1a")),
                    "3m": _num_or_none(r.get("getiri3a")),
                    "6m": _num_or_none(r.get("getiri6a")),
                    "ytd": _num_or_none(r.get("getiriyb")),
                    "1y": _num_or_none(r.get("getiri1y")),
                    "3y": _num_or_none(r.get("getiri3y")),
                    "5y": _num_or_none(r.get("getiri5y")),
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
