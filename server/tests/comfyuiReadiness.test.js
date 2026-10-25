import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { ComfyUiProvider, validateComfyObjectInfo } from '../selfie/providers/comfyuiProvider.js';
import { resolveMapping } from '../selfie/providers/workflowMapping.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = path.join(ROOT_DIR, 'workflows', 'selfie.api.json');
const WORKFLOW = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf-8'));
const MAPPING = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'selfie.mapping.json'), 'utf-8'));
const LOADER_INPUTS = new Set(['unet_name', 'vae_name', 'clip_name', 'image']);

function readyObjectInfo(workflow = WORKFLOW) {
  const result = {};
  for (const node of Object.values(workflow)) {
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

async function startFakeComfy(t, { statsStatus = 200, objectStatus = 200, objectInfo = readyObjectInfo() } = {}) {
  const server = http.createServer((request, response) => {
    if (request.url === '/system_stats') {
      response.writeHead(statsStatus, { 'Content-Type': 'application/json' });
      response.end('{}');
      return;
    }
    if (request.url === '/object_info') {
      response.writeHead(objectStatus, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(objectInfo));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function makeProvider(comfyUrl, overrides = {}) {
  return new ComfyUiProvider({
    comfyUrl,
    workflowPath: WORKFLOW_PATH,
    healthTimeoutMs: 250,
    ...overrides,
  });
}

test('ComfyUI checkReady accepts every workflow node and configured loader file', async (t) => {
  const provider = makeProvider(await startFakeComfy(t));

  assert.deepEqual(await provider.checkReady(), {
    ready: true,
    code: 'READY',
    message: 'ComfyUI is ready.',
  });
});

test('ComfyUI loader readiness also names missing checkpoint, LoRA and upscale model files', () => {
  const workflow = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'missing checkpoint.safetensors' } },
    2: { class_type: 'LoraLoader', inputs: { lora_name: 'missing lora.safetensors' } },
    3: { class_type: 'UpscaleModelLoader', inputs: { model_name: 'missing upscale.pth' } },
  };
  const info = Object.fromEntries(Object.values(workflow).map(node => [node.class_type, {
    input: { required: Object.fromEntries(Object.keys(node.inputs).map(key => [key, [[], {}]])) },
  }]));
  const readiness = validateComfyObjectInfo(workflow, info);
  assert.equal(readiness.code, 'COMFYUI_FILES_MISSING');
  assert.match(readiness.message, /CheckpointLoaderSimple.ckpt_name="missing checkpoint.safetensors"/);
  assert.match(readiness.message, /LoraLoader.lora_name="missing lora.safetensors"/);
  assert.match(readiness.message, /UpscaleModelLoader.model_name="missing upscale.pth"/);
});

test('ComfyUI checkReady names every missing workflow class type', async (t) => {
  const objectInfo = readyObjectInfo();
  delete objectInfo.TextEncodeQwenImage21;
  delete objectInfo.ModelSamplingAuraFlow;
  const provider = makeProvider(await startFakeComfy(t, { objectInfo }));

  const readiness = await provider.checkReady();

  assert.equal(readiness.ready, false);
  assert.equal(readiness.code, 'COMFYUI_NODES_MISSING');
  assert.match(readiness.message, /TextEncodeQwenImage21/);
  assert.match(readiness.message, /ModelSamplingAuraFlow/);
});

test('ComfyUI checkReady names exact missing model and reference assignments', async (t) => {
  const objectInfo = readyObjectInfo();
  objectInfo.UnetLoaderGGUF.input.required.unet_name[0] = [];
  objectInfo.LoadImage.input.required.image[0] = [];
  const provider = makeProvider(await startFakeComfy(t, { objectInfo }));

  const readiness = await provider.checkReady();

  assert.equal(readiness.ready, false);
  assert.equal(readiness.code, 'COMFYUI_FILES_MISSING');
  assert.match(readiness.message, /UnetLoaderGGUF\.unet_name="qwen-image-2\.1-UC-Q5_K_M\.gguf"/);
  assert.match(readiness.message, /LoadImage\.image="IMG_20261013_172709\.jpg"/);
});

test('ComfyUI checkReady reports health and object-info HTTP failures', async (t) => {
  const unhealthy = makeProvider(await startFakeComfy(t, { statsStatus: 503 }));
  const noInfo = makeProvider(await startFakeComfy(t, { objectStatus: 500 }));

  assert.deepEqual(await unhealthy.checkReady(), {
    ready: false,
    code: 'COMFYUI_UNREACHABLE',
    message: 'ComfyUI GET /system_stats returned HTTP 503.',
    publicMessage: 'ComfyUI GET /system_stats returned HTTP 503.',
  });
  assert.deepEqual(await noInfo.checkReady(), {
    ready: false,
    code: 'COMFYUI_OBJECT_INFO',
    message: 'ComfyUI GET /object_info returned HTTP 500.',
    publicMessage: 'ComfyUI GET /object_info returned HTTP 500.',
  });
});

test('ComfyUI checkReady uses healthTimeoutMs for both readiness requests', async () => {
  const provider = makeProvider('http://127.0.0.1:1', { healthTimeoutMs: 1234, healthCheckTimeoutMs: 9999 });
  const timeouts = [];
  provider._fetch = async (pathname, _init, timeoutMs) => {
    timeouts.push([pathname, timeoutMs]);
    return pathname === '/object_info'
      ? { ok: true, json: async () => readyObjectInfo() }
      : { ok: true };
  };

  assert.equal((await provider.checkReady()).ready, true);
  assert.deepEqual(timeouts, [['/system_stats', 1234], ['/object_info', 1234]]);
});

test('ComfyUI object-info validation accepts file choices in optional inputs', () => {
  const objectInfo = readyObjectInfo();
  objectInfo.LoadImage.input.optional = {
    image: objectInfo.LoadImage.input.required.image,
  };
  delete objectInfo.LoadImage.input.required.image;

  assert.equal(validateComfyObjectInfo(WORKFLOW, objectInfo).ready, true);
});

test('ComfyUI public diagnostics name missing files without Windows, Unix, or UNC directories', () => {
  const files = {
    unet_name: path.win32.join('X:', '/', 'Path With Spaces', 'diffusion.gguf'),
    vae_name: '/private/owner/models/vae.safetensors',
    image: '\\\\private-share\\references\\reference.png',
  };
  const readiness = validateComfyObjectInfo({
    loader: { class_type: 'TestLoader', inputs: files },
  }, { TestLoader: { input: { required: {} } } });
  for (const value of Object.values(files)) {
    assert.ok(readiness.message.includes(value));
    assert.ok(readiness.publicMessage.includes(path.win32.basename(value)));
    assert.equal(readiness.publicMessage.includes(value), false);
  }
  assert.match(readiness.publicMessage, /TestLoader\.unet_name="diffusion\.gguf"/);
});

test('ComfyUI object-info validation rejects an empty workflow and checks numbered CLIP inputs', () => {
  assert.equal(validateComfyObjectInfo({}, {}).code, 'COMFYUI_WORKFLOW_INVALID');
  const workflow = {
    clip: {
      class_type: 'DualCLIPLoader',
      inputs: { clip_name1: 'first.safetensors', clip_name2: 'second.safetensors' },
    },
  };
  const objectInfo = {
    DualCLIPLoader: {
      input: {
        required: {
          clip_name1: [['first.safetensors'], {}],
          clip_name2: [[], {}],
        },
      },
    },
  };

  const readiness = validateComfyObjectInfo(workflow, objectInfo);
  assert.equal(readiness.code, 'COMFYUI_FILES_MISSING');
  assert.match(readiness.message, /DualCLIPLoader\.clip_name2="second\.safetensors"/);
});

test('ComfyUI prompt builder applies base and per-provider resolution, steps, and cfg values', () => {
  const provider = makeProvider('http://127.0.0.1:1', {
    preset: 'cepat',
    presets: { cepat: { resolution: 768, steps: 12, cfg: 3 } },
    filenamePrefix: 'test_selfie',
  });
  provider.template = WORKFLOW;
  provider.map = resolveMapping(WORKFLOW, MAPPING);

  const base = provider._buildPrompt({
    positivePrompt: 'positive',
    negativePrompt: 'negative',
    referenceImage: 'reference.png',
    seed: 42,
  });
  const overridden = provider._buildPrompt({
    positivePrompt: 'positive',
    negativePrompt: 'negative',
    referenceImage: 'reference.png',
    seed: 43,
    resolution: 1024,
    steps: 20,
    cfgScale: 4.5,
  });
  const samplerId = provider.map.sampler.id;
  const promptId = provider.map.prompt.id;

  assert.equal(base[promptId].inputs.resolution, 768);
  assert.equal(base[samplerId].inputs.steps, 12);
  assert.equal(base[samplerId].inputs.cfg, 3);
  assert.equal(overridden[promptId].inputs.resolution, 1024);
  assert.equal(overridden[samplerId].inputs.steps, 20);
  assert.equal(overridden[samplerId].inputs.cfg, 4.5);
});

test('ComfyUI square-resolution workflows reject rectangular experiments before submission', () => {
  const provider = makeProvider('http://127.0.0.1:1', {
    preset: 'cepat', presets: { cepat: { resolution: 768, steps: 12, cfg: 3 } },
  });
  provider.template = WORKFLOW;
  provider.map = resolveMapping(WORKFLOW, MAPPING);
  assert.throws(() => provider._buildPrompt({ resolution: 512, width: 512, height: 768 }), error => {
    assert.equal(error.generationStarted, false);
    assert.match(error.message, /square resolution.*sdcpp/);
    return true;
  });
  const prompt = provider._buildPrompt({ resolution: 512, width: 512, height: 512 });
  assert.equal(prompt[provider.map.prompt.id].inputs.resolution, 512);
});

test('ComfyUI startup readiness returns unavailable on timeout and propagates caller abort', async (t) => {
  const sockets = new Set();
  const server = http.createServer((_request, _response) => {});
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const provider = makeProvider(`http://127.0.0.1:${server.address().port}`, { healthTimeoutMs: 20 });

  const timedOut = await provider.checkReady();
  assert.equal(timedOut.ready, false);
  assert.equal(timedOut.code, 'COMFYUI_UNREACHABLE');

  const abort = new AbortController();
  const pending = provider.checkReady(abort.signal);
  abort.abort(new Error('startup stopped'));
  await assert.rejects(pending, /startup stopped/);
});

async function createSubmissionProvider(t, mode) {
  const pending = new Map();
  const requests = [];
  let websocket = null;
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    requests.push({ pathname, method: request.method });
    if (pathname === '/prompt') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      if (mode === 'rejected') {
        response.writeHead(400);
        response.end('invalid prompt');
        return;
      }
      pending.set('ours', payload.client_id);
      if (mode === 'lost') {
        request.socket.destroy();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ prompt_id: 'ours' }));
      queueMicrotask(() => websocket?.send(JSON.stringify({
        type: 'progress',
        data: { prompt_id: 'ours', value: 1, max: 2 },
      })));
      return;
    }
    if (pathname === '/queue' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      for (const id of payload.delete || []) pending.delete(id);
      response.end('{}');
      return;
    }
    request.resume();
    if (pathname === '/queue') {
      response.end(JSON.stringify({
        queue_pending: [...pending].map(([id, clientId]) => [0, id, {}, { client_id: clientId }]),
        queue_running: [],
      }));
      return;
    }
    response.end('{}');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => { websocket = socket; });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const provider = makeProvider(`http://127.0.0.1:${server.address().port}`, {
    defaultReference: 'reference.png',
    cacheRetries: 0,
    freeVramAfter: false,
    jobTimeoutMs: 1000,
    pollIntervalMs: 1000,
  });
  provider.isAvailable = async () => true;
  provider.init = async () => { provider.map = { save: { id: 'save' } }; };
  provider.ensureReference = async () => 'reference.png';
  provider._buildPrompt = () => ({});
  return { provider, pending, requests };
}

test('ComfyUI explicit submission rejection remains eligible for pre-generation failover', async (t) => {
  const { provider } = await createSubmissionProvider(t, 'rejected');
  let starts = 0;

  await assert.rejects(
    provider.generate({}, () => {}, undefined, () => { starts++; }),
    (error) => error.httpStatus === 400 && error.generationStarted === false,
  );
  assert.equal(starts, 0);
});

test('ComfyUI lost submission response is non-retriable and cleans only its client-owned prompt', async (t) => {
  const { provider, pending, requests } = await createSubmissionProvider(t, 'lost');
  let starts = 0;

  await assert.rejects(
    provider.generate({}, () => {}, undefined, () => { starts++; }),
    (error) => error.generationStarted === true,
  );
  assert.equal(starts, 0);
  assert.equal(pending.size, 0);
  assert.equal(requests.some((request) => request.pathname === '/interrupt'), false);
  assert.equal(requests.filter((request) => request.pathname === '/queue').length, 3);
});

test('ComfyUI confirms an accepted prompt exactly once before its first progress callback', async (t) => {
  const { provider } = await createSubmissionProvider(t, 'accepted');
  const abort = new AbortController();
  const order = [];
  const generation = provider.generate(
    {},
    () => {
      order.push('progress');
      abort.abort();
    },
    abort.signal,
    () => order.push('started'),
  );

  await assert.rejects(generation, (error) => error.code === 'CANCELLED' && error.generationStarted === true);
  assert.deepEqual(order, ['started', 'progress']);
});
