# Vercel Python entrypoint — exposes the FastAPI app as a serverless function.
# vercel.json rewrites all paths here, so /api/* routes work unchanged.
from app.main import app  # noqa: F401
