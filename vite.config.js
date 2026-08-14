import { defineConfig } from 'vite';
import path from 'path';

// Backend routes remain proxied to Node; @framework points at the vendored,
// official Live2D Cubism Web Framework source.
export default defineConfig({
  resolve: {
    alias: {
      '@framework': path.resolve(__dirname, 'vendor/live2d/framework'),
    },
  },
  server: {
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
