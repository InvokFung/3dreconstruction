"""How the backend invokes the pipeline CLI (never imported in-process), plus capabilities caching."""

from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess
import threading
import time
from pathlib import Path

from .config import Settings
from .storage import Storage

log = logging.getLogger(__name__)

# Env vars that the pipeline subprocess has no business seeing.
_SCRUB_ENV = ("SECRET_KEY", "DATABASE_URL")


def recon_command(settings: Settings) -> list[str]:
    if settings.RECON_COMMAND:
        return shlex.split(settings.RECON_COMMAND)
    return [settings.RECON_PYTHON, "-m", "recon.cli"]


def recon_env(settings: Settings) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in _SCRUB_ENV}
    recon_path = str(settings.RECON_PATH)
    env["PYTHONPATH"] = recon_path + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    env["PYTHONUNBUFFERED"] = "1"
    return env


def recon_cwd(settings: Settings) -> str:
    p = settings.RECON_PATH
    return str(p) if p.is_dir() else os.getcwd()


def _unavailable(reason: str) -> dict:
    return {
        "engines": {
            "photogrammetry": {"available": False, "reason": reason},
            "generative": {"available": False, "reason": reason},
        },
        "device": None,
        "error": reason,
    }


def probe_capabilities(settings: Settings) -> dict:
    """Run `recon.cli --capabilities`. Never raises; returns an 'unavailable' object on failure."""
    cmd = recon_command(settings) + ["--capabilities"]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=settings.CAPABILITIES_TIMEOUT_SECONDS,
            env=recon_env(settings),
            cwd=recon_cwd(settings),
        )
    except subprocess.TimeoutExpired:
        return _unavailable("Pipeline capability check timed out")
    except OSError as e:
        return _unavailable(f"Pipeline could not be started: {e.strerror or e}")
    if proc.returncode != 0:
        log.warning("capabilities probe failed", extra={"rc": proc.returncode, "stderr": proc.stderr[-2000:]})
        return _unavailable("Reconstruction pipeline is not installed or failed to start")
    for line in reversed(proc.stdout.strip().splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and isinstance(data.get("engines"), dict):
            return data
    return _unavailable("Pipeline returned malformed capabilities")


def write_capabilities_file(settings: Settings, data: dict) -> None:
    path = Storage(settings).capabilities_file
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"written_at": time.time(), "capabilities": data}))
    os.replace(tmp, path)


def _read_capabilities_file(settings: Settings) -> dict | None:
    path: Path = Storage(settings).capabilities_file
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if time.time() - float(raw.get("written_at", 0)) > settings.CAPABILITIES_FILE_MAX_AGE_SECONDS:
        return None
    caps = raw.get("capabilities")
    if isinstance(caps, dict) and isinstance(caps.get("engines"), dict) and "error" not in caps:
        return caps
    return None


class CapabilitiesCache:
    """Process-wide cache. Prefers the file the worker writes (the API image may not have the
    pipeline's heavy dependencies installed); falls back to probing the CLI directly."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._value: dict | None = None
        self._expires = 0.0

    def clear(self) -> None:
        with self._lock:
            self._value, self._expires = None, 0.0

    def get(self, settings: Settings) -> dict:
        now = time.monotonic()
        with self._lock:
            if self._value is not None and now < self._expires:
                return self._value
            data = _read_capabilities_file(settings)
            if data is None:
                data = probe_capabilities(settings)
            ok = "error" not in data
            ttl = settings.CAPABILITIES_TTL_SECONDS if ok else min(30.0, settings.CAPABILITIES_TTL_SECONDS)
            self._value, self._expires = data, now + ttl
            return data


capabilities_cache = CapabilitiesCache()
