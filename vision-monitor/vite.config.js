import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), '');
  const bridgePort = process.env.PORT || env.PORT || '3001';
  const proxy = {
    '/ws-monitor': { target: `http://127.0.0.1:${bridgePort}`, ws: true },
    '/api/status': { target: `http://127.0.0.1:${bridgePort}` },
  };
  return {
    server: { port: 5174, host: '0.0.0.0', allowedHosts: true, proxy },
    preview: { proxy },
  };
});
