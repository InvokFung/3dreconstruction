# Backend: API + job worker

FastAPI service (`app/`) and a DB-backed job worker (`python -m app.worker`, same package). The worker runs the
reconstruction pipeline (`recon/`, invoked as `python -m recon.cli`) **as a subprocess**. The API process never
imports the pipeline or its heavy dependencies. The contracts are in [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

```
app/
  main.py           app factory (CORS, JSON errors, request logging, routers)
  config.py         settings (env vars / .env)
  db.py, models.py  SQLAlchemy 2.x models; Alembic migrations in alembic/
  security.py       argon2 passwords, HS256 JWT, ?token= support, per-IP auth rate limit
  storage.py        DATA_DIR layout, upload sniffing (Pillow/pillow-heif, video magic), thumbnails, job logs
  services.py       image ingest, job submission, deletion
  recon_runner.py   how recon.cli is invoked + capabilities cache
  worker.py         job claiming, subprocess supervision, progress/log/artifact handling
  routers/          auth, projects (+images, jobs), jobs (+SSE), artifacts, samples, health/engines
tests/              pytest suite; tests/fake_recon/fake_cli.py is a contract-conformant fake pipeline
```

## Run locally

Easiest: from the repo root, `npm run setup` then `npm run dev` (see the root README).
By hand, with [uv](https://docs.astral.sh/uv/) (it installs Python 3.11/3.12 for you):

```bash
cd backend
uv sync                                   # API + worker + pipeline into backend/.venv (from uv.lock)
cp ../.env.example .env                   # optional; then edit as needed

# API on :8000 (runs `alembic upgrade head` at startup when AUTO_MIGRATE=true)
uv run uvicorn app.main:app --reload --reload-dir app --port 8000

# Worker, in another shell
uv run python -m app.worker
#   --once            process a single queued job and exit
#   --concurrency N   override WORKER_CONCURRENCY
```

Check that the pipeline is installed: `uv run python -m recon.cli --capabilities`.

Without uv: create a venv and `pip install -r requirements-dev.txt -r recon/requirements.txt`, then
`pip install --no-deps -r recon/requirements-nodeps.txt`. Docker and CI use these requirement files.

`RECON_PYTHON` can point the worker at a separate pipeline interpreter (by default it uses its own).
To try the whole flow without the real pipeline, point the worker at the fake:
`RECON_COMMAND="python tests/fake_recon/fake_cli.py" python -m app.worker` (`FAKE_RECON_MODE=fail|slow|...`).

The frontend dev server (`cd frontend && npm run dev`) proxies `/api` to `http://localhost:8000`.
OpenAPI docs: <http://localhost:8000/api/docs>.

## Configuration

Read from the environment or `.env` in the working directory. See `/.env.example` for the full list.

| Variable | Default | Notes |
|---|---|---|
| `ENV` | `development` | `production` refuses to start unless `SECRET_KEY` is set and at least 32 characters long |
| `DATABASE_URL` | `sqlite:///./data/app.db` | `postgresql://user:pass@host/db` uses psycopg 3 |
| `DATA_DIR` | `./data` | uploads, job dirs, thumbnails, capabilities cache |
| `SAMPLES_DIR` | `<repo>/samples` | `samples/<name>/{images/, meta.json}` (meta is optional) |
| `SECRET_KEY` | dev placeholder | HS256 JWT signing key |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `10080` | |
| `CORS_ORIGINS` | `http://localhost:5173,...` | comma-separated; `*` allowed (no cookies are used) |
| `MAX_UPLOAD_MB` / `MAX_FILES_PER_PROJECT` | `50` / `200` | per file / per project |
| `AUTH_RATE_LIMIT` / `AUTH_RATE_WINDOW_SECONDS` | `10` / `60` | per IP and endpoint, in-process |
| `WORKER_CONCURRENCY` | `1` | parallel jobs per worker process |
| `JOB_TIMEOUT_SECONDS` | `7200` | job fails with `error_code: "timeout"` |
| `CANCEL_GRACE_SECONDS` | `10` | SIGTERM, then SIGKILL after this |
| `RECON_PYTHON` | current interpreter | interpreter with the pipeline deps |
| `RECON_PATH` | `backend/` | dir containing `recon/`; prepended to `PYTHONPATH` and used as cwd |
| `RECON_COMMAND` | unset | full command prefix override (tests use the fake CLI) |
| `STALE_JOB_SECONDS` / `MAX_JOB_ATTEMPTS` | `120` / `2` | stale `running` job recovery |
| `SSE_POLL_SECONDS` / `SSE_KEEPALIVE_SECONDS` | `0.5` / `15` | |
| `LOG_LEVEL` / `LOG_FORMAT` | `INFO` / `text` | `json` for structured logs (set in Docker) |
| `AUTO_MIGRATE` | `true` | run Alembic migrations at startup |

## Storage layout

```
DATA_DIR/
  projects/<pid>/images/<image_id>.<ext>   originals (the display filename is in the DB)
  projects/<pid>/thumbs/<image_id>.jpg     <=384 px JPEG thumbnails
  jobs/<jid>/input/                        hard links (or copies) of the project's files at submission: 0001_<name>.<ext>, ...
  jobs/<jid>/output/                       written by the pipeline
  jobs/<jid>/config.json                   {"engine": ..., <options with defaults filled>}
  jobs/<jid>/log.txt                       "<ISO ts> [<level>] <message>" lines (worker notes, stderr, `log` events)
  capabilities.json                        last successful `recon.cli --capabilities` (written by the worker)
  tmp/                                     upload spool (TMPDIR in Docker)
```

## How jobs run

- `POST /api/projects/{id}/jobs` validates options, stages `input/` and `config.json`, and inserts a `queued` job. A
  partial unique index allows only one `queued`/`running` job per project, so a second submission gets 409.
- The worker claims a job atomically. On Postgres it uses `SELECT ... FOR UPDATE SKIP LOCKED`. On SQLite it does a
  conditional `UPDATE ... WHERE status='queued'` and checks the rowcount. It then runs
  `$RECON_PYTHON -m recon.cli --job-dir <dir> --config <dir>/config.json` in its own process group.
- stdout JSON lines are handled as follows. `progress` updates stage, progress and message; writes are throttled and
  progress never goes down. `log` lines are appended to `log.txt`. `result` registers artifacts (paths must stay inside
  the job dir; missing files are skipped). `error` sets `job.error`/`job.error_code`. stderr goes to `log.txt`.
- Cancel: a queued job is canceled immediately. For a running job, `cancel_requested` is set. The worker then sends
  SIGTERM to the process group and SIGKILL after `CANCEL_GRACE_SECONDS`.
- Heartbeat: running jobs update `heartbeat_at` every few seconds. Every worker periodically re-queues `running` jobs
  whose heartbeat is older than `STALE_JOB_SECONDS`. After `MAX_JOB_ATTEMPTS` they fail with `worker_lost` instead.
  On startup, jobs left by a previous worker process on the same host are recovered right away.
- On SIGTERM the worker stops claiming, stops its pipelines and re-queues their jobs.
- Error codes added by the worker: `timeout`, `pipeline_crashed`, `no_result`, `no_output`, `spawn_failed`,
  `worker_lost`, `worker_error`. Pipeline codes such as `too_few_registered` pass through unchanged.

## Tests

```bash
cd backend
~/venvs/api/bin/pytest -q                      # SQLite
TEST_DATABASE_URL=postgresql://pg:pg@localhost:5432/test ~/venvs/api/bin/pytest -q   # Postgres (schema is wiped)
~/venvs/api/bin/ruff check app tests alembic
alembic check                                  # models and migrations agree
```

The worker tests run real subprocesses of `tests/fake_recon/fake_cli.py`. They cover success with artifacts,
error mapping, crash, cancel (graceful, and SIGKILL for a process that ignores SIGTERM), timeout, SSE, and stale
recovery. One SSE test starts a real uvicorn server, because the TestClient buffers whole responses.

## Migrations

```bash
cd backend
alembic upgrade head
alembic revision --autogenerate -m "describe change"   # after editing app/models.py; review the file
```

## Deploy (docker compose)

```bash
cd deploy
cp ../.env.example .env        # set SECRET_KEY, POSTGRES_PASSWORD, CORS_ORIGINS
docker compose up -d --build   # web on http://localhost:${WEB_PORT:-8080}
# NVIDIA GPU worker:
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

Services:
- `postgres`
- `api`: slim image that runs the migrations.
- `worker`: API code plus `recon/requirements.txt`, ffmpeg and GL libraries. The model cache is the `models`
  volume mounted at `/models`, with `HF_HOME` and `TORCH_HOME` pointing into it.
- `web`: nginx serving the Vite build and proxying `/api`. SSE responses are unbuffered and uploads are streamed.

`api` and `worker` share the `data` volume. Images are built from the repo root:
`docker build -f backend/Dockerfile --target api .` and `--target worker`. For the GPU worker, add
`--build-arg WORKER_BASE_IMAGE=nvidia/cuda:...` and `--build-arg TORCH_INDEX_URL=...`. Behind a TLS-intercepting
proxy, pass `--secret id=ca_bundle,src=/path/ca.crt`.

Scaling notes:
- Rate limiting is in-process, so it is per API replica.
- You can run several worker replicas. Claiming is safe on Postgres.
- Uploads are spooled to `TMPDIR` by the multipart parser, then copied into place with per-file size enforcement.
  nginx `client_max_body_size` caps a single request at 2 GB.
