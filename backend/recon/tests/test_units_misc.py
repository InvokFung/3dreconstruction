"""Unit tests for config, progress protocol, ingest helpers, pair selection and depth filters."""

import json
import os

import cv2
import numpy as np
import pytest
from PIL import Image

from recon.config import PRESETS, JobConfig
from recon.depth import consistency_filter, depth_edges, scale_intrinsics
from recon.errors import ReconError, is_oom
from recon.ingest import focal_from_exif, ingest, select_frames_by_sharpness, sharpness
from recon.progress import Emitter, Progress
from recon.sfm import choose_offset_window, offset_pairs, retrieval_pairs


# ---- config -----------------------------------------------------------------------------------


def test_config_defaults_match_contract():
    cfg = JobConfig.from_dict({})
    assert (cfg.engine, cfg.quality, cfg.mode, cfg.device) == ("photogrammetry", "standard", "object", "auto")
    assert cfg.texture_size == 2048 and cfg.target_faces == 100_000
    assert cfg.formats == ["glb", "obj", "ply", "usdz"]


def test_config_presets_and_overrides():
    d = JobConfig.from_dict({"quality": "draft", "unknown_key": 1})
    assert d.texture_size == PRESETS["draft"].texture_size
    h = JobConfig.from_dict({"quality": "high", "texture_size": 1024, "target_faces": 5000, "formats": ["glb", "obj_zip", "bogus"]})
    assert h.texture_size == 1024 and h.target_faces == 5000 and h.formats == ["glb", "obj"]
    assert JobConfig.from_dict({"texture_size": 3000}).texture_size == 2048  # snapped
    with pytest.raises(ReconError) as e:
        JobConfig.from_dict({"mode": "galaxy"})
    assert e.value.code == "unsupported_input"


def test_is_oom():
    assert is_oom(MemoryError())
    assert is_oom(RuntimeError("CUDA out of memory. Tried to allocate"))
    assert is_oom(RuntimeError("[enforce fail at alloc_cpu.cpp] DefaultCPUAllocator: can't allocate memory"))
    assert not is_oom(ValueError("bad"))


# ---- progress protocol ----------------------------------------------------------------------


def test_progress_is_monotonic_and_json(tmp_path):
    r, w = os.pipe()
    em = Emitter(w)
    p = Progress(em, [("ingest", 1), ("sfm", 3), ("export", 1)], min_interval=0)
    p.stage("ingest")
    p.update(0.5, "half")
    p.stage("sfm")
    p.update(0.9)
    p.update(0.2)  # going backwards must not decrease overall progress
    p.stage("ingest")  # re-entering an earlier stage must not decrease it either
    p.stage("export")
    p.finish()
    em.result([{"kind": "glb", "path": "output/model.glb"}], {"faces": np.int64(3)})
    os.close(w)
    lines = os.fdopen(r).read().splitlines()
    objs = [json.loads(line) for line in lines]
    values = [o["progress"] for o in objs if o["type"] == "progress"]
    assert values == sorted(values) and values[-1] == 100.0
    assert all(set(o) == {"type", "stage", "progress", "message"} for o in objs if o["type"] == "progress")
    assert objs[-1] == {"type": "result", "artifacts": [{"kind": "glb", "path": "output/model.glb"}], "metrics": {"faces": 3}}
    assert "sfm" in p.timings


# ---- ingest ---------------------------------------------------------------------------------


def _textured(seed: int, size=(240, 320)) -> np.ndarray:
    rng = np.random.default_rng(seed)
    img = (rng.random((size[0] // 8, size[1] // 8, 3)) * 255).astype(np.uint8)
    return cv2.resize(img, (size[1], size[0]), interpolation=cv2.INTER_NEAREST)


def test_sharpness_and_frame_selection():
    sharp = cv2.cvtColor(_textured(0), cv2.COLOR_RGB2GRAY)
    blurry = cv2.GaussianBlur(sharp, (0, 0), 4)
    assert sharpness(sharp) > 5 * sharpness(blurry)
    scores = [1, 5, 2, 9, 1, 1, 3, 8, 2, 2]
    assert select_frames_by_sharpness(scores, 2) == [3, 7]
    assert select_frames_by_sharpness(scores, 20) == list(range(10))


def test_focal_from_exif():
    assert focal_from_exif(26, 4032, 3024) == pytest.approx(26 / 36 * 4032)
    assert focal_from_exif(None, 100, 100) is None
    assert focal_from_exif(1, 4000, 3000) is None  # implausible


def test_ingest_exif_orientation_duplicates_and_blur(tmp_path):
    inp = tmp_path / "input"
    inp.mkdir()
    for i in range(6):
        Image.fromarray(_textured(i)).save(inp / f"img_{i:02d}.jpg", quality=95)
    # Exact duplicate and a very blurry shot.
    Image.fromarray(_textured(0)).save(inp / "img_00_dup.png")
    Image.fromarray(cv2.GaussianBlur(_textured(7), (0, 0), 8)).save(inp / "img_07.jpg")
    # A portrait photo stored landscape with EXIF orientation 6 (rotate 90 CW).
    exif = Image.Exif()
    exif[0x0112] = 6
    Image.fromarray(_textured(8)).save(inp / "img_08.jpg", exif=exif.tobytes())
    (inp / "notes.txt").write_text("ignored")
    res = ingest(inp, tmp_path / "work", PRESETS["draft"], min_images=3)
    sizes = {(f.width, f.height) for f in res.frames}
    assert (240, 320) in sizes  # rotated portrait frame
    assert res.dropped_duplicates == 1
    assert res.dropped_blurry == 1
    assert len(res.frames) == 7
    assert all(f.path.exists() for f in res.frames)


def test_ingest_heic(tmp_path):
    pillow_heif = pytest.importorskip("pillow_heif")
    inp = tmp_path / "input"
    inp.mkdir()
    for i in range(3):
        heif = pillow_heif.from_pillow(Image.fromarray(_textured(i)))
        heif.save(str(inp / f"p{i}.heic"), quality=90)
    res = ingest(inp, tmp_path / "work", PRESETS["draft"], min_images=3)
    assert len(res.frames) == 3


def test_ingest_video(tmp_path):
    inp = tmp_path / "input"
    inp.mkdir()
    w = cv2.VideoWriter(str(inp / "clip.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), 10, (320, 240))
    base = _textured(1)
    for k in range(80):
        shifted = np.roll(base, k * 2, axis=1)
        w.write(cv2.cvtColor(shifted, cv2.COLOR_RGB2BGR))
    w.release()
    res = ingest(inp, tmp_path / "work", PRESETS["draft"], min_images=3)
    assert res.ordered == "video"
    assert 10 <= len(res.frames) <= 60
    assert all(f.from_video for f in res.frames)


def test_ingest_errors(tmp_path):
    inp = tmp_path / "input"
    inp.mkdir()
    with pytest.raises(ReconError) as e:
        ingest(inp, tmp_path / "w", PRESETS["draft"])
    assert e.value.code == "unsupported_input"
    Image.fromarray(_textured(0)).save(inp / "a.png")
    Image.fromarray(_textured(1)).save(inp / "b.png")
    with pytest.raises(ReconError) as e:
        ingest(inp, tmp_path / "w", PRESETS["draft"])
    assert e.value.code == "too_few_images"


# ---- SfM pair selection ---------------------------------------------------------------------


def test_offset_pairs_cyclic():
    assert offset_pairs(5, 1, cyclic=False) == [(0, 1), (1, 2), (2, 3), (3, 4)]
    assert (0, 4) in offset_pairs(5, 1, cyclic=True)
    assert len(offset_pairs(6, 3, cyclic=True)) == 3  # opposite pairs, deduplicated


def test_choose_offset_window_stops_before_doppelgangers():
    # Real statistics from the bundled 'switch' sample: matches fall off, then rise again for
    # views of the box's two identical ends (offset 8-9).
    med = [710, 485, 349, 179, 85, 95, 99, 158, 193]
    assert choose_offset_window(med) == 3
    assert choose_offset_window([10, 5]) == 0  # nothing matches well
    assert choose_offset_window([500, 480, 470, 460]) == 4


def test_retrieval_pairs():
    d = np.eye(4)[[0, 0, 1, 1]] + 0.01 * np.arange(4)[:, None]
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    assert set(retrieval_pairs(d, 1)) == {(0, 1), (2, 3)}


# ---- depth filters --------------------------------------------------------------------------


def test_depth_edges_marks_discontinuities():
    d = np.full((20, 20), 2.0, np.float32)
    d[:, 10:] = 4.0
    e = depth_edges(d, rel=0.05)
    assert e[:, 9:11].all() and not e[:, :8].any() and not e[:, 12:].any()


def test_scale_intrinsics_pixel_centres():
    K = np.array([[500.0, 0, 319.5], [0, 500, 239.5], [0, 0, 1]])
    K2 = scale_intrinsics(K, 0.5, 0.5)
    assert K2[0, 2] == pytest.approx(159.5) and K2[0, 0] == 250


def test_consistency_filter_rejects_inconsistent_view():
    from recon.data import View
    from recon.geometry import rotation_about_y

    K = np.array([[80.0, 0, 31.5], [0, 80, 23.5], [0, 0, 1]])
    views, depths = [], []
    for yaw in (-0.15, 0.0, 0.15):
        R = rotation_about_y(yaw)
        C = -R.T @ np.array([0, 0, 3.0])  # camera 3 units in front of the plane z=0, looking at origin
        t = -R @ C
        views.append(View(name=str(yaw), image=np.zeros((48, 64, 3), np.uint8), K=K, R=R, t=t))
        # Ray-cast the plane z = 0.
        ys, xs = np.mgrid[0:48, 0:64]
        dirs = np.stack([(xs - K[0, 2]) / K[0, 0], (ys - K[1, 2]) / K[1, 1], np.ones_like(xs, float)], -1) @ R
        lam = -C[2] / dirs[..., 2]
        depths.append(lam.astype(np.float32))  # z-depth since dirs have unit camera-z
    bad = depths[1] * 1.2  # middle view is 20% off
    out, kept = consistency_filter([depths[0], bad, depths[2]], [K] * 3, views, [[1, 2], [0, 2], [0, 1]], rel_tol=0.02, min_consistent=1)
    assert kept[0] > 0.5 and kept[2] > 0.5
    assert kept[1] < 0.2
