import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_BASE: public base path. "/" by default; GitHub Pages builds use "/3dreconstruction/".
// VITE_PROXY_TARGET: where the dev server forwards /api when VITE_API_URL is empty.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.VITE_BASE || '/';
  return {
    base: base.endsWith('/') ? base : `${base}/`,
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: env.VITE_PROXY_TARGET || 'http://localhost:8000',
          changeOrigin: true,
        },
      },
    },
    build: {
      sourcemap: true,
      chunkSizeWarningLimit: 800,
    },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{js,jsx}'],
    },
  };
});
