"""Generative engine: single/few image(s) -> textured mesh with an open-source image-to-3D model.

UNTESTED IN THIS REPOSITORY'S CI: both backends need an NVIDIA GPU (>= 24 GB recommended) plus
their CUDA-only packages, neither of which exist on the CPU development machine. The code
follows the published APIs (checked October 2026) and is isolated here so failures cannot affect
the photogrammetry engine; the output goes through the same normalisation/export stage.

Backends, in order of preference:

1. **TRELLIS.2** (microsoft/TRELLIS.2-4B, MIT). ``trellis2`` + ``o_voxel`` packages from
   https://github.com/microsoft/TRELLIS.2 (custom CUDA extensions: flex_gemm, cumesh,
   nvdiffrast). Produces PBR-textured meshes via ``o_voxel.postprocess.to_glb``.
2. **Hunyuan3D-2** (tencent/Hunyuan3D-2, Tencent Hunyuan Community License - not usable in the
   EU/UK/South Korea). ``hy3dgen`` package: DiT flow-matching shape model + paint pipeline.

Input selection: the sharpest image with the largest, uncut subject mask. Background removal is
done with the same BiRefNet model as photogrammetry (RGBA input).
"""

from __future__ import annotations

import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from ..cleanup import Mesh, basic_clean, keep_main_components
from ..config import JobConfig
from ..errors import ReconError
from ..finalize import ExportInputs, export_all
from ..geometry import Similarity
from ..progress import Progress
from ..runtime import CANCEL

log = logging.getLogger("recon")

PLAN = [("ingest", 3), ("masking", 5), ("generate", 70), ("cleanup", 5), ("export", 17)]

TRELLIS_REPO = "microsoft/TRELLIS.2-4B"
HUNYUAN_REPO = "tencent/Hunyuan3D-2"
MIN_VRAM_GB = 16


def _has(mod: str) -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec(mod) is not None
    except (ImportError, ValueError):
        return False


def _backend() -> str | None:
    if _has("trellis2") and _has("o_voxel"):
        return "trellis2"
    if _has("hy3dgen"):
        return "hunyuan3d-2"
    return None


def availability(cuda: bool) -> dict[str, Any]:
    if not cuda:
        return {"available": False, "reason": "No CUDA GPU (image-to-3D models need an NVIDIA GPU with 16+ GB VRAM)"}
    b = _backend()
    if b is None:
        return {
            "available": False,
            "reason": "No image-to-3D package installed (install TRELLIS.2 or hy3dgen; see backend/recon/requirements-gpu.txt)",
        }
    try:
        import torch

        vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
        if vram < MIN_VRAM_GB:
            return {"available": False, "reason": f"GPU has {vram:.0f} GB VRAM; {MIN_VRAM_GB}+ GB required"}
    except Exception:
        pass
    return {"available": True, "notes": f"{b}: single-image generation (best photo is used); geometry of unseen sides is hallucinated"}


def _pick_input(job_dir: Path, cfg: JobConfig, progress: Progress, device: str) -> tuple[np.ndarray, Any]:
    """Return (RGBA uint8 image of the subject, ingest info)."""
    from ..ingest import ingest, load_rgb
    from ..masking import load_segmenter, mask_stats, refine_mask

    work = Path(tempfile.mkdtemp(prefix="recon-gen-"))
    try:
        progress.stage("ingest", "Reading photos")
        ing = ingest(job_dir / "input", work, cfg.preset, min_images=1, progress=lambda f, m: progress.update(f, m), cancel=CANCEL.check)
        progress.stage("masking", "Isolating the subject")
        seg = load_segmenter(1024, device)
        best, best_score, best_rgba = None, -1.0, None
        cand = ing.frames
        if len(cand) > 12:  # evaluate a spread of frames only
            cand = [cand[i] for i in np.linspace(0, len(cand) - 1, 12).round().astype(int)]
        for k, fr in enumerate(cand):
            CANCEL.check()
            rgb = load_rgb(fr.path)
            m = refine_mask(seg(rgb)) if seg is not None else np.ones(rgb.shape[:2], np.float32)
            frac, cut = mask_stats(m)
            score = (0.0 if cut else 1.0) * min(frac, 0.5) * np.log1p(fr.sharpness)
            if score > best_score:
                best, best_score = fr, score
                best_rgba = np.dstack([rgb, (m * 255).astype(np.uint8)])
            progress.update((k + 1) / len(cand))
        if best_rgba is None or best_score <= 0:
            raise ReconError("no_subject_found", "No photo shows the whole subject clearly. Use a photo where the object is fully in frame.")
        log.info("Generative input: %s", best.source if best else "?")
        return _crop_square(best_rgba), ing
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _crop_square(rgba: np.ndarray, margin: float = 0.12) -> np.ndarray:
    ys, xs = np.nonzero(rgba[..., 3] > 127)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    side = int(max(y1 - y0, x1 - x0) * (1 + 2 * margin))
    cy, cx = (y0 + y1) // 2, (x0 + x1) // 2
    out = np.zeros((side, side, 4), np.uint8)
    sy, sx = cy - side // 2, cx - side // 2
    h, w = rgba.shape[:2]
    a0, a1 = max(0, sy), min(h, sy + side)
    b0, b1 = max(0, sx), min(w, sx + side)
    out[a0 - sy : a1 - sy, b0 - sx : b1 - sx] = rgba[a0:a1, b0:b1]
    return out


def _run_trellis2(image_rgba: np.ndarray, cfg: JobConfig, out_glb: Path) -> None:
    """UNTESTED (needs CUDA). Follows the TRELLIS.2-4B model card example."""
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    import o_voxel  # type: ignore[import-not-found]
    from PIL import Image
    from trellis2.pipelines import Trellis2ImageTo3DPipeline  # type: ignore[import-not-found]

    pipe = Trellis2ImageTo3DPipeline.from_pretrained(TRELLIS_REPO)
    pipe.cuda()
    mesh = pipe.run(Image.fromarray(image_rgba, "RGBA"), seed=cfg.seed)[0]
    mesh.simplify(16_777_216)  # nvdiffrast limit, per upstream example
    glb = o_voxel.postprocess.to_glb(
        vertices=mesh.vertices,
        faces=mesh.faces,
        attr_volume=mesh.attrs,
        coords=mesh.coords,
        attr_layout=mesh.layout,
        voxel_size=mesh.voxel_size,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=int(cfg.target_faces),
        texture_size=int(cfg.texture_size),
        remesh=True,
        remesh_band=1,
        remesh_project=0,
        verbose=False,
    )
    glb.export(str(out_glb))  # plain PNG textures (no WebP extension) for maximum compatibility


def _run_hunyuan(image_rgba: np.ndarray, cfg: JobConfig, out_glb: Path) -> None:
    """UNTESTED (needs CUDA). Hunyuan3D-2 shape + paint pipelines (``hy3dgen``)."""
    from PIL import Image
    from hy3dgen.shapegen import FaceReducer, FloaterRemover, DegenerateFaceRemover, Hunyuan3DDiTFlowMatchingPipeline  # type: ignore[import-not-found]
    from hy3dgen.texgen import Hunyuan3DPaintPipeline  # type: ignore[import-not-found]

    import torch

    img = Image.fromarray(image_rgba, "RGBA")
    shape = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(HUNYUAN_REPO)
    mesh = shape(image=img, num_inference_steps=50, octree_resolution=380, generator=torch.manual_seed(cfg.seed))[0]
    mesh = FloaterRemover()(mesh)
    mesh = DegenerateFaceRemover()(mesh)
    mesh = FaceReducer()(mesh, max_facenum=int(cfg.target_faces))
    del shape
    torch.cuda.empty_cache()
    paint = Hunyuan3DPaintPipeline.from_pretrained(HUNYUAN_REPO)
    mesh = paint(mesh, image=img)
    mesh.export(str(out_glb))


def _load_glb(path: Path) -> Mesh:
    import trimesh

    scene = trimesh.load(str(path), force="scene")
    meshes = [g for g in scene.dump() if isinstance(g, trimesh.Trimesh)] if hasattr(scene, "dump") else [scene]
    if not meshes:
        raise ReconError("internal", "The generative model produced no geometry.")
    tm = max(meshes, key=lambda m: len(m.faces))
    V = np.asarray(tm.vertices, np.float64)
    F = np.asarray(tm.faces, np.int64)
    uv, tex = None, None
    vis = tm.visual
    if getattr(vis, "uv", None) is not None and getattr(vis, "material", None) is not None:
        mat = vis.material
        img = getattr(mat, "baseColorTexture", None) or getattr(mat, "image", None)
        if img is not None:
            uv = np.asarray(vis.uv, np.float64)
            tex = np.asarray(img.convert("RGB"))
    C = None
    if tex is None and hasattr(vis, "vertex_colors"):
        C = np.asarray(vis.vertex_colors)[:, :3] / 255.0
    return Mesh(V, F, C, uv, tex)


def run(job_dir: Path, cfg: JobConfig, progress: Progress, device: str) -> tuple[list[dict[str, str]], dict[str, Any]]:
    if device != "cuda":
        raise ReconError("engine_unavailable", "The generative engine needs an NVIDIA GPU, which this server does not have. Use the photogrammetry engine.")
    backend = _backend()
    if backend is None:
        raise ReconError("engine_unavailable", "No image-to-3D model is installed on this server. Use the photogrammetry engine.")
    rgba, ing = _pick_input(job_dir, cfg, progress, device)

    progress.stage("generate", f"Generating 3D model ({backend})")
    work = Path(tempfile.mkdtemp(prefix="recon-gen-"))
    try:
        out = work / "gen.glb"
        try:
            if backend == "trellis2":
                _run_trellis2(rgba, cfg, out)
            else:
                _run_hunyuan(rgba, cfg, out)
        except Exception as e:
            from ..errors import is_oom

            if is_oom(e):
                raise ReconError("out_of_memory", "The GPU ran out of memory. Try a smaller texture size or fewer target faces.") from e
            raise
        CANCEL.check()
        progress.update(1.0, "Generated")
        progress.stage("cleanup", "Cleaning up")
        mesh = _load_glb(out)
        if mesh.UV is None:
            mesh = keep_main_components(basic_clean(mesh), min_rel=0.1)
        # Generators output Y-up meshes in a unit cube; put the base at y = 0 and keep the size
        # normalised (no metric information from a single image).
        lo, hi = mesh.V.min(0), mesh.V.max(0)
        s = 1.0 / max(float(np.linalg.norm(hi - lo)), 1e-9)
        T = Similarity(s=s, R=np.eye(3), t=-s * np.array([0.5 * (lo[0] + hi[0]), lo[1], 0.5 * (lo[2] + hi[2])]))
        mesh.V = T.apply(mesh.V)
        if mesh.texture is None:
            from ..texturing import unwrap
            from ..finalize import transfer_texture

            uvm = unwrap(mesh, cfg.texture_size)
            uvm.texture = transfer_texture(mesh, uvm, cfg.texture_size)
            mesh = uvm
        progress.stage("export", "Exporting")
        report = {
            "metrics": {"images_in": ing.inputs_images + ing.inputs_videos, "images_used": 1, "registered_images": 0},
            "generative": {"backend": backend},
            "notes": ["Generated from a single photo: hidden sides are plausible guesses, and the size is normalised (not metric)."],
        }
        return export_all(job_dir, cfg, ExportInputs(mesh=mesh, points=None, point_colors=None, scale_source="normalized", report=report), progress.sub(0.0, 1.0), progress.timings)
    finally:
        shutil.rmtree(work, ignore_errors=True)
