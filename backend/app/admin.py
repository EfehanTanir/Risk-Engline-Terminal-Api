# Finansla Terminal - https://terminal.finansla.net
# Copyright (c) 2026 Efehan Tanırgan. Tüm hakları saklıdır.
# Bu dosya özel mülkiyettir; izinsiz kopyalanamaz, çoğaltılamaz veya dağıtılamaz.

"""Admin panel API: servis sağlığı, ziyaretçi analitiği ve halka açık izleme
sinyali (/api/track).

Kimlik doğrulama: kullanıcı adı YOK, şifre YOK. Yalnızca authenticator
uygulamasındaki 6 haneli TOTP kodu (`ADMIN_TOTP_SECRET` ortam değişkeni).
Doğrulanan koda karşılık 8 saatlik, imzalı ve durumsuz bir oturum jetonu
verilir; panel sonraki isteklerde bu jetonu `X-Admin-Session` başlığıyla yollar.

Frontend statik ve herkese açık olduğu için sır asla JS içinde olamaz —
doğrulama yalnızca burada yapılır. `ADMIN_TOTP_SECRET` tanımlı değilse admin
uçları her isteği reddeder; unutulmuş bir değişken paneli sessizce açmaz.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import os
import time
import urllib.parse
from typing import Optional

import requests
from fastapi import APIRouter, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field

from . import analytics, posts, sitecfg, store, totp
from . import tefas_client as tefas
from . import yahoo

router = APIRouter()

# TOTP tek faktör olduğu için kaba kuvvet koruması kritik: 6 hane = 1M olasılık
# ve kod ~90 saniye geçerli. Bu limitler Upstash yapılandırılmışsa uygulanır.
MAX_FAILS = 10
FAIL_WINDOW = 900       # 15 dakika

# Her soğuk başlangıçta sıfırlanır; panel bu örneğin ne kadardır ayakta
# olduğunu ve ne kadar istek gördüğünü gösterebilsin diye.
_BOOT = time.time()
_SERVED = 0


# ---- kimlik doğrulama ----------------------------------------------------

def _ip_key(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    ip = fwd.split(",")[0].strip() if fwd else (
        request.client.host if request.client else "0.0.0.0")
    return hashlib.sha256(ip.encode()).hexdigest()[:16]


def _fail_count(ip_hash: str) -> int:
    if not store.enabled():
        return 0
    try:
        return int(store.cmd("GET", f"fl:authfail:{ip_hash}") or 0)
    except (TypeError, ValueError):
        return 0


def _note_fail(ip_hash: str) -> None:
    if store.enabled():
        store.pipeline([["INCR", f"fl:authfail:{ip_hash}"],
                        ["EXPIRE", f"fl:authfail:{ip_hash}", FAIL_WINDOW]])


def _claim_counter(counter: int) -> bool:
    """Aynı 6 haneli kodun ikinci kez kullanılmasını engeller (replay). Depolama
    kapalıysa engelleyemeyiz — kod yine de 90 saniyede geçersiz olur."""
    if not store.enabled():
        return True
    return store.cmd("SET", f"fl:totpused:{counter}", "1", "NX", "EX", 120) == "OK"


def require_session(x_admin_session: Optional[str] = Header(None)) -> None:
    if not totp.configured():
        raise HTTPException(503, "ADMIN_TOTP_SECRET sunucuda tanımlı değil")
    if not totp.verify_session(x_admin_session):
        raise HTTPException(401, "Oturum geçersiz veya süresi dolmuş")


class LoginRequest(BaseModel):
    code: str = Field(default="", max_length=12)


@router.post("/api/admin/login")
def api_login(req: LoginRequest, request: Request):
    if not totp.configured():
        raise HTTPException(503, "ADMIN_TOTP_SECRET sunucuda tanımlı değil")

    ip_hash = _ip_key(request)
    if _fail_count(ip_hash) >= MAX_FAILS:
        raise HTTPException(429, "Çok fazla hatalı deneme. 15 dakika bekleyin.")

    ok, counter = totp.verify_code(req.code)
    if not ok:
        _note_fail(ip_hash)
        raise HTTPException(401, "Kod geçersiz")
    if not _claim_counter(counter):
        raise HTTPException(401, "Bu kod zaten kullanıldı — sıradakini bekleyin")

    if store.enabled():
        store.cmd("DEL", f"fl:authfail:{ip_hash}")
    token, expires = totp.issue_session()
    return {"token": token, "expiresAt": expires}


@router.get("/api/admin/ping")
def api_admin_ping(x_admin_session: Optional[str] = Header(None)):
    """Mevcut oturumun hâlâ geçerli olup olmadığını ucuza kontrol eder."""
    require_session(x_admin_session)
    return {"ok": True, "analyticsEnabled": store.enabled()}


# ---- halka açık izleme sinyali -------------------------------------------

class TrackEvent(BaseModel):
    page: str = Field(default="unknown", max_length=60)
    ref: str = Field(default="", max_length=200)
    query: str = Field(default="", max_length=60)
    symbol: str = Field(default="", max_length=24)
    fund: str = Field(default="", max_length=10)


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"


def _ref_host(ref: str) -> str:
    """Yönlendiren adres yalnızca alan adı olarak anlamlı — yol ve sorgu atılır."""
    if not ref:
        return ""
    try:
        host = urllib.parse.urlparse(ref).netloc.lower()
    except Exception:
        return ""
    if not host or "finansla.net" in host:
        return ""          # kendi sayfalarımız yönlendiren sayılmaz
    return host[:60]


@router.post("/api/track")
def api_track(event: TrackEvent, request: Request):
    """Her sayfa açılışında çağrılır. Tasarım gereği halka açık: ucuz kalır,
    ham IP saklamaz ve analitik kapalıyken bile 200 döner — tarayıcı bir izleme
    çağrısından asla hata görmemeli."""
    if not store.enabled():
        return {"ok": False, "reason": "storage not configured"}

    ip = _client_ip(request)
    ua = request.headers.get("user-agent", "")[:200]
    city = urllib.parse.unquote(request.headers.get("x-vercel-ip-city", ""))

    try:
        analytics.record(
            page=event.page,
            visitor=analytics.visitor_id(ip, ua),
            country=request.headers.get("x-vercel-ip-country", ""),
            city=city,
            ref=_ref_host(event.ref),
            query=event.query,
            symbol=event.symbol,
            fund=event.fund,
        )
    except Exception:
        return {"ok": False}
    return {"ok": True}


# ---- servis sağlığı ------------------------------------------------------

def _timed(fn, *args):
    """Sondayı çalıştırır, (ok, ms, detay) döner ve her hatayı yutar."""
    t0 = time.time()
    try:
        result = fn(*args)
        return bool(result), round((time.time() - t0) * 1000, 1), None
    except Exception as exc:
        return False, round((time.time() - t0) * 1000, 1), str(exc)[:200]


def _probe_yahoo():
    return yahoo.light_quote("AAPL")


def _probe_tefas():
    return tefas.fund_info("NNF")


def _probe_news():
    resp = requests.get(
        "https://news.google.com/rss/search",
        params={"q": "borsa", "hl": "tr", "gl": "TR", "ceid": "TR:tr"},
        headers={"User-Agent": "Mozilla/5.0"}, timeout=10,
    )
    resp.raise_for_status()
    return b"<item" in resp.content or b"<entry" in resp.content


@router.get("/api/admin/health")
def api_health(x_admin_session: Optional[str] = Header(None)):
    require_session(x_admin_session)

    probes = {"yahoo": _probe_yahoo, "tefas": _probe_tefas, "news": _probe_news}
    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = {name: pool.submit(_timed, fn) for name, fn in probes.items()}
        for name, fut in futures.items():
            try:
                ok, ms, detail = fut.result(timeout=30)
            except Exception as exc:
                ok, ms, detail = False, None, str(exc)[:200]
            results[name] = {"ok": ok, "ms": ms, "detail": detail}

    redis_ok, redis_ms, redis_err = store.ping()
    results["storage"] = {"ok": redis_ok, "ms": redis_ms, "detail": redis_err}

    from .main import MAX_ASSETS, MC_SIMS, RF_TRY, RF_USD, _heatmap_cache, _history_cache

    fund_cache = getattr(tefas, "_fund_list_cache", {}) or {}
    cached_funds = fund_cache.get("data")
    return {
        "checkedAt": int(time.time()),
        "services": results,
        "instance": {
            "uptimeSec": round(time.time() - _BOOT, 1),
            "requestsServed": _SERVED,
            "region": os.environ.get("VERCEL_REGION") or "local",
            "env": os.environ.get("VERCEL_ENV") or "development",
            "commit": (os.environ.get("VERCEL_GIT_COMMIT_SHA") or "")[:7],
        },
        "caches": {
            "history": len(_history_cache),
            "heatmap": sorted(_heatmap_cache.keys()),
            "fundUniverse": len(cached_funds) if cached_funds else 0,
            "fundUniverseAgeSec": (round(time.time() - fund_cache.get("t", 0))
                                   if fund_cache.get("t") else None),
        },
        "config": {
            "RF_TRY": RF_TRY, "RF_USD": RF_USD,
            "MAX_ASSETS": MAX_ASSETS, "MC_SIMS": MC_SIMS,
            "analyticsEnabled": store.enabled(),
            # Depolama kapalıyken giriş denemeleri sınırlanamıyor — panelde göster.
            "loginRateLimited": store.enabled(),
        },
    }


# ---- analitik ------------------------------------------------------------

@router.get("/api/admin/stats")
def api_stats(days: int = Query(14, ge=1, le=90),
              x_admin_session: Optional[str] = Header(None)):
    require_session(x_admin_session)
    return analytics.summary(days)


class ResetRequest(BaseModel):
    scope: str = "all"


@router.post("/api/admin/reset")
def api_reset(req: ResetRequest, x_admin_session: Optional[str] = Header(None)):
    require_session(x_admin_session)
    if not analytics.reset(req.scope):
        raise HTTPException(400, f"Bilinmeyen kapsam '{req.scope}' veya depolama yok")
    return {"ok": True, "scope": req.scope}


# ---- site kontrolü (duyuru bandı + bakım modu) ---------------------------

@router.get("/api/site-config")
def api_site_config(scope: str = "terminal"):
    """Halka açık: her sayfa açılışında okunur. Örnek başına 20 sn önbellekli,
    Redis erişilemezse varsayılana (duyuru yok, bakım yok) düşer — depolama
    kesintisi siteyi yanlışlıkla bakıma sokmasın.

    `scope`: "terminal" (varsayılan) veya "web" (finansla.net). Terminalin
    site.js'i parametresiz çağırdığı için varsayılan değişmemeli."""
    return sitecfg.get_config(scope=scope)


class SiteBanner(BaseModel):
    active: bool = False
    level: str = "info"
    tr: str = Field(default="", max_length=400)
    en: str = Field(default="", max_length=400)
    expiresHours: float = Field(default=0, ge=0, le=720)   # 0 = süresiz


class SiteMaintenance(BaseModel):
    active: bool = False
    tr: str = Field(default="", max_length=400)
    en: str = Field(default="", max_length=400)


class SiteConfigRequest(BaseModel):
    banner: SiteBanner = SiteBanner()
    maintenance: SiteMaintenance = SiteMaintenance()


@router.get("/api/admin/site")
def api_site_get(scope: str = "terminal",
                 x_admin_session: Optional[str] = Header(None)):
    require_session(x_admin_session)
    return sitecfg.get_config(fresh=True, scope=scope)   # panelde bayat veri gösterme


@router.post("/api/admin/site")
def api_site_save(req: SiteConfigRequest, scope: str = "terminal",
                  x_admin_session: Optional[str] = Header(None)):
    require_session(x_admin_session)
    saved = sitecfg.save_config(req.model_dump(), scope=scope)
    if saved is None:
        raise HTTPException(503, "Depolama yapılandırılmamış — Upstash gerekli")
    return saved


# ---- eğitim yazıları -----------------------------------------------------

class FaqItem(BaseModel):
    q: str = Field(default="", max_length=300)
    a: str = Field(default="", max_length=1000)


class PostRequest(BaseModel):
    slug: str = Field(default="", max_length=120)
    oldSlug: str = Field(default="", max_length=120)
    title: str = Field(default="", max_length=300)
    category: str = Field(default="", max_length=80)
    excerpt: str = Field(default="", max_length=600)
    metaTitle: str = Field(default="", max_length=300)
    metaDescription: str = Field(default="", max_length=300)
    cover: str = Field(default="", max_length=300)
    body: str = Field(default="", max_length=120_000)
    date: str = Field(default="", max_length=10)
    published: bool = False
    faq: list[FaqItem] = []


@router.get("/api/admin/posts")
def api_posts_list(x_admin_session: Optional[str] = Header(None)):
    """Taslaklar dahil tüm yazılar (gövde metni olmadan)."""
    require_session(x_admin_session)
    return {"posts": posts.listing()}


@router.get("/api/admin/post")
def api_post_get(slug: str = Query(..., min_length=1),
                 x_admin_session: Optional[str] = Header(None)):
    require_session(x_admin_session)
    post = posts.get(slug)
    if post is None:
        raise HTTPException(404, "Yazı bulunamadı")
    return post


@router.post("/api/admin/post")
def api_post_save(req: PostRequest,
                  x_admin_session: Optional[str] = Header(None)):
    require_session(x_admin_session)
    if not req.title.strip():
        raise HTTPException(400, "Başlık boş olamaz")
    saved = posts.save(req.model_dump(), old_slug=req.oldSlug or None)
    if saved is None:
        raise HTTPException(503, "Depolama yapılandırılmamış — Upstash gerekli")
    return saved


class SlugRequest(BaseModel):
    slug: str = Field(..., min_length=1, max_length=120)


@router.post("/api/admin/post/delete")
def api_post_delete(req: SlugRequest,
                    x_admin_session: Optional[str] = Header(None)):
    require_session(x_admin_session)
    if not posts.delete(req.slug):
        raise HTTPException(503, "Silinemedi — depolama yok")
    return {"ok": True, "slug": req.slug}


def note_request() -> None:
    """main.py'deki middleware'den çağrılır; bu örneğin trafiğini sayar."""
    global _SERVED
    _SERVED += 1
