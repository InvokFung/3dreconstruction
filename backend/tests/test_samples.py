def test_list_samples(client):
    r = client.get("/api/samples")
    assert r.status_code == 200
    s = {x["name"]: x for x in r.json()}
    assert set(s) == {"mug", "nometa"}
    assert s["mug"] == {
        "name": "mug",
        "title": "Coffee mug",
        "description": "Three photos.",
        "image_count": 3,
        "thumbnail_url": "/api/samples/mug/thumbnail",
    }
    assert s["nometa"]["title"] == "Nometa"
    t = client.get(s["mug"]["thumbnail_url"])
    assert t.status_code == 200 and t.headers["content-type"] == "image/jpeg"


def test_create_project_from_sample(api):
    c = api.c
    h, _ = api.register()
    r = c.post("/api/samples/mug/project", headers=h)
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["name"] == "Coffee mug" and p["image_count"] == 3 and p["status"] == "ready"
    assert [i["filename"] for i in p["images"]] == ["m1.png", "m2.png", "m3.png"]
    assert c.post("/api/samples/nope/project", headers=h).status_code == 404
    assert c.post("/api/samples/..%2F..%2Fetc/project", headers=h).status_code == 404
    assert c.post("/api/samples/mug/project").status_code == 401


def test_repo_samples_dir(client, monkeypatch):
    """The real repo samples/ folder is readable (meta.json may be missing for some)."""
    from app.config import REPO_ROOT, get_settings

    get_settings().SAMPLES_DIR = REPO_ROOT / "samples"
    r = client.get("/api/samples")
    assert r.status_code == 200
    for s in r.json():
        assert s["image_count"] > 0 and s["title"]
