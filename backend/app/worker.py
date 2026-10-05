"""DB-backed job worker.  Run:  python -m app.worker  [--once] [--concurrency N]

* Claims queued jobs atomically:
    - Postgres: SELECT ... FOR UPDATE SKIP LOCKED, then UPDATE, in one transaction.
    - SQLite:   conditional UPDATE ... WHERE id=:candidate AND status='queued' (rowcount decides the winner).
* Runs `recon.cli` in a subprocess (own process group), parses its JSON-lines stdout into
  stage/progress/message (DB writes throttled), appends stderr and `log` events to jobs/<id>/log.txt,
  registers artifacts on `result`, maps `error` to job.error.
* Enforces JOB_TIMEOUT_SECONDS; honours cancel_requested (SIGTERM, then SIGKILL after
  CANCEL_GRACE_SECONDS); writes a heartbeat so stale `running` jobs can be recovered.
* On SIGTERM/SIGINT the worker stops claiming, stops its running pipelines and re-queues them.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import queue
import re
import shutil
import signal
import socket
import subprocess
import threading
import time
from datetime import UTC, timedelta
from pathlib import Path

from sqlalchemy import and_, or_, select, update

from .config import Settings, get_settings
from .db import init_engine, run_migrations, session
from .logging_config import setup_logging
from .models import Artifact, Job, Project, new_id, utcnow
from .recon_runner import probe_capabilities, recon_command, recon_cwd, recon_env, write_capabilities_file
from .storage import Storage, format_log_lines, slugify

log = logging.getLogger("app.worker")

_STDERR_LEVEL_RE = re.compile(r"\b(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\b")
CAPABILITIES_REFRESH_SECONDS = 600


def _aware(dt):
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


class _JobLog:
    """Thread-safe appender for jobs/<id>/log.txt (handle kept open so a deleted job dir isn't recreated)."""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._f = open(path, "a", encoding="utf-8")
        self._lock = threading.Lock()

    def write(self, level: str, message: str) -> None:
        with self._lock:
            try:
                self._f.write(format_log_lines(level, message))
                self._f.flush()
            except (OSError, ValueError):
                pass

    def close(self) -> None:
        with self._lock:
            try:
                self._f.close()
            except OSError:
                pass


def _stderr_level(line: str) -> str:
    m = _STDERR_LEVEL_RE.search(line[:60])
    if not m:
        return "info"
    return {"WARN": "warning", "CRITICAL": "error", "FATAL": "error"}.get(m.group(1), m.group(1).lower())


_IS_WINDOWS = os.name == "nt"
# SIGKILL does not exist on Windows; there "kill" means TerminateProcess.
_SIGKILL = getattr(signal, "SIGKILL", signal.SIGTERM)


def _signal_group(proc: subprocess.Popen, sig: int) -> None:
    if _IS_WINDOWS:
        # No process groups/POSIX signals: terminate the whole child tree.
        if sig == _SIGKILL or sig == signal.SIGTERM:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"] if sig == _SIGKILL else ["taskkill", "/PID", str(proc.pid), "/T"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        try:
            if sig == _SIGKILL:
                proc.kill()
        except OSError:
            pass
        return
    try:
        os.killpg(proc.pid, sig)
    except (ProcessLookupError, PermissionError):
        try:
            proc.send_signal(sig)
        except (ProcessLookupError, OSError):
            pass


class JobRunner:
    def __init__(self, worker: Worker, job_id: str):
        self.worker = worker
        self.s = worker.settings
        self.job_id = job_id
        self.st = Storage(self.s)
        self.jdir = self.st.job_dir(job_id)

    # -------------------------------------------------------------- db helpers

    def _update(self, **values) -> bool:
        """Update our job only if we still own it (status running, our worker id)."""
        with session() as db:
            res = db.execute(
                update(Job)
                .where(Job.id == self.job_id, Job.status == "running", Job.worker_id == self.worker.worker_id)
                .values(**values)
            )
            db.commit()
            return bool(res.rowcount)

    def _final(self, base: dict, **values) -> bool:
        return self._update(**{**base, **values})

    def _cancel_state(self) -> str | None:
        with session() as db:
            row = db.execute(select(Job.status, Job.cancel_requested, Job.worker_id).where(Job.id == self.job_id)).first()
        if row is None:
            return "deleted"
        status, cancel, wid = row
        if status != "running" or wid != self.worker.worker_id:
            return "lost"  # recovered by someone else / externally changed
        return "cancel" if cancel else None

    # -------------------------------------------------------------- main

    def run(self) -> None:
        jlog = _JobLog(self.st.job_log(self.job_id))
        try:
            self._run(jlog)
        except Exception as e:  # never let a bug leave the job stuck in "running"
            log.exception("job runner crashed", extra={"job_id": self.job_id})
            jlog.write("error", f"Internal worker error: {e}")
            self._update(
                status="failed",
                error="Internal error while running the job",
                error_code="worker_error",
                finished_at=utcnow(),
                heartbeat_at=utcnow(),
            )
        finally:
            jlog.close()

    def _run(self, jlog: _JobLog) -> None:
        with session() as db:
            job = db.get(Job, self.job_id)
            if job is None or job.status != "running":
                return
            project = db.get(Project, job.project_id)
            slug = slugify(project.name if project else "model")
            attempt = job.attempts

        cfg = self.jdir / "config.json"
        (self.jdir / "output").mkdir(parents=True, exist_ok=True)
        cmd = recon_command(self.s) + ["--job-dir", str(self.jdir), "--config", str(cfg)]
        jlog.write("info", f"Worker {self.worker.worker_id} started the job (attempt {attempt})")
        log.info("job started", extra={"job_id": self.job_id, "attempt": attempt})
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                cwd=recon_cwd(self.s),
                env=recon_env(self.s),
                # Own process group so we can signal the whole tree (Windows: own console group).
                start_new_session=not _IS_WINDOWS,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if _IS_WINDOWS else 0,
            )
        except OSError as e:
            jlog.write("error", f"Could not start the reconstruction pipeline: {e}")
            self._update(
                status="failed",
                error="Could not start the reconstruction pipeline",
                error_code="spawn_failed",
                finished_at=utcnow(),
                heartbeat_at=utcnow(),
            )
            return

        events: queue.Queue = queue.Queue()

        def read_stdout():
            assert proc.stdout is not None
            for raw in proc.stdout:
                events.put(raw.decode("utf-8", "replace").rstrip("\r\n"))
            events.put(None)

        def read_stderr():
            assert proc.stderr is not None
            for raw in proc.stderr:
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if line.strip():
                    jlog.write(_stderr_level(line), line)

        t_out = threading.Thread(target=read_stdout, daemon=True)
        t_err = threading.Thread(target=read_stderr, daemon=True)
        t_out.start()
        t_err.start()

        stage: str | None = None
        progress = 0.0
        message: str | None = None
        result: dict | None = None
        error_ev: dict | None = None
        dirty = False
        stage_changed = False

        start = time.monotonic()
        deadline = start + self.s.JOB_TIMEOUT_SECONDS
        last_write = 0.0
        last_cancel_check = start
        reason: str | None = None
        kill_at: float | None = None
        exited_at: float | None = None
        stdout_done = False

        def handle(line: str) -> None:
            nonlocal stage, progress, message, result, error_ev, dirty, stage_changed
            if not line.strip():
                return
            try:
                ev = json.loads(line)
                if not isinstance(ev, dict):
                    raise ValueError
            except ValueError:
                jlog.write("info", line)  # stray non-JSON stdout; keep it visible
                return
            typ = ev.get("type")
            if typ == "progress":
                new_stage = ev.get("stage")
                if isinstance(new_stage, str) and new_stage and new_stage != stage:
                    stage = new_stage[:50]
                    stage_changed = True
                    jlog.write("info", f"Stage: {stage}" + (f" - {ev['message']}" if ev.get("message") else ""))
                try:
                    p = float(ev.get("progress", progress))
                    progress = max(progress, min(100.0, max(0.0, p)))  # monotonic
                except (TypeError, ValueError):
                    pass
                if ev.get("message") is not None:
                    message = str(ev["message"])[:2000]
                dirty = True
            elif typ == "log":
                jlog.write(str(ev.get("level") or "info"), str(ev.get("message", "")))
            elif typ == "result":
                result = ev
            elif typ == "error":
                error_ev = ev
                jlog.write("error", f"{ev.get('code') or 'error'}: {ev.get('message') or ''}")
            else:
                jlog.write("debug", line)

        while True:
            try:
                item = events.get(timeout=0.2)
                while True:
                    if item is None:
                        stdout_done = True
                    else:
                        handle(item)
                    item = events.get_nowait()
            except queue.Empty:
                pass

            now = time.monotonic()
            if proc.poll() is not None and exited_at is None:
                exited_at = now
            if reason is None and exited_at is None:
                if now >= deadline:
                    reason = "timeout"
                elif self.worker.stop_event.is_set():
                    reason = "shutdown"
                elif now - last_cancel_check >= 1.0:
                    last_cancel_check = now
                    reason = self._cancel_state()
                if reason is not None:
                    jlog.write(
                        "warning",
                        {
                            "timeout": f"Time limit of {self.s.JOB_TIMEOUT_SECONDS}s exceeded; stopping the pipeline",
                            "shutdown": "Worker is shutting down; stopping the pipeline",
                            "cancel": "Stopping the pipeline (cancel requested)",
                            "deleted": "Job was deleted; stopping the pipeline",
                            "lost": "Job is no longer owned by this worker; stopping the pipeline",
                        }[reason],
                    )
                    _signal_group(proc, signal.SIGTERM)
                    kill_at = now + self.s.CANCEL_GRACE_SECONDS
            if kill_at is not None and now >= kill_at and proc.poll() is None:
                jlog.write("warning", "Pipeline did not exit after SIGTERM; killing it")
                _signal_group(proc, _SIGKILL)
                kill_at = None

            heartbeat_due = now - last_write >= self.s.HEARTBEAT_SECONDS
            if reason is None and (stage_changed or heartbeat_due or (dirty and now - last_write >= self.s.PROGRESS_WRITE_INTERVAL)):
                vals = {"heartbeat_at": utcnow()}
                if dirty:
                    vals.update(stage=stage, progress=progress, message=message)
                if not self._update(**vals):
                    reason = reason or self._cancel_state() or "lost"
                    _signal_group(proc, signal.SIGTERM)
                    kill_at = now + self.s.CANCEL_GRACE_SECONDS
                dirty = stage_changed = False
                last_write = now

            if exited_at is not None and (stdout_done or now - exited_at > 5.0):
                break

        # Make sure nothing in the process group survives (e.g. orphaned helpers).
        _signal_group(proc, _SIGKILL)
        t_out.join(timeout=2)
        t_err.join(timeout=2)
        while True:  # drain anything left
            try:
                item = events.get_nowait()
            except queue.Empty:
                break
            if item is not None:
                handle(item)
        rc = proc.returncode
        self._finish(jlog, rc, reason, stage, progress, message, result, error_ev, slug)

    # -------------------------------------------------------------- finalisation

    def _finish(self, jlog, rc, reason, stage, progress, message, result, error_ev, slug) -> None:
        now = utcnow()
        base = {"stage": stage, "progress": progress, "message": message, "heartbeat_at": now}
        if reason in ("deleted", "lost"):
            log.info("job abandoned", extra={"job_id": self.job_id, "reason": reason})
            return
        if reason == "shutdown":
            jlog.write("warning", "Job re-queued because the worker shut down")
            self._reset_output()
            with session() as db:
                db.execute(
                    update(Job)
                    .where(Job.id == self.job_id, Job.status == "running", Job.worker_id == self.worker.worker_id)
                    .values(
                        status="queued",
                        stage=None,
                        progress=0.0,
                        message="Re-queued",
                        worker_id=None,
                        started_at=None,
                        heartbeat_at=None,
                        attempts=Job.attempts - 1,
                    )
                )
                db.commit()
            return
        if reason == "timeout":
            msg = f"Reconstruction took longer than the {self.s.JOB_TIMEOUT_SECONDS} second limit and was stopped"
            jlog.write("error", msg)
            self._final(base, status="failed", error=msg, error_code="timeout", finished_at=now)
            return
        succeeded = rc == 0 and result is not None
        if reason == "cancel" and not succeeded:
            jlog.write("warning", "Job canceled")
            self._final(base, status="canceled", message="Canceled", finished_at=now)
            return
        if succeeded:
            self._succeed(jlog, base, result, slug)
            return
        if error_ev is not None:
            msg = str(error_ev.get("message") or "Reconstruction failed")
            code = str(error_ev.get("code") or "pipeline_error")[:100]
        elif rc == 0:
            msg, code = "The pipeline finished without producing a result", "no_result"
        elif rc is not None and rc < 0:
            msg, code = f"The reconstruction pipeline was killed by signal {-rc}. See the log for details.", "pipeline_crashed"
        else:
            msg, code = f"The reconstruction pipeline crashed (exit code {rc}). See the log for details.", "pipeline_crashed"
        jlog.write("error", f"Job failed: {msg}")
        self._final(base, status="failed", error=msg, error_code=code, finished_at=now)

    def _succeed(self, jlog, base, result, slug) -> None:
        jroot = self.jdir.resolve()
        arts: list[Artifact] = []
        used_names: set[str] = set()
        for a in result.get("artifacts") or []:
            if not isinstance(a, dict):
                continue
            kind, rel = str(a.get("kind") or ""), a.get("path")
            if not kind or not isinstance(rel, str):
                continue
            path = (jroot / rel).resolve()
            if not path.is_relative_to(jroot) or not path.is_file():
                jlog.write("warning", f"Artifact {kind} not found at {rel}; skipping")
                continue
            fname = f"{slug}-{path.name}"
            n = 2
            while fname in used_names:
                fname = f"{slug}-{n}-{path.name}"
                n += 1
            used_names.add(fname)
            arts.append(
                Artifact(
                    id=new_id(),
                    job_id=self.job_id,
                    kind=kind[:30],
                    filename=fname[:255],
                    rel_path=str(path.relative_to(jroot)),
                    size_bytes=path.stat().st_size,
                    created_at=utcnow(),
                )
            )
        now = utcnow()
        if not arts:
            msg = "The pipeline reported success but produced no output files"
            jlog.write("error", msg)
            self._final(base, status="failed", error=msg, error_code="no_output", finished_at=now)
            return
        metrics = result.get("metrics") if isinstance(result.get("metrics"), dict) else None
        jlog.write("info", f"Job succeeded with {len(arts)} artifact(s): " + ", ".join(a.kind for a in arts))
        with session() as db:
            res = db.execute(
                update(Job)
                .where(Job.id == self.job_id, Job.status == "running", Job.worker_id == self.worker.worker_id)
                .values(
                    **{
                        **base,
                        "progress": 100.0,
                        "status": "succeeded",
                        "message": "Completed",
                        "metrics": metrics,
                        "finished_at": now,
                    }
                )
            )
            if res.rowcount:
                db.add_all(arts)
            db.commit()
        log.info("job succeeded", extra={"job_id": self.job_id, "artifacts": len(arts)})

    def _reset_output(self) -> None:
        out = self.jdir / "output"
        shutil.rmtree(out, ignore_errors=True)
        out.mkdir(parents=True, exist_ok=True)


class Worker:
    def __init__(
        self,
        settings: Settings | None = None,
        worker_id: str | None = None,
        concurrency: int | None = None,
        write_capabilities: bool = True,
    ):
        self.settings = settings or get_settings()
        self.hostname = socket.gethostname()
        self.worker_id = worker_id or f"{self.hostname}:{os.getpid()}:{new_id()[:8]}"
        self.concurrency = concurrency or self.settings.WORKER_CONCURRENCY
        self.write_capabilities = write_capabilities
        self.stop_event = threading.Event()
        self._threads: dict[str, threading.Thread] = {}

    # -------------------------------------------------------------- claiming

    def claim(self) -> str | None:
        now = utcnow()
        values = dict(
            status="running",
            worker_id=self.worker_id,
            started_at=now,
            heartbeat_at=now,
            attempts=Job.attempts + 1,
            stage=None,
            progress=0.0,
            message="Starting",
            error=None,
            error_code=None,
        )
        with session() as db:
            if db.get_bind().dialect.name == "postgresql":
                jid = db.scalars(
                    select(Job.id).where(Job.status == "queued").order_by(Job.created_at).limit(1).with_for_update(skip_locked=True)
                ).first()
                if jid is None:
                    db.rollback()
                    return None
                db.execute(update(Job).where(Job.id == jid).values(**values))
                db.commit()
                return jid
            for _ in range(10):
                jid = db.scalars(select(Job.id).where(Job.status == "queued").order_by(Job.created_at).limit(1)).first()
                if jid is None:
                    db.rollback()
                    return None
                res = db.execute(update(Job).where(Job.id == jid, Job.status == "queued").values(**values))
                db.commit()
                if res.rowcount == 1:
                    return jid
            return None

    # -------------------------------------------------------------- recovery

    def recover_stale(self, startup: bool = False) -> int:
        """Re-queue (or fail, after MAX_JOB_ATTEMPTS) `running` jobs whose worker stopped heart-beating.
        On startup, jobs held by a previous worker process on this same host are recovered immediately."""
        s = self.settings
        now = utcnow()
        cutoff = now - timedelta(seconds=s.STALE_JOB_SECONDS)
        conds = [Job.heartbeat_at.is_(None), Job.heartbeat_at < cutoff]
        if startup:
            conds.append(and_(Job.worker_id.like(f"{self.hostname}:%"), Job.worker_id != self.worker_id))
        st = Storage(s)
        n = 0
        with session() as db:
            stale = db.scalars(select(Job).where(Job.status == "running", or_(*conds))).all()
            for job in stale:
                if job.worker_id == self.worker_id:
                    continue
                hb_fresh = job.heartbeat_at is not None and _aware(job.heartbeat_at) >= cutoff
                if hb_fresh and not self._same_host_owner_dead(job.worker_id):
                    continue  # matched only by the same-host rule, but that worker process is still alive
                if job.cancel_requested:
                    vals = dict(status="canceled", message="Canceled", finished_at=now)
                    note = "Worker stopped while canceling; job marked canceled"
                elif job.attempts >= s.MAX_JOB_ATTEMPTS:
                    vals = dict(
                        status="failed",
                        finished_at=now,
                        error_code="worker_lost",
                        error="The worker processing this job stopped unexpectedly",
                    )
                    note = "Worker stopped unexpectedly; giving up after repeated attempts"
                else:
                    vals = dict(
                        status="queued",
                        stage=None,
                        progress=0.0,
                        message="Re-queued",
                        started_at=None,
                        worker_id=None,
                        heartbeat_at=None,
                    )
                    note = "Worker stopped unexpectedly; job re-queued"
                res = db.execute(
                    update(Job).where(Job.id == job.id, Job.status == "running", Job.worker_id == job.worker_id).values(**vals)
                )
                db.commit()
                if res.rowcount:
                    n += 1
                    if vals["status"] == "queued":
                        shutil.rmtree(st.job_dir(job.id) / "output", ignore_errors=True)
                    try:
                        with open(st.job_log(job.id), "a", encoding="utf-8") as f:
                            f.write(format_log_lines("warning", note))
                    except OSError:
                        pass
                    log.warning("recovered stale job", extra={"job_id": job.id, "new_status": vals["status"]})
        return n

    def _same_host_owner_dead(self, worker_id: str | None) -> bool:
        """For worker ids "<host>:<pid>:<rand>" on this host: is that process gone?"""
        try:
            host, pid_s, _ = (worker_id or "").split(":", 2)
            pid = int(pid_s)
        except ValueError:
            return False
        if host != self.hostname:
            return False
        if pid == os.getpid():
            return True  # a previous incarnation with our pid (e.g. PID 1 in a restarted container)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        return False

    # -------------------------------------------------------------- loop

    def run_job(self, job_id: str) -> None:
        JobRunner(self, job_id).run()

    def run_once(self) -> str | None:
        """Claim one job and run it to completion in this thread (used by --once and tests)."""
        jid = self.claim()
        if jid:
            self.run_job(jid)
        return jid

    def _refresh_capabilities(self) -> None:
        while not self.stop_event.is_set():
            try:
                data = probe_capabilities(self.settings)
                if "error" not in data:
                    write_capabilities_file(self.settings, data)
                else:
                    log.warning("capabilities probe failed", extra={"reason": data.get("error")})
            except Exception:
                log.exception("capabilities refresh failed")
            self.stop_event.wait(CAPABILITIES_REFRESH_SECONDS)

    def run_forever(self) -> None:
        s = self.settings
        log.info("worker started", extra={"worker_id": self.worker_id, "concurrency": self.concurrency})
        self.recover_stale(startup=True)
        if self.write_capabilities:
            threading.Thread(target=self._refresh_capabilities, daemon=True, name="capabilities").start()
        last_recover = time.monotonic()
        backoff = s.WORKER_POLL_SECONDS
        while not self.stop_event.is_set():
            for jid, t in list(self._threads.items()):
                if not t.is_alive():
                    del self._threads[jid]
            claimed = False
            try:
                if len(self._threads) < self.concurrency:
                    jid = self.claim()
                    if jid:
                        claimed = True
                        t = threading.Thread(target=self.run_job, args=(jid,), name=f"job-{jid[:8]}", daemon=True)
                        self._threads[jid] = t
                        t.start()
                if time.monotonic() - last_recover > 30:
                    self.recover_stale()
                    last_recover = time.monotonic()
                backoff = s.WORKER_POLL_SECONDS
            except Exception:
                log.exception("worker loop error (database unavailable?)")
                backoff = min(30.0, backoff * 2)
            if not claimed:
                self.stop_event.wait(backoff)
        log.info("worker stopping", extra={"active_jobs": len(self._threads)})
        for t in list(self._threads.values()):
            t.join(timeout=s.CANCEL_GRACE_SECONDS + 15)
        log.info("worker stopped")

    def stop(self) -> None:
        self.stop_event.set()


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m app.worker", description="Reconstruction job worker")
    ap.add_argument("--once", action="store_true", help="process at most one queued job, then exit")
    ap.add_argument("--concurrency", type=int, default=None, help="override WORKER_CONCURRENCY")
    args = ap.parse_args(argv)

    settings = get_settings()
    settings.validate_for_runtime()
    setup_logging(settings.LOG_LEVEL, settings.LOG_FORMAT)
    init_engine(settings)
    Storage(settings).ensure()
    if settings.AUTO_MIGRATE:
        run_migrations(settings)
    worker = Worker(settings, concurrency=args.concurrency)

    if args.once:
        worker.recover_stale(startup=True)
        jid = worker.run_once()
        log.info("done", extra={"job_id": jid})
        return

    def _on_signal(signum, _frame):
        log.info("signal received", extra={"signal": signum})
        worker.stop()

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    worker.run_forever()


if __name__ == "__main__":
    main()
