/**
 * In-browser mock of the WebRecon API (VITE_MOCK=1).
 *
 * Implements the HTTP contract in docs/ARCHITECTURE.md section 2 on top of localStorage, including
 * multipart uploads with progress (MockXHR), Server-Sent Events (MockEventSource) and real
 * downloadable model files generated with three.js at startup.
 */
import { buildDemoAssets } from './demoModel.js';
import { renderSampleImage, SAMPLES } from './sampleImages.js';
import { materialize } from './simulate.js';

const DB_KEY = 'webrecon.mock.v1';
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);
const ARTIFACT_FILES = { glb: 'model.glb', preview: 'preview.glb', obj_zip: 'model_obj.zip', ply: 'model.ply', usdz: 'model.usdz', report: 'report.json' };

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const latency = () => sleep(120 + Math.random() * 180);

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ db */

function emptyDb() {
  return { users: [], projects: [], images: [], jobs: [] };
}

function loadDb() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return null;
}

let db = emptyDb();
function save() {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch {
    /* quota exceeded: keep working in memory */
  }
}

function seed() {
  const user = { id: uuid(), email: 'demo@webrecon.dev', name: 'Demo User', password: 'demo1234', created_at: nowIso() };
  db.users.push(user);
  const hour = 3600 * 1000;
  const mk = (name, description, sample, count, ageMs) => {
    const p = { id: uuid(), owner_id: user.id, name, description, created_at: new Date(Date.now() - ageMs).toISOString() };
    p.updated_at = p.created_at;
    db.projects.push(p);
    for (let i = 0; i < count; i += 1) addSampleImage(p.id, sample, i, p.created_at);
    return p;
  };
  const vase = mk('Ceramic vase', 'Turntable capture, overcast light.', 'vase', 36, 26 * hour);
  db.jobs.push(newJobRecord(vase.id, 'photogrammetry', { quality: 'standard', mode: 'object', texture_size: 2048, target_faces: 100000 }, 36, new Date(Date.now() - 25 * hour).toISOString()));
  const lamp = mk('Desk lamp', 'Quick test with only two shots.', 'switch', 2, 5 * hour);
  db.jobs.push(newJobRecord(lamp.id, 'photogrammetry', { quality: 'draft', mode: 'object', texture_size: 1024, target_faces: 50000 }, 2, new Date(Date.now() - 4.9 * hour).toISOString()));
  mk('Garden gnome', '', null, 0, 0.5 * hour);
  save();
}

function addSampleImage(projectId, sample, index, createdAt = nowIso()) {
  const img = {
    id: uuid(),
    project_id: projectId,
    filename: `${sample}_${String(index + 1).padStart(3, '0')}.jpg`,
    kind: 'image',
    size_bytes: 2_400_000 + ((index * 7919) % 900_000),
    width: 4032,
    height: 3024,
    created_at: createdAt,
    sample,
    sample_index: index,
  };
  db.images.push(img);
  return img;
}

function newJobRecord(projectId, engine, options, imageCount, createdAt = nowIso()) {
  return { id: uuid(), project_id: projectId, engine, options, image_count: imageCount, created_at: createdAt, canceled_at: null };
}

/* ------------------------------------------------------------ views */

let assetBlobs = {};
let assetUrls = {};

function imageView(img) {
  const base = `/api/projects/${img.project_id}/images/${img.id}/file`;
  const { sample: _s, sample_index: _i, thumb: _t, project_id: _p, ...rest } = img;
  return { ...rest, thumb_url: `${base}?thumb=1`, url: base };
}

function jobView(rec, now = Date.now()) {
  const { job } = materialize(rec, now);
  if (job.status === 'succeeded') {
    job.artifacts = Object.keys(ARTIFACT_FILES)
      .filter((kind) => kind === 'report' || assetBlobs[kind])
      .map((kind) => ({
        id: `${rec.id}~${kind}`,
        kind,
        filename: ARTIFACT_FILES[kind],
        size_bytes: kind === 'report' ? 640 : assetBlobs[kind].size,
        url: `/api/artifacts/${rec.id}~${kind}/download`,
      }));
  }
  return job;
}

function projectJobs(projectId) {
  return db.jobs.filter((j) => j.project_id === projectId).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function projectView(p, { full = false } = {}) {
  const images = db.images.filter((i) => i.project_id === p.id).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.filename.localeCompare(b.filename));
  const latestRec = projectJobs(p.id)[0];
  const latest = latestRec ? jobView(latestRec) : null;
  let status = images.length ? 'ready' : 'empty';
  if (latest) {
    if (!TERMINAL.has(latest.status)) status = 'processing';
    else if (latest.status === 'succeeded') status = 'done';
    else if (latest.status === 'failed') status = 'failed';
  }
  const view = {
    id: p.id,
    name: p.name,
    description: p.description || '',
    created_at: p.created_at,
    updated_at: p.updated_at,
    image_count: images.length,
    thumbnail_url: images[0] ? imageView(images[0]).thumb_url : null,
    status,
  };
  if (full) {
    view.images = images.map(imageView);
    view.latest_job = latest;
  }
  return view;
}

/* ------------------------------------------------------------ auth */

const tokenFor = (user) => `mock.${user.id}`;
function userFromToken(token) {
  if (!token?.startsWith('mock.')) return null;
  return db.users.find((u) => u.id === token.slice(5)) ?? null;
}
const publicUser = ({ password: _p, ...u }) => u;

function requireUser(token) {
  const user = userFromToken(token);
  if (!user) throw new HttpError(401, 'Not authenticated');
  return user;
}

function ownProject(user, id) {
  const p = db.projects.find((x) => x.id === id);
  if (!p || p.owner_id !== user.id) throw new HttpError(404, 'Project not found');
  return p;
}

function ownJob(user, id) {
  const j = db.jobs.find((x) => x.id === id);
  if (!j) throw new HttpError(404, 'Job not found');
  ownProject(user, j.project_id);
  return j;
}

/* ------------------------------------------------------------ routes */

const ENGINES = {
  engines: {
    photogrammetry: { available: true, notes: 'COLMAP + OpenMVS pipeline (simulated in demo mode).' },
    generative: { available: false, reason: 'Requires a CUDA GPU; none detected on this server.' },
  },
  device: 'cpu',
};

function route(method, path, body, token) {
  let m;
  const is = (meth, re) => method === meth && (m = path.match(re));

  if (is('GET', /^\/api\/health$/)) return { version: '2.0.0-mock', status: 'ok' };
  if (is('GET', /^\/api\/engines$/)) return ENGINES;

  if (is('POST', /^\/api\/auth\/register$/)) {
    const email = String(body?.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(422, 'Enter a valid email address.');
    if (String(body?.password ?? '').length < 8) throw new HttpError(422, 'Password must be at least 8 characters.');
    if (db.users.some((u) => u.email === email)) throw new HttpError(409, 'An account with this email already exists.');
    const user = { id: uuid(), email, name: String(body?.name || email.split('@')[0]), password: body.password, created_at: nowIso() };
    db.users.push(user);
    save();
    return { access_token: tokenFor(user), token_type: 'bearer', user: publicUser(user) };
  }
  if (is('POST', /^\/api\/auth\/login$/)) {
    const email = String(body?.email ?? '').trim().toLowerCase();
    let user = db.users.find((u) => u.email === email);
    if (!user && /^[^@\s]+@[^@\s]+$/.test(email) && String(body?.password ?? '').length >= 4) {
      // Demo convenience: any email signs in (and gets an account).
      user = { id: uuid(), email, name: email.split('@')[0], password: body.password, created_at: nowIso() };
      db.users.push(user);
      save();
    }
    if (!user || user.password !== body?.password) throw new HttpError(401, 'Incorrect email or password.');
    return { access_token: tokenFor(user), token_type: 'bearer', user: publicUser(user) };
  }
  if (is('GET', /^\/api\/auth\/me$/)) return publicUser(requireUser(token));

  if (is('GET', /^\/api\/samples$/)) {
    return SAMPLES.map((s) => ({ ...s, thumbnail_url: `/api/samples/${s.name}/thumbnail` }));
  }
  if (is('POST', /^\/api\/samples\/([^/]+)\/project$/)) {
    const user = requireUser(token);
    const sample = SAMPLES.find((s) => s.name === decodeURIComponent(m[1]));
    if (!sample) throw new HttpError(404, 'Sample not found');
    const p = { id: uuid(), owner_id: user.id, name: sample.title, description: sample.description, created_at: nowIso(), updated_at: nowIso() };
    db.projects.push(p);
    for (let i = 0; i < sample.image_count; i += 1) addSampleImage(p.id, sample.name, i, p.created_at);
    save();
    return projectView(p, { full: true });
  }

  if (is('GET', /^\/api\/projects$/)) {
    const user = requireUser(token);
    return db.projects
      .filter((p) => p.owner_id === user.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((p) => projectView(p));
  }
  if (is('POST', /^\/api\/projects$/)) {
    const user = requireUser(token);
    const name = String(body?.name ?? '').trim();
    if (!name) throw new HttpError(422, 'name: Field required');
    const p = { id: uuid(), owner_id: user.id, name, description: body?.description ?? '', created_at: nowIso(), updated_at: nowIso() };
    db.projects.push(p);
    save();
    return projectView(p, { full: true });
  }
  if (is('GET', /^\/api\/projects\/([^/]+)$/)) return projectView(ownProject(requireUser(token), m[1]), { full: true });
  if (is('PATCH', /^\/api\/projects\/([^/]+)$/)) {
    const p = ownProject(requireUser(token), m[1]);
    if (body?.name != null) p.name = String(body.name).trim() || p.name;
    if (body?.description != null) p.description = String(body.description);
    p.updated_at = nowIso();
    save();
    return projectView(p, { full: true });
  }
  if (is('DELETE', /^\/api\/projects\/([^/]+)$/)) {
    const p = ownProject(requireUser(token), m[1]);
    db.projects = db.projects.filter((x) => x.id !== p.id);
    db.images = db.images.filter((x) => x.project_id !== p.id);
    db.jobs = db.jobs.filter((x) => x.project_id !== p.id);
    save();
    return null;
  }
  if (is('DELETE', /^\/api\/projects\/([^/]+)\/images\/([^/]+)$/)) {
    ownProject(requireUser(token), m[1]);
    const before = db.images.length;
    db.images = db.images.filter((x) => !(x.id === m[2] && x.project_id === m[1]));
    if (db.images.length === before) throw new HttpError(404, 'Image not found');
    save();
    return null;
  }
  if (is('GET', /^\/api\/projects\/([^/]+)\/jobs$/)) {
    ownProject(requireUser(token), m[1]);
    return projectJobs(m[1]).map((j) => jobView(j));
  }
  if (is('POST', /^\/api\/projects\/([^/]+)\/jobs$/)) {
    const p = ownProject(requireUser(token), m[1]);
    const engine = body?.engine ?? 'photogrammetry';
    if (!ENGINES.engines[engine]) throw new HttpError(422, `Unknown engine "${engine}".`);
    if (!ENGINES.engines[engine].available) throw new HttpError(409, `Engine "${engine}" is not available: ${ENGINES.engines[engine].reason}`);
    const count = db.images.filter((i) => i.project_id === p.id).length;
    if (!count) throw new HttpError(409, 'Upload at least one photo before starting a reconstruction.');
    const active = projectJobs(p.id).map((j) => jobView(j)).find((j) => !TERMINAL.has(j.status));
    if (active) throw new HttpError(409, 'A reconstruction is already running for this project.');
    const options = { quality: 'standard', mode: 'object', texture_size: 2048, target_faces: 100000, ...(body?.options ?? {}) };
    const rec = newJobRecord(p.id, engine, options, count);
    db.jobs.push(rec);
    save();
    return jobView(rec);
  }
  if (is('GET', /^\/api\/jobs\/([^/]+)$/)) return jobView(ownJob(requireUser(token), m[1]));
  if (is('POST', /^\/api\/jobs\/([^/]+)\/cancel$/)) {
    const rec = ownJob(requireUser(token), m[1]);
    if (!TERMINAL.has(jobView(rec).status)) {
      rec.canceled_at = nowIso();
      save();
    }
    return jobView(rec);
  }
  throw new HttpError(404, `No mock route for ${method} ${path}`);
}

/* ------------------------------------------------------------ transports */

function bearer(headers) {
  const h = headers ?? {};
  const v = h.Authorization ?? h.authorization ?? '';
  return v.startsWith('Bearer ') ? v.slice(7) : null;
}

async function mockFetch(input, init = {}) {
  await latency();
  const url = new URL(typeof input === 'string' ? input : input.url, window.location.origin);
  const method = (init.method ?? 'GET').toUpperCase();
  let body;
  if (typeof init.body === 'string') {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = undefined;
    }
  }
  if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  try {
    const data = route(method, url.pathname, body, bearer(init.headers));
    if (data === null) return new Response(null, { status: 204 });
    const status = method === 'POST' && /\/(projects|jobs|register|project)$/.test(url.pathname) ? 201 : 200;
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    return new Response(JSON.stringify({ detail: err.message }), { status, headers: { 'Content-Type': 'application/json' } });
  }
}

function loadImageFromBlob(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode'));
    };
    img.src = url;
  });
}

function videoFrame(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    const timer = setTimeout(() => reject(new Error('timeout')), 4000);
    v.muted = true;
    v.preload = 'auto';
    v.onloadeddata = () => {
      v.currentTime = Math.min(0.5, (v.duration || 1) / 2);
    };
    v.onseeked = () => {
      clearTimeout(timer);
      resolve({ img: v, url, width: v.videoWidth, height: v.videoHeight });
    };
    v.onerror = () => {
      clearTimeout(timer);
      reject(new Error('decode'));
    };
    v.src = url;
  });
}

function placeholderThumb(label) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 192;
  const g = c.getContext('2d');
  g.fillStyle = '#26272b';
  g.fillRect(0, 0, 256, 192);
  g.fillStyle = '#ff5f2e';
  g.font = '600 18px sans-serif';
  g.textAlign = 'center';
  g.fillText(label, 128, 102);
  return c.toDataURL('image/jpeg', 0.8);
}

/** Downscaled JPEG thumbnail (≤256px) stored in the mock DB. */
async function makeThumb(file, isVideo) {
  try {
    const { img, url, width, height } = isVideo ? await videoFrame(file) : await loadImageFromBlob(file);
    const w0 = width ?? img.naturalWidth;
    const h0 = height ?? img.naturalHeight;
    const scale = Math.min(1, 256 / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * scale));
    c.height = Math.max(1, Math.round(h0 * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    return { thumb: c.toDataURL('image/jpeg', 0.75), width: w0, height: h0 };
  } catch {
    return { thumb: placeholderThumb(isVideo ? 'VIDEO' : 'IMAGE'), width: null, height: null };
  }
}

class MockXHR {
  constructor() {
    this.upload = { onprogress: null };
    this.status = 0;
    this.responseText = '';
    this.headers = {};
    this.timers = [];
    this.aborted = false;
  }
  open(method, url) {
    this.method = method;
    this.url = new URL(url, window.location.origin);
  }
  setRequestHeader(k, v) {
    this.headers[k] = v;
  }
  abort() {
    this.aborted = true;
    this.timers.forEach(clearTimeout);
    this.onabort?.();
  }
  send(form) {
    const file = form?.get?.('files');
    const size = file?.size ?? 0;
    // ~6 MB/s simulated link, clamped so tiny files still show progress
    const duration = Math.min(3500, Math.max(500, (size / (6 * 1024 * 1024)) * 1000));
    const steps = 12;
    for (let i = 1; i <= steps; i += 1) {
      this.timers.push(
        setTimeout(() => {
          if (this.aborted) return;
          this.upload.onprogress?.({ lengthComputable: true, loaded: Math.round((size * i) / steps), total: size || 1 });
          if (i === steps) this.finish(file);
        }, (duration * i) / steps),
      );
    }
  }
  async finish(file) {
    const respond = (status, data) => {
      if (this.aborted) return;
      this.status = status;
      this.responseText = JSON.stringify(data);
      this.onload?.();
    };
    try {
      const user = requireUser(bearer(this.headers));
      const m = this.url.pathname.match(/^\/api\/projects\/([^/]+)\/images$/);
      if (!m) throw new HttpError(404, 'Not found');
      const p = ownProject(user, m[1]);
      if (!file) throw new HttpError(422, 'files: Field required');
      const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name);
      const { thumb, width, height } = await makeThumb(file, isVideo);
      const img = {
        id: uuid(),
        project_id: p.id,
        filename: file.name,
        kind: isVideo ? 'video' : 'image',
        size_bytes: file.size,
        width,
        height,
        created_at: nowIso(),
        thumb,
      };
      db.images.push(img);
      p.updated_at = nowIso();
      save();
      respond(201, [imageView(img)]);
    } catch (err) {
      respond(err instanceof HttpError ? err.status : 500, { detail: err.message });
    }
  }
}

class MockEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.sentLogs = 0;
    this.lastKey = '';
    const parsed = new URL(url.replace(/^mock:/, 'http://mock'));
    this.jobId = parsed.pathname.match(/\/api\/jobs\/([^/]+)\/events/)?.[1];
    this.token = parsed.searchParams.get('token');
    this.timer = setTimeout(() => this.start(), 80);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= new Set()).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type]?.delete(fn);
  }
  emit(type, data) {
    const ev = new MessageEvent(type, { data: JSON.stringify(data) });
    this.listeners[type]?.forEach((fn) => fn(ev));
  }
  start() {
    let rec;
    try {
      rec = ownJob(requireUser(this.token), decodeURIComponent(this.jobId));
    } catch {
      this.readyState = 2;
      this.onerror?.(new Event('error'));
      return;
    }
    this.rec = rec;
    this.readyState = 1;
    this.onopen?.(new Event('open'));
    this.tick(true);
    this.interval = setInterval(() => this.tick(false), 350);
  }
  tick(first) {
    if (this.readyState !== 1) return;
    const now = Date.now();
    const { logs } = materialize(this.rec, now);
    const job = jobView(this.rec, now);
    const key = `${job.status}|${job.stage}|${job.progress}`;
    if (first || key !== this.lastKey) {
      this.lastKey = key;
      this.emit('job', job);
    }
    for (; this.sentLogs < logs.length; this.sentLogs += 1) this.emit('log', logs[this.sentLogs]);
    if (TERMINAL.has(job.status)) {
      this.emit('end', job);
      this.close();
    }
  }
  close() {
    this.readyState = 2;
    clearTimeout(this.timer);
    clearInterval(this.interval);
  }
}

/* ------------------------------------------------------------ assets */

function makeResolver(getToken) {
  return (path) => {
    const url = new URL(path, 'http://mock');
    let m = url.pathname.match(/^\/api\/projects\/[^/]+\/images\/([^/]+)\/file$/);
    if (m) {
      const img = db.images.find((i) => i.id === m[1]);
      if (!img) return '';
      if (img.sample) return renderSampleImage(img.sample, img.sample_index, url.searchParams.has('thumb') ? 384 : 1024);
      return img.thumb ?? '';
    }
    m = url.pathname.match(/^\/api\/samples\/([^/]+)\/thumbnail$/);
    if (m) return renderSampleImage(m[1], 0, 512);
    m = url.pathname.match(/^\/api\/artifacts\/([^/]+)~([a-z_]+)\/download$/);
    if (m) {
      const kind = m[2];
      if (kind === 'report') {
        const rec = db.jobs.find((j) => j.id === m[1]);
        const job = rec ? jobView(rec) : {};
        return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({ job_id: m[1], metrics: job.metrics, options: job.options }, null, 2))}`;
      }
      return assetUrls[kind] ?? '';
    }
    const token = getToken();
    return `mock:${url.pathname}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  };
}

/**
 * Swaps the API client's transport for the in-browser mock.
 * @param {ReturnType<import('../client.js').createClient>} client
 */
export async function installMockApi(client) {
  db = loadDb() ?? emptyDb();
  if (!db.users.length) seed();
  try {
    assetBlobs = await buildDemoAssets();
  } catch (err) {
    console.warn('[mock] could not build demo model', err);
    assetBlobs = {};
  }
  assetUrls = Object.fromEntries(Object.entries(assetBlobs).map(([k, b]) => [k, URL.createObjectURL(b)]));
  client.configure({
    baseUrl: '',
    fetchImpl: mockFetch,
    XHR: MockXHR,
    EventSourceImpl: MockEventSource,
    resolveAsset: makeResolver(() => client.tokens.get()),
  });
  // handy for demos: wipe the mock database
  window.__webreconMockReset = () => {
    localStorage.removeItem(DB_KEY);
    location.reload();
  };
}
