import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalEmbedding, validateEmbeddingResult, validateLocalEmbeddingUrl } from '../providers/adapters/localEmbedding.js';
import { ProviderRegistry } from '../providers/registry.js';
import { DEFAULT_CONFIG, resolveSlot } from '../providers/config.js';
import { testSlot } from '../providers/testSlot.js';
import { listModels } from '../settings/models.js';

const vector = () => Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);
const health = { ok: true, model: 'BAAI/bge-m3', tag: 'bge-m3-d768', dims: 768, device: 'cpu', revision: 'a'.repeat(40) };
const result = count => ({ model: 'bge-m3-d768', dims: 768, embeddings: Array.from({ length: count }, vector), revision: 'a'.repeat(40) });
const adapter = fetchImpl => new LocalEmbedding({ profile: DEFAULT_CONFIG.profiles.localBge,
  model: 'bge-m3-d768', fetchImpl });

test('local embedding protocol uses original texts and correct query/document task fields', async () => {
  const calls = [];
  const provider = adapter(async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('/health') ? health : result(JSON.parse(options.body).texts.length));
  });
  assert.equal((await provider.health()).revision, health.revision);
  const embedded = await provider.embed({ texts: ['Aku suka Hikari.'], taskType: 'query' });
  assert.deepEqual(embedded, { model: 'bge-m3-d768', dimensions: 768, vectors: [vector()], revision: health.revision });
  assert.deepEqual(JSON.parse(calls[1].options.body), { texts: ['Aku suka Hikari.'], task_type: 'query' });
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  await provider.embed({ texts: ['One fact.', 'Another fact.'] });
  assert.equal(JSON.parse(calls[2].options.body).task_type, 'document');
});

for (const endpoint of ['https://example.com', 'http://192.168.1.1:8011', 'http://127.0.0.1:8011/api',
  'http://127.0.0.1:8011?token=secret', 'http://user:password@localhost:8011']) {
  test(`local embeddings refuse a nonlocal or nonorigin endpoint ${endpoint}`, () => {
    assert.throws(() => validateLocalEmbeddingUrl(endpoint));
  });
}

test('local embedding URL permits canonical loopback origins', () => {
  for (const endpoint of ['http://127.0.0.1:8011', 'http://localhost:8011/', 'http://[::1]:8011']) {
    assert.equal(new URL(validateLocalEmbeddingUrl(endpoint).url).port, '8011');
  }
});

test('bad embedding requests never reach a provider', async () => {
  let calls = 0;
  const provider = adapter(async () => { calls++; });
  for (const request of [{ texts: [] }, { texts: [''] }, { texts: Array(9).fill('x') },
    { texts: ['x'.repeat(20001)] }, { texts: ['x'], taskType: 'raw' }]) {
    await assert.rejects(provider.embed(request), { code: 'BAD_REQUEST' });
  }
  assert.equal(calls, 0);
});

for (const alter of [body => { body.dims = 1024; }, body => { body.model = 'other'; },
  body => { body.embeddings = []; }, body => { body.embeddings[0][0] = NaN; },
  body => { body.embeddings[0] = Array(768).fill(0); }, body => { body.embeddings[0].pop(); },
  body => { body.revision = 'main'; }]) {
  test('invalid vector shape, model, revision, finiteness or norm is rejected', () => {
    const body = result(1); alter(body);
    assert.throws(() => validateEmbeddingResult(body, 1), { code: 'BAD_RESPONSE' });
  });
}

test('provider normalizes vectors without mutating the original', () => {
  const body = result(1); body.embeddings[0][0] = 3;
  assert.equal(validateEmbeddingResult(body, 1).vectors[0][0], 1);
  assert.equal(body.embeddings[0][0], 3);
});

test('invalid health responses do not claim readiness', async () => {
  const provider = adapter(async () => Response.json({ ...health, dims: 1024 }));
  await assert.rejects(provider.health(), { code: 'BAD_RESPONSE' });
});

test('query timeout is bounded even when the transport ignores cancellation', async () => {
  const provider = adapter(() => new Promise(() => {}));
  const started = performance.now();
  await assert.rejects(provider.embed({ texts: ['Query'], taskType: 'query',
    timeouts: { firstByteMs: 25, idleMs: 25, totalMs: 25 } }), { code: 'TIMEOUT' });
  assert.ok(performance.now() - started < 300);
});

test('cancellation rejects late local embedding responses', async () => {
  let release;
  const provider = adapter(() => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  const pending = provider.embed({ texts: ['Query'], taskType: 'query', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
  release(Response.json(result(1)));
});

test('HTTP errors and redirects do not retry or disclose provider payloads', async () => {
  for (const [status, code] of [[429, 'RATE_LIMIT'], [500, 'SERVER'], [302, 'BAD_REQUEST'], [401, 'AUTH']]) {
    let calls = 0;
    const provider = adapter(async () => { calls++; return new Response('private transcript', { status }); });
    await assert.rejects(provider.embed({ texts: ['Query'], taskType: 'query' }), error => {
      assert.equal(error.code, code); assert.equal(error.message.includes('private transcript'), false); return true;
    });
    assert.equal(calls, 1);
  }
});

test('oversized response is cancelled before decoding', async () => {
  const provider = adapter(async () => new Response('{}', { headers: { 'content-length': 3 * 1024 * 1024 } }));
  await assert.rejects(provider.embed({ texts: ['Query'] }), { code: 'BAD_RESPONSE' });
});

test('memory slots preserve explicit null and writer follows the main LLM', () => {
  const llm = { profile: 'localBge', model: 'bge-m3-d768' };
  assert.equal(resolveSlot({ slots: { llm } }, 'memoryWriter'), llm);
  assert.equal(resolveSlot({ slots: { memoryWriter: null } }, 'memoryWriter'), null);
  assert.equal(resolveSlot({ slots: { memoryEmbedding: null } }, 'memoryEmbedding'), null);
  assert.deepEqual(resolveSlot({ slots: {} }, 'memoryEmbedding'), DEFAULT_CONFIG.slots.memoryEmbedding);
  const registry = new ProviderRegistry({ config: structuredClone(DEFAULT_CONFIG) });
  assert.equal(registry.getEmbedding().capabilities.embeddings, true);
  assert.equal(registry.getSlotStatus('memoryWriter').available, false);
  registry.config.slots.llm = { profile: 'localBge', model: 'bge-m3-d768' };
  assert.equal(registry.getSlotStatus('llm').available, false);
  registry.config.profiles.chatOnly = { adapter: 'openaiCompatible', baseUrl: 'http://127.0.0.1:9000',
    capabilities: { embeddings: true } };
  registry.config.slots.memoryEmbedding = { profile: 'chatOnly', model: 'fixture' };
  assert.equal(registry.getSlotStatus('memoryEmbedding').available, false);
  assert.equal(registry.getEmbedding(), null);
});

test('local embedding model catalogue never probes a provider', async () => {
  const service = { config: () => ({ profiles: { local: DEFAULT_CONFIG.profiles.localBge } }) };
  assert.deepEqual(await listModels(service, { profile: 'local', fetchImpl: () => { throw new Error('No requests'); } }),
    { models: ['bge-m3-d768'], reason: null });
});

test('explicit memory slot test probes only synthetic embedding text', async () => {
  const texts = [];
  const registry = new ProviderRegistry({ config: structuredClone(DEFAULT_CONFIG), adapterOptions: {
    fetchImpl: async (url, options) => {
      if (url.endsWith('/health')) return Response.json(health);
      texts.push(...JSON.parse(options.body).texts);
      return Response.json(result(texts.length));
    },
  } });
  const probe = await testSlot('memoryEmbedding', { registry });
  assert.equal(probe.ok, true);
  assert.equal(probe.details.dimensions, 768);
  assert.deepEqual(texts, ['A synthetic memory connection check.']);
});
