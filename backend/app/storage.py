"""Filesystem layout, upload validation (content sniffing), thumbnails and job log files.

Layout under DATA_DIR:
    projects/<pid>/images/<image_id>.<ext>     original uploads
    projects/<pid>/thumbs/<image_id>.jpg       <=384px JPEG thumbnails
    jobs/<jid>/input/                          hard-links (or copies) of the project images at submission
    jobs/<jid>/output/                         pipeline outputs
    jobs/<jid>/config.json                     pipeline config
    jobs/<jid>/log.txt                         "<iso-ts> [<level>] <message>" lines
    cache/samples/<name>.jpg                   sample thumbnails
    capabilities.json                          capabilities written by the worker
    tmp/                                       upload spool area
"""

from __future__ import annotations

import os
import re
import shutil
import unicodedata
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import BinaryIO

from PIL import Image as PILImage
from PIL import ImageDraw, ImageOps

from .config import Settings

try:  # optional HEIC/HEIF support
    import pillow_heif  # type: ignore

    pillow_heif.register_heif_opener()
    HEIF_SUPPORTED = True
except Exception:  # pragma: no cover - depends on environment
    HEIF_SUPPORTED = False

PILImage.MAX_IMAGE_PIXELS = 200_000_000  # large phone/DSLR photos are fine; still guards decompression bombs

THUMB_MAX = 384
CHUNK = 1024 * 1024

# Pillow format -> (extension, content type)
IMAGE_FORMATS = {
    "JPEG": (".jpg", "image/jpeg"),
    "MPO": (".jpg", "image/jpeg"),  # multi-picture JPEG (many phones)
    "PNG": (".png", "image/png"),
    "WEBP": (".webp", "image/webp"),
    "HEIF": (".heic", "image/heic"),
    "AVIF": (".avif", "image/avif"),
}
VIDEO_EXTENSIONS = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}


class UploadRejected(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


# ---------------------------------------------------------------- paths


class Storage:
    def __init__(self, settings: Settings):
        self.root = settings.DATA_DIR

    def ensure(self) -> None:
        for sub in ("projects", "jobs", "cache/samples", "tmp"):
            (self.root / sub).mkdir(parents=True, exist_ok=True)

    def project_dir(self, pid: str) -> Path:
        return self.root / "projects" / pid

    def images_dir(self, pid: str) -> Path:
        return self.project_dir(pid) / "images"

    def thumbs_dir(self, pid: str) -> Path:
        return self.project_dir(pid) / "thumbs"

    def image_path(self, pid: str, stored_name: str) -> Path:
        return self.images_dir(pid) / stored_name

    def thumb_path(self, pid: str, image_id: str) -> Path:
        return self.thumbs_dir(pid) / f"{image_id}.jpg"

    def job_dir(self, jid: str) -> Path:
        return self.root / "jobs" / jid

    def job_log(self, jid: str) -> Path:
        return self.job_dir(jid) / "log.txt"

    def tmp_dir(self) -> Path:
        p = self.root / "tmp"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def capabilities_file(self) -> Path:
        return self.root / "capabilities.json"

    def sample_thumb(self, name: str) -> Path:
        return self.root / "cache" / "samples" / f"{name}.jpg"


def rmtree_quiet(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


# ---------------------------------------------------------------- filenames

_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_filename(name: str | None, default: str = "file") -> str:
    name = (name or "").replace("\\", "/").split("/")[-1]
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    name = _SAFE_RE.sub("_", name).strip("._")
    if not name:
        name = default
    if len(name) > 120:
        stem, ext = os.path.splitext(name)
        name = stem[: 120 - len(ext[:10])] + ext[:10]
    return name


def slugify(text: str, default: str = "model") -> str:
    s = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:60] or default


# ---------------------------------------------------------------- sniffing


@dataclass
class SniffResult:
    kind: str  # image | video
    ext: str
    content_type: str
    width: int | None = None
    height: int | None = None


def sniff_video(head: bytes) -> tuple[str, str] | None:
    """Recognise ISO-BMFF (mp4/mov) and EBML (webm/mkv) containers by magic bytes."""
    if len(head) >= 12 and head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand.startswith(b"qt"):
            return ".mov", "video/quicktime"
        return ".mp4", "video/mp4"
    if len(head) >= 8 and head[4:8] in (b"moov", b"mdat", b"wide", b"free", b"skip"):
        return ".mov", "video/quicktime"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return ".webm", "video/webm"
    return None


def sniff_file(path: Path, original_name: str) -> SniffResult:
    with open(path, "rb") as f:
        head = f.read(64)
    if not head:
        raise UploadRejected(400, f"'{original_name}' is empty")
    # Images: let Pillow decide from content (never trust the extension or client content-type).
    try:
        with PILImage.open(path) as im:
            fmt = (im.format or "").upper()
            if fmt in IMAGE_FORMATS:
                im.verify()
                ext, ctype = IMAGE_FORMATS[fmt]
                with PILImage.open(path) as im2:
                    oriented = ImageOps.exif_transpose(im2) or im2
                    w, h = oriented.size
                return SniffResult("image", ext, ctype, w, h)
            raise UploadRejected(
                415, f"'{original_name}': image format {fmt or 'unknown'} is not supported (use JPEG, PNG, WebP or HEIC)"
            )
    except UploadRejected:
        raise
    except PILImage.DecompressionBombError:
        raise UploadRejected(413, f"'{original_name}' has too many pixels") from None
    except Exception:
        pass
    vid = sniff_video(head)
    if vid is not None:
        ext_in = os.path.splitext(original_name.lower())[1]
        ext, ctype = vid
        # Both are ISO-BMFF; keep the user's .mov/.m4v naming when the content is compatible.
        if ext == ".mp4" and ext_in in (".mov", ".m4v"):
            ext, ctype = ext_in, VIDEO_EXTENSIONS[ext_in]
        return SniffResult("video", ext, ctype)
    hint = "" if HEIF_SUPPORTED else " (HEIC support is not installed on this server)"
    raise UploadRejected(415, f"'{original_name}' is not a supported image or video{hint}")


def copy_stream_limited(src: BinaryIO, dest: Path, max_bytes: int, original_name: str) -> int:
    total = 0
    with open(dest, "wb") as out:
        while True:
            chunk = src.read(CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise UploadRejected(413, f"'{original_name}' exceeds the {max_bytes // (1024 * 1024)} MB limit")
            out.write(chunk)
    return total


# ---------------------------------------------------------------- thumbnails


def make_image_thumb(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with PILImage.open(src) as im:
        im.draft("RGB", (THUMB_MAX * 2, THUMB_MAX * 2))  # fast JPEG downscale
        im = ImageOps.exif_transpose(im) or im
        im.thumbnail((THUMB_MAX, THUMB_MAX), PILImage.Resampling.LANCZOS)
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = PILImage.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.split()[-1])
            im = bg
        elif im.mode != "RGB":
            im = im.convert("RGB")
        tmp = dest.with_suffix(".tmp")
        im.save(tmp, "JPEG", quality=82, optimize=True)
        os.replace(tmp, dest)


def make_video_placeholder_thumb(dest: Path) -> None:
    """The API image has no ffmpeg; show a neutral 'video' tile instead of a frame."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    w, h = THUMB_MAX, THUMB_MAX * 3 // 4
    im = PILImage.new("RGB", (w, h), (48, 52, 60))
    d = ImageDraw.Draw(im)
    cx, cy, r = w // 2, h // 2, 48
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(90, 96, 108))
    d.polygon([(cx - 16, cy - 26), (cx - 16, cy + 26), (cx + 28, cy)], fill=(235, 235, 240))
    im.save(dest, "JPEG", quality=85)


# ---------------------------------------------------------------- job input staging


def link_or_copy(src: Path, dest: Path) -> None:
    try:
        os.link(src, dest)
    except OSError:
        shutil.copy2(src, dest)


# ---------------------------------------------------------------- job logs

_LOG_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z) \[(\w+)\] ?(.*)$")
LOG_LEVELS = {"debug", "info", "warning", "error"}


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize_level(level: str | None) -> str:
    lv = (level or "info").lower()
    if lv == "warn":
        lv = "warning"
    if lv in ("critical", "fatal"):
        lv = "error"
    return lv if lv in LOG_LEVELS else "info"


def format_log_lines(level: str, message: str, ts: str | None = None) -> str:
    ts = ts or now_iso()
    level = normalize_level(level)
    lines = str(message).rstrip("\n").split("\n") or [""]
    return "".join(f"{ts} [{level}] {ln.rstrip(chr(13))}\n" for ln in lines)


def parse_log_line(line: str) -> dict:
    m = _LOG_RE.match(line)
    if m:
        return {"level": m.group(2), "message": m.group(3), "ts": m.group(1)}
    return {"level": "info", "message": line, "ts": now_iso()}
