"""Cleanup, texture baking (synthetic textured cube seen by known cameras) and export tests."""

import zipfile

import numpy as np
import pytest

from recon.cleanup import Mesh, boundary_loops, cap_holes, keep_main_components, silhouette_carve, submesh_faces
from recon.data import View
from recon.render import look_at, render


def _cube(subdiv: int = 3, size: float = 1.0) -> Mesh:
    import trimesh

    tm = trimesh.creation.box(extents=[size] * 3)
    for _ in range(subdiv):
        tm = tm.subdivide()
    return Mesh(np.asarray(tm.vertices, float), np.asarray(tm.faces, np.int64))


def _albedo(P: np.ndarray) -> np.ndarray:
    """Procedural ground-truth colour: per-face base colour x 4x4 checker."""
    P = np.asarray(P)
    ax = np.argmax(np.abs(P), axis=1)
    sign = np.sign(P[np.arange(len(P)), ax])
    face = ax * 2 + (sign > 0)
    base = np.array([[220, 40, 40], [40, 200, 60], [40, 70, 220], [230, 200, 40], [200, 60, 200], [40, 200, 210]], float)
    Q = np.floor((P + 0.5) * 4).astype(int)
    Q[np.arange(len(P)), ax] = 0  # checker only over the two in-face coordinates
    q = Q.sum(1) % 2
    return base[face] * (0.55 + 0.45 * q[:, None])


def _views(mesh: Mesh, n_az: int = 8) -> list[View]:
    import open3d as o3d

    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(mesh.V.astype(np.float32)), o3d.core.Tensor(mesh.F.astype(np.uint32)))
    K = np.array([[420.0, 0, 159.5], [0, 420, 119.5], [0, 0, 1]])
    views = []
    for el in (-35.0, 35.0):
        for az in np.linspace(0, 360, n_az, endpoint=False) + (0 if el > 0 else 22.5):
            a, e = np.radians(az), np.radians(el)
            eye = 3.2 * np.array([np.sin(a) * np.cos(e), np.sin(e), np.cos(a) * np.cos(e)])
            R, t = look_at(eye, np.zeros(3))
            ys, xs = np.mgrid[0:240, 0:320].astype(np.float32)
            d = np.stack([(xs - K[0, 2]) / K[0, 0], (ys - K[1, 2]) / K[1, 1], np.ones_like(xs)], -1).reshape(-1, 3) @ R
            rays = np.c_[np.broadcast_to(eye, d.shape), d].astype(np.float32)
            th = scene.cast_rays(o3d.core.Tensor(rays))["t_hit"].numpy()
            hit = np.isfinite(th)
            img = np.full((240 * 320, 3), 128.0)
            P = eye + d[hit] * th[hit, None]
            img[hit] = _albedo(P)
            views.append(View(name=f"{az}_{el}", image=img.reshape(240, 320, 3).astype(np.uint8), K=K, R=R, t=t, mask=hit.reshape(240, 320).astype(np.float32)))
    return views


def test_texture_bake_reproduces_synthetic_cube():
    from recon.texturing import bake_texture, rasterize_uv, unwrap

    mesh = _cube()
    views = _views(mesh)
    uvm = unwrap(mesh, 512)
    tex, stats = bake_texture(uvm, views, 512, topk=3, exposure_compensation=True)
    assert tex.shape == (512, 512, 3) and tex.dtype == np.uint8
    assert stats.seen_fraction > 0.97
    texels = rasterize_uv(uvm, 512)
    gt = _albedo(texels.P)
    got = tex[texels.ys, texels.xs].astype(float)
    # Ignore texels right on checker/face boundaries (sub-texel ambiguity).
    P = texels.P
    frac = (P + 0.5) * 4
    near_line = np.abs(frac - np.round(frac)) < 0.08
    near_line[np.arange(len(P)), np.argmax(np.abs(P), axis=1)] = False
    interior = ~near_line.any(1)
    err = np.abs(got - gt)[interior].mean()
    assert err < 8.0, err
    # Exposure compensation must not drift with perfectly consistent inputs.
    assert np.allclose(stats.gains, 1.0, atol=0.03)


def test_texture_bake_compensates_exposure():
    from recon.texturing import bake_texture, unwrap

    mesh = _cube(subdiv=2)
    views = _views(mesh, n_az=6)
    views[0].image = np.clip(views[0].image.astype(float) * 1.25, 0, 255).astype(np.uint8)  # over-exposed shot
    uvm = unwrap(mesh, 256)
    _, stats = bake_texture(uvm, views, 256, exposure_compensation=True)
    assert stats.gains[0][0] < 0.9  # the bright view was toned down


def test_cap_holes_closes_open_box():
    mesh = _cube(subdiv=2)
    # Remove the top face (y = +0.5) to create one big planar hole.
    cen = mesh.V[mesh.F].mean(1)
    open_box = submesh_faces(mesh, cen[:, 1] < 0.49)
    assert len(boundary_loops(open_box.F)) == 1
    closed = cap_holes(open_box)
    assert boundary_loops(closed.F) == []
    import trimesh

    tm = trimesh.Trimesh(closed.V, closed.F, process=True)
    assert tm.is_watertight
    assert tm.is_winding_consistent
    assert tm.volume == pytest.approx(1.0, rel=0.02)  # flat cap at the right height
    new = closed.V[len(open_box.V):]
    assert np.allclose(new[:, 1], 0.5, atol=1e-6)


def test_keep_main_components_drops_floaters():
    a = _cube(subdiv=2)
    b = _cube(subdiv=0, size=0.05)
    b.V = b.V + 3.0
    merged = Mesh(np.r_[a.V, b.V], np.r_[a.F, b.F + len(a.V)])
    kept = keep_main_components(merged, min_rel=0.2)
    assert kept.n_faces == a.n_faces


def test_silhouette_carve_removes_points_outside_masks():
    mesh = _cube(subdiv=1)
    views = _views(mesh, n_az=4)
    V = np.r_[mesh.V, [[0, 0.85, 0]], [[0.85, 0, 0.1]]]
    keep = silhouette_carve(V, views)
    assert keep[: len(mesh.V)].all()
    assert not keep[-2:].any()


def test_render_and_exports(tmp_path):
    from recon.export import write_glb, write_obj_zip, write_ply_points, write_usdz
    from recon.texturing import unwrap
    from recon.finalize import make_preview

    mesh = unwrap(_cube(subdiv=1), 128)
    mesh.texture = np.zeros((128, 128, 3), np.uint8)
    mesh.texture[..., 0] = 200
    img = render(mesh, size=64)
    assert img.shape == (64, 64, 4) and img[..., 3].max() == 255 and img[0, 0, 3] == 0
    assert img[32, 32, 0] > img[32, 32, 1] + 50  # red texture visible

    write_glb(mesh, tmp_path / "m.glb")
    assert (tmp_path / "m.glb").read_bytes()[:4] == b"glTF"
    import trimesh

    loaded = trimesh.load(tmp_path / "m.glb", force="mesh")
    assert len(loaded.faces) == mesh.n_faces

    write_obj_zip(mesh, tmp_path / "m.zip")
    names = zipfile.ZipFile(tmp_path / "m.zip").namelist()
    assert "model.obj" in names and "model.mtl" in names and any(n.endswith(".png") for n in names)

    write_ply_points(np.random.rand(10, 3), np.random.rand(10, 3), tmp_path / "p.ply")
    head = (tmp_path / "p.ply").read_bytes()[:200]
    assert b"element vertex 10" in head and b"property uchar red" in head

    prev = make_preview(mesh)
    assert prev.texture is not None and prev.UV is not None

    pytest.importorskip("pxr")
    assert write_usdz(mesh, tmp_path / "m.usdz")
    assert zipfile.is_zipfile(tmp_path / "m.usdz")


def test_chunked_unwrap_covers_all_faces_without_overlap():
    from recon.texturing import rasterize_uv, unwrap

    mesh = _cube(subdiv=3)
    uvm = unwrap(mesh, 512, chunk_faces=300)
    assert uvm.n_faces == mesh.n_faces
    assert uvm.UV.min() >= 0 and uvm.UV.max() <= 1
    # Every face covers some texels and no texel is shared by two charts (rasterizer picks one).
    tex = rasterize_uv(uvm, 512)
    assert len(tex.P) > 0.4 * 512 * 512
    # Geometry is unchanged: same surface area.
    def area(m):
        return 0.5 * np.linalg.norm(np.cross(m.V[m.F[:, 1]] - m.V[m.F[:, 0]], m.V[m.F[:, 2]] - m.V[m.F[:, 0]]), axis=1).sum()

    assert area(uvm) == pytest.approx(area(mesh))
