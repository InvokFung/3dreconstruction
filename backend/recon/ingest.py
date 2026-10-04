"""Input ingestion: photos (incl. HEIC, EXIF orientation), videos -> sharp frames, filtering."""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
from PIL import Image, ImageOps

from .config import Preset
from .data import Frame, IngestResult
from .errors import ReconError

log = logging.getLogger("recon")

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".bmp", ".tif", ".tiff"}
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"}

_heif_registered = False


def _register_heif() -> bool:
    global _heif_registered
    if _heif_registered:
        return True
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
        _heif_registered = True
    except Exception:  # optional dependency
        _heif_registered = False
    return _heif_registered


def natural_key(s: str) -> list[object]:
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def list_inputs(input_dir: Path) -> tuple[list[Path], list[Path], list[Path]]:
    images, videos, other = [], [], []
    if not input_dir.is_dir():
        return images, videos, other
    for p in sorted(input_dir.rglob("*"), key=lambda q: natural_key(str(q.relative_to(input_dir)))):
        if not p.is_file() or any(part.startswith(".") for part in p.relative_to(input_dir).parts):
            continue
        ext = p.suffix.lower()
        if ext in IMAGE_EXTS:
            images.append(p)
        elif ext in VIDEO_EXTS:
            videos.append(p)
        else:
            other.append(p)
    return images, videos, other


# ---------------------------------------------------------------------------------------------
# Image helpers (pure; unit-tested)
# ---------------------------------------------------------------------------------------------


def sharpness(gray: np.ndarray, max_side: int = 640) -> float:
    """Variance of the Laplacian at a normalised resolution (resolution-independent blur score)."""
    h, w = gray.shape[:2]
    s = max_side / max(h, w)
    if s < 1.0:
        gray = cv2.resize(gray, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(gray, cv2.CV_32F, ksize=3).var())


def thumb(gray: np.ndarray) -> np.ndarray:
    t = cv2.resize(gray, (64, 48), interpolation=cv2.INTER_AREA).astype(np.float32)
    t -= t.mean()
    n = np.linalg.norm(t)
    return t / n if n > 1e-6 else t


def resize_max_side(img: np.ndarray, max_side: int) -> np.ndarray:
    h, w = img.shape[:2]
    s = max_side / max(h, w)
    if s >= 1.0:
        return img
    return cv2.resize(img, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)


def select_frames_by_sharpness(scores: list[float], target: int) -> list[int]:
    """Split the timeline into ``target`` equal bins and pick the sharpest frame of each."""
    n = len(scores)
    if n == 0:
        return []
    if n <= target:
        return list(range(n))
    edges = np.linspace(0, n, target + 1)
    out: list[int] = []
    for a, b in zip(edges[:-1], edges[1:]):
        lo, hi = int(round(a)), max(int(round(b)), int(round(a)) + 1)
        seg = scores[lo:hi]
        out.append(lo + int(np.argmax(seg)))
    return sorted(set(out))


def focal_from_exif(exif_35mm: float | None, width: int, height: int) -> float | None:
    """Focal length in pixels from the 35 mm-equivalent focal length (36 mm film width)."""
    if not exif_35mm or exif_35mm <= 0:
        return None
    f = float(exif_35mm) / 36.0 * max(width, height)
    # Reject implausible values (FOV outside ~10..130 degrees).
    if not (0.25 * max(width, height) < f < 12 * max(width, height)):
        return None
    return f


@dataclass
class _Loaded:
    rgb: np.ndarray
    source: str
    focal35: float | None
    time_key: float | None
    device: str
    from_video: bool = False


def _exif_info(im: Image.Image) -> tuple[float | None, float | None, str]:
    focal35 = None
    tkey = None
    device = ""
    try:
        exif = im.getexif()
        if exif:
            device = f"{exif.get(0x010F, '')} {exif.get(0x0110, '')}".strip()
            sub = exif.get_ifd(0x8769) if hasattr(exif, "get_ifd") else {}
            f35 = sub.get(0xA405) or exif.get(0xA405)
            if f35:
                focal35 = float(f35)
            dto = sub.get(0x9003) or exif.get(0x0132)
            if dto:
                dt = datetime.strptime(str(dto).strip("\x00 "), "%Y:%m:%d %H:%M:%S")
                subsec = sub.get(0x9291)
                tkey = dt.timestamp() + (float(f"0.{int(subsec)}") if subsec and str(subsec).isdigit() else 0.0)
    except Exception:
        pass
    return focal35, tkey, device


def load_image(path: Path) -> _Loaded:
    if path.suffix.lower() in (".heic", ".heif") and not _register_heif():
        raise ReconError(
            "unsupported_input",
            f"{path.name} is a HEIC image but HEIC support (pillow-heif) is not installed. "
            "Export the photos as JPEG or install pillow-heif.",
        )
    with Image.open(path) as im:
        focal35, tkey, device = _exif_info(im)
        im = ImageOps.exif_transpose(im)
        if im.mode not in ("RGB",):
            if im.mode in ("RGBA", "LA", "P"):
                bg = Image.new("RGB", im.size, (255, 255, 255))
                im_rgba = im.convert("RGBA")
                bg.paste(im_rgba, mask=im_rgba.split()[-1])
                im = bg
            else:
                im = im.convert("RGB")
        rgb = np.asarray(im, dtype=np.uint8).copy()
    if rgb.ndim != 3 or rgb.shape[0] < 32 or rgb.shape[1] < 32:
        raise ValueError("image too small")
    return _Loaded(rgb=rgb, source=path.name, focal35=focal35, time_key=tkey, device=device)


def sample_video(path: Path, target: int, max_side: int, cancel: Callable[[], None] | None = None) -> list[_Loaded]:
    """Decode a video and return ~``target`` sharp, evenly spaced frames."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise ValueError("cannot open video")
    scores: list[float] = []
    try:
        while True:
            ok = cap.grab()
            if not ok:
                break
            ok, frame = cap.retrieve()
            if not ok or frame is None:
                break
            g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            scores.append(sharpness(g))
            if cancel is not None and len(scores) % 50 == 0:
                cancel()
    finally:
        cap.release()
    if not scores:
        raise ValueError("video has no decodable frames")
    chosen = set(select_frames_by_sharpness(scores, target))
    out: list[_Loaded] = []
    cap = cv2.VideoCapture(str(path))
    idx = 0
    try:
        while True:
            ok = cap.grab()
            if not ok:
                break
            if idx in chosen:
                ok, frame = cap.retrieve()
                if ok and frame is not None:
                    rgb = cv2.cvtColor(resize_max_side(frame, max_side), cv2.COLOR_BGR2RGB)
                    out.append(
                        _Loaded(rgb=rgb, source=f"{path.name}#{idx}", focal35=None, time_key=None, device=f"video:{path.name}", from_video=True)
                    )
            idx += 1
    finally:
        cap.release()
    return out


def ingest(
    input_dir: Path,
    work_dir: Path,
    preset: Preset,
    min_images: int = 3,
    progress: Callable[[float, str | None], None] | None = None,
    cancel: Callable[[], None] | None = None,
) -> IngestResult:
    images, videos, other = list_inputs(input_dir)
    if not images and not videos:
        extra = f" Found unsupported files: {', '.join(p.name for p in other[:5])}." if other else ""
        raise ReconError(
            "unsupported_input",
            "No images or videos were found. Upload JPG, PNG, WebP or HEIC photos, or an MP4/MOV/WebM video." + extra,
        )
    image_dir = work_dir / "images"
    image_dir.mkdir(parents=True, exist_ok=True)

    loaded: list[_Loaded] = []
    unreadable: list[str] = []
    total = len(images) + len(videos)
    for i, p in enumerate(images):
        if cancel:
            cancel()
        try:
            item = load_image(p)
            item.rgb = resize_max_side(item.rgb, preset.max_image_side)
            loaded.append(item)
        except ReconError:
            raise
        except Exception as e:
            log.warning("Skipping unreadable image %s (%s)", p.name, e)
            unreadable.append(p.name)
        if progress:
            progress((i + 1) / total * 0.7, f"Loaded {i + 1}/{len(images)} photos")

    # Photos first, ordered by capture time when every photo has one, else by file name.
    ordered = "filename"
    if loaded and all(x.time_key is not None for x in loaded) and len({x.time_key for x in loaded}) == len(loaded):
        loaded.sort(key=lambda x: x.time_key)  # type: ignore[arg-type,return-value]
        ordered = "exif_time"

    if videos:
        per_video = max(10, preset.video_frames // len(videos)) if images == [] else max(10, preset.video_frames // (len(videos) + 1))
        for j, v in enumerate(videos):
            try:
                frames = sample_video(v, per_video, preset.max_image_side, cancel)
                loaded.extend(frames)
                log.info("Sampled %d frames from %s", len(frames), v.name)
            except Exception as e:
                log.warning("Skipping unreadable video %s (%s)", v.name, e)
                unreadable.append(v.name)
            if progress:
                progress(0.7 + 0.2 * (j + 1) / len(videos), f"Extracted frames from {v.name}")
        if not images:
            ordered = "video"

    if not loaded:
        raise ReconError(
            "unsupported_input",
            "None of the uploaded files could be read. Make sure they are valid photos or videos.",
        )

    # ---- duplicate + blur filtering --------------------------------------------------------
    grays = [cv2.cvtColor(x.rgb, cv2.COLOR_RGB2GRAY) for x in loaded]
    sharp = np.array([sharpness(g) for g in grays])
    keep = np.ones(len(loaded), dtype=bool)

    digests: set[str] = set()
    dropped_dup = 0
    last_thumb: np.ndarray | None = None
    for i, (x, g) in enumerate(zip(loaded, grays)):
        dg = hashlib.sha1(x.rgb.tobytes()).hexdigest()
        th = thumb(g)
        if dg in digests:
            keep[i] = False
            dropped_dup += 1
            continue
        if last_thumb is not None and th.shape == last_thumb.shape:
            # Near-identical consecutive shots (e.g. camera not moved / video standing still).
            ncc = float((th * last_thumb).sum())
            if ncc > 0.995:
                keep[i] = False
                dropped_dup += 1
                continue
        digests.add(dg)
        last_thumb = th

    dropped_blur = 0
    idx = np.flatnonzero(keep)
    if len(idx) > min_images:
        med = float(np.median(sharp[idx]))
        blurry = [i for i in idx if sharp[i] < 0.2 * med]
        # Never drop so many that we fall below the minimum, nor more than a third of the set.
        max_drop = min(len(idx) - min_images, len(idx) // 3)
        blurry = sorted(blurry, key=lambda i: sharp[i])[:max(0, max_drop)]
        for i in blurry:
            keep[i] = False
            dropped_blur += 1
            log.info("Dropping blurry image %s", loaded[i].source)

    kept = [x for x, k in zip(loaded, keep) if k]
    kept_sharp = [float(s) for s, k in zip(sharp, keep) if k]
    if len(kept) < min_images:
        raise ReconError(
            "too_few_images",
            f"Only {len(kept)} usable image(s) were found; at least {min_images} are required "
            "(20-60 overlapping photos taken all around the subject work best).",
        )

    frames: list[Frame] = []
    for i, (x, s) in enumerate(zip(kept, kept_sharp)):
        name = f"{i:05d}.jpg"
        path = image_dir / name
        cv2.imwrite(str(path), cv2.cvtColor(x.rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95])
        h, w = x.rgb.shape[:2]
        frames.append(
            Frame(
                index=i,
                name=name,
                path=path,
                source=x.source,
                width=w,
                height=h,
                focal_px_prior=focal_from_exif(x.focal35, w, h),
                camera_key=f"{x.device}|{w}x{h}",
                sharpness=s,
                from_video=x.from_video,
            )
        )
    if progress:
        progress(1.0, f"Using {len(frames)} images")
    return IngestResult(
        frames=frames,
        image_dir=image_dir,
        inputs_images=len(images),
        inputs_videos=len(videos),
        dropped_blurry=dropped_blur,
        dropped_duplicates=dropped_dup,
        unreadable=unreadable,
        ordered=ordered,
    )


def load_rgb(path: Path) -> np.ndarray:
    bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if bgr is None:
        raise ReconError("internal", f"Could not read working image {path.name}")
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
