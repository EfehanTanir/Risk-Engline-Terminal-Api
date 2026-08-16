# Finansla Terminal - https://terminal.finansla.net
# Copyright (c) 2026 Efehan Tanırgan. Tüm hakları saklıdır.
# Bu dosya özel mülkiyettir; izinsiz kopyalanamaz, çoğaltılamaz veya dağıtılamaz.

# Vercel Python entrypoint — exposes the FastAPI app as a serverless function.
# vercel.json rewrites all paths here, so /api/* routes work unchanged.
from app.main import app  # noqa: F401
