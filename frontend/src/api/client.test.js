import { describe, expect, it, vi } from 'vitest';
import { ApiError, createClient, errorDetail, TOKEN_KEY } from './client.js';

function memoryStorage(init = {}) {
  const data = { ...init };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
    removeItem: (k) => {
      delete data[k];
    },
    data,
  };
}

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('api client', () => {
  it('stores the token on login and sends it as a bearer header', async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/api/auth/login')) return json(200, { access_token: 'tok', token_type: 'bearer', user: { id: 'u1' } });
      return json(200, []);
    });
    const api = createClient({ baseUrl: 'http://api', fetchImpl, storage });
    const res = await api.auth.login({ email: 'a@b.c', password: 'pw' });
    expect(res.user.id).toBe('u1');
    expect(storage.data[TOKEN_KEY]).toBe('tok');

    await api.projects.list();
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe('http://api/api/projects');
    expect(init.headers.Authorization).toBe('Bearer tok');
    // login itself must not send a stale token
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('serialises JSON bodies and returns null for 204', async () => {
    const fetchImpl = vi.fn(async (url, init) => (init.method === 'DELETE' ? new Response(null, { status: 204 }) : json(201, JSON.parse(init.body))));
    const api = createClient({ fetchImpl, storage: memoryStorage() });
    await expect(api.projects.create({ name: 'Mug' })).resolves.toEqual({ name: 'Mug' });
    expect(fetchImpl.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
    await expect(api.projects.remove('p 1')).resolves.toBeNull();
    expect(fetchImpl.mock.calls[1][0]).toBe('/api/projects/p%201');
  });

  it('logs out and notifies listeners on 401', async () => {
    const storage = memoryStorage({ [TOKEN_KEY]: 'old' });
    const api = createClient({ fetchImpl: async () => json(401, { detail: 'Token expired' }), storage });
    const onUnauthorized = vi.fn();
    api.onUnauthorized(onUnauthorized);
    const err = await api.projects.list().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe('Token expired');
    expect(api.tokens.get()).toBeNull();
    expect(storage.data[TOKEN_KEY]).toBeUndefined();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not log out on a failed login (401 on an unauthenticated call)', async () => {
    const storage = memoryStorage({ [TOKEN_KEY]: 'keep' });
    const api = createClient({ fetchImpl: async () => json(401, { detail: 'Incorrect email or password.' }), storage });
    const onUnauthorized = vi.fn();
    api.onUnauthorized(onUnauthorized);
    await expect(api.auth.login({ email: 'x', password: 'y' })).rejects.toThrow('Incorrect email or password.');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('maps network failures to status 0', async () => {
    const api = createClient({
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
      storage: memoryStorage(),
    });
    const err = await api.health().catch((e) => e);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/reach the server/);
  });

  it('builds asset URLs with the token', () => {
    const api = createClient({ baseUrl: 'http://api', storage: memoryStorage({ [TOKEN_KEY]: 'a b' }) });
    expect(api.assetUrl('/api/artifacts/1/download')).toBe('http://api/api/artifacts/1/download?token=a%20b');
    expect(api.assetUrl('/api/projects/p/images/i/file?thumb=1')).toBe('http://api/api/projects/p/images/i/file?thumb=1&token=a%20b');
    expect(api.assetUrl(null)).toBeNull();
    expect(api.assetUrl('blob:x')).toBe('blob:x');
  });

  it('opens the SSE stream with the token in the query', () => {
    const EventSourceImpl = vi.fn();
    const api = createClient({ baseUrl: 'http://api', EventSourceImpl, storage: memoryStorage({ [TOKEN_KEY]: 't' }) });
    api.jobs.events('j1');
    expect(EventSourceImpl).toHaveBeenCalledWith('http://api/api/jobs/j1/events?token=t');
  });

  it('uploads with XHR and reports progress', async () => {
    const instances = [];
    class FakeXHR {
      constructor() {
        this.upload = {};
        this.headers = {};
        instances.push(this);
      }
      open(method, url) {
        Object.assign(this, { method, url });
      }
      setRequestHeader(k, v) {
        this.headers[k] = v;
      }
      send(body) {
        this.body = body;
        this.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
        this.status = 201;
        this.responseText = JSON.stringify([{ id: 'img1' }]);
        this.onload();
      }
    }
    const api = createClient({ baseUrl: 'http://api', XHR: FakeXHR, storage: memoryStorage({ [TOKEN_KEY]: 't' }) });
    const progress = [];
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    const res = await api.projects.uploadImage('p1', file, { onProgress: (p) => progress.push(p) });
    expect(res).toEqual([{ id: 'img1' }]);
    expect(progress).toEqual([0.5, 1]);
    const xhr = instances[0];
    expect(xhr.url).toBe('http://api/api/projects/p1/images');
    expect(xhr.headers.Authorization).toBe('Bearer t');
    expect(xhr.body.get('files').name).toBe('a.jpg');
  });
});

describe('errorDetail', () => {
  it('handles FastAPI validation errors', () => {
    expect(errorDetail({ detail: [{ loc: ['body', 'email'], msg: 'value is not a valid email' }] }, 422)).toBe('email: value is not a valid email');
  });
  it('falls back to status text', () => {
    expect(errorDetail(null, 503)).toMatch(/server/);
    expect(errorDetail(null, 404)).toBe('Not found.');
  });
});
