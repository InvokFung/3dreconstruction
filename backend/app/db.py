"""Database engine/session management and migrations."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import BACKEND_DIR, Settings

log = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


class _State:
    engine: Engine | None = None
    SessionLocal: sessionmaker[Session] | None = None
    url: str | None = None


state = _State()


def normalize_url(url: str) -> str:
    # Accept the common "postgres://" / "postgresql://" forms and use psycopg 3.
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


def make_engine(database_url: str) -> Engine:
    url = normalize_url(database_url)
    if url.startswith("sqlite"):
        u = make_url(url)
        if u.database and u.database != ":memory:":
            Path(u.database).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
        engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30})

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _rec):  # pragma: no cover - trivial
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA busy_timeout=30000")
            cur.close()

        return engine
    return create_engine(url, pool_pre_ping=True, pool_size=10, max_overflow=20)


def init_engine(settings: Settings) -> Engine:
    """(Re)initialise the global engine for these settings."""
    url = normalize_url(settings.DATABASE_URL)
    if state.engine is not None and state.url == url:
        return state.engine
    if state.engine is not None:
        state.engine.dispose()
    state.engine = make_engine(url)
    state.SessionLocal = sessionmaker(bind=state.engine, expire_on_commit=False, autoflush=False)
    state.url = url
    return state.engine


def session() -> Session:
    assert state.SessionLocal is not None, "init_engine() not called"
    return state.SessionLocal()


def get_db() -> Iterator[Session]:
    db = session()
    try:
        yield db
    finally:
        db.close()


def run_migrations(settings: Settings) -> None:
    """Run `alembic upgrade head` programmatically (serialised with an advisory lock on Postgres)."""
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    cfg.set_main_option("sqlalchemy.url", normalize_url(settings.DATABASE_URL).replace("%", "%%"))
    engine = init_engine(settings)
    with engine.begin() as conn:
        if conn.dialect.name == "postgresql":
            conn.execute(text("SELECT pg_advisory_xact_lock(724411)"))
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "head")
    log.info("database migrated", extra={"db": engine.dialect.name})
