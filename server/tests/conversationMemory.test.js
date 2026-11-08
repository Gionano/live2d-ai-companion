import test from 'node:test';
import assert from 'node:assert/strict';
import { generateConversationReply } from '../conversationCoordinator.js';
import { generateReply } from '../llmChat.js';
import { recallConversation, renderConversationMemory } from '../conversationMemory.js';

const collect = async iterable => { const result = []; for await (const event of iterable) result.push(event); return result; };

function registryFor({ mode = 'say+think' } = {}) {
  const requests = [];
  return { requests, getSlotStatus: () => ({ available: true }), getTts: () => ({ params: {} }),
    getLlm: role => ({ async *stream(request) {
      requests.push({ role, ...request });
      const text = role === 'surface' ? 'Hikari, ya?' : 'Kamu pernah bilang suka Hikari.';
      yield { type: 'text', delta: JSON.stringify({ ...(role === 'surface' && { mode, status: 'ok' }),
        segments: [{ text, emotion: 'netral', register: 'casual' }] }) };
    } }) };
}

test('surface and deep retrieve once and render the same evidence at their distinct budgets', async () => {
  const requests = [];
  const renders = [];
  const bundle = Object.freeze({ facts: ['quote-backed fixture'], generation: 1 });
  const memory = { async retrieve(message, options) { requests.push({ message, ...options }); return bundle; },
    render(value, budget) { renders.push({ value, budget }); return `Historical evidence (${budget}): user said "Aku suka Hikari."`; } };
  const registry = registryFor();
  const history = [{ role: 'user', content: 'Aku menonton anime.' }];
  await collect(generateConversationReply(history, 'Masih ingat favoritku?', null, { registry, memory }));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].message, 'Masih ingat favoritku?');
  assert.deepEqual(requests[0].history, history);
  assert.deepEqual(renders.map(item => item.budget), [2000, 3600]);
  assert.ok(renders.every(item => item.value === bundle));
  assert.ok(registry.requests.every(request => request.messages[0].content.includes('Aku suka Hikari.')));
});

test('a retrieval begun during routing is reused without a second memory operation', async () => {
  const bundle = { generation: 1 };
  const memory = { retrieve() { assert.fail('Must reuse the earlier retrieval'); }, render: () => 'Reused evidence.' };
  const registry = registryFor();
  await collect(generateConversationReply([], 'Favoritku?', null, { registry, memory, memoryBundle: Promise.resolve(bundle) }));
  assert.equal(registry.requests.length, 2);
});

test('proactive retrieval uses recent user context without its internal instruction becoming a query', async () => {
  const queries = [];
  const history = [{ role: 'user', content: 'Aku suka Hikari.' }, { role: 'assistant', content: 'Hikari itu menarik.' }];
  const memory = { retrieve: async (message, options) => { queries.push({ message, history: options.history }); return {}; }, render: () => '' };
  const registry = registryFor();
  await collect(generateConversationReply(history, null, null, { registry, memory, skipSurface: true,
    internalInstruction: 'PRIVATE REFLECTION DIRECTION' }));
  assert.equal(queries.length, 1);
  assert.equal(queries[0].message, null);
  assert.deepEqual(queries[0].history, history);
  assert.doesNotMatch(JSON.stringify(queries), /PRIVATE REFLECTION/);
});

test('memory failure does not block a healthy reply or expose storage errors', async () => {
  const registry = registryFor({ mode: 'say' });
  const memory = { retrieve() { throw new Error('private storage detail'); }, render() { assert.fail(); } };
  const events = await collect(generateConversationReply([], 'Halo.', null, { registry, memory }));
  assert.equal(events.find(event => event.type === 'conversation_done').text, 'Hikari, ya?');
  assert.doesNotMatch(JSON.stringify(events), /private storage/);
});

test('the legacy single-generator chat path retrieves once with the deep budget', async () => {
  let retrieved = 0;
  const memory = { retrieve: async () => { retrieved++; return {}; },
    render: (_bundle, budget) => { assert.equal(budget, 3600); return 'Evidence.'; } };
  const events = await collect(generateReply([], 'Halo.', null, { registry: registryFor(), memory }));
  assert.equal(retrieved, 1);
  assert.ok(events.some(event => event.type === 'delta'));
});

test('cancellation releases an ignored lookup and its late completion cannot start a model', async () => {
  let resolve;
  const bundle = new Promise(done => { resolve = done; });
  const controller = new AbortController();
  const registry = registryFor();
  const work = collect(generateConversationReply([], 'An old request.', null, { registry,
    memory: { render: () => 'Old evidence' }, memoryBundle: bundle, signal: controller.signal }));
  controller.abort();
  await assert.rejects(work, error => error.name === 'AbortError');
  resolve({});
  await Promise.resolve();
  assert.equal(registry.requests.length, 0);
});

test('missing and obsolete evidence produce no context', async () => {
  assert.equal(renderConversationMemory({}, null), '');
  assert.equal(renderConversationMemory({ render: () => { throw new Error('retired bundle'); } }, {}), '');
  assert.equal(await recallConversation({}, 'Hello.', []), null);
});
