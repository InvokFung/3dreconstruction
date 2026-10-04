import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectJobEvents } from './jobStream.js';

class FakeES {
  static all = [];
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeES.all.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type, data) {
    (this.listeners[type] ?? []).forEach((fn) => fn({ data: JSON.stringify(data) }));
  }
  close() {
    this.closed = true;
  }
}

function fakeClient(getJob) {
  return { jobs: { events: (id) => new FakeES(`/events/${id}`), get: vi.fn(getJob) } };
}

describe('connectJobEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeES.all = [];
  });
  afterEach(() => vi.useRealTimers());

  it('forwards job, log and end events and closes on end', () => {
    const h = { onJob: vi.fn(), onLog: vi.fn(), onEnd: vi.fn(), onStatus: vi.fn() };
    connectJobEvents(fakeClient(), 'j1', h);
    const es = FakeES.all[0];
    es.onopen();
    es.emit('job', { id: 'j1', progress: 10 });
    es.emit('log', { message: 'x' });
    es.emit('end', { id: 'j1', status: 'succeeded' });
    expect(h.onJob).toHaveBeenCalledWith({ id: 'j1', progress: 10 });
    expect(h.onLog).toHaveBeenCalledWith({ message: 'x' });
    expect(h.onEnd).toHaveBeenCalledWith({ id: 'j1', status: 'succeeded' });
    expect(es.closed).toBe(true);
    expect(h.onStatus.mock.calls.map((c) => c[0])).toEqual(['connecting', 'open', 'closed']);
  });

  it('reconnects with backoff after a drop', async () => {
    const client = fakeClient(async () => ({ id: 'j1', status: 'running', progress: 50 }));
    const h = { onJob: vi.fn(), onStatus: vi.fn(), onEnd: vi.fn() };
    connectJobEvents(client, 'j1', h, { baseDelay: 100 });
    FakeES.all[0].onerror();
    expect(FakeES.all[0].closed).toBe(true);
    expect(h.onStatus).toHaveBeenLastCalledWith('reconnecting');
    await vi.advanceTimersByTimeAsync(100);
    expect(client.jobs.get).toHaveBeenCalledWith('j1');
    expect(h.onJob).toHaveBeenCalledWith({ id: 'j1', status: 'running', progress: 50 });
    expect(FakeES.all).toHaveLength(2);
    // second drop waits twice as long
    FakeES.all[1].onerror();
    await vi.advanceTimersByTimeAsync(150);
    expect(FakeES.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60);
    expect(FakeES.all).toHaveLength(3);
  });

  it('finishes instead of reconnecting when the job ended while disconnected', async () => {
    const client = fakeClient(async () => ({ id: 'j1', status: 'failed', error: 'boom' }));
    const h = { onEnd: vi.fn(), onStatus: vi.fn() };
    connectJobEvents(client, 'j1', h, { baseDelay: 10 });
    FakeES.all[0].onerror();
    await vi.advanceTimersByTimeAsync(20);
    expect(h.onEnd).toHaveBeenCalledWith({ id: 'j1', status: 'failed', error: 'boom' });
    expect(FakeES.all).toHaveLength(1);
  });

  it('stops on unsubscribe', async () => {
    const client = fakeClient(async () => ({ id: 'j1', status: 'running' }));
    const stop = connectJobEvents(client, 'j1', {}, { baseDelay: 10 });
    FakeES.all[0].onerror();
    stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(client.jobs.get).not.toHaveBeenCalled();
    expect(FakeES.all).toHaveLength(1);
  });
});
