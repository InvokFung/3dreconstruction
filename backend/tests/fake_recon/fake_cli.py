#!/usr/bin/env python3
"""Fake `recon.cli` implementing the pipeline CLI contract (docs/ARCHITECTURE.md section 1), for tests.

Usage (same as the real CLI):
    fake_cli.py --job-dir DIR --config DIR/config.json
    fake_cli.py --capabilities

Behaviour is selected with env vars:
    FAKE_RECON_MODE   success (default) | fail | crash | slow | stubborn | noresult | missing_artifacts
    FAKE_RECON_DELAY  seconds between progress steps (default 0.02)
    FAKE_RECON_GENERATIVE  "1" to report the generative engine as available
Standard library only.
"""

import argparse
import json
import os
import signal
import struct
import sys
import time
import zlib

STAGES = [
    ("ingest", 5),
    ("masking", 15),
    ("sfm", 35),
    ("depth", 50),
    ("fusion", 60),
    ("meshing", 70),
    ("cleanup", 78),
    ("texturing", 90),
    ("export", 97),
]


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def tiny_png() -> bytes:
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    raw = b"\x00\xff\x00\x00"  # one red pixel, filter byte 0
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-dir")
    ap.add_argument("--config")
    ap.add_argument("--capabilities", action="store_true")
    args = ap.parse_args()

    if args.capabilities:
        gen = os.environ.get("FAKE_RECON_GENERATIVE") == "1"
        emit(
            {
                "engines": {
                    "photogrammetry": {"available": True, "notes": "fake"},
                    "generative": {"available": gen, **({} if gen else {"reason": "No CUDA GPU"})},
                },
                "device": "cpu",
            }
        )
        return 0

    mode = os.environ.get("FAKE_RECON_MODE", "success")
    delay = float(os.environ.get("FAKE_RECON_DELAY", "0.02"))

    if mode == "stubborn":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    else:

        def on_term(_s, _f):
            print("got SIGTERM, exiting", file=sys.stderr, flush=True)
            sys.exit(143)

        signal.signal(signal.SIGTERM, on_term)

    job_dir = args.job_dir
    with open(args.config) as f:
        cfg = json.load(f)
    inputs = sorted(os.listdir(os.path.join(job_dir, "input")))
    print(f"INFO fake pipeline starting with {len(inputs)} inputs, engine={cfg.get('engine')}", file=sys.stderr, flush=True)
    emit({"type": "log", "level": "info", "message": f"Found {len(inputs)} input files"})

    if mode == "crash":
        print("Traceback (most recent call last):\nRuntimeError: boom", file=sys.stderr, flush=True)
        return 3

    if mode in ("slow", "stubborn"):
        for i in range(10_000):
            emit({"type": "progress", "stage": "sfm", "progress": min(40.0, 10 + i * 0.01), "message": f"step {i}"})
            time.sleep(0.05)
        return 0

    for stage, pct in STAGES:
        emit({"type": "progress", "stage": stage, "progress": float(pct), "message": f"Running {stage}"})
        time.sleep(delay)
        if mode == "fail" and stage == "sfm":
            emit(
                {
                    "type": "error",
                    "code": "too_few_registered",
                    "message": "Only 2 of 18 images could be aligned. Take more overlapping photos.",
                }
            )
            return 2

    if mode == "noresult":
        return 0

    out = os.path.join(job_dir, "output")
    os.makedirs(out, exist_ok=True)
    files = {
        "glb": ("model.glb", b"glTF" + b"\x02\x00\x00\x00" + b"\x00" * 4088),
        "obj_zip": ("model_obj.zip", b"PK\x05\x06" + b"\x00" * 18),
        "ply": ("model.ply", b"ply\nformat binary_little_endian 1.0\nend_header\n"),
        "usdz": ("model.usdz", b"PK\x05\x06" + b"\x00" * 18),
        "thumbnail": ("thumbnail.png", tiny_png()),
        "report": ("report.json", json.dumps({"ok": True}).encode()),
    }
    artifacts = []
    for kind, (name, data) in files.items():
        if mode == "missing_artifacts":
            artifacts.append({"kind": kind, "path": f"output/{name}"})
            continue
        with open(os.path.join(out, name), "wb") as f:
            f.write(data)
        artifacts.append({"kind": kind, "path": f"output/{name}"})
    artifacts.append({"kind": "evil", "path": "../../../etc/passwd"})  # must be ignored by the worker
    emit({"type": "progress", "stage": "export", "progress": 100.0, "message": "Done"})
    emit({"type": "result", "artifacts": artifacts, "metrics": {"registered_images": len(inputs), "faces": 98000}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
