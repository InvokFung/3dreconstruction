"""TSDF fusion of the filtered depth maps (Open3D ScalableTSDFVolume)."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import cv2
import numpy as np

from .data import View
from .geometry import backproject, robust_bbox
from .progress import SubProgress
from .runtime import CANCEL

log = logging.getLogger("recon")


@dataclass
class FusionResult:
    mesh: object  # open3d.geometry.TriangleMesh (vertex colours)
    points: np.ndarray  # (P,3) fused point cloud
    colors: np.ndarray  # (P,3) float in [0,1]
    voxel: float
    extent: float
    center: np.ndarray


def estimate_extent(views: list[View], depths: list[np.ndarray], Ks: list[np.ndarray], max_pts: int = 200_000) -> tuple[np.ndarray, float]:
    """Robust centre and diagonal of the reconstructed geometry (from depth maps)."""
    pts = []
    rng = np.random.default_rng(0)
    per = max(1000, max_pts // max(1, len(views)))
    for v, d, K in zip(views, depths, Ks):
        X, _ = backproject(d, K, v.R, v.t)
        if len(X) > per:
            X = X[rng.choice(len(X), per, replace=False)]
        pts.append(X)
    P = np.concatenate(pts) if pts else np.zeros((0, 3))
    if len(P) < 100:
        return np.zeros(3), 0.0
    lo, hi = robust_bbox(P, 1.0, 99.0)
    return 0.5 * (lo + hi), float(np.linalg.norm(hi - lo))


def tsdf_fuse(
    views: list[View],
    depths: list[np.ndarray],
    Ks: list[np.ndarray],
    resolution: int,
    progress: SubProgress,
) -> FusionResult:
    import open3d as o3d

    center, extent = estimate_extent(views, depths, Ks)
    if extent <= 0:
        from .errors import ReconError

        raise ReconError(
            "no_subject_found",
            "No consistent 3D surface could be recovered from the photos. Make sure the subject is well lit, "
            "textured and photographed from many overlapping angles.",
        )
    voxel = extent / float(resolution)
    trunc = 4.0 * voxel
    log.info("TSDF: extent %.4f, voxel %.5f (%d voxels across)", extent, voxel, resolution)
    vol = o3d.pipelines.integration.ScalableTSDFVolume(
        voxel_length=voxel,
        sdf_trunc=trunc,
        color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8,
    )
    for i, (v, d, K) in enumerate(zip(views, depths, Ks)):
        CANCEL.check()
        h, w = d.shape
        if not (d > 0).any():
            continue
        color = cv2.resize(v.image, (w, h), interpolation=cv2.INTER_AREA)
        # Clip depth to a generous range around the subject to avoid integrating far junk.
        dist_c = float(np.linalg.norm(v.center - center))
        dmax = dist_c + 1.0 * extent
        dd = np.where(d < dmax, d, 0).astype(np.float32)
        rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
            o3d.geometry.Image(np.ascontiguousarray(color)),
            o3d.geometry.Image(np.ascontiguousarray(dd)),
            depth_scale=1.0,
            depth_trunc=float(dmax),
            convert_rgb_to_intensity=False,
        )
        intr = o3d.camera.PinholeCameraIntrinsic(w, h, float(K[0, 0]), float(K[1, 1]), float(K[0, 2]), float(K[1, 2]))
        vol.integrate(rgbd, intr, v.w2c)
        progress.update(0.85 * (i + 1) / len(views), f"Fusing depth {i + 1}/{len(views)}")
    progress.update(0.88, "Extracting surface")
    mesh = vol.extract_triangle_mesh()
    pcd = vol.extract_point_cloud()
    pts = np.asarray(pcd.points)
    cols = np.asarray(pcd.colors)
    progress.update(1.0, f"Surface: {len(mesh.triangles)} triangles")
    if len(mesh.triangles) == 0:
        from .errors import ReconError

        raise ReconError(
            "no_subject_found",
            "The depth maps did not agree on a surface. Try more photos with more overlap, or 'scene' mode.",
        )
    return FusionResult(mesh=mesh, points=pts, colors=cols, voxel=voxel, extent=extent, center=center)


def depth_point_cloud(views: list[View], depths: list[np.ndarray], Ks: list[np.ndarray], max_points: int = 3_000_000) -> tuple[np.ndarray, np.ndarray]:
    """All filtered depth pixels back-projected to world space with their image colours."""
    pts, cols = [], []
    total = sum(int((d > 0).sum()) for d in depths)
    keep_p = min(1.0, max_points / max(total, 1))
    rng = np.random.default_rng(0)
    for v, d, K in zip(views, depths, Ks):
        X, idx = backproject(d, K, v.R, v.t)
        if keep_p < 1.0:
            sel = rng.random(len(idx)) < keep_p
            X, idx = X[sel], idx[sel]
        h, w = d.shape
        img = cv2.resize(v.image, (w, h), interpolation=cv2.INTER_AREA)
        pts.append(X)
        cols.append(img.reshape(-1, 3)[idx])
    if not pts:
        return np.zeros((0, 3)), np.zeros((0, 3), np.uint8)
    return np.concatenate(pts), np.concatenate(cols)
