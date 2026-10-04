import io

import pytest
from PIL import Image

from app.config import get_settings

from .helpers import jpeg_bytes, mp4_bytes, png_bytes


def test_upload_images_and_thumbs(api, env):
    c = api.c
    h, tok = api.register()
    p = api.project(h)
    r = api.upload(h, p["id"], [("../../evil name?.JPG", jpeg_bytes(1600, 1200)), ("b.png", png_bytes(300, 200))])
    assert r.status_code == 201, r.text
    imgs = r.json()
    assert [i["kind"] for i in imgs] == ["image", "image"]
    a = imgs[0]
    assert a["filename"] == "evil_name_.JPG"
    assert (a["width"], a["height"]) == (1600, 1200)
    assert a["size_bytes"] > 0
    assert a["url"] == f"/api/projects/{p['id']}/images/{a['id']}/file"
    assert a["thumb_url"] == a["url"] + "?thumb=1"

    t = c.get(a["thumb_url"], headers=h)
    assert t.status_code == 200 and t.headers["content-type"] == "image/jpeg"
    im = Image.open(io.BytesIO(t.content))
    assert max(im.size) <= 384 and im.format == "JPEG"
    # ?token= works for <img src>
    assert c.get(f"{a['thumb_url']}&token={tok}").status_code == 200
    orig = c.get(f"{a['url']}?token={tok}")
    assert orig.status_code == 200 and orig.headers["content-type"] == "image/jpeg"
    assert len(orig.content) == a["size_bytes"]

    files = list((env.DATA_DIR / "projects" / p["id"] / "images").iterdir())
    assert len(files) == 2 and all(f.name.split(".")[0] in {a["id"], imgs[1]["id"]} for f in files)


def test_upload_video(api):
    h, _ = api.register()
    p = api.project(h)
    r = api.upload(h, p["id"], [("clip.mov", mp4_bytes()), ("x.webm", b"\x1a\x45\xdf\xa3" + b"\x00" * 100)])
    assert r.status_code == 201, r.text
    v = r.json()
    assert [x["kind"] for x in v] == ["video", "video"]
    assert v[0]["width"] is None and v[0]["filename"] == "clip.mov"
    assert api.c.get(v[0]["thumb_url"], headers=h).headers["content-type"] == "image/jpeg"


@pytest.mark.parametrize(
    "name,data",
    [
        ("notes.txt", b"hello world"),
        ("fake.jpg", b"this is not a jpeg at all" * 10),
        ("empty.png", b""),
        ("anim.gif", None),
    ],
)
def test_upload_rejected_types(api, name, data):
    if data is None:
        buf = io.BytesIO()
        Image.new("RGB", (10, 10)).save(buf, "GIF")
        data = buf.getvalue()
    h, _ = api.register()
    p = api.project(h)
    r = api.upload(h, p["id"], [("good.png", png_bytes()), (name, data)])
    assert r.status_code in (400, 415), r.text
    assert isinstance(r.json()["detail"], str)
    # all-or-nothing: the good file was not kept
    proj = api.c.get(f"/api/projects/{p['id']}", headers=h).json()
    assert proj["image_count"] == 0


def test_upload_limits(api, env):
    h, _ = api.register()
    p = api.project(h)
    get_settings().MAX_UPLOAD_MB = 1
    r = api.upload(h, p["id"], [("big.mp4", mp4_bytes(2 * 1024 * 1024))])
    assert r.status_code == 413 and "MB" in r.json()["detail"]
    get_settings().MAX_UPLOAD_MB = 50
    get_settings().MAX_FILES_PER_PROJECT = 2
    assert api.upload(h, p["id"], [("a.png", png_bytes()), ("b.png", png_bytes())]).status_code == 201
    r = api.upload(h, p["id"], [("c.png", png_bytes())])
    assert r.status_code == 400 and "at most 2" in r.json()["detail"]
    leftovers = [f for f in (env.DATA_DIR / "projects" / p["id"] / "images").iterdir() if f.name.startswith(".upload")]
    assert leftovers == []


def test_heic_upload(api):
    pillow_heif = pytest.importorskip("pillow_heif")
    buf = io.BytesIO()
    try:
        pillow_heif.from_pillow(Image.new("RGB", (64, 32), (10, 200, 10))).save(buf, quality=80)
    except Exception as e:  # encoder not available in this build
        pytest.skip(f"cannot encode HEIC: {e}")
    h, _ = api.register()
    p = api.project(h)
    r = api.upload(h, p["id"], [("IMG_0001.HEIC", buf.getvalue())])
    assert r.status_code == 201, r.text
    img = r.json()[0]
    assert img["kind"] == "image" and (img["width"], img["height"]) == (64, 32)
    assert api.c.get(img["thumb_url"], headers=h).status_code == 200


def test_delete_image_and_project_files(api, env):
    c = api.c
    h, _ = api.register()
    p = api.project_with_images(h, 2)
    proj = c.get(f"/api/projects/{p['id']}", headers=h).json()
    img = proj["images"][0]
    assert c.delete(f"/api/projects/{p['id']}/images/{img['id']}", headers=h).status_code == 204
    assert c.get(img["url"], headers=h).status_code == 404
    assert c.get(f"/api/projects/{p['id']}", headers=h).json()["image_count"] == 1

    job = c.post(f"/api/projects/{p['id']}/jobs", json={}, headers=h).json()
    pdir = env.DATA_DIR / "projects" / p["id"]
    jdir = env.DATA_DIR / "jobs" / job["id"]
    assert pdir.exists() and jdir.exists()
    assert c.delete(f"/api/projects/{p['id']}", headers=h).status_code == 204
    assert not pdir.exists() and not jdir.exists()
