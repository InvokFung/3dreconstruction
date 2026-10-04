import pytest

from app.config import DEFAULT_SECRET_KEY, Settings, get_settings


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok" and r.json()["version"]


def test_register_login_me(client):
    r = client.post("/api/auth/register", json={"email": "Alice@Example.com", "password": "s3cret-pass", "name": "Alice"})
    assert r.status_code == 201
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["user"]["email"] == "alice@example.com"
    assert set(body["user"]) == {"id", "email", "name", "created_at"}

    r = client.post("/api/auth/register", json={"email": "alice@example.com", "password": "another-pass", "name": "A"})
    assert r.status_code == 409 and isinstance(r.json()["detail"], str)

    r = client.post("/api/auth/login", json={"email": "ALICE@example.com", "password": "s3cret-pass"})
    assert r.status_code == 200
    tok = r.json()["access_token"]
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {tok}"})
    assert me.status_code == 200 and me.json()["name"] == "Alice"

    assert client.post("/api/auth/login", json={"email": "alice@example.com", "password": "wrong-pass"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "nobody@example.com", "password": "wrong-pass"}).status_code == 401


def test_auth_required_and_bad_token(client):
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/projects").status_code == 401
    r = client.get("/api/auth/me", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401 and r.json() == {"detail": "Invalid or expired token"}
    # query-string tokens are only accepted on the media/SSE endpoints
    tok = client.post("/api/auth/register", json={"email": "q@example.com", "password": "password1"}).json()["access_token"]
    assert client.get(f"/api/auth/me?token={tok}").status_code == 401


def test_validation_errors_are_strings(client):
    r = client.post("/api/auth/register", json={"email": "not-an-email", "password": "short"})
    assert r.status_code == 422
    assert isinstance(r.json()["detail"], str) and "password" in r.json()["detail"]


def test_rate_limit(client):
    get_settings().AUTH_RATE_LIMIT = 3
    codes = [client.post("/api/auth/login", json={"email": "x@example.com", "password": "whatever1"}).status_code for _ in range(5)]
    assert codes[:3] == [401, 401, 401]
    assert codes[3:] == [429, 429]


def test_production_refuses_default_secret():
    with pytest.raises(RuntimeError):
        Settings(ENV="production", SECRET_KEY=DEFAULT_SECRET_KEY).validate_for_runtime()
    with pytest.raises(RuntimeError):
        Settings(ENV="production", SECRET_KEY="short").validate_for_runtime()
    Settings(ENV="production", SECRET_KEY="x" * 40).validate_for_runtime()
    Settings(ENV="development").validate_for_runtime()


def test_cors(client):
    r = client.options(
        "/api/projects",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"
