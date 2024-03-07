import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { fileURLToPath, URL } from "url";
import { viteCommonjs, esbuildCommonjs } from '@originjs/vite-plugin-commonjs';

// https://vitejs.dev/config/
export default defineConfig({
  base: "/3dreconstruction/",
  define: {
    global: {},
  },
  assetsInclude: ["**/*.glb", "**/*.ply", "**/*.npy"],
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json'],
    alias: {
      "app": fileURLToPath(new URL("./src/app", import.meta.url)),
      "components": fileURLToPath(new URL("./src/components", import.meta.url)),
      'stream': 'stream-browserify'
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
