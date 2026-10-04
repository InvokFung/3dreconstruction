"""``--capabilities``: cheap probe of which engines can run here (no model loading)."""

from __future__ import annotations

import importlib.util
from typing import Any


def _has(mod: str) -> bool:
    try:
        return importlib.util.find_spec(mod) is not None
    except (ImportError, ValueError):
        return False


def _cuda() -> tuple[bool, str | None]:
    if not _has("torch"):
        return False, None
    try:
        import torch

        if torch.cuda.is_available():
            p = torch.cuda.get_device_properties(0)
            return True, f"{p.name} ({p.total_memory / 1024**3:.0f} GB)"
    except Exception:
        pass
    return False, None


def capabilities() -> dict[str, Any]:
    cuda, gpu = _cuda()
    device = "cuda" if cuda else "cpu"

    missing = [m for m in ("pycolmap", "open3d", "trimesh", "xatlas", "cv2", "torch") if not _has(m)]
    if missing:
        photo: dict[str, Any] = {"available": False, "reason": f"Missing Python packages: {', '.join(missing)}"}
    else:
        notes = ["SfM: COLMAP incremental mapper with ALIKED+LightGlue matching"]
        colmap_cuda = False
        try:
            import pycolmap

            colmap_cuda = bool(getattr(pycolmap, "has_cuda", False))
        except Exception:
            pass
        if cuda and colmap_cuda:
            notes.append("dense: COLMAP PatchMatch MVS (CUDA)")
        else:
            notes.append(
                "dense: Depth Anything 3 pose-conditioned depth + TSDF fusion"
                + ("" if _has("depth_anything_3") else " (DA3 not installed: Depth Anything V2 fallback)")
            )
        notes.append("texture: multi-view baked atlas")
        if not cuda:
            notes.append("CPU only: expect ~3-6 min (draft) to 10-30 min (high) for ~20 photos")
        photo = {"available": True, "notes": "; ".join(notes)}

    from .engines.generative import availability

    gen = availability(cuda)
    return {
        "engines": {"photogrammetry": photo, "generative": gen},
        "device": device,
        **({"gpu": gpu} if gpu else {}),
    }
