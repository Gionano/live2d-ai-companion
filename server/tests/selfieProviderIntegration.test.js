import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { JobManager } from '../selfie/jobManager.js';
import { ProviderResolver } from '../selfie/providerResolver.js';
import { prepareSelfieJob } from '../selfie/backendLifecycle.js';
import { installSelfieFeatureControl } from '../selfie/featureControl.js';
import { installSelfieImageRoutes } from '../selfie/imageRoutes.js';

const PLAN = {
  caption: 'Ini fotoku, sayang.', emotion: 'sayang', slots: {},
  positivePrompt: 'portrait', negativePrompt: 'blur', referenceImage: 'default.png',
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(t, providers, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfie-e1-integration-'));
  const config = {
    provider: 'auto', autoOrder: ['comfyui', 'sdcpp'], availabilityCacheMs: 30000,
    maxQueue: 1, dailyLimit: 3, cooldownMs: 0, freeVramAfter: false,
    outputDir: directory, limitsStorePath: null, etaStorePath: path.join(directory, 'eta.json'),
    preset: 'cepat', presets: { cepat: { resolution: 768, steps: 12, cfg: 3 } },
    phrases: { providerUnavailable: ['Aduh sayang, sekarang aku belum bisa foto.'] },
    ...(typeof overrides === 'function' ? overrides(directory) : overrides),
  };
  const events = [];
  const manager = new JobManager(config);
  manager.provider = new ProviderResolver(config, {
    createProvider: (name, providerConfig) => typeof providers[name] === 'function'
      ? providers[name](providerConfig) : providers[name],
    onStatus: (status, publicStatus) => manager._handleProviderStatus(status, publicStatus),
  });
  manager.setBroadcaster(event => events.push(event));
  t.after(async () => {
    await manager.shutdown();
    assert.ok(path.basename(directory).startsWith('selfie-e1-integration-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { manager, events, directory };
}

const readyProvider = generate => ({
  checkReady: async () => ({ ready: true, code: 'READY', message: 'Ready.' }),
  generate,
  cancel: async () => {},
  release: async () => {},
});

async function finishJobs(manager) {
  await Promise.all([...manager._runTasks]);
}

test('preparation failover emits the actual started provider and consumes quota once', async (t) => {
  const calls = [];
  const { manager, events } = harness(t, {
    comfyui: readyProvider(async () => {
      calls.push('comfyui');
      throw Object.assign(new Error('Submission rejected'), { generationStarted: false });
    }),
    sdcpp: readyProvider(async (params, onProgress, signal, onStarted) => {
      calls.push('sdcpp');
      assert.equal(manager.getDailyCount(), 0);
      onStarted();
      assert.equal(manager.getDailyCount(), 1);
      return { imagePath: 'fake.png' };
    }),
  });
  await manager.submitJob({ plan: PLAN });
  await finishJobs(manager);
  assert.deepEqual(calls, ['comfyui', 'sdcpp']);
  assert.deepEqual(events.filter(event => event.type === 'selfie_started').map(event => event.provider), ['sdcpp']);
  assert.equal(events.filter(event => event.type === 'selfie_ready').length, 1);
  assert.equal(manager.getDailyCount(), 1);
});

test('generation failure emits selfie_failed and re-resolves for the next job', async (t) => {
  let available = true;
  let fallbackCalls = 0;
  const primary = readyProvider(async (params, progress, signal, onStarted) => {
    onStarted();
    available = false;
    throw Object.assign(new Error('Generator stopped'), { generationStarted: true });
  });
  primary.checkReady = async () => ({ ready: available, message: 'Generator stopped.' });
  const { manager, events } = harness(t, {
    comfyui: primary,
    sdcpp: readyProvider(async (params, progress, signal, onStarted) => {
      fallbackCalls++;
      onStarted();
      return { imagePath: 'next.png' };
    }),
  });
  await manager.submitJob({ plan: PLAN });
  await finishJobs(manager);
  assert.equal(fallbackCalls, 0);
  assert.equal(events.filter(event => event.type === 'selfie_failed').length, 1);
  assert.equal(manager.getDailyCount(), 1);
  await manager.submitJob({ plan: PLAN });
  await finishJobs(manager);
  assert.equal(fallbackCalls, 1);
  assert.equal(manager.getDailyCount(), 2);
  assert.equal(events.filter(event => event.type === 'selfie_started').at(-1).provider, 'sdcpp');
});

test('an unresolved accepted submission retains quota and releases its provider', async (t) => {
  let releases = 0;
  let fallbackCalls = 0;
  const primary = readyProvider(async () => {
    throw Object.assign(new Error('Lost accepted submission response'), { generationStarted: true });
  });
  primary.release = async () => { releases++; };
  const { manager, events } = harness(t, {
    comfyui: primary,
    sdcpp: readyProvider(async () => { fallbackCalls++; return { imagePath: 'unexpected.png' }; }),
  });
  await manager.submitJob({ plan: PLAN });
  await finishJobs(manager);
  assert.equal(manager.getDailyCount(), 1);
  assert.equal(releases, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(events.filter(event => event.type === 'selfie_failed').length, 1);
  assert.equal(events.find(event => event.type === 'selfie_started').provider, 'comfyui');
});

test('no ready providers skips the cloud planner, refunds admission, and publishes disabled status', async (t) => {
  const offline = { checkReady: async () => ({ ready: false, message: 'Unavailable.' }) };
  const { manager, events } = harness(t, { comfyui: offline, sdcpp: offline });
  let planned = false;
  const result = await prepareSelfieJob({
    manager,
    planner: async () => { planned = true; return { ok: true, plan: PLAN }; },
    userText: 'pap dong', history: [],
  });
  assert.equal(result.reason, 'PROVIDER_UNAVAILABLE');
  assert.match(result.text, /belum bisa foto/);
  assert.equal(planned, false);
  assert.equal(manager.getDailyCount(), 0);
  assert.equal(manager.activeJob, null);
  const status = events.find(event => event.type === 'selfie_feature').status;
  assert.equal(status.active, null);
  assert.ok(status.reasons.comfyui && status.reasons.sdcpp);
});

test('cancelled preparation finishes cleanup before another provider job starts', async (t) => {
  const entered = deferred();
  const cleanup = deferred();
  let calls = 0;
  const { manager, events } = harness(t, {
    comfyui: readyProvider(async (params, progress, signal, onStarted) => {
      calls++;
      if (calls === 1) {
        entered.resolve();
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        await cleanup.promise;
        throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED', generationStarted: false });
      }
      onStarted();
      return { imagePath: 'second.png' };
    }),
    sdcpp: { checkReady: async () => ({ ready: false, message: 'Offline.' }) },
  });
  const first = await manager.submitJob({ plan: PLAN });
  await entered.promise;
  await manager.cancelJob(first.jobId);
  const second = await manager.submitJob({ plan: PLAN });
  assert.equal(second.queued, true);
  assert.equal(calls, 1);
  assert.equal(manager.getDailyCount(), 0);
  cleanup.resolve();
  await finishJobs(manager);
  await finishJobs(manager);
  assert.equal(calls, 2);
  assert.equal(manager.getDailyCount(), 1);
  assert.equal(events.filter(event => event.type === 'selfie_ready').length, 1);
});

test('turn cancellation aborts held readiness and skips planning and fallback', { timeout: 2000 }, async (t) => {
  const entered = deferred();
  const stopped = deferred();
  let readinessSignal;
  let fallbackChecks = 0;
  let planned = false;
  const { manager } = harness(t, {
    comfyui: {
      checkReady: signal => new Promise((resolve, reject) => {
        readinessSignal = signal;
        const onAbort = () => { stopped.resolve(); reject(signal.reason); };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        entered.resolve();
      }),
    },
    sdcpp: { checkReady: async () => { fallbackChecks++; return { ready: true }; } },
  });
  const controller = new AbortController();
  const request = prepareSelfieJob({
    manager, signal: controller.signal, userText: 'pap dong', history: [],
    planner: async () => { planned = true; return { ok: true, plan: PLAN }; },
  });
  const rejected = assert.rejects(request, error => error.name === 'AbortError');
  await entered.promise;
  controller.abort();
  await rejected;
  await stopped.promise;
  assert.equal(readinessSignal.aborted, true);
  assert.equal(fallbackChecks, 0);
  assert.equal(planned, false);
  assert.equal(manager.activeJob, null);
  assert.equal(manager.getDailyCount(), 0);
});

test('provider status broadcasts and feature acknowledgments keep filesystem details in the backend', async (t) => {
  const privatePath = path.win32.join('X:', '/', 'Path With Spaces', 'workflow.json');
  const { manager, events } = harness(t, {
    comfyui: { checkReady: async () => ({
      ready: false, code: 'COMFYUI_WORKFLOW_INVALID',
      message: `Invalid workflow at ${privatePath}`,
      publicMessage: 'ComfyUI workflow is missing or invalid: workflow.json.',
    }) },
    sdcpp: { checkReady: async () => ({
      ready: false, code: 'SDCPP_MODEL_MISSING', message: `Missing model at ${privatePath}`,
      publicMessage: 'sdcpp.vae is missing: vae.gguf',
    }) },
  });
  await manager.refreshProviderStatus({ force: true });
  assert.ok(manager.provider.getStatus().reasons.comfyui.includes(privatePath));
  const sent = [];
  const handle = installSelfieFeatureControl({ socket: {}, manager, send: event => sent.push(event) });
  handle({ type: 'selfie_feature', enabled: false });
  for (const event of [...events, ...sent]) {
    assert.equal(JSON.stringify(event).includes(privatePath), false);
    assert.match(event.status.reasons.comfyui, /workflow\.json/);
    assert.match(event.status.reasons.sdcpp, /vae\.gguf/);
  }
});

test('native generation errors retain their detailed backend reason without leaking paths over status', async (t) => {
  const privatePath = '/private/owner/models/diffusion.gguf';
  const { manager, events } = harness(t, {
    comfyui: readyProvider(async (params, progress, signal, onStarted) => {
      onStarted();
      throw Object.assign(new Error(`Native model failure at ${privatePath}`), { code: 'FAILED' });
    }),
    sdcpp: { checkReady: async () => ({ ready: false, message: 'Offline.' }) },
  });
  await manager.submitJob({ plan: PLAN });
  await finishJobs(manager);
  assert.ok(manager.provider.getStatus().reasons.comfyui.includes(privatePath));
  assert.equal(JSON.stringify(events).includes(privatePath), false);
  assert.match(manager.getProviderStatus().reasons.comfyui, /see backend logs/);
});

test('live config reload keeps output tokens and quota persistence valid during an active job', async (t) => {
  const entered = deferred();
  const completion = deferred();
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const makeProvider = (name, config) => readyProvider(async (params, progress, signal, onStarted) => {
    onStarted();
    if (name === 'comfyui') {
      entered.resolve();
      await completion.promise;
    }
    const imagePath = path.join(config.outputDir, `${name}.png`);
    fs.writeFileSync(imagePath, image);
    return { imagePath };
  });
  t.after(() => completion.resolve());
  const { manager, events, directory } = harness(t, {
    comfyui: config => makeProvider('comfyui', config),
    sdcpp: config => makeProvider('sdcpp', config),
  }, directory => ({
    limitsStoreFile: 'initial-limits.json', limitsStorePath: path.join(directory, 'initial-limits.json'),
  }));
  const initialConfig = manager.config;
  const existingImage = path.join(directory, 'existing.png');
  fs.writeFileSync(existingImage, image);
  manager.tokenMap.set('existing', { filePath: existingImage, jobId: 'existing', timestamp: Date.now() });
  const app = express();
  installSelfieImageRoutes(app, manager);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await manager.submitJob({ plan: PLAN });
  await entered.promise;
  const nextLimitsPath = path.join(directory, 'next-limits.json');
  await manager.updateConfig({
    ...initialConfig, provider: 'sdcpp', outputDir: path.join(directory, 'next output'),
    limitsStoreFile: 'next-limits.json', limitsStorePath: nextLimitsPath,
  });
  assert.equal(manager.config.outputDir, initialConfig.outputDir);
  assert.equal(manager.provider.config.outputDir, initialConfig.outputDir);
  assert.equal(manager.config.limitsStoreFile, initialConfig.limitsStoreFile);
  assert.equal(manager.config.limitsStorePath, initialConfig.limitsStorePath);
  assert.equal((await fetch(`${baseUrl}/api/selfies/existing`)).status, 200);
  completion.resolve();
  await finishJobs(manager);
  await manager.submitJob({ plan: PLAN });
  await finishJobs(manager);
  const readyEvents = events.filter(event => event.type === 'selfie_ready');
  assert.equal(readyEvents.length, 2);
  for (const event of readyEvents) {
    const response = await fetch(baseUrl + event.imageUrl);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  }
  assert.equal(JSON.parse(fs.readFileSync(initialConfig.limitsStorePath, 'utf-8')).dailyRecords.count, 2);
  assert.equal(fs.existsSync(nextLimitsPath), false);
  assert.deepEqual(events.filter(event => event.type === 'selfie_started').map(event => event.provider), ['comfyui', 'sdcpp']);
});

test('insufficient memory refuses before quota is consumed or a started event is emitted', async (t) => {
  const primary = readyProvider(async () => {
    throw Object.assign(new Error('Heuristic memory preflight: insufficient.'), {
      code: 'MEMORY_INSUFFICIENT', generationStarted: false,
    });
  });
  primary.getStatus = () => ({ ready: false, code: 'MEMORY_INSUFFICIENT', memoryTier: 'insufficient' });
  const { manager, events } = harness(t, { sdcpp: primary }, { provider: 'sdcpp' });
  await manager.submitJob({ plan: PLAN });
  await finishJobs(manager);
  assert.equal(manager.getDailyCount(), 0);
  assert.equal(events.filter(event => event.type === 'selfie_started').length, 0);
  assert.equal(events.find(event => event.type === 'selfie_failed').reason, 'MEMORY_INSUFFICIENT');
  assert.equal(manager.getProviderStatus().sdcpp.memoryTier, 'insufficient');
});

test('a runtime CPU guard failure consumes started quota and never triggers automatic failover', async (t) => {
  let fallbackRuns = 0;
  const { manager, events } = harness(t, {
    sdcpp: readyProvider(async (params, progress, signal, onStarted) => {
      onStarted();
      throw Object.assign(new Error('CPU-only runtime backend'), { code: 'NO_GPU_BACKEND', generationStarted: true });
    }),
    comfyui: readyProvider(async () => { fallbackRuns++; return { imagePath: 'unexpected.png' }; }),
  }, { autoOrder: ['sdcpp', 'comfyui'] });
  await manager.submitJob({ plan: PLAN });
  await finishJobs(manager);
  assert.equal(manager.getDailyCount(), 1);
  assert.equal(fallbackRuns, 0);
  assert.equal(events.find(event => event.type === 'selfie_started').provider, 'sdcpp');
  assert.equal(events.find(event => event.type === 'selfie_failed').reason, 'NO_GPU_BACKEND');
});

test('success, failure, and cancellation store bounded per-preset peaks while ETA stays success-only', async (t) => {
  let runs = 0;
  let lastPeaks = null;
  const enteredCancellation = deferred();
  const received = [];
  const primary = readyProvider(async (params, progress, signal, onStarted) => {
    received.push(params);
    runs++;
    onStarted();
    if (runs === 3) {
      enteredCancellation.resolve();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    }
    lastPeaks = { vramUsedGB: runs, privateBytesGB: runs + 1, peakWorkingSetGB: runs + 2,
      commitUsedGB: runs + 3, commitLimitGB: 32 };
    if (runs === 2) throw Object.assign(new Error('Generation failed'), { code: 'FAILED' });
    if (runs === 3) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
    return { imagePath: 'success.png', peaks: lastPeaks };
  });
  primary.getStatus = () => ({ ready: true, code: 'READY', backend: 'cuda', deviceName: 'Fake GPU', lastPeaks });
  primary.getGenerationPeaks = () => lastPeaks;
  const { manager } = harness(t, { sdcpp: primary }, {
    provider: 'sdcpp', preset: 'hemat', etaHistorySize: 2,
    presets: { hemat: { resolution: 768, steps: 12, cfg: 3, sdcpp: { args: ['--vae-tiling'], modelArgs: [] } } },
  });
  await manager.submitJob({ plan: PLAN });
  await finishJobs(manager);
  await manager.submitJob({ plan: PLAN });
  await finishJobs(manager);
  const cancelled = await manager.submitJob({ plan: PLAN });
  await enteredCancellation.promise;
  await manager.cancelJob(cancelled.jobId);
  await finishJobs(manager);
  const history = JSON.parse(fs.readFileSync(manager.config.etaStorePath, 'utf-8'));
  assert.equal(history.hemat.length, 1);
  assert.deepEqual(history._peaks.hemat.map(entry => entry.vramUsedGB), [2, 3]);
  assert.equal(manager.getDailyCount(), 3);
  assert.equal(received.every(params => params.preset === 'hemat'), true);
  assert.deepEqual(received[0].sdcpp, { args: ['--vae-tiling'], modelArgs: [] });
  const fresh = new ProviderResolver(manager.config, { createProvider: () => ({
    checkReady: async () => ({ ready: true, code: 'READY' }),
    getStatus: () => ({ ready: true, code: 'READY', backend: 'cuda', lastPeaks: null }),
  }) });
  await fresh.resolveProvider();
  assert.equal(fresh.getPublicStatus().sdcpp.lastPeaks.vramUsedGB, 3);
});

test('queued jobs persist the actual provider telemetry setting after config reload', async (t) => {
  const entered = deferred();
  const completion = deferred();
  let runs = 0;
  const { manager } = harness(t, {
    sdcpp: config => {
      let currentPeaks = null;
      const provider = readyProvider(async (params, progress, signal, onStarted) => {
        runs++;
        onStarted();
        if (runs === 1) { entered.resolve(); await completion.promise; }
        currentPeaks = config.telemetry?.enabled ? { vramUsedGB: runs } : null;
        return { imagePath: 'fake.png', peaks: currentPeaks };
      });
      provider.getGenerationPeaks = () => currentPeaks;
      return provider;
    },
  }, { provider: 'sdcpp', telemetry: { enabled: false } });
  t.after(() => completion.resolve());
  await manager.submitJob({ plan: PLAN });
  await entered.promise;
  await manager.submitJob({ plan: PLAN });
  await manager.updateConfig({ ...manager.config, telemetry: { enabled: true } });
  completion.resolve();
  while (manager._runTasks.size) await finishJobs(manager);
  const history = JSON.parse(fs.readFileSync(manager.config.etaStorePath, 'utf-8'));
  assert.equal(history.cepat.length, 2);
  assert.deepEqual(history._peaks.cepat.map(entry => entry.vramUsedGB), [2]);
});

test('managed jobs publish profile and separate timings, store peaks, and release even with freeVramAfter disabled', async (t) => {
  let releases = 0;
  let stops = 0;
  const primary = readyProvider(async (params, progress, signal, onStarted) => {
    onStarted();
    return { imagePath: 'managed.png', peaks: { vramUsedGB: 3, sharedGpuUsedGB: 1 } };
  });
  primary.getStatus = () => ({ ready: true, code: 'READY', profile: 'low', running: true });
  primary.getGenerationTimings = () => ({ coldStartMs: 5000, generateMs: 2400 });
  primary.release = async () => { releases++; };
  primary.shutdown = async () => { stops++; };
  const { manager, events } = harness(t, { 'comfyui-managed': primary }, { provider: 'comfyui-managed' });
  await manager.submitJob({ plan: PLAN });
  await finishJobs(manager);
  assert.equal(releases, 1);
  const ready = events.find(event => event.type === 'selfie_ready');
  assert.equal(ready.provider, 'comfyui-managed');
  assert.equal(ready.profile, 'low');
  assert.equal(ready.coldStartMs, 5000);
  assert.equal(ready.generateMs, 2400);
  const history = JSON.parse(fs.readFileSync(manager.config.etaStorePath, 'utf-8'));
  assert.deepEqual(history.cepat, [2000]);
  assert.equal(history._peaks.cepat[0].sharedGpuUsedGB, 1);
  await manager.shutdown();
  assert.equal(releases, 1);
  assert.equal(stops, 1);
});

test('failed managed cold starts release each attempt before generation consumes quota', async (t) => {
  let releases = 0;
  const primary = readyProvider(async () => {
    throw Object.assign(new Error('managed cold start failed'), { code: 'START_FAILED', generationStarted: false });
  });
  primary.release = async () => { releases++; };
  const { manager, events } = harness(t, { 'comfyui-managed': primary }, { provider: 'comfyui-managed' });
  await manager.submitJob({ plan: PLAN });
  await finishJobs(manager);
  await manager.submitJob({ plan: PLAN });
  await finishJobs(manager);
  assert.equal(releases, 2);
  assert.equal(manager.getDailyCount(), 0);
  assert.equal(events.filter(event => event.type === 'selfie_started').length, 0);
});

test('actual admission cancels managed idle stop and abandoned planning rearms it while readiness stays advisory', async (t) => {
  let armed = true;
  let admissions = 0;
  let idles = 0;
  const primary = readyProvider(async () => { throw new Error('Planning-only admission must not generate.'); });
  primary.onJobAdmitted = () => { admissions++; armed = false; };
  primary.onJobsIdle = () => { idles++; armed = true; };
  const { manager } = harness(t, { 'comfyui-managed': primary }, { provider: 'comfyui-managed' });
  await manager.refreshProviderStatus({ force: true });
  await manager.canAcceptJob();
  assert.equal(armed, true);
  assert.equal(admissions, 0, 'periodic/advisory readiness cannot keep a warm process alive');
  const admitted = manager.tryAdmit();
  assert.equal(admitted.allowed, true);
  assert.equal(armed, false);
  assert.equal(admissions, 1);
  await manager.cancelJob(admitted.jobId);
  assert.equal(manager.activeJob, null);
  assert.equal(armed, true);
  assert.equal(idles, 1);
});

test('zero-second managed idle stop cannot fire between queued jobs', async (t) => {
  const firstEntered = deferred();
  const firstDone = deferred();
  const secondEntered = deferred();
  const secondDone = deferred();
  let runs = 0;
  let stops = 0;
  let idleTimer = null;
  const cancelTimer = () => { clearTimeout(idleTimer); idleTimer = null; };
  const armTimer = () => { cancelTimer(); idleTimer = setTimeout(() => { stops++; }, 0); };
  const primary = readyProvider(async (params, progress, signal, onStarted) => {
    runs++;
    assert.equal(stops, 0, 'queued generation must reuse the warm process');
    onStarted();
    if (runs === 1) { firstEntered.resolve(); await firstDone.promise; }
    else { secondEntered.resolve(); await secondDone.promise; }
    return { imagePath: 'queued-managed.png' };
  });
  primary.release = async () => { armTimer(); };
  primary.onJobAdmitted = cancelTimer;
  primary.onJobsIdle = armTimer;
  primary.shutdown = async () => { cancelTimer(); };
  const { manager } = harness(t, { 'comfyui-managed': primary }, { provider: 'comfyui-managed' });
  t.after(() => { firstDone.resolve(); secondDone.resolve(); cancelTimer(); });
  await manager.submitJob({ plan: PLAN });
  await firstEntered.promise;
  await manager.submitJob({ plan: PLAN });
  firstDone.resolve();
  await secondEntered.promise;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stops, 0, 'release idle timer must be cancelled before pumping the next job');
  secondDone.resolve();
  while (manager._runTasks.size) await finishJobs(manager);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runs, 2);
  assert.equal(stops, 1, 'idle stop is rearmed only after the queue drains');
});
