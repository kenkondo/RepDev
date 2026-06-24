import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

// Build/dev orchestration for the three Electron targets. Run with
// `npm run dev` (HMR renderer + auto-reload main) or `npm run build`.
//
// externalizeDepsPlugin keeps production `dependencies` (ssh2, simple-git) OUT
// of the bundle so they load as real CJS modules from node_modules at runtime.
// Inlining them into the ESM main bundle breaks modules that use `__dirname`
// (ssh2) and bloats the bundle. The packager keeps these deps via prune:true.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, 'src/electron/main.ts') },
      rollupOptions: { output: { format: 'es' } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
