"""Pure geometric helpers (no I/O, no models). Unit-tested."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class AffineFit:
    scale: float
    shift: float
    inlier_ratio: float
    residual: float  # median absolute relative residual on inliers
    n: int


def fit_scale_shift(
    pred: np.ndarray,
    target: np.ndarray,
    weights: np.ndarray | None = None,
    iters: int = 20,
    allow_shift: bool = True,
    rel_threshold: float = 0.05,
    seed: int = 0,
) -> AffineFit:
    """Robustly fit ``target ~= scale * pred + shift``.

    RANSAC on minimal 2-point samples (inliers judged by relative error), followed by IRLS
    (Huber/Cauchy-style reweighting) on the inlier set. Works in whatever space the inputs are
    in (depth or inverse depth).
    """
    pred = np.asarray(pred, dtype=np.float64).ravel()
    target = np.asarray(target, dtype=np.float64).ravel()
    w0 = np.ones_like(pred) if weights is None else np.asarray(weights, dtype=np.float64).ravel()
    ok = np.isfinite(pred) & np.isfinite(target) & (np.abs(target) > 1e-12) & (w0 > 0)
    pred, target, w0 = pred[ok], target[ok], w0[ok]
    n = len(pred)
    if n == 0:
        return AffineFit(1.0, 0.0, 0.0, float("inf"), 0)
    if n < 3 or not allow_shift:
        # Scale only: weighted median of ratios is robust.
        r = target / np.where(np.abs(pred) > 1e-12, pred, np.nan)
        r = r[np.isfinite(r)]
        s = float(np.median(r)) if len(r) else 1.0
        res = np.abs(s * pred - target) / np.abs(target)
        inl = res < rel_threshold
        return AffineFit(s, 0.0, float(inl.mean()), float(np.median(res[inl])) if inl.any() else float(np.median(res)), n)

    rng = np.random.default_rng(seed)
    best_inl = None
    best_count = -1
    trials = min(200, n * (n - 1) // 2)
    for _ in range(trials):
        i, j = rng.choice(n, 2, replace=False)
        dp = pred[i] - pred[j]
        if abs(dp) < 1e-9 * (abs(pred[i]) + 1e-12):
            continue
        s = (target[i] - target[j]) / dp
        if s <= 0:
            continue
        b = target[i] - s * pred[i]
        res = np.abs(s * pred + b - target) / np.abs(target)
        inl = res < rel_threshold
        c = int((inl * w0).sum() * 1000)
        if c > best_count:
            best_count, best_inl = c, inl
    if best_inl is None or best_inl.sum() < 3:
        best_inl = np.ones(n, dtype=bool)

    # IRLS on inliers (+ near-inliers) with Cauchy weights.
    s, b = 1.0, 0.0
    mask = best_inl
    wr = np.ones(n)
    for _ in range(iters):
        P, T = pred[mask], target[mask]
        # Relative residuals: weight by 1/target^2 so the fit minimises relative error.
        W = (w0 * wr)[mask] / np.maximum(T * T, 1e-24)
        A = np.stack([P, np.ones_like(P)], 1)
        sw = np.sqrt(W)
        sol, *_ = np.linalg.lstsq(A * sw[:, None], T * sw, rcond=None)
        s_new, b_new = float(sol[0]), float(sol[1])
        res = np.abs(s_new * pred + b_new - target) / np.abs(target)
        sigma = max(1.4826 * float(np.median(res[mask])), 1e-4)
        wr = 1.0 / (1.0 + (res / (2.5 * sigma)) ** 2)
        new_mask = res < max(rel_threshold, 3 * sigma)
        converged = abs(s_new - s) <= 1e-7 * abs(s_new) + 1e-12 and abs(b_new - b) <= 1e-7 * (abs(b_new) + 1e-9)
        s, b = s_new, b_new
        if new_mask.sum() < 3 or converged:
            break
        mask = new_mask
    res = np.abs(s * pred + b - target) / np.abs(target)
    inl = res < rel_threshold
    return AffineFit(s, b, float(inl.mean()), float(np.median(res[inl])) if inl.any() else float(np.median(res)), n)


def fit_plane_ransac(
    pts: np.ndarray, threshold: float, iters: int = 500, seed: int = 0
) -> tuple[np.ndarray, float, np.ndarray] | None:
    """Fit ``n.x + d = 0`` (unit n). Returns (n, d, inlier_mask) or None."""
    pts = np.asarray(pts, dtype=np.float64)
    if len(pts) < 3:
        return None
    rng = np.random.default_rng(seed)
    best = None
    best_count = 0
    for _ in range(iters):
        a, b, c = pts[rng.choice(len(pts), 3, replace=False)]
        nrm = np.cross(b - a, c - a)
        ln = np.linalg.norm(nrm)
        if ln < 1e-12:
            continue
        nrm /= ln
        d = -float(nrm @ a)
        inl = np.abs(pts @ nrm + d) < threshold
        cnt = int(inl.sum())
        if cnt > best_count:
            best_count, best = cnt, (nrm, d, inl)
    if best is None:
        return None
    nrm, d, inl = best
    # Least-squares refinement on inliers.
    P = pts[inl]
    c = P.mean(0)
    _, _, vt = np.linalg.svd(P - c, full_matrices=False)
    nrm = vt[-1]
    if nrm @ best[0] < 0:
        nrm = -nrm
    d = -float(nrm @ c)
    inl = np.abs(pts @ nrm + d) < threshold
    return nrm, d, inl


def rotation_between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Rotation matrix mapping unit vector ``a`` onto unit vector ``b``."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(a @ b)
    if c < -1 + 1e-9:
        # 180 degrees: rotate about any axis orthogonal to a.
        axis = np.cross(a, [1.0, 0, 0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0, 1.0, 0])
        axis /= np.linalg.norm(axis)
        return 2 * np.outer(axis, axis) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1.0 / (1.0 + c))


def rotation_about_y(angle: float) -> np.ndarray:
    c, s = np.cos(angle), np.sin(angle)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def up_from_cameras(Rs: list[np.ndarray]) -> np.ndarray:
    """World up direction from camera orientations (OpenCV cameras: +y points down in image).

    People hold cameras roughly level, so the mean of the cameras' -y axes is a good estimate of
    gravity-up. For orbits the cameras' up vectors are also nearly orthogonal to the plane of
    camera centres, which the caller may use to refine this.
    """
    ups = np.stack([-R[1] for R in Rs])
    u = ups.mean(0)
    n = np.linalg.norm(u)
    return u / n if n > 1e-9 else np.array([0.0, -1.0, 0.0])


@dataclass
class Similarity:
    """x' = s * R @ x + t."""

    s: float
    R: np.ndarray
    t: np.ndarray

    def apply(self, X: np.ndarray) -> np.ndarray:
        return self.s * (np.asarray(X) @ self.R.T) + self.t

    def apply_dir(self, N: np.ndarray) -> np.ndarray:
        return np.asarray(N) @ self.R.T

    def matrix(self) -> np.ndarray:
        M = np.eye(4)
        M[:3, :3] = self.s * self.R
        M[:3, 3] = self.t
        return M

    def compose(self, other: "Similarity") -> "Similarity":
        """self after other."""
        return Similarity(self.s * other.s, self.R @ other.R, self.s * (self.R @ other.t) + self.t)


def robust_bbox(pts: np.ndarray, lo: float = 2.0, hi: float = 98.0) -> tuple[np.ndarray, np.ndarray]:
    return np.percentile(pts, lo, axis=0), np.percentile(pts, hi, axis=0)


def backproject(depth: np.ndarray, K: np.ndarray, R: np.ndarray, t: np.ndarray, mask: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Depth map -> world points. Returns (points (M,3), flat pixel indices (M,))."""
    h, w = depth.shape
    valid = depth > 0
    if mask is not None:
        valid &= mask
    idx = np.flatnonzero(valid)
    ys, xs = np.divmod(idx, w)
    z = depth.ravel()[idx]
    x = (xs - K[0, 2]) / K[0, 0] * z
    y = (ys - K[1, 2]) / K[1, 1] * z
    Xc = np.stack([x, y, z], 1)
    Xw = (Xc - t) @ R  # R^T (Xc - t)
    return Xw, idx


def bilinear_sample(img: np.ndarray, x: np.ndarray, y: np.ndarray, wrap: bool = False) -> np.ndarray:
    """Bilinear lookup at float pixel coords (pixel centre = integer coords).

    Returns (N,) for 2-D images or (N,C) for multi-channel images. Coordinates are clamped to
    the border (or wrapped when ``wrap``). Pure numpy: no size limits (unlike ``cv2.remap``).
    """
    h, w = img.shape[:2]
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    if wrap:
        x = np.mod(x, w)
        y = np.mod(y, h)
    else:
        x = np.clip(x, 0, w - 1)
        y = np.clip(y, 0, h - 1)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = (x - x0).astype(np.float32)
    fy = (y - y0).astype(np.float32)
    if wrap:
        x1, y1 = (x0 + 1) % w, (y0 + 1) % h
        x0, y0 = x0 % w, y0 % h
    else:
        x1, y1 = np.minimum(x0 + 1, w - 1), np.minimum(y0 + 1, h - 1)
    a = img[y0, x0].astype(np.float32)
    b = img[y0, x1].astype(np.float32)
    c = img[y1, x0].astype(np.float32)
    d = img[y1, x1].astype(np.float32)
    if img.ndim == 3:
        fx, fy = fx[:, None], fy[:, None]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
