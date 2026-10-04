"""Job configuration (``config.json``) and quality presets."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal

from .errors import ReconError

Engine = Literal["photogrammetry", "generative"]
Quality = Literal["draft", "standard", "high"]
Mode = Literal["object", "scene"]
Device = Literal["auto", "cpu", "cuda"]

ALLOWED_TEXTURE_SIZES = (512, 1024, 2048, 4096, 8192)
ALLOWED_FORMATS = ("glb", "obj", "ply", "usdz")


@dataclass(frozen=True)
class Preset:
    """Quality-dependent knobs. All sizes are in pixels unless stated otherwise."""

    name: Quality
    # Ingest
    max_image_side: int  # images are downscaled to this before anything else
    video_frames: int  # target number of frames sampled from videos
    # Masking
    mask_resolution: int  # BiRefNet input size
    # SfM
    feature_max_side: int  # image size used for keypoint extraction
    max_keypoints: int
    exhaustive_max_images: int  # above this, use sequential + retrieval pairs
    retrieval_neighbors: int
    sequential_overlap: int
    # Depth
    depth_model: str  # Depth Anything 3 checkpoint
    depth_resolution: int  # longest side fed to the depth network (multiple of 14)
    depth_chunk: int  # views per multi-view depth forward pass
    # Fusion (voxel = scene extent / tsdf_resolution)
    tsdf_resolution: int
    # Texturing / output
    texture_size: int
    target_faces: int
    texture_views_topk: int
    exposure_compensation: bool


PRESETS: dict[str, Preset] = {
    "draft": Preset(
        name="draft",
        max_image_side=1280,
        video_frames=40,
        mask_resolution=512,
        feature_max_side=1024,
        max_keypoints=2048,
        exhaustive_max_images=30,
        retrieval_neighbors=5,
        sequential_overlap=4,
        depth_model="depth-anything/DA3-SMALL",
        depth_resolution=504,
        depth_chunk=24,
        tsdf_resolution=192,
        texture_size=1024,
        target_faces=50_000,
        texture_views_topk=3,
        exposure_compensation=False,
    ),
    "standard": Preset(
        name="standard",
        max_image_side=2048,
        video_frames=80,
        mask_resolution=768,
        feature_max_side=1600,
        max_keypoints=4096,
        exhaustive_max_images=40,
        retrieval_neighbors=8,
        sequential_overlap=6,
        depth_model="depth-anything/DA3-BASE",
        depth_resolution=756,
        depth_chunk=24,
        tsdf_resolution=320,
        texture_size=2048,
        target_faces=100_000,
        texture_views_topk=3,
        exposure_compensation=True,
    ),
    "high": Preset(
        name="high",
        max_image_side=3072,
        video_frames=120,
        mask_resolution=1024,
        feature_max_side=2048,
        max_keypoints=8192,
        exhaustive_max_images=60,
        retrieval_neighbors=12,
        sequential_overlap=8,
        depth_model="depth-anything/DA3-LARGE-1.1",
        depth_resolution=1008,
        depth_chunk=16,
        tsdf_resolution=448,
        texture_size=4096,
        target_faces=300_000,
        texture_views_topk=4,
        exposure_compensation=True,
    ),
}


@dataclass
class JobConfig:
    """Parsed ``config.json``. Missing keys use the contract defaults.

    ``texture_size`` and ``target_faces`` default to the selected quality preset when they are
    absent from ``config.json`` (for ``standard`` these equal the contract defaults 2048/100000).
    Explicit values always win.
    """

    engine: Engine = "photogrammetry"
    quality: Quality = "standard"
    mode: Mode = "object"
    texture_size: int = 2048
    target_faces: int = 100_000
    formats: list[str] = field(default_factory=lambda: list(ALLOWED_FORMATS))
    device: Device = "auto"
    # Not part of the contract; recognised for power users / tests, ignored when absent.
    seed: int = 0

    @property
    def preset(self) -> Preset:
        return PRESETS[self.quality]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "JobConfig":
        if not isinstance(raw, dict):
            raise ReconError("unsupported_input", "config.json must contain a JSON object.")

        def pick(key: str, allowed: tuple[str, ...], default: str) -> str:
            val = raw.get(key, default)
            if val is None:
                return default
            val = str(val).strip().lower()
            if val not in allowed:
                raise ReconError(
                    "unsupported_input",
                    f"Invalid value {raw.get(key)!r} for '{key}'. Expected one of: {', '.join(allowed)}.",
                )
            return val

        engine = pick("engine", ("photogrammetry", "generative"), "photogrammetry")
        quality = pick("quality", ("draft", "standard", "high"), "standard")
        mode = pick("mode", ("object", "scene"), "object")
        device = pick("device", ("auto", "cpu", "cuda"), "auto")
        preset = PRESETS[quality]

        tex_raw = raw.get("texture_size")
        if tex_raw is None:
            texture_size = preset.texture_size
        else:
            try:
                texture_size = int(tex_raw)
            except (TypeError, ValueError) as e:
                raise ReconError("unsupported_input", f"Invalid texture_size {tex_raw!r}.") from e
            if texture_size not in ALLOWED_TEXTURE_SIZES:
                # Snap to the nearest supported power of two instead of failing.
                texture_size = min(ALLOWED_TEXTURE_SIZES, key=lambda s: abs(s - texture_size))

        faces_raw = raw.get("target_faces")
        if faces_raw is None:
            target_faces = preset.target_faces
        else:
            try:
                target_faces = int(faces_raw)
            except (TypeError, ValueError) as e:
                raise ReconError("unsupported_input", f"Invalid target_faces {faces_raw!r}.") from e
            target_faces = max(1_000, min(target_faces, 5_000_000))

        formats_raw = raw.get("formats")
        if formats_raw is None:
            formats = list(ALLOWED_FORMATS)
        else:
            if isinstance(formats_raw, str):
                formats_raw = [formats_raw]
            if not isinstance(formats_raw, list):
                raise ReconError("unsupported_input", "'formats' must be a list of strings.")
            formats = []
            for f in formats_raw:
                f = str(f).strip().lower()
                if f in ("obj_zip", "objzip"):
                    f = "obj"
                if f in ALLOWED_FORMATS and f not in formats:
                    formats.append(f)
            if not formats:
                formats = ["glb"]

        seed_raw = raw.get("seed", 0)
        try:
            seed = int(seed_raw)
        except (TypeError, ValueError):
            seed = 0

        return cls(
            engine=engine,  # type: ignore[arg-type]
            quality=quality,  # type: ignore[arg-type]
            mode=mode,  # type: ignore[arg-type]
            texture_size=texture_size,
            target_faces=target_faces,
            formats=formats,
            device=device,  # type: ignore[arg-type]
            seed=seed,
        )

    @classmethod
    def load(cls, path: Path | None) -> "JobConfig":
        if path is None or not path.exists():
            return cls.from_dict({})
        try:
            raw = json.loads(path.read_text(encoding="utf-8") or "{}")
        except json.JSONDecodeError as e:
            raise ReconError("unsupported_input", f"config.json is not valid JSON: {e}") from e
        return cls.from_dict(raw)
