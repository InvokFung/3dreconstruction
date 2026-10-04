import { API_URL } from '../config.js';
import { createClient } from './client.js';

const hasWindow = typeof window !== 'undefined';

/** The app-wide API client. Mock mode swaps its transport at startup (see main.jsx). */
export const api = createClient({
  baseUrl: API_URL,
  fetchImpl: (...args) => fetch(...args),
  XHR: hasWindow ? window.XMLHttpRequest : undefined,
  EventSourceImpl: hasWindow ? window.EventSource : undefined,
  storage: hasWindow ? window.localStorage : undefined,
});

export { ApiError, TERMINAL_STATUSES } from './client.js';
