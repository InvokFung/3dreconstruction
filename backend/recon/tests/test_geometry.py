import numpy as np
import pytest

from recon.geometry import (
    Similarity,
    backproject,
    bilinear_sample,
    fit_plane_ransac,
    fit_scale_shift,
    rotation_about_y,
    rotation_between,
    up_from_cameras,
)


def test_fit_scale_shift_recovers_affine_with_outliers():
    rng = np.random.default_rng(0)
    pred = rng.uniform(1, 5, 2000)
    target = 2.5 * pred + 0.7
    target *= 1 + rng.normal(0, 0.002, pred.shape)
    target[:400] = rng.uniform(0.5, 30, 400)  # 20% gross outliers
    fit = fit_scale_shift(pred, target)
    assert fit.scale == pytest.approx(2.5, rel=0.01)
    assert fit.shift == pytest.approx(0.7, abs=0.05)
    assert 0.75 < fit.inlier_ratio < 0.85
    assert fit.residual < 0.01


def test_fit_scale_shift_inverse_depth_space():
    # Mono networks predict affine-invariant *inverse* depth; the fit must work there too.
    rng = np.random.default_rng(1)
    z = rng.uniform(1.0, 4.0, 500)
    disp = (1.0 / z - 0.05) / 0.8  # target = 0.8 * disp + 0.05
    fit = fit_scale_shift(disp, 1.0 / z)
    assert fit.scale == pytest.approx(0.8, rel=1e-3)
    assert fit.shift == pytest.approx(0.05, abs=1e-3)


def test_fit_scale_only_and_degenerate_inputs():
    fit = fit_scale_shift(np.array([1.0, 2.0]), np.array([3.0, 6.0]))
    assert fit.scale == pytest.approx(3.0)
    assert fit.shift == 0.0
    empty = fit_scale_shift(np.array([]), np.array([]))
    assert empty.n == 0 and empty.scale == 1.0
    nan = fit_scale_shift(np.array([np.nan, 1, 2, 3]), np.array([1, 2, 4, 6.0]))
    assert nan.n == 3


def test_plane_ransac():
    rng = np.random.default_rng(2)
    xy = rng.uniform(-1, 1, (500, 2))
    pts = np.c_[xy[:, 0], np.full(500, -0.3), xy[:, 1]] + rng.normal(0, 0.002, (500, 3))
    pts = np.r_[pts, rng.uniform(-1, 1, (200, 3))]
    n, d, inl = fit_plane_ransac(pts, threshold=0.01)
    assert abs(abs(n[1]) - 1) < 1e-3
    assert abs(abs(d) - 0.3) < 0.01
    assert inl[:500].mean() > 0.98


def test_rotations():
    a = np.array([0.3, -0.9, 0.2])
    a /= np.linalg.norm(a)
    for b in (np.array([0, 1.0, 0]), -a, a):
        R = rotation_between(a, b)
        assert np.allclose(R @ a, b / np.linalg.norm(b), atol=1e-9)
        assert np.allclose(R @ R.T, np.eye(3), atol=1e-9)
        assert np.linalg.det(R) == pytest.approx(1.0)
    Ry = rotation_about_y(np.pi / 2)
    assert np.allclose(Ry @ [0, 0, 1], [1, 0, 0], atol=1e-12)


def test_up_from_cameras_level_cameras():
    # OpenCV cameras looking horizontally: camera +y (row 1 of R) points down = world -Y.
    Rs = []
    for yaw in np.linspace(0, 2 * np.pi, 8, endpoint=False):
        f = np.array([np.sin(yaw), 0, np.cos(yaw)])
        r = np.cross(f, [0, 1, 0])
        r /= np.linalg.norm(r)
        d = np.cross(f, r)
        Rs.append(np.stack([r, d, f]))
    assert np.allclose(up_from_cameras(Rs), [0, 1, 0], atol=1e-9)


def test_similarity_compose_and_apply():
    T1 = Similarity(2.0, rotation_about_y(0.3), np.array([1.0, 2, 3]))
    T2 = Similarity(0.5, rotation_between(np.array([1.0, 0, 0]), np.array([0, 0, 1.0])), np.array([-1.0, 0, 0]))
    X = np.random.default_rng(3).normal(size=(10, 3))
    assert np.allclose(T1.compose(T2).apply(X), T1.apply(T2.apply(X)))
    M = T1.matrix()
    assert np.allclose((np.c_[X, np.ones(10)] @ M.T)[:, :3], T1.apply(X))


def test_bilinear_sample_matches_analytic():
    yy, xx = np.mgrid[0:20, 0:30].astype(np.float32)
    img = 2 * xx + 3 * yy
    x = np.array([0.0, 5.25, 10.5, 28.9])
    y = np.array([0.0, 3.75, 7.5, 18.1])
    assert np.allclose(bilinear_sample(img, x, y), 2 * x + 3 * y, atol=1e-4)
    rgb = np.dstack([img, img * 0, img])
    out = bilinear_sample(rgb, x, y)
    assert out.shape == (4, 3)
    # Large queries (cv2.remap is limited to 32767 rows).
    big = bilinear_sample(img, np.full(100_000, 3.5), np.full(100_000, 2.0))
    assert big.shape == (100_000,)


def test_backproject_roundtrip():
    K = np.array([[100.0, 0, 31.5], [0, 100, 23.5], [0, 0, 1]])
    R = rotation_about_y(0.4)
    t = np.array([0.1, -0.2, 2.0])
    depth = np.full((48, 64), 3.0, np.float32)
    X, idx = backproject(depth, K, R, t)
    Xc = X @ R.T + t
    assert np.allclose(Xc[:, 2], 3.0)
    u = Xc[:, 0] / Xc[:, 2] * K[0, 0] + K[0, 2]
    ys, xs = np.divmod(idx, 64)
    assert np.allclose(u, xs, atol=1e-6)
