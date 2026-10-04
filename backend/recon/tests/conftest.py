"""Test setup: make ``recon`` importable when running ``pytest`` from backend/ or backend/recon/."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

REPO = BACKEND.parent
SAMPLES = REPO / "samples"


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "slow: end-to-end runs that take minutes (deselect with -m 'not slow')")


@pytest.fixture
def samples_dir() -> Path:
    return SAMPLES
