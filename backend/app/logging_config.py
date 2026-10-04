"""Structured logging: JSON lines (LOG_FORMAT=json) or readable key=value text."""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime

_STD_ATTRS = set(vars(logging.makeLogRecord({})).keys()) | {"message", "asctime", "taskName"}


def _extras(record: logging.LogRecord) -> dict:
    return {k: v for k, v in record.__dict__.items() if k not in _STD_ATTRS and not k.startswith("_")}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        data = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        data.update(_extras(record))
        if record.exc_info:
            data["exc"] = self.formatException(record.exc_info)
        return json.dumps(data, default=str)


class TextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        ts = datetime.fromtimestamp(record.created, UTC).strftime("%Y-%m-%d %H:%M:%S")
        extras = " ".join(f"{k}={v}" for k, v in _extras(record).items())
        line = f"{ts} {record.levelname:<7} {record.name}: {record.getMessage()}" + (f"  {extras}" if extras else "")
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        return line


def setup_logging(level: str = "INFO", fmt: str = "text") -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonFormatter() if fmt == "json" else TextFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    for name in ("uvicorn", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers[:] = []
        lg.propagate = True
    # We log requests ourselves (without query strings, which may hold tokens).
    logging.getLogger("uvicorn.access").disabled = True
