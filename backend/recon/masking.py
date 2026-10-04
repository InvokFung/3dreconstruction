"""Foreground (subject) segmentation for object mode.

Primary model: BiRefNet-lite (MIT) via ``transformers`` remote code pinned to a commit.
Fallback: ``rembg`` (IS-Net) when installed. If neither is available the pipeline continues
without masks and relies on geometric cleanup only.
"""

from __future__ import annotations

import logging
from typing import Callable, Protocol

import cv2
import numpy as np

from .errors import ReconError

log = logging.getLogger("recon")

_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


class Segmenter(Protocol):
    name: str

    def __call__(self, rgb: np.ndarray) -> np.ndarray:  # returns HxW float32 in [0,1]
        ...


class BiRefNetSegmenter:
    name = "birefnet-lite"

    def __init__(self, resolution: int, device: str) -> None:
        import torch
        from transformers import AutoModelForImageSegmentation

        from .models import BIREFNET_REPO, BIREFNET_REVISION

        self.torch = torch
        self.device = device
        self.res = int(resolution) // 32 * 32
        self.model = AutoModelForImageSegmentation.from_pretrained(
            BIREFNET_REPO, revision=BIREFNET_REVISION, trust_remote_code=True
        )
        self.model.eval().to(device)
        if device == "cuda":
            self.model.half()

    def __call__(self, rgb: np.ndarray) -> np.ndarray:
        torch = self.torch
        h, w = rgb.shape[:2]
        x = cv2.resize(rgb, (self.res, self.res), interpolation=cv2.INTER_AREA if max(h, w) > self.res else cv2.INTER_CUBIC)
        x = (x.astype(np.float32) / 255.0 - _MEAN) / _STD
        t = torch.from_numpy(x.transpose(2, 0, 1)[None].copy()).to(self.device)
        if self.device == "cuda":
            t = t.half()
        with torch.inference_mode():
            out = self.model(t)[-1].sigmoid()[0, 0].float().cpu().numpy()
        return cv2.resize(out, (w, h), interpolation=cv2.INTER_LINEAR).clip(0, 1)


class RembgSegmenter:
    name = "rembg-isnet"

    def __init__(self) -> None:
        import rembg

        self._rembg = rembg
        self.session = rembg.new_session("isnet-general-use")

    def __call__(self, rgb: np.ndarray) -> np.ndarray:
        from PIL import Image

        m = self._rembg.remove(Image.fromarray(rgb), session=self.session, only_mask=True)
        a = np.asarray(m, dtype=np.float32) / 255.0
        if a.shape[:2] != rgb.shape[:2]:
            a = cv2.resize(a, (rgb.shape[1], rgb.shape[0]))
        return a


def load_segmenter(resolution: int, device: str) -> Segmenter | None:
    try:
        return BiRefNetSegmenter(resolution, device)
    except Exception as e:
        log.warning("BiRefNet unavailable (%s); trying rembg", e)
    try:
        return RembgSegmenter()
    except Exception as e:
        log.warning("rembg unavailable (%s); continuing without subject masks", e)
    return None


def refine_mask(prob: np.ndarray, min_rel_area: float = 0.15) -> np.ndarray:
    """Threshold + clean a soft mask: keep the main blob(s), fill small holes.

    Returns a float32 mask in [0,1] that keeps soft edges inside the kept components.
    """
    h, w = prob.shape
    binary = (prob > 0.5).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    if n <= 1:
        return np.zeros_like(prob, dtype=np.float32)
    areas = stats[1:, cv2.CC_STAT_AREA]
    biggest = areas.max()
    keep_ids = 1 + np.flatnonzero(areas >= min_rel_area * biggest)
    keep = np.isin(labels, keep_ids).astype(np.uint8)
    # Fill holes smaller than 2% of the subject area (labels, specular highlights...).
    inv = (1 - keep).astype(np.uint8)
    n2, lab2, st2, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    for i in range(1, n2):
        x, y, bw, bh, area = st2[i]
        touches_border = x == 0 or y == 0 or x + bw >= w or y + bh >= h
        if not touches_border and area < 0.02 * keep.sum():
            keep[lab2 == i] = 1
    soft = np.where(keep > 0, np.maximum(prob, 0.5), 0.0).astype(np.float32)
    return soft


def mask_stats(mask: np.ndarray) -> tuple[float, bool]:
    """(foreground area fraction, touches the image border on >= 3 sides)."""
    m = mask > 0.5
    frac = float(m.mean())
    sides = int(m[0].any()) + int(m[-1].any()) + int(m[:, 0].any()) + int(m[:, -1].any())
    return frac, sides >= 3


def compute_masks(
    images: list[np.ndarray],
    resolution: int,
    device: str,
    progress: Callable[[float, str | None], None] | None = None,
    cancel: Callable[[], None] | None = None,
) -> tuple[list[np.ndarray] | None, str | None]:
    """Segment the subject in every image. Returns (masks or None, model name)."""
    seg = load_segmenter(resolution, device)
    if seg is None:
        return None, None
    masks: list[np.ndarray] = []
    for i, rgb in enumerate(images):
        if cancel:
            cancel()
        masks.append(refine_mask(seg(rgb)))
        if progress:
            progress((i + 1) / len(images), f"Isolated subject in {i + 1}/{len(images)} images")
    fracs = [mask_stats(m)[0] for m in masks]
    good = sum(1 for f in fracs if 0.003 < f < 0.97)
    if good < max(2, 0.5 * len(masks)):
        raise ReconError(
            "no_subject_found",
            "Could not find a clear subject in most photos. Make sure the object is fully visible and "
            "stands out from the background, or switch to 'scene' mode.",
        )
    return masks, seg.name
