# Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
# SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

"""FINANSLA TERMINAL API — FastAPI backend.

Data sources: Yahoo Finance (yfinance), TEFAS (tefas-crawler + comparison
endpoint), Google News RSS. Run locally with:

    uvicorn app.main:app --reload --port 8000
"""
from __future__ import annotations

import concurrent.futures
import math
import time
from typing import Literal, Optional

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import admin as admin_mod
from . import backtest as backtest_mod
from . import gold as gold_mod
from . import news as news_mod
from . import risk
from . import tefas_client as tefas
from . import yahoo

# Simplifying assumptions, surfaced in every payload rather than hidden
RF_TRY = 0.40   # TRY policy/deposit-rate proxy
RF_USD = 0.045
MAX_ASSETS = 10
MC_SIMS = 20_000

app = FastAPI(title="Finansla Terminal API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Admin panel: health checks, visitor analytics, and the public /api/track
# beacon. Everything it needs is optional, so a missing ADMIN_TOTP_SECRET or
# Upstash config degrades the panel without touching the rest of the API.
app.include_router(admin_mod.router)


@app.middleware("http")
async def _count_requests(request, call_next):
    admin_mod.note_request()
    return await call_next(request)


@app.get("/")
def root():
    return {
        "name": "FINANSLA TERMINAL API",
        "endpoints": [
            "/api/search?q=THYAO", "/api/quotes?symbols=XU100.IS,USDTRY=X",
            "/api/stock?symbol=THYAO.IS", "/api/fund?code=NNF",
            "/api/news?q=Turkish+Airlines&lang=tr", "POST /api/portfolio",
        ],
    }


# ---- search --------------------------------------------------------------

@app.get("/api/search")
def api_search(q: str = Query(..., min_length=1)):
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        f_stocks = pool.submit(yahoo.search, q, 12)
        f_funds = pool.submit(tefas.search_funds, q, 12)
        stocks, funds = [], []
        try:
            stocks = f_stocks.result(timeout=15)
        except Exception:
            pass
        try:
            funds = f_funds.result(timeout=20)
        except Exception:
            pass
    return {"query": q, "stocks": stocks, "funds": funds}


# ---- quotes (ticker tape) ------------------------------------------------

@app.get("/api/quotes")
def api_quotes(symbols: str = Query(...)):
    syms = [s.strip() for s in symbols.split(",") if s.strip()][:15]
    return {"quotes": yahoo.quotes(syms)}


# ---- stock detail --------------------------------------------------------

# ---- gold (spot + Turkish market) ---------------------------------------

@app.get("/api/gold")
def api_gold():
    """Kur & Altın sayfasının fiyat kaynakları.

    Yahoo spot altın vermediği (GC=F vadeli kontrat) için ayrı kaynaklardan
    çekilir. Ayrıntılı gerekçe: app/gold.py başlığı.
    """
    return gold_mod.payload()


@app.get("/api/stock")
def api_stock(symbol: str = Query(...)):
    is_turkish = symbol.upper().endswith(".IS")
    benchmark = "XU100.IS" if is_turkish else "^GSPC"
    rf = RF_TRY if is_turkish else RF_USD

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            f_quote = pool.submit(yahoo.full_quote, symbol)
            f_hist = pool.submit(yahoo.price_history, symbol, "1y")
            f_bench = pool.submit(yahoo.price_history, benchmark, "1y")
            profile, quote = f_quote.result(timeout=30)
            closes = f_hist.result(timeout=30)
            try:
                bench = f_bench.result(timeout=30)
            except Exception:
                bench = pd.Series(dtype=float)
    except Exception as e:
        raise HTTPException(502, f"Yahoo Finance error for {symbol}: {e}")

    if closes.size < 30:
        raise HTTPException(400, f"Not enough price history for {symbol}")

    # Beta on aligned dates
    bench_returns = None
    if bench.size > 30:
        joined = pd.concat({"a": closes, "b": bench}, axis=1, join="inner").dropna()
        if len(joined) > 30:
            bench_returns = risk.daily_returns(joined["b"].to_numpy())
            asset_aligned = risk.daily_returns(joined["a"].to_numpy())

    risk_metrics = risk.risk_profile(closes.to_numpy(), rf)
    if risk_metrics is not None:
        risk_metrics["beta"] = (
            risk.beta(asset_aligned, bench_returns) if bench_returns is not None else None
        )

    S = quote.get("price")
    greeks = None
    if risk_metrics and S and S > 0:
        greeks = risk.black_scholes(S=S, K=S, T=30 / 365, r=rf,
                                    sigma=risk_metrics["annVolatility"])

    return {
        "profile": profile,
        "quote": quote,
        "history": [{"date": d, "close": float(c)} for d, c in closes.items()],
        "risk": risk_metrics,
        "greeks": greeks,
        "benchmark": benchmark,
        "assumptions": {
            "riskFreeRate": rf,
            "note": "Greeks are for a synthetic at-the-money European option, 30 days "
                    "to expiry, priced with Black-Scholes using 1y realized volatility.",
        },
    }


# ---- price history (benchmark overlays for the interactive chart) -------

_history_cache: dict = {}  # (symbol, period) -> (timestamp, payload); short TTL


@app.get("/api/history")
def api_history(symbol: str = Query(..., min_length=1), period: str = "1y"):
    """Lightweight daily-close history for one symbol — used to overlay
    benchmark lines (BIST 100, NASDAQ) on the interactive chart."""
    if period not in ("1mo", "3mo", "6mo", "1y", "2y", "5y"):
        period = "1y"
    key = (symbol.upper(), period)
    now = time.time()
    cached = _history_cache.get(key)
    if cached and now - cached[0] < 300:
        return cached[1]
    try:
        closes = yahoo.price_history(symbol, period)
    except Exception as e:
        raise HTTPException(502, f"Yahoo Finance error for {symbol}: {e}")
    payload = {
        "symbol": symbol.upper(),
        "history": [{"date": d, "close": float(c)} for d, c in closes.items()],
    }
    _history_cache[key] = (now, payload)
    return payload


# ---- multi-market sector heatmap ----------------------------------------

# Broad liquid universe per market, grouped by a sector KEY (translated in the
# frontend via i18n). The heatmap scans the whole sector and surfaces only the
# biggest movers, so the tiles reflect the real top gainers/losers of the day.
TOP_PER_SIDE = 6  # up to this many gainers AND losers shown per sector

MARKETS = {
    "bist": {
        "banks": ["GARAN.IS", "AKBNK.IS", "YKBNK.IS", "ISCTR.IS", "VAKBN.IS", "HALKB.IS",
                  "TSKB.IS", "ALBRK.IS", "SKBNK.IS", "QNBFB.IS", "ICBCT.IS", "KLNMA.IS"],
        "holding": ["KCHOL.IS", "SAHOL.IS", "DOHOL.IS", "ALARK.IS", "ENKAI.IS", "SISE.IS",
                    "AGHOL.IS", "TKFEN.IS", "KOZAA.IS", "NTHOL.IS", "ECILC.IS", "GLYHO.IS",
                    "BRYAT.IS", "GSDHO.IS", "IHLGM.IS"],
        "industry": ["EREGL.IS", "KRDMD.IS", "SASA.IS", "PETKM.IS", "TUPRS.IS", "HEKTS.IS",
                     "GUBRF.IS", "KORDS.IS", "ALKIM.IS", "BAGFS.IS", "CIMSA.IS", "AKCNS.IS",
                     "OYAKC.IS", "BRSAN.IS", "CEMTS.IS", "KONYA.IS", "AKSA.IS", "GOODY.IS"],
        "auto": ["FROTO.IS", "TOASO.IS", "ARCLK.IS", "VESTL.IS", "OTKAR.IS", "TTRAK.IS",
                 "KARSN.IS", "DOAS.IS", "KLMSN.IS", "EGEEN.IS", "PARSN.IS", "JANTS.IS"],
        "retail": ["BIMAS.IS", "MGROS.IS", "SOKM.IS", "ULKER.IS", "CCOLA.IS", "AEFES.IS",
                   "BIZIM.IS", "TATGD.IS", "KNFRT.IS", "PNSUT.IS", "PETUN.IS", "TUKAS.IS",
                   "MAVI.IS", "SELEC.IS"],
        "transport_tech": ["THYAO.IS", "PGSUS.IS", "TAVHL.IS", "ASELS.IS", "TCELL.IS", "TTKOM.IS",
                           "ASTOR.IS", "KONTR.IS", "LOGO.IS", "NETAS.IS", "KAREL.IS", "INDES.IS",
                           "ARENA.IS", "ARDYZ.IS", "PKART.IS", "ALCTL.IS", "SMART.IS", "DGATE.IS"],
    },
    "us": {
        "technology": ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "ORCL", "CRM", "ADBE",
                       "CSCO", "IBM", "NOW", "INTU", "ACN"],
        "semiconductors": ["NVDA", "AMD", "AVGO", "INTC", "QCOM", "MU", "TXN", "AMAT",
                           "LRCX", "KLAC", "ADI", "MRVL", "NXPI", "ON", "TSM"],
        "consumer": ["TSLA", "WMT", "COST", "KO", "MCD", "NKE", "SBUX", "PEP", "PG",
                     "HD", "LOW", "TGT", "BKNG", "CMG"],
        "finance": ["JPM", "BAC", "GS", "MS", "V", "MA", "WFC", "C", "AXP", "BLK",
                    "SCHW", "USB", "PNC", "CB"],
        "healthcare": ["JNJ", "UNH", "PFE", "MRK", "ABBV", "LLY", "TMO", "ABT", "DHR",
                       "BMY", "AMGN", "GILD", "CVS", "MDT"],
        "communication": ["NFLX", "DIS", "T", "VZ", "CMCSA", "TMUS", "CHTR", "WBD", "EA", "TTWO"],
    },
    "europe": {
        "technology": ["SAP.DE", "ASML.AS", "ADYEN.AS", "STM.PA", "CAP.PA", "IFX.DE", "PRX.AS"],
        "luxury": ["MC.PA", "OR.PA", "RMS.PA", "KER.PA", "EL.PA", "CFR.SW", "MONC.MI", "BRBY.L"],
        "industrials": ["SIE.DE", "AIR.PA", "ABBN.SW", "SU.PA", "DHL.DE", "MBG.DE", "BMW.DE",
                        "VOW3.DE", "PHIA.AS"],
        "healthcare": ["NOVN.SW", "ROG.SW", "AZN.L", "SAN.PA", "GSK.L", "BAYN.DE", "NOVO-B.CO"],
        "finance": ["HSBA.L", "ALV.DE", "BNP.PA", "SAN.MC", "INGA.AS", "ISP.MI", "BBVA.MC",
                    "DBK.DE", "BARC.L", "LLOY.L"],
        "energy": ["SHEL.L", "BP.L", "TTE.PA", "ENI.MI", "EQNR.OL", "REP.MC", "IBE.MC"],
        "consumer": ["NESN.SW", "ULVR.L", "DGE.L", "HEIA.AS", "ABI.BR", "BATS.L", "RI.PA"],
    },
    "asia": {
        "technology": ["6758.T", "0700.HK", "9988.HK", "3690.HK", "9618.HK", "6861.T"],
        "semiconductors": ["2330.TW", "005930.KS", "000660.KS", "6857.T", "8035.T", "2454.TW"],
        "auto": ["7203.T", "7267.T", "1211.HK", "7201.T", "005380.KS", "000270.KS"],
        "finance": ["8306.T", "0939.HK", "1299.HK", "8316.T", "1398.HK", "3988.HK"],
        "consumer": ["9983.T", "1810.HK", "2331.HK", "0288.HK", "2020.HK"],
        "telecom": ["9432.T", "9984.T", "0941.HK", "0762.HK"],
    },
}

# Friendly display codes for symbols whose ticker is cryptic (mostly EU/Asia).
# Anything not listed falls back to the ticker without its exchange suffix.
CODE_NAMES = {
    "SAP.DE": "SAP", "ASML.AS": "ASML", "ADYEN.AS": "ADYEN", "STM.PA": "STM",
    "CAP.PA": "CAPGEMINI", "IFX.DE": "INFINEON", "PRX.AS": "PROSUS",
    "MC.PA": "LVMH", "OR.PA": "LOREAL", "RMS.PA": "HERMES", "KER.PA": "KERING",
    "EL.PA": "ESSILOR", "CFR.SW": "RICHEMONT", "MONC.MI": "MONCLER", "BRBY.L": "BURBERRY",
    "SIE.DE": "SIEMENS", "AIR.PA": "AIRBUS", "ABBN.SW": "ABB", "SU.PA": "SCHNEIDER",
    "DHL.DE": "DHL", "MBG.DE": "MERCEDES", "BMW.DE": "BMW", "VOW3.DE": "VW", "PHIA.AS": "PHILIPS",
    "NOVN.SW": "NOVARTIS", "ROG.SW": "ROCHE", "AZN.L": "ASTRA", "SAN.PA": "SANOFI",
    "GSK.L": "GSK", "BAYN.DE": "BAYER", "NOVO-B.CO": "NOVONORDISK",
    "HSBA.L": "HSBC", "ALV.DE": "ALLIANZ", "BNP.PA": "BNP", "SAN.MC": "SANTANDER",
    "INGA.AS": "ING", "ISP.MI": "INTESA", "BBVA.MC": "BBVA", "DBK.DE": "DEUTSCHEBANK",
    "BARC.L": "BARCLAYS", "LLOY.L": "LLOYDS",
    "SHEL.L": "SHELL", "BP.L": "BP", "TTE.PA": "TOTAL", "ENI.MI": "ENI",
    "EQNR.OL": "EQUINOR", "REP.MC": "REPSOL", "IBE.MC": "IBERDROLA",
    "NESN.SW": "NESTLE", "ULVR.L": "UNILEVER", "DGE.L": "DIAGEO", "HEIA.AS": "HEINEKEN",
    "ABI.BR": "ABINBEV", "BATS.L": "BAT", "RI.PA": "PERNOD",
    "6758.T": "SONY", "0700.HK": "TENCENT", "9988.HK": "ALIBABA", "3690.HK": "MEITUAN",
    "9618.HK": "JD", "6861.T": "KEYENCE", "2330.TW": "TSMC", "005930.KS": "SAMSUNG",
    "000660.KS": "SKHYNIX", "6857.T": "ADVANTEST", "8035.T": "TOKYOELEC", "2454.TW": "MEDIATEK",
    "7203.T": "TOYOTA", "7267.T": "HONDA", "1211.HK": "BYD", "7201.T": "NISSAN",
    "005380.KS": "HYUNDAI", "000270.KS": "KIA", "8306.T": "MUFG", "0939.HK": "CCB",
    "1299.HK": "AIA", "8316.T": "SMFG", "1398.HK": "ICBC", "3988.HK": "BOC",
    "9983.T": "UNIQLO", "1810.HK": "XIAOMI", "2331.HK": "LINING", "0288.HK": "WHGROUP",
    "2020.HK": "ANTA", "9432.T": "NTT", "9984.T": "SOFTBANK", "0941.HK": "CHINAMOBILE",
    "0762.HK": "CHINAUNICOM",
}


def _display_code(sym: str) -> str:
    return CODE_NAMES.get(sym) or sym.split(".")[0]


_heatmap_cache: dict = {}  # market -> (timestamp, payload); short TTL for auto-refresh


@app.get("/api/heatmap")
def api_heatmap(market: str = "bist"):
    """Scan each sector's full universe and return the biggest daily movers
    (top gainers + top losers), grouped by sector, for the chosen market."""
    if market not in MARKETS:
        market = "bist"

    now = time.time()
    cached = _heatmap_cache.get(market)
    if cached and now - cached[0] < 45:
        return cached[1]

    sector_map = MARKETS[market]
    all_syms = [s for syms in sector_map.values() for s in syms]
    changes = yahoo.market_changes(all_syms)

    sectors = []
    for key, syms in sector_map.items():
        rows = []
        for sym in syms:
            q = changes.get(sym)
            if q:
                rows.append({"symbol": sym, "code": _display_code(sym),
                             "price": q["price"], "changePercent": q["changePercent"]})
        if not rows:
            continue
        avg = sum(r["changePercent"] for r in rows) / len(rows)
        gainers = sorted([r for r in rows if r["changePercent"] >= 0],
                         key=lambda r: -r["changePercent"])[:TOP_PER_SIDE]
        losers = sorted([r for r in rows if r["changePercent"] < 0],
                        key=lambda r: r["changePercent"])[:TOP_PER_SIDE]
        sectors.append({"key": key, "avg": avg, "stocks": gainers + losers})

    payload = {"market": market, "sectors": sectors}
    _heatmap_cache[market] = (now, payload)
    return payload


# ---- fund universe (screener) -------------------------------------------

@app.get("/api/funds")
def api_funds():
    """Full TEFAS fund universe with period returns and risk values."""
    try:
        return {"funds": tefas.fund_list()}
    except Exception as e:
        raise HTTPException(502, f"TEFAS error: {e}")


# ---- fund detail ---------------------------------------------------------

@app.get("/api/fund")
def api_fund(code: str = Query(..., min_length=2, max_length=6)):
    df = tefas.fund_history(code, days=380)
    if df is None or df.empty:
        raise HTTPException(400, f'No TEFAS data found for fund code "{code.upper()}"')

    try:
        entry = next((f for f in tefas.fund_list() if f["code"] == code.upper()), None)
    except Exception:
        entry = None
    try:
        info = tefas.fund_info(code) or {}
    except Exception:
        info = {}

    latest = df.iloc[-1]
    prices = df["price"].astype(float).to_numpy()

    def _num(v):
        try:
            f = float(v)
            return f if math.isfinite(f) else None
        except (TypeError, ValueError):
            return None

    def _first(*vals):
        return next((v for v in vals if v is not None), None)

    return {
        "profile": {
            "code": code.upper(),
            "title": str(latest.get("title") or info.get("title")
                         or (entry or {}).get("title") or code.upper()),
            "category": _first((entry or {}).get("category"), info.get("category")),
            "currency": "TRY",
        },
        "latest": {
            "date": str(pd.Timestamp(latest["date"]).date()),
            "price": float(latest["price"]),
            "aum": _first(_num(latest.get("market_cap")), info.get("aum")),
            "investors": _first(_num(latest.get("number_of_investors")), info.get("investors")),
            "shares": _first(_num(latest.get("number_of_shares")), info.get("shares")),
        },
        "returns": (entry or {}).get("returns"),
        "history": [
            {"date": str(pd.Timestamp(r["date"]).date()), "close": float(r["price"])}
            for _, r in df.iterrows()
        ],
        "risk": risk.risk_profile(prices, RF_TRY),
        "allocation": tefas.latest_allocation(df, code),
        "assumptions": {"riskFreeRate": RF_TRY},
    }


# ---- news ----------------------------------------------------------------

@app.get("/api/news")
def api_news(q: str = Query(..., min_length=1), lang: str = "tr"):
    try:
        items = news_mod.google_news(q, "en" if lang == "en" else "tr", 12)
    except Exception as e:
        raise HTTPException(502, f"Google News error: {e}")
    return {"query": q, "lang": lang, "items": items}


@app.get("/api/market-news")
def api_market_news(lang: str = "tr"):
    """Home-page panel: Google's top business/economy headlines of the day,
    tagged with the tickers they mention."""
    is_en = lang == "en"
    # Google blocks the topic feed from datacenter IPs (503) but allows the
    # search feed, so fall back to a broad last-24h market query on any failure.
    items = []
    try:
        items = news_mod.top_business_news("en" if is_en else "tr", 12)
    except Exception:
        pass
    if not items:
        fallback_q = ("stock market OR earnings OR fed when:1d" if is_en
                      else "Borsa İstanbul OR TCMB OR dolar OR faiz when:1d")
        try:
            items = news_mod.google_news(fallback_q, "en" if is_en else "tr", 12)
        except Exception as e:
            raise HTTPException(502, f"Google News error: {e}")
    for item in items:
        item["tickers"] = news_mod.extract_tickers(item["title"])
    return {"lang": lang, "items": items}


# ---- portfolio risk engine ----------------------------------------------

class Asset(BaseModel):
    type: Literal["stock", "fund"]
    id: str = Field(min_length=1, max_length=20)
    weight: float = 0.0


class PortfolioRequest(BaseModel):
    assets: list[Asset] = Field(min_length=1, max_length=MAX_ASSETS)
    confidence: float = 0.95
    horizonDays: int = 1


def _asset_series(a: Asset, fund_days: int = 380, stock_period: str = "1y") -> pd.Series:
    """Tek varlığın kapanış serisi, tarih dizinli.

    Varsayılanlar risk motorunun 1 yıllık penceresi içindir; geriye dönük test
    çok daha uzun geçmiş ister (250 gün tahmin penceresi + 250 gün sınav), o
    yüzden çağıran süreyi uzatabiliyor.
    """
    if a.type == "fund":
        df = tefas.fund_history(a.id, days=fund_days)
        if df is None or df.empty:
            return pd.Series(dtype=float)
        s = df.set_index(df["date"].map(lambda d: str(pd.Timestamp(d).date())))["price"].astype(float)
        return s
    return yahoo.price_history(a.id, stock_period)


@app.post("/api/portfolio")
def api_portfolio(req: PortfolioRequest):
    confidence = 0.99 if req.confidence == 0.99 else 0.95
    horizon = min(max(req.horizonDays, 1), 30)
    scale = math.sqrt(horizon)

    weights = np.array([max(a.weight, 0.0) for a in req.assets], dtype=float)
    weights = weights / weights.sum() if weights.sum() > 0 else np.full(len(req.assets), 1 / len(req.assets))

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(req.assets), 6)) as pool:
        series = list(pool.map(_asset_series, req.assets))

    for a, s in zip(req.assets, series):
        if s.size < 30:
            raise HTTPException(400, f"Not enough price history for {a.id}")

    aligned = pd.concat({i: s for i, s in enumerate(series)}, axis=1, join="inner").dropna()
    if len(aligned) < 60:
        raise HTTPException(
            400,
            f"Only {len(aligned)} overlapping trading days across these assets - need at "
            "least 60. Mixing rarely-traded instruments reduces the overlap.",
        )
    aligned = aligned.sort_index()

    rets = aligned.to_numpy()
    rets = rets[1:] / rets[:-1] - 1.0            # (T, n) daily return matrix
    port_returns = rets @ weights

    port_index = np.concatenate([[100.0], 100.0 * np.cumprod(1 + port_returns)])
    mean_vec = rets.mean(axis=0)
    cov = np.cov(rets, rowvar=False, ddof=1)
    cov = np.atleast_2d(cov)
    corr = np.corrcoef(rets, rowvar=False)
    corr = np.atleast_2d(corr)

    mc = risk.monte_carlo_portfolio(weights, mean_vec, cov, MC_SIMS)
    tail_n = max(1, int(MC_SIMS * (1 - confidence)))
    mc_sorted = np.sort(mc)

    port_vol_daily = float(port_returns.std(ddof=1))
    weighted_avg_vol = float(sum(w * rets[:, i].std(ddof=1) for i, w in enumerate(weights)))
    s = pd.Series(port_returns)

    per_asset = []
    for i, a in enumerate(req.assets):
        r_i = rets[:, i]
        per_asset.append({
            "id": a.id,
            "type": a.type,
            "weight": float(weights[i]),
            "annVolatility": float(r_i.std(ddof=1) * math.sqrt(risk.TRADING_DAYS)),
            "var95Hist": risk.historical_var(r_i, 0.95),
            "annReturn": float(r_i.mean() * risk.TRADING_DAYS),
            "corrToPortfolio": float(np.corrcoef(r_i, port_returns)[0, 1]),
        })

    return {
        "inputs": {
            "assets": [{"id": a.id, "type": a.type, "weight": float(weights[i])}
                       for i, a in enumerate(req.assets)],
            "confidence": confidence,
            "horizonDays": horizon,
            "window": {
                "start": str(aligned.index[0]), "end": str(aligned.index[-1]),
                "observations": int(len(port_returns)),
            },
            "mcSimulations": MC_SIMS,
        },
        "portfolio": {
            "annReturn": float(port_returns.mean() * risk.TRADING_DAYS),
            "annVolatility": port_vol_daily * math.sqrt(risk.TRADING_DAYS),
            "sharpe": risk.sharpe(port_returns, RF_TRY),
            "sortino": risk.sortino(port_returns, RF_TRY),
            "maxDrawdown": risk.max_drawdown(port_index),
            "skewness": float(s.skew()),
            "excessKurtosis": float(s.kurt()),
            "var": {
                "historical": risk.historical_var(port_returns, confidence) * scale,
                "parametric": risk.parametric_var(port_returns, confidence) * scale,
                "monteCarlo": float(-np.quantile(mc, 1 - confidence)) * scale,
                "cvarHistorical": risk.cvar(port_returns, confidence) * scale,
                "cvarMonteCarlo": float(-mc_sorted[:tail_n].mean()) * scale,
            },
            "diversificationBenefit": (1 - port_vol_daily / weighted_avg_vol) if weighted_avg_vol > 0 else 0.0,
        },
        "perAsset": per_asset,
        "correlationMatrix": [[float(x) for x in row] for row in corr],
        "histograms": {
            "historical": risk.histogram(port_returns, 41),
            "monteCarlo": risk.histogram(mc, 61),
        },
        "notes": [
            "VaR/CVaR reported as positive loss fractions over the chosen horizon (sqrt-of-time scaling).",
            "Monte Carlo assumes multivariate normal returns with the sample covariance (Cholesky factorization).",
            "Sharpe/Sortino use a 40% TRY risk-free proxy; cross-currency portfolios ignore FX conversion (returns are unitless).",
        ],
    }


# ---- VaR backtesting (model validation) ---------------------------------

# Basel kurulumu 250 gün tahmin penceresi + 250 gün sınav = 500 işlem günü
# ister. Yahoo'nun period sözlüğünde "3y" YOK, bir üst basamak "5y".
# TEFAS takvim günüyle çalışır: 1000 takvim günü ≈ 690 işlem günü, yeter.
BT_STOCK_PERIOD = "5y"
BT_FUND_DAYS = 1000


class BacktestRequest(BaseModel):
    assets: list[Asset] = Field(min_length=1, max_length=MAX_ASSETS)
    confidence: float = 0.99
    estimationWindow: int = 250


@app.post("/api/backtest")
def api_backtest(req: BacktestRequest):
    """Portföyün VaR modelini geçmiş veriyle sınar.

    Risk motoru "kayıp şu seviyeyi %99 ihtimalle aşmaz" diyor; burası o iddiayı
    gün gün test edip Kupiec, Christoffersen ve Basel trafik ışığı sonuçlarını
    döndürüyor. Ayrıntılı yöntem: app/backtest.py başlığı.
    """
    confidence = 0.99 if req.confidence == 0.99 else 0.95
    window = min(max(int(req.estimationWindow), 60), 500)

    weights = np.array([max(a.weight, 0.0) for a in req.assets], dtype=float)
    weights = weights / weights.sum() if weights.sum() > 0 else np.full(len(req.assets), 1 / len(req.assets))

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(req.assets), 6)) as pool:
        series = list(pool.map(
            lambda a: _asset_series(a, BT_FUND_DAYS, BT_STOCK_PERIOD), req.assets))

    for a, s in zip(req.assets, series):
        if s.size < window + 40:
            raise HTTPException(
                400,
                f"{a.id}: only {s.size} days of history — a {window}-day estimation "
                "window plus a test period needs more. Try a shorter window.",
            )

    aligned = pd.concat({i: s for i, s in enumerate(series)}, axis=1, join="inner").dropna()
    aligned = aligned.sort_index()
    if len(aligned) < window + 31:
        raise HTTPException(
            400,
            f"Only {len(aligned)} overlapping trading days across these assets — a "
            f"{window}-day window leaves too few days to test. Use a shorter window "
            "or drop the asset with the shortest history.",
        )

    prices = aligned.to_numpy()
    port_returns = (prices[1:] / prices[:-1] - 1.0) @ weights
    dates = [str(d) for d in aligned.index[1:]]

    try:
        result = backtest_mod.run(port_returns, dates, confidence, window)
    except ValueError as e:
        raise HTTPException(400, str(e))

    result["inputs"] = {
        "assets": [{"id": a.id, "type": a.type, "weight": float(weights[i])}
                   for i, a in enumerate(req.assets)],
        "confidence": confidence,
        "estimationWindow": window,
        "horizonDays": 1,
    }
    result["notes"] = [
        "Each day's VaR is forecast from the preceding window only — no look-ahead.",
        "Weights are held fixed across the test period (daily rebalancing assumption).",
        "Basel traffic-light zones follow the binomial definition, so they stay valid "
        "for test lengths other than 250 days.",
    ]
    return result
