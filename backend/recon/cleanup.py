"""Mesh cleanup: silhouette carving, ground removal, floaters, holes, smoothing, decimation,
and the final gravity/scale/origin normalisation."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import cv2
import numpy as np

from .data import View
from .geometry import Similarity, fit_plane_ransac, rotation_about_y, rotation_between, up_from_cameras

log = logging.getLogger("recon")


@dataclass
class Mesh:
    V: np.ndarray  # (n,3) float64
    F: np.ndarray  # (m,3) int64
    C: np.ndarray | None = None  # (n,3) float in [0,1] vertex colours
    UV: np.ndarray | None = None  # (n,2) texture coords (when textured)
    texture: np.ndarray | None = None  # HxWx3 uint8
    meta: dict = field(default_factory=dict)

    @property
    def n_faces(self) -> int:
        return int(len(self.F))

    def copy(self) -> "Mesh":
        return Mesh(
            self.V.copy(),
            self.F.copy(),
            None if self.C is None else self.C.copy(),
            None if self.UV is None else self.UV.copy(),
            self.texture,
            dict(self.meta),
        )


def from_o3d(m) -> Mesh:  # type: ignore[no-untyped-def]
    V = np.asarray(m.vertices, dtype=np.float64)
    F = np.asarray(m.triangles, dtype=np.int64)
    C = np.asarray(m.vertex_colors, dtype=np.float64) if m.has_vertex_colors() else None
    return Mesh(V.copy(), F.copy(), None if C is None else C.copy())


def to_o3d(mesh: Mesh):  # type: ignore[no-untyped-def]
    import open3d as o3d

    m = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(mesh.V), o3d.utility.Vector3iVector(mesh.F.astype(np.int32)))
    if mesh.C is not None and len(mesh.C) == len(mesh.V):
        m.vertex_colors = o3d.utility.Vector3dVector(np.clip(mesh.C, 0, 1))
    return m


def submesh_vertices(mesh: Mesh, keep_v: np.ndarray) -> Mesh:
    """Keep faces whose three vertices are kept; drop unreferenced vertices."""
    keep_f = keep_v[mesh.F].all(1)
    return submesh_faces(mesh, keep_f)


def submesh_faces(mesh: Mesh, keep_f: np.ndarray) -> Mesh:
    F = mesh.F[keep_f]
    used = np.unique(F)
    remap = -np.ones(len(mesh.V), dtype=np.int64)
    remap[used] = np.arange(len(used))
    return Mesh(
        mesh.V[used],
        remap[F],
        None if mesh.C is None else mesh.C[used],
        None if mesh.UV is None else mesh.UV[used],
        mesh.texture,
        dict(mesh.meta),
    )


# ---------------------------------------------------------------------------------------------
# Carving / ground
# ---------------------------------------------------------------------------------------------


def silhouette_carve(V: np.ndarray, views: list[View], dilate_px: int = 4, min_votes: int = 2, rel_votes: float = 0.2) -> np.ndarray:
    """Vertices that fall outside the (dilated) subject mask in enough views -> False.

    Returns a keep mask. A vertex is removed when it projects outside the mask in at least
    ``max(min_votes, rel_votes * n_in_frame)`` of the views in which it is inside the frame.
    """
    outside = np.zeros(len(V), np.int32)
    in_frame = np.zeros(len(V), np.int32)
    kernel = np.ones((2 * dilate_px + 1, 2 * dilate_px + 1), np.uint8)
    for v in views:
        if v.mask is None:
            continue
        m = cv2.dilate((v.mask > 0.5).astype(np.uint8), kernel)
        uv, z = v.project(V)
        x = np.round(uv[:, 0]).astype(np.int64)
        y = np.round(uv[:, 1]).astype(np.int64)
        ok = (z > 0) & (x >= 0) & (x < v.width) & (y >= 0) & (y < v.height)
        in_frame += ok
        inside = np.zeros(len(V), bool)
        inside[ok] = m[y[ok], x[ok]] > 0
        outside += ok & ~inside
    thresh = np.maximum(min_votes, np.ceil(rel_votes * in_frame))
    return outside < thresh


def estimate_up(views: list[View], points: np.ndarray, extent: float, center: np.ndarray, object_mode: bool) -> tuple[np.ndarray, tuple[np.ndarray, float] | None]:
    """Gravity-up direction and (optionally) the supporting ground plane ``n.x + d = 0``.

    Camera up vectors give a first estimate. A dominant plane in the sparse points that is
    roughly perpendicular to it (within 25 degrees) and lies below the subject refines it.
    """
    up = up_from_cameras([v.R for v in views])
    # Orbits: the normal of the camera-centre plane is also a good up estimate.
    C = np.stack([v.center for v in views])
    if len(C) >= 6:
        c0 = C.mean(0)
        _, s, vt = np.linalg.svd(C - c0)
        if s[2] < 0.25 * s[1]:
            n = vt[2] * (1 if vt[2] @ up > 0 else -1)
            if n @ up > np.cos(np.radians(30)):
                up = n / np.linalg.norm(n)
    plane = None
    if len(points) >= 50:
        # Only consider points near the subject (within 1.5 extents).
        near = points[np.linalg.norm(points - center, axis=1) < 1.5 * extent]
        if len(near) >= 50:
            res = fit_plane_ransac(near, threshold=0.01 * extent, iters=800)
            if res is not None:
                n, d, inl = res
                if n @ up < 0:
                    n, d = -n, -d
                frac = inl.mean()
                below = (center @ n + d) > 0  # subject centre above the plane
                if n @ up > np.cos(np.radians(25)) and frac > 0.15 and below:
                    up = n
                    plane = (n, d)
    return up / np.linalg.norm(up), plane


def sparse_roi(points: np.ndarray, errors: np.ndarray | None = None, pad: float = 0.1) -> tuple[np.ndarray, np.ndarray] | None:
    """Robust axis-aligned box around well-triangulated SfM points (scene-mode crop)."""
    P = points
    if errors is not None and len(errors) == len(points):
        P = points[errors < max(2.0, float(np.percentile(errors, 80)))]
    if len(P) < 50:
        return None
    lo, hi = np.percentile(P, 1, axis=0), np.percentile(P, 99, axis=0)
    size = hi - lo
    return lo - pad * size.max(), hi + pad * size.max()


def cut_below_plane(mesh: Mesh, plane: tuple[np.ndarray, float], eps: float) -> Mesh:
    n, d = plane
    h = mesh.V @ n + d
    return submesh_vertices(mesh, h > eps)


# ---------------------------------------------------------------------------------------------
# Topology cleanup
# ---------------------------------------------------------------------------------------------


def keep_main_components(mesh: Mesh, min_rel: float = 0.2, center: np.ndarray | None = None) -> Mesh:
    """Drop floaters: keep the largest connected component and any with >= ``min_rel`` of its area."""
    o = to_o3d(mesh)
    labels, counts, areas = o.cluster_connected_triangles()
    labels = np.asarray(labels)
    areas = np.asarray(areas)
    if len(areas) <= 1:
        return mesh
    main = int(np.argmax(areas))
    keep_ids = set(np.flatnonzero(areas >= min_rel * areas[main]).tolist()) | {main}
    keep_f = np.isin(labels, list(keep_ids))
    out = submesh_faces(mesh, keep_f)
    log.info("Removed %d floating fragments", len(areas) - len(keep_ids))
    return out


def basic_clean(mesh: Mesh) -> Mesh:
    o = to_o3d(mesh)
    o.remove_duplicated_vertices()
    o.remove_degenerate_triangles()
    o.remove_duplicated_triangles()
    o.remove_non_manifold_edges()
    o.remove_unreferenced_vertices()
    return from_o3d(o)


def fill_holes(mesh: Mesh, max_hole_size: float) -> Mesh:
    """Close holes whose size is below ``max_hole_size`` (model units)."""
    try:
        import open3d as o3d

        t = o3d.t.geometry.TriangleMesh.from_legacy(to_o3d(mesh))
        filled = t.fill_holes(hole_size=float(max_hole_size)).to_legacy()
        out = from_o3d(filled)
        if out.C is None and mesh.C is not None:
            out.C = _nearest_colors(mesh, out.V)
        elif out.C is not None and mesh.C is not None and len(out.C) == len(out.V):
            # New cap vertices get colours of their nearest original vertex.
            out.C = _nearest_colors(mesh, out.V)
        return out
    except Exception as e:  # pragma: no cover - VTK edge cases
        log.warning("Hole filling failed (%s); keeping holes", e)
        return mesh


def boundary_loops(F: np.ndarray) -> list[np.ndarray]:
    """Ordered boundary vertex loops. Each loop follows the direction of its incident face's
    edge (a -> b), so a cap must use the reverse orientation."""
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    key = np.minimum(e[:, 0], e[:, 1]) * (int(F.max()) + 1) + np.maximum(e[:, 0], e[:, 1])
    _, inv, cnt = np.unique(key, return_inverse=True, return_counts=True)
    bnd = e[cnt[inv] == 1]
    nxt: dict[int, list[int]] = {}
    for a, b in bnd:
        nxt.setdefault(int(a), []).append(int(b))
    loops: list[np.ndarray] = []
    used: set[tuple[int, int]] = set()
    for a0, b0 in bnd:
        a0, b0 = int(a0), int(b0)
        if (a0, b0) in used:
            continue
        loop = [a0]
        used.add((a0, b0))
        cur = b0
        ok = True
        while cur != a0:
            loop.append(cur)
            cands = [c for c in nxt.get(cur, []) if (cur, c) not in used]
            if not cands or len(loop) > len(bnd) + 1:
                ok = False
                break
            used.add((cur, cands[0]))
            cur = cands[0]
        if ok and len(loop) >= 3:
            loops.append(np.array(loop, dtype=np.int64))
    return loops


def cap_holes(mesh: Mesh, max_perimeter: float | None = None, max_loops: int = 200) -> Mesh:
    """Close boundary loops with a well-tessellated harmonic membrane.

    For each loop we build concentric rings shrinking towards the loop centroid, stitch them
    with triangle strips (consistently oriented with the surrounding surface), and then solve a
    Laplace equation for the interior vertices with the boundary fixed. Planar loops (the unseen
    top/bottom of a box) give flat caps; curved loops give a smooth minimal-like patch.
    """
    from scipy.sparse import coo_matrix
    from scipy.sparse.linalg import spsolve

    loops = boundary_loops(mesh.F)
    if not loops:
        return mesh
    loops = sorted(loops, key=len, reverse=True)[:max_loops]
    V = [mesh.V]
    F = [mesh.F]
    C = [mesh.C] if mesh.C is not None else None
    nv = len(mesh.V)
    new_ids_all: list[np.ndarray] = []
    new_faces_all: list[np.ndarray] = []
    for loop in loops:
        P = mesh.V[loop]
        seg = np.linalg.norm(np.roll(P, -1, 0) - P, axis=1)
        perim = float(seg.sum())
        if max_perimeter is not None and perim > max_perimeter:
            continue
        m = len(loop)
        c = P.mean(0)
        radius = float(np.median(np.linalg.norm(P - c, axis=1)))
        step = max(float(np.median(seg)), 1e-12)
        rings = int(np.clip(round(radius / step), 1, 60))
        # Reverse orientation for the cap.
        lp = loop[::-1]
        Pr = mesh.V[lp]
        ring_ids = [lp]
        verts = []
        for k in range(1, rings):
            a = 1.0 - k / rings
            ids = np.arange(nv, nv + m)
            verts.append(c + a * (Pr - c))
            nv += m
            ring_ids.append(ids)
        center_id = nv
        verts.append(c[None])
        nv += 1
        faces = []
        for k in range(len(ring_ids) - 1):
            r0, r1 = ring_ids[k], ring_ids[k + 1]
            r0n, r1n = np.roll(r0, -1), np.roll(r1, -1)
            faces.append(np.stack([r0, r0n, r1n], 1))
            faces.append(np.stack([r0, r1n, r1], 1))
        last = ring_ids[-1]
        faces.append(np.stack([last, np.roll(last, -1), np.full(m, center_id)], 1))
        Fn = np.concatenate(faces)
        Vn = np.concatenate(verts)
        V.append(Vn)
        F.append(Fn)
        if C is not None:
            Cn = np.repeat(mesh.C[lp].mean(0, keepdims=True), len(Vn), 0)
            C.append(Cn)
        new_ids_all.append(np.arange(nv - len(Vn), nv))
        new_faces_all.append(Fn)
    if not new_ids_all:
        return mesh
    Vall = np.concatenate(V)
    Fall = np.concatenate(F)
    # Harmonic (uniform Laplacian) solve for new interior vertices, boundary fixed.
    new_ids = np.concatenate(new_ids_all)
    capF = np.concatenate(new_faces_all)
    e = np.concatenate([capF[:, [0, 1]], capF[:, [1, 2]], capF[:, [2, 0]]])
    e = np.concatenate([e, e[:, ::-1]])
    e = np.unique(e, axis=0)
    is_new = np.zeros(len(Vall), bool)
    is_new[new_ids] = True
    loc = -np.ones(len(Vall), np.int64)
    loc[new_ids] = np.arange(len(new_ids))
    ee = e[is_new[e[:, 0]]]
    n = len(new_ids)
    deg = np.bincount(loc[ee[:, 0]], minlength=n).astype(np.float64)
    rows, cols, vals = [np.arange(n)], [np.arange(n)], [deg]
    inner = is_new[ee[:, 1]]
    rows.append(loc[ee[inner, 0]])
    cols.append(loc[ee[inner, 1]])
    vals.append(-np.ones(int(inner.sum())))
    A = coo_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n)).tocsr()
    B = np.zeros((n, 3))
    outer = ~inner
    np.add.at(B, loc[ee[outer, 0]], Vall[ee[outer, 1]])
    X = spsolve(A, B)
    Vall[new_ids] = np.asarray(X).reshape(n, 3)
    out = Mesh(Vall, Fall, None if C is None else np.concatenate(C), None, None, dict(mesh.meta))
    log.info("Capped %d holes", len(new_ids_all))
    return out


def _nearest_colors(src: Mesh, V: np.ndarray) -> np.ndarray | None:
    if src.C is None:
        return None
    from scipy.spatial import cKDTree

    _, idx = cKDTree(src.V).query(V, k=1)
    return src.C[idx]


def smooth(mesh: Mesh, iterations: int = 5) -> Mesh:
    if iterations <= 0:
        return mesh
    o = to_o3d(mesh).filter_smooth_taubin(number_of_iterations=iterations)
    out = from_o3d(o)
    out.C = mesh.C if out.C is None else out.C
    return out


def decimate(mesh: Mesh, target_faces: int) -> Mesh:
    if mesh.n_faces <= target_faces:
        return mesh
    o = to_o3d(mesh).simplify_quadric_decimation(target_number_of_triangles=int(target_faces))
    out = from_o3d(o)
    return out


def cleanup_mesh(
    mesh: Mesh,
    views: list[View],
    object_mode: bool,
    plane: tuple[np.ndarray, float] | None,
    voxel: float,
    extent: float,
    target_faces: int,
    smooth_iters: int = 3,
    roi: tuple[np.ndarray, np.ndarray] | None = None,
) -> Mesh:
    n0 = mesh.n_faces
    mesh = basic_clean(mesh)
    if roi is not None:
        lo, hi = roi
        inside = ((mesh.V >= lo) & (mesh.V <= hi)).all(1)
        mesh = submesh_vertices(mesh, inside)
        log.info("Cropped %d vertices outside the reconstructed region", int((~inside).sum()))
    if object_mode and any(v.mask is not None for v in views):
        keep = silhouette_carve(mesh.V, views)
        mesh = submesh_vertices(mesh, keep)
        log.info("Silhouette carving removed %d vertices", int((~keep).sum()))
    if object_mode and plane is not None:
        mesh = cut_below_plane(mesh, plane, eps=1.5 * voxel)
    if mesh.n_faces == 0:
        from .errors import ReconError

        raise ReconError(
            "no_subject_found",
            "Nothing was left after isolating the subject. Make sure the object is fully in frame in most photos.",
        )
    mesh = keep_main_components(mesh, min_rel=0.25 if object_mode else 0.05)
    mesh = basic_clean(mesh)
    # Close holes: small ones always; in object mode also large openings (unseen bottom/top).
    mesh = cap_holes(mesh, max_perimeter=None if object_mode else 40 * voxel)
    mesh = basic_clean(mesh)
    mesh = smooth(mesh, smooth_iters)
    mesh = decimate(mesh, target_faces)
    mesh = basic_clean(mesh)
    mesh = keep_main_components(mesh, min_rel=0.25 if object_mode else 0.05)
    log.info("Cleanup: %d -> %d faces", n0, mesh.n_faces)
    return mesh


# ---------------------------------------------------------------------------------------------
# Normalisation (gravity up, origin, scale)
# ---------------------------------------------------------------------------------------------


def normalization_transform(
    V: np.ndarray,
    up: np.ndarray,
    views: list[View],
    metric_scale: float | None,
    object_mode: bool,
) -> tuple[Similarity, str]:
    """Similarity taking SfM coordinates to the output frame.

    Output frame (glTF convention): +Y up, metres. Objects: bottom-centre of the bounding box at
    the origin (so they sit on the ground plane), front (towards the first camera) facing +Z.
    Scenes: bounding-box centre at the origin.
    """
    R1 = rotation_between(up, np.array([0.0, 1.0, 0.0]))
    Vr = V @ R1.T
    # Yaw: first camera towards +Z.
    c0 = R1 @ views[0].center
    ctr = 0.5 * (Vr.min(0) + Vr.max(0))
    d = c0 - ctr
    yaw = np.arctan2(d[0], d[2])
    R2 = rotation_about_y(-yaw)
    R = R2 @ R1
    Vr = V @ R.T
    scale_source = "metric_estimate"
    s = metric_scale if metric_scale and np.isfinite(metric_scale) and metric_scale > 0 else None
    if s is not None:
        size = float(np.linalg.norm(Vr.max(0) - Vr.min(0))) * s
        if not (0.01 < size < 500.0):
            log.warning("Metric scale estimate gives an implausible size (%.3f m); normalising instead", size)
            s = None
    if s is None:
        diag = float(np.linalg.norm(Vr.max(0) - Vr.min(0)))
        s = 1.0 / max(diag, 1e-9)  # unit-diagonal model
        scale_source = "normalized"
    Vs = s * Vr
    lo, hi = Vs.min(0), Vs.max(0)
    if object_mode:
        t = -np.array([0.5 * (lo[0] + hi[0]), lo[1], 0.5 * (lo[2] + hi[2])])
    else:
        t = -0.5 * (lo + hi)
    return Similarity(s=float(s), R=R, t=t), scale_source
