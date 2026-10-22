import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { ComfyUiProvider } from '../providers/comfyuiProvider.js';
import { IMAGE_ERROR } from '../imageProvider.js';
import { JobManager } from '../jobManager.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function createProvider(t, { holdSubmission = false, jobTimeoutMs = 2000 } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  t.after(() => {
    for (const socket of wss.clients) socket.terminate();
    return new Promise((resolve) => wss.close(resolve));
  });

  const submitted = deferred();
  const submissionResponse = deferred();
  const pending = new Set();
  const requests = [];
  let socket;
  let running = null;
  wss.on('connection', (client) => { socket = client; });

  class FakeComfyUiProvider extends ComfyUiProvider {
    async isAvailable() { return true; }
    async init() { this.map = { save: { id: 'save' } }; }
    async ensureReference() { return 'reference.png'; }
    _buildPrompt() { return {}; }
    async _json(pathname, init = {}) {
      if (pathname === '/queue' && init.method === 'POST') return this._fetch(pathname, init);
      if (pathname === '/queue') {
        requests.push({ pathname, method: 'GET' });
        return {
          queue_pending: [
            ...[...pending].map(id => [0, id, {}, { client_id: this.clientId }]),
            [1, 'another-client-prompt', {}, { client_id: 'another-client' }],
          ],
          queue_running: running ? [[0, running, {}, { client_id: this.clientId }]] : [],
        };
      }
      if (pathname === '/prompt') {
        pending.add('prompt-1');
        submitted.resolve();
        if (holdSubmission) await submissionResponse.promise;
        return { prompt_id: 'prompt-1' };
      }
      return {};
    }
    async _fetch(pathname, init) {
      requests.push({ pathname, method: init.method, body: init.body });
      if (pathname === '/interrupt') running = null;
      if (pathname === '/queue') {
        for (const id of JSON.parse(init.body).delete) pending.delete(id);
      }
      return { ok: true, status: 200 };
    }
    async _downloadResult() {
      assert.fail('A cancelled job must not download an image.');
    }
  }

  const provider = new FakeComfyUiProvider({
    comfyUrl: `http://127.0.0.1:${wss.address().port}`,
    defaultReference: 'reference.png',
    cacheRetries: 0,
    freeVramAfter: false,
    jobTimeoutMs,
    pollIntervalMs: 2000,
  });
  return {
    provider,
    requests,
    pending,
    submitted: submitted.promise,
    releaseSubmission: submissionResponse.resolve,
    rejectSubmission: submissionResponse.reject,
    get running() { return running; },
    start() {
      running = 'prompt-1';
      pending.delete('prompt-1');
      socket.send(JSON.stringify({ type: 'execution_start', data: { prompt_id: 'prompt-1' } }));
    },
  };
}

function assertCancelled(promise, code = IMAGE_ERROR.CANCELLED) {
  return assert.rejects(promise, (error) => error.code === code);
}

function assertRemoteCancelled(fake, promptId, running = false) {
  assert.equal(fake.provider.active, null);
  assert.equal(fake.pending.size, 0);
  assert.equal(fake.running, null);
  assert.equal(fake.requests.filter((request) => request.pathname === '/interrupt').length, running ? 1 : 0);
  const queueRequests = fake.requests.filter((request) => request.pathname === '/queue' && request.method === 'POST');
  assert.equal(queueRequests.length, promptId && !running ? 1 : 0);
  if (promptId && !running) assert.deepEqual(JSON.parse(queueRequests[0].body), { delete: [promptId] });
  if (!promptId) assert.equal(fake.requests.length, 0);
}

test('ComfyUI rejects an already-aborted signal before submitting a prompt', async (t) => {
  const fake = await createProvider(t);
  const controller = new AbortController();
  controller.abort();
  await assertCancelled(fake.provider.generate({}, () => {}, controller.signal));
  assertRemoteCancelled(fake);
});

test('ComfyUI checks for abort immediately after installing the signal listener', async (t) => {
  const fake = await createProvider(t);
  const controller = new AbortController();
  const signal = {
    get aborted() { return controller.signal.aborted; },
    addEventListener(type, listener, options) {
      controller.abort();
      controller.signal.addEventListener(type, listener, options);
    },
    removeEventListener(type, listener) {
      controller.signal.removeEventListener(type, listener);
    },
  };
  await assertCancelled(fake.provider.generate({}, () => {}, signal));
  assertRemoteCancelled(fake);
});

test('ComfyUI dequeues a prompt accepted while its submission response is pending', async (t) => {
  const fake = await createProvider(t, { holdSubmission: true });
  const controller = new AbortController();
  const generation = fake.provider.generate({}, () => {}, controller.signal);
  const rejected = assertCancelled(generation);
  await fake.submitted;
  controller.abort();
  fake.releaseSubmission();
  await rejected;
  assertRemoteCancelled(fake, 'prompt-1');
});

test('ComfyUI recovers and dequeues its accepted prompt when an aborted submission loses its response', async (t) => {
  const fake = await createProvider(t, { holdSubmission: true });
  const controller = new AbortController();
  const generation = fake.provider.generate({}, () => {}, controller.signal);
  const rejected = assertCancelled(generation);
  await fake.submitted;
  controller.abort();
  fake.rejectSubmission(new Error('Submission response lost'));
  await rejected;
  assertRemoteCancelled(fake, 'prompt-1');
  assert.equal(fake.requests.filter(request => request.pathname === '/queue' && request.method === 'GET').length, 2);
});

for (const phase of ['queued', 'running']) {
  test(`ComfyUI cleans only its aborted ${phase} prompt`, async (t) => {
    const fake = await createProvider(t);
    const controller = new AbortController();
    const generation = fake.provider.generate({}, () => {}, controller.signal);
    const rejected = assertCancelled(generation);
    await fake.submitted;
    // Let the accepted prompt reach the generation wait before cancellation.
    await new Promise((resolve) => setImmediate(resolve));
    if (phase === 'running') fake.start();
    controller.abort();
    await rejected;
    assertRemoteCancelled(fake, 'prompt-1', phase === 'running');
  });
}

test('ComfyUI timeout during submission cancels the accepted prompt', async (t) => {
  const fake = await createProvider(t, { holdSubmission: true, jobTimeoutMs: 20 });
  const generation = fake.provider.generate({});
  const rejected = assertCancelled(generation, IMAGE_ERROR.TIMEOUT);
  await fake.submitted;
  await new Promise((resolve) => fake.provider.active.ctl.signal.addEventListener('abort', resolve, { once: true }));
  fake.releaseSubmission();
  await rejected;
  assertRemoteCancelled(fake, 'prompt-1');
});

async function fakeComfyServer(t, { hold = null, running = 'manual-prompt' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfie-comfy-http-'));
  fs.writeFileSync(path.join(directory, 'reference.png'), 'reference');
  const entered = deferred();
  const submitted = deferred();
  const requests = [];
  const pending = new Map();
  let current = running;
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    requests.push({ pathname, method: req.method });
    if (pathname === hold) { req.resume(); entered.resolve(); return; }
    if (pathname === '/prompt' || pathname === '/queue' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      requests.at(-1).body = payload;
      if (pathname === '/prompt') {
        pending.set('ours', payload.client_id);
        res.end(JSON.stringify({ prompt_id: 'ours' }));
        submitted.resolve();
      } else {
        for (const id of payload.delete) pending.delete(id);
        res.end('{}');
      }
      return;
    }
    req.resume();
    if (pathname === '/view') { res.writeHead(404); return res.end(); }
    if (pathname === '/queue') return res.end(JSON.stringify({
      queue_pending: [...pending].map(([id, clientId]) => [0, id, {}, { client_id: clientId }]),
      queue_running: current ? [[0, current, {}, { client_id: 'manual-client' }]] : [],
    }));
    if (pathname === '/interrupt') current = null;
    res.end('{}');
  });
  const wss = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = new ComfyUiProvider({
    comfyUrl: `http://127.0.0.1:${server.address().port}`, referenceDir: directory,
    defaultReference: 'reference.png', outputDir: directory,
    cacheRetries: 0, jobTimeoutMs: 2000, healthCheckTimeoutMs: 1000,
    freeVramAfter: false, pollIntervalMs: 1000,
  });
  provider.init = async signal => { signal.throwIfAborted(); provider.map = {}; };
  provider._buildPrompt = () => ({});
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { provider, entered: entered.promise, submitted: submitted.promise, pending, requests,
    get running() { return current; }, set running(value) { current = value; } };
}

for (const stage of ['/system_stats', '/view', '/upload/image']) {
  test(`HTTP cancellation during preparation ${stage} reaches shutdown release promptly`, { timeout: 3000 }, async (t) => {
    const fake = await fakeComfyServer(t, { hold: stage });
    const manager = new JobManager({
      limitsStorePath: null, etaStorePath: null, maxQueue: 0, cooldownMs: 0,
      dailyLimit: 2, freeVramAfter: false,
    });
    fake.provider.isAvailable = async signal => {
      // JobManager checks availability without a signal before generate().
      if (!signal) return true;
      return ComfyUiProvider.prototype.isAvailable.call(fake.provider, signal);
    };
    manager.provider = fake.provider;
    t.after(() => manager.shutdown());
    await manager.submitJob({ plan: { slots: {}, caption: 'test', referenceImage: 'reference.png' } });
    await fake.entered;
    assert.ok(fake.provider.active);
    const started = Date.now();
    await manager.shutdown();
    assert.ok(Date.now() - started < 1000);
    assert.equal(fake.provider.active, null);
    assert.equal(fake.requests.filter(req => req.pathname === '/free').length, 1);
    assert.equal(fake.requests.some(req => ['/prompt', '/interrupt', '/queue'].includes(req.pathname)), false);
    assert.equal(fake.running, 'manual-prompt');
  });
}

test('HTTP preparation timeout applies before prompt submission', { timeout: 3000 }, async (t) => {
  const fake = await fakeComfyServer(t, { hold: '/upload/image' });
  fake.provider.cfg.jobTimeoutMs = 150;
  await assertCancelled(fake.provider.generate({}), IMAGE_ERROR.TIMEOUT);
  assert.equal(fake.provider.active, null);
  assert.equal(fake.requests.some(req => ['/prompt', '/interrupt', '/queue'].includes(req.pathname)), false);
});

test('HTTP pending cancellation leaves an unrelated running prompt untouched', { timeout: 3000 }, async (t) => {
  const fake = await fakeComfyServer(t);
  const abort = new AbortController();
  const rejected = assertCancelled(fake.provider.generate({}, () => {}, abort.signal));
  await fake.submitted;
  abort.abort();
  await rejected;
  assert.equal(fake.pending.size, 0);
  assert.equal(fake.running, 'manual-prompt');
  assert.equal(fake.requests.some(req => req.pathname === '/interrupt'), false);
  assert.deepEqual(fake.requests.find(req => req.pathname === '/queue' && req.method === 'POST').body, { delete: ['ours'] });
});

test('HTTP cancellation verifies ownership before interrupting a running prompt', async (t) => {
  const fake = await fakeComfyServer(t, { running: 'ours' });
  await fake.provider._cancelRemote('ours', true);
  assert.equal(fake.running, null);
  assert.deepEqual(fake.requests.map(req => req.pathname), ['/queue', '/interrupt']);
  fake.running = 'manual-prompt';
  await fake.provider._cancelRemote('ours', true);
  assert.equal(fake.running, 'manual-prompt');
  assert.equal(fake.requests.filter(req => req.pathname === '/interrupt').length, 1);
});
