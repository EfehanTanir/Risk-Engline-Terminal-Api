"""Yahoo Finance access via yfinance, shaped to the terminal's API contract."""
from __future__ import annotations

import concurrent.futures
import re
from typing import Optional

import pandas as pd
import requests
import yfinance as yf

STOCK_TYPES = {"EQUITY", "ETF", "INDEX", "CURRENCY", "CRYPTOCURRENCY", "MUTUALFUND"}

_UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


# Equities first so index derivatives never drown out the actual stock
_TYPE_ORDER = {"EQUITY": 0, "ETF": 1, "MUTUALFUND": 2, "CRYPTOCURRENCY": 3,
               "CURRENCY": 4, "INDEX": 5}


def search(q: str, count: int = 12) -> list[dict]:
    fetch_n = max(count * 2, 25)  # over-fetch, then rank
    quotes = []
    try:
        s = yf.Search(q, max_results=fetch_n, news_count=0)
        quotes = s.quotes or []
    except Exception:
        try:
            r = requests.get(
                "https://query2.finance.yahoo.com/v1/finance/search",
                params={"q": q, "quotesCount": fetch_n, "newsCount": 0},
                headers=_UA, timeout=10,
            )
            quotes = r.json().get("quotes", [])
        except Exception:
            quotes = []
    out = []
    for x in quotes:
        sym = x.get("symbol")
        if not sym or x.get("quoteType") not in STOCK_TYPES:
            continue
        if "_" in sym:  # BIST hedged/currency index variants - pure noise
            continue
        out.append({
            "symbol": sym,
            "name": x.get("longname") or x.get("shortname") or sym,
            "exchange": x.get("exchDisp") or x.get("exchange"),
            "type": x.get("quoteType"),
            "isTurkish": bool(re.search(r"\.IS$", sym)),
        })
    # Stable sort keeps Yahoo's relevance order within each type
    out.sort(key=lambda r: _TYPE_ORDER.get(r["type"], 9))
    return out[:count]


def _safe_info(ticker: yf.Ticker) -> dict:
    try:
        return ticker.info or {}
    except Exception:
        return {}


def quick_quote(symbol: str) -> Optional[dict]:
    """Tape quote. Uses the SAME price/previous-close sources as full_quote so
    the home page and the detail page always show identical change figures."""
    try:
        t = yf.Ticker(symbol)
        info = _safe_info(t)
        fi = {}
        try:
            fi = dict(t.fast_info)
        except Exception:
            pass
        price = info.get("regularMarketPrice") or info.get("currentPrice") or fi.get("lastPrice")
        if price is None:
            return None
        prev = info.get("regularMarketPreviousClose") or info.get("previousClose") or fi.get("previousClose")
        change = (price - prev) if prev else None
        return {
            "symbol": symbol,
            "name": info.get("shortName") or info.get("longName") or symbol,
            "price": price,
            "change": change,
            "changePercent": (change / prev * 100) if (change is not None and prev) else None,
            "currency": info.get("currency") or fi.get("currency"),
            "marketState": info.get("marketState"),
        }
    except Exception:
        return None


def quotes(symbols: list[str]) -> list[dict]:
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(quick_quote, symbols))
    return [r for r in results if r]


def light_quote(symbol: str) -> Optional[dict]:
    """Fast fast_info-only quote (no heavy .info) for the sector heatmap where
    many symbols are fetched at once and only price/change is needed."""
    try:
        fi = dict(yf.Ticker(symbol).fast_info)
        price = fi.get("lastPrice")
        prev = fi.get("previousClose")
        if price is None or not prev:
            return None
        return {"symbol": symbol, "price": float(price),
                "changePercent": (price - prev) / prev * 100}
    except Exception:
        return None


def light_quotes(symbols: list[str]) -> dict:
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        results = pool.map(light_quote, symbols)
    return {s: r for s, r in zip(symbols, results) if r}


def price_history(symbol: str, period: str = "1y") -> pd.Series:
    """Daily closes indexed by ISO date string."""
    df = yf.Ticker(symbol).history(period=period, interval="1d", auto_adjust=True)
    if df is None or df.empty:
        return pd.Series(dtype=float)
    closes = df["Close"].dropna()
    closes = closes[closes > 0]
    closes.index = [d.date().isoformat() for d in closes.index]
    return closes


def full_quote(symbol: str) -> tuple[dict, dict]:
    """(profile, quote) dictionaries for the stock detail page."""
    t = yf.Ticker(symbol)
    info = _safe_info(t)
    fi = {}
    try:
        fi = dict(t.fast_info)
    except Exception:
        pass

    price = info.get("regularMarketPrice") or info.get("currentPrice") or fi.get("lastPrice")
    prev = info.get("regularMarketPreviousClose") or info.get("previousClose") or fi.get("previousClose")
    change = (price - prev) if (price is not None and prev) else None
    is_turkish = bool(re.search(r"\.IS$", symbol, re.I))

    profile = {
        "symbol": symbol.upper(),
        "longName": info.get("longName") or info.get("shortName") or symbol.upper(),
        "shortName": info.get("shortName"),
        "exchange": info.get("fullExchangeName") or info.get("exchange"),
        "currency": info.get("currency") or fi.get("currency"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "website": info.get("website"),
        "city": info.get("city"),
        "country": info.get("country"),
        "employees": info.get("fullTimeEmployees"),
        "summary": info.get("longBusinessSummary"),
        "isTurkish": is_turkish,
    }
    quote = {
        "price": price,
        "change": change,
        "changePercent": (change / prev * 100) if (change is not None and prev) else None,
        "previousClose": prev,
        "open": info.get("regularMarketOpen") or info.get("open"),
        "dayHigh": info.get("regularMarketDayHigh") or info.get("dayHigh"),
        "dayLow": info.get("regularMarketDayLow") or info.get("dayLow"),
        "high52w": info.get("fiftyTwoWeekHigh"),
        "low52w": info.get("fiftyTwoWeekLow"),
        "volume": info.get("regularMarketVolume") or info.get("volume"),
        "avgVolume": info.get("averageVolume"),
        "marketCap": info.get("marketCap") or fi.get("marketCap"),
        "trailingPE": info.get("trailingPE"),
        "forwardPE": info.get("forwardPE"),
        "eps": info.get("trailingEps"),
        "dividendYield": info.get("dividendYield"),
        "priceToBook": info.get("priceToBook"),
        "targetMeanPrice": info.get("targetMeanPrice"),
        "recommendation": info.get("recommendationKey"),
        "marketState": info.get("marketState"),
    }
    return profile, quote
