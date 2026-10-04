from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .. import __version__
from ..config import get_settings
from ..db import session
from ..recon_runner import capabilities_cache

router = APIRouter(prefix="/api", tags=["meta"])


@router.get("/health")
def health():
    db_ok = True
    try:
        with session() as db:
            db.execute(text("SELECT 1"))
    except Exception:
        db_ok = False
    body = {"status": "ok" if db_ok else "degraded", "version": __version__, "database": "ok" if db_ok else "error"}
    return JSONResponse(body, status_code=200 if db_ok else 503)


@router.get("/engines")
def engines():
    return capabilities_cache.get(get_settings())
