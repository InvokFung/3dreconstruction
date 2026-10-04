import { describe, expect, it } from 'vitest';
import { materialize, QUEUE_MS } from './simulate.js';

const base = { id: 'j', project_id: 'p', engine: 'photogrammetry', options: { quality: 'draft' }, created_at: '2026-01-01T00:00:00.000Z', image_count: 20 };
const t0 = Date.parse(base.created_at);

describe('mock job simulation', () => {
  it('goes queued -> running -> succeeded with monotonic progress', () => {
    expect(materialize(base, t0 + 100).job.status).toBe('queued');
    let last = -1;
    for (let t = QUEUE_MS; t < 13000; t += 500) {
      const { job } = materialize(base, t0 + t);
      expect(job.progress).toBeGreaterThanOrEqual(last);
      last = job.progress;
    }
    const done = materialize(base, t0 + 60000).job;
    expect(done.status).toBe('succeeded');
    expect(done.progress).toBe(100);
    expect(done.metrics.faces).toBeGreaterThan(0);
  });

  it('fails at sfm with too few images', () => {
    const { job, logs } = materialize({ ...base, image_count: 2 }, t0 + 60000);
    expect(job.status).toBe('failed');
    expect(job.stage).toBe('sfm');
    expect(job.error).toMatch(/could be aligned/);
    expect(logs.at(-1).level).toBe('error');
  });

  it('honours cancellation', () => {
    const job = materialize({ ...base, canceled_at: new Date(t0 + 4000).toISOString() }, t0 + 60000).job;
    expect(job.status).toBe('canceled');
    expect(job.progress).toBeLessThan(100);
  });
});
