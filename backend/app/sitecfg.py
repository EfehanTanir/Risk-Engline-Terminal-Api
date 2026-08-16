# Finansla Terminal - https://terminal.finansla.net
# Copyright (c) 2026 Efehan Tanırgan. Tüm hakları saklıdır.
# Bu dosya özel mülkiyettir; izinsiz kopyalanamaz, çoğaltılamaz veya dağıtılamaz.

"""Site geneli kontrol: duyuru bandı ve bakım modu.

Yönetim panelinden yazılan ayar Redis'te tek bir JSON kaydında durur; her
sayfa açılışında `/api/site-config` ucundan okunur. Yeniden dağıtım gerekmez —
yazdığınız duyuru en geç ~20 saniyede tüm ziyaretçilerde görünür.

Tasarımdaki iki kural:

1. **Arıza güvenliği.** Redis okunamazsa varsayılan (duyuru yok, bakım yok)
   döner. Bir depolama kesintisi siteyi yanlışlıkla bakım moduna sokamaz.
2. **Örnek başına kısa önbellek.** Ziyaretçi sayısı ne olursa olsun Redis'e
   20 saniyede birden fazla gidilmez; Upstash komut bütçesi korunur.
"""
from __future__ import annotations

import json
import time
from typing import Optional

from . import store

# İki ayrı site, iki ayrı ayar: terminalde duyuru açmak finansla.net'i
# etkilemesin. "terminal" varsayılan, çünkü terminalin site.js'i parametresiz
# çağırıyor ve o davranış bozulmamalı.
SCOPES = ("terminal", "web")
KEY = "fl:site:config"


def _key(scope: str) -> str:
    return KEY if scope == "terminal" else f"{KEY}:{scope}"
CACHE_TTL = 20          # saniye, örnek başına
MAX_TEXT = 280          # duyuru metni üst sınırı
LEVELS = ("info", "warning", "danger")

DEFAULT = {
    "banner": {"active": False, "level": "info", "tr": "", "en": "", "expiresAt": 0},
    "maintenance": {"active": False, "tr": "", "en": ""},
    "updatedAt": 0,
}

_cache: dict = {}   # scope -> {"t": ..., "data": ...}


def _clean_text(value) -> str:
    if not isinstance(value, str):
        return ""
    # Satır sonlarını boşluğa indir: banda tek satır olarak basılıyor
    return " ".join(value.split())[:MAX_TEXT]


def normalize(raw) -> dict:
    """Gelen veriyi şemaya oturt. Panelden de Redis'ten de geçebilir, ikisine
    de güvenmiyoruz."""
    if not isinstance(raw, dict):
        return json.loads(json.dumps(DEFAULT))

    banner = raw.get("banner") or {}
    maint = raw.get("maintenance") or {}
    level = banner.get("level")
    try:
        expires = max(0, int(banner.get("expiresAt") or 0))
    except (TypeError, ValueError):
        expires = 0
    return {
        "banner": {
            "active": bool(banner.get("active")),
            "level": level if level in LEVELS else "info",
            "tr": _clean_text(banner.get("tr")),
            "en": _clean_text(banner.get("en")),
            "expiresAt": expires,          # 0 = süresiz
        },
        "maintenance": {
            "active": bool(maint.get("active")),
            "tr": _clean_text(maint.get("tr")),
            "en": _clean_text(maint.get("en")),
        },
        "updatedAt": int(raw.get("updatedAt") or 0),
    }


def _apply_expiry(cfg: dict) -> dict:
    """Süresi dolmuş duyuruyu kapalı say. Süre kontrolü OKUMA anında yapılır,
    böylece kimsenin panele girip 'kaldır' demesine gerek kalmaz — duyuru
    yayınlandıktan sonra siteyi unutsanız bile kendiliğinden düşer."""
    b = cfg.get("banner") or {}
    if b.get("active") and b.get("expiresAt") and time.time() > b["expiresAt"]:
        b["active"] = False
    return cfg


def get_config(fresh: bool = False, scope: str = "terminal") -> dict:
    """Yürürlükteki ayar. `fresh=True` önbelleği atlar (yönetim paneli için)."""
    scope = scope if scope in SCOPES else "terminal"
    slot = _cache.setdefault(scope, {"t": 0.0, "data": None})
    now = time.time()
    if not fresh and slot["data"] is not None and now - slot["t"] < CACHE_TTL:
        # Önbellek tazeyken bile süreyi yeniden değerlendir: 20 sn'lik pencere
        # dolmuş bir duyuruyu yayında tutmasın.
        return _apply_expiry(slot["data"])

    if not store.enabled():
        return normalize(None)

    raw: Optional[str] = store.cmd("GET", _key(scope))
    if not raw:
        cfg = normalize(None)
    else:
        try:
            cfg = normalize(json.loads(raw))
        except Exception:
            # Bozuk kayıt: siteyi bakıma sokmaktansa varsayılana dön
            cfg = normalize(None)

    slot.update(t=now, data=cfg)
    return _apply_expiry(cfg)


def save_config(raw, scope: str = "terminal") -> Optional[dict]:
    """Ayarı yaz ve yazılan hâlini döndür; depolama yoksa None.

    Panel süreyi saat cinsinden (`expiresHours`) yollar; mutlak zamanı burada
    hesaplıyoruz ki istemci saatine güvenmek zorunda kalmayalım."""
    if not store.enabled():
        return None

    if isinstance(raw, dict) and isinstance(raw.get("banner"), dict):
        try:
            hours = float(raw["banner"].get("expiresHours") or 0)
        except (TypeError, ValueError):
            hours = 0
        raw["banner"]["expiresAt"] = (
            int(time.time() + hours * 3600) if hours > 0 else 0)

    cfg = normalize(raw)
    cfg["updatedAt"] = int(time.time())
    scope = scope if scope in SCOPES else "terminal"
    if store.cmd("SET", _key(scope), json.dumps(cfg, ensure_ascii=False)) is None:
        return None
    # bu örnek anında güncel olsun
    _cache[scope] = {"t": time.time(), "data": cfg}
    return cfg
