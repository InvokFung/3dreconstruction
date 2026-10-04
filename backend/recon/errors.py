"""Pipeline error types.

Every failure that should reach the user is raised as :class:`ReconError` with one of the
contract error codes (see docs/ARCHITECTURE.md section 1) and a message that tells the user
what to do about it.
"""

from __future__ import annotations

from typing import Final, Literal

ErrorCode = Literal[
    "too_few_images",
    "too_few_registered",
    "no_subject_found",
    "out_of_memory",
    "unsupported_input",
    "engine_unavailable",
    "internal",
]

ERROR_CODES: Final[tuple[str, ...]] = (
    "too_few_images",
    "too_few_registered",
    "no_subject_found",
    "out_of_memory",
    "unsupported_input",
    "engine_unavailable",
    "internal",
)


class ReconError(Exception):
    """A user-facing pipeline failure with a contract error code."""

    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: ErrorCode = code
        self.message = message


class Cancelled(Exception):
    """Raised when the job was cancelled (SIGTERM)."""


def is_oom(exc: BaseException) -> bool:
    """Best-effort detection of out-of-memory conditions from numpy/torch/open3d."""
    if isinstance(exc, MemoryError):
        return True
    text = f"{type(exc).__name__}: {exc}".lower()
    needles = (
        "out of memory",
        "cuda error: out of memory",
        "can't allocate memory",
        "cannot allocate memory",
        "defaultcpuallocator",
        "bad_alloc",
        "std::bad_alloc",
        "unable to allocate",
    )
    return any(n in text for n in needles)
