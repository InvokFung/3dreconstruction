"""CLI contract tests (docs/ARCHITECTURE.md section 1): stdout is JSON Lines only, error codes,
exit codes, capabilities, cancellation. The slow end-to-end runs use the bundled samples."""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2]
SAMPLES = BACKEND.parent / "samples"


def run_cli(args: list[str], timeout: float = 120, env: dict | None = None) -> subprocess.CompletedProcess:
    e = dict(os.environ)
    e["PYTHONPATH"] = str(BACKEND) + os.pathsep + e.get("PYTHONPATH", "")
    if env:
        e.update(env)
    return subprocess.run([sys.executable, "-m", "recon.cli", *args], cwd=BACKEND, env=e, capture_output=True, text=True, timeout=timeout)


def parse_lines(stdout: str) -> list[dict]:
    lines = [ln for ln in stdout.splitlines() if ln.strip()]
    out = []
    for ln in lines:
        obj = json.loads(ln)  # every stdout line must be JSON
        assert isinstance(obj, dict) and "type" in obj
        out.append(obj)
    return out


def test_capabilities():
    p = run_cli(["--capabilities"])
    assert p.returncode == 0
    lines = p.stdout.strip().splitlines()
    assert len(lines) == 1
    caps = json.loads(lines[0])
    assert set(caps["engines"]) == {"photogrammetry", "generative"}
    assert caps["engines"]["photogrammetry"]["available"] is True
    assert caps["device"] in ("cpu", "cuda")
    if caps["device"] == "cpu":
        assert caps["engines"]["generative"]["available"] is False
        assert caps["engines"]["generative"]["reason"]


@pytest.mark.parametrize(
    "files,config,code",
    [
        ([], {}, "unsupported_input"),
        (["notes.txt"], {}, "unsupported_input"),
        (["m1.png", "m2.png"], {}, "too_few_images"),
        (["m1.png", "m2.png", "m3.png"], {"quality": "ludicrous"}, "unsupported_input"),
        (["m1.png"], {"engine": "generative", "device": "cpu"}, "engine_unavailable"),
    ],
)
def test_error_contract(tmp_path, files, config, code):
    job = tmp_path / "job"
    (job / "input").mkdir(parents=True)
    for f in files:
        if f.endswith(".txt"):
            (job / "input" / f).write_text("hello")
        else:
            shutil.copy(SAMPLES / "box" / "images" / f, job / "input" / f)
    (job / "config.json").write_text(json.dumps(config))
    p = run_cli(["--job-dir", str(job), "--config", str(job / "config.json")])
    assert p.returncode != 0
    msgs = parse_lines(p.stdout)
    errs = [m for m in msgs if m["type"] == "error"]
    assert len(errs) == 1 and errs[0]["code"] == code and errs[0]["message"]
    assert not any(m["type"] == "result" for m in msgs)


def test_sigterm_cancels_promptly(tmp_path):
    job = tmp_path / "job"
    shutil.copytree(SAMPLES / "box" / "images", job / "input")
    (job / "config.json").write_text(json.dumps({"quality": "draft"}))
    e = dict(os.environ)
    e["PYTHONPATH"] = str(BACKEND)
    proc = subprocess.Popen([sys.executable, "-m", "recon.cli", "--job-dir", str(job)], cwd=BACKEND, env=e, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    # Wait until real work has started.
    deadline = time.time() + 120
    assert proc.stdout is not None
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        if json.loads(line).get("type") == "progress" and json.loads(line)["progress"] > 1:
            break
    t0 = time.time()
    proc.send_signal(signal.SIGTERM)
    proc.wait(timeout=30)
    assert time.time() - t0 < 10
    assert proc.returncode != 0
    assert not (job / "output" / "model.glb").exists()


def _run_sample(tmp_path: Path, sample: str, quality: str) -> tuple[Path, dict, list[dict]]:
    job = tmp_path / f"{sample}_{quality}"
    shutil.copytree(SAMPLES / sample / "images", job / "input")
    (job / "config.json").write_text(json.dumps({"quality": quality, "mode": "object"}))
    p = run_cli(["--job-dir", str(job), "--config", str(job / "config.json")], timeout=3600)
    msgs = parse_lines(p.stdout)
    assert p.returncode == 0, (p.stdout[-2000:], p.stderr[-4000:])
    prog = [m["progress"] for m in msgs if m["type"] == "progress"]
    assert prog == sorted(prog)
    stages = {m["stage"] for m in msgs if m["type"] == "progress"}
    assert stages <= {"ingest", "masking", "sfm", "depth", "fusion", "meshing", "cleanup", "texturing", "export", "generate"}
    result = [m for m in msgs if m["type"] == "result"]
    assert len(result) == 1 and msgs[-1]["type"] == "result"
    return job, result[0], msgs


@pytest.mark.slow
@pytest.mark.parametrize("sample", ["box", "switch"])
def test_end_to_end_draft(tmp_path, sample):
    job, result, _ = _run_sample(tmp_path, sample, "draft")
    kinds = {a["kind"]: a["path"] for a in result["artifacts"]}
    assert {"glb", "obj_zip", "ply", "preview", "thumbnail", "report"} <= set(kinds)
    for path in kinds.values():
        assert (job / path).is_file() and (job / path).stat().st_size > 0
        assert path.startswith("output/")
    assert (job / kinds["glb"]).read_bytes()[:4] == b"glTF"
    m = result["metrics"]
    assert m["registered_images"] >= 17
    assert 20_000 <= m["faces"] <= 50_000
    assert m["texture_size"] == 1024
    # A shoebox-sized object (tens of centimetres), not a room or a coin.
    assert 0.15 < max(m["bbox_size"]) < 1.5
    import trimesh

    tm = trimesh.load(job / kinds["glb"], force="mesh")
    assert tm.visual.kind == "texture"
    # Object sits on the ground plane: bottom at y = 0, centred in x/z.
    lo, hi = tm.bounds
    assert abs(lo[1]) < 1e-3 and abs(lo[0] + hi[0]) < 1e-3 and abs(lo[2] + hi[2]) < 1e-3
    # One clean, closed object once UV-seam duplicates are welded.
    tm.merge_vertices(merge_tex=True, merge_norm=True)
    assert tm.body_count == 1
    assert tm.is_watertight
    report = json.loads((job / kinds["report"]).read_text())
    assert set(report["timings_s"]) >= {"ingest", "sfm", "depth", "fusion", "texturing", "export"}
