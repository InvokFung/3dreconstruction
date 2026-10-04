"""Dense depth for every registered view.

CPU path (default): Depth Anything 3 (Apache-2.0 checkpoints) run multi-view and *pose
conditioned* on the SfM cameras, so its depth comes out in SfM units and consistent across
views (median relative error vs. SfM points ~0.5% on the samples). Each view is then refined
with a robust scale+shift fit against its sparse SfM depths, filtered for multi-view
consistency and depth discontinuities, and optionally masked to the subject.

Fallback: Depth Anything V2 Small (mono, relative inverse depth) aligned per view to SfM in
inverse-depth space.

GPU option: when pycolmap is built with CUDA, ``engines.colmap_mvs`` runs PatchMatch MVS instead.
"""

from __future__ import annotations

import logging
from typing import Callable

import cv2
import numpy as np

from .data import DepthResult, View
from .geometry import bilinear_sample, fit_scale_shift
from .progress import SubProgress
from .runtime import CANCEL

log = logging.getLogger("recon")


def _round14(x: float) -> int:
    return max(14, int(round(x / 14.0)) * 14)


# ---------------------------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------------------------


class DA3Backend:
    def __init__(self, repo: str, device: str) -> None:
        import torch
        from depth_anything_3.api import DepthAnything3

        self.torch = torch
        self.repo = repo
        self.model = DepthAnything3.from_pretrained(repo).eval().to(device)
        self.device = device

    def infer(
        self, images: list[np.ndarray], w2c: np.ndarray | None, K: np.ndarray | None, res: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Returns (depth (N,h,w), conf (N,h,w), intrinsics (N,3,3) at depth resolution)."""
        torch = self.torch
        with torch.inference_mode():
            pred = self.model.inference(
                images,
                extrinsics=None if w2c is None else w2c.astype(np.float32),
                intrinsics=None if K is None else K.astype(np.float32),
                align_to_input_ext_scale=True,
                process_res=res,
                ref_view_strategy="saddle_balanced",
            )
        conf = pred.conf if pred.conf is not None else np.ones_like(pred.depth)
        return np.asarray(pred.depth, np.float32), np.asarray(conf, np.float32), np.asarray(pred.intrinsics, np.float64)


class DAV2Backend:
    """Mono relative depth (inverse-depth output)."""

    def __init__(self, device: str) -> None:
        import torch
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation

        from .models import DAV2_FALLBACK_REPO

        self.torch = torch
        self.proc = AutoImageProcessor.from_pretrained(DAV2_FALLBACK_REPO)
        self.model = AutoModelForDepthEstimation.from_pretrained(DAV2_FALLBACK_REPO).eval().to(device)
        self.device = device

    def infer_disparity(self, rgb: np.ndarray, res: int) -> np.ndarray:
        torch = self.torch
        h, w = rgb.shape[:2]
        s = res / max(h, w)
        th, tw = _round14(h * s), _round14(w * s)
        x = cv2.resize(rgb, (tw, th), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
        inputs = self.proc(images=x, return_tensors="pt", do_resize=False)
        with torch.inference_mode():
            out = self.model(**{k: v.to(self.device) for k, v in inputs.items()}).predicted_depth
        return out[0].float().cpu().numpy()


# ---------------------------------------------------------------------------------------------
# Helpers (pure)
# ---------------------------------------------------------------------------------------------


def scale_intrinsics(K: np.ndarray, sx: float, sy: float) -> np.ndarray:
    """Scale pinhole intrinsics for an image resized by (sx, sy) (pixel-centre = 0 convention)."""
    K2 = K.copy().astype(np.float64)
    K2[0, 0] *= sx
    K2[1, 1] *= sy
    K2[0, 2] = (K[0, 2] + 0.5) * sx - 0.5
    K2[1, 2] = (K[1, 2] + 0.5) * sy - 0.5
    return K2


def sample_nearest(img: np.ndarray, uv: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    h, w = img.shape[:2]
    x = np.round(uv[:, 0]).astype(np.int64)
    y = np.round(uv[:, 1]).astype(np.int64)
    ok = (x >= 0) & (x < w) & (y >= 0) & (y < h)
    out = np.zeros(len(uv), dtype=img.dtype)
    out[ok] = img[y[ok], x[ok]]
    return out, ok


def depth_edges(depth: np.ndarray, rel: float = 0.04) -> np.ndarray:
    """Pixels at depth discontinuities (flying pixels) -> True."""
    d = depth.astype(np.float32)
    valid = d > 0
    dmax = cv2.dilate(np.where(valid, d, 0), np.ones((3, 3), np.uint8))
    dmin = -cv2.dilate(np.where(valid, -d, -1e9), np.ones((3, 3), np.uint8))
    dmin = np.where(dmin < -1e8, 0, dmin)
    with np.errstate(divide="ignore", invalid="ignore"):
        jump = (dmax - dmin) / np.maximum(d, 1e-9)
    return valid & (jump > rel)


def covisibility_neighbors(views: list[View], k: int) -> list[list[int]]:
    """For each view, the ``k`` views sharing the most sparse points (fallback: nearest centres)."""
    sets = [set(v.sparse_ids.tolist()) for v in views]
    centers = np.stack([v.center for v in views])
    out: list[list[int]] = []
    for i in range(len(views)):
        scores = []
        for j in range(len(views)):
            if i == j:
                continue
            shared = len(sets[i] & sets[j])
            scores.append((shared, -float(np.linalg.norm(centers[i] - centers[j])), j))
        scores.sort(reverse=True)
        out.append([j for s, _, j in scores[:k]])
    return out


def consistency_filter(
    depths: list[np.ndarray],
    Ks: list[np.ndarray],
    views: list[View],
    neighbors: list[list[int]],
    rel_tol: float,
    min_consistent: int,
) -> tuple[list[np.ndarray], list[float]]:
    """Keep pixels whose 3D point agrees (within ``rel_tol``) with >= ``min_consistent`` neighbours.

    Pixels that project outside a neighbour or behind it count as neither agreeing nor
    disagreeing; a pixel seen by fewer than ``min_consistent`` neighbours keeps its depth only if
    no neighbour contradicts it (occlusion-aware).
    """
    from .geometry import backproject

    out: list[np.ndarray] = []
    kept_frac: list[float] = []
    for i, d in enumerate(depths):
        CANCEL.check()
        v = views[i]
        X, idx = backproject(d, Ks[i], v.R, v.t)
        if len(idx) == 0:
            out.append(d)
            kept_frac.append(0.0)
            continue
        agree = np.zeros(len(idx), np.int32)
        seen = np.zeros(len(idx), np.int32)
        front = np.zeros(len(idx), np.int32)  # neighbour sees something clearly *behind* us -> contradiction
        for j in neighbors[i]:
            vj = views[j]
            Xc = X @ vj.R.T + vj.t
            z = Xc[:, 2]
            Kj = Ks[j]
            with np.errstate(divide="ignore", invalid="ignore"):
                u = Xc[:, 0] / z * Kj[0, 0] + Kj[0, 2]
                w = Xc[:, 1] / z * Kj[1, 1] + Kj[1, 2]
            dj, ok = sample_nearest(depths[j], np.stack([u, w], 1))
            ok &= (z > 0) & (dj > 0)
            rel = np.abs(z - dj) / np.maximum(dj, 1e-9)
            seen += ok
            agree += ok & (rel < rel_tol)
            # Our point lies in front of what the neighbour sees => free-space violation of
            # our point being solid (the neighbour looks *through* it).
            front += ok & (z < dj * (1 - 3 * rel_tol))
        good = (agree >= min_consistent) | ((seen < min_consistent) & (front == 0))
        good &= front <= agree  # majority vote against free-space violations
        nd = np.zeros_like(d)
        nd.ravel()[idx[good]] = d.ravel()[idx[good]]
        out.append(nd)
        kept_frac.append(float(good.mean()))
    return out, kept_frac


# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------


def compute_depths(
    views: list[View],
    model_repo: str,
    resolution: int,
    chunk: int,
    device: str,
    use_masks: bool,
    progress: SubProgress,
    estimate_metric: bool = True,
) -> DepthResult:
    n = len(views)
    max_side = max(max(v.width, v.height) for v in views)
    res = min(resolution, _round14(max_side))
    depths: list[np.ndarray] = [np.zeros((1, 1), np.float32)] * n
    confs: list[np.ndarray] = [np.zeros((1, 1), np.float32)] * n
    Ks: list[np.ndarray] = [np.eye(3)] * n
    model_name = model_repo
    inverse_space = False

    try:
        progress.update(0.02, "Loading depth model")
        backend = DA3Backend(model_repo, device)
        chunks = [list(range(i, min(n, i + chunk))) for i in range(0, n, chunk)]
        # Avoid a tiny last chunk: rebalance sizes.
        if len(chunks) > 1:
            k = len(chunks)
            chunks = [c.tolist() for c in np.array_split(np.arange(n), k)]
        for ci, idxs in enumerate(chunks):
            CANCEL.check()
            imgs = [views[i].image for i in idxs]
            w2c = np.stack([views[i].w2c for i in idxs])
            K = np.stack([views[i].K for i in idxs])
            progress.update(0.05 + 0.6 * ci / len(chunks), f"Estimating depth ({len(idxs)} views, {res}px)")
            d, c, kd = backend.infer(imgs, w2c if len(idxs) > 1 else None, K if len(idxs) > 1 else None, res)
            for k_, i in enumerate(idxs):
                depths[i], confs[i] = d[k_], c[k_]
                if len(idxs) > 1:
                    Ks[i] = kd[k_]
                else:
                    h, w = d.shape[1:]
                    Ks[i] = scale_intrinsics(views[i].K, w / views[i].width, h / views[i].height)
        del backend
    except Exception as e:
        if "Cancelled" in type(e).__name__:
            raise
        from .errors import is_oom

        if is_oom(e):
            raise
        log.warning("Depth Anything 3 unavailable (%s); falling back to Depth Anything V2 Small", e)
        model_name = "depth-anything/Depth-Anything-V2-Small-hf"
        inverse_space = True
        backend2 = DAV2Backend(device)
        for i, v in enumerate(views):
            CANCEL.check()
            disp = backend2.infer_disparity(v.image, res)
            h, w = disp.shape
            depths[i] = disp
            confs[i] = np.ones_like(disp)
            Ks[i] = scale_intrinsics(v.K, w / v.width, h / v.height)
            progress.update(0.05 + 0.6 * (i + 1) / n, f"Estimating depth {i + 1}/{n}")

    # ---- per-view alignment to sparse SfM depth
    progress.update(0.68, "Aligning depth to camera poses")
    errors: list[float] = []
    for i, v in enumerate(views):
        d = depths[i]
        h, w = d.shape
        if len(v.sparse_xyz) == 0:
            if inverse_space:
                depths[i] = np.zeros_like(d)
            continue
        Xc = v.sparse_xyz @ v.R.T + v.t
        z = Xc[:, 2]
        K = Ks[i]
        uv = np.stack([Xc[:, 0] / z * K[0, 0] + K[0, 2], Xc[:, 1] / z * K[1, 1] + K[1, 2]], 1)
        pv = bilinear_sample(d, uv[:, 0], uv[:, 1])
        ok = (uv[:, 0] >= 0) & (uv[:, 0] <= w - 1) & (uv[:, 1] >= 0) & (uv[:, 1] <= h - 1) & (z > 0) & (pv > 0)
        if inverse_space:
            fit = fit_scale_shift(pv[ok], 1.0 / z[ok], rel_threshold=0.05)
            if fit.n < 10 or fit.inlier_ratio < 0.3:
                log.warning("View %s: unreliable depth alignment (%d points)", v.name, fit.n)
                depths[i] = np.zeros_like(d)
                continue
            inv = fit.scale * d + fit.shift
            depths[i] = np.where(inv > 1e-9, 1.0 / np.maximum(inv, 1e-9), 0).astype(np.float32)
            errors.append(fit.residual)
        else:
            if ok.sum() >= 30:
                fit = fit_scale_shift(pv[ok], z[ok], rel_threshold=0.03)
                # Pose-conditioned DA3 is already in SfM scale; accept only sane corrections.
                if fit.inlier_ratio > 0.5 and 0.7 < fit.scale < 1.4 and abs(fit.shift) < 0.2 * float(np.median(z[ok])):
                    depths[i] = (fit.scale * d + fit.shift).astype(np.float32)
                else:
                    s = float(np.median(z[ok] / pv[ok]))
                    depths[i] = (d * s).astype(np.float32)
            dd = depths[i]
            pv2 = bilinear_sample(dd, uv[:, 0], uv[:, 1])
            ok2 = ok & (pv2 > 0)
            if ok2.any():
                errors.append(float(np.median(np.abs(pv2[ok2] - z[ok2]) / z[ok2])))
    align_err = float(np.median(errors)) if errors else float("nan")
    log.info("Depth alignment: median relative error vs. SfM points %.2f%%", 100 * align_err)

    # ---- confidence, edges, masks
    progress.update(0.72, "Filtering depth maps")
    for i, v in enumerate(views):
        d = depths[i]
        h, w = d.shape
        keep = d > 0
        c = confs[i]
        if c.shape == d.shape and np.isfinite(c).all() and c.max() > c.min():
            keep &= c >= np.percentile(c[keep], 10) if keep.any() else keep
        keep &= ~depth_edges(d, rel=0.03)
        if use_masks and v.mask is not None:
            m = cv2.resize(v.mask, (w, h), interpolation=cv2.INTER_LINEAR) > 0.5
            m = cv2.erode(m.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
            keep &= m
        depths[i] = np.where(keep, d, 0).astype(np.float32)

    # ---- multi-view consistency
    progress.update(0.78, "Checking multi-view consistency")
    k = min(6, n - 1)
    if k >= 1:
        nb = covisibility_neighbors(views, k)
        min_c = 2 if n >= 8 else 1
        tol = 0.015 if not inverse_space else 0.03
        depths, kept = consistency_filter(depths, Ks, views, nb, rel_tol=tol, min_consistent=min_c)
        log.info("Multi-view consistency kept %.0f%% of depth pixels", 100 * float(np.mean(kept)))

    metric = None
    if estimate_metric:
        progress.update(0.85, "Estimating real-world scale")
        try:
            metric = estimate_metric_scale(views, depths, Ks, device, res)
        except Exception as e:
            if "Cancelled" in type(e).__name__:
                raise
            log.warning("Metric scale estimation failed (%s)", e)
    progress.update(1.0, "Depth maps ready")
    return DepthResult(
        depths=depths,
        confidences=confs,
        intrinsics=Ks,
        model=model_name,
        alignment_error=align_err,
        metric_scale=metric,
    )


def estimate_metric_scale(views: list[View], depths: list[np.ndarray], Ks: list[np.ndarray], device: str, res: int, n_views: int = 3) -> float | None:
    """Meters per SfM unit, from DA3-Metric mono depth on a few views (median of ratios)."""
    from .models import DA3_METRIC_REPO

    backend = DA3Backend(DA3_METRIC_REPO, device)
    order = np.argsort([-(d > 0).sum() for d in depths])[: max(1, n_views)]
    ratios = []
    for i in order:
        CANCEL.check()
        raw, _, _ = backend.infer([views[i].image], None, None, min(res, 504))
        raw = raw[0]
        h, w = raw.shape
        Km = scale_intrinsics(views[i].K, w / views[i].width, h / views[i].height)
        metric = raw * (0.5 * (Km[0, 0] + Km[1, 1]) / 300.0)
        d = depths[i]
        m = cv2.resize(metric, (d.shape[1], d.shape[0]), interpolation=cv2.INTER_LINEAR)
        ok = (d > 0) & (m > 0)
        if ok.sum() > 100:
            ratios.append(float(np.median(m[ok] / d[ok])))
    del backend
    if not ratios:
        return None
    s = float(np.median(ratios))
    spread = float(np.std(ratios) / max(s, 1e-9)) if len(ratios) > 1 else 0.0
    log.info("Metric scale estimate: %.4f m/unit (spread %.1f%% over %d views)", s, 100 * spread, len(ratios))
    return s if np.isfinite(s) and s > 0 else None


ProgressFn = Callable[[float, str | None], None]
