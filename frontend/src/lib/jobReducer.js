/**
 * Reducer for a job's live state, fed by the SSE stream (`job`, `log`, `end` events)
 * plus connection status changes and polling fallbacks.
 */
import { TERMINAL_STATUSES } from '../api/client.js';

export const MAX_LOGS = 1000;

export const initialJobState = {
  job: null,
  logs: [],
  /** 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' */
  connection: 'idle',
  ended: false,
};

export const isTerminal = (job) => Boolean(job && TERMINAL_STATUSES.has(job.status));

/** Merges an incoming job snapshot. Ignores snapshots for other jobs and keeps progress monotonic. */
export function mergeJob(prev, next) {
  if (!next) return prev;
  if (!prev || prev.id !== next.id) return next;
  // Never go backwards from a terminal state because of a late, stale event.
  if (isTerminal(prev) && !isTerminal(next)) return prev;
  const progress = isTerminal(next) ? next.progress ?? prev.progress : Math.max(prev.progress ?? 0, next.progress ?? 0);
  return { ...prev, ...next, progress, artifacts: next.artifacts ?? prev.artifacts };
}

const logKey = (l) => `${l.ts ?? ''}|${l.level ?? ''}|${l.message ?? ''}`;

export function jobReducer(state, action) {
  switch (action.type) {
    case 'reset':
      return { ...initialJobState, job: action.job ?? null, ended: isTerminal(action.job) };
    case 'connection':
      if (state.connection === action.status) return state;
      return { ...state, connection: action.status };
    case 'job': {
      const job = mergeJob(state.job, action.job);
      if (job === state.job) return state;
      return { ...state, job, ended: state.ended || isTerminal(job) };
    }
    case 'log': {
      const entry = action.log;
      if (!entry || typeof entry.message !== 'string') return state;
      // Streams may replay history after a reconnect: drop exact duplicates.
      const key = logKey(entry);
      const tail = state.logs.slice(-200);
      if (tail.some((l) => logKey(l) === key)) return state;
      const logs = state.logs.length >= MAX_LOGS ? [...state.logs.slice(-(MAX_LOGS - 1)), entry] : [...state.logs, entry];
      return { ...state, logs };
    }
    case 'end':
      return { ...state, job: mergeJob(state.job, action.job) ?? state.job, ended: true, connection: 'closed' };
    default:
      return state;
  }
}
