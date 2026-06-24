import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

// Build/dev orchestration for the three Electron targets. Run with
// `npm run dev` (HMR renderer + auto-reload main) or `npm run build`.
export default defineConfig({
  main: {
    build: {
      lib: { entry: resolve(__dirname, 'src/electron/main.ts') },
      rollupOptions: { output: { format: 'es' } },
    },
  },
  preload: {
    build: {
      lib: { entry: resolve(__dirname, 'src/electron/preload.ts') },
      // Preload must be CommonJS (.cjs) for sandboxed contextBridge.
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'preload.cjs' } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
