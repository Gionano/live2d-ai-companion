import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';
import viteConfig from '../../vite.config.js';
import { startProductionStaticServer } from '../../desktop-companion/src/main/staticServer.js';
import { JobManager } from '../selfie/jobManager.js';
import { installSelfieLifecycle } from '../selfie/backendLifecycle.js';
import { installSelfieImagePolicy, installSelfieImageRoutes, isLocalImageRequest } from '../selfie/imageRoutes.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const PLAN = { slots: {}, positivePrompt: 'portrait', negativePrompt: 'blur', caption: 'Ini fotonya sayang.', emotion: 'sayang' };
const quietLogger = { info() {}, warn() {}, error() {} };

function get(url, headers = {}, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { headers, method }, (response) => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.setTimeout(5000, () => request.destroy(new Error('Image request timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

function assertPrivateResponse(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(Object.keys(response.headers).some(name => name.startsWith('access-control-')), false);
}

async function closeServer(server) {
  server.closeAllConnections?.();
  if (server.listening) await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
}

async function createBackend(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfie-image-integration-'));
  const outputDir = path.join(directory, 'photos');
  fs.mkdirSync(outputDir);
  const imagePath = path.join(outputDir, 'photo.png');
  fs.writeFileSync(imagePath, PNG);
  const manager = new JobManager({
    outputDir,
    allowLan: false,
    cooldownMs: 0,
    dailyLimit: 10,
    maxQueue: 0,
    freeVramAfter: false,
    etaStorePath: path.join(directory, 'durations.json'),
    limitsStorePath: null,
  });
  manager.provider = {
    async isAvailable() { return true; },
    async generate(_params, onProgress, signal) {
      assert.equal(signal.aborted, false);
      onProgress({ value: 1, max: 1 });
      return { imagePath };
    },
    async cancel() {},
    async release() {},
  };
  const requests = [];
  const app = express();
  app.use((req, res, next) => {
    requests.push({ peer: req.socket.remoteAddress, headers: { ...req.headers } });
    next();
  });
  installSelfieImagePolicy(app, manager);
  app.use(express.json());
  installSelfieImageRoutes(app, manager);
  app.use((error, req, res, next) => res.status(error.status || 500).end());
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  manager.setBroadcaster(event => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
    }
  });
  wss.on('connection', (socket) => {
    socket.on('message', (message) => {
      if (JSON.parse(message.toString()).type === 'test_selfie') void manager.submitJob({ plan: PLAN, skipInitialSpeech: true });
    });
  });
  const lifecycle = installSelfieLifecycle({ manager, server, wss, signals: process, exit() {} });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    lifecycle.dispose();
    await manager.shutdown();
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    await closeServer(server);
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'selfie-image-integration-')));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, outputDir, imagePath, manager, requests, server, wss,
    baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function connect(t, baseUrl) {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws`);
  t.after(() => socket.terminate());
  const events = [];
  const waiters = [];
  socket.on('message', raw => {
    const event = JSON.parse(raw.toString());
    events.push(event);
    for (const waiter of waiters) if (waiter.type === event.type) waiter.resolve(event);
  });
  await once(socket, 'open');
  return {
    socket,
    events,
    waitFor(type) {
      const existing = events.find(event => event.type === type);
      if (existing) return Promise.resolve(existing);
      let timer;
      return new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`No ${type} WS event`)), 5000);
        waiters.push({ type, resolve });
      }).finally(() => clearTimeout(timer));
    },
  };
}

test('HTTP and WS serve only registered, unexpired images inside the real output directory', async (t) => {
  const backend = await createBackend(t);
  const client = await connect(t, backend.baseUrl);
  client.socket.send(JSON.stringify({ type: 'test_selfie' }));
  const ready = await client.waitFor('selfie_ready');
  assert.match(ready.imageUrl, /^\/api\/selfies\/[a-f0-9]{32}$/);

  await t.test('the genuine ready URL serves the file without caching or CORS', async () => {
    const response = await get(backend.baseUrl + ready.imageUrl, { Origin: 'http://localhost:5173' });
    assertPrivateResponse(response, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.deepEqual(response.body, PNG);
    const reconnected = await connect(t, backend.baseUrl);
    assert.deepEqual(await reconnected.waitFor('selfie_snapshot'), {
      type: 'selfie_snapshot', activeJobId: null, events: [ready],
    });
  });

  const register = (token, filePath, timestamp = Date.now()) => {
    backend.manager.tokenMap.set(token, { filePath, timestamp, jobId: 'registered-test' });
    return `${backend.baseUrl}/api/selfies/${token}`;
  };
  await t.test('unknown and expired tokens return 404', async () => {
    assertPrivateResponse(await get(`${backend.baseUrl}/api/selfies/unknown`), 404);
    const expiredUrl = register('expired', backend.imagePath, Date.now() - 24 * 60 * 60 * 1000 - 1);
    assertPrivateResponse(await get(expiredUrl), 404);
    assert.equal(backend.manager.getFileByToken('expired'), null);
  });

  await t.test('registered traversal and sibling-prefix files are rejected', async () => {
    const outside = path.join(backend.directory, 'outside.png');
    const sibling = path.join(backend.directory, 'photos-private');
    fs.writeFileSync(outside, PNG);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'photo.png'), PNG);
    assertPrivateResponse(await get(register('traversal', path.join(backend.outputDir, '..', 'outside.png'))), 403);
    assertPrivateResponse(await get(register('sibling', path.join(sibling, 'photo.png'))), 403);
    assertPrivateResponse(await get(`${backend.baseUrl}/api/selfies/%2e%2e%2foutside.png`), 404);
  });

  await t.test('a directory junction escaping outputDir is rejected after realpath', async () => {
    const externalDir = path.join(backend.directory, 'external');
    const link = path.join(backend.outputDir, 'link');
    fs.mkdirSync(externalDir);
    fs.writeFileSync(path.join(externalDir, 'photo.png'), PNG);
    fs.symlinkSync(externalDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    assertPrivateResponse(await get(register('junction', path.join(link, 'photo.png'))), 403);
  });

  await t.test('original LAN clients and spoofed forwarding chains are rejected', async () => {
    for (const forwarded of ['192.168.1.50', '127.0.0.1, 192.168.1.50', 'invalid', '', 'fe80::1%12']) {
      assertPrivateResponse(await get(backend.baseUrl + ready.imageUrl, { 'X-Forwarded-For': forwarded }), 403);
    }
    assertPrivateResponse(await get(backend.baseUrl + ready.imageUrl, { 'X-Forwarded-For': '127.0.0.1, ::1, ::ffff:127.0.0.1' }), 200);
    const remotePeer = { socket: { remoteAddress: '192.168.1.50' }, headers: { 'x-forwarded-for': '127.0.0.1' } };
    assert.equal(isLocalImageRequest(remotePeer), false);
    backend.manager.config.allowLan = true;
    assertPrivateResponse(await get(backend.baseUrl + ready.imageUrl, { 'X-Forwarded-For': '192.168.1.50' }), 200);
    backend.manager.config.allowLan = false;
  });

  await t.test('JSON parsing failures retain image no-store headers', async () => {
    assertPrivateResponse(await get(backend.baseUrl + ready.imageUrl,
      { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }, 'POST', '{broken'), 400);
  });

  await t.test('Host and trusted original Host must be localhost or 127.0.0.1', async () => {
    for (const headers of [
      { Host: 'attacker.example' },
      { Host: '127.0.0.1.attacker.example' },
      { 'X-Forwarded-Host': 'attacker.example' },
      { 'X-Forwarded-Host': 'localhost, attacker.example' },
    ]) assertPrivateResponse(await get(backend.baseUrl + ready.imageUrl, headers), 403);
    assertPrivateResponse(await get(backend.baseUrl + ready.imageUrl, { Host: 'localhost:8787' }), 200);
  });
});

test('selfie settings expose capability and auto-close only to same-origin local requests', async (t) => {
  const backend = await createBackend(t);
  const settingsUrl = `${backend.baseUrl}/api/selfies/settings`;
  for (const autoCloseSeconds of [30, 0, 12]) {
    backend.manager.config.autoCloseSeconds = autoCloseSeconds;
    for (const headers of [{ 'Sec-Fetch-Site': 'none' }, { 'Sec-Fetch-Site': 'same-origin' },
      { Origin: backend.baseUrl }, { Origin: backend.baseUrl, 'Sec-Fetch-Site': 'same-origin' }]) {
      const local = await get(settingsUrl, headers);
      assertPrivateResponse(local, 200);
      assert.deepEqual(JSON.parse(local.body.toString()), { enabled: true, autoCloseSeconds });
      assert.equal(local.body.toString().includes(backend.outputDir), false);
      assert.equal(local.body.toString().includes('outputDir'), false);
    }
  }
  backend.manager.config.allowLan = true;
  for (const headers of [
    {},
    { 'X-Forwarded-For': '192.168.1.50' },
    { 'X-Forwarded-For': '127.0.0.1, 192.168.1.50' },
    { Host: 'foreign.example' },
    { 'X-Forwarded-Host': 'foreign.example' },
    { Origin: 'http://foreign.example' },
    { Origin: 'null' },
    { Origin: `${backend.baseUrl}/other` },
    { Origin: backend.baseUrl.replace('127.0.0.1', 'localhost') },
    { Origin: backend.baseUrl.replace('http:', 'https:') },
    { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-origin' },
    { Origin: backend.baseUrl, 'Sec-Fetch-Site': 'cross-site' },
    { Origin: backend.baseUrl, 'Sec-Fetch-Site': 'same-site' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
    { 'Sec-Fetch-Site': 'unknown' },
  ]) assertPrivateResponse(await get(settingsUrl, headers), 403);
  assertPrivateResponse(await get(settingsUrl.replace('/settings', '/SETTINGS/'), { Origin: 'null' }), 403);
  assertPrivateResponse(await get(settingsUrl, { Origin: 'http://foreign.example', 'Content-Type': 'application/json' }, 'POST', '{broken'), 403);
  assertPrivateResponse(await get(settingsUrl, {
    Origin: 'http://foreign.example', 'Access-Control-Request-Method': 'GET',
  }, 'OPTIONS'), 403);
  assert.equal(isLocalImageRequest({ socket: { remoteAddress: '192.168.1.50' }, headers: {} }), false);
});

for (const frontend of ['Vite dev', 'Electron production']) {
  test(`${frontend} proxies the genuine WS image URL and preserves image access policy`, async (t) => {
    const backend = await createBackend(t);
    let baseUrl;
    if (frontend === 'Vite dev') {
      assert.equal(viteConfig.server.proxy['/api'].xfwd, true);
      assert.equal(viteConfig.server.proxy['/ws'].xfwd, true);
      const vite = await createViteServer({
        ...viteConfig,
        configFile: false,
        logLevel: 'silent',
        server: {
          ...viteConfig.server,
          port: 0,
          hmr: false,
          watch: null,
          proxy: {
            '/api': { ...viteConfig.server.proxy['/api'], target: backend.baseUrl },
            '/ws': { ...viteConfig.server.proxy['/ws'], target: backend.baseUrl.replace(/^http/, 'ws') },
          },
        },
      });
      await vite.listen();
      baseUrl = `http://127.0.0.1:${vite.httpServer.address().port}`;
      t.after(() => vite.close());
    } else {
      const { server, url } = await startProductionStaticServer(backend.directory, { backendUrl: backend.baseUrl, logger: quietLogger });
      baseUrl = url;
      t.after(() => closeServer(server));
    }
    const client = await connect(t, baseUrl);
    client.socket.send(JSON.stringify({ type: 'test_selfie' }));
    const ready = await client.waitFor('selfie_ready');
    assert.match(ready.imageUrl, /^\/api\/selfies\/[a-f0-9]{32}$/);
    const response = await get(baseUrl + ready.imageUrl, { Origin: 'http://localhost:5173' });
    assertPrivateResponse(response, 200);
    assert.deepEqual(response.body, PNG);
    assert.equal(backend.requests.at(-1).headers.host, new URL(backend.baseUrl).host);
    assert.match(backend.requests.at(-1).headers['x-forwarded-for'], /127\.0\.0\.1/);
    assert.match(backend.requests.at(-1).headers['x-forwarded-host'], /127\.0\.0\.1/);
    assertPrivateResponse(await get(baseUrl + ready.imageUrl, { 'X-Forwarded-For': '127.0.0.1, 192.168.1.50' }), 403);
    assert.match(backend.requests.at(-1).headers['x-forwarded-for'], /192\.168\.1\.50,\s*(?:::ffff:)?127\.0\.0\.1$/);
    assertPrivateResponse(await get(baseUrl + ready.imageUrl, { Host: 'attacker.example', 'X-Forwarded-Host': 'localhost' }), 403);
    const settingsUrl = `${baseUrl}/api/selfies/settings`;
    const settings = await get(settingsUrl, { Origin: baseUrl, 'Sec-Fetch-Site': 'same-origin' });
    assertPrivateResponse(settings, 200);
    assert.deepEqual(JSON.parse(settings.body.toString()), { enabled: true, autoCloseSeconds: 30 });
    assert.equal(settings.body.toString().includes('outputDir'), false);
    assertPrivateResponse(await get(settingsUrl, { Origin: 'http://foreign.example' }), 403);
    assertPrivateResponse(await get(settingsUrl, { Origin: baseUrl, 'Sec-Fetch-Site': 'same-site' }), 403);
    assertPrivateResponse(await get(settingsUrl, { Origin: 'http://foreign.example', 'X-Forwarded-Host': 'foreign.example' }), 403);
    assertPrivateResponse(await get(`${baseUrl}/api/selfies/unknown`, { Origin: 'http://localhost:5173' }), 404);
    assertPrivateResponse(await get(baseUrl + ready.imageUrl, { 'X-Forwarded-For': 'fe80::1%12' }), 403);
    assertPrivateResponse(await get(baseUrl + ready.imageUrl,
      { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }, 'POST', '{broken'), 400);
    assertPrivateResponse(await get(baseUrl + ready.imageUrl.replace('/selfies/', '/SELFIES/'), { Origin: 'http://localhost:5173' }), 200);
    const preflight = await get(baseUrl + ready.imageUrl, {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'GET',
    }, 'OPTIONS');
    assert.equal(Object.keys(preflight.headers).some(name => name.startsWith('access-control-')), false);
    assert.equal(preflight.headers['cache-control'], 'no-store');
    for (const socket of backend.wss.clients) socket.terminate();
    await closeServer(backend.server);
    assertPrivateResponse(await get(baseUrl + ready.imageUrl, { Origin: 'http://localhost:5173' }),
      frontend === 'Vite dev' ? 500 : 502);
  });
}
