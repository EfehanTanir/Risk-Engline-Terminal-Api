# Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
# SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

"""Altın fiyat kaynakları — iki farklı dünya, iki farklı cevap.

NEDEN BU DOSYA VAR
------------------
Yahoo Finance spot altın (XAU/USD) vermiyor. Denenen ve BOŞ dönen semboller:
XAUUSD=X, XAU=X, GCUSD=X, GOLD=X. Elde kalan `GC=F` ise spot değil, en aktif
COMEX **vadeli** kontratı — API'nin kendisi "Gold Dec 26" adıyla döndürüyor.
Vadeli fiyat, taşıma maliyeti kadar spotun üzerindedir (19.08.2026 ölçümü:
4.405 $ vadeli / 4.356 $ spot = %1,2 fark) ve bu fark gram altına birebir
yansıyordu.

İKİ KAYNAK, İKİ AMAÇ
--------------------
* spot()    → küresel spot ons. Gram/çeyrek hesabını BİZ yaparız (has değer).
* turkish() → Türk serbest piyasası. Gram, çeyrek, tam altın fiyatları hazır
              gelir; sarrafiye primi ve alış/satış makası dahildir.

Hangisinin gösterileceğine kullanıcı karar verir; ikisi de aynı yanıtta döner
ki arayüz kaynak değiştirirken yeniden istek atmasın.

Her şey YUMUŞAK ÇÖKER: kaynak ölürse None döner, sayfa Yahoo vadeli fiyatıyla
çalışmaya devam eder. Altın verisi hiçbir zaman terminali kilitlemez.
"""
from __future__ import annotations

import time
from typing import Any, Optional

import requests

TIMEOUT = 4          # Vercel fonksiyon bütçesinin çok altında kal
CACHE_TTL = 60       # saniye; sayfa 60 sn'de bir yeniliyor zaten

SPOT_URL = "https://api.gold-api.com/price/XAU"
TR_URL = "https://finans.truncgil.com/today.json"

_cache: dict = {}    # anahtar -> (zaman, veri)


def _cached(key: str, fetch):
    """Ortak önbellek sarmalayıcı. Hata durumunda BAYAT VERİYİ döndürür —
    kaynak birkaç dakika düşse bile sayfada boşluk oluşmasın diye."""
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_TTL:
        return hit[1]
    try:
        data = fetch()
    except Exception:
        data = None
    if data is None and hit:
        return hit[1]            # bayat ama boş ekrandan iyi
    _cache[key] = (now, data)
    return data


def _num(raw: Any) -> Optional[float]:
    """Türk biçimli sayıyı float'a çevirir: '6.713,37' -> 6713.37

    Nokta binlik ayracı, virgül ondalık ayracıdır — Python'un beklediğinin tam
    tersi. '$' ve '%' önekleri de temizlenir ('$4.356,26', '%0,51').
    """
    if raw is None:
        return None
    s = str(raw).replace("$", "").replace("₺", "").replace("%", "").strip()
    if not s:
        return None
    s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


# ---- küresel spot ---------------------------------------------------------

def _fetch_spot() -> Optional[dict]:
    r = requests.get(SPOT_URL, timeout=TIMEOUT)
    r.raise_for_status()
    j = r.json()
    price = j.get("price")
    if not price:
        return None
    return {
        "ounceUsd": float(price),
        "updated": j.get("updatedAt"),
        "source": "gold-api.com",
    }


def spot() -> Optional[dict]:
    return _cached("spot", _fetch_spot)


# ---- Türk serbest piyasası ------------------------------------------------

# truncgil anahtarı -> bizim anahtarımız. Sayfadaki kartlarla aynı sırada.
_TR_ITEMS = {
    "gram-altin": "gram",
    "ceyrek-altin": "ceyrek",
    "yarim-altin": "yarim",
    "tam-altin": "tam",
    "cumhuriyet-altini": "cumhur",
    "22-ayar-bilezik": "k22",
    "18-ayar-altin": "k18",
    "14-ayar-altin": "k14",
}


def _tr_entry(node: Any) -> Optional[dict]:
    if not isinstance(node, dict):
        return None
    bid, ask = _num(node.get("Alış")), _num(node.get("Satış"))
    if bid is None and ask is None:
        return None
    return {"bid": bid, "ask": ask, "changePercent": _num(node.get("Değişim"))}


def _fetch_turkish() -> Optional[dict]:
    r = requests.get(TR_URL, timeout=TIMEOUT)
    r.raise_for_status()
    j = r.json()
    if not isinstance(j, dict):
        return None

    items = {}
    for src_key, our_key in _TR_ITEMS.items():
        e = _tr_entry(j.get(src_key))
        if e:
            items[our_key] = e

    ons = _tr_entry(j.get("ons"))
    usd = _tr_entry(j.get("USD"))
    eur = _tr_entry(j.get("EUR"))
    if not items and not ons:
        return None

    return {
        "updated": j.get("Update_Date"),
        "ounceUsd": (ons or {}).get("ask"),
        "usdTry": (usd or {}).get("ask"),
        "eurTry": (eur or {}).get("ask"),
        "items": items,
        "source": "truncgil",
    }


def turkish() -> Optional[dict]:
    return _cached("tr", _fetch_turkish)


def payload() -> dict:
    """Her iki kaynak tek yanıtta; arayüz kaynak değiştirirken ağa çıkmaz."""
    s, t = spot(), turkish()
    return {
        "spot": s,
        "turkish": t,
        "onsGram": 31.1034768,
        "notes": [
            "spot: küresel spot ons (XAU/USD). Gram ve sarrafiye değerleri "
            "bu fiyattan hesaplanır; saf altının piyasa karşılığıdır (has değer).",
            "turkish: Türk serbest piyasası alış/satış fiyatları. Sarrafiye "
            "primi ve makas dahildir, kuyumcu fiyatına daha yakındır.",
            "Yahoo'nun GC=F sembolü spot DEĞİL vadeli kontrattır; taşıma "
            "maliyeti kadar spotun üzerinde işlem görür.",
        ],
    }
