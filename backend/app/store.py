# Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
# SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

"""Optional Upstash Redis (REST) storage, used only by the admin analytics.

Vercel functions have no disk and no memory shared between instances, so visit
counters have to live outside the process. Upstash speaks plain HTTP, which
means no driver, no connection pool and no new dependency — just `requests`,
which the project already ships.

Configure with two environment variables in the Vercel dashboard:

    UPSTASH_REDIS_REST_URL     https://xxxx.upstash.io
    UPSTASH_REDIS_REST_TOKEN   AX...

Everything here fails soft. If the variables are missing or Upstash is having a
bad day, `enabled()` is False and every call returns None: analytics must never
be able to break the terminal itself.
"""
from __future__ import annotations

import os
import time
from typing import Any, Optional

import requests

def _env(name: str) -> str:
    """Upstash değerleri panoya `KEY="deger"` biçiminde kopyalanıyor; tırnaklar
    yanlışlıkla yapıştırılırsa sessizce bozulmasın diye temizliyoruz."""
    return (os.environ.get(name) or "").strip().strip('"').strip("'").strip()


REST_URL = _env("UPSTASH_REDIS_REST_URL").rstrip("/")
REST_TOKEN = _env("UPSTASH_REDIS_REST_TOKEN")

TIMEOUT = 4  # keep well inside the function budget; nothing here blocks a user


def enabled() -> bool:
    return bool(REST_URL and REST_TOKEN)


def _headers() -> dict:
    return {"Authorization": f"Bearer {REST_TOKEN}"}


def pipeline(commands: list[list[Any]]) -> Optional[list]:
    """Run many commands in ONE HTTP round trip.

    Upstash returns [{"result": ...}, {"error": ...}, ...] in request order.
    Returns a plain list of results (None where a command errored), or None if
    storage is off or the call failed entirely.
    """
    if not enabled() or not commands:
        return None
    body = [[str(c) for c in cmd] for cmd in commands]
    try:
        resp = requests.post(f"{REST_URL}/pipeline", json=body,
                             headers=_headers(), timeout=TIMEOUT)
        resp.raise_for_status()
        return [row.get("result") for row in resp.json()]
    except Exception:
        return None


def cmd(*args: Any) -> Optional[Any]:
    """Run a single Redis command. Returns its result, or None on any failure."""
    out = pipeline([list(args)])
    return out[0] if out else None


def ping() -> tuple[bool, Optional[float], Optional[str]]:
    """(ok, latency_ms, error) — used by the admin health check."""
    if not enabled():
        return False, None, "not configured"
    t0 = time.time()
    try:
        resp = requests.post(f"{REST_URL}/pipeline", json=[["PING"]],
                             headers=_headers(), timeout=TIMEOUT)
        resp.raise_for_status()
        return True, round((time.time() - t0) * 1000, 1), None
    except Exception as exc:
        return False, round((time.time() - t0) * 1000, 1), str(exc)[:200]
