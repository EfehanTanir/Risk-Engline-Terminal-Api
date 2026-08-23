# Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
# SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

"""Eğitim yazılarının deposu (Upstash Redis).

Yazılar burada Markdown olarak saklanır; HTML'e çevirme işi yönetim panelinde,
tarayıcıda yapılır. Sebep: finansla.net statik bir sitedir, sunucu tarafında
şablon çalıştıramayız. Panel, yazıdan **hazır HTML dosyası üretir**, kullanıcı
onu cPanel'e yükler.

Redis burada "gerçeğin kaynağı"dır: yayımlanmış dosyayı kaybetsen bile yazı
burada durur, düzenleyip yeniden üretebilirsin.

    fl:post:{slug}   JSON  -> yazının kendisi
    fl:posts         zset  -> slug -> yayın zamanı (sıralama için)
"""
from __future__ import annotations

import json
import re
import time
import unicodedata
from typing import Optional

from . import store

KEY_POST = "fl:post:"
KEY_INDEX = "fl:posts"
MAX_BODY = 120_000

# Türkçe karakterleri URL'e uygun hâle getirme tablosu. unicodedata tek başına
# 'ı' ve 'ğ' gibi harflerde beklenen sonucu vermiyor, önce elle çeviriyoruz.
_TR = str.maketrans({
    "ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g",
    "ü": "u", "Ü": "u", "ö": "o", "Ö": "o", "ç": "c", "Ç": "c",
})


def slugify(text: str) -> str:
    text = (text or "").translate(_TR).lower()
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:80] or "yazi"


def _clean(value, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


def normalize(raw: dict) -> dict:
    """Panelden gelen veriyi şemaya oturt. İstemciye asla güvenmiyoruz."""
    raw = raw if isinstance(raw, dict) else {}
    title = _clean(raw.get("title"), 200)
    slug = slugify(raw.get("slug") or title)
    return {
        "slug": slug,
        "title": title,
        "category": _clean(raw.get("category"), 60) or "Eğitim",
        "excerpt": _clean(raw.get("excerpt"), 400),
        "metaDescription": _clean(raw.get("metaDescription"), 200),
        "metaTitle": _clean(raw.get("metaTitle"), 200),
        "cover": _clean(raw.get("cover"), 200),
        "body": _clean(raw.get("body"), MAX_BODY),
        "published": bool(raw.get("published")),
        "date": _clean(raw.get("date"), 10) or time.strftime("%Y-%m-%d"),
        "updatedAt": int(time.time()),
        "faq": [
            {"q": _clean(item.get("q"), 200), "a": _clean(item.get("a"), 800)}
            for item in (raw.get("faq") or [])[:8]
            if isinstance(item, dict) and _clean(item.get("q"), 200)
        ],
    }


def save(raw: dict, old_slug: Optional[str] = None) -> Optional[dict]:
    if not store.enabled():
        return None
    post = normalize(raw)
    cmds = [["SET", KEY_POST + post["slug"], json.dumps(post, ensure_ascii=False)],
            ["ZADD", KEY_INDEX, int(time.time()), post["slug"]]]
    # Başlık değişince slug da değişebilir; eskisini ortalıkta bırakmayalım
    if old_slug and old_slug != post["slug"]:
        cmds += [["DEL", KEY_POST + old_slug], ["ZREM", KEY_INDEX, old_slug]]
    if store.pipeline(cmds) is None:
        return None
    return post


def get(slug: str) -> Optional[dict]:
    if not store.enabled():
        return None
    raw = store.cmd("GET", KEY_POST + slugify(slug))
    if not raw:
        return None
    try:
        return normalize(json.loads(raw))
    except Exception:
        return None


def delete(slug: str) -> bool:
    if not store.enabled():
        return False
    slug = slugify(slug)
    return store.pipeline([["DEL", KEY_POST + slug],
                           ["ZREM", KEY_INDEX, slug]]) is not None


def listing(only_published: bool = False) -> list[dict]:
    """Yeniden eskiye sıralı yazı listesi. Gövde metni taşınmaz — liste
    ekranında gerekmiyor ve boşuna büyütmenin anlamı yok."""
    if not store.enabled():
        return []
    slugs = store.cmd("ZREVRANGE", KEY_INDEX, 0, 199) or []
    if not slugs:
        return []
    rows = store.pipeline([["GET", KEY_POST + s] for s in slugs]) or []

    out = []
    for raw in rows:
        if not raw:
            continue
        try:
            post = normalize(json.loads(raw))
        except Exception:
            continue
        if only_published and not post["published"]:
            continue
        post.pop("body", None)
        out.append(post)
    return out
