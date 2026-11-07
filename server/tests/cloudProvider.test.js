import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { CloudProvider, CLOUDFLARE_MODEL, buildCloudPrompt } from '../selfie/providers/cloudProvider.js';
import { ProviderResolver } from '../selfie/providerResolver.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'mock-cloud-token';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, fetchImpl, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-pap-'));
  const referenceDir = path.join(root, 'references');
  const outputDir = path.join(root, 'output');
  await fs.mkdir(referenceDir);
  const reference = await sharp({ create: { width: 1200, height: 800, channels: 3, background: 'red' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  await fs.writeFile(path.join(referenceDir, 'default.jpg'), reference);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    provider: 'cloud', referenceDir, defaultReference: 'default.jpg', outputDir, jobTimeoutMs: 1000,
    cloud: { accountId: ACCOUNT, model: CLOUDFLARE_MODEL, healthTimeoutMs: 1000 },
    cloudCredentials: async () => ({ accountId: ACCOUNT, token: TOKEN }), ...extra,
  };
  return { root, config, reference, provider: new CloudProvider(config, { fetchImpl, env: {} }) };
}

async function outputImage() {
  return sharp({ create: { width: 1024, height: 1024, channels: 3, background: 'blue' } }).withMetadata().png().toBuffer();
}

test('cloud sends one identity reference and supported multipart fields, then validates and stores the output', async t => {
  const output = await outputImage();
  let requests = 0;
  const f = await fixture(t, async (url, options) => {
    requests += 1;
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${CLOUDFLARE_MODEL}`);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.headers['Content-Type'], undefined);
    assert.deepEqual([...options.body.keys()], ['prompt', 'input_image_0', 'width', 'height', 'seed']);
    assert.match(options.body.get('prompt'), /identity reference.*sunset/s);
    assert.equal(options.body.get('width'), '1024');
    assert.equal(options.body.get('height'), '1024');
    assert.equal(options.body.get('seed'), '42');
    const reference = await sharp(Buffer.from(await options.body.get('input_image_0').arrayBuffer())).metadata();
    assert.equal(reference.width, 320);
    assert.equal(reference.height, 480);
    assert.equal(reference.orientation, undefined);
    assert.equal(reference.exif, undefined);
    return json({ success: true, result: { image: output.toString('base64') } });
  });
  const phases = [];
  let starts = 0;
  const result = await f.provider.generate({ positivePrompt: 'sunset portrait', negativePrompt: 'ignored', cfgScale: 99, steps: 99, seed: 42 },
    progress => phases.push(progress), undefined, () => { starts += 1; });
  assert.equal(requests, 1);
  assert.equal(starts, 1);
  assert.equal(result.seed, 42);
  assert.equal(result.timings.steps, 4);
  assert.deepEqual(phases.map(p => p.phase), ['preparing', 'generating', 'validating', 'saving']);
  assert.ok(phases.every(p => p.percentage === null));
  const metadata = await sharp(await fs.readFile(result.imagePath)).metadata();
  assert.equal(metadata.width, 1024);
  assert.equal(metadata.exif, undefined);
  assert.deepEqual(await fs.readFile(path.join(f.config.referenceDir, 'default.jpg')), f.reference);
});

test('cloud readiness verifies the account model with a read-only request and states generation is untested', async t => {
  let requests = 0;
  const f = await fixture(t, async (url, options) => {
    requests += 1;
    assert.match(url, /\/ai\/models\/search\?search=flux-2-klein-9b$/);
    assert.equal(options.method, undefined);
    assert.equal(options.body, undefined);
    return json({ success: true, result: [{ name: CLOUDFLARE_MODEL }] });
  });
  const result = await f.provider.checkReady();
  assert.equal(result.ready, true);
  assert.equal(result.generationTested, false);
  assert.match(result.publicMessage, /Generasi belum diuji/);
  assert.equal(requests, 1);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('cloud missing credentials and unavailable models fail readiness without generating', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls += 1; return json({ success: true, result: [] }); });
  assert.equal((await f.provider.checkReady()).ready, false);
  const missing = new CloudProvider({ ...f.config, cloudCredentials: async () => ({}) }, { env: {}, fetchImpl: async () => { throw new Error('must not call'); } });
  assert.equal((await missing.checkReady()).ready, false);
  assert.equal(calls, 1);
});

test('cloud HTTP authentication, quota, and provider failures never retry an accepted submission', async t => {
  for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [503, 'UNAVAILABLE']]) {
    await t.test(String(status), async t => {
      let requests = 0;
      const f = await fixture(t, async () => { requests += 1; return json({ error: TOKEN }, status); });
      await assert.rejects(f.provider.generate({ positivePrompt: 'portrait' }), error => {
        assert.equal(error.code, code);
        assert.equal(error.generationStarted, true);
        assert.equal(error.beforeGeneration, false);
        assert.equal(error.message.includes(TOKEN), false);
        return true;
      });
      assert.equal(requests, 1);
      assert.equal(await fs.stat(f.config.outputDir).catch(() => null), null);
    });
  }
});

test('cloud cancellation rejects a late response without publishing its image', async t => {
  const started = deferred();
  const response = deferred();
  const f = await fixture(t, async () => { started.resolve(); return response.promise; });
  const controller = new AbortController();
  const generation = f.provider.generate({ positivePrompt: 'portrait' }, () => {}, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(generation, error => error.code === 'CANCELLED' && error.generationStarted === true);
  response.resolve(json({ success: true, result: { image: (await outputImage()).toString('base64') } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await fs.stat(f.config.outputDir).catch(() => null), null);
  assert.equal(f.provider.active, null);
});

test('cloud generation and readiness time out even if a transport ignores cancellation', async t => {
  const f = await fixture(t, () => new Promise(() => {}), { jobTimeoutMs: 80,
    cloud: { accountId: ACCOUNT, model: CLOUDFLARE_MODEL, healthTimeoutMs: 20 } });
  assert.equal((await f.provider.checkReady()).code, 'TIMEOUT');
  await assert.rejects(f.provider.generate({ positivePrompt: 'portrait' }), error => error.code === 'TIMEOUT' && error.generationStarted === true);
});

test('cloud pre-aborted requests and cancellation at submission do not send a billable request', async t => {
  let requests = 0;
  const f = await fixture(t, async () => { requests += 1; throw new Error('must not submit'); });
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(f.provider.generate({ positivePrompt: 'portrait' }, () => {}, cancelled.signal),
    error => error.code === 'CANCELLED' && error.beforeGeneration === true);
  await assert.rejects(f.provider.checkReady(cancelled.signal), error => error.code === 'CANCELLED');
  const atSubmit = new AbortController();
  await assert.rejects(f.provider.generate({ positivePrompt: 'portrait' }, () => {}, atSubmit.signal, () => atSubmit.abort()),
    error => error.code === 'CANCELLED' && error.beforeGeneration === true);
  assert.equal(requests, 0);
});

test('cloud rejects bad images, dimensions, and unsafe reference names before publishing', async t => {
  const badResults = ['invalid base64!', Buffer.from('not an image').toString('base64'),
    (await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64')];
  for (const image of badResults) {
    const f = await fixture(t, async () => json({ success: true, result: { image } }));
    await assert.rejects(f.provider.generate({ positivePrompt: 'portrait' }), error => error.code === 'FAILED');
    assert.equal(await fs.stat(f.config.outputDir).catch(() => null), null);
  }
  const f = await fixture(t, async () => { throw new Error('unsafe reference reached transport'); });
  await assert.rejects(f.provider.generate({ positivePrompt: 'portrait', referenceImage: '../default.jpg' }),
    error => error.code === 'FAILED' && error.beforeGeneration === true);
  assert.throws(() => buildCloudPrompt(''), /prompt/);
});

test('cloud response size limits reject oversized bodies without publishing', async t => {
  const f = await fixture(t, async () => new Response('{}', { headers: { 'Content-Length': String(25 * 1024 * 1024) } }));
  await assert.rejects(f.provider.generate({ positivePrompt: 'portrait' }), /size limit/);
  assert.equal(await fs.stat(f.config.outputDir).catch(() => null), null);
});

test('explicit cloud resolution never initializes or checks local providers', async () => {
  const created = [];
  let initialized = 0;
  const resolver = new ProviderResolver({ provider: 'cloud' }, {
    initializeManaged: async () => { initialized += 1; },
    createProvider: async name => { created.push(name); return { checkReady: async () => ({ ready: true }), generate: async () => ({ imagePath: 'cloud.png' }) }; },
  });
  assert.equal((await resolver.resolveProvider()).name, 'cloud');
  assert.equal(initialized, 0);
  assert.deepEqual(created, ['cloud']);
});

test('automatic provider resolution cannot introduce a paid cloud fallback', async () => {
  const created = [];
  const resolver = new ProviderResolver({ provider: 'auto', autoOrder: ['cloud', 'sdcpp'] }, {
    initializeManaged: null, createProvider: async name => { created.push(name); return { checkReady: async () => ({ ready: false }) }; },
  });
  assert.equal((await resolver.resolveProvider()).name, null);
  assert.deepEqual(created, ['sdcpp']);
});

test('cloud resolver preserves actionable readiness codes and safe provider messages', async () => {
  for (const code of ['AUTH', 'RATE_LIMIT', 'TIMEOUT']) {
    const resolver = new ProviderResolver({ provider: 'cloud' }, {
      initializeManaged: null, createProvider: async () => ({ checkReady: async () => ({
        ready: false, code, message: `Cloudflare ${code}`, publicMessage: 'Periksa token dan izin Cloudflare.' }) }),
    });
    const result = await resolver.checkReady();
    assert.equal(result.code, code);
    assert.equal(result.publicMessage, 'Periksa token dan izin Cloudflare.');
    assert.equal(result.ready, false);
    await resolver.shutdown();
  }
});
