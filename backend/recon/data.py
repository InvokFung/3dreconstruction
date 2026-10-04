"""Shared data structures passed between pipeline stages."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np


@dataclass
class Frame:
    """One ingested image (a photo or a frame sampled from a video)."""

    index: int
    name: str  # file name inside the work image dir
    path: Path
    source: str  # original file name (``video.mp4#frame123`` for video frames)
    width: int
    height: int
    focal_px_prior: float | None = None  # from EXIF FocalLengthIn35mmFilm, in pixels
    camera_key: str = "default"  # frames sharing intrinsics (same device + resolution)
    sharpness: float = 0.0
    from_video: bool = False


@dataclass
class IngestResult:
    frames: list[Frame]
    image_dir: Path
    inputs_images: int = 0
    inputs_videos: int = 0
    dropped_blurry: int = 0
    dropped_duplicates: int = 0
    unreadable: list[str] = field(default_factory=list)
    ordered: str = "filename"  # how frames were ordered: "exif_time" | "filename" | "video"


@dataclass
class View:
    """A registered, undistorted (pinhole) camera with its image.

    Coordinates follow the OpenCV/COLMAP convention: x_cam = R @ x_world + t, +z forward,
    +y down. ``image`` is RGB uint8 at the ingest resolution.
    """

    name: str
    image: np.ndarray
    K: np.ndarray  # 3x3
    R: np.ndarray  # 3x3 world->camera
    t: np.ndarray  # (3,)
    mask: np.ndarray | None = None  # HxW float32 in [0,1] (foreground probability)
    sparse_xyz: np.ndarray = field(default_factory=lambda: np.zeros((0, 3)))
    sparse_uv: np.ndarray = field(default_factory=lambda: np.zeros((0, 2)))
    sparse_depth: np.ndarray = field(default_factory=lambda: np.zeros((0,)))
    sparse_ids: np.ndarray = field(default_factory=lambda: np.zeros((0,), dtype=np.int64))

    @property
    def width(self) -> int:
        return int(self.image.shape[1])

    @property
    def height(self) -> int:
        return int(self.image.shape[0])

    @property
    def center(self) -> np.ndarray:
        return -self.R.T @ self.t

    @property
    def w2c(self) -> np.ndarray:
        m = np.eye(4)
        m[:3, :3] = self.R
        m[:3, 3] = self.t
        return m

    @property
    def viewing_dir(self) -> np.ndarray:
        return self.R[2].copy()

    def project(self, X: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Project world points; returns (uv pixels (N,2), depth (N,))."""
        Xc = X @ self.R.T + self.t
        z = Xc[:, 2]
        with np.errstate(divide="ignore", invalid="ignore"):
            uv = (Xc[:, :2] / z[:, None]) * np.array([self.K[0, 0], self.K[1, 1]]) + np.array(
                [self.K[0, 2], self.K[1, 2]]
            )
        return uv, z


@dataclass
class SfMResult:
    views: list[View]
    points_xyz: np.ndarray  # (P,3) sparse points
    points_rgb: np.ndarray  # (P,3) uint8
    points_err: np.ndarray  # (P,) reprojection error
    num_input: int
    num_registered: int
    mean_reprojection_error: float
    matcher: str
    sequential: bool
    camera_model: str
    timings: dict[str, float] = field(default_factory=dict)


@dataclass
class DepthResult:
    """Per-view depth maps in SfM units at depth resolution, with matching intrinsics."""

    depths: list[np.ndarray]  # HxW float32, 0 = invalid
    confidences: list[np.ndarray]
    intrinsics: list[np.ndarray]  # 3x3 at depth resolution
    model: str
    alignment_error: float  # median relative error vs sparse SfM depth after alignment
    metric_scale: float | None = None  # multiply SfM units by this to get meters (estimate)
    stats: dict[str, float] = field(default_factory=dict)
