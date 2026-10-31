import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderResolver } from '../selfie/providerResolver.js';
import { cleanupManagedComfyUiOnStartup } from '../selfie/comfyuiManagedProcess.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(ROOT_DIR, 'workflows', 'selfie.api.json');
const WORKFLOW = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf-8'));
const LOADER_INPUTS = new Set(['unet_name', 'vae_name', 'clip_name', 'image']);
const HELP_FLAGS = '--diffusion-model --vae --llm --llm_vision -r -p -n --steps '
  + '--cfg-scale --sampling-method -W -H -s --offload-to-cpu -o';

function ready(available, message = 'offline') {
  return { ready: available, code: available ? 'READY' : 'UNAVAILABLE', message };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function readyObjectInfo() {
  const result = {};
  for (const node of Object.values(WORKFLOW)) {
    const entry = result[node.class_type] || { input: { required: {} } };
    for (const [name, value] of Object.entries(node.inputs || {})) {
      if (LOADER_INPUTS.has(name) && typeof value === 'string') {
        entry.input.required[name] = [[value], {}];
      }
    }
    result[node.class_type] = entry;
  }
  return result;
}

async function startFakeComfy(t, { statsStatus = 200, objectInfo = readyObjectInfo() } = {}) {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/system_stats') {
      response.writeHead(statsStatus);
      response.end('{}');
      return;
    }
    if (request.url === '/object_info') {
      response.end(JSON.stringify(objectInfo));
      return;
    }
    response.writeHead(404);
    response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function realProviderConfig(t, comfyUrl, { missingBinary = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver Path With Spaces '));
  const script = path.join(root, 'fake sd-cli.cjs');
  fs.writeFileSync(script, `process.stdout.write(process.argv.includes('--list-devices')
    ? ${JSON.stringify('Devices:\nCUDA0: CUDA Fake GPU\n')} : ${JSON.stringify(`${HELP_FLAGS}\n`)});`);
  const models = {};
  for (const name of ['diffusionModel', 'vae', 'llm']) {
    models[name] = path.join(root, `${name}.gguf`);
    fs.writeFileSync(models[name], name);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    rootDir: root,
    localDir: path.join(root, 'local'),
    provider: 'auto',
    autoOrder: ['comfyui', 'sdcpp'],
    availabilityCacheMs: 30000,
    healthTimeoutMs: 500,
    comfyUrl,
    workflowPath: WORKFLOW_PATH,
    sdcpp: {
      binaryPath: missingBinary ? path.join(root, 'missing sd-cli.exe') : process.execPath,
      ...models,
      llmVision: null,
      offloadToCpu: true,
      extraArgs: [script],
    },
  };
}

function harness(overrides = {}) {
  let now = 1000;
  const created = [];
  const checks = { comfyui: 0, sdcpp: 0 };
  const providers = {
    comfyui: {
      name: 'comfyui',
      readiness: ready(true),
      async checkReady() { checks.comfyui += 1; return this.readiness; },
      async generate() { return { imagePath: 'comfy.png' }; },
      async cancel() { this.cancelled = (this.cancelled || 0) + 1; },
      async release() { this.released = (this.released || 0) + 1; },
    },
    sdcpp: {
      name: 'sdcpp',
      readiness: ready(true),
      async checkReady() { checks.sdcpp += 1; return this.readiness; },
      async generate() { return { imagePath: 'sdcpp.png' }; },
      async cancel() { this.cancelled = (this.cancelled || 0) + 1; },
      async release() { this.released = (this.released || 0) + 1; },
    },
  };
  const statuses = [];
  const config = {
    provider: 'auto',
    autoOrder: ['comfyui', 'sdcpp'],
    availabilityCacheMs: 30000,
    ...overrides,
  };
  const resolver = new ProviderResolver(config, {
    createProvider(name, receivedConfig) {
      created.push({ name, config: receivedConfig });
      return providers[name];
    },
    onStatus: status => statuses.push(status),
    now: () => now,
  });
  return {
    resolver, providers, checks, created, statuses,
    advance(ms) { now += ms; },
  };
}

test('auto selects the first ready provider and caches readiness until expiry', async () => {
  const h = harness();
  const first = await h.resolver.resolveProvider();
  assert.equal(first.name, 'comfyui');
  assert.deepEqual(first.status, { active: 'comfyui', reasons: { comfyui: null, 'comfyui-managed': 'Not checked.', sdcpp: null } });
  assert.deepEqual(h.checks, { comfyui: 1, sdcpp: 1 });

  await h.resolver.resolveProvider();
  assert.deepEqual(h.checks, { comfyui: 1, sdcpp: 1 });
  h.advance(29999);
  await h.resolver.resolveProvider();
  assert.deepEqual(h.checks, { comfyui: 1, sdcpp: 1 });
  h.advance(1);
  await h.resolver.resolveProvider();
  assert.deepEqual(h.checks, { comfyui: 2, sdcpp: 2 });
});

test('missing cache configuration defaults to thirty seconds', async () => {
  const h = harness({ availabilityCacheMs: undefined });
  await h.resolver.resolveProvider();
  h.advance(29999);
  await h.resolver.resolveProvider();
  assert.deepEqual(h.checks, { comfyui: 1, sdcpp: 1 });
  h.advance(1);
  await h.resolver.resolveProvider();
  assert.deepEqual(h.checks, { comfyui: 2, sdcpp: 2 });
});

test('concurrent forced readiness checks share one provider check per revision', async () => {
  const h = harness();
  const comfyGate = deferred();
  const sdcppGate = deferred();
  h.providers.comfyui.checkReady = async () => {
    h.checks.comfyui += 1;
    await comfyGate.promise;
    return ready(true);
  };
  h.providers.sdcpp.checkReady = async () => {
    h.checks.sdcpp += 1;
    await sdcppGate.promise;
    return ready(true);
  };
  const checks = [
    h.resolver.resolveProvider({ force: true }),
    h.resolver.resolveProvider({ force: true }),
    h.resolver.resolveProvider({ force: true }),
  ];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.checks.comfyui, 1);
  comfyGate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.checks.sdcpp, 1);
  sdcppGate.resolve();
  const results = await Promise.all(checks);
  assert.deepEqual(results.map(result => result.name), ['comfyui', 'comfyui', 'comfyui']);
  assert.deepEqual(h.checks, { comfyui: 1, sdcpp: 1 });
});

test('aborting one concurrent readiness caller does not cancel the shared check for others', async () => {
  const h = harness({ provider: 'comfyui' });
  const gate = deferred();
  h.providers.comfyui.checkReady = async (signal) => {
    h.checks.comfyui += 1;
    await gate.promise;
    signal.throwIfAborted();
    return ready(true);
  };
  const controller = new AbortController();
  const cancelled = h.resolver.resolveProvider({ force: true, signal: controller.signal });
  const surviving = h.resolver.resolveProvider({ force: true });
  controller.abort();
  await assert.rejects(cancelled, error => error.name === 'AbortError');
  gate.resolve();
  assert.equal((await surviving).name, 'comfyui');
  assert.equal(h.checks.comfyui, 1);
});

test('a config update prevents stale readiness and instances from publishing', async () => {
  const h = harness();
  const entered = deferred();
  const gate = deferred();
  h.providers.comfyui.checkReady = async () => {
    h.checks.comfyui += 1;
    entered.resolve();
    await gate.promise;
    return ready(true);
  };
  const stale = h.resolver.resolveProvider({ force: true });
  await entered.promise;
  const nextConfig = { provider: 'sdcpp', autoOrder: ['sdcpp'], availabilityCacheMs: 30000 };
  h.resolver.updateConfig(nextConfig);
  const current = await h.resolver.resolveProvider();
  assert.equal(current.name, 'sdcpp');
  gate.resolve();
  assert.equal((await stale).name, 'sdcpp');
  assert.deepEqual(h.resolver.getStatus(), {
    active: 'sdcpp',
    reasons: { comfyui: 'Not checked.', 'comfyui-managed': 'Not checked.', sdcpp: null },
  });
  assert.ok(h.created.some(item => item.name === 'sdcpp' && item.config === nextConfig));
});

test('auto skips an unavailable provider and reports reasons for both providers', async () => {
  const h = harness();
  h.providers.comfyui.readiness = ready(false, 'missing node: TextEncodeQwenImage21');
  const result = await h.resolver.resolveProvider();
  assert.equal(result.name, 'sdcpp');
  assert.deepEqual(result.status, {
    active: 'sdcpp',
    reasons: { comfyui: 'missing node: TextEncodeQwenImage21', 'comfyui-managed': 'Not checked.', sdcpp: null },
  });
});

test('both unavailable disables the resolver with clear provider reasons', async () => {
  const h = harness();
  h.providers.comfyui.readiness = ready(false, 'connection refused');
  h.providers.sdcpp.readiness = ready(false, 'binary missing');
  const status = await h.resolver.checkReady();
  assert.equal(status.ready, false);
  assert.match(status.message, /comfyui: connection refused/);
  assert.match(status.message, /sdcpp: binary missing/);
  assert.deepEqual(h.resolver.getStatus(), {
    active: null,
    reasons: { comfyui: 'connection refused', 'comfyui-managed': 'Not checked.', sdcpp: 'binary missing' },
  });
});

test('explicit provider never checks or falls back to the other provider', async () => {
  const h = harness({ provider: 'comfyui' });
  h.providers.comfyui.generate = async () => { throw new Error('submit rejected'); };
  await assert.rejects(h.resolver.generate({}, () => {}), /submit rejected/);
  assert.deepEqual(h.checks, { comfyui: 1, sdcpp: 0 });
  assert.deepEqual(h.created.map(item => item.name), ['comfyui']);
});

test('auto failover occurs only before generation starts and reports the provider used', async () => {
  const h = harness();
  const started = [];
  h.providers.comfyui.generate = async () => {
    throw Object.assign(new Error('connection refused before submit'), { generationStarted: false });
  };
  h.providers.sdcpp.generate = async (params, progress, signal, onStarted) => {
    onStarted();
    return { imagePath: 'sdcpp.png' };
  };
  const result = await h.resolver.generate({}, () => {}, undefined, name => started.push(name));
  assert.equal(result.imagePath, 'sdcpp.png');
  assert.equal(result.provider, 'sdcpp');
  assert.deepEqual(started, ['sdcpp']);
  assert.equal(h.resolver.getStatus().active, 'sdcpp');
});

test('unknown, cancelled, and aborted failures never trigger speculative failover', async () => {
  for (const scenario of ['unknown', 'cancelled', 'aborted']) {
    const h = harness();
    let sdcppRuns = 0;
    const controller = new AbortController();
    h.providers.sdcpp.generate = async () => { sdcppRuns += 1; return { imagePath: 'unexpected.png' }; };
    h.providers.comfyui.generate = async () => {
      if (scenario === 'aborted') controller.abort();
      const error = new Error(scenario);
      if (scenario === 'cancelled') error.code = 'CANCELLED';
      if (scenario !== 'unknown') error.generationStarted = false;
      throw error;
    };
    await assert.rejects(
      h.resolver.generate({}, () => {}, controller.signal),
      error => error.message === scenario || error.name === 'AbortError',
    );
    assert.equal(sdcppRuns, 0, `${scenario} must not fail over`);
  }
});

test('an explicitly pre-generation timeout may fail over when the caller was not aborted', async () => {
  const h = harness();
  h.providers.comfyui.generate = async () => {
    throw Object.assign(new Error('preparation timeout'), {
      code: 'TIMEOUT',
      generationStarted: false,
    });
  };
  h.providers.sdcpp.generate = async (params, progress, signal, onStarted) => {
    onStarted();
    return { imagePath: 'fallback.png' };
  };
  assert.equal((await h.resolver.generate({}, () => {})).provider, 'sdcpp');
});

test('provider-specific preset overrides are optional and apply resolution, steps, and cfg', async () => {
  for (const providerName of ['comfyui', 'sdcpp']) {
    const h = harness({ provider: providerName });
    const received = [];
    h.providers[providerName].generate = async (params) => {
      received.push(params);
      return { imagePath: `${providerName}.png` };
    };
    const base = {
      positivePrompt: 'portrait',
      resolution: 768,
      steps: 12,
      cfgScale: 3,
    };
    await h.resolver.generate(base, () => {});
    await h.resolver.generate({
      ...base,
      providerOverrides: {
        [providerName]: { resolution: 1024, steps: 24, cfg: 4.5 },
      },
    }, () => {});
    assert.deepEqual(
      received.map(params => ({
        resolution: params.resolution,
        steps: params.steps,
        cfgScale: params.cfgScale,
      })),
      [
        { resolution: 768, steps: 12, cfgScale: 3 },
        { resolution: 1024, steps: 24, cfgScale: 4.5 },
      ],
      providerName,
    );
  }
});

test('mid-generation failure does not fail over and invalidates readiness for the next job', async () => {
  const h = harness();
  h.providers.comfyui.generate = async (params, progress, signal, onStarted) => {
    onStarted();
    throw new Error('generation crashed');
  };
  await assert.rejects(h.resolver.generate({}, () => {}, undefined, () => {}), /generation crashed/);
  assert.equal(h.providers.sdcpp.generated, undefined);
  assert.equal(h.resolver.getStatus().active, null);

  h.providers.comfyui.readiness = ready(false, 'worker stopped');
  h.providers.sdcpp.generate = async (params, progress, signal, onStarted) => {
    h.providers.sdcpp.generated = true;
    onStarted();
    return { imagePath: 'next.png' };
  };
  const result = await h.resolver.generate({}, () => {});
  assert.equal(result.provider, 'sdcpp');
  assert.equal(h.checks.comfyui, 2, 'failed provider is rechecked for the next job');
  assert.equal(h.providers.sdcpp.generated, true);
});

test('cancel and release target the provider currently running the job', async () => {
  const h = harness();
  await h.resolver.generate({}, () => {});
  await h.resolver.cancel();
  await h.resolver.release();
  assert.equal(h.providers.comfyui.cancelled, 1);
  assert.equal(h.providers.comfyui.released, 1);
  assert.equal(h.providers.sdcpp.cancelled, undefined);
  assert.equal(h.providers.sdcpp.released, undefined);
});

test('config updates discard provider instances and readiness cache', async () => {
  const h = harness();
  const entered = deferred();
  const completion = deferred();
  h.providers.comfyui.generate = async () => {
    entered.resolve();
    return completion.promise;
  };
  const running = h.resolver.generate({}, () => {});
  await entered.promise;
  const nextConfig = { provider: 'sdcpp', autoOrder: ['sdcpp'], availabilityCacheMs: 100 };
  h.resolver.updateConfig(nextConfig);
  await h.resolver.cancel();
  assert.equal(h.providers.comfyui.cancelled, 1, 'an active old-config process remains cancellable');
  const result = await h.resolver.resolveProvider();
  assert.equal(result.name, 'sdcpp');
  assert.deepEqual(h.checks, { comfyui: 1, sdcpp: 2 });
  assert.equal(h.created.at(-1).name, 'sdcpp');
  assert.equal(h.created.at(-1).config, nextConfig);
  completion.resolve({ imagePath: 'old-config.png' });
  assert.equal((await running).provider, 'comfyui');
  await h.resolver.release();
  assert.equal(h.providers.comfyui.released, 1);
  assert.equal(h.providers.sdcpp.released, undefined);
});

test('release retains an idle old-config provider after another provider replaces it', async () => {
  const h = harness();
  await h.resolver.generate({}, () => {});
  h.resolver.updateConfig({ provider: 'sdcpp', availabilityCacheMs: 30000 });
  await h.resolver.generate({}, () => {});
  await h.resolver.release();
  await h.resolver.release();
  assert.equal(h.providers.comfyui.released, 1);
  assert.equal(h.providers.sdcpp.released, 1);
});

test('a failed provider release still joins other releases and can be retried', async () => {
  const h = harness();
  let failedReleases = 0;
  h.providers.comfyui.release = async () => {
    failedReleases++;
    if (failedReleases === 1) throw new Error('ComfyUI free failed');
  };
  await h.resolver.generate({}, () => {});
  h.resolver.updateConfig({ provider: 'sdcpp', availabilityCacheMs: 30000 });
  await h.resolver.generate({}, () => {});
  await assert.rejects(h.resolver.release(), AggregateError);
  assert.equal(h.providers.sdcpp.released, 1);
  await h.resolver.release();
  assert.equal(failedReleases, 2);
  assert.equal(h.providers.sdcpp.released, 1);
});

test('real readiness checks prefer a fully ready fake ComfyUI over fake sd-cli', async (t) => {
  const comfyUrl = await startFakeComfy(t);
  const resolver = new ProviderResolver(realProviderConfig(t, comfyUrl));
  const result = await resolver.resolveProvider();
  assert.equal(result.name, 'comfyui');
  assert.deepEqual({ active: result.status.active, reasons: result.status.reasons }, {
    active: 'comfyui',
    reasons: { comfyui: null, 'comfyui-managed': 'Not checked.', sdcpp: null },
  });
});

test('real readiness checks fall back to fake sd-cli when ComfyUI is missing a node', async (t) => {
  const objectInfo = readyObjectInfo();
  delete objectInfo.TextEncodeQwenImage21;
  const comfyUrl = await startFakeComfy(t, { objectInfo });
  const resolver = new ProviderResolver(realProviderConfig(t, comfyUrl));
  const result = await resolver.resolveProvider();
  assert.equal(result.name, 'sdcpp');
  assert.match(result.status.reasons.comfyui, /TextEncodeQwenImage21/);
  assert.equal(result.status.reasons.sdcpp, null);
});

test('real readiness checks disable auto when ComfyUI and sd.cpp are unavailable', async (t) => {
  const comfyUrl = await startFakeComfy(t, { statsStatus: 503 });
  const resolver = new ProviderResolver(realProviderConfig(t, comfyUrl, { missingBinary: true }));
  const status = await resolver.checkReady();
  assert.equal(status.ready, false);
  assert.match(status.message, /ComfyUI GET \/system_stats returned HTTP 503/);
  assert.match(status.message, /sd-cli binary is missing/);
  assert.equal(resolver.getStatus().active, null);
});

test('cached sd.cpp readiness retains metadata and live memory/peak updates publish safe deep copies', async () => {
  const h = harness({ provider: 'sdcpp' });
  let listener;
  const metadata = {
    ready: true, code: 'READY', backend: 'cuda', deviceName: 'NVIDIA Fake GPU',
    memoryTier: null, lastPeaks: null,
  };
  h.providers.sdcpp.getStatus = () => metadata;
  h.providers.sdcpp.setStatusListener = value => { listener = value; };
  await h.resolver.resolveProvider();
  await h.resolver.resolveProvider();
  assert.equal(h.checks.sdcpp, 1);
  assert.equal(h.resolver.getPublicStatus().sdcpp.backend, 'cuda');
  const count = h.statuses.length;
  listener({ ...metadata, memoryTier: 'tight', memoryMessage: 'Heuristic: RAM is tight.',
    lastPeaks: { vramUsedGB: 2, privateBytesGB: 3 }, argv: ['--llm', '/private/model.gguf'],
    rawOutput: path.win32.join('X:', '/', 'Path With Spaces', 'model.gguf'),
  });
  assert.equal(h.statuses.length, count + 1);
  const publicStatus = h.resolver.getPublicStatus();
  assert.equal(publicStatus.sdcpp.memoryTier, 'tight');
  assert.equal(publicStatus.sdcpp.lastPeaks.vramUsedGB, 2);
  assert.equal(JSON.stringify(publicStatus).includes('model.gguf'), false);
  publicStatus.sdcpp.lastPeaks.vramUsedGB = 999;
  assert.equal(h.resolver.getPublicStatus().sdcpp.lastPeaks.vramUsedGB, 2);
  await h.resolver.resolveProvider();
  assert.equal(h.resolver.getPublicStatus().sdcpp.memoryTier, 'tight');
});

test('retired provider status cannot overwrite a new config while its terminal peaks stay available', async () => {
  const h = harness({ provider: 'sdcpp' });
  let listener;
  let lastPeaks = null;
  h.providers.sdcpp.getStatus = () => ({
    ready: true, code: 'READY', backend: 'cuda', deviceName: 'Old GPU', lastPeaks,
  });
  h.providers.sdcpp.setStatusListener = value => { listener = value; };
  await h.resolver.generate({}, () => {});
  const retiredListener = listener;
  h.resolver.updateConfig({ provider: 'comfyui', availabilityCacheMs: 30000 });
  await h.resolver.resolveProvider();
  const current = h.resolver.getPublicStatus();
  lastPeaks = { vramUsedGB: 4 };
  retiredListener({ ready: true, code: 'READY', backend: 'cuda', deviceName: 'Old GPU', lastPeaks });
  assert.deepEqual(h.resolver.getPublicStatus(), current);
  assert.equal(h.resolver.getGenerationStatus().lastPeaks.vramUsedGB, 4);
});

test('resolver forwards effective argv diagnostics to the CLI while public status excludes them', async () => {
  const h = harness({ provider: 'sdcpp' });
  const effective = {
    offloadToCpu: true, args: ['--sampling-method', 'euler'],
    presetArgs: ['--vae-tiling'], effectiveOffloadToCpu: true,
  };
  const warnings = [{ code: 'OFFLOAD_OFF_LOW_VRAM', message: 'Low VRAM.' }];
  h.providers.sdcpp.getEffectiveConfig = () => effective;
  h.providers.sdcpp.getSanityWarnings = () => warnings;
  assert.equal(h.resolver.getEffectiveConfig(), null);
  assert.deepEqual(h.resolver.getSanityWarnings(), []);
  await h.resolver.generate({}, () => {});
  assert.deepEqual(h.resolver.getEffectiveConfig(), effective);
  assert.deepEqual(h.resolver.getSanityWarnings(), warnings);
  const publicStatus = JSON.stringify(h.resolver.getPublicStatus());
  assert.equal(publicStatus.includes('sampling-method'), false);
  assert.equal(publicStatus.includes('OFFLOAD_OFF_LOW_VRAM'), false);
});

function managedResolverHarness(config = {}) {
  const checks = [];
  const created = [];
  const statuses = [];
  const providers = Object.fromEntries(['comfyui', 'comfyui-managed', 'sdcpp'].map(name => [name, {
    name,
    readiness: ready(true),
    status: { ready: true, code: 'READY', profile: 'low', running: false, coldStartMs: null, lastPeaks: null },
    async checkReady() { checks.push(name); return this.readiness; },
    getStatus() { return this.status; },
    setStatusListener(listener) { this.listener = listener; },
    async generate(params, progress, signal, onStarted) { onStarted(); return { imagePath: `${name}.png` }; },
    async release() { this.releases = (this.releases || 0) + 1; },
    async shutdown() { this.stops = (this.stops || 0) + 1; },
  }]));
  const resolver = new ProviderResolver({ provider: 'auto', ...config }, {
    createProvider(name) { created.push(name); return providers[name]; },
    onStatus: status => statuses.push(status),
  });
  return { resolver, checks, providers, created, statuses };
}

test('default resolver auto order places managed ComfyUI between external ComfyUI and sd.cpp', async () => {
  const h = managedResolverHarness();
  h.providers.comfyui.readiness = ready(false, 'external not running');
  const selected = await h.resolver.resolveProvider();
  assert.deepEqual(h.checks, ['comfyui', 'comfyui-managed', 'sdcpp']);
  assert.equal(selected.name, 'comfyui-managed');
  assert.equal(selected.status.comfyuiManaged.profile, 'low');
  assert.equal(selected.status.comfyuiManaged.running, false);
  h.providers['comfyui-managed'].readiness = ready(false, 'managed Python missing');
  assert.equal((await h.resolver.resolveProvider({ force: true })).name, 'sdcpp');
});

test('explicit managed ComfyUI never checks or falls back to another provider', async () => {
  const h = managedResolverHarness({ provider: 'comfyui-managed' });
  h.providers['comfyui-managed'].generate = async () => {
    throw Object.assign(new Error('missing node: CustomTextEncoder'), { generationStarted: false });
  };
  await assert.rejects(h.resolver.generate({}, () => {}), /CustomTextEncoder/);
  assert.deepEqual(h.checks, ['comfyui-managed']);
  assert.deepEqual(h.created, ['comfyui-managed']);
});

test('managed status publishes running/profile safely and forwards isolated generation timing and peaks', async () => {
  const h = managedResolverHarness({ provider: 'comfyui-managed' });
  const provider = h.providers['comfyui-managed'];
  provider.getGenerationTimings = () => ({ coldStartMs: 1532, generateMs: 4210, argv: ['private.py'] });
  provider.getGenerationPeaks = () => ({ vramUsedGB: 3, sharedGpuUsedGB: 1.5, privateBytesGB: 2 });
  await h.resolver.generate({}, () => {});
  provider.status = { ...provider.status, running: true, coldStartMs: 1532,
    lastPeaks: provider.getGenerationPeaks(), pythonPath: path.win32.join('X:', '/', 'Path With Spaces', 'python.exe'), env: { SECRET: 'hidden' } };
  provider.listener(provider.status);
  const publicStatus = h.resolver.getPublicStatus();
  assert.equal(publicStatus.active, 'comfyui-managed');
  assert.equal(publicStatus.comfyuiManaged.profile, 'low');
  assert.equal(publicStatus.comfyuiManaged.running, true);
  assert.equal(JSON.stringify(publicStatus).includes('Private'), false);
  assert.equal(JSON.stringify(publicStatus).includes('hidden'), false);
  assert.deepEqual(h.resolver.getGenerationTimings(), { coldStartMs: 1532, generateMs: 4210 });
  assert.equal(h.resolver.getGenerationPeaks().sharedGpuUsedGB, 1.5);
  publicStatus.comfyuiManaged.lastPeaks.vramUsedGB = 99;
  assert.equal(h.resolver.getGenerationStatus().lastPeaks.vramUsedGB, 3);
});

test('managed config reload waits for the owned running job to finish before replacing its provider', async () => {
  const h = managedResolverHarness({ provider: 'comfyui-managed' });
  const original = h.providers['comfyui-managed'];
  const entered = deferred();
  const completed = deferred();
  original.generate = async () => { entered.resolve(); return completed.promise; };
  const running = h.resolver.generate({}, () => {});
  await entered.promise;
  const retiredListener = original.listener;
  const replacement = { ...original, generate: async () => ({ imagePath: 'new.png' }), status: { ...original.status, profile: 'new' } };
  h.providers['comfyui-managed'] = replacement;
  h.resolver.updateConfig({ provider: 'comfyui-managed' });
  const next = h.resolver.resolveProvider();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.created.length, 1, 'no replacement may start while the retired job is using its child');
  assert.equal(original.stops, undefined);
  completed.resolve({ imagePath: 'old.png' });
  assert.equal((await running).provider, 'comfyui-managed');
  assert.equal((await next).provider, replacement);
  assert.equal(original.releases, 1);
  assert.equal(original.stops, 1);
  const current = h.resolver.getPublicStatus();
  retiredListener({ ...original.status, running: true });
  assert.deepEqual(h.resolver.getPublicStatus(), current);
  await h.resolver.shutdown();
  assert.equal(original.stops, 1);
  assert.equal(replacement.stops, 1);
});

test('backend provider shutdown stops managed children that only passed readiness and joins failures', async () => {
  const h = managedResolverHarness({ provider: 'comfyui-managed' });
  await h.resolver.resolveProvider();
  assert.equal(h.resolver.providersToRelease.size, 0);
  await Promise.all([h.resolver.shutdown(), h.resolver.shutdown()]);
  assert.equal(h.providers['comfyui-managed'].stops, 1);
  assert.equal(h.providers.comfyui.stops, undefined);
  assert.equal(h.providers.sdcpp.stops, undefined);
  await assert.rejects(h.resolver.resolveProvider(), /shutting down/);
});

test('managed workflow presets inherit ComfyUI overrides unless a managed override is configured', async () => {
  const h = managedResolverHarness({ provider: 'comfyui-managed' });
  const received = [];
  h.providers['comfyui-managed'].generate = async params => { received.push(params); return { imagePath: 'result.png' }; };
  const base = { resolution: 768, steps: 12, cfgScale: 3,
    providerOverrides: { comfyui: { resolution: 1024, steps: 20, cfg: 4 } } };
  await h.resolver.generate(base, () => {});
  await h.resolver.generate({ ...base, providerOverrides: { ...base.providerOverrides,
    'comfyui-managed': { resolution: 512, steps: 8, cfg: 2 } } }, () => {});
  assert.deepEqual(received.map(({ resolution, steps, cfgScale }) => ({ resolution, steps, cfgScale })), [
    { resolution: 1024, steps: 20, cfgScale: 4 }, { resolution: 512, steps: 8, cfgScale: 2 },
  ]);
});

test('explicit external providers clean an owned stale managed child without checking or starting managed generation', async (t) => {
  for (const providerName of ['comfyui', 'sdcpp']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfie-startup-cleanup-'));
    const stateFile = path.join(root, 'owned-process.json');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pythonPath = path.join(root, 'Python With Spaces', 'python.exe');
    const mainScript = path.join(root, 'User Comfy UI', 'main.py');
    const record = { owner: 'amika-comfyui-managed-v1', rootDir: root, pid: 501, backendPid: 101,
      pythonPath, mainScript, startedAt: 'old-child', backendStartedAt: 'old-backend' };
    fs.writeFileSync(stateFile, JSON.stringify(record));
    const calls = [];
    const config = { rootDir: root, provider: providerName, comfyuiManaged: { installDir: '', pythonPath: '', mainScript: '' } };
    const resolver = new ProviderResolver(config, {
      initializeManaged: cfg => cleanupManagedComfyUiOnStartup(cfg, {
        stateFile, platform: 'win32', logger() {}, warner() {},
        spawnProcess() { calls.push('unexpected spawn'); throw new Error('Cleanup must not launch help or a server.'); },
        processAlive: () => false,
        processIdentity: async pid => pid === record.pid ? {
          name: 'python.exe', executablePath: pythonPath,
          commandLine: `"${pythonPath}" "${mainScript}"`, startedAt: record.startedAt,
        } : null,
        killTree: async pid => { assert.equal(pid, record.pid); calls.push('owned stale child stopped'); },
      }),
      createProvider(name) {
        calls.push(`factory:${name}`);
        assert.equal(name, providerName);
        return { checkReady: async () => { calls.push(`check:${name}`); return ready(true); } };
      },
    });
    assert.equal((await resolver.resolveProvider()).name, providerName);
    assert.deepEqual(calls, ['owned stale child stopped', `factory:${providerName}`, `check:${providerName}`]);
    assert.equal(fs.existsSync(stateFile), false);
    await resolver.resolveProvider();
    assert.equal(calls.length, 3, 'startup cleanup runs once and cached explicit readiness stays isolated');
    await resolver.shutdown();
  }
});

test('failed owned-child startup cleanup blocks provider selection and exposes safe status', async () => {
  const created = [];
  const privateReason = 'Could not verify owned PID 501 identity at ' + path.win32.join('X:', '/', 'Path With Spaces', 'python.exe.');
  const resolver = new ProviderResolver({ provider: 'comfyui' }, {
    initializeManaged: async () => { throw new Error(privateReason); },
    createProvider(name) { created.push(name); return { checkReady: async () => ready(true) }; },
  });
  await assert.rejects(resolver.resolveProvider(), /verify owned PID/);
  assert.deepEqual(created, []);
  assert.equal(resolver.getStatus().reasons['comfyui-managed'], privateReason);
  assert.equal(JSON.stringify(resolver.getPublicStatus()).includes('Private'), false);
  await assert.rejects(resolver.shutdown(), AggregateError);
});
