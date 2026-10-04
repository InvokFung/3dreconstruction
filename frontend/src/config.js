const env = import.meta.env;

/** Base URL of the backend, without a trailing slash. Empty string = same origin. */
export const API_URL = (env.VITE_API_URL || '').replace(/\/+$/, '');

/** When true the app talks to an in-browser mock API instead of a real backend. */
export const MOCK = env.VITE_MOCK === '1' || env.VITE_MOCK === 'true';

/** Public base path (used to build links to files in /public). */
export const BASE = env.BASE_URL || '/';

export const publicAsset = (path) => `${BASE}${path.replace(/^\//, '')}`;
