"""Database engine/session management and migrations."""

from __future__ import annotations

import logging
import os
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
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
            cur.execute("PRAGMA busy_timeout=30000")
            cur.execute("PRAGMA foreign_keys=ON")
            # WAL is persistent in the db file, so only the first connection ever needs to switch it.
            # Switching needs an exclusive lock and can fail with "database is locked" when the API
            # and the worker start at the same moment (seen on Windows), so retry briefly.
            if cur.execute("PRAGMA journal_mode").fetchone()[0].lower() != "wal":
                for attempt in range(50):
                    try:
                        cur.execute("PRAGMA journal_mode=WAL")
                        break
                    except sqlite3.OperationalError:
                        if attempt == 49:
                            raise
                        time.sleep(0.2)
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


@contextmanager
def _sqlite_migration_lock(engine: Engine) -> Iterator[None]:
    """Serialise migrations across processes for a file-based SQLite db (API + worker start together).

    SQLite DDL isn't transactional under the driver, so without this two processes both try to
    CREATE the tables. Postgres uses an advisory lock instead (see run_migrations).
    """
    db = engine.url.database if engine.dialect.name == "sqlite" else None
    if not db or db == ":memory:":
        yield
        return
    lock = Path(db).expanduser().resolve().with_suffix(".migrate.lock")
    deadline = time.monotonic() + 120
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:  # stale lock from a crashed process
                if time.time() - lock.stat().st_mtime > 120:
                    lock.unlink(missing_ok=True)
                    continue
            except FileNotFoundError:
                continue
            if time.monotonic() > deadline:
                raise TimeoutError(f"Timed out waiting for migration lock {lock}") from None
            time.sleep(0.1)
    try:
        yield
    finally:
        os.close(fd)
        lock.unlink(missing_ok=True)


def run_migrations(settings: Settings) -> None:
    """Run `alembic upgrade head` programmatically (serialised with an advisory lock on Postgres)."""
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    cfg.set_main_option("sqlalchemy.url", normalize_url(settings.DATABASE_URL).replace("%", "%%"))
    engine = init_engine(settings)
    with _sqlite_migration_lock(engine), engine.begin() as conn:
        if conn.dialect.name == "postgresql":
            conn.execute(text("SELECT pg_advisory_xact_lock(724411)"))
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "head")
    log.info("database migrated", extra={"db": engine.dialect.name})
