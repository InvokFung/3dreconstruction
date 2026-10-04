# WebRecon: photos to 3D models

WebRecon turns a set of overlapping photos (or a short video) of an object or scene into a cleaned,
textured, ready-to-use 3D model: GLB for the web and game engines, OBJ for DCC tools, PLY for
analysis and USDZ for AR Quick Look. Upload in the browser, watch the pipeline run live, inspect the
result in an interactive 3D viewer and download it.

## Architecture

```
 Browser                          Server                                   Disk
┌──────────────────────┐  HTTP   ┌──────────────────────────┐            ┌──────────────┐
│ frontend/            │  JSON   │ backend/app  (FastAPI)   │  SQLite /  │ DATA_DIR/    │
│ React + Vite + three │ ──────▶ │ auth, projects, uploads, │  Postgres  │  uploads,    │
│ upload · progress ·  │ ◀────── │ jobs, artifacts          │            │  job dirs,   │
│ 3D viewer · download │   SSE   │ SSE /api/jobs/{id}/events│            │  models      │
└──────────────────────┘         └────────────┬─────────────┘            └──────▲───────┘
                                              │ queue (DB)                      │
                                 ┌────────────▼─────────────┐  subprocess  ┌────┴─────────┐
                                 │ worker (python -m        │ ───────────▶ │ backend/recon│
                                 │ app.worker)              │ ◀─ JSONL ─── │ pipeline CLI │
                                 └──────────────────────────┘   progress   └──────────────┘
                                   ingest → masking → sfm → depth → fusion → meshing
                                   → cleanup → texturing → export
```

The contracts between the pieces (pipeline CLI, HTTP API, config) are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Bundled demo captures live in `samples/`.

## Quick start

1. **Backend**: see [backend/README.md](backend/README.md) to run the API and the worker
   (default `http://localhost:8000`).
2. **Frontend**: see [frontend/README.md](frontend/README.md).
   ```bash
   cd frontend && npm install && npm run dev        # proxies /api to localhost:8000
   ```
   No backend handy? `npm run dev:mock` runs the whole UI against an in-browser mock API.

## Repository layout

```
frontend/   React + Vite + three.js web app
backend/    FastAPI service, worker and the reconstruction pipeline (recon/)
samples/    demo image sets used by "Try this sample"
docs/       architecture and API contract
```

## License

See [LICENSE](LICENSE).
