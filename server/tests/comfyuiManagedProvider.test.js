import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { ComfyUiManagedProvider } from '../selfie/providers/comfyuiManagedProvider.js';
import { ComfyUiProvider } from '../selfie/providers/comfyuiProvider.js';

const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
const WORKFLOW_PATH = path.join(ROOT_DIR, 'workflows', 'selfie.api.json');
const WORKFLOW = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
const FIXTURE = fileURLToPath(new URL('./fixtures/fakeComfyUiManaged.cjs', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/hN8AAAAASUVORK5CYII=', 'base64');

function objectInfo() {
  const info = {};
  for (const node of Object.values(WORKFLOW)) {
    info[node.class_type] ||= { input: { required: {} } };
    for (const [key, value] of Object.entries(node.inputs)) {
      if (/^(unet_name|vae_name|clip_name\d*|image)$/.test(key) && typeof value === 'string') {
        info[node.class_type].input.required[key] = [[value], {}];
      }
    }
  }
  return info;
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for fake managed ComfyUI.');
}

function fixture(t, { env = {}, config = {}, dependencies = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed provider paths with spaces '));
  const script = path.join(root, 'fake ComfyUI main.cjs');
  fs.copyFileSync(FIXTURE, script);
  const reference = Object.values(WORKFLOW).find(node => node.class_type === 'LoadImage').inputs.image;
  fs.writeFileSync(path.join(root, reference), PNG);
  const httpLog = path.join(root, 'requests.log');
  const promptLog = path.join(root, 'prompt.json');
  const children = new Map();
  const rows = [];
  const cfg = {
    rootDir: root, comfyUrl: 'http://127.0.0.1:1',
    workflowPath: WORKFLOW_PATH, mappingPath: path.join(ROOT_DIR, 'selfie.mapping.json'),
    referenceDir: root, defaultReference: reference, outputDir: path.join(root, 'output images'),
    jobTimeoutMs: 8000, healthTimeoutMs: 500, pollIntervalMs: 20, cacheRetries: 0,
    freeVramAfter: false, telemetry: { enabled: false }, preset: 'cepat',
    presets: { cepat: { resolution: 768, steps: 12, cfg: 3 } }, filenamePrefix: 'managed-test',
    comfyuiManaged: {
      installDir: root, pythonPath: process.execPath, mainScript: script,
      host: '127.0.0.1', port: 'auto', args: [], profile: 'test', profiles: { test: { args: ['--lowvram'] } },
      env: { FAKE_HTTP_LOG: httpLog, FAKE_PROMPT_LOG: promptLog, FAKE_OBJECT_INFO: JSON.stringify(objectInfo()), ...env },
      healthPath: '/system_stats', startTimeoutMs: 3000, idleStopSeconds: 0.15,
    }, ...config,
  };
  const provider = new ComfyUiManagedProvider(cfg, {
    appendRun: async row => rows.push(row), warner: () => {},
    processOptions: {
      logger: () => {}, warner: () => {}, gracefulTimeoutMs: 50,
      processIdentity: async pid => ({ name: path.basename(process.execPath), executablePath: process.execPath,
        commandLine: `${process.execPath} ${script}`, startedAt: `start-${pid}` }),
      onChild: child => children.set(child.pid, child),
      killTree: async pid => { children.get(pid)?.kill(); },
    }, ...dependencies,
  });
  t.after(async () => { await provider.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const params = { preset: 'cepat', positivePrompt: 'safe selfie', negativePrompt: 'blur', referenceImage: reference,
    resolution: 768, steps: 12, cfgScale: 3 };
  return { provider, cfg, params, root, rows, httpLog, promptLog };
}

test('managed provider readiness is a launch probe without starting ComfyUI', async t => {
  const { provider } = fixture(t);
  assert.equal((await provider.checkReady()).ready, true);
  assert.equal(provider.getStatus().running, false);
  assert.equal(provider.delegate, null);
  assert.match((await provider.checkReady()).message, /checked after start/);
});

test('managed generation composes workflow/title mapping, random seeds, free and warm reuse', async t => {
  const { provider, params, httpLog, promptLog, rows } = fixture(t);
  const statuses = [];
  provider.setStatusListener(value => statuses.push(value));
  const started = [];
  const first = await provider.generate(params, () => {}, undefined, name => started.push(name));
  const pid = provider.lifecycle.getStatus().pid;
  assert.ok(provider.delegate instanceof ComfyUiProvider);
  assert.equal(first.provider, 'comfyui-managed');
  assert.equal(first.profile, 'test');
  assert.ok(first.timings.coldStartMs > 0);
  assert.ok(first.timings.generateMs > 0);
  assert.deepEqual(fs.readFileSync(first.imagePath), PNG);
  const second = await provider.generate(params, () => {}, undefined, name => started.push(name));
  assert.equal(provider.lifecycle.getStatus().pid, pid);
  assert.equal(second.timings.coldStartMs, 0);
  assert.notEqual(first.seed, second.seed);
  const workflow = JSON.parse(fs.readFileSync(promptLog, 'utf8'));
  assert.equal(Object.values(workflow).find(node => node.class_type === 'KSampler').inputs.seed, second.seed);
  assert.equal(Object.values(workflow).find(node => node.class_type === 'TextEncodeQwenImage21').inputs.prompt, params.positivePrompt);
  assert.deepEqual(started, ['comfyui-managed', 'comfyui-managed']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].profile, 'test');
  assert.equal(fs.readFileSync(httpLog, 'utf8').match(/POST \/free/g).length, 2);
  await provider.release();
  assert.equal(fs.readFileSync(httpLog, 'utf8').match(/POST \/free/g).length, 2);
  provider.onJobAdmitted();
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(provider.getStatus().running, true, 'admitted planning job keeps the owned child warm');
  provider.onJobsIdle();
  await waitFor(() => !provider.getStatus().running);
  assert.ok(statuses.some(status => status.running && status.profile === 'test'));
  assert.equal(statuses.at(-1).running, false);
});

test('managed post-start readiness names a missing workflow node and frees without submission', async t => {
  const info = objectInfo();
  delete info.UnetLoaderGGUF;
  const { provider, params, httpLog, rows } = fixture(t, { env: { FAKE_OBJECT_INFO: JSON.stringify(info) } });
  await assert.rejects(provider.generate(params), error => error.code === 'COMFYUI_NODES_MISSING'
    && /UnetLoaderGGUF/.test(error.message) && error.generationStarted === false);
  const readiness = await provider.checkReady();
  assert.equal(readiness.ready, false);
  assert.match(readiness.message, /UnetLoaderGGUF/);
  const requests = fs.readFileSync(httpLog, 'utf8');
  assert.ok(requests.includes('GET /object_info'));
  assert.ok(requests.includes('POST /free'));
  assert.ok(!requests.includes('POST /prompt'));
  assert.equal(rows[0].status, 'COMFYUI_NODES_MISSING');
});

test('managed admitted jobs prevent zero-second idle shutdown during asynchronous terminal logging', async t => {
  const { provider, cfg, params } = fixture(t, { dependencies: {
    appendRun: async () => { await new Promise(resolve => setTimeout(resolve, 30)); },
  } });
  cfg.comfyuiManaged.idleStopSeconds = 0;
  provider.onJobAdmitted();
  await provider.generate(params);
  const pid = provider.lifecycle.getStatus().pid;
  assert.equal(provider.getStatus().running, true);
  provider.onJobAdmitted();
  const next = await provider.generate(params);
  assert.equal(provider.lifecycle.getStatus().pid, pid);
  assert.equal(next.timings.coldStartMs, 0);
  provider.onJobsIdle();
  await waitFor(() => !provider.getStatus().running);
});

test('managed post-start readiness names the exact missing loader model', async t => {
  const info = objectInfo();
  info.VAELoader.input.required.vae_name[0] = [];
  const { provider, params } = fixture(t, { env: { FAKE_OBJECT_INFO: JSON.stringify(info) } });
  await assert.rejects(provider.generate(params), /VAELoader\.vae_name="qwen_image_2.1_vae_bf16.safetensors"/);
});

test('managed custom health path is honored by both lifecycle and delegated readiness', async t => {
  const { provider, cfg } = fixture(t, { env: { FAKE_HEALTH_PATH: '/health' } });
  cfg.comfyuiManaged.healthPath = '/health';
  await provider.ensureRunning();
  assert.equal((await provider.checkReady()).ready, true);
});

test('managed cancel uses the existing owned queue/interrupt path then releases', async t => {
  const { provider, params, httpLog, rows } = fixture(t, { env: { FAKE_SLOW: '1' } });
  const controller = new AbortController();
  const running = provider.generate(params, () => {}, controller.signal);
  const rejected = assert.rejects(running, error => error.code === 'CANCELLED' && error.generationStarted);
  await waitFor(() => fs.existsSync(httpLog) && fs.readFileSync(httpLog, 'utf8').includes('POST /prompt'));
  await new Promise(resolve => setTimeout(resolve, 25));
  controller.abort();
  await rejected;
  const requests = fs.readFileSync(httpLog, 'utf8');
  assert.ok(requests.includes('GET /queue'));
  assert.ok(requests.includes('POST /interrupt'));
  assert.ok(requests.includes('POST /free'));
  assert.equal(rows[0].status, 'CANCELLED');
});

test('managed shutdown aborts a cold start and joins owned-child cleanup', async t => {
  const { provider, params } = fixture(t, { env: { FAKE_READY_DELAY_MS: '20000' } });
  const rejected = assert.rejects(provider.generate(params), error => error.code === 'CANCELLED');
  await waitFor(() => provider.getStatus().running);
  await provider.shutdown();
  await rejected;
  assert.equal(provider.getStatus().running, false);
  assert.equal(provider.lifecycle.child, null);
});

test('managed telemetry composes the shared sampler, reports all peaks and stops per job', async t => {
  const peaks = { vramUsedGB: 4, sharedGpuUsedGB: 1, privateBytesGB: 6, peakWorkingSetGB: 5,
    commitUsedGB: 12, commitLimitGB: 32 };
  const samples = [];
  let stops = 0;
  const { provider, params, rows } = fixture(t, { config: { telemetry: { enabled: true } }, dependencies: {
    monitor: { start: (pid, { onPeaks }) => {
      samples.push(pid); onPeaks(peaks);
      return { stop: () => { stops++; return peaks; } };
    } },
  } });
  const result = await provider.generate(params);
  assert.deepEqual(result.peaks, peaks);
  assert.deepEqual(provider.getGenerationPeaks(), peaks);
  assert.deepEqual(rows[0].peaks, peaks);
  assert.equal(samples.length, 1);
  assert.equal(stops, 1);
  assert.equal(provider.getGenerationTimings().coldStartMs, result.timings.coldStartMs);
  assert.equal(provider.lifecycle.child.listenerCount('exit'), 0);
});

test('managed provider forwards progress through its composed provider', async t => {
  const progress = [];
  const { provider, params } = fixture(t, { dependencies: {
    createComfyProvider: cfg => ({ baseUrl: cfg.comfyUrl,
      checkReady: async () => ({ ready: true, code: 'READY' }), cancel: async () => {}, release: async () => {},
      generate: async (input, onProgress, _signal, onStarted) => {
        assert.equal(input, params); onStarted(); onProgress({ value: 4, max: 12 });
        return { seed: 123, timings: { generateMs: 4, totalMs: 5 } };
      },
    }),
  } });
  await provider.generate(params, value => progress.push(value));
  assert.deepEqual(progress, [{ value: 4, max: 12 }]);
});

test('managed provider never sends health, free, interrupt or shutdown to configured external ComfyUI', async t => {
  const requests = [];
  const external = http.createServer((req, res) => { requests.push(req.url); res.end('{}'); });
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => external.close(resolve)));
  const { provider, params } = fixture(t, { config: { comfyUrl: `http://127.0.0.1:${external.address().port}` } });
  await provider.generate(params);
  await provider.shutdown();
  assert.deepEqual(requests, []);
  assert.equal(external.listening, true);
});

test('managed shutdown stops the owned child even when delegated cancellation throws', async t => {
  const { provider } = fixture(t, { dependencies: {
    createComfyProvider: cfg => ({ baseUrl: cfg.comfyUrl,
      checkReady: async () => ({ ready: true, code: 'READY' }),
      cancel: async () => { throw new Error('fake cancel failed'); }, release: async () => {},
    }),
  } });
  await provider.ensureRunning();
  await provider.shutdown();
  assert.equal(provider.getStatus().running, false);
});
