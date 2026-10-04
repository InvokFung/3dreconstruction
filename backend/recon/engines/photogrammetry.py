"""Photogrammetry engine: photos/video -> SfM -> dense depth -> TSDF -> cleanup -> texture -> export.

Runs fully on CPU. With a CUDA build of pycolmap and ``device`` cuda/auto, dense depth comes from
COLMAP PatchMatch MVS (see ``colmap_mvs``) instead of Depth Anything 3.
"""

from __future__ import annotations

import logging
import shutil
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from ..cleanup import basic_clean, cleanup_mesh, estimate_up, from_o3d, normalization_transform, sparse_roi
from ..config import JobConfig
from ..depth import compute_depths
from ..errors import ReconError
from ..finalize import ExportInputs, export_all, transform_mesh
from ..fusion import depth_point_cloud, tsdf_fuse
from ..ingest import ingest, load_rgb
from ..masking import compute_masks
from ..progress import Progress
from ..runtime import CANCEL
from ..sfm import run_sfm
from ..texturing import texture_mesh

log = logging.getLogger("recon")

PLAN = [
    ("ingest", 3),
    ("masking", 8),
    ("sfm", 22),
    ("depth", 20),
    ("fusion", 7),
    ("meshing", 2),
    ("cleanup", 5),
    ("texturing", 22),
    ("export", 11),
]


def run(job_dir: Path, cfg: JobConfig, progress: Progress, device: str) -> tuple[list[dict[str, str]], dict[str, Any]]:
    preset = cfg.preset
    object_mode = cfg.mode == "object"
    work = Path(tempfile.mkdtemp(prefix="recon-"))
    CANCEL.on_cancel(lambda: shutil.rmtree(work, ignore_errors=True))
    report: dict[str, Any] = {"metrics": {}}
    try:
        # ---- ingest ---------------------------------------------------------------------
        progress.stage("ingest", "Reading photos")
        ing = ingest(job_dir / "input", work, preset, min_images=3, progress=lambda f, m: progress.update(f, m), cancel=CANCEL.check)
        frames = ing.frames
        report["input"] = {
            "images": ing.inputs_images,
            "videos": ing.inputs_videos,
            "frames_used": len(frames),
            "dropped_blurry": ing.dropped_blurry,
            "dropped_duplicates": ing.dropped_duplicates,
            "unreadable": ing.unreadable,
            "ordering": ing.ordered,
        }
        if len(frames) < 8:
            log.warning("Only %d usable images; 20+ overlapping photos give much better results", len(frames))

        # ---- masking --------------------------------------------------------------------
        masks: dict[str, np.ndarray] | None = None
        if object_mode:
            progress.stage("masking", "Isolating the subject")
            imgs = [load_rgb(f.path) for f in frames]
            # Many (video) frames: cap the segmentation resolution to bound CPU time.
            mres = preset.mask_resolution if len(frames) <= 60 or device == "cuda" else min(preset.mask_resolution, 640 if len(frames) <= 100 else 512)
            mlist, mname = compute_masks(imgs, mres, device, progress=lambda f, m: progress.update(f, m), cancel=CANCEL.check)
            del imgs
            if mlist is not None:
                masks = {f.name: m for f, m in zip(frames, mlist)}
            report["masking_model"] = mname

        # ---- SfM ------------------------------------------------------------------------
        progress.stage("sfm", "Aligning photos")
        sfm = run_sfm(frames, ing.image_dir, work, preset, device, progress.sub(0.0, 1.0), ordered=True, masks=masks)
        views = sfm.views
        progress.message(f"Registered {sfm.num_registered}/{sfm.num_input} images")
        report["sfm"] = {
            "matcher": sfm.matcher,
            "sequential_pairs": sfm.sequential,
            "camera_model": sfm.camera_model,
            "timings_s": sfm.timings,
        }
        report["metrics"].update(
            {
                "images_in": ing.inputs_images + ing.inputs_videos,
                "images_used": len(frames),
                "registered_images": sfm.num_registered,
                "reprojection_error": round(sfm.mean_reprojection_error, 3),
                "sparse_points": int(len(sfm.points_xyz)),
            }
        )

        # ---- dense depth ----------------------------------------------------------------
        progress.stage("depth", "Estimating depth")
        dense = None
        if device == "cuda":
            try:
                from .colmap_mvs import patchmatch_depths

                dense = patchmatch_depths(work, views, preset, progress.sub(0.0, 1.0), use_masks=object_mode)
            except Exception as e:
                if isinstance(e, ReconError) or type(e).__name__ == "Cancelled":
                    raise
                log.warning("PatchMatch MVS unavailable (%s); using learned depth", e)
        if dense is None:
            dense = compute_depths(
                views,
                preset.depth_model,
                preset.depth_resolution,
                preset.depth_chunk,
                device,
                use_masks=object_mode and masks is not None,
                progress=progress.sub(0.0, 1.0),
            )
        report["depth"] = {"model": dense.model, "alignment_error": round(dense.alignment_error, 5) if np.isfinite(dense.alignment_error) else None}

        # ---- fusion ---------------------------------------------------------------------
        progress.stage("fusion", "Fusing depth maps")
        fused = tsdf_fuse(views, dense.depths, dense.intrinsics, preset.tsdf_resolution, progress.sub(0.0, 1.0))
        del dense.confidences

        progress.stage("meshing", "Building mesh")
        mesh = basic_clean(from_o3d(fused.mesh))
        progress.update(1.0, f"Raw mesh: {mesh.n_faces} triangles")

        # ---- cleanup --------------------------------------------------------------------
        progress.stage("cleanup", "Cleaning up the mesh")
        up, plane = estimate_up(views, sfm.points_xyz, fused.extent, fused.center, object_mode)
        roi = None if object_mode else sparse_roi(sfm.points_xyz, sfm.points_err)
        mesh = cleanup_mesh(mesh, views, object_mode, plane, fused.voxel, fused.extent, cfg.target_faces, roi=roi)
        progress.update(1.0, f"Clean mesh: {mesh.n_faces} triangles")

        # Dense colored point cloud restricted to the final surface.
        dp, dc = depth_point_cloud(views, dense.depths, dense.intrinsics)
        pts, cols = _surface_points(dp, dc, mesh, 2.0 * fused.voxel)

        # ---- texturing ------------------------------------------------------------------
        progress.stage("texturing", "Texturing")
        tmesh, bake = texture_mesh(
            mesh, views, cfg.texture_size, preset.texture_views_topk, preset.exposure_compensation, progress.sub(0.0, 1.0),
            chart_iterations=0 if cfg.quality == "draft" else 1,
        )
        report["texture"] = {
            "size": cfg.texture_size,
            "seen_fraction": round(bake.seen_fraction, 4),
            "views_used": bake.views_used,
            "uv_utilization": tmesh.meta.get("uv_utilization"),
        }

        # ---- normalise + export ---------------------------------------------------------
        progress.stage("export", "Exporting")
        T, scale_source = normalization_transform(tmesh.V, up, views, dense.metric_scale, object_mode)
        out_mesh = transform_mesh(tmesh, T)
        out_pts = T.apply(pts) if len(pts) else pts
        report["metrics"]["dense_points"] = int(len(out_pts))
        report["transform"] = {"sfm_to_output": T.matrix().round(8).tolist(), "metric_scale_m_per_unit": dense.metric_scale}
        report["notes"] = _quality_notes(sfm.num_registered, sfm.num_input, bake.seen_fraction, len(frames))
        artifacts, metrics = export_all(
            job_dir,
            cfg,
            ExportInputs(mesh=out_mesh, points=out_pts, point_colors=cols, scale_source=scale_source, report=report),
            progress.sub(0.0, 1.0),
            progress.timings,
        )
        return artifacts, metrics
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _surface_points(points: np.ndarray, colors: np.ndarray, mesh, max_dist: float, max_points: int = 2_000_000):  # type: ignore[no-untyped-def]
    if len(points) == 0:
        return points, colors
    import open3d as o3d

    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(mesh.V.astype(np.float32)), o3d.core.Tensor(mesh.F.astype(np.uint32)))
    d = scene.compute_distance(o3d.core.Tensor(points.astype(np.float32))).numpy()
    keep = d < max_dist
    points, colors = points[keep], colors[keep]
    if len(points) > max_points:
        idx = np.random.default_rng(0).choice(len(points), max_points, replace=False)
        points, colors = points[idx], colors[idx]
    return points, colors


def _quality_notes(nreg: int, n: int, seen: float, nframes: int) -> list[str]:
    notes = []
    if nframes < 20:
        notes.append("Few photos were provided; 30-60 overlapping photos from all around (including higher and lower angles) give more complete models.")
    if nreg < 0.85 * n:
        notes.append(f"{n - nreg} photos could not be aligned and were ignored.")
    if seen < 0.85:
        notes.append(f"{100 * (1 - seen):.0f}% of the surface was not visible in any photo (e.g. the underside); its colour was extrapolated.")
    return notes

