/**
 * HTTP client for the WebRecon API (docs/ARCHITECTURE.md, section 2).
 *
 * The client is transport-agnostic: fetch, XMLHttpRequest and EventSource are injected so the
 * same code runs against the real backend, the in-browser mock (VITE_MOCK=1) and unit tests.
 */

export const TOKEN_KEY = 'webrecon.token';
export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

/** @typedef {{id:string,email:string,name:string,created_at:string}} User */
/** @typedef {{id:string,filename:string,kind:'image'|'video',size_bytes:number,width:number|null,height:number|null,thumb_url:string,url:string,created_at:string}} Image */
/** @typedef {{id:string,kind:string,filename:string,size_bytes:number,url:string}} Artifact */
/** @typedef {{id:string,project_id:string,engine:string,options:object,status:'queued'|'running'|'succeeded'|'failed'|'canceled',stage:string|null,progress:number,message:string|null,error:string|null,metrics:object|null,created_at:string,started_at:string|null,finished_at:string|null,artifacts:Artifact[]}} Job */
/** @typedef {{id:string,name:string,description?:string,created_at:string,updated_at:string,image_count:number,thumbnail_url:string|null,status:'empty'|'ready'|'processing'|'done'|'failed',images?:Image[],latest_job?:Job|null}} Project */

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status (0 = network failure)
   * @param {string} message human readable message (the API's `detail`)
   * @param {unknown} [body]
   */
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Extracts a human readable message from a FastAPI error body. */
export function errorDetail(body, status) {
  if (body && typeof body === 'object' && 'detail' in body) {
    const { detail } = body;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d) => {
          const field = Array.isArray(d?.loc) ? d.loc.filter((p) => p !== 'body').join('.') : '';
          return field ? `${field}: ${d.msg}` : d?.msg;
        })
        .filter(Boolean)
        .join('; ');
    }
  }
  if (typeof body === 'string' && body.trim() && body.length < 300) return body.trim();
  if (status === 0) return 'Cannot reach the server. Check your connection and that the API is running.';
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You do not have access to this resource.';
  if (status === 404) return 'Not found.';
  if (status === 413) return 'File too large for the server.';
  if (status >= 500) return 'The server ran into a problem. Please try again in a moment.';
  return `Request failed (${status}).`;
}

/** Token persistence with an in-memory fallback when storage is unavailable. */
export function createTokenStore(storage) {
  let memory = null;
  const listeners = new Set();
  const read = () => {
    try {
      return storage?.getItem(TOKEN_KEY) ?? null;
    } catch {
      return null;
    }
  };
  const write = (value) => {
    try {
      if (value) storage?.setItem(TOKEN_KEY, value);
      else storage?.removeItem(TOKEN_KEY);
    } catch {
      /* storage blocked (private mode); keep the in-memory copy */
    }
  };
  return {
    get: () => read() ?? memory,
    set(token) {
      memory = token || null;
      write(memory);
      listeners.forEach((fn) => fn(memory));
    },
    clear() {
      memory = null;
      write(null);
      listeners.forEach((fn) => fn(null));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const enc = encodeURIComponent;

/**
 * @param {object} opts
 * @param {string} [opts.baseUrl]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {typeof XMLHttpRequest} [opts.XHR]
 * @param {typeof EventSource} [opts.EventSourceImpl]
 * @param {Storage} [opts.storage]
 * @param {(path:string)=>string} [opts.resolveAsset] maps API paths to URLs (mock mode)
 */
export function createClient(opts = {}) {
  const transport = { baseUrl: '', ...opts };
  const tokens = createTokenStore(opts.storage);
  const unauthorized = new Set();

  function notifyUnauthorized() {
    const had = Boolean(tokens.get());
    tokens.clear();
    if (had) unauthorized.forEach((fn) => fn());
  }

  function authHeaders(auth) {
    const token = tokens.get();
    return auth && token ? { Authorization: `Bearer ${token}` } : {};
  }

  /**
   * JSON request. Throws ApiError on non-2xx; a 401 on an authenticated call logs out.
   * @returns {Promise<any>}
   */
  async function request(path, { method = 'GET', body, signal, auth = true } = {}) {
    const headers = { Accept: 'application/json', ...authHeaders(auth) };
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await transport.fetchImpl(`${transport.baseUrl}${path}`, { method, headers, body: payload, signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new ApiError(0, errorDetail(null, 0));
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      if (res.status === 401 && auth) notifyUnauthorized();
      throw new ApiError(res.status, errorDetail(data, res.status), data);
    }
    return data;
  }

  /**
   * Upload one file with progress reporting (XMLHttpRequest exposes upload progress; fetch does not).
   * @param {string} projectId
   * @param {File} file
   * @param {{onProgress?:(fraction:number)=>void, signal?:AbortSignal}} [o]
   * @returns {Promise<Image[]>}
   */
  function uploadImage(projectId, file, { onProgress, signal } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new transport.XHR();
      xhr.open('POST', `${transport.baseUrl}/api/projects/${enc(projectId)}/images`);
      const headers = authHeaders(true);
      Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      xhr.setRequestHeader('Accept', 'application/json');
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
        };
      }
      const abort = () => xhr.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const done = () => signal?.removeEventListener('abort', abort);
      xhr.onload = () => {
        done();
        let data;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          data = xhr.responseText;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress?.(1);
          resolve(Array.isArray(data) ? data : data ? [data] : []);
        } else {
          if (xhr.status === 401) notifyUnauthorized();
          reject(new ApiError(xhr.status, errorDetail(data, xhr.status), data));
        }
      };
      xhr.onerror = () => {
        done();
        reject(new ApiError(0, errorDetail(null, 0)));
      };
      xhr.onabort = () => {
        done();
        reject(new DOMException('Upload canceled', 'AbortError'));
      };
      const form = new FormData();
      form.append('files', file, file.name);
      xhr.send(form);
    });
  }

  /**
   * Absolute URL for an API-relative asset path, with `?token=` for <img>, <a> and loaders.
   * @param {string|null|undefined} path
   */
  function assetUrl(path) {
    if (!path) return null;
    if (/^(blob:|data:)/.test(path)) return path;
    if (transport.resolveAsset) return transport.resolveAsset(path);
    const url = /^https?:\/\//.test(path) ? path : `${transport.baseUrl}${path}`;
    const token = tokens.get();
    if (!token) return url;
    return `${url}${url.includes('?') ? '&' : '?'}token=${enc(token)}`;
  }

  const json = (method) => (path, body, o) => request(path, { ...o, method, body });
  const get = (path, o) => request(path, o);
  const post = json('POST');
  const patch = json('PATCH');
  const del = (path, o) => request(path, { ...o, method: 'DELETE' });

  async function authenticate(path, body) {
    const res = await request(path, { method: 'POST', body, auth: false });
    tokens.set(res.access_token);
    return res;
  }

  return {
    tokens,
    request,
    assetUrl,
    /** Replace transport pieces (used by mock mode). */
    configure(next) {
      Object.assign(transport, next);
    },
    /** Called after a 401 on an authenticated request; returns an unsubscribe fn. */
    onUnauthorized(fn) {
      unauthorized.add(fn);
      return () => unauthorized.delete(fn);
    },

    health: () => get('/api/health', { auth: false }),
    engines: (o) => get('/api/engines', o),

    auth: {
      /** @returns {Promise<{access_token:string,token_type:string,user:User}>} */
      register: ({ email, password, name }) => authenticate('/api/auth/register', { email, password, name }),
      login: ({ email, password }) => authenticate('/api/auth/login', { email, password }),
      /** @returns {Promise<User>} */
      me: (o) => get('/api/auth/me', o),
      logout: () => tokens.clear(),
    },

    projects: {
      /** @returns {Promise<Project[]>} */
      list: (o) => get('/api/projects', o),
      /** @returns {Promise<Project>} */
      create: ({ name, description }) => post('/api/projects', description ? { name, description } : { name }),
      /** @returns {Promise<Project>} */
      get: (id, o) => get(`/api/projects/${enc(id)}`, o),
      update: (id, changes) => patch(`/api/projects/${enc(id)}`, changes),
      remove: (id) => del(`/api/projects/${enc(id)}`),
      uploadImage,
      removeImage: (projectId, imageId) => del(`/api/projects/${enc(projectId)}/images/${enc(imageId)}`),
      /** @returns {Promise<Job[]>} */
      jobs: (id, o) => get(`/api/projects/${enc(id)}/jobs`, o),
      /** @returns {Promise<Job>} */
      startJob: (id, { engine, options }) => post(`/api/projects/${enc(id)}/jobs`, { engine, options }),
    },

    samples: {
      list: (o) => get('/api/samples', o),
      /** @returns {Promise<Project>} */
      createProject: (name) => post(`/api/samples/${enc(name)}/project`),
    },

    jobs: {
      /** @returns {Promise<Job>} */
      get: (id, o) => get(`/api/jobs/${enc(id)}`, o),
      cancel: (id) => post(`/api/jobs/${enc(id)}/cancel`),
      /** Opens the SSE stream for a job. */
      events: (id) => new transport.EventSourceImpl(assetUrl(`/api/jobs/${enc(id)}/events`)),
    },
  };
}
