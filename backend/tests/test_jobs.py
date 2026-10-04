import json
import threading
import time
from datetime import timedelta

import pytest

from app import db as appdb
from app.config import get_settings
from app.models import Job, utcnow
from app.recon_runner import capabilities_cache


def read_sse(client, url, headers=None, max_seconds=20, stop_on=None):
    """Collect (event, data|None) tuples; comments are returned as ("comment", text)."""
    events = []
    end = time.monotonic() + max_seconds
    with client.stream("GET", url, headers=headers or {}) as r:
        assert r.status_code == 200, r.read()
        assert r.headers["content-type"].startswith("text/event-stream")
        ev, data = None, []
        for line in r.iter_lines():
            if line.startswith(":"):
                events.append(("comment", line[1:].strip()))
            elif line.startswith("event:"):
                ev = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].strip())
            elif line == "":
                if ev:
                    events.append((ev, json.loads("\n".join(data))))
                ev, data = None, []
            if stop_on and stop_on(events):
                break
            if time.monotonic() > end:
                break
    return events


def test_submit_validation_and_one_active(api, env):
    c = api.c
    h, _ = api.register()
    p = api.project(h)
    r = c.post(f"/api/projects/{p['id']}/jobs", json={"engine": "photogrammetry"}, headers=h)
    assert r.status_code == 400  # no images
    api.upload(h, p["id"], [("a.png", __import__("tests.helpers", fromlist=["x"]).png_bytes())])
    assert c.post(f"/api/projects/{p['id']}/jobs", json={"engine": "magic"}, headers=h).status_code == 422
    assert c.post(f"/api/projects/{p['id']}/jobs", json={"options": {"quality": "ultra"}}, headers=h).status_code == 422

    r = c.post(
        f"/api/projects/{p['id']}/jobs",
        json={"engine": "photogrammetry", "options": {"quality": "draft", "formats": ["glb", "glb"], "bogus": 1}},
        headers=h,
    )
    assert r.status_code == 201, r.text
    job = r.json()
    assert job["status"] == "queued" and job["progress"] == 0 and job["artifacts"] == []
    assert job["options"] == {
        "quality": "draft",
        "mode": "object",
        "texture_size": None,
        "target_faces": None,
        "formats": ["glb"],
        "device": "auto",
    }
    jdir = env.DATA_DIR / "jobs" / job["id"]
    cfg = json.loads((jdir / "config.json").read_text())
    assert cfg["engine"] == "photogrammetry" and cfg["quality"] == "draft" and "bogus" not in cfg
    assert [f.name for f in (jdir / "input").iterdir()] == ["0001_a.png"]

    assert c.post(f"/api/projects/{p['id']}/jobs", json={}, headers=h).status_code == 409
    assert c.get(f"/api/projects/{p['id']}", headers=h).json()["status"] == "processing"

    r = c.post(f"/api/jobs/{job['id']}/cancel", headers=h)
    assert r.status_code == 200 and r.json()["status"] == "canceled" and r.json()["finished_at"]
    assert c.post(f"/api/projects/{p['id']}/jobs", json={}, headers=h).status_code == 201
    assert len(c.get(f"/api/projects/{p['id']}/jobs", headers=h).json()) == 2


def test_job_success_end_to_end(api, worker, env):
    c = api.c
    h, tok = api.register()
    p = api.project_with_images(h, 3)
    job = c.post(f"/api/projects/{p['id']}/jobs", json={"engine": "photogrammetry"}, headers=h).json()
    job = api.wait_job(h, job["id"])
    assert job["status"] == "succeeded", job
    assert job["progress"] == 100 and job["error"] is None
    assert job["metrics"] == {"registered_images": 3, "faces": 98000}
    assert job["started_at"] and job["finished_at"]
    kinds = {a["kind"]: a for a in job["artifacts"]}
    assert set(kinds) == {"glb", "obj_zip", "ply", "usdz", "thumbnail", "report"}  # "evil" path ignored
    glb = kinds["glb"]
    assert glb["url"] == f"/api/artifacts/{glb['id']}/download" and glb["filename"] == "proj-model.glb"

    expected = {
        "glb": "model/gltf-binary",
        "usdz": "model/vnd.usdz+zip",
        "obj_zip": "application/zip",
        "ply": "application/octet-stream",
        "thumbnail": "image/png",
    }
    for kind, ctype in expected.items():
        r = c.get(f"{kinds[kind]['url']}?token={tok}")
        assert r.status_code == 200, kind
        assert r.headers["content-type"].split(";")[0] == ctype
        assert len(r.content) == kinds[kind]["size_bytes"]
    r = c.get(glb["url"], headers=h)
    assert 'filename="proj-model.glb"' in r.headers["content-disposition"]
    assert r.headers["content-disposition"].startswith("attachment")
    r = c.get(glb["url"], headers={**h, "Range": "bytes=0-3"})
    assert r.status_code == 206 and r.content == b"glTF" and r.headers["content-range"].startswith("bytes 0-3/")

    proj = c.get(f"/api/projects/{p['id']}", headers=h).json()
    assert proj["status"] == "done"
    assert proj["thumbnail_url"] == kinds["thumbnail"]["url"]
    assert proj["latest_job"]["id"] == job["id"]
    log = (env.DATA_DIR / "jobs" / job["id"] / "log.txt").read_text()
    assert "fake pipeline starting" in log and "Found 3 input files" in log and "Stage: sfm" in log


@pytest.mark.parametrize(
    "mode,code,fragment",
    [
        ("fail", "too_few_registered", "Only 2 of 18 images"),
        ("crash", "pipeline_crashed", "exit code 3"),
        ("noresult", "no_result", "without producing a result"),
        ("missing_artifacts", "no_output", "no output files"),
    ],
)
def test_job_failure_mapping(api, worker, monkeypatch, mode, code, fragment):
    monkeypatch.setenv("FAKE_RECON_MODE", mode)
    c = api.c
    h, _ = api.register()
    p = api.project_with_images(h, 2)
    job = c.post(f"/api/projects/{p['id']}/jobs", json={}, headers=h).json()
    job = api.wait_job(h, job["id"])
    assert job["status"] == "failed"
    assert job["error_code"] == code
    assert fragment in job["error"]
    assert job["artifacts"] == []
    assert c.get(f"/api/projects/{p['id']}", headers=h).json()["status"] == "failed"


@pytest.mark.parametrize("mode", ["slow", "stubborn"])
def test_cancel_running_job(api, worker, monkeypatch, env, mode):
    monkeypatch.setenv("FAKE_RECON_MODE", mode)
    c = api.c
    h, _ = api.register()
    p = api.project_with_images(h, 1)
    job = c.post(f"/api/projects/{p['id']}/jobs", json={}, headers=h).json()
    running = api.wait_job(h, job["id"], statuses=("running",))
    assert running["started_at"]
    # wait for some progress to be reported
    end = time.monotonic() + 5
    while time.monotonic() < end and c.get(f"/api/jobs/{job['id']}", headers=h).json()["stage"] != "sfm":
        time.sleep(0.05)
    t0 = time.monotonic()
    r = c.post(f"/api/jobs/{job['id']}/cancel", headers=h)
    assert r.status_code == 200 and r.json()["status"] == "running"
    final = api.wait_job(h, job["id"], timeout=15)
    assert final["status"] == "canceled"
    assert time.monotonic() - t0 < 10
    log = (env.DATA_DIR / "jobs" / job["id"] / "log.txt").read_text()
    assert "Cancel requested" in log
    if mode == "stubborn":
        assert "killing it" in log
    else:
        assert "got SIGTERM" in log


def test_job_timeout(api, worker, monkeypatch):
    monkeypatch.setenv("FAKE_RECON_MODE", "slow")
    get_settings().JOB_TIMEOUT_SECONDS = 1
    c = api.c
    h, _ = api.register()
    p = api.project_with_images(h, 1)
    job = c.post(f"/api/projects/{p['id']}/jobs", json={}, headers=h).json()
    final = api.wait_job(h, job["id"], timeout=15)
    assert final["status"] == "failed" and final["error_code"] == "timeout"
    assert "1 second limit" in final["error"]


def test_sse_stream(api, worker, monkeypatch):
    monkeypatch.setenv("FAKE_RECON_DELAY", "0.15")
    c = api.c
    h, tok = api.register()
    p = api.project_with_images(h, 2)
    job = c.post(f"/api/projects/{p['id']}/jobs", json={}, headers=h).json()
    events = read_sse(c, f"/api/jobs/{job['id']}/events?token={tok}")
    names = [e for e, _ in events if e != "comment"]
    assert names[0] == "job"
    assert names[-1] == "end"
    end = events[-1][1]
    assert end["status"] == "succeeded" and end["artifacts"]
    jobs = [d for e, d in events if e == "job"]
    assert len(jobs) >= 3
    progresses = [j["progress"] for j in jobs]
    assert progresses == sorted(progresses)
    assert {"queued", "running"} & {j["status"] for j in jobs}
    logs = [d for e, d in events if e == "log"]
    assert logs and all(set(d) == {"level", "message", "ts"} for d in logs)
    assert any("Found 2 input files" in d["message"] for d in logs)
    assert any(d["message"].startswith("Job succeeded") for d in logs)

    # a finished job: job, logs..., end - immediately
    again = read_sse(c, f"/api/jobs/{job['id']}/events", headers=h, max_seconds=5)
    assert again[0][0] == "job" and again[-1][0] == "end"
    assert c.get(f"/api/jobs/{job['id']}/events").status_code == 401


@pytest.fixture
def live_server(env, client):
    """A real uvicorn server (the TestClient buffers whole responses, so it cannot test endless streams)."""
    import socket

    import uvicorn

    from app.main import create_app

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(uvicorn.Config(create_app(env), host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    end = time.monotonic() + 10
    while not server.started and time.monotonic() < end:
        time.sleep(0.02)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    t.join(timeout=10)


def test_sse_keepalive_and_live_progress(api, live_server, env):
    import httpx

    from app.worker import Worker

    c = api.c
    h, tok = api.register()
    p = api.project_with_images(h, 1)
    job = c.post(f"/api/projects/{p['id']}/jobs", json={}, headers=h).json()  # no worker yet: stays queued
    seen: list = []
    with httpx.stream("GET", f"{live_server}/api/jobs/{job['id']}/events?token={tok}", timeout=20) as r:
        assert r.status_code == 200
        assert r.headers["x-accel-buffering"] == "no"
        started = False
        for line in r.iter_lines():
            seen.append(line)
            if line == ": keepalive" and not started:
                started = True
                w = Worker(env, write_capabilities=False)
                threading.Thread(target=w.run_once, daemon=True).start()
            if line.startswith("event: end"):
                break
    assert seen[0].startswith("retry:")
    assert "event: job" in seen and ": keepalive" in seen
    assert any('"status":"running"' in ln for ln in seen)
    assert any('"status":"succeeded"' in ln for ln in seen if ln.startswith("data:"))


def test_engines(client, monkeypatch, env):
    r = client.get("/api/engines")
    assert r.status_code == 200
    assert r.json()["engines"]["photogrammetry"]["available"] is True
    assert r.json()["engines"]["generative"]["available"] is False

    capabilities_cache.clear()
    get_settings().RECON_COMMAND = "/nonexistent/python -m recon.cli"
    r = client.get("/api/engines")
    assert r.status_code == 200
    assert r.json()["engines"]["photogrammetry"]["available"] is False


def test_unavailable_engine_rejected(api):
    h, _ = api.register()
    p = api.project_with_images(h, 1)
    r = api.c.post(f"/api/projects/{p['id']}/jobs", json={"engine": "generative"}, headers=h)
    assert r.status_code == 400 and "No CUDA GPU" in r.json()["detail"]


def test_capabilities_file_from_worker(client, env):
    from app.recon_runner import write_capabilities_file

    write_capabilities_file(
        env, {"engines": {"photogrammetry": {"available": True}, "generative": {"available": True}}, "device": "cuda"}
    )
    capabilities_cache.clear()
    get_settings().RECON_COMMAND = "/nonexistent/python"  # not used: file wins
    assert client.get("/api/engines").json()["device"] == "cuda"


def test_atomic_claim(api, env):
    from app.worker import Worker

    h, _ = api.register()
    jobs = []
    for _ in range(3):
        p = api.project_with_images(h, 1)
        jobs.append(api.c.post(f"/api/projects/{p['id']}/jobs", json={}, headers=h).json()["id"])
    workers = [Worker(env, worker_id=f"w{i}", write_capabilities=False) for i in range(6)]
    claimed: list = []
    barrier = threading.Barrier(len(workers))

    def go(w):
        barrier.wait()
        claimed.append(w.claim())

    threads = [threading.Thread(target=go, args=(w,)) for w in workers]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    got = [j for j in claimed if j]
    assert sorted(got) == sorted(jobs)  # each job claimed exactly once
    assert claimed.count(None) == 3


def test_stale_recovery(api, env):
    from app.worker import Worker

    h, _ = api.register()
    ids = []
    for _ in range(2):
        p = api.project_with_images(h, 1)
        ids.append(api.c.post(f"/api/projects/{p['id']}/jobs", json={}, headers=h).json()["id"])
    with appdb.session() as db:
        for jid, attempts in zip(ids, (1, 2), strict=True):
            j = db.get(Job, jid)
            j.status, j.worker_id, j.attempts = "running", "deadhost:1:abc", attempts
            j.heartbeat_at = utcnow() - timedelta(seconds=env.STALE_JOB_SECONDS + 5)
        db.commit()
    w = Worker(env, write_capabilities=False)
    assert w.recover_stale() == 2
    a = api.c.get(f"/api/jobs/{ids[0]}", headers=h).json()
    b = api.c.get(f"/api/jobs/{ids[1]}", headers=h).json()
    assert a["status"] == "queued"
    assert b["status"] == "failed" and b["error_code"] == "worker_lost"
    # the re-queued job then runs normally
    assert w.run_once() == ids[0]
    assert api.c.get(f"/api/jobs/{ids[0]}", headers=h).json()["status"] == "succeeded"


def test_delete_project_while_running(api, worker, monkeypatch, env):
    monkeypatch.setenv("FAKE_RECON_MODE", "slow")
    c = api.c
    h, _ = api.register()
    p = api.project_with_images(h, 1)
    job = c.post(f"/api/projects/{p['id']}/jobs", json={}, headers=h).json()
    api.wait_job(h, job["id"], statuses=("running",))
    assert c.delete(f"/api/projects/{p['id']}", headers=h).status_code == 204
    end = time.monotonic() + 10
    while time.monotonic() < end and worker._threads:
        time.sleep(0.1)
    assert not worker._threads
    assert not (env.DATA_DIR / "jobs" / job["id"]).exists()


def test_startup_recovery_same_host(api, env):
    import socket

    from app.worker import Worker

    h, _ = api.register()
    ids = []
    for _ in range(2):
        p = api.project_with_images(h, 1)
        ids.append(api.c.post(f"/api/projects/{p['id']}/jobs", json={}, headers=h).json()["id"])
    host = socket.gethostname()
    with appdb.session() as db:
        dead, alive = db.get(Job, ids[0]), db.get(Job, ids[1])
        for j in (dead, alive):
            j.status, j.attempts, j.heartbeat_at = "running", 1, utcnow()
        dead.worker_id = f"{host}:999999999:dead"  # no such pid
        alive.worker_id = f"{host}:1:alive" if __import__("os").getpid() != 1 else f"{host}:2:alive"
        db.commit()
    w = Worker(env, write_capabilities=False)
    assert w.recover_stale(startup=True) == 1
    assert api.c.get(f"/api/jobs/{ids[0]}", headers=h).json()["status"] == "queued"
    assert api.c.get(f"/api/jobs/{ids[1]}", headers=h).json()["status"] == "running"
