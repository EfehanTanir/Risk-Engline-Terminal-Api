"""Google News RSS + lightweight lexicon sentiment (Turkish + English financial
vocabulary). A heuristic indicator — the UI renders it as a green/red/gray dot."""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Optional

import requests

POSITIVE = [
    # Turkish
    "rekor", "yükseldi", "yükseliş", "kazandı", "kazanç", "büyüme", "büyüdü", "kâr",
    "kar açıkladı", "arttı", "artış", "olumlu", "güçlü", "temettü", "anlaşma",
    "imzaladı", "ihale kazandı", "yatırım", "hedef yükselt", "tavan", "prim",
    "onay aldı", "işbirliği", "sözleşme", "teşvik", "geri alım", "bedelsiz",
    # English
    "record", "surge", "soar", "rally", "beat", "beats", "profit", "growth", "gain",
    "gains", "upgrade", "outperform", "strong", "buyback", "dividend", "partnership",
    "contract", "approval", "expansion", "raised guidance", "all-time high", "wins",
    "award", "breakthrough", "bullish",
]

NEGATIVE = [
    # Turkish
    "düştü", "düşüş", "geriledi", "zarar", "kayıp", "dava", "soruşturma", "ceza",
    "iflas", "konkordato", "kriz", "olumsuz", "zayıf", "taban", "satış baskısı",
    "borç", "haciz", "yaptırım", "grev", "istifa", "küçülme", "işten çıkarma",
    "hedef düşür", "uyarı", "manipülasyon", "tedbir", "yasak",
    # English
    "drop", "falls", "fell", "plunge", "slump", "loss", "losses", "lawsuit", "probe",
    "investigation", "fine", "penalty", "bankruptcy", "default", "downgrade",
    "underperform", "weak", "miss", "misses", "layoff", "layoffs", "recall",
    "strike", "fraud", "cut guidance", "bearish", "crash", "sanction",
]

_TR_LOWER = str.maketrans("İI", "iı")

# Company-name patterns -> ticker, for tagging market headlines with the
# stocks they mention. Patterns are matched against Turkish-lowercased text;
# leading/trailing spaces guard against substring hits inside other words.
TICKER_PATTERNS = [
    ("THYAO.IS", "THYAO", ["türk hava yolları", " thy ", "thyao"]),
    ("ASELS.IS", "ASELS", ["aselsan", "asels"]),
    ("GARAN.IS", "GARAN", ["garanti bbva", "garanti bankası", "garan"]),
    ("AKBNK.IS", "AKBNK", ["akbank", "akbnk"]),
    ("ISCTR.IS", "ISCTR", ["iş bankası", "isctr"]),
    ("YKBNK.IS", "YKBNK", ["yapı kredi", "ykbnk"]),
    ("VAKBN.IS", "VAKBN", ["vakıfbank", "vakbn"]),
    ("HALKB.IS", "HALKB", ["halkbank", "halkb"]),
    ("TUPRS.IS", "TUPRS", ["tüpraş", "tuprs"]),
    ("EREGL.IS", "EREGL", ["ereğli demir", "erdemir", "eregl"]),
    ("KRDMD.IS", "KRDMD", ["kardemir", "krdmd"]),
    ("SISE.IS", "SISE", ["şişecam", " sise "]),
    ("KCHOL.IS", "KCHOL", ["koç holding", "kchol"]),
    ("SAHOL.IS", "SAHOL", ["sabancı holding", "sahol"]),
    ("FROTO.IS", "FROTO", ["ford otosan", "froto"]),
    ("TOASO.IS", "TOASO", ["tofaş", "toaso"]),
    ("ARCLK.IS", "ARCLK", ["arçelik", "arclk"]),
    ("VESTL.IS", "VESTL", ["vestel", "vestl"]),
    ("BIMAS.IS", "BIMAS", ["bim birleşik", " bim ", "bimas"]),
    ("MGROS.IS", "MGROS", ["migros", "mgros"]),
    ("SOKM.IS", "SOKM", ["şok market", " şok "]),
    ("ULKER.IS", "ULKER", ["ülker", "ulker"]),
    ("PGSUS.IS", "PGSUS", ["pegasus", "pgsus"]),
    ("TCELL.IS", "TCELL", ["turkcell", "tcell"]),
    ("TTKOM.IS", "TTKOM", ["türk telekom", "ttkom"]),
    ("PETKM.IS", "PETKM", ["petkim", "petkm"]),
    ("SASA.IS", "SASA", [" sasa "]),
    ("HEKTS.IS", "HEKTS", ["hektaş", "hekts"]),
    ("ASTOR.IS", "ASTOR", ["astor enerji", "astor"]),
    ("ENKAI.IS", "ENKAI", [" enka ", "enkai"]),
    ("TAVHL.IS", "TAVHL", ["tav havalimanları", " tav "]),
    ("GUBRF.IS", "GUBRF", ["gübretaş", "gubrf"]),
    ("EKGYO.IS", "EKGYO", ["emlak konut", "ekgyo"]),
    ("AKSEN.IS", "AKSEN", ["aksa enerji", "aksen"]),
    ("ALARK.IS", "ALARK", ["alarko", "alark"]),
    ("KONTR.IS", "KONTR", ["kontrolmatik", "kontr"]),
    ("DOHOL.IS", "DOHOL", ["doğan holding", "dohol"]),
    ("KOZAL.IS", "KOZAL", ["koza altın", "kozal"]),
    ("OYAKC.IS", "OYAKC", ["oyak çimento", "oyakc"]),
    ("XU100.IS", "BIST100", ["bist 100", "bist100", "borsa istanbul endeks"]),
    # global majors
    ("AAPL", "AAPL", ["apple"]),
    ("TSLA", "TSLA", ["tesla"]),
    ("NVDA", "NVDA", ["nvidia"]),
    ("MSFT", "MSFT", ["microsoft"]),
    ("AMZN", "AMZN", ["amazon"]),
    ("GOOGL", "GOOGL", ["google", "alphabet"]),
    ("META", "META", [" meta ", "facebook"]),
    ("BTC-USD", "BTC", ["bitcoin"]),
]


def extract_tickers(text: str, limit: int = 4) -> list[dict]:
    """Best-effort tagging of tickers mentioned in a headline."""
    t = " " + (text or "").translate(_TR_LOWER).lower() + " "
    found = []
    for symbol, code, patterns in TICKER_PATTERNS:
        if any(p in t for p in patterns):
            found.append({"symbol": symbol, "code": code})
            if len(found) >= limit:
                break
    return found


def sentiment(text: str) -> dict:
    t = (text or "").translate(_TR_LOWER).lower()
    score = sum(1 for w in POSITIVE if w in t) - sum(1 for w in NEGATIVE if w in t)
    label = "positive" if score > 0 else "negative" if score < 0 else "neutral"
    return {"label": label, "score": score}


def _fetch_feed(url: str, params: Optional[dict], limit: int) -> list[dict]:
    resp = requests.get(url, params=params, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
    resp.raise_for_status()
    root = ET.fromstring(resp.content)
    items = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        if not title:
            continue
        clean_title = re.sub(r"\s+-\s+[^-]+$", "", title)  # strip trailing " - Source"
        items.append({
            "title": title,
            "link": (item.findtext("link") or "").strip(),
            "source": (item.findtext("source") or "").strip(),
            "date": (item.findtext("pubDate") or "").strip(),
            "sentiment": sentiment(clean_title + " " + (item.findtext("description") or "")),
        })
        if len(items) >= limit:
            break
    return items


def google_news(q: str, lang: str = "tr", limit: int = 12) -> list[dict]:
    """Search-based feed (used on stock/fund detail pages)."""
    is_tr = lang != "en"
    return _fetch_feed("https://news.google.com/rss/search", {
        "q": q,
        "hl": "tr" if is_tr else "en-US",
        "gl": "TR" if is_tr else "US",
        "ceid": "TR:tr" if is_tr else "US:en",
    }, limit)


def top_business_news(lang: str = "tr", limit: int = 12) -> list[dict]:
    """Google News BUSINESS topic headlines - Google's own ranking of the
    day's top business/economy stories (used on the home page)."""
    is_tr = lang != "en"
    url = ("https://news.google.com/rss/headlines/section/topic/BUSINESS"
           f"?hl={'tr' if is_tr else 'en-US'}&gl={'TR' if is_tr else 'US'}"
           f"&ceid={'TR:tr' if is_tr else 'US:en'}")
    return _fetch_feed(url, None, limit)
