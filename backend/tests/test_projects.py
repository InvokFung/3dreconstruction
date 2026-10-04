from .helpers import png_bytes


def test_project_crud_and_status(api):
    c = api.c
    h, _ = api.register()
    p1 = api.project(h, "First")
    p2 = api.project(h, "Second")
    assert p1["status"] == "empty" and p1["image_count"] == 0 and p1["thumbnail_url"] is None
    assert p1["images"] == [] and p1["latest_job"] is None

    lst = c.get("/api/projects", headers=h).json()
    assert [p["name"] for p in lst] == ["Second", "First"]  # newest first
    assert "images" not in lst[0]

    r = c.patch(f"/api/projects/{p1['id']}", json={"name": "Renamed", "description": "d"}, headers=h)
    assert r.status_code == 200 and r.json()["name"] == "Renamed" and r.json()["description"] == "d"
    assert c.patch(f"/api/projects/{p1['id']}", json={"name": "  "}, headers=h).status_code == 422

    api.upload(h, p1["id"], [("a.png", png_bytes())])
    p = c.get(f"/api/projects/{p1['id']}", headers=h).json()
    assert p["status"] == "ready" and p["image_count"] == 1
    assert p["thumbnail_url"] == p["images"][0]["thumb_url"]

    assert c.delete(f"/api/projects/{p2['id']}", headers=h).status_code == 204
    assert c.get(f"/api/projects/{p2['id']}", headers=h).status_code == 404


def test_ownership_isolation(api, worker):
    c = api.c
    ha, ta = api.register()
    hb, tb = api.register()
    p = api.project_with_images(ha, 2)
    pid = p["id"]
    img = c.get(f"/api/projects/{pid}", headers=ha).json()["images"][0]
    job = c.post(f"/api/projects/{pid}/jobs", json={"engine": "photogrammetry"}, headers=ha).json()
    job = api.wait_job(ha, job["id"])
    assert job["status"] == "succeeded"
    art = job["artifacts"][0]

    assert c.get("/api/projects", headers=hb).json() == []
    for method, url in [
        ("get", f"/api/projects/{pid}"),
        ("patch", f"/api/projects/{pid}"),
        ("delete", f"/api/projects/{pid}"),
        ("get", f"/api/projects/{pid}/jobs"),
        ("post", f"/api/projects/{pid}/jobs"),
        ("delete", f"/api/projects/{pid}/images/{img['id']}"),
        ("get", f"/api/projects/{pid}/images/{img['id']}/file"),
        ("get", f"/api/jobs/{job['id']}"),
        ("post", f"/api/jobs/{job['id']}/cancel"),
        ("get", f"/api/jobs/{job['id']}/events"),
        ("get", f"/api/artifacts/{art['id']}/download"),
    ]:
        kw = {"json": {}} if method in ("patch", "post") else {}
        r = getattr(c, method)(url, headers=hb, **kw)
        assert r.status_code == 404, (method, url, r.status_code)
    r = c.post(f"/api/projects/{pid}/images", headers=hb, files=[("files", ("x.png", png_bytes(), "image/png"))])
    assert r.status_code == 404
    # ?token= of another user is also a 404
    assert c.get(f"{art['url']}?token={tb}").status_code == 404
    assert c.get(f"{art['url']}?token={ta}").status_code == 200
    # owner still sees everything
    assert c.get(f"/api/projects/{pid}", headers=ha).status_code == 200
