import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { createServer } from 'vite';
import { CompanionWsClient } from '../../vision-monitor/server/companionWsClient.js';
import monitorConfig from '../../vision-monitor/vite.config.js';

test('monitor bridge connects to the IPv4 main backend even with a legacy localhost URL', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws' });
  await once(server, 'listening');
  const client = new CompanionWsClient(`ws://localhost:${server.address().port}/ws`);
  t.after(async () => {
    client.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  const connected = once(server, 'connection');
  const opened = new Promise(resolve => {
    client.onStatusChange = status => { if (status === 'connected') resolve(); };
  });
  client.connect();
  const [, request] = await connected;
  await opened;
  assert.equal(new URL(client.url).hostname, '127.0.0.1');
  assert.equal(new URL(request.url, 'http://127.0.0.1').searchParams.get('role'), 'monitor');
});

test('monitor dev frontend forwards the same-origin WebSocket to its bridge', async t => {
  const backend = http.createServer();
  const bridge = new WebSocketServer({ server: backend, path: '/ws-monitor' });
  let frontend;
  let socket;
  t.after(async () => {
    socket?.terminate();
    for (const client of bridge.clients) client.terminate();
    await frontend?.close();
    await new Promise(resolve => bridge.close(resolve));
    await new Promise(resolve => backend.close(resolve));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const oldPort = process.env.PORT;
  process.env.PORT = String(backend.address().port);
  let config;
  try { config = monitorConfig({ mode: 'test' }); }
  finally {
    if (oldPort === undefined) delete process.env.PORT;
    else process.env.PORT = oldPort;
  }
  const target = `http://127.0.0.1:${backend.address().port}`;
  assert.equal(config.server.proxy['/ws-monitor'].target, target);
  assert.equal(config.preview.proxy['/ws-monitor'].target, target);
  frontend = await createServer({ root: process.cwd(), configFile: false, logLevel: 'silent',
    cacheDir: './.test-vite-cache', css: { postcss: { plugins: [] } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, proxy: config.server.proxy,
      watch: null, fs: { allow: [process.cwd()] } } });
  await frontend.listen();
  const reachedBridge = once(bridge, 'connection');
  socket = new WebSocket(`ws://127.0.0.1:${frontend.httpServer.address().port}/ws-monitor`);
  const opened = once(socket, 'open');
  const [, request] = await reachedBridge;
  await opened;
  assert.equal(request.url, '/ws-monitor');
});
