# Finansla Terminal · Copyright (c) 2026 Efehan Tanırgan
# SPDX-License-Identifier: LicenseRef-Finansla-Proprietary

"""TOTP (RFC 6238) doğrulama ve imzalı oturum jetonu — sadece stdlib.

Admin paneline giriş tek adımdır: kullanıcı adı ve şifre yoktur, yalnızca
authenticator uygulamasının (Google Authenticator, Proton Authenticator, Aegis,
1Password …) ürettiği 6 haneli kod istenir.

`pyotp` kasıtlı olarak kullanılmadı: HOTP zaten 15 satır ve projeye Vercel'de
kurulacak yeni bir bağımlılık eklememek daha güvenli.

Kod doğrulandıktan sonra istemciye kısa ömürlü, HMAC ile imzalanmış bir oturum
jetonu verilir. Jeton kendi kendini doğrular (stateless), böylece her istekte
yeni bir TOTP kodu gerekmez — kodlar 30 saniyede bir değişiyor.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import struct
import time
from typing import Optional

SECRET = ((os.environ.get("ADMIN_TOTP_SECRET") or "")
          .strip().strip('"').strip("'")     # tırnakla yapıştırılırsa temizle
          .replace(" ", "").upper())         # authenticator'daki 4'lü gruplar

STEP = 30          # TOTP periyodu (saniye) — authenticator uygulamalarının standardı
DIGITS = 6
DRIFT = 1          # ±1 adım: telefon ile sunucu saati arasındaki kaymaya tolerans
SESSION_HOURS = 8  # oturum ömrü


def configured() -> bool:
    return len(SECRET) >= 16


def _secret_bytes() -> bytes:
    pad = "=" * (-len(SECRET) % 8)
    return base64.b32decode(SECRET + pad, casefold=True)


def _hotp(key: bytes, counter: int) -> str:
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % (10 ** DIGITS)).zfill(DIGITS)


def verify_code(code: str) -> tuple[bool, Optional[int]]:
    """(geçerli mi, kullanılan sayaç). Sayaç, aynı kodun ikinci kez
    kullanılmasını engellemek için çağıran tarafa döner."""
    if not configured():
        return False, None
    code = (code or "").strip().replace(" ", "")
    if not code.isdigit() or len(code) != DIGITS:
        return False, None
    try:
        key = _secret_bytes()
    except Exception:
        return False, None

    counter = int(time.time()) // STEP
    for drift in range(-DRIFT, DRIFT + 1):
        # compare_digest: doğru rakam sayısından zamanlama üzerinden bilgi sızmasın
        if hmac.compare_digest(_hotp(key, counter + drift), code):
            return True, counter + drift
    return False, None


# ---- oturum jetonu -------------------------------------------------------

def _session_key() -> bytes:
    """İmzalama anahtarı TOTP sırrından türetilir, böylece Vercel'de tek bir
    ortam değişkeni yönetmek yeterli oluyor."""
    return hashlib.sha256(b"finansla-session|" + SECRET.encode()).digest()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def issue_session() -> tuple[str, int]:
    """(jeton, bitiş zamanı). Sunucuda hiçbir şey saklanmaz."""
    expires = int(time.time()) + SESSION_HOURS * 3600
    payload = str(expires).encode()
    sig = hmac.new(_session_key(), payload, hashlib.sha256).digest()
    return f"{_b64(payload)}.{_b64(sig)}", expires


def verify_session(token: Optional[str]) -> bool:
    if not configured() or not token or "." not in token:
        return False
    try:
        payload_b64, sig_b64 = token.split(".", 1)
        payload = _unb64(payload_b64)
        expected = hmac.new(_session_key(), payload, hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64(sig_b64)):
            return False
        return int(payload.decode()) > int(time.time())
    except Exception:
        return False


def provisioning_uri(label: str = "Finansla Terminal") -> str:
    """Authenticator uygulamasına elle girmek yerine QR ile eklemek istersen."""
    issuer = "Finansla"
    return (f"otpauth://totp/{issuer}:{label.replace(' ', '%20')}"
            f"?secret={SECRET}&issuer={issuer}&algorithm=SHA1"
            f"&digits={DIGITS}&period={STEP}")
