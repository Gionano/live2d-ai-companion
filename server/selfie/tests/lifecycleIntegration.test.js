import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { JobManager } from '../jobManager.js';
import { installSelfieLifecycle, prepareSelfieJob } from '../backendLifecycle.js';

const plan = {
  slots: {},
  positivePrompt: 'portrait',
  negativePrompt: 'blur',
  referenceImage: 'reference.png',
  caption: 'Ini fotonya sayang.',
  emotion: 'sayang',
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createManager(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfie-lifecycle-'));
  const started = deferred();
  const completed = deferred();
  const provider = {
    availabilityChecks: 0,
    starts: 0,
    releases: 0,
    cancels: 0,
    async isAvailable() { this.availabilityChecks += 1; return true; },
    generate(params, onProgress, signal) {
      this.starts += 1;
      const abort = () => completed.reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      onProgress({ value: 2, max: 5 });
      started.resolve();
      return completed.promise.finally(() => signal.removeEventListener('abort', abort));
    },
    async cancel() { this.cancels += 1; },
    async release() { this.releases += 1; },
  };
  const manager = new JobManager({
    maxQueue: 1,
    dailyLimit: 5,
    cooldownMs: 0,
    freeVramAfter: false,
    presets: { cepat: { resolution: 768, steps: 12 } },
    etaStorePath: path.join(directory, 'durations.json'),
    limitsStorePath: path.join(directory, 'limits.json'),
    ...overrides,
  });
  manager.provider = provider;
  t.after(async () => {
    await manager.shutdown();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('selfie-lifecycle-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { manager, provider, started, completed, directory };
}

test('backend admission reserves capacity before delayed availability and planning', async (t) => {
  const { manager, provider } = createManager(t);
  const availability = deferred();
  provider.isAvailable = async () => {
    provider.availabilityChecks += 1;
    return availability.promise;
  };
  let plans = 0;
  const request = () => prepareSelfieJob({
    manager,
    planner: async () => { plans += 1; return { ok: true, plan }; },
    userText: 'pap dong',
    history: [],
  });
  const first = request();
  const second = request();
  const third = await request();
  assert.equal(third.ok, false);
  assert.equal(third.reason, 'BUSY');
  assert.equal(plans, 0);
  availability.resolve(true);
  const results = await Promise.all([first, second]);
  assert.equal(results.every(result => result.ok), true);
  assert.ok(provider.availabilityChecks >= 2);
  assert.equal(plans, 2);
  assert.equal(manager.queue.length, 1);
});

test('cancelled admission cannot continue to planning or generation after an await', async (t) => {
  for (const stage of ['availability', 'planning']) {
    await t.test(stage, async (t) => {
      const { manager, provider } = createManager(t, { maxQueue: 0 });
      const paused = deferred();
      const entered = deferred();
      let plans = 0;
      let planner = async () => { plans += 1; return { ok: true, plan }; };
      if (stage === 'availability') {
        provider.isAvailable = async () => { entered.resolve(); return paused.promise; };
      } else {
        planner = async () => { plans += 1; entered.resolve(); return paused.promise; };
      }
      const request = prepareSelfieJob({ manager, planner, userText: 'pap dong', history: [] });
      await entered.promise;
      await manager.cancelJob(manager.activeJob.jobId);
      paused.resolve(stage === 'availability' ? true : { ok: true, plan });
      const result = await request;
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'CANCELLED');
      assert.equal(plans, stage === 'availability' ? 0 : 1);
      assert.equal(provider.starts, 0);
    });
  }
});

test('backend failures and rejected submissions refund reservations before returning', async (t) => {
  for (const failure of ['unavailable', 'availability throws', 'planner blocked', 'planner throws', 'submit rejected']) {
    await t.test(failure, async (t) => {
      const { manager, provider } = createManager(t, { maxQueue: 0, dailyLimit: 1 });
      let planner = async () => ({ ok: true, plan });
      if (failure === 'unavailable') provider.isAvailable = async () => false;
      if (failure === 'availability throws') provider.isAvailable = async () => { throw new Error('Offline'); };
      if (failure === 'planner blocked') {
        planner = async () => ({ ok: false, blocked: true, refusalText: 'Tidak bisa ya sayang.', emotion: 'malu' });
      }
      if (failure === 'planner throws') planner = async () => { throw new Error('Planner unavailable'); };
      if (failure === 'submit rejected') {
        manager.submitJob = async () => ({ ok: false, reason: 'COOLDOWN', text: 'Tunggu sebentar ya.', emotion: 'malu' });
      }
      const request = prepareSelfieJob({ manager, planner, userText: 'pap dong', history: [] });
      if (failure === 'planner throws') await assert.rejects(request, /Planner unavailable/);
      else {
        const result = await request;
        assert.equal(result.ok, false);
        assert.ok(result.text);
        if (failure === 'submit rejected') assert.equal(result.text, 'Tunggu sebentar ya.');
      }
      const retry = manager.tryAdmit();
      assert.equal(retry.allowed, true);
      await manager.cancelJob(retry.jobId);
      assert.equal(provider.starts, 0);
    });
  }
});

test('each companion WS connection receives current progress or ready snapshot', { timeout: 5000 }, async (t) => {
  const { manager, started, completed, directory } = createManager(t);
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    socket.isMonitor = new URL(req.url, 'http://localhost').searchParams.get('role') === 'monitor';
  });
  const lifecycle = installSelfieLifecycle({ manager, server, wss, signals: new EventEmitter(), exit() {} });
  t.after(async () => {
    lifecycle.dispose();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const connect = async (role = '', expectedCount = 2) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws${role}`);
    const messages = [];
    const received = deferred();
    socket.on('message', (raw) => {
      messages.push(JSON.parse(raw.toString()));
      if (messages.length >= expectedCount) received.resolve();
    });
    await once(socket, 'open');
    if (expectedCount) await received.promise;
    t.after(() => socket.terminate());
    return messages;
  };

  const submitted = await manager.submitJob({ plan, skipInitialSpeech: true });
  await started.promise;
  const first = await connect();
  const reconnect = await connect();
  for (const messages of [first, reconnect]) {
    assert.equal(messages[0].type, 'selfie_started');
    assert.equal(messages[0].jobId, submitted.jobId);
    assert.equal(messages[0].etaSeconds, null);
    assert.equal(messages[1].type, 'selfie_progress');
    assert.equal(messages[1].percentage, 40);
  }
  const monitor = await connect('?role=monitor', 0);
  assert.deepEqual(monitor, []);
  const ready = deferred();
  manager.setBroadcaster(event => { if (event.type === 'selfie_ready') ready.resolve(event); });
  completed.resolve({ imagePath: path.join(directory, 'photo.png') });
  const readyEvent = await ready.promise;
  const afterCompletion = await connect('', 1);
  assert.deepEqual(afterCompletion, [readyEvent]);
});

test('backend SIGINT, SIGTERM, and server close await one interrupt and release before exit', async (t) => {
  const { manager, provider, started } = createManager(t);
  await manager.submitJob({ plan, skipInitialSpeech: true });
  await started.promise;
  const server = new EventEmitter();
  const wss = new EventEmitter();
  const signals = new EventEmitter();
  const released = deferred();
  const exitCalled = deferred();
  const exits = [];
  const order = [];
  provider.release = async () => {
    provider.releases += 1;
    order.push('release');
    await released.promise;
  };
  server.close = () => { order.push('close'); server.emit('close'); };
  wss.clients = new Set([{ terminate() { order.push('terminate'); } }]);
  wss.close = () => order.push('ws close');
  const lifecycle = installSelfieLifecycle({
    manager, server, wss, signals,
    exit(code) { exits.push(code); order.push('exit'); exitCalled.resolve(); },
  });
  t.after(() => lifecycle.dispose());
  signals.emit('SIGINT');
  signals.emit('SIGTERM');
  server.emit('close');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(provider.releases, 1);
  assert.ok(provider.cancels >= 1);
  assert.deepEqual(exits, []);
  released.resolve();
  await exitCalled.promise;
  await lifecycle.shutdown();
  assert.deepEqual(exits, [0]);
  assert.equal(provider.releases, 1);
  assert.ok(order.indexOf('release') < order.indexOf('exit'));
  assert.equal(manager.activeJob, null);
});
