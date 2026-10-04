# WebRecon frontend

React 18 + Vite + three.js single-page app for WebRecon: upload photos or a video, run a
reconstruction, follow it live, inspect the textured model in 3D and download GLB / OBJ / PLY / USDZ.

It talks to the FastAPI backend in `../backend` through the HTTP contract in
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md#2-http-api-backendapp--frontend), section 2.

## Quick start

```bash
cd frontend
npm install

# against a running backend (the dev server proxies /api to http://localhost:8000)
npm run dev

# no backend at all: in-browser mock API with simulated jobs and a generated demo model
npm run dev:mock          # same as VITE_MOCK=1 npm run dev
```

In mock mode sign in with `demo@webrecon.dev` / `demo1234` (prefilled), or any email with a
4+ character password. Run `__webreconMockReset()` in the browser console to wipe the mock data.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `npm run dev:mock` | Dev server on :5173 (real API / mock API) |
| `npm run build` | Production build into `dist/` |
| `npm run build:pages` | Build with base `/3dreconstruction/` for GitHub Pages |
| `npm run deploy` | `build:pages` + publish `dist/` with `gh-pages` |
| `npm run preview` | Serve the built `dist/` |
| `npm run lint` | ESLint (flat config), zero warnings allowed |
| `npm test` | Vitest unit tests (API client, SSE/progress reducer, reconnect logic, mock simulation) |

## Configuration

Vite env vars (see `.env.example`; `.env.mock` and `.env.pages` hold the mode presets):

| Variable | Default | Meaning |
|---|---|---|
| `VITE_API_URL` | empty (same origin) | Backend base URL, e.g. `https://api.example.com`. Must allow the frontend origin via `CORS_ORIGINS`. |
| `VITE_BASE` | `/` | Public base path. GitHub Pages: `/3dreconstruction/`. |
| `VITE_MOCK` | `0` | `1` = use the in-browser mock API (no backend). |
| `VITE_PROXY_TARGET` | `http://localhost:8000` | Dev server only: where `/api` is proxied when `VITE_API_URL` is empty. |

Routing uses `HashRouter` (`/#/projects/<id>`), so deep links work on static hosts like GitHub
Pages without rewrite rules. A static demo with no backend: `VITE_MOCK=1 npm run build:pages`.

## Structure

```
src/
  main.jsx              boot (installs the mock transport when VITE_MOCK=1, then renders)
  App.jsx               routes: /, /login, /register, /projects, /projects/:id, /try/:sample
  config.js             env parsing
  api/
    client.js           transport-agnostic API client: token storage, 401 auto-logout,
                        XHR uploads with progress, asset URLs (+?token=), SSE factory
    index.js            the app-wide client instance
    mock/               in-browser mock backend: routes, MockXHR, MockEventSource,
                        time-based job simulation, procedural sample photos,
                        demo GLB/OBJ/PLY/USDZ exported with three.js at runtime
  lib/
    jobReducer.js       SSE/progress reducer (monotonic progress, log de-dupe, terminal states)
    jobStream.js        EventSource wrapper with backoff reconnect + polling fallback
    stages.js           pipeline stage metadata and stepper states
    errorHints.js       failed job -> actionable hints
    format.js           bytes, numbers, dates, durations
  hooks/                auth context (+RequireAuth), toasts, useJobStream
  components/
    layout/             header, footer, logo
    ui/                 Icon, Dialog/ConfirmDialog, StatusBadge, PageSkeleton
    viewer/             three.js viewer (viewerCore.js) + React UI and AR button
    project/            UploadPanel, SettingsPanel, ProgressPanel, ResultPanel, ErrorPanel, JobHistory
    PointCloudHero.jsx  2D-canvas animated point cloud on the landing page
  pages/                Home, Auth, Projects, Project, TrySample, NotFound
  styles/               tokens.css (colours, type, spacing; light + dark), base.css, components.css
```

Page and component styles are CSS modules next to their components; shared primitives
(`.btn`, `.card`, `.badge`, `.seg`, `.choice`, `.skeleton`, ...) live in `styles/components.css`.

## Notes

* **Auth.** The JWT is stored in `localStorage` (`webrecon.token`). Any 401 on an authenticated
  call clears it and redirects to `/login?next=...`.
* **Uploads.** One `POST /api/projects/{id}/images` per file (field `files`), three in parallel,
  so each file gets its own XHR progress bar, cancel and retry.
* **Live progress.** `GET /api/jobs/{id}/events` via `EventSource` with `?token=`. On a drop the
  stream is closed, the job is fetched once (to catch 401s and jobs that ended meanwhile), then the
  stream reopens with exponential backoff (1s to 15s). Replayed log lines are de-duplicated. On page
  load the project's `latest_job` is restored and re-subscribed if it is still queued/running.
* **Viewer.** GLTFLoader loads the `preview` artifact first, then the full `glb`, keeping the
  camera. RoomEnvironment/PMREM lighting, ACES tone mapping, sRGB output, shadow-catcher ground
  and grid, wireframe, texture on/off, auto-rotate, background cycle, fullscreen and PNG
  screenshot. Keyboard: R, A, W, T, G, B, F, P when the viewer has focus.
* **AR.** On iOS a USDZ opens in AR Quick Look (`<a rel="ar">`); on Android the GLB opens in
  Scene Viewer. No `<model-viewer>` dependency; the button is hidden on desktop.
