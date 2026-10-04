import { describe, expect, it } from 'vitest';
import { initialJobState, jobReducer, MAX_LOGS, mergeJob } from './jobReducer.js';
import { stageStates } from './stages.js';

const job = (over = {}) => ({ id: 'j1', status: 'running', stage: 'sfm', progress: 30, engine: 'photogrammetry', ...over });

describe('jobReducer', () => {
  it('resets to a job and marks terminal jobs as ended', () => {
    expect(jobReducer(initialJobState, { type: 'reset', job: job() }).ended).toBe(false);
    expect(jobReducer(initialJobState, { type: 'reset', job: job({ status: 'succeeded' }) }).ended).toBe(true);
  });

  it('keeps progress monotonic while running', () => {
    let s = jobReducer(initialJobState, { type: 'reset', job: job({ progress: 40 }) });
    s = jobReducer(s, { type: 'job', job: job({ progress: 35, stage: 'depth' }) });
    expect(s.job.progress).toBe(40);
    expect(s.job.stage).toBe('depth');
  });

  it('ignores stale non-terminal snapshots after the job ended', () => {
    let s = jobReducer(initialJobState, { type: 'reset', job: job() });
    s = jobReducer(s, { type: 'end', job: job({ status: 'succeeded', progress: 100, artifacts: [{ id: 'a' }] }) });
    expect(s.ended).toBe(true);
    expect(s.connection).toBe('closed');
    s = jobReducer(s, { type: 'job', job: job({ status: 'running', progress: 90 }) });
    expect(s.job.status).toBe('succeeded');
    expect(s.job.artifacts).toHaveLength(1);
  });

  it('switches to a different job id', () => {
    const merged = mergeJob(job({ status: 'succeeded' }), job({ id: 'j2', status: 'queued', progress: 0 }));
    expect(merged.id).toBe('j2');
    expect(merged.progress).toBe(0);
  });

  it('appends logs, dedupes replays after reconnect, and caps the buffer', () => {
    const log = { level: 'info', message: 'hello', ts: '2026-01-01T00:00:00Z' };
    let s = jobReducer(initialJobState, { type: 'log', log });
    s = jobReducer(s, { type: 'log', log: { ...log } });
    expect(s.logs).toHaveLength(1);
    for (let i = 0; i < MAX_LOGS + 50; i += 1) s = jobReducer(s, { type: 'log', log: { level: 'info', message: `m${i}`, ts: String(i) } });
    expect(s.logs).toHaveLength(MAX_LOGS);
    expect(s.logs.at(-1).message).toBe(`m${MAX_LOGS + 49}`);
  });

  it('tracks connection status without needless re-renders', () => {
    const s = jobReducer(initialJobState, { type: 'connection', status: 'open' });
    expect(s.connection).toBe('open');
    expect(jobReducer(s, { type: 'connection', status: 'open' })).toBe(s);
  });
});

describe('stageStates', () => {
  it('marks earlier stages done, the current one active', () => {
    const states = stageStates(job({ stage: 'depth' }));
    expect(states.map((s) => s.state).slice(0, 5)).toEqual(['done', 'done', 'done', 'active', 'pending']);
  });
  it('marks the failing stage', () => {
    const states = stageStates(job({ stage: 'sfm', status: 'failed' }));
    expect(states.find((s) => s.stage === 'sfm').state).toBe('failed');
  });
  it('uses the generative stage list', () => {
    expect(stageStates(job({ engine: 'generative', stage: 'generate' })).map((s) => s.stage)).toContain('generate');
  });
});
