from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.config import get_settings  # noqa: E402
from app.recon_runner import capabilities_cache  # noqa: E402
from app.security import rate_limiter  # noqa: E402

FAKE_CLI = Path(__file__).parent / "fake_recon" / "fake_cli.py"

from .helpers import jpeg_bytes, png_bytes  # noqa: E402


@pytest.fixture
def samples_dir(tmp_path) -> Path:
    root = tmp_path / "samples"
    (root / "mug" / "images").mkdir(parents=True)
    for i in range(1, 4):
        (root / "mug" / "images" / f"m{i}.png").write_bytes(png_bytes(320, 240, (i * 40, 80, 120)))
    (root / "mug" / "meta.json").write_text(json.dumps({"title": "Coffee mug", "description": "Three photos."}))
    (root / "nometa" / "images").mkdir(parents=True)
    (root / "nometa" / "images" / "a.jpg").write_bytes(jpeg_bytes(100, 100))
    (root / "not_a_sample").mkdir()
    return root


def _reset_postgres(url: str) -> None:
    from sqlalchemy import text

    from app.db import init_engine

    get_settings.cache_clear()
    engine = init_engine(get_settings())
    with engine.begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))


@pytest.fixture
def env(tmp_path, monkeypatch, samples_dir):
    data = tmp_path / "data"
    values = {
        "ENV": "test",
        # Set TEST_DATABASE_URL=postgresql://... to run the whole suite against Postgres.
        "DATABASE_URL": os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{tmp_path / 'test.db'}",
        "DATA_DIR": str(data),
        "SAMPLES_DIR": str(samples_dir),
        "SECRET_KEY": "test-secret-key-0123456789abcdef0123456789",
        "RECON_COMMAND": f"{sys.executable} {FAKE_CLI}",
        "CANCEL_GRACE_SECONDS": "1",
        "WORKER_POLL_SECONDS": "0.05",
        "PROGRESS_WRITE_INTERVAL": "0.1",
        "HEARTBEAT_SECONDS": "0.5",
        "SSE_POLL_SECONDS": "0.05",
        "SSE_KEEPALIVE_SECONDS": "0.3",
        "AUTH_RATE_LIMIT": "1000",
        "LOG_LEVEL": "WARNING",
        "CORS_ORIGINS": "http://localhost:5173",
    }
    for k, v in values.items():
        monkeypatch.setenv(k, v)
    for k in (
        "FAKE_RECON_MODE",
        "FAKE_RECON_DELAY",
        "FAKE_RECON_GENERATIVE",
        "JOB_TIMEOUT_SECONDS",
        "MAX_UPLOAD_MB",
        "MAX_FILES_PER_PROJECT",
        "RECON_PYTHON",
    ):
        monkeypatch.delenv(k, raising=False)
    get_settings.cache_clear()
    capabilities_cache.clear()
    rate_limiter.reset()
    if os.environ.get("TEST_DATABASE_URL"):
        _reset_postgres(values["DATABASE_URL"])
    yield get_settings()
    get_settings.cache_clear()
    capabilities_cache.clear()


@pytest.fixture
def client(env):
    from app.main import create_app

    with TestClient(create_app(env)) as c:
        yield c


class Api:
    def __init__(self, client: TestClient):
        self.c = client
        self._n = 0

    def register(self, email=None, password="correct horse battery", name="Tester"):
        self._n += 1
        email = email or f"user{self._n}-{time.monotonic_ns()}@example.com"
        r = self.c.post("/api/auth/register", json={"email": email, "password": password, "name": name})
        assert r.status_code == 201, r.text
        tok = r.json()["access_token"]
        return {"Authorization": f"Bearer {tok}"}, tok

    def project(self, headers, name="Proj"):
        r = self.c.post("/api/projects", json={"name": name}, headers=headers)
        assert r.status_code == 201, r.text
        return r.json()

    def upload(self, headers, pid, files):
        return self.c.post(
            f"/api/projects/{pid}/images", headers=headers, files=[("files", (n, d, "application/octet-stream")) for n, d in files]
        )

    def project_with_images(self, headers, n=3):
        p = self.project(headers)
        r = self.upload(headers, p["id"], [(f"img{i}.png", png_bytes(64, 48)) for i in range(n)])
        assert r.status_code == 201, r.text
        return p

    def wait_job(self, headers, jid, statuses=("succeeded", "failed", "canceled"), timeout=20.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            j = self.c.get(f"/api/jobs/{jid}", headers=headers).json()
            if j["status"] in statuses:
                return j
            time.sleep(0.05)
        raise AssertionError(f"job {jid} did not reach {statuses}; last={j}")


@pytest.fixture
def api(client):
    return Api(client)


@pytest.fixture
def worker(env, client):
    from app.worker import Worker

    w = Worker(env, write_capabilities=False)
    t = threading.Thread(target=w.run_forever, daemon=True)
    t.start()
    yield w
    w.stop()
    t.join(timeout=30)
