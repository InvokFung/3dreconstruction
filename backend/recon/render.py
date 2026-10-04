"""Headless software renderer (ray casting with Open3D) for thumbnails and QA renders.

No OpenGL/EGL context is needed, so it works in any container.
"""

from __future__ import annotations

import numpy as np

from .cleanup import Mesh


def look_at(eye: np.ndarray, target: np.ndarray, up: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """World->camera (R, t) for an OpenCV camera (+z forward, +y down)."""
    up = np.array([0.0, 1.0, 0.0]) if up is None else up
    f = target - eye
    f /= np.linalg.norm(f)
    r = np.cross(f, up)
    if np.linalg.norm(r) < 1e-6:
        r = np.cross(f, np.array([0.0, 0.0, 1.0]))
    r /= np.linalg.norm(r)
    d = np.cross(f, r)  # camera +y (down)
    R = np.stack([r, d, f])
    t = -R @ eye
    return R, t


def _sample_texture(tex: np.ndarray, uv: np.ndarray) -> np.ndarray:
    """Sample an image texture at OBJ-convention UVs (v up), with wrap-around."""
    from .geometry import bilinear_sample

    h, w = tex.shape[:2]
    x = uv[:, 0] * w - 0.5
    y = (1.0 - uv[:, 1]) * h - 0.5
    out = bilinear_sample(tex, x, y, wrap=True)
    return out.reshape(len(uv), -1)


def render(
    mesh: Mesh,
    size: int = 512,
    azimuth_deg: float = 35.0,
    elevation_deg: float = 25.0,
    fov_deg: float = 35.0,
    supersample: int = 2,
    background: tuple[int, int, int, int] = (0, 0, 0, 0),
) -> np.ndarray:
    """Render an RGBA image (uint8) of a mesh with its texture or vertex colours (Y-up frame)."""
    import cv2
    import open3d as o3d

    V, F = mesh.V.astype(np.float64), mesh.F.astype(np.int64)
    lo, hi = V.min(0), V.max(0)
    center = 0.5 * (lo + hi)
    radius = 0.5 * float(np.linalg.norm(hi - lo)) or 1.0
    dist = radius / np.sin(np.radians(fov_deg) / 2) * 1.05
    az, el = np.radians(azimuth_deg), np.radians(elevation_deg)
    eye = center + dist * np.array([np.sin(az) * np.cos(el), np.sin(el), np.cos(az) * np.cos(el)])
    R, t = look_at(eye, center)
    S = size * supersample
    f = 0.5 * S / np.tan(np.radians(fov_deg) / 2)
    ys, xs = np.mgrid[0:S, 0:S].astype(np.float32)
    dc = np.stack([(xs + 0.5 - S / 2) / f, (ys + 0.5 - S / 2) / f, np.ones_like(xs)], -1).reshape(-1, 3)
    dw = dc @ R
    rays = np.concatenate([np.broadcast_to(eye, dw.shape), dw], 1).astype(np.float32)
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(V.astype(np.float32)), o3d.core.Tensor(F.astype(np.uint32)))
    ans = scene.cast_rays(o3d.core.Tensor(rays))
    prim = ans["primitive_ids"].numpy()
    hit = prim != o3d.t.geometry.RaycastingScene.INVALID_ID
    idx = np.flatnonzero(hit)
    fi = prim[idx].astype(np.int64)
    buv = ans["primitive_uvs"].numpy()[idx].astype(np.float64)
    b1, b2 = buv[:, 0:1], buv[:, 1:2]
    b0 = 1 - b1 - b2
    tri = F[fi]
    if mesh.UV is not None and mesh.texture is not None:
        uv = b0 * mesh.UV[tri[:, 0]] + b1 * mesh.UV[tri[:, 1]] + b2 * mesh.UV[tri[:, 2]]
        albedo = _sample_texture(mesh.texture, uv)[:, :3] / 255.0
    elif mesh.C is not None:
        albedo = b0 * mesh.C[tri[:, 0]] + b1 * mesh.C[tri[:, 1]] + b2 * mesh.C[tri[:, 2]]
    else:
        albedo = np.full((len(idx), 3), 0.75)
    n = np.asarray(ans["primitive_normals"].numpy()[idx], dtype=np.float64)
    view_dir = -dw[idx] / np.linalg.norm(dw[idx], axis=1, keepdims=True)
    n = np.where(((n * view_dir).sum(1) < 0)[:, None], -n, n)  # two-sided
    key = np.array([0.4, 0.8, 0.45])
    key /= np.linalg.norm(key)
    lam = np.clip(n @ key, 0, 1)[:, None]
    head = np.clip((n * view_dir).sum(1), 0, 1)[:, None]
    shade = 0.62 + 0.25 * lam + 0.18 * head
    rgb = np.clip(albedo * shade, 0, 1)
    img = np.zeros((S * S, 4), np.float32)
    img[:] = np.array(background, np.float32) / 255.0
    img[idx, :3] = rgb
    img[idx, 3] = 1.0
    img = img.reshape(S, S, 4)
    if supersample > 1:
        # Premultiplied-alpha downsample for clean edges.
        pm = img.copy()
        pm[..., :3] *= pm[..., 3:4]
        pm = cv2.resize(pm, (size, size), interpolation=cv2.INTER_AREA)
        a = pm[..., 3:4]
        pm[..., :3] = np.where(a > 1e-6, pm[..., :3] / np.maximum(a, 1e-6), np.array(background[:3], np.float32) / 255.0)
        img = pm
    return np.clip(img * 255 + 0.5, 0, 255).astype(np.uint8)


def contact_sheet(mesh: Mesh, size: int = 384, azimuths: tuple[float, ...] = (0, 90, 180, 270), elevation: float = 20.0) -> np.ndarray:
    tiles = [render(mesh, size=size, azimuth_deg=a, elevation_deg=elevation, background=(255, 255, 255, 255)) for a in azimuths]
    return np.concatenate(tiles, axis=1)
