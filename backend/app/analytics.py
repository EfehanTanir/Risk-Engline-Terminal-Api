# Finansla Terminal - https://terminal.finansla.net
# Copyright (c) 2026 Efehan Tanırgan. Tüm hakları saklıdır.
# Bu dosya özel mülkiyettir; izinsiz kopyalanamaz, çoğaltılamaz veya dağıtılamaz.

"""Visitor tracking and usage analytics on top of Upstash Redis.

Privacy: raw IP addresses are never stored. A visitor is identified by
sha256(salt + ip + user-agent) truncated to 12 hex chars, which is enough to
count unique people and detect who is online right now, but is not reversible
and is useless outside this database. Unique counts use HyperLogLog, which
keeps an approximate cardinality rather than the identities themselves. This
matters for KVKK: nothing here is personal data at rest.

Key layout (all prefixed `fl:`):

    fl:pv:total        counter  all-time page views
    fl:pv:d:{day}      counter  page views for one day        (90d TTL)
    fl:uv:d:{day}      HLL      unique visitors for one day   (90d TTL)
    fl:page            zset     views per page
    fl:q               zset     search queries
    fl:sym             zset     viewed equity symbols
    fl:fund            zset     viewed TEFAS fund codes
    fl:geo             zset     visitors per country
    fl:ref             zset     referrer hosts
    fl:live            zset     visitor -> last-seen timestamp (online now)
    fl:recent          list     last 60 events, newest first
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import time
from typing import Optional

from . import store

# Turkey has had no DST since 2016, so a fixed offset is safe and avoids
# depending on tzdata being present in the Vercel image.
TR_TZ = dt.timezone(dt.timedelta(hours=3))

DAY_TTL = 90 * 24 * 3600
ONLINE_WINDOW = 300      # seconds a visitor counts as "online now"
RECENT_MAX = 60          # events kept for the live feed
TOP_N = 15

SALT = (os.environ.get("ANALYTICS_SALT")
        or os.environ.get("ADMIN_TOTP_SECRET")
        or "finansla-terminal")

_SAFE = re.compile(r"[^A-Za-z0-9 ._\-/=^&:?ğüşıöçĞÜŞİÖÇ]")


def _day(offset: int = 0) -> str:
    return (dt.datetime.now(TR_TZ) - dt.timedelta(days=offset)).strftime("%Y-%m-%d")


def _clean(value: Optional[str], limit: int = 60) -> str:
    """Anything reaching here came from a public endpoint, so clamp hard: no
    control characters, no unbounded strings turning into Redis members."""
    if not value:
        return ""
    return _SAFE.sub("", str(value).strip())[:limit]


def visitor_id(ip: str, ua: str) -> str:
    return hashlib.sha256(f"{SALT}|{ip}|{ua}".encode("utf-8", "ignore")).hexdigest()[:12]


def record(*, page: str, visitor: str, country: str = "", city: str = "",
           ref: str = "", query: str = "", symbol: str = "", fund: str = "") -> bool:
    """Write one visit. Batched into a single HTTP round trip; never raises."""
    if not store.enabled():
        return False

    page = _clean(page, 40) or "unknown"
    country = _clean(country, 8)
    city = _clean(city, 40)
    ref = _clean(ref, 60)
    now = int(time.time())
    day = _day()

    # Hangi siteden geldiği sayfa adından anlaşılıyor: landing "site:" önekiyle
    # gönderiyor, terminal göndermiyor. Böylece tek uçtan iki mülkü ayrı ayrı
    # sayabiliyoruz — panelde "terminal vs finansla.net" kırılımı buradan çıkıyor.
    prop = "web" if page.startswith("site:") else "term"

    cmds: list[list] = [
        ["INCR", "fl:pv:total"],
        ["INCR", f"fl:pv:d:{day}"],
        ["EXPIRE", f"fl:pv:d:{day}", DAY_TTL],
        ["PFADD", f"fl:uv:d:{day}", visitor],
        ["EXPIRE", f"fl:uv:d:{day}", DAY_TTL],
        ["INCR", f"fl:pv:d:{day}:{prop}"],
        ["EXPIRE", f"fl:pv:d:{day}:{prop}", DAY_TTL],
        ["PFADD", f"fl:uv:d:{day}:{prop}", visitor],
        ["EXPIRE", f"fl:uv:d:{day}:{prop}", DAY_TTL],
        ["ZINCRBY", "fl:page", 1, page],
        ["ZADD", "fl:live", now, visitor],
    ]
    if country:
        cmds.append(["ZINCRBY", "fl:geo", 1, country])
    if ref:
        cmds.append(["ZINCRBY", "fl:ref", 1, ref])
    if query:
        cmds.append(["ZINCRBY", "fl:q", 1, _clean(query, 40).lower()])
    if symbol:
        cmds.append(["ZINCRBY", "fl:sym", 1, _clean(symbol, 20).upper()])
    if fund:
        cmds.append(["ZINCRBY", "fl:fund", 1, _clean(fund, 8).upper()])

    event = {"t": now, "p": page, "c": country, "y": city, "r": ref, "v": visitor}
    for extra, key in ((query, "q"), (symbol, "s"), (fund, "f")):
        if extra:
            event[key] = _clean(extra, 40)
    cmds.append(["LPUSH", "fl:recent", json.dumps(event, ensure_ascii=False)])
    cmds.append(["LTRIM", "fl:recent", 0, RECENT_MAX - 1])

    return store.pipeline(cmds) is not None


def _pairs(flat) -> list[dict]:
    """ZREVRANGE ... WITHSCORES gives [member, score, member, score, ...]."""
    if not flat:
        return []
    out = []
    for i in range(0, len(flat) - 1, 2):
        try:
            out.append({"name": flat[i], "count": int(float(flat[i + 1]))})
        except (TypeError, ValueError):
            continue
    return out


def summary(days: int = 14) -> dict:
    """Everything the dashboard needs, in one pipeline."""
    if not store.enabled():
        return {"enabled": False}

    days = max(1, min(days, 90))
    day_keys = [f"fl:pv:d:{_day(i)}" for i in range(days)]
    uv_keys = [f"fl:uv:d:{_day(i)}" for i in range(days)]
    cutoff = int(time.time()) - ONLINE_WINDOW

    cmds: list[list] = [
        ["GET", "fl:pv:total"],
        ["MGET"] + day_keys,
        ["PFCOUNT"] + uv_keys,
        ["PFCOUNT", uv_keys[0]],
        ["ZREMRANGEBYSCORE", "fl:live", "-inf", cutoff],   # prune before counting
        ["ZCOUNT", "fl:live", cutoff, "+inf"],
        ["ZREVRANGE", "fl:page", 0, TOP_N - 1, "WITHSCORES"],
        ["ZREVRANGE", "fl:q", 0, TOP_N - 1, "WITHSCORES"],
        ["ZREVRANGE", "fl:sym", 0, TOP_N - 1, "WITHSCORES"],
        ["ZREVRANGE", "fl:fund", 0, TOP_N - 1, "WITHSCORES"],
        ["ZREVRANGE", "fl:geo", 0, TOP_N - 1, "WITHSCORES"],
        ["ZREVRANGE", "fl:ref", 0, TOP_N - 1, "WITHSCORES"],
        ["LRANGE", "fl:recent", 0, RECENT_MAX - 1],
        # mülk kırılımı: terminal ve finansla.net ayrı ayrı
        ["MGET"] + [f"{k}:term" for k in day_keys],
        ["MGET"] + [f"{k}:web" for k in day_keys],
        ["PFCOUNT"] + [f"{k}:term" for k in uv_keys],
        ["PFCOUNT"] + [f"{k}:web" for k in uv_keys],
    ]
    res = store.pipeline(cmds)
    if res is None:
        return {"enabled": True, "error": "storage unreachable"}

    def num(v) -> int:
        try:
            return int(float(v))
        except (TypeError, ValueError):
            return 0

    daily = res[1] or []
    # index 0 is today, so reverse into chronological order for the chart
    series = [{"date": _day(i), "views": num(daily[i] if i < len(daily) else 0)}
              for i in range(days)][::-1]

    recent = []
    for raw in (res[12] or []):
        try:
            recent.append(json.loads(raw))
        except Exception:
            continue

    def prop_series(raw_list) -> list[dict]:
        raw_list = raw_list or []
        return [{"date": _day(i), "views": num(raw_list[i] if i < len(raw_list) else 0)}
                for i in range(days)][::-1]

    term_series = prop_series(res[13])
    web_series = prop_series(res[14])

    period_views = sum(p["views"] for p in series)
    return {
        "enabled": True,
        "days": days,
        # İki siteyi ayrı ayrı görebilmek için. Toplamlarla birebir tutmayabilir:
        # mülk sayaçları bu özellik eklendikten sonra başladı, eski günler boş.
        "properties": {
            "terminal": {
                "series": term_series,
                "periodViews": sum(p["views"] for p in term_series),
                "periodVisitors": num(res[15]),
                "todayViews": term_series[-1]["views"] if term_series else 0,
            },
            "web": {
                "series": web_series,
                "periodViews": sum(p["views"] for p in web_series),
                "periodVisitors": num(res[16]),
                "todayViews": web_series[-1]["views"] if web_series else 0,
            },
        },
        "totals": {
            "allTimeViews": num(res[0]),
            "periodViews": period_views,
            "periodVisitors": num(res[2]),
            "todayViews": series[-1]["views"] if series else 0,
            "todayVisitors": num(res[3]),
            "onlineNow": num(res[5]),
        },
        "series": series,
        "topPages": _pairs(res[6]),
        "topQueries": _pairs(res[7]),
        "topSymbols": _pairs(res[8]),
        "topFunds": _pairs(res[9]),
        "topCountries": _pairs(res[10]),
        "topReferrers": _pairs(res[11]),
        "recent": recent,
    }


def reset(scope: str = "all") -> bool:
    """Wipe analytics. `scope` is 'all' or one of the leaderboard names."""
    groups = {
        "queries": ["fl:q"], "symbols": ["fl:sym"], "funds": ["fl:fund"],
        "pages": ["fl:page"], "geo": ["fl:geo"], "referrers": ["fl:ref"],
        "recent": ["fl:recent"], "live": ["fl:live"],
    }
    if scope == "all":
        keys = [k for group in groups.values() for k in group] + ["fl:pv:total"]
        keys += [f"fl:pv:d:{_day(i)}" for i in range(90)]
        keys += [f"fl:uv:d:{_day(i)}" for i in range(90)]
    else:
        keys = groups.get(scope, [])
    if not keys:
        return False
    return store.pipeline([["DEL"] + keys]) is not None
