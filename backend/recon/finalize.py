"""Shared final stage for every engine: normalisation, preview, exports, thumbnail, report."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .cleanup import Mesh, decimate, basic_clean, keep_main_components
from .config import JobConfig
from .export import write_glb, write_json, write_obj_zip, write_ply_points, write_png, write_usdz
from .geometry import Similarity
from .progress import SubProgress
from .render import render
from .runtime import CANCEL

log = logging.getLogger("recon")

PREVIEW_FACES = 10_000
PREVIEW_TEXTURE = 1024


def transform_mesh(mesh: Mesh, T: Similarity) -> Mesh:
    out = mesh.copy()
    out.V = T.apply(mesh.V)
    if np.linalg.det(T.R) < 0:  # keep winding consistent under reflections
        out.F = out.F[:, ::-1].copy()
    return out


def transfer_texture(src: Mesh, dst: Mesh, size: int) -> np.ndarray:
    """Bake ``src``'s texture (or vertex colours) onto UV-mapped ``dst`` via closest points."""
    import open3d as o3d

    from .render import _sample_texture
    from .texturing import push_pull_fill, rasterize_uv

    tex = rasterize_uv(dst, size)
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(src.V.astype(np.float32)), o3d.core.Tensor(src.F.astype(np.uint32)))
    ans = scene.compute_closest_points(o3d.core.Tensor(tex.P.astype(np.float32)))
    prim = ans["primitive_ids"].numpy().astype(np.int64)
    buv = ans["primitive_uvs"].numpy().astype(np.float64)
    b1, b2 = buv[:, 0:1], buv[:, 1:2]
    b0 = 1 - b1 - b2
    tri = src.F[prim]
    if src.UV is not None and src.texture is not None:
        uv = b0 * src.UV[tri[:, 0]] + b1 * src.UV[tri[:, 1]] + b2 * src.UV[tri[:, 2]]
        col = _sample_texture(src.texture, uv)[:, :3]
    elif src.C is not None:
        col = (b0 * src.C[tri[:, 0]] + b1 * src.C[tri[:, 1]] + b2 * src.C[tri[:, 2]]) * 255.0
    else:
        col = np.full((len(prim), 3), 180.0)
    img = np.zeros((size, size, 3), np.float32)
    valid = np.zeros((size, size), bool)
    img[tex.ys, tex.xs] = col
    valid[tex.ys, tex.xs] = True
    img = push_pull_fill(img, valid)
    return np.clip(img + 0.5, 0, 255).astype(np.uint8)


def make_preview(mesh: Mesh) -> Mesh:
    from .texturing import unwrap

    low = Mesh(mesh.V.copy(), mesh.F.copy(), None if mesh.C is None else mesh.C.copy())
    if low.n_faces > PREVIEW_FACES:
        # Decimation needs a welded mesh (UV seams split vertices).
        low = basic_clean(low)
        low = decimate(low, PREVIEW_FACES)
        low = keep_main_components(basic_clean(low), min_rel=0.05)
    uvm = unwrap(low, PREVIEW_TEXTURE)
    uvm.texture = transfer_texture(mesh, uvm, PREVIEW_TEXTURE)
    return uvm


@dataclass
class ExportInputs:
    mesh: Mesh  # final textured mesh in OUTPUT coordinates (Y-up, metres or normalised)
    points: np.ndarray | None  # dense point cloud in output coordinates
    point_colors: np.ndarray | None
    scale_source: str  # "metric_estimate" | "normalized" | "model"
    report: dict[str, Any] = field(default_factory=dict)


def export_all(job_dir: Path, cfg: JobConfig, inp: ExportInputs, progress: SubProgress, timings: dict[str, float]) -> tuple[list[dict[str, str]], dict[str, Any]]:
    out_dir = job_dir / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    artifacts: list[dict[str, str]] = []
    t0 = time.monotonic()

    def rel(p: Path) -> str:
        return str(p.relative_to(job_dir))

    mesh = inp.mesh
    # Always produce the GLB: the viewer and preview depend on it.
    progress.update(0.05, "Writing GLB")
    glb = out_dir / "model.glb"
    write_glb(mesh, glb)
    artifacts.append({"kind": "glb", "path": rel(glb)})
    CANCEL.check()

    if "obj" in cfg.formats:
        progress.update(0.2, "Writing OBJ")
        p = out_dir / "model_obj.zip"
        write_obj_zip(mesh, p)
        artifacts.append({"kind": "obj_zip", "path": rel(p)})
    if "ply" in cfg.formats:
        progress.update(0.3, "Writing point cloud")
        p = out_dir / "pointcloud.ply"
        if inp.points is not None and len(inp.points):
            write_ply_points(inp.points, inp.point_colors, p)
        else:  # generative engine: sample the surface
            write_ply_points(*_sample_surface(mesh, 200_000), p)
        artifacts.append({"kind": "ply", "path": rel(p)})
    if "usdz" in cfg.formats:
        progress.update(0.4, "Writing USDZ")
        p = out_dir / "model.usdz"
        try:
            if write_usdz(mesh, p):
                artifacts.append({"kind": "usdz", "path": rel(p)})
        except Exception as e:
            log.warning("USDZ export failed (%s); skipping", e)
    CANCEL.check()

    progress.update(0.5, "Building preview model")
    try:
        prev = make_preview(mesh)
        p = out_dir / "preview.glb"
        write_glb(prev, p)
        artifacts.append({"kind": "preview", "path": rel(p)})
    except Exception as e:
        log.warning("Preview generation failed (%s)", e)

    progress.update(0.75, "Rendering thumbnail")
    p = out_dir / "thumbnail.png"
    write_png(render(mesh, size=512), p)
    artifacts.append({"kind": "thumbnail", "path": rel(p)})

    timings["export"] = round(time.monotonic() - t0, 3)
    lo, hi = mesh.V.min(0), mesh.V.max(0)
    size = (hi - lo).tolist()
    unit = "m" if inp.scale_source in ("metric_estimate", "model_metric") else "normalized"
    metrics: dict[str, Any] = {
        **{k: v for k, v in inp.report.get("metrics", {}).items()},
        "faces": int(mesh.n_faces),
        "vertices": int(len(mesh.V)),
        "texture_size": int(mesh.texture.shape[0]) if mesh.texture is not None else 0,
        "bbox_size": [round(float(x), 4) for x in size],
        "bbox_unit": unit,
        "scale_source": inp.scale_source,
    }
    report = {
        "engine": cfg.engine,
        "config": cfg.to_dict(),
        "metrics": metrics,
        "timings_s": timings,
        **{k: v for k, v in inp.report.items() if k != "metrics"},
        "artifacts": artifacts + [{"kind": "report", "path": "output/report.json"}],
    }
    p = out_dir / "report.json"
    write_json(report, p)
    artifacts.append({"kind": "report", "path": rel(p)})
    progress.update(1.0, "Exported")
    return artifacts, metrics


def _sample_surface(mesh: Mesh, n: int) -> tuple[np.ndarray, np.ndarray | None]:
    import trimesh

    from .render import _sample_texture

    tm = trimesh.Trimesh(mesh.V, mesh.F, process=False)
    pts, fidx = trimesh.sample.sample_surface(tm, n, seed=0)
    cols = None
    if mesh.UV is not None and mesh.texture is not None:
        bary = trimesh.triangles.points_to_barycentric(tm.triangles[fidx], pts)
        tri = mesh.F[fidx]
        uv = (bary[:, 0:1] * mesh.UV[tri[:, 0]] + bary[:, 1:2] * mesh.UV[tri[:, 1]] + bary[:, 2:3] * mesh.UV[tri[:, 2]])
        cols = np.clip(_sample_texture(mesh.texture, uv)[:, :3], 0, 255).astype(np.uint8)
    return np.asarray(pts), cols
