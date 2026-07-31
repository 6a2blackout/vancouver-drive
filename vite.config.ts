import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  build: { target: 'esnext' },
  // rapier3d-compat inlines its wasm as base64, so no wasm plugin or
  // top-level-await support is required. This is the reason we use the
  // -compat build rather than @dimforge/rapier3d.
});
