"""Google News RSS + lightweight lexicon sentiment (Turkish + English financial
vocabulary). A heuristic indicator — the UI renders it as a green/red/gray dot."""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET

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


def sentiment(text: str) -> dict:
    t = (text or "").translate(_TR_LOWER).lower()
    score = sum(1 for w in POSITIVE if w in t) - sum(1 for w in NEGATIVE if w in t)
    label = "positive" if score > 0 else "negative" if score < 0 else "neutral"
    return {"label": label, "score": score}


def google_news(q: str, lang: str = "tr", limit: int = 12) -> list[dict]:
    is_tr = lang != "en"
    url = "https://news.google.com/rss/search"
    params = {
        "q": q,
        "hl": "tr" if is_tr else "en-US",
        "gl": "TR" if is_tr else "US",
        "ceid": "TR:tr" if is_tr else "US:en",
    }
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
