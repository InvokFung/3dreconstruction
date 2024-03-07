import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { fileURLToPath, URL } from "url";
import { viteCommonjs, esbuildCommonjs } from '@originjs/vite-plugin-commonjs';

// https://vitejs.dev/config/
export default defineConfig({
  base: "/3dreconstruction/",
  define: {
    global: {},
    Buffer: [],
    process: { env: { DEBUG: undefined }, version: [] },
    'process.env.VITE_AWS_ACCESS_KEY_ID': JSON.stringify(process.env.VITE_AWS_ACCESS_KEY_ID),
    'process.env.VITE_AWS_SECRET_ACCESS_KEY': JSON.stringify(process.env.VITE_AWS_SECRET_ACCESS_KEY),
    'process.env.VITE_AWS_REGION': JSON.stringify(process.env.VITE_AWS_REGION),
    'process.env.VITE_AWS_BUCKET_NAME': JSON.stringify(process.env.VITE_AWS_BUCKET_NAME),
  },
  assetsInclude: ["**/*.glb", "**/*.ply", "**/*.npy"],
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json'],
    alias: {
      "app": fileURLToPath(new URL("./src/app", import.meta.url)),
      "components": fileURLToPath(new URL("./src/components", import.meta.url)),
    },
  },
  plugins: [react()],
  optimizeDeps: {
    esbuildOptions: {
      plugins: [
        esbuildCommonjs(['when']),
      ],
    },
  }
})
