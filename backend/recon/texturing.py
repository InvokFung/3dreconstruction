"""UV unwrapping (xatlas) and multi-view texture baking.

For every texel of the atlas we know its 3D position and normal (rasterised in UV space with an
Open3D ray-casting scene). Each texel is projected into every view; a view contributes when the
texel is visible there (depth test against the mesh rendered from that view), faces the camera
and lies away from image borders / silhouette edges. The top-k views per texel are blended with
weights that strongly favour frontal, close, sharp observations, after an optional per-view
exposure (gain) compensation. Texels no view saw get the colour of the nearest seen surface
point; finally the atlas is padded (push-pull) so mip-mapping and bilinear filtering never pull
in background colour across chart seams.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import cv2
import numpy as np

from .cleanup import Mesh
from .data import View
from .progress import SubProgress
from .runtime import CANCEL

log = logging.getLogger("recon")


# ---------------------------------------------------------------------------------------------
# UV unwrap
# ---------------------------------------------------------------------------------------------


def spatial_chunks(mesh: Mesh, max_faces: int) -> list[np.ndarray]:
    """Split faces into spatially compact groups of <= ``max_faces`` (recursive median cuts)."""
    if mesh.n_faces <= max_faces:
        return [np.arange(mesh.n_faces)]
    cen = mesh.V[mesh.F].mean(1)
    k = int(np.ceil(mesh.n_faces / max_faces))
    groups = [np.arange(mesh.n_faces)]
    while len(groups) < k:
        groups.sort(key=len)
        g = groups.pop()
        c = cen[g]
        ax = int(np.argmax(np.ptp(c, axis=0)))
        order = np.argsort(c[:, ax], kind="stable")
        h = len(g) // 2
        groups += [g[order[:h]], g[order[h:]]]
    return groups


def unwrap(
    mesh: Mesh, texture_size: int, padding: int | None = None, chart_iterations: int = 1, chunk_faces: int = 25_000
) -> Mesh:
    """Return a copy of ``mesh`` with per-vertex UVs (vertices split along seams).

    Large meshes are split into spatial chunks that xatlas charts in parallel and packs into one
    atlas: chart computation scales super-linearly, so a 300k-face mesh drops from >10 min to
    ~30 s on 4 cores at the cost of a few extra seams.

    UVs follow the OBJ/trimesh convention (v = 0 at the bottom row of the image).
    """
    import xatlas

    groups = spatial_chunks(mesh, chunk_faces)
    atlas = xatlas.Atlas()
    used_list = []
    for g in groups:
        used, inv = np.unique(mesh.F[g], return_inverse=True)
        used_list.append(used)
        atlas.add_mesh(mesh.V[used].astype(np.float32), inv.reshape(-1, 3).astype(np.uint32))
    co = xatlas.ChartOptions()
    co.max_iterations = int(chart_iterations)  # 0 is ~2x faster with slightly more charts
    po = xatlas.PackOptions()
    po.resolution = int(texture_size)
    po.padding = int(padding if padding is not None else max(2, texture_size // 512))
    po.bilinear = True
    po.blockAlign = True
    atlas.generate(co, po)
    if atlas.atlas_count != 1:
        log.warning("xatlas produced %d atlas pages; repacking as a single page", atlas.atlas_count)
        if len(groups) > 1:
            return unwrap(mesh, texture_size, padding, chart_iterations, chunk_faces=mesh.n_faces)
    Vs, Fs, UVs, Cs = [], [], [], []
    offset = 0
    for i, used in enumerate(used_list):
        vmapping, indices, uvs = atlas[i]
        src = used[vmapping]
        Vs.append(mesh.V[src])
        if mesh.C is not None:
            Cs.append(mesh.C[src])
        UVs.append(uvs)
        Fs.append(indices.astype(np.int64) + offset)
        offset += len(src)
    out = Mesh(
        V=np.concatenate(Vs).copy(),
        F=np.concatenate(Fs),
        C=np.concatenate(Cs) if Cs else None,
        UV=np.concatenate(UVs).astype(np.float64),
        meta=dict(mesh.meta),
    )
    util = atlas.utilization
    out.meta["uv_utilization"] = round(float(util if np.isscalar(util) else util[0]), 4)
    out.meta["uv_charts"] = int(atlas.chart_count)
    return out


def vertex_normals(V: np.ndarray, F: np.ndarray) -> np.ndarray:
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])  # area-weighted
    vn = np.zeros_like(V)
    for k in range(3):
        np.add.at(vn, F[:, k], fn)
    n = np.linalg.norm(vn, axis=1, keepdims=True)
    return vn / np.maximum(n, 1e-20)


# ---------------------------------------------------------------------------------------------
# UV-space rasterisation
# ---------------------------------------------------------------------------------------------


@dataclass
class Texels:
    ys: np.ndarray  # (M,) row in texture image (0 = top)
    xs: np.ndarray  # (M,) column
    P: np.ndarray  # (M,3) float32 world positions
    N: np.ndarray  # (M,3) float32 unit normals
    size: int
    tri: np.ndarray | None = None  # (M,3) vertex ids of the covering triangle
    bary: np.ndarray | None = None  # (M,3) barycentric weights


def rasterize_uv(mesh: Mesh, size: int) -> Texels:
    """Find which triangle covers every texel centre and interpolate position/normal."""
    import open3d as o3d

    assert mesh.UV is not None
    uv = mesh.UV
    # Texture pixel coords (x right, y down) for each vertex.
    px = np.stack([uv[:, 0] * size, (1.0 - uv[:, 1]) * size, np.zeros(len(uv))], 1).astype(np.float32)
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(px), o3d.core.Tensor(mesh.F.astype(np.uint32)))
    ys, xs = np.mgrid[0:size, 0:size]
    rays = np.zeros((size, size, 6), np.float32)
    rays[..., 0] = xs + 0.5
    rays[..., 1] = ys + 0.5
    rays[..., 2] = 1.0
    rays[..., 5] = -1.0
    ans = scene.cast_rays(o3d.core.Tensor(rays))
    prim = ans["primitive_ids"].numpy().ravel()
    buv = ans["primitive_uvs"].numpy().reshape(-1, 2)
    hit = prim != o3d.t.geometry.RaycastingScene.INVALID_ID
    idx = np.flatnonzero(hit)
    f = mesh.F[prim[idx].astype(np.int64)]
    b1, b2 = buv[idx, 0:1].astype(np.float64), buv[idx, 1:2].astype(np.float64)
    b0 = 1.0 - b1 - b2
    P = b0 * mesh.V[f[:, 0]] + b1 * mesh.V[f[:, 1]] + b2 * mesh.V[f[:, 2]]
    vn = vertex_normals(mesh.V, mesh.F)
    N = b0 * vn[f[:, 0]] + b1 * vn[f[:, 1]] + b2 * vn[f[:, 2]]
    fnrm = np.cross(mesh.V[f[:, 1]] - mesh.V[f[:, 0]], mesh.V[f[:, 2]] - mesh.V[f[:, 0]])
    fnrm /= np.maximum(np.linalg.norm(fnrm, axis=1, keepdims=True), 1e-20)
    bad = ~np.isfinite(N).all(1) | (np.linalg.norm(N, axis=1) < 1e-6)
    N[bad] = fnrm[bad]
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-20)
    yy, xx = np.divmod(idx, size)
    return Texels(
        ys=yy, xs=xx, P=P.astype(np.float32), N=N.astype(np.float32), size=size,
        tri=f, bary=np.concatenate([b0, b1, b2], 1).astype(np.float32),
    )


# ---------------------------------------------------------------------------------------------
# Visibility
# ---------------------------------------------------------------------------------------------


def render_depth(scene, v: View, scale: float = 1.0) -> np.ndarray:  # type: ignore[no-untyped-def]
    """Z-depth of the mesh as seen from ``v`` (0 where nothing is hit)."""
    import open3d as o3d

    w, h = max(1, int(round(v.width * scale))), max(1, int(round(v.height * scale)))
    K = v.K.copy()
    K[0, :] *= w / v.width
    K[1, :] *= h / v.height
    K[0, 2] = (v.K[0, 2] + 0.5) * w / v.width - 0.5
    K[1, 2] = (v.K[1, 2] + 0.5) * h / v.height - 0.5
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    dc = np.stack([(xs - K[0, 2]) / K[0, 0], (ys - K[1, 2]) / K[1, 1], np.ones_like(xs)], -1)  # z = 1
    dw = dc.reshape(-1, 3) @ v.R  # R^T d
    o = np.broadcast_to(v.center.astype(np.float32), dw.shape)
    rays = np.concatenate([o, dw], 1).astype(np.float32)
    t = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
    # dc has z = 1, so t_hit along R^T dc equals the z-depth.
    d = np.where(np.isfinite(t), t, 0).reshape(h, w).astype(np.float32)
    return d


def _bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    from .geometry import bilinear_sample

    return bilinear_sample(img, x, y)


def _edge_weight_map(v: View, fade_px: float) -> np.ndarray:
    """1 inside, fading to ~0 near image borders and subject-mask edges (avoids halos)."""
    h, w = v.height, v.width
    inside = np.ones((h, w), np.uint8)
    inside[0, :] = inside[-1, :] = inside[:, 0] = inside[:, -1] = 0
    if v.mask is not None:
        inside &= (v.mask > 0.5).astype(np.uint8)
    dist = cv2.distanceTransform(inside, cv2.DIST_L2, 5)
    return np.clip(dist / fade_px, 0.02, 1.0).astype(np.float32)


@dataclass
class _ViewSamples:
    idx: np.ndarray  # texel indices
    w: np.ndarray  # weights
    c: np.ndarray  # (k,3) float32 colours 0..255


def _sample_view(scene, v: View, tex: Texels, depth_tol: float, fade_px: float, min_cos: float = 0.1) -> _ViewSamples:  # type: ignore[no-untyped-def]
    P = tex.P
    Xc = P @ v.R.T.astype(np.float32) + v.t.astype(np.float32)
    z = Xc[:, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        x = Xc[:, 0] / z * v.K[0, 0] + v.K[0, 2]
        y = Xc[:, 1] / z * v.K[1, 1] + v.K[1, 2]
    ok = (z > 1e-9) & (x >= 0) & (x <= v.width - 1) & (y >= 0) & (y <= v.height - 1)
    idx = np.flatnonzero(ok)
    if len(idx) == 0:
        return _ViewSamples(idx, np.zeros(0, np.float32), np.zeros((0, 3), np.float32))
    to_cam = v.center.astype(np.float32) - P[idx]
    dist = np.linalg.norm(to_cam, axis=1)
    cos = (tex.N[idx] * to_cam).sum(1) / np.maximum(dist, 1e-12)
    keep = cos > min_cos
    idx, cos, dist = idx[keep], cos[keep], dist[keep]
    x, y, z = x[idx], y[idx], z[idx]
    # Depth test against the mesh rendered from this view.
    dmap = render_depth(scene, v)
    dm = _bilinear(dmap, x, y)
    dn = dmap[np.clip(np.round(y).astype(int), 0, v.height - 1), np.clip(np.round(x).astype(int), 0, v.width - 1)]
    vis = ((np.abs(z - dm) < depth_tol + 0.002 * z) | (np.abs(z - dn) < depth_tol + 0.002 * z)) & (dn > 0)
    idx, cos, z, x, y = idx[vis], cos[vis], z[vis], x[vis], y[vis]
    if len(idx) == 0:
        return _ViewSamples(idx, np.zeros(0, np.float32), np.zeros((0, 3), np.float32))
    edge = _bilinear(_edge_weight_map(v, fade_px), x, y)
    f = 0.5 * (v.K[0, 0] + v.K[1, 1])
    res = f / z  # pixels per world unit: favours close / high-resolution views
    w = (cos**3) * (res**2) * edge
    col = _bilinear(v.image.astype(np.float32), x, y)
    return _ViewSamples(idx, w.astype(np.float32), col.astype(np.float32))


# ---------------------------------------------------------------------------------------------
# Atlas filling
# ---------------------------------------------------------------------------------------------


def harmonic_fill(mesh: Mesh, tex: Texels, color: np.ndarray, seen: np.ndarray) -> np.ndarray:
    """Per-texel colours where unseen texels interpolate seen colours smoothly across the mesh.

    Seen texel colours are splatted onto (position-welded) vertices; vertices without
    observations are solved with a graph Laplace equation (Dirichlet boundary = observed
    vertices), then texels interpolate vertex colours barycentrically.
    """
    from scipy.sparse import coo_matrix
    from scipy.sparse.linalg import spsolve

    assert tex.tri is not None and tex.bary is not None
    # Weld UV-seam duplicates so colour diffuses across chart boundaries.
    q = np.round(mesh.V / max(1e-12, float(np.ptp(mesh.V, axis=0).max()) * 1e-7)).astype(np.int64)
    _, weld = np.unique(q, axis=0, return_inverse=True)
    weld = weld.ravel()
    nv = int(weld.max()) + 1
    acc = np.zeros((nv, 3))
    wsum = np.zeros(nv)
    tri_w = weld[tex.tri[seen]]
    bw = tex.bary[seen].astype(np.float64)
    for k in range(3):
        np.add.at(acc, tri_w[:, k], bw[:, k : k + 1] * color[seen])
        np.add.at(wsum, tri_w[:, k], bw[:, k])
    known = wsum > 0.5
    vcol = np.zeros((nv, 3))
    vcol[known] = acc[known] / wsum[known, None]
    unknown = np.flatnonzero(~known)
    if len(unknown):
        Fw = weld[mesh.F]
        e = np.concatenate([Fw[:, [0, 1]], Fw[:, [1, 2]], Fw[:, [2, 0]]])
        e = np.unique(np.concatenate([e, e[:, ::-1]]), axis=0)
        e = e[e[:, 0] != e[:, 1]]
        loc = -np.ones(nv, np.int64)
        loc[unknown] = np.arange(len(unknown))
        eu = e[loc[e[:, 0]] >= 0]
        n = len(unknown)
        deg = np.bincount(loc[eu[:, 0]], minlength=n).astype(np.float64) + 1e-9
        inner = loc[eu[:, 1]] >= 0
        A = coo_matrix(
            (np.concatenate([deg, -np.ones(int(inner.sum()))]),
             (np.concatenate([np.arange(n), loc[eu[inner, 0]]]), np.concatenate([np.arange(n), loc[eu[inner, 1]]]))),
            shape=(n, n),
        ).tocsr()
        B = np.zeros((n, 3))
        np.add.at(B, loc[eu[~inner, 0]], vcol[eu[~inner, 1]])
        # Components with no observed vertex get the global mean (regularise lightly).
        mean = color[seen].mean(0)
        A = A + coo_matrix((np.full(n, 1e-6), (np.arange(n), np.arange(n))), shape=(n, n)).tocsr()
        B += 1e-6 * mean
        harm = np.asarray(spsolve(A, B)).reshape(n, 3)
        # Far from observed surface, harmonic interpolation turns into radial streaks of the
        # boundary colours; fade towards the region's median boundary colour with distance.
        from scipy.sparse.csgraph import connected_components
        from scipy.spatial import cKDTree

        Au = coo_matrix((np.ones(int(inner.sum())), (loc[eu[inner, 0]], loc[eu[inner, 1]])), shape=(n, n)).tocsr()
        ncomp, comp = connected_components(Au, directed=False)
        Vw = np.zeros((nv, 3))
        Vw[weld] = mesh.V
        dist, _ = cKDTree(Vw[known]).query(Vw[unknown], k=1)
        falloff = 0.03 * float(np.ptp(mesh.V, axis=0).max())
        med = np.tile(mean, (ncomp, 1))
        bnd_src = loc[eu[~inner, 0]]
        bnd_col = vcol[eu[~inner, 1]]
        for c_ in np.unique(comp[bnd_src]):
            sel = comp[bnd_src] == c_
            med[c_] = np.median(bnd_col[sel], axis=0)
        alpha = np.exp(-dist / max(falloff, 1e-12))[:, None]
        vcol[unknown] = alpha * harm + (1 - alpha) * med[comp]
    tv = vcol[weld[tex.tri]]  # (M,3,3)
    return (tex.bary[..., None].astype(np.float64) * tv).sum(1).astype(np.float32)


def push_pull_fill(img: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Fill invalid pixels with a smooth extrapolation of valid ones (mask-weighted pyramid)."""
    img = img.astype(np.float32)
    w = valid.astype(np.float32)
    levels = []
    cur_c, cur_w = img * w[..., None], w
    while min(cur_w.shape) > 1:
        levels.append((cur_c, cur_w))
        h, wd = cur_w.shape
        nh, nw = max(1, h // 2), max(1, wd // 2)
        cur_c = cv2.resize(cur_c, (nw, nh), interpolation=cv2.INTER_AREA)
        cur_w = cv2.resize(cur_w, (nw, nh), interpolation=cv2.INTER_AREA)
        if cur_c.ndim == 2:
            cur_c = cur_c[..., None]
    filled = cur_c / np.maximum(cur_w[..., None], 1e-8)
    for c, wl in reversed(levels):
        h, wd = wl.shape
        up = cv2.resize(filled, (wd, h), interpolation=cv2.INTER_LINEAR)
        if up.ndim == 2:
            up = up[..., None]
        own = c / np.maximum(wl[..., None], 1e-8)
        a = np.clip(wl, 0, 1)[..., None]
        filled = a * own + (1 - a) * up
    out = np.where(valid[..., None], img, filled)
    return out


@dataclass
class BakeStats:
    texels: int
    seen_fraction: float
    views_used: int
    gains: list[list[float]]


def bake_texture(
    mesh: Mesh,
    views: list[View],
    size: int,
    topk: int = 3,
    exposure_compensation: bool = True,
    depth_tol: float | None = None,
    progress: SubProgress | None = None,
) -> tuple[np.ndarray, BakeStats]:
    """Bake an RGB texture (``size`` x ``size`` uint8) for a UV-mapped mesh."""
    import open3d as o3d

    assert mesh.UV is not None
    tex = rasterize_uv(mesh, size)
    M = len(tex.P)
    ext = float(np.linalg.norm(mesh.V.max(0) - mesh.V.min(0)))
    if depth_tol is None:
        depth_tol = 0.01 * ext
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(mesh.V.astype(np.float32)), o3d.core.Tensor(mesh.F.astype(np.uint32)))
    fade_px = max(4.0, 0.01 * max(views[0].width, views[0].height))

    n = len(views)
    passes = 2 if exposure_compensation and n > 1 else 1
    gains = np.ones((n, 3), np.float32)
    seen = np.zeros(M, bool)
    used_views = 0
    color = np.zeros((M, 3), np.float32)
    cache: list[_ViewSamples] = []
    cache_ok = M * n * 4 * 4 < 1.5e9  # keep samples in memory when cheap

    for p in range(passes):
        best_w = np.zeros((M, topk), np.float32)
        best_c = np.zeros((M, topk, 3), np.float32)
        used_views = 0
        for i, v in enumerate(views):
            CANCEL.check()
            if p == 0 or not cache_ok:
                s = _sample_view(scene, v, tex, depth_tol, fade_px)
                if p == 0 and cache_ok and passes > 1:
                    cache.append(s)
            else:
                s = cache[i]
            if len(s.idx) == 0:
                continue
            used_views += 1
            c = s.c * gains[i]
            col = np.argmin(best_w[s.idx], axis=1)
            cur = best_w[s.idx, col]
            better = s.w > cur
            ii, cc = s.idx[better], col[better]
            best_w[ii, cc] = s.w[better]
            best_c[ii, cc] = c[better]
            if progress is not None:
                progress.update((p + (i + 1) / n) / (passes + 0.3), f"Texturing: view {i + 1}/{n}" + (" (exposure-matched)" if p else ""))
        wmax = best_w.max(1, keepdims=True)
        seen = wmax[:, 0] > 0
        # Sharpen the blend toward the best view while keeping smooth transitions.
        wn = np.where(wmax > 0, best_w / np.maximum(wmax, 1e-30), 0) ** 4
        color = (wn[..., None] * best_c).sum(1) / np.maximum(wn.sum(1, keepdims=True), 1e-12)
        if p == 0 and passes > 1:
            # Per-view gain: median ratio between the blended reference and the view's samples.
            for i, v in enumerate(views):
                s = cache[i] if cache_ok else _sample_view(scene, v, tex, depth_tol, fade_px)
                if len(s.idx) < 200:
                    continue
                ref = color[s.idx]
                lum = s.c.mean(1)
                good = (lum > 20) & (lum < 235) & (s.w > 0.25 * np.median(s.w))
                if good.sum() < 100:
                    continue
                ratio = np.median(ref[good] / np.maximum(s.c[good], 1.0), axis=0)
                gains[i] = np.clip(ratio, 0.75, 1.33)
            # Normalise gains so the overall brightness is preserved.
            gains /= np.median(gains, axis=0, keepdims=True)

    # Unseen texels (e.g. the underside): smooth harmonic extrapolation over the surface.
    if seen.any() and (~seen).any():
        color[~seen] = harmonic_fill(mesh, tex, color, seen)[~seen]
    elif not seen.any():
        color[:] = 160.0

    img = np.zeros((size, size, 3), np.float32)
    valid = np.zeros((size, size), bool)
    img[tex.ys, tex.xs] = color
    valid[tex.ys, tex.xs] = True
    img = push_pull_fill(img, valid)
    out = np.clip(img + 0.5, 0, 255).astype(np.uint8)
    if progress is not None:
        progress.update(1.0, "Texture baked")
    stats = BakeStats(texels=M, seen_fraction=float(seen.mean()) if M else 0.0, views_used=used_views, gains=gains.round(3).tolist())
    return out, stats


def texture_mesh(
    mesh: Mesh,
    views: list[View],
    size: int,
    topk: int,
    exposure_compensation: bool,
    progress: SubProgress | None = None,
    chart_iterations: int = 1,
) -> tuple[Mesh, BakeStats]:
    if progress is not None:
        progress.update(0.02, "Unwrapping UVs")
    uvm = unwrap(mesh, size, chart_iterations=chart_iterations)
    if progress is not None:
        progress.update(0.15, "Baking texture")
    sub = progress.sub(0.15, 1.0) if progress is not None else None
    tex, stats = bake_texture(uvm, views, size, topk=topk, exposure_compensation=exposure_compensation, progress=sub)
    uvm.texture = tex
    return uvm, stats
