"""JSON-lines protocol on stdout (see docs/ARCHITECTURE.md section 1).

The CLI redirects file descriptor 1 to stderr at startup so that nothing printed by native
libraries (COLMAP, Open3D, ...) can corrupt the protocol stream. The original stdout is kept as
a private duplicate and only :class:`Emitter` writes to it.
"""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Iterable

log = logging.getLogger("recon")


class Emitter:
    """Thread-safe writer of protocol messages to a file descriptor."""

    def __init__(self, fd: int) -> None:
        self._fd = fd
        self._lock = threading.Lock()
        self.closed = False

    def emit(self, obj: dict[str, Any]) -> None:
        if self.closed:
            return
        data = (json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=_json_default) + "\n").encode()
        with self._lock:
            view = memoryview(data)
            while view:
                try:
                    n = os.write(self._fd, view)
                except InterruptedError:
                    continue
                except OSError:
                    # The reader went away; nothing sensible left to do with protocol output.
                    self.closed = True
                    return
                view = view[n:]

    def log(self, level: str, message: str) -> None:
        self.emit({"type": "log", "level": level, "message": message})

    def error(self, code: str, message: str) -> None:
        self.emit({"type": "error", "code": code, "message": message})

    def result(self, artifacts: list[dict[str, str]], metrics: dict[str, Any]) -> None:
        self.emit({"type": "result", "artifacts": artifacts, "metrics": metrics})


def _json_default(o: Any) -> Any:
    # numpy scalars/arrays and paths sneak into metrics easily.
    try:
        import numpy as np

        if isinstance(o, np.generic):
            return o.item()
        if isinstance(o, np.ndarray):
            return o.tolist()
    except ImportError:  # pragma: no cover
        pass
    if isinstance(o, os.PathLike):
        return os.fspath(o)
    return str(o)


class ProtocolLogHandler(logging.Handler):
    """Forwards records of the ``recon`` logger to the protocol as ``log`` lines."""

    _LEVELS = {logging.DEBUG: "debug", logging.INFO: "info", logging.WARNING: "warning", logging.ERROR: "error"}

    def __init__(self, emitter: Emitter, level: int = logging.INFO) -> None:
        super().__init__(level)
        self.emitter = emitter

    def emit(self, record: logging.LogRecord) -> None:
        try:
            level = self._LEVELS.get(record.levelno, "error" if record.levelno > logging.ERROR else "info")
            self.emitter.log(level, record.getMessage())
        except Exception:  # pragma: no cover - logging must never raise
            self.handleError(record)


@dataclass
class _StageState:
    name: str
    start: float
    weight: float
    t0: float = field(default_factory=time.monotonic)


class Progress:
    """Maps per-stage fractions onto a monotonic 0-100 overall percentage.

    ``plan`` lists ``(stage, weight)``; weights are normalised to 100. Stages may be skipped;
    entering a later stage jumps progress forward, never backward.
    """

    def __init__(self, emitter: Emitter | None, plan: Iterable[tuple[str, float]], min_interval: float = 0.25) -> None:
        self.emitter = emitter
        plan = list(plan)
        total = sum(w for _, w in plan) or 1.0
        self._starts: dict[str, tuple[float, float]] = {}
        acc = 0.0
        for name, w in plan:
            span = 100.0 * w / total
            self._starts[name] = (acc, span)
            acc += span
        self._current: _StageState | None = None
        self._last_value = 0.0
        self._last_emit_t = 0.0
        self._last_msg: str | None = None
        self._min_interval = min_interval
        self.timings: dict[str, float] = {}
        self._lock = threading.Lock()
        self.cancel_check: Any = None  # optional callable raising Cancelled

    @property
    def value(self) -> float:
        return self._last_value

    @property
    def stage_name(self) -> str | None:
        return self._current.name if self._current else None

    def stage(self, name: str, message: str | None = None) -> None:
        """Enter ``name`` (finishing the previous stage)."""
        self._finish_current()
        start, span = self._starts.get(name, (self._last_value, 0.0))
        self._current = _StageState(name=name, start=max(start, self._last_value), weight=span)
        self._emit(self._current.start, message or f"{name.capitalize()}...", force=True)

    def update(self, fraction: float, message: str | None = None, force: bool = False) -> None:
        if self.cancel_check is not None:
            self.cancel_check()
        if self._current is None:
            return
        if not math.isfinite(fraction):
            fraction = 0.0
        fraction = min(max(fraction, 0.0), 1.0)
        start, span = self._starts.get(self._current.name, (self._current.start, self._current.weight))
        value = start + span * fraction
        self._emit(value, message, force=force)

    def message(self, message: str) -> None:
        self._emit(self._last_value, message, force=True)

    def finish(self) -> None:
        self._finish_current()
        self._emit(100.0, "Done", force=True)

    def sub(self, lo: float, hi: float) -> "SubProgress":
        return SubProgress(self, lo, hi)

    # -- internals -------------------------------------------------------------------------

    def _finish_current(self) -> None:
        if self._current is not None:
            dt = time.monotonic() - self._current.t0
            self.timings[self._current.name] = round(self.timings.get(self._current.name, 0.0) + dt, 3)
            self._current = None

    def _emit(self, value: float, message: str | None, force: bool = False) -> None:
        with self._lock:
            value = round(min(max(value, self._last_value), 100.0), 1)
            now = time.monotonic()
            changed_msg = message is not None and message != self._last_msg
            if not force and not changed_msg and (now - self._last_emit_t) < self._min_interval:
                self._last_value = value
                return
            if not force and not changed_msg and value == self._last_value:
                return
            self._last_value = value
            self._last_emit_t = now
            if message is not None:
                self._last_msg = message
            if self.emitter is not None:
                self.emitter.emit(
                    {
                        "type": "progress",
                        "stage": self._current.name if self._current else "export",
                        "progress": value,
                        "message": self._last_msg or "",
                    }
                )


class SubProgress:
    """A view onto a fraction range ``[lo, hi]`` of the current stage."""

    def __init__(self, parent: Progress, lo: float, hi: float) -> None:
        self.parent, self.lo, self.hi = parent, lo, hi

    def update(self, fraction: float, message: str | None = None) -> None:
        fraction = min(max(fraction, 0.0), 1.0)
        self.parent.update(self.lo + (self.hi - self.lo) * fraction, message)

    def message(self, message: str) -> None:
        self.parent.update(self.lo, message)

    def sub(self, lo: float, hi: float) -> "SubProgress":
        span = self.hi - self.lo
        return SubProgress(self.parent, self.lo + span * lo, self.lo + span * hi)
