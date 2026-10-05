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

You need **Node.js 20+** and **[uv](https://docs.astral.sh/uv/getting-started/installation/)**
(uv also installs the right Python for you). Works on Windows, macOS and Linux.

```bash
npm run setup    # once: Python env (uv sync), backend/.env, frontend packages  (pnpm works too)
npm run dev      # starts API :8000 + worker + web app :5173
```

Open http://localhost:5173 and sign in with the demo account **demo@webrecon.dev / demo1234**
(or register your own). Click a sample → **Start reconstruction**. A draft run takes a few minutes on a
CPU. The first run also downloads the AI models (~1–2 GB) into `~/.cache/recon`.

Other commands:

| Command | What it does |
|---|---|
| `npm run dev:mock` | UI only, with a fake in-browser API (no Python needed) |
| `npm test` | backend + pipeline + frontend tests |
| `cd backend && uv run uvicorn app.main:app --reload` | API only |
| `cd backend && uv run python -m app.worker` | worker only |
| `cd backend && uv run python -m recon.cli --job-dir DIR --config DIR/config.json` | pipeline on a folder of photos |

Linux only: the pipeline needs `sudo apt-get install -y libgl1 libegl1 libgomp1`.
Production deployment with Docker: see [backend/README.md](backend/README.md) and `deploy/`.

## Repository layout

```
frontend/   React + Vite + three.js web app
backend/    FastAPI service, worker and the reconstruction pipeline (recon/)
samples/    demo image sets used by "Try this sample"
docs/       architecture and API contract
```

## License

See [LICENSE](LICENSE).
