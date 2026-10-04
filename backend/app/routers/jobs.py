from __future__ import annotations

import json
import os
import time

import anyio
from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import update
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db, session
from ..deps import owned_job, storage
from ..models import JOB_TERMINAL, Job, User, utcnow
from ..schemas import JobOut, job_out
from ..security import current_user, current_user_or_query
from ..storage import format_log_lines, parse_log_line

router = APIRouter(prefix="/api/jobs", tags=["jobs"])

LOG_BACKLOG_BYTES = 512 * 1024
LOG_READ_CHUNK = 256 * 1024


@router.get("/{job_id}", response_model=JobOut)
def get_job(job_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return job_out(owned_job(db, user, job_id))


@router.post("/{job_id}/cancel", response_model=JobOut)
def cancel_job(job_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    job = owned_job(db, user, job_id)
    now = utcnow()
    # Conditional updates avoid racing the worker's claim.
    res = db.execute(
        update(Job)
        .where(Job.id == job.id, Job.status == "queued")
        .values(status="canceled", cancel_requested=True, finished_at=now, message="Canceled")
    )
    if res.rowcount:
        msg = "Job canceled before it started"
    else:
        res = db.execute(update(Job).where(Job.id == job.id, Job.status == "running").values(cancel_requested=True))
        msg = "Cancel requested; stopping the pipeline" if res.rowcount else None
    db.commit()
    if msg:
        try:
            with open(storage().job_log(job.id), "a", encoding="utf-8") as f:
                f.write(format_log_lines("warning", msg))
        except OSError:
            pass
    db.refresh(job)
    return job_out(job)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


class _LogTail:
    def __init__(self, path: str):
        self.path = path
        self.offset: int | None = None
        self.buf = b""

    def read(self) -> list[dict]:
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return []
        if self.offset is None:
            self.offset = max(0, size - LOG_BACKLOG_BYTES)
            skip_partial = self.offset > 0
        else:
            skip_partial = False
        if size < self.offset:  # truncated (e.g. job re-queued)
            self.offset, self.buf = 0, b""
        if size == self.offset:
            return []
        with open(self.path, "rb") as f:
            f.seek(self.offset)
            data = f.read(LOG_READ_CHUNK)
        self.offset += len(data)
        data = self.buf + data
        if skip_partial:
            nl = data.find(b"\n")
            data = data[nl + 1 :] if nl >= 0 else b""
        lines = data.split(b"\n")
        self.buf = lines.pop()  # incomplete last line (or b"")
        return [parse_log_line(ln.decode("utf-8", "replace")) for ln in lines if ln.strip()]


@router.get("/{job_id}/events")
async def job_events(job_id: str, request: Request, user: User = Depends(current_user_or_query)):
    settings = get_settings()

    def _load() -> dict | None:
        db = session()
        try:
            job = db.get(Job, job_id)
            return job_out(job).model_dump() if job else None
        finally:
            db.close()

    # Ownership check up-front (404 for others' jobs) using a short-lived session.
    def _check():
        db = session()
        try:
            owned_job(db, user, job_id)
        finally:
            db.close()

    await anyio.to_thread.run_sync(_check)
    tail = _LogTail(str(storage().job_log(job_id)))

    async def stream():
        last_key = None
        last_sent = time.monotonic()
        yield "retry: 3000\n\n"
        while True:
            job = await anyio.to_thread.run_sync(_load)
            if job is None:  # deleted
                break
            terminal = job["status"] in JOB_TERMINAL
            chunks: list[str] = []
            key = (job["status"], job["stage"], job["progress"], job["message"])
            if key != last_key and (not terminal or last_key is None):
                chunks.append(_sse("job", job))  # always the first event of a stream
                last_key = key
            # Drain all available log lines (the worker writes logs before the terminal status).
            while True:
                lines = await anyio.to_thread.run_sync(tail.read)
                chunks.extend(_sse("log", ln) for ln in lines)
                if not terminal or not lines:
                    break
            if terminal:
                if key != last_key:
                    chunks.append(_sse("job", job))
                chunks.append(_sse("end", job))
                yield "".join(chunks)
                return
            now = time.monotonic()
            if chunks:
                yield "".join(chunks)
                last_sent = now
            elif now - last_sent >= settings.SSE_KEEPALIVE_SECONDS:
                yield ": keepalive\n\n"
                last_sent = now
            if await request.is_disconnected():
                return
            await anyio.sleep(settings.SSE_POLL_SECONDS)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
