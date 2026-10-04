"""Dense depth with COLMAP PatchMatch MVS (CUDA builds of pycolmap only).

UNTESTED HERE: the development machine has no GPU and the PyPI pycolmap wheel is CPU-only
(``pycolmap.has_cuda == False``). With a CUDA build this replaces Depth Anything 3: PatchMatch
geometric depth maps are metric-consistent multi-view stereo, sharper on well-textured surfaces.
The resulting depth maps go through the same masking, TSDF fusion and cleanup as the CPU path.
"""

from __future__ import annotations

import logging
from pathlib import Path

import cv2
import numpy as np

from ..config import Preset
from ..data import DepthResult, View
from ..progress import SubProgress
from ..runtime import CANCEL

log = logging.getLogger("recon")


def read_colmap_array(path: Path) -> np.ndarray:
    """Read COLMAP's ``.bin`` dense array format: ``w&h&c&`` text header + float32 data (column-major)."""
    with open(path, "rb") as f:
        header = b""
        amp = 0
        while amp < 3:
            ch = f.read(1)
            if not ch:
                raise ValueError("truncated header")
            header += ch
            if ch == b"&":
                amp += 1
        w, h, c = (int(x) for x in header.decode().strip("&").split("&"))
        data = np.frombuffer(f.read(), dtype=np.float32)
    # Same layout as COLMAP's scripts/python/read_write_dense.py (Fortran order, then transpose).
    arr = data.reshape((w, h, c), order="F").transpose(1, 0, 2)
    return np.ascontiguousarray(arr[..., 0] if c == 1 else arr)


def write_colmap_array(arr: np.ndarray, path: Path) -> None:
    """Inverse of :func:`read_colmap_array` (used by tests)."""
    a = np.asarray(arr, np.float32)
    h, w = a.shape[:2]
    c = 1 if a.ndim == 2 else a.shape[2]
    with open(path, "wb") as f:
        f.write(f"{w}&{h}&{c}&".encode())
        a3 = a.reshape(h, w, c).transpose(1, 0, 2)  # -> (w, h, c)
        f.write(a3.astype("<f4").tobytes(order="F"))


def patchmatch_depths(work: Path, views: list[View], preset: Preset, progress: SubProgress, use_masks: bool) -> DepthResult:
    import pycolmap

    if not getattr(pycolmap, "has_cuda", False):
        raise RuntimeError("pycolmap was built without CUDA")
    sfm_dir = work / "sfm"
    rec_dirs = sorted(p for p in sfm_dir.rglob("cameras.bin"))
    if not rec_dirs:
        raise RuntimeError("no sparse model on disk")
    # The mapper wrote one sub-directory per model; use the one with the most images.
    best = max((p.parent for p in rec_dirs), key=lambda d: pycolmap.Reconstruction(str(d)).num_reg_images())
    mvs = work / "mvs"
    progress.update(0.02, "Undistorting images for MVS")
    pycolmap.undistort_images(str(mvs), str(best), str(work / "images"))
    opts = pycolmap.PatchMatchOptions()
    opts.max_image_size = max(1000, preset.max_image_side)
    opts.geom_consistency = True
    opts.filter = True
    token = pycolmap.CancellationToken()
    from ..runtime import CANCEL as C

    unhook = C.add_native_hook(token.cancel)
    try:
        progress.update(0.05, "PatchMatch stereo (GPU)")
        pycolmap.patch_match_stereo(str(mvs), options=opts, cancellation_token=token)
    finally:
        unhook()
    rec = pycolmap.Reconstruction(str(mvs / "sparse"))
    by_name = {im.name: im for im in rec.images.values()}
    depths, Ks, confs = [], [], []
    for i, v in enumerate(views):
        CANCEL.check()
        im = by_name.get(v.name)
        p = mvs / "stereo" / "depth_maps" / f"{v.name}.geometric.bin"
        if im is None or not p.exists():
            depths.append(np.zeros((v.height, v.width), np.float32))
            Ks.append(v.K.copy())
            confs.append(np.zeros((v.height, v.width), np.float32))
            continue
        d = read_colmap_array(p)
        cam = rec.cameras[im.camera_id]
        K = cam.calibration_matrix().copy()
        K[0, 2] -= 0.5
        K[1, 2] -= 0.5
        # Undistorted MVS images can differ in size from our views; rescale K to the depth map.
        h, w = d.shape
        if (w, h) != (cam.width, cam.height):
            sx, sy = w / cam.width, h / cam.height
            K[0, :] *= sx
            K[1, :] *= sy
        if use_masks and v.mask is not None:
            m = cv2.resize(v.mask, (w, h), interpolation=cv2.INTER_LINEAR) > 0.5
            d = np.where(m, d, 0)
        depths.append(d.astype(np.float32))
        Ks.append(K)
        confs.append((d > 0).astype(np.float32))
        progress.update(0.8 + 0.2 * (i + 1) / len(views))
    return DepthResult(depths=depths, confidences=confs, intrinsics=Ks, model="colmap-patchmatch", alignment_error=float("nan"))

