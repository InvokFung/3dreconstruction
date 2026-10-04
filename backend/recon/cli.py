"""Pipeline entry point (contract: docs/ARCHITECTURE.md section 1).

    python -m recon.cli --job-dir <DIR> --config <DIR>/config.json
    python -m recon.cli --capabilities
    python -m recon.cli --download-models

stdout carries JSON Lines only; everything else goes to stderr.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
import traceback
from pathlib import Path


def _parse(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="python -m recon.cli", description="Photos/video -> textured 3D model")
    p.add_argument("--job-dir", type=Path, help="job directory with input/ (outputs go to output/)")
    p.add_argument("--config", type=Path, help="path to config.json (default: <job-dir>/config.json)")
    p.add_argument("--capabilities", action="store_true", help="print available engines as one JSON object and exit")
    p.add_argument("--download-models", action="store_true", help="pre-fetch all model weights into RECON_MODEL_DIR")
    p.add_argument("--no-large-models", action="store_true", help="with --download-models: skip the 'high' preset depth model")
    p.add_argument("-v", "--verbose", action="store_true", help="debug logging on stderr")
    return p.parse_args(argv)


def _setup_logging(verbose: bool) -> None:
    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)
    h = logging.StreamHandler(sys.stderr)
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", "%H:%M:%S"))
    root.addHandler(h)
    root.setLevel(logging.DEBUG if verbose else logging.WARNING)
    logging.getLogger("recon").setLevel(logging.DEBUG if verbose else logging.INFO)


def main(argv: list[str] | None = None) -> int:
    # Must happen before anything can write to fd 1 or spawn threads.
    from .runtime import configure_model_cache_env, guard_stdout, install_signal_watcher

    proto_fd = guard_stdout()
    install_signal_watcher()
    configure_model_cache_env()

    from .progress import Emitter, ProtocolLogHandler

    emitter = Emitter(proto_fd)
    try:
        args = _parse(argv)
    except SystemExit as e:  # argparse error/--help: output already went to stderr
        if e.code not in (0, None):
            emitter.error("unsupported_input", "Invalid command line arguments.")
        return int(e.code or 0)
    _setup_logging(args.verbose)

    if args.capabilities:
        from .capabilities import capabilities

        emitter.emit(capabilities())
        return 0

    if args.download_models:
        from .models import download_all

        status = download_all(include_large=not args.no_large_models)
        for line in status:
            print(line, file=sys.stderr)
        ok = not any(s.startswith("FAIL") for s in status)
        emitter.emit({"type": "download", "ok": ok, "status": status})
        return 0 if ok else 1

    if args.job_dir is None:
        emitter.error("unsupported_input", "--job-dir is required.")
        return 2

    log = logging.getLogger("recon")
    log.addHandler(ProtocolLogHandler(emitter, logging.INFO))
    return run_job(args.job_dir, args.config, emitter)


def run_job(job_dir: Path, config_path: Path | None, emitter) -> int:  # type: ignore[no-untyped-def]
    from .config import JobConfig
    from .errors import Cancelled, ReconError, is_oom
    from .progress import Progress
    from .runtime import CANCEL, configure_threads, resolve_device

    log = logging.getLogger("recon")
    t0 = time.monotonic()
    job_dir = job_dir.resolve()
    try:
        if not job_dir.is_dir():
            raise ReconError("unsupported_input", f"Job directory {job_dir} does not exist.")
        cfg = JobConfig.load(config_path if config_path is not None else job_dir / "config.json")
        (job_dir / "output").mkdir(parents=True, exist_ok=True)
        configure_threads()
        device = resolve_device(cfg.device)
        log.info("Engine %s, quality %s, mode %s, device %s", cfg.engine, cfg.quality, cfg.mode, device)
        _seed(cfg.seed)

        if cfg.engine == "photogrammetry":
            from .engines import photogrammetry as engine

            plan = engine.PLAN if cfg.mode == "object" else [s for s in engine.PLAN if s[0] != "masking"]
        else:
            from .engines import generative as engine  # type: ignore[no-redef]

            plan = engine.PLAN
        progress = Progress(emitter, plan)
        progress.cancel_check = CANCEL.check
        artifacts, metrics = engine.run(job_dir, cfg, progress, device)
        CANCEL.check()
        metrics["duration_s"] = round(time.monotonic() - t0, 1)
        progress.finish()
        emitter.result(artifacts, metrics)
        return 0
    except Cancelled:
        log.warning("Cancelled")
        return 143
    except ReconError as e:
        emitter.error(e.code, e.message)
        print(f"error [{e.code}]: {e.message}", file=sys.stderr)
        return 1
    except BaseException as e:  # noqa: BLE001 - last line of defence; report and exit non-zero
        if CANCEL.cancelled:
            return 143
        traceback.print_exc(file=sys.stderr)
        if is_oom(e):
            emitter.error(
                "out_of_memory",
                "The reconstruction ran out of memory. Try the 'draft' quality, fewer or smaller photos, or a smaller texture size.",
            )
        else:
            emitter.error("internal", f"Unexpected error during reconstruction ({type(e).__name__}: {str(e)[:300]}).")
        return 1


def _seed(seed: int) -> None:
    import random

    import numpy as np

    random.seed(seed)
    np.random.seed(seed % (2**32))
    try:
        import torch

        torch.manual_seed(seed)
    except Exception:
        pass
    os.environ.setdefault("PYTHONHASHSEED", str(seed))


if __name__ == "__main__":
    code = main()
    sys.stderr.flush()
    # Hard exit: native thread pools (OpenMP/TBB) can otherwise delay interpreter shutdown.
    os._exit(code)
