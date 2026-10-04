import { TERMINAL_STATUSES } from '../api/client.js';

const parse = (data) => {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};

/**
 * Subscribes to `/api/jobs/{id}/events` and keeps the subscription alive across drops.
 *
 * On error the stream is closed and re-opened with exponential backoff. Before re-opening, the job is
 * fetched once: that surfaces 401s (auto-logout happens in the client) and catches jobs that finished
 * while we were disconnected.
 *
 * @param {ReturnType<import('../api/client.js').createClient>} client
 * @param {string} jobId
 * @param {{onJob:Function,onLog:Function,onEnd:Function,onStatus:Function}} handlers
 * @param {{maxDelay?:number, baseDelay?:number}} [opts]
 * @returns {() => void} unsubscribe
 */
export function connectJobEvents(client, jobId, handlers, { baseDelay = 1000, maxDelay = 15000 } = {}) {
  const { onJob, onLog, onEnd, onStatus } = handlers;
  let source = null;
  let stopped = false;
  let attempt = 0;
  let timer = null;

  const finish = (job) => {
    stopped = true;
    source?.close();
    if (job) onEnd?.(job);
    onStatus?.('closed');
  };

  const open = () => {
    if (stopped) return;
    onStatus?.(attempt ? 'reconnecting' : 'connecting');
    try {
      source = client.jobs.events(jobId);
    } catch {
      scheduleReconnect();
      return;
    }
    source.onopen = () => {
      attempt = 0;
      onStatus?.('open');
    };
    source.addEventListener('job', (e) => {
      const job = parse(e.data);
      if (job) onJob?.(job);
    });
    source.addEventListener('log', (e) => {
      const log = parse(e.data);
      if (log) onLog?.(log);
    });
    source.addEventListener('end', (e) => finish(parse(e.data)));
    source.onerror = () => {
      if (stopped) return;
      source.close();
      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    onStatus?.('reconnecting');
    const delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
    attempt += 1;
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        const job = await client.jobs.get(jobId);
        if (stopped) return;
        if (TERMINAL_STATUSES.has(job.status)) {
          finish(job);
          return;
        }
        onJob?.(job);
      } catch (err) {
        if (err?.status === 401 || err?.status === 404 || err?.status === 403) {
          finish(null);
          return;
        }
        // Network still down: try the stream again anyway; the next error re-schedules.
      }
      open();
    }, delay);
  };

  open();

  return () => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
  };
}
