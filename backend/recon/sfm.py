"""Structure-from-Motion with pycolmap (COLMAP 4.x).

Features/matching:
  * Default: ALIKED-N16rot keypoints + LightGlue (kornia), written into a COLMAP database and
    geometrically verified by COLMAP. On small, low-texture, wide-baseline sets this registers
    far more views than SIFT (all 19 vs. 7 on the bundled box sample).
  * Fallback: COLMAP SIFT (CPU) when the learned matcher is unavailable.

Pair selection:
  * Small sets (<= preset.exhaustive_max_images): capture order is exploited. If consecutive
    frames match well, pairs are added by increasing index offset (cyclically, so orbits close)
    until the median match count of an offset falls off. This avoids "doppelganger" pairs
    between symmetric/repeated views (e.g. the two identical ends of a box), which otherwise fold
    the reconstruction. Unordered sets fall back to exhaustive matching.
  * Large sets (video): sequential window + DINOv2 retrieval neighbours.

Mapping: COLMAP incremental mapper; the model with the most registered images wins.
"""

from __future__ import annotations

import itertools
import logging
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .config import Preset
from .data import Frame, SfMResult, View
from .errors import ReconError
from .ingest import load_rgb, resize_max_side
from .progress import SubProgress
from .runtime import CANCEL

log = logging.getLogger("recon")

MIN_PAIR_INLIERS = 25


# ---------------------------------------------------------------------------------------------
# Learned features
# ---------------------------------------------------------------------------------------------


@dataclass
class Features:
    keypoints: np.ndarray  # (N,2) float32, pixel coords at ingest resolution, pixel-centre = 0
    descriptors: object  # torch.Tensor (N,D)
    size: tuple[int, int]  # (w, h) at ingest resolution


class AlikedLightGlue:
    name = "aliked+lightglue"

    def __init__(self, max_keypoints: int, device: str) -> None:
        import torch
        import kornia.feature as KF

        from .models import ensure_aliked_weights

        ensure_aliked_weights()
        self.torch = torch
        self.device = torch.device(device)
        self.extractor = KF.ALIKED.from_pretrained(
            "aliked-n16rot", max_num_keypoints=max_keypoints, detection_threshold=0.01, device=self.device
        ).eval()
        self.matcher = KF.LightGlue("aliked").eval().to(self.device)

    def extract(self, rgb: np.ndarray, max_side: int) -> Features:
        torch = self.torch
        h, w = rgb.shape[:2]
        small = resize_max_side(rgb, max_side)
        sh, sw = small.shape[:2]
        x = torch.from_numpy(small).permute(2, 0, 1)[None].float().div(255.0).to(self.device)
        with torch.inference_mode():
            f = self.extractor(x)[0]
        kp = f.keypoints.float().cpu().numpy()
        # Rescale to ingest resolution (pixel-centre convention).
        kp = (kp + 0.5) * np.array([w / sw, h / sh], dtype=np.float32) - 0.5
        return Features(keypoints=kp.astype(np.float32), descriptors=f.descriptors.float(), size=(w, h))

    def match(self, a: Features, b: Features) -> np.ndarray:
        torch = self.torch
        if len(a.keypoints) < 8 or len(b.keypoints) < 8:
            return np.zeros((0, 2), dtype=np.uint32)
        data = {
            "image0": {
                "keypoints": torch.from_numpy(a.keypoints)[None].to(self.device),
                "descriptors": a.descriptors[None],  # type: ignore[index]
                "image_size": torch.tensor([a.size], dtype=torch.float32, device=self.device),
            },
            "image1": {
                "keypoints": torch.from_numpy(b.keypoints)[None].to(self.device),
                "descriptors": b.descriptors[None],  # type: ignore[index]
                "image_size": torch.tensor([b.size], dtype=torch.float32, device=self.device),
            },
        }
        with torch.inference_mode():
            out = self.matcher(data)
        return out["matches"][0].cpu().numpy().astype(np.uint32)


def quick_inliers(ka: np.ndarray, kb: np.ndarray, matches: np.ndarray, size: tuple[int, int]) -> int:
    """Fundamental-matrix RANSAC inlier count (only used for pair-selection statistics)."""
    if len(matches) < 15:
        return 0
    p1 = ka[matches[:, 0]].astype(np.float64)
    p2 = kb[matches[:, 1]].astype(np.float64)
    thr = max(1.0, 1.0 * max(size) / 1000.0)
    try:
        _, mask = cv2.findFundamentalMat(p1, p2, cv2.USAC_MAGSAC, thr, 0.999, 2000)
    except cv2.error:
        return 0
    return int(mask.sum()) if mask is not None else 0


# ---------------------------------------------------------------------------------------------
# Pair selection (pure helpers are unit-tested)
# ---------------------------------------------------------------------------------------------


def offset_pairs(n: int, d: int, cyclic: bool = True) -> list[tuple[int, int]]:
    pairs = []
    for i in range(n):
        j = i + d
        if j >= n:
            if not cyclic:
                continue
            j -= n
        a, b = (i, j) if i < j else (j, i)
        if a != b:
            pairs.append((a, b))
    return sorted(set(pairs))


def choose_offset_window(medians: list[float], rel: float = 0.3, floor: float = MIN_PAIR_INLIERS) -> int:
    """Largest offset ``d`` (1-based) such that offsets 1..d all keep a strong median.

    Stops at the first offset whose median falls below ``rel * medians[0]`` or ``floor``, or
    that rises again (a sign of doppelganger matches between symmetric views).
    """
    if not medians or medians[0] < floor:
        return 0
    best = 1
    for k in range(1, len(medians)):
        m = medians[k]
        if m < rel * medians[0] or m < floor or m > 1.15 * medians[k - 1]:
            break
        best = k + 1
    return best


def retrieval_pairs(desc: np.ndarray, k: int) -> list[tuple[int, int]]:
    sim = desc @ desc.T
    np.fill_diagonal(sim, -np.inf)
    pairs = set()
    for i in range(len(desc)):
        for j in np.argsort(-sim[i])[:k]:
            a, b = (i, int(j)) if i < j else (int(j), i)
            pairs.add((a, b))
    return sorted(pairs)


def global_descriptors(images: list[np.ndarray], device: str) -> np.ndarray | None:
    try:
        import torch
        from transformers import AutoModel

        from .models import RETRIEVAL_REPO

        model = AutoModel.from_pretrained(RETRIEVAL_REPO).eval().to(device)
        mean = np.array([0.485, 0.456, 0.406], np.float32)
        std = np.array([0.229, 0.224, 0.225], np.float32)
        out = []
        for rgb in images:
            CANCEL.check()
            x = cv2.resize(rgb, (224, 224), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
            x = torch.from_numpy(((x - mean) / std).transpose(2, 0, 1)[None]).to(device)
            with torch.inference_mode():
                hs = model(pixel_values=x).last_hidden_state[0]
            # GeM-pooled patch tokens + CLS.
            patches = hs[1:].clamp(min=1e-6).pow(3).mean(0).pow(1 / 3)
            v = torch.cat([hs[0], patches]).float().cpu().numpy()
            out.append(v / (np.linalg.norm(v) + 1e-8))
        return np.stack(out)
    except Exception as e:
        log.warning("Image retrieval model unavailable (%s); using sequential pairs only", e)
        return None


# ---------------------------------------------------------------------------------------------
# COLMAP database helpers
# ---------------------------------------------------------------------------------------------


def _camera_groups(frames: list[Frame]) -> dict[str, list[int]]:
    groups: dict[str, list[int]] = {}
    for i, f in enumerate(frames):
        groups.setdefault(f.camera_key, []).append(i)
    return groups


def _make_database(db_path: Path, frames: list[Frame], camera_model: str) -> list[int]:
    import pycolmap

    db = pycolmap.Database.open(str(db_path))
    image_ids = [0] * len(frames)
    try:
        for _, idxs in _camera_groups(frames).items():
            f0 = frames[idxs[0]]
            priors = [frames[i].focal_px_prior for i in idxs if frames[i].focal_px_prior]
            focal = float(np.median(priors)) if priors else 1.2 * max(f0.width, f0.height)
            cam = pycolmap.Camera.create_from_model_name(1, camera_model, focal, f0.width, f0.height)
            cam.has_prior_focal_length = bool(priors)
            cam_id = db.write_camera(cam)
            for i in idxs:
                image_ids[i] = db.write_image(pycolmap.Image(name=frames[i].name, camera_id=cam_id))
    finally:
        db.close()
    return image_ids


# ---------------------------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------------------------


def run_sfm(
    frames: list[Frame],
    image_dir: Path,
    work_dir: Path,
    preset: Preset,
    device: str,
    progress: SubProgress,
    ordered: bool = True,
    masks: dict[str, np.ndarray] | None = None,
) -> SfMResult:
    import pycolmap

    t0 = time.monotonic()
    sfm_dir = work_dir / "sfm"
    if sfm_dir.exists():
        shutil.rmtree(sfm_dir)
    sfm_dir.mkdir(parents=True)
    db_path = sfm_dir / "database.db"
    n = len(frames)
    timings: dict[str, float] = {}

    matcher_name = "aliked+lightglue"
    sequential = False
    try:
        # Large (video) sets: fewer keypoints per frame keeps LightGlue affordable on CPU;
        # neighbouring video frames overlap heavily, so this costs little accuracy.
        kpts = preset.max_keypoints if n <= preset.exhaustive_max_images else max(1024, preset.max_keypoints // 2)
        engine = AlikedLightGlue(kpts, device)
    except Exception as e:
        log.warning("Learned matcher unavailable (%s); falling back to COLMAP SIFT", e)
        engine = None
        matcher_name = "sift"

    camera_model = "SIMPLE_RADIAL"
    token = pycolmap.CancellationToken()
    unhook = CANCEL.add_native_hook(token.cancel)
    try:
        if engine is not None:
            image_ids = _make_database(db_path, frames, camera_model)
            # ---- features
            feats: list[Features] = []
            images = []
            for i, fr in enumerate(frames):
                CANCEL.check()
                rgb = load_rgb(fr.path)
                images.append(rgb)
                feats.append(engine.extract(rgb, preset.feature_max_side))
                progress.update(0.25 * (i + 1) / n, f"Detected features in {i + 1}/{n} images")
            timings["features"] = time.monotonic() - t0
            db = pycolmap.Database.open(str(db_path))
            try:
                for iid, f in zip(image_ids, feats):
                    db.write_keypoints(iid, (f.keypoints + 0.5).astype(np.float32))  # COLMAP: pixel centre = 0.5
            finally:
                db.close()

            # ---- matching with adaptive pair selection
            matched: dict[tuple[int, int], np.ndarray] = {}
            inl: dict[tuple[int, int], int] = {}

            def do_pairs(pairs: list[tuple[int, int]], lo: float, hi: float, label: str) -> None:
                todo = [p for p in pairs if p not in matched]
                for k, (a, b) in enumerate(todo):
                    CANCEL.check()
                    m = engine.match(feats[a], feats[b])
                    matched[(a, b)] = m
                    inl[(a, b)] = quick_inliers(feats[a].keypoints, feats[b].keypoints, m, feats[a].size)
                    progress.update(lo + (hi - lo) * (k + 1) / max(1, len(todo)), f"{label} ({k + 1}/{len(todo)} pairs)")

            t1 = time.monotonic()
            if n <= preset.exhaustive_max_images:
                cyclic = n >= 6
                do_pairs(offset_pairs(n, 1, cyclic), 0.25, 0.32, "Matching neighbours")
                consecutive = [inl[p] for p in offset_pairs(n, 1, cyclic=False)]
                strong = float(np.mean([c >= MIN_PAIR_INLIERS * 2 for c in consecutive])) if consecutive else 0.0
                if ordered and strong >= 0.8:
                    sequential = True
                    medians = [float(np.median([inl[p] for p in offset_pairs(n, 1, cyclic)]))]
                    d = 2
                    max_d = n // 2
                    while d <= max_d:
                        do_pairs(offset_pairs(n, d, cyclic), 0.32, 0.6, f"Matching offset {d}")
                        medians.append(float(np.median([inl[p] for p in offset_pairs(n, d, cyclic)])))
                        if choose_offset_window(medians) < d:
                            break
                        d += 1
                    window = max(1, choose_offset_window(medians))
                    keep = set()
                    for dd in range(1, window + 1):
                        keep.update(offset_pairs(n, dd, cyclic))
                    log.info(
                        "Ordered capture detected: matching neighbours up to offset %d (median inliers per offset: %s)",
                        window,
                        ", ".join(str(int(m)) for m in medians),
                    )
                else:
                    keep = set(itertools.combinations(range(n), 2))
                    do_pairs(sorted(keep), 0.32, 0.6, "Matching all pairs")
            else:
                keep = set()
                for d in range(1, preset.sequential_overlap + 1):
                    keep.update(offset_pairs(n, d, cyclic=False))
                desc = global_descriptors(images, device)
                if desc is not None:
                    keep.update(retrieval_pairs(desc, preset.retrieval_neighbors))
                else:
                    stride = max(2, n // 20)
                    for i in range(0, n, stride):
                        for j in range(i + 2 * preset.sequential_overlap, n, stride * 2):
                            keep.add((i, j))
                sequential = True
                do_pairs(sorted(keep), 0.25, 0.6, "Matching pairs")
            timings["matching"] = time.monotonic() - t1
            del images

            db = pycolmap.Database.open(str(db_path))
            try:
                for (a, b) in sorted(keep):
                    m = matched.get((a, b))
                    if m is not None and len(m) >= 15:
                        db.write_matches(image_ids[a], image_ids[b], m)
            finally:
                db.close()
            progress.update(0.62, "Verifying matches")
            pycolmap.geometric_verification(str(db_path), cancellation_token=token)
        else:
            _sift_features_and_matches(db_path, image_dir, frames, preset, token, progress)

        CANCEL.check()
        progress.update(0.65, "Estimating camera poses")
        t2 = time.monotonic()
        rec = _map(db_path, image_dir, sfm_dir, token, relaxed=False, progress=progress)
        if rec is None or rec.num_reg_images() < max(3, int(0.7 * n)):
            CANCEL.check()
            log.info("Retrying mapping with relaxed thresholds")
            rec2 = _map(db_path, image_dir, sfm_dir / "relaxed", token, relaxed=True, progress=progress)
            if rec2 is not None and (rec is None or rec2.num_reg_images() > rec.num_reg_images()):
                rec = rec2
        timings["mapping"] = time.monotonic() - t2
    finally:
        unhook()
    CANCEL.check()

    nreg = 0 if rec is None else rec.num_reg_images()
    if rec is None or nreg < max(3, int(np.ceil(0.25 * n))):
        raise ReconError(
            "too_few_registered",
            f"Only {nreg} of {n} images could be aligned. Take more photos with large overlap "
            "(each spot visible in 3+ photos), avoid motion blur, and keep the subject textured and well lit.",
        )
    if nreg < 0.7 * n:
        log.warning("Only %d of %d images were aligned; the model may be incomplete", nreg, n)
    progress.update(0.95, f"Registered {nreg}/{n} images")

    views, pts, rgb, err = build_views(rec, frames, masks)
    progress.update(1.0, f"Registered {nreg}/{n} images, {len(pts)} points")
    cam0 = next(iter(rec.cameras.values()))
    return SfMResult(
        views=views,
        points_xyz=pts,
        points_rgb=rgb,
        points_err=err,
        num_input=n,
        num_registered=nreg,
        mean_reprojection_error=float(rec.compute_mean_reprojection_error()),
        matcher=matcher_name,
        sequential=sequential,
        camera_model=str(cam0.model_name),
        timings={k: round(v, 3) for k, v in timings.items()},
    )


def _sift_features_and_matches(
    db_path: Path, image_dir: Path, frames: list[Frame], preset: Preset, token: object, progress: SubProgress
) -> None:
    import pycolmap

    progress.update(0.05, "Detecting SIFT features")
    eo = pycolmap.FeatureExtractionOptions()
    eo.max_image_size = preset.feature_max_side
    eo.sift.max_num_features = preset.max_keypoints * 2
    eo.sift.peak_threshold = 0.002  # more features on low-contrast surfaces
    ro = pycolmap.ImageReaderOptions()
    ro.camera_model = "SIMPLE_RADIAL"
    single = len(_camera_groups(frames)) == 1
    pycolmap.extract_features(
        str(db_path),
        str(image_dir),
        image_names=[f.name for f in frames],
        camera_mode=pycolmap.CameraMode.SINGLE if single else pycolmap.CameraMode.AUTO,
        reader_options=ro,
        extraction_options=eo,
        device=pycolmap.Device.auto,
        cancellation_token=token,  # type: ignore[arg-type]
    )
    progress.update(0.3, "Matching SIFT features")
    mo = pycolmap.FeatureMatchingOptions()
    mo.guided_matching = True
    if len(frames) <= preset.exhaustive_max_images:
        pycolmap.match_exhaustive(str(db_path), matching_options=mo, cancellation_token=token)  # type: ignore[arg-type]
    else:
        po = pycolmap.SequentialPairingOptions()
        po.overlap = preset.sequential_overlap
        po.loop_detection = False
        pycolmap.match_sequential(str(db_path), matching_options=mo, pairing_options=po, cancellation_token=token)  # type: ignore[arg-type]
    progress.update(0.6, "Matched SIFT features")


def _map(db_path: Path, image_dir: Path, out: Path, token: object, relaxed: bool, progress: SubProgress):  # type: ignore[no-untyped-def]
    import pycolmap

    out.mkdir(parents=True, exist_ok=True)
    opts = pycolmap.IncrementalPipelineOptions()
    opts.min_model_size = 3
    opts.extract_colors = True
    if relaxed:
        opts.min_num_matches = 10
        opts.mapper.init_min_num_inliers = 40
        opts.mapper.abs_pose_min_num_inliers = 15
        opts.mapper.abs_pose_min_inlier_ratio = 0.15
        opts.mapper.init_min_tri_angle = 8.0
    count = {"n": 0}

    def on_next() -> None:
        # Never raise into native code: cancellation is delivered via the COLMAP token.
        count["n"] += 1
        try:
            progress.update(0.65 + 0.28 * min(1.0, count["n"] / 50.0), f"Registered {count['n'] + 2} images")
        except BaseException:
            pass

    try:
        recs = pycolmap.incremental_mapping(
            str(db_path), str(image_dir), str(out), opts, next_image_callback=on_next, cancellation_token=token  # type: ignore[arg-type]
        )
    except Exception as e:
        log.warning("Incremental mapping failed: %s", e)
        return None
    if not recs:
        return None
    return max(recs.values(), key=lambda r: (r.num_reg_images(), r.num_points3D()))


def _undistort(img: np.ndarray, model: str, params: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (undistorted image, pinhole K) for COLMAP camera models we create/accept."""
    if model == "SIMPLE_PINHOLE":
        f, cx, cy = params[:3]
        return img, np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]])
    if model == "PINHOLE":
        fx, fy, cx, cy = params[:4]
        return img, np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]])
    if model == "SIMPLE_RADIAL":
        f, cx, cy, k = params[:4]
        K, dist = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]]), np.array([k, 0, 0, 0])
    elif model == "RADIAL":
        f, cx, cy, k1, k2 = params[:5]
        K, dist = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]]), np.array([k1, k2, 0, 0])
    elif model == "OPENCV":
        fx, fy, cx, cy, k1, k2, p1, p2 = params[:8]
        K, dist = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]]), np.array([k1, k2, p1, p2])
    else:
        raise ReconError("internal", f"Unsupported camera model {model}")
    if np.abs(dist).max() < 1e-6:
        return img, K
    # COLMAP pixel-centre is 0.5; OpenCV uses 0 - shift the principal point accordingly.
    Kcv = K.copy()
    Kcv[0, 2] -= 0.5
    Kcv[1, 2] -= 0.5
    und = cv2.undistort(img, Kcv, dist, None, Kcv)
    return und, K


def build_views(rec, frames: list[Frame], masks: dict[str, np.ndarray] | None = None) -> tuple[list[View], np.ndarray, np.ndarray, np.ndarray]:  # type: ignore[no-untyped-def]
    by_name = {f.name: f for f in frames}
    pid_list = list(rec.points3D.keys())
    pid_index = {pid: k for k, pid in enumerate(pid_list)}
    pts = np.array([rec.points3D[p].xyz for p in pid_list], dtype=np.float64).reshape(-1, 3)
    rgb = np.array([rec.points3D[p].color for p in pid_list], dtype=np.uint8).reshape(-1, 3)
    err = np.array([rec.points3D[p].error for p in pid_list], dtype=np.float64)

    views: list[View] = []
    images = sorted((im for im in rec.images.values() if im.has_pose), key=lambda im: im.name)
    for im in images:
        fr = by_name.get(im.name)
        if fr is None:
            continue
        cam = rec.cameras[im.camera_id]
        img = load_rgb(fr.path)
        und, K = _undistort(img, cam.model_name, np.asarray(cam.params, dtype=np.float64))
        # Shift to the 0-centred pixel convention used everywhere downstream.
        K = K.copy()
        K[0, 2] -= 0.5
        K[1, 2] -= 0.5
        M = im.cam_from_world().matrix()
        R, t = M[:, :3].copy(), M[:, 3].copy()
        ids = np.array([p.point3D_id for p in im.points2D if p.has_point3D()], dtype=np.int64)
        idx = np.array([pid_index[i] for i in ids if i in pid_index], dtype=np.int64)
        v = View(name=im.name, image=und, K=K, R=R, t=t)
        if masks is not None and im.name in masks:
            mk, _ = _undistort(masks[im.name].astype(np.float32), cam.model_name, np.asarray(cam.params, dtype=np.float64))
            v.mask = np.clip(mk, 0, 1).astype(np.float32)
        if len(idx):
            X = pts[idx]
            uv, z = v.project(X)
            ok = z > 0
            v.sparse_xyz, v.sparse_uv, v.sparse_depth, v.sparse_ids = X[ok], uv[ok], z[ok], idx[ok]
        views.append(v)
    return views, pts, rgb, err
