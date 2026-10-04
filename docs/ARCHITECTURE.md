# Architecture & contracts

Photos (or a video) → a cleaned, textured, ready-to-use 3D model (GLB / OBJ / PLY / USDZ).

```
frontend/   React + Vite + three.js web app (upload, progress, 3D viewer, downloads)
backend/
  app/      FastAPI service: auth, projects, uploads, jobs, artifacts, SSE progress
  worker    same package (`python -m app.worker`): claims queued jobs, runs the pipeline in a subprocess
  recon/    reconstruction pipeline package, invoked as `python -m recon.cli`
samples/    bundled demo image sets (samples/<name>/images/*, samples/<name>/meta.json)
deploy/     docker-compose, nginx config
docs/
```

## 1. Pipeline CLI contract (backend/recon ⇄ worker)

```
python -m recon.cli --job-dir <DIR> --config <DIR>/config.json
```

* Inputs: `<DIR>/input/` holds images (jpg/png/webp/heic) and/or videos (mp4/mov/webm).
* Outputs: everything is written under `<DIR>/output/`.
* `config.json`:
  ```json
  {
    "engine": "photogrammetry",          // "photogrammetry" | "generative"
    "quality": "standard",               // "draft" | "standard" | "high"
    "mode": "object",                    // "object" (isolate subject, remove background) | "scene"
    "texture_size": null,                // 1024 | 2048 | 4096; null/missing = quality preset (draft 1024, standard 2048, high 4096)
    "target_faces": null,                // decimation target; null/missing = preset (50k / 100k / 300k)
    "formats": ["glb", "obj", "ply", "usdz"],
    "device": "auto"                     // "auto" | "cpu" | "cuda"
  }
  ```
  Missing keys use these defaults. Unknown keys are ignored.
* stdout is **JSON Lines only** (one object per line). Human logs go to stderr.
  ```json
  {"type":"progress","stage":"sfm","progress":35.0,"message":"Registered 17/18 images"}
  {"type":"log","level":"info","message":"..."}
  {"type":"result","artifacts":[{"kind":"glb","path":"output/model.glb"}],"metrics":{"registered_images":17,"faces":98000}}
  {"type":"error","code":"too_few_registered","message":"Only 2 of 18 images could be aligned. Take more overlapping photos."}
  ```
  * `progress` is a 0–100 overall percentage and is monotonic.
  * Stage names: `ingest`, `masking`, `sfm`, `depth`, `fusion`, `meshing`, `cleanup`, `texturing`, `export`, `generate`.
  * Artifact `kind`: `glb`, `obj_zip`, `ply`, `usdz`, `thumbnail` (png), `preview` (low-poly glb), `report` (json).
    `path` is relative to the job dir.
* Exit code 0 on success (a `result` line has been emitted). Non-zero on failure (an `error` line has been emitted when possible).
* SIGTERM means cancel: exit promptly.
* `python -m recon.cli --capabilities` prints one JSON object, then exits:
  `{"engines":{"photogrammetry":{"available":true,"notes":"..."},"generative":{"available":false,"reason":"No CUDA GPU"}},"device":"cpu"}`

## 2. HTTP API (backend/app ⇄ frontend)

* Base: `${VITE_API_URL}` (e.g. `http://localhost:8000`). All routes are under `/api`.
* JSON everywhere. Errors are `{"detail": "human readable message"}` with the right status code.
* Auth: `Authorization: Bearer <jwt>`.
  `EventSource` and plain `<a href>`/model loading can't set headers, so those endpoints also accept `?token=<jwt>`.
* IDs are UUID strings. Timestamps are ISO-8601 UTC.

| Method | Path | Body / notes | Response |
|---|---|---|---|
| GET | /api/health | | `{"status":"ok","version":"..."}` |
| GET | /api/engines | cached output of `recon.cli --capabilities` | capabilities object |
| POST | /api/auth/register | `{email, password, name}` | `{access_token, token_type:"bearer", user}` |
| POST | /api/auth/login | `{email, password}` | same |
| GET | /api/auth/me | | `user` |
| GET | /api/projects | | `[project]` (newest first) |
| POST | /api/projects | `{name, description?}` | `project` |
| GET | /api/projects/{id} | | `project` (includes `images` and `latest_job`) |
| PATCH | /api/projects/{id} | `{name?, description?}` | `project` |
| DELETE | /api/projects/{id} | deletes files too | 204 |
| POST | /api/projects/{id}/images | multipart, field `files` (repeatable); images or videos; max 200 files, 50 MB each (configurable) | `[image]` |
| DELETE | /api/projects/{id}/images/{image_id} | | 204 |
| GET | /api/projects/{id}/images/{image_id}/file?thumb=1 | `thumb=1` returns a ≤384px jpeg | bytes |
| GET | /api/samples | | `[{name, title, description, image_count, thumbnail_url}]` |
| POST | /api/samples/{name}/project | creates a project prefilled with the sample's images | `project` |
| POST | /api/projects/{id}/jobs | `{engine, options}` (options = config keys above) | `job` (status `queued`) |
| GET | /api/projects/{id}/jobs | | `[job]` |
| GET | /api/jobs/{job_id} | | `job` (with `artifacts`) |
| POST | /api/jobs/{job_id}/cancel | | `job` |
| GET | /api/jobs/{job_id}/events | Server-Sent Events | see below |
| GET | /api/artifacts/{artifact_id}/download | `Content-Disposition` filename; GLB served as `model/gltf-binary` | bytes |

Objects:
```
user     {id, email, name, created_at}
project  {id, name, description, created_at, updated_at, image_count, thumbnail_url|null, status: "empty"|"ready"|"processing"|"done"|"failed", images?:[image], latest_job?:job|null}
image    {id, filename, kind:"image"|"video", size_bytes, width|null, height|null, thumb_url, url, created_at}
job      {id, project_id, engine, options, status:"queued"|"running"|"succeeded"|"failed"|"canceled", stage|null, progress (0-100), message|null, error|null, metrics|null, created_at, started_at|null, finished_at|null, artifacts:[artifact]}
artifact {id, kind, filename, size_bytes, url}   // url = /api/artifacts/{id}/download
```
`thumb_url`, `url` and `thumbnail_url` are API-relative paths. The frontend prefixes them with `VITE_API_URL` and appends `?token=`.

SSE `/api/jobs/{id}/events`. Each message is `event: <type>` + `data: <json>`:
* `job`: the full job object. Sent first, then whenever status, stage or progress changes.
* `log`: `{"level","message","ts"}`
* `end`: the final job object, sent when the job reaches a terminal state. The server then closes the stream.

## 3. Configuration (env vars, backend)

`DATABASE_URL` (default `sqlite:///./data/app.db`; Postgres supported), `DATA_DIR` (default `./data`),
`SECRET_KEY` (required in production), `ACCESS_TOKEN_EXPIRE_MINUTES` (default 10080),
`CORS_ORIGINS` (comma-separated), `MAX_UPLOAD_MB`, `MAX_FILES_PER_PROJECT`, `WORKER_CONCURRENCY` (default 1),
`JOB_TIMEOUT_SECONDS` (default 7200), `RECON_PYTHON` (interpreter used to run `recon.cli`; defaults to the current one).
Storage is the local filesystem under `DATA_DIR`. S3 is not used.

Frontend: `VITE_API_URL`, `VITE_BASE` (vite base path, default `/`).
