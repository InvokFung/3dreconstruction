"""FastAPI application factory. Run: uvicorn app.main:app"""

from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .config import Settings, get_settings
from .db import init_engine, run_migrations
from .logging_config import setup_logging
from .routers import artifacts, auth, jobs, meta, projects, samples
from .storage import Storage

log = logging.getLogger("app")
access_log = logging.getLogger("app.access")


def _validation_message(exc: RequestValidationError) -> str:
    parts = []
    for err in exc.errors():
        loc = [str(x) for x in err.get("loc", ()) if x not in ("body", "query", "path")]
        msg = err.get("msg", "invalid value")
        parts.append(f"{'.'.join(loc)}: {msg}" if loc else msg)
    return "; ".join(parts) or "Invalid request"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    settings.validate_for_runtime()
    setup_logging(settings.LOG_LEVEL, settings.LOG_FORMAT)
    init_engine(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        Storage(settings).ensure()
        if settings.AUTO_MIGRATE:
            run_migrations(settings)
        log.info("api started", extra={"version": __version__, "env": settings.ENV})
        yield

    app = FastAPI(
        title="3D Reconstruction API",
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,  # bearer tokens, no cookies
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition", "Content-Length", "Content-Range", "Accept-Ranges"],
    )

    @app.middleware("http")
    async def request_log(request: Request, call_next):
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        start = time.perf_counter()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            response.headers["X-Request-ID"] = rid
            return response
        finally:
            # Path only: query strings may carry ?token=
            access_log.info(
                "request",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "status": status_code,
                    "ms": round((time.perf_counter() - start) * 1000, 1),
                    "request_id": rid,
                    "client": request.client.host if request.client else None,
                },
            )

    @app.exception_handler(StarletteHTTPException)
    async def http_exc(_req: Request, exc: StarletteHTTPException):
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        return JSONResponse({"detail": detail}, status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def validation_exc(_req: Request, exc: RequestValidationError):
        # Contract: errors are {"detail": "<human readable>"}; structured info kept under "errors".
        errors = [{"loc": list(e.get("loc", ())), "msg": e.get("msg"), "type": e.get("type")} for e in exc.errors()]
        return JSONResponse({"detail": _validation_message(exc), "errors": errors}, status_code=422)

    @app.exception_handler(Exception)
    async def unhandled(_req: Request, exc: Exception):
        log.exception("unhandled error")
        return JSONResponse({"detail": "Internal server error"}, status_code=500)

    for r in (meta.router, auth.router, projects.router, samples.router, jobs.router, artifacts.router):
        app.include_router(r)
    return app


def __getattr__(name: str):
    # Lazily build the module-level ASGI app so importing app.main in tests doesn't need env setup.
    if name == "app":
        global app
        app = create_app()
        return app
    raise AttributeError(name)
