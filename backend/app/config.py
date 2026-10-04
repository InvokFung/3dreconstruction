"""Application settings (env vars). See docs/ARCHITECTURE.md section 3."""

from __future__ import annotations

import sys
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]  # .../backend
REPO_ROOT = BACKEND_DIR.parent

DEFAULT_SECRET_KEY = "dev-insecure-secret-key-change-me"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    ENV: Literal["development", "production", "test"] = "development"

    DATABASE_URL: str = "sqlite:///./data/app.db"
    DATA_DIR: Path = Path("./data")
    SAMPLES_DIR: Path = REPO_ROOT / "samples"

    SECRET_KEY: str = DEFAULT_SECRET_KEY
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 10080
    CORS_ORIGINS: str = "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173"

    MAX_UPLOAD_MB: int = 50
    MAX_FILES_PER_PROJECT: int = 200

    # Auth rate limiting (per client IP, per endpoint, sliding window, in-process).
    AUTH_RATE_LIMIT: int = 10
    AUTH_RATE_WINDOW_SECONDS: int = 60

    # Worker / pipeline
    WORKER_CONCURRENCY: int = Field(default=1, ge=1)
    JOB_TIMEOUT_SECONDS: int = 7200
    RECON_PYTHON: str = sys.executable
    # Directory that contains the `recon` package (prepended to PYTHONPATH, used as cwd).
    RECON_PATH: Path = BACKEND_DIR
    # Optional full command prefix override (shell-style), e.g. "python /path/fake_cli.py".
    # When set it replaces "$RECON_PYTHON -m recon.cli".
    RECON_COMMAND: str | None = None
    CANCEL_GRACE_SECONDS: float = 10.0
    WORKER_POLL_SECONDS: float = 1.0
    HEARTBEAT_SECONDS: float = 5.0
    STALE_JOB_SECONDS: float = 120.0
    MAX_JOB_ATTEMPTS: int = 2
    PROGRESS_WRITE_INTERVAL: float = 1.0

    # Capabilities (/api/engines)
    CAPABILITIES_TIMEOUT_SECONDS: float = 60.0
    CAPABILITIES_TTL_SECONDS: float = 300.0
    CAPABILITIES_FILE_MAX_AGE_SECONDS: float = 86400.0

    # SSE
    SSE_POLL_SECONDS: float = 0.5
    SSE_KEEPALIVE_SECONDS: float = 15.0

    LOG_LEVEL: str = "INFO"
    LOG_FORMAT: Literal["json", "text"] = "text"
    AUTO_MIGRATE: bool = True

    @field_validator("DATA_DIR", "SAMPLES_DIR", "RECON_PATH", mode="after")
    @classmethod
    def _abs(cls, v: Path) -> Path:
        return v.expanduser().resolve()

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    @property
    def max_upload_bytes(self) -> int:
        return self.MAX_UPLOAD_MB * 1024 * 1024

    @property
    def is_sqlite(self) -> bool:
        return self.DATABASE_URL.startswith("sqlite")

    def validate_for_runtime(self) -> None:
        """Refuse to run with insecure settings in production."""
        if self.ENV == "production":
            if self.SECRET_KEY == DEFAULT_SECRET_KEY or len(self.SECRET_KEY) < 32:
                raise RuntimeError("SECRET_KEY must be set to a random value of at least 32 characters when ENV=production")


@lru_cache
def get_settings() -> Settings:
    return Settings()
