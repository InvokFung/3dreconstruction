"""Process-level runtime setup: stdout guarding, cancellation, devices and model cache paths."""

from __future__ import annotations

import logging
import os
import signal
import sys
import threading
from pathlib import Path
from typing import Callable

from .errors import Cancelled

log = logging.getLogger("recon")


# ---------------------------------------------------------------------------------------------
# Model cache
# ---------------------------------------------------------------------------------------------


def model_dir() -> Path:
    """Root of all downloaded weights (``RECON_MODEL_DIR``, default ``~/.cache/recon``)."""
    root = Path(os.environ.get("RECON_MODEL_DIR") or Path.home() / ".cache" / "recon").expanduser()
    root.mkdir(parents=True, exist_ok=True)
    return root


def configure_model_cache_env() -> Path:
    """Point Hugging Face / torch hub caches into ``RECON_MODEL_DIR``.

    Must run before importing ``transformers``/``huggingface_hub``/``torch.hub`` users. Values
    already present in the environment are respected.
    """
    root = model_dir()
    os.environ.setdefault("HF_HOME", str(root / "hf"))
    os.environ.setdefault("TORCH_HOME", str(root / "torch"))
    os.environ.setdefault("U2NET_HOME", str(root / "rembg"))
    # Quieter third-party output; all of it goes to stderr anyway.
    os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("PYTHONWARNINGS", "ignore")
    os.environ.setdefault("GLOG_minloglevel", "1")  # COLMAP INFO spam
    os.environ.setdefault("KMP_WARNINGS", "0")
    return root


# ---------------------------------------------------------------------------------------------
# stdout protection
# ---------------------------------------------------------------------------------------------


def guard_stdout() -> int:
    """Duplicate fd 1 for the protocol and redirect fd 1 (and ``sys.stdout``) to stderr.

    Returns the private protocol file descriptor.
    """
    try:
        sys.stdout.flush()
    except Exception:  # pragma: no cover
        pass
    proto_fd = os.dup(1)
    os.set_inheritable(proto_fd, False)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return proto_fd


# ---------------------------------------------------------------------------------------------
# Cancellation
# ---------------------------------------------------------------------------------------------


class CancelToken:
    """Cooperative cancellation shared by all stages.

    SIGTERM/SIGINT are blocked in every thread and consumed by a dedicated watcher thread via
    ``sigwait``. This works even while the main thread is stuck inside native code (COLMAP,
    torch, Open3D), where a regular Python signal handler would never run. The watcher sets the
    flag, forwards to registered native cancellation hooks (pycolmap ``CancellationToken``), and
    if the main thread does not exit within ``grace`` seconds it hard-exits the process.
    """

    def __init__(self) -> None:
        self._event = threading.Event()
        self._hooks: list[Callable[[], None]] = []
        self._on_cancel: list[Callable[[], None]] = []
        self.grace = 5.0

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def check(self) -> None:
        if self._event.is_set():
            raise Cancelled()

    def add_native_hook(self, fn: Callable[[], None]) -> Callable[[], None]:
        self._hooks.append(fn)
        if self.cancelled:
            fn()
        return lambda: self._hooks.remove(fn) if fn in self._hooks else None

    def on_cancel(self, fn: Callable[[], None]) -> None:
        self._on_cancel.append(fn)

    def cancel(self) -> None:
        if self._event.is_set():
            return
        self._event.set()
        for fn in list(self._hooks):
            try:
                fn()
            except Exception:  # pragma: no cover
                pass
        for fn in list(self._on_cancel):
            try:
                fn()
            except Exception:  # pragma: no cover
                pass


CANCEL = CancelToken()


def install_signal_watcher(token: CancelToken = CANCEL, exit_code: int = 143) -> None:
    """Block SIGTERM/SIGINT process-wide and handle them on a watcher thread.

    Must be called from the main thread *before* any library spawns threads, so all native
    worker threads inherit the blocked mask.
    """
    sigs = {signal.SIGTERM, signal.SIGINT}
    if not hasattr(signal, "pthread_sigmask"):  # pragma: no cover - non-POSIX
        for s in sigs:
            signal.signal(s, lambda *_: token.cancel())
        return
    signal.pthread_sigmask(signal.SIG_BLOCK, sigs)

    def watcher() -> None:
        while True:
            try:
                sig = signal.sigwait(sigs)
            except Exception:  # pragma: no cover
                return
            log.warning("Received %s, cancelling", signal.Signals(sig).name)
            token.cancel()
            # Give the main thread a moment to unwind cleanly, then force exit.
            timer = threading.Timer(token.grace, lambda: os._exit(exit_code))
            timer.daemon = True
            timer.start()

    t = threading.Thread(target=watcher, name="recon-signal-watcher", daemon=True)
    t.start()


# ---------------------------------------------------------------------------------------------
# Devices / threads
# ---------------------------------------------------------------------------------------------


def cuda_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def resolve_device(requested: str) -> str:
    if requested == "cpu":
        return "cpu"
    if requested == "cuda":
        if not cuda_available():
            log.warning("CUDA was requested but is not available; falling back to CPU")
            return "cpu"
        return "cuda"
    return "cuda" if cuda_available() else "cpu"


def cpu_count() -> int:
    try:
        return max(1, len(os.sched_getaffinity(0)))
    except Exception:  # pragma: no cover
        return max(1, os.cpu_count() or 1)


def configure_threads() -> None:
    n = cpu_count()
    try:
        import torch

        torch.set_num_threads(n)
    except Exception:  # pragma: no cover
        pass
    try:
        import cv2

        cv2.setNumThreads(n)
    except Exception:  # pragma: no cover
        pass


def available_memory_bytes() -> int:
    """Memory available to this process (cgroup limit aware)."""
    avail = None
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    avail = int(line.split()[1]) * 1024
                    break
    except OSError:
        pass
    for p in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            raw = Path(p).read_text().strip()
            if raw and raw != "max":
                lim = int(raw)
                usage_p = Path(p).with_name("memory.current" if p.endswith("memory.max") else "memory.usage_in_bytes")
                used = int(usage_p.read_text().strip()) if usage_p.exists() else 0
                cg = max(lim - used, 0)
                avail = cg if avail is None else min(avail, cg)
        except (OSError, ValueError):
            continue
    return int(avail if avail is not None else 8 * 1024**3)
