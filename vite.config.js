import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELFIE_PATH = /^\/api\/selfies(?:\/|$)/i;

const selfieImagePolicy = {
  name: 'selfie-image-policy',
  configureServer(server) {
    // Run before Vite CORS, including preflight and error responses.
    server.middlewares.use((req, res, next) => {
      if (SELFIE_PATH.test(req.url?.split('?')[0] || '')) {
        res.setHeader('Cache-Control', 'no-store');
        const setHeader = res.setHeader;
        res.setHeader = function (name, value) {
          if (String(name).toLowerCase().startsWith('access-control-')) return this;
          return setHeader.call(this, name, value);
        };
      }
      next();
    });
  },
};

function configureApiProxy(proxy) {
  proxy.on('error', (_error, req, res) => {
    if (SELFIE_PATH.test(req.url?.split('?')[0] || '') && !res.headersSent) {
      res.setHeader('Cache-Control', 'no-store');
      for (const name of res.getHeaderNames()) {
        if (String(name).toLowerCase().startsWith('access-control-')) res.removeHeader(name);
      }
    }
  });
  proxy.on('proxyReq', (proxyReq, req) => {
    // http-proxy preserves a supplied X-Forwarded-Host; retain the actual Host too.
    const forwarded = proxyReq.getHeader('x-forwarded-host');
    proxyReq.setHeader('x-forwarded-host', forwarded ? `${forwarded},${req.headers.host || ''}` : req.headers.host || '');
  });
  proxy.on('proxyRes', (proxyRes, req, res) => {
    if (!SELFIE_PATH.test(req.url?.split('?')[0] || '')) return;
    // Vite's CORS middleware runs before its proxy. Images must remain without CORS.
    for (const name of res.getHeaderNames()) {
      if (String(name).toLowerCase().startsWith('access-control-')) res.removeHeader(name);
    }
    for (const name of Object.keys(proxyRes.headers)) {
      if (name.startsWith('access-control-')) delete proxyRes.headers[name];
    }
  });
}

// Backend routes remain proxied to Node; @framework points at the vendored,
// official Live2D Cubism Web Framework source.
export default defineConfig({
  plugins: [selfieImagePolicy],
  resolve: {
    alias: {
      '@framework': path.resolve(__dirname, 'vendor/live2d/framework'),
    },
  },
  server: {
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true, xfwd: true, configure: configureApiProxy },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true, changeOrigin: true, xfwd: true },
    },
  },
});
