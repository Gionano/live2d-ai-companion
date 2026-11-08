import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager, MemoryError } from '../memoryManager.js';
import { MemoryStore, atomicWrite, digest, lease } from '../memory/store.js';
import { validateFact, publishFact } from '../memory/evidence.js';
import { bm25, fuse, normalizedVector, renderBundle, resolveQuery, embeddingDocuments } from '../memory/retrieval.js';

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-core-'));
  let clock = 1762538400000;
  const manager = new MemoryManager({ dataDir, now: () => clock, ...options });
  t.after(() => { manager.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { manager, dataDir, advance: delta => { clock += delta; }, time: () => clock };
}

const event = (id, userText = 'Karakter favoritku Hikari.', assistantText = 'Aku mengerti pilihanmu.') => ({
  eventId: id, sessionId: 'session', turnId: 'turn_' + id, speechId: 'speech_' + id,
  userText, assistantText, origin: 'conversation' });

const fact = (row, predicate = 'favorite_character', value = 'Hikari', extra = {}) => ({
  subject: 'user', predicate, value, category: 'preference', sourceIds: [row.id],
  quotes: [{ eventId: row.id, speaker: 'user', text: row.userText }], ...extra });

function embedding(model = 'fixture', revision = 'weights_a') {
  const calls = [];
  return { model, dimensions: 3, revision, calls,
    async embed(request) {
      calls.push(request);
      return { model, dimensions: 3, revision, vectors: request.texts.map(text =>
        /Hikari|ocean hero|pahlawan laut/i.test(text) ? [1, 0, 0] : [0, 1, 0]) };
    } };
}

test('memory construction and legacy prompt preview do not touch storage', t => {
  const { dataDir } = fixture(t);
  const nested = path.join(dataDir, 'not-created');
  const manager = new MemoryManager({ dataDir: nested });
  assert.equal(manager.getMemoryPrompt(), '');
  assert.equal(fs.existsSync(nested), false);
  manager.dispose();
});

test('legacy migration preserves facts, names, summaries and exact original backup without invented quotes', t => {
  const { manager, dataDir } = fixture(t);
  const original = JSON.stringify({ version: 1, lastSeen: 1234,
    profile: { userName: 'Budi', nickname: 'Bud', facts: ['Aku suka Hikari', { text: 'Suka kopi', category: 'drink' }] },
    episodes: [{ summary: 'Watched an anime.', topic: 'anime', timestamp: 1000 }] });
  fs.writeFileSync(path.join(dataDir, 'memory.json'), original);
  assert.equal(manager.status().ready, true);
  assert.equal(manager.memory.profile.userName, 'Budi');
  assert.equal(manager.memory.profile.nickname, 'Bud');
  assert.equal(manager.memory.episodes[0].status, 'legacy');
  for (const row of manager.memory.profile.facts) {
    assert.equal(row.origin, 'legacy'); assert.deepEqual(row.sourceIds, []); assert.deepEqual(row.quotes, []);
  }
  assert.equal(fs.readFileSync(path.join(dataDir, 'memory.json'), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(dataDir, 'memory-v2/legacy-backup.json'), 'utf8'), original);
  assert.equal(manager.getMemoryPrompt().includes('Hikari'), false);
});

test('corrupt legacy and current storage is preserved and makes recall unavailable rather than overwriting it', async t => {
  const { manager, dataDir } = fixture(t);
  fs.writeFileSync(path.join(dataDir, 'memory.json'), '{broken');
  assert.equal(manager.status().ready, false);
  assert.equal(fs.readFileSync(path.join(dataDir, 'memory.json'), 'utf8'), '{broken');
  const result = await manager.retrieve('Hikari');
  assert.equal(result.diagnostics.method, 'unavailable');
  assert.deepEqual(result.events, []);
  assert.equal(fs.existsSync(path.join(dataDir, 'memory-v2/state.json')), false);
});

test('completed events are idempotent, immediately searchable, and retained beyond old 40/20 limits', async t => {
  const { manager } = fixture(t);
  const initial = manager.archiveCompleted(event('first'));
  manager.archiveCompleted(event('first'));
  assert.equal(manager.status().counts.events, 1);
  assert.equal(manager.status().jobs.length, 2);
  for (let index = 0; index < 45; index++) manager.addFact('Unrelated fact ' + index);
  for (let index = 0; index < 22; index++) manager.archiveCompleted(event('other_' + index, 'Aku bekerja pada proyek nomor ' + index));
  const result = await manager.retrieve('Hikari');
  assert.equal(result.events.some(row => row.id === initial.id), true);
  assert.equal(manager.status().counts.facts, 45);
  assert.equal(manager.status().counts.events, 23);
  assert.equal(manager.render(result).includes('Karakter favoritku Hikari.'), true);
  assert.equal(manager.lastRetrieval.query, undefined);
});

test('proactive and visual commentary archive assistant speech only; old internal generation calls do not archive', t => {
  const { manager } = fixture(t);
  manager.archiveCompleted({ ...event('proactive'), origin: 'proactive' });
  manager.archiveCompleted({ ...event('vision'), origin: 'vision' });
  assert.equal(manager.listEvents().items.every(row => row.userText === ''), true);
  assert.deepEqual(manager.recordTurnAndExtract('Aku suka Hikari.', 'Okay.'), { skipped: true, reason: 'playback_required' });
  assert.equal(manager.status().counts.events, 2);
});

test('archive rejects traversal, huge or empty events and conflicting idempotency payloads', t => {
  const { manager } = fixture(t);
  for (const item of [event('../bad'), event('empty', 'hello', ''), event('large', 'x'.repeat(65537))]) {
    assert.throws(() => manager.archiveCompleted(item), { code: 'INVALID_MEMORY' });
  }
  manager.archiveCompleted(event('same'));
  assert.throws(() => manager.archiveCompleted(event('same', 'Aku suka kopi.')), { code: 'DUPLICATE_MEMORY_EVENT' });
});

test('evidence requires literal source IDs, speaker ownership, declarative self-disclosure and meaningful quotes', () => {
  const row = { id: 'original', timestamp: 1000, userText: 'Aku suka Hikari.', assistantText: 'Kamu suka Hikari?' };
  const accepted = validateFact(fact(row, 'likes'), [row], []);
  assert.deepEqual(accepted.quotes[0], { eventId: 'original', speaker: 'user', text: row.userText, start: 0, end: row.userText.length });
  const invalid = [fact(row, 'likes', 'Hikari', { sourceIds: ['unknown'] }),
    fact(row, 'likes', 'Hikari', { quotes: [{ eventId: row.id, speaker: 'assistant', text: row.assistantText }] }),
    fact(row, 'likes', 'Hikari', { quotes: [{ eventId: row.id, speaker: 'user', text: 'I prefer Hikari.' }] }),
    fact(row, 'likes', 'Hikari', { quotes: [{ eventId: row.id, speaker: 'user', text: 'Hikari' }] })];
  for (const candidate of invalid) assert.throws(() => validateFact(candidate, [row], []), { code: 'INVALID_EVIDENCE' });
});

test('removing question marks, conditionals or reported context from a quote cannot turn it into user evidence', () => {
  for (const original of ['Apakah aku suka Hikari?', 'Kalau aku suka Hikari, apa kamu setuju?',
    'Dia bilang, "aku suka Hikari".', 'Manaka berkata: "aku suka Hikari".']) {
    const row = { id: 'original', timestamp: 1000, userText: original, assistantText: 'Okay.' };
    const candidate = fact(row, 'likes', 'Hikari', { quotes: [{ eventId: row.id, speaker: 'user', text: 'aku suka Hikari' }] });
    assert.throws(() => validateFact(candidate, [row], []), { code: 'INVALID_EVIDENCE' }, original);
  }
});

test('additive likes coexist, singleton conflicts remain uncertain, and explicit corrections supersede only older matching facts', () => {
  const state = { facts: [] };
  const one = { id: 'one', timestamp: 1000, userText: 'Aku suka Hikari.', assistantText: 'Okay.' };
  const two = { id: 'two', timestamp: 2000, userText: 'Aku suka kopi.', assistantText: 'Okay.' };
  publishFact(state, validateFact(fact(one, 'likes'), [one], state.facts));
  publishFact(state, validateFact(fact(two, 'likes', 'kopi'), [two], state.facts));
  assert.equal(state.facts.every(row => row.status === 'active'), true);
  const favoriteOne = publishFact(state, validateFact(fact(one), [one], state.facts));
  const favoriteTwo = publishFact(state, validateFact(fact(two, 'favorite_character', 'Tsumugu'), [two], state.facts));
  assert.equal(favoriteOne.status, 'uncertain'); assert.equal(favoriteTwo.status, 'uncertain');
  const correction = { id: 'three', timestamp: 3000, userText: 'Ralat, sekarang karakter favoritku Hikari.', assistantText: 'Okay.' };
  const revived = publishFact(state, validateFact(fact(correction, 'favorite_character', 'Hikari', {
    supersedes: [favoriteTwo.id] }), [correction], state.facts));
  assert.equal(favoriteTwo.status, 'superseded');
  assert.equal(favoriteTwo.supersededBy, revived.id);
  assert.equal(revived.status, 'active');
  assert.equal(revived.quotes.some(quote => quote.eventId === correction.id), true);
  assert.throws(() => validateFact(fact(one, 'favorite_character', 'Hikari', { supersedes: [favoriteTwo.id] }), [one], state.facts), { code: 'INVALID_CORRECTION' });
});

test('same-time correction requires an explicitly ordered later original event', () => {
  const first = { id: 'first', timestamp: 1000, sequence: 1, userText: 'Karakter favoritku Hikari.', assistantText: 'Okay.' };
  const old = validateFact(fact(first), [first], []);
  const later = { id: 'later', timestamp: 1000, sequence: 2, userText: 'Sekarang karakter favoritku Tsumugu.', assistantText: 'Okay.' };
  assert.equal(validateFact(fact(later, 'favorite_character', 'Tsumugu', { supersedes: [old.id] }), [later], [old]).supersedes[0], old.id);
  assert.throws(() => validateFact(fact({ ...later, sequence: 0 }, 'favorite_character', 'Tsumugu', { supersedes: [old.id] }), [{ ...later, sequence: 0 }], [old]), { code: 'INVALID_CORRECTION' });
});

test('keyword ranking is topic relevant and short recall anchoring ignores assistant assertions', () => {
  const history = [{ role: 'user', content: 'Aku suka tokoh Hikari di anime itu.' },
    { role: 'assistant', content: 'Kamu suka Manaka dan kopi.' }];
  assert.equal(resolveQuery('Masih ingat?', history).includes('Hikari'), true);
  assert.equal(resolveQuery('Masih ingat?', history).includes('Manaka'), false);
  assert.equal(resolveQuery('Sekarang bahas komputer baru', history), 'Sekarang bahas komputer baru');
  const ranking = bm25([{ id: 'coffee', text: 'Aku suka kopi hitam', timestamp: 20 },
    { id: 'anime', text: 'Karakter favorit Hikari anime', timestamp: 1 }], 'Hikari');
  assert.deepEqual(ranking.map(row => row.id), ['anime']);
  assert.deepEqual(fuse([{ id: 'anime', score: 9 }], [{ id: 'anime', score: 0.8 }, { id: 'coffee', score: 0.9 }]).map(row => row.id), ['anime', 'coffee']);
});

test('retrieval excludes original events already present in short-term history and shares budget-safe evidence', async t => {
  const { manager } = fixture(t);
  const original = manager.archiveCompleted(event('original'));
  const recent = await manager.retrieve('Hikari', { history: [{ role: 'user', content: original.userText }, { role: 'assistant', content: original.assistantText }] });
  assert.deepEqual(recent.events, []);
  const recalled = await manager.retrieve('Hikari');
  assert.equal(manager.render(recalled, 2000).length <= 2000, true);
  assert.equal(manager.render(recalled, 3600).length <= 3600, true);
  assert.equal(manager.render(recalled, 200).length, 0);
  assert.equal(manager.render(recalled).includes('speaker":"user"'), true);
  assert.equal(manager.render(recalled).includes('speaker":"assistant"'), true);
});

test('rendering never slices quoted evidence and reserves room for original user speech', () => {
  const bundle = { events: [{ id: 'source', timestamp: 1000, origin: 'conversation', userText: 'Aku suka Hikari.', assistantText: 'x'.repeat(5000) }],
    facts: [{ id: 'fact', subject: 'user', predicate: 'likes', value: 'Hikari', origin: 'extracted', status: 'active', quotes: [{ eventId: 'source', speaker: 'user', text: 'Aku suka Hikari.' }] }] };
  const output = renderBundle(bundle, 2000);
  assert.equal(output.includes('Aku suka Hikari.'), true);
  assert.equal(output.includes('x'.repeat(100)), false);
  for (const line of output.split('\n').slice(1)) assert.doesNotThrow(() => JSON.parse(line));
});

test('semantic paraphrases retrieve an old original with one cached query operation and float32 sidecars', async t => {
  const provider = embedding();
  const { manager, dataDir } = fixture(t, { getEmbedding: () => provider });
  const source = manager.archiveCompleted(event('hikari'));
  manager.archiveCompleted(event('coffee', 'Aku suka kopi hitam.', 'Coffee sounds nice.'));
  await manager.processJobs(); await manager.processJobs();
  const result = await manager.retrieve('ocean hero');
  assert.equal(result.events.some(row => row.id === source.id), true);
  assert.equal(result.diagnostics.method, 'hybrid');
  await manager.retrieve('ocean hero');
  assert.equal(provider.calls.filter(call => call.taskType === 'query').length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'memory-v2/state.json'), 'utf8'));
  assert.equal(state.vectors.embeddingRevision, 'weights_a');
  const bytes = fs.readFileSync(path.join(dataDir, 'memory-v2', state.vectors.file));
  assert.equal(bytes.length, state.vectors.items.length * 3 * 4);
  assert.equal(digest(bytes), state.vectors.sha256);
});

test('embedding timeouts retain fast keyword results and do not admit a late cached result', async t => {
  const provider = embedding();
  const { manager } = fixture(t, { getEmbedding: () => provider, queryTimeoutMs: 20 });
  manager.archiveCompleted(event('hikari'));
  await manager.processJobs();
  let release;
  provider.embed = request => new Promise(resolve => { release = () => resolve({ model: provider.model, dimensions: 3, revision: provider.revision, vectors: [[1, 0, 0]] }); });
  const before = performance.now();
  const result = await manager.retrieve('Hikari');
  assert.equal(result.diagnostics.fallbackReason, 'timeout');
  assert.equal(result.events.length, 1);
  assert.equal(performance.now() - before < 200, true);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.queryCache.size, 0);
});

test('disabled embeddings, changed provider model and immutable weight revisions never reuse old vectors', async t => {
  let provider = embedding();
  const { manager } = fixture(t, { getEmbedding: () => provider });
  manager.archiveCompleted(event('hikari'));
  await manager.processJobs();
  provider = null;
  assert.equal((await manager.retrieve('Hikari')).diagnostics.fallbackReason, 'embedding_unavailable');
  provider = embedding('changed');
  assert.equal((await manager.retrieve('Hikari')).diagnostics.fallbackReason, 'reindex_required');
  provider = embedding('fixture', 'weights_b');
  assert.equal((await manager.retrieve('Hikari')).diagnostics.fallbackReason, 'reindex_required');
  const request = manager.reindex(); await manager.processJobs();
  assert.equal(manager.status().jobs.find(job => job.id === request.id).state, 'complete');
  assert.equal((await manager.retrieve('ocean hero')).diagnostics.method, 'hybrid');
});

test('a service revision learned during the first embed and after backend restart does not force needless reindexing', async t => {
  const service = embedding();
  const { manager, dataDir } = fixture(t);
  function freshAdapter() {
    return { model: 'fixture', revision: null, async embed(request) {
      const result = await service.embed(request); this.revision = result.revision; return result;
    } };
  }
  let provider = freshAdapter();
  manager.configure({ getEmbedding: () => provider });
  manager.archiveCompleted(event('original')); await manager.processJobs();
  assert.equal(manager.status().counts.vectors, 1);
  assert.equal(manager.status().jobs.find(job => job.type === 'embed').state, 'complete');
  provider = freshAdapter();
  const restored = new MemoryManager({ dataDir, getEmbedding: () => provider }); t.after(() => restored.dispose());
  assert.equal((await restored.retrieve('ocean hero')).diagnostics.method, 'hybrid');
  assert.equal(restored.status().indexState, 'ready');
});

test('a corrupt float32 sidecar falls back to keywords, can be rebuilt, and never prevents deleting source speech', async t => {
  const provider = embedding();
  const { manager, dataDir } = fixture(t, { getEmbedding: () => provider });
  manager.archiveCompleted(event('original')); await manager.processJobs();
  let state = manager.ensure();
  fs.writeFileSync(path.join(dataDir, 'memory-v2', state.vectors.file), 'broken');
  const fallback = await manager.retrieve('Hikari');
  assert.equal(fallback.events.length, 1); assert.equal(fallback.diagnostics.method, 'keyword');
  const reindex = manager.reindex(); await manager.processJobs();
  assert.equal(manager.status().jobs.find(job => job.id === reindex.id).state, 'complete');
  assert.equal((await manager.retrieve('ocean hero')).diagnostics.method, 'hybrid');
  state = manager.ensure(); fs.writeFileSync(path.join(dataDir, 'memory-v2', state.vectors.file), 'broken again');
  assert.doesNotThrow(() => manager.deleteEvent('original'));
  assert.equal(manager.status().counts.events, 0);
  assert.equal(manager.status().counts.vectors, 0);
});

test('invalid vector shape, NaN and zero vectors are rejected and semantic thresholds omit unrelated results', async t => {
  for (const candidate of [[0, 0, 0], [NaN, 1, 2], [1, 0]]) assert.throws(() => normalizedVector(candidate, 3), { code: 'INVALID_EMBEDDING' });
  const provider = embedding();
  const { manager } = fixture(t, { getEmbedding: () => provider });
  manager.archiveCompleted(event('coffee', 'Aku suka kopi.', 'Okay.')); await manager.processJobs();
  assert.deepEqual((await manager.retrieve('ocean hero')).events, []);
});

test('document embedding chunks preserve complete original archive and keep batches at most eight', async t => {
  const provider = embedding();
  const { manager } = fixture(t, { getEmbedding: () => provider });
  const text = 'Aku suka Hikari. '.repeat(2500);
  manager.archiveCompleted(event('long', text));
  await manager.processJobs();
  assert.equal(manager.listEvents().items[0].userText, text.trim());
  assert.equal(provider.calls.every(call => call.texts.length <= 8 && call.texts.every(item => item.length <= 3000)), true);
  assert.equal(embeddingDocuments(manager.corpus()).length > 8, true);
});

test('extraction starts after its delay, batches eight events and validates exact quote packets', async t => {
  let calls = 0;
  const writer = { async complete(request) {
    calls++;
    const input = JSON.parse(request.messages[1].content);
    assert.equal(input.events.length <= 8, true);
    return { text: JSON.stringify({ facts: input.events.map(row => ({ subject: 'user', predicate: 'likes', value: 'Hikari',
      sourceIds: [row.id], quotes: [{ eventId: row.id, speaker: 'user', text: row.speakers.user }] })) }) };
  } };
  const { manager, advance } = fixture(t, { getWriter: () => writer });
  for (let index = 0; index < 10; index++) manager.archiveCompleted(event('turn_' + index, 'Aku suka Hikari.'));
  await manager.processJobs(); assert.equal(calls, 0);
  advance(120000); await manager.processJobs(); await manager.processJobs();
  assert.equal(calls, 2);
  assert.equal(manager.memory.profile.facts.length, 1);
  assert.equal(manager.memory.profile.facts[0].sourceIds.length, 10);
  assert.equal(manager.status().jobs.filter(job => job.type === 'extract').every(job => job.state === 'complete'), true);
});

test('corrections inside one delayed extraction batch resolve original event links before old fact IDs exist', async t => {
  const { manager, advance } = fixture(t, { getWriter: () => ({ async complete(request) {
    const [first, next] = JSON.parse(request.messages[1].content).events;
    // Intentionally reversed writer order; publication follows original event chronology.
    return { text: JSON.stringify({ facts: [
      fact({ id: next.id, userText: next.speakers.user }, 'favorite_character', 'Tsumugu', { supersedesSourceIds: [first.id] }),
      fact({ id: first.id, userText: first.speakers.user })] }) };
  } }) });
  const first = manager.archiveCompleted(event('first')); advance(1000);
  const next = manager.archiveCompleted(event('next', 'Sekarang karakter favoritku Tsumugu.'));
  advance(120000); await manager.processJobs();
  const facts = manager.memory.profile.facts;
  assert.equal(facts.find(row => row.value === 'Hikari').status, 'superseded');
  assert.equal(facts.find(row => row.value === 'Tsumugu').status, 'active');
  assert.deepEqual(facts.find(row => row.value === 'Tsumugu').supersedesSourceIds, [first.id]);
  const recalled = await manager.retrieve('karakter favorit');
  assert.equal(recalled.facts.some(row => row.value === 'Hikari'), false);
  assert.equal(recalled.facts.some(row => row.value === 'Tsumugu'), true);
  const oldQuery = await manager.retrieve('Hikari');
  assert.equal(oldQuery.facts.some(row => row.value === 'Tsumugu'), true);
  assert.equal(oldQuery.events.some(row => row.id === next.id), true);
  assert.equal(oldQuery.facts.some(row => row.value === 'Hikari'), false);
});

test('a late enriched original cannot revive a fact already corrected by a later source event', () => {
  const first = { id: 'first', timestamp: 1000, userText: 'Karakter favoritku Hikari.', assistantText: 'Okay.' };
  const next = { id: 'next', timestamp: 2000, userText: 'Sekarang karakter favoritku Tsumugu.', assistantText: 'Okay.' };
  const state = { facts: [] };
  const newer = publishFact(state, validateFact(fact(next, 'favorite_character', 'Tsumugu', { supersedesSourceIds: ['first'] }), [first, next], []));
  const older = publishFact(state, validateFact(fact(first), [first], state.facts));
  assert.equal(older.status, 'superseded'); assert.equal(older.supersededBy, newer.id);
  assert.equal(newer.status, 'active');
  assert.throws(() => validateFact(fact(first, 'favorite_character', 'Hikari', { supersedesSourceIds: ['next'] }), [first, next], state.facts), { code: 'INVALID_CORRECTION' });
});

test('name projection retains unverified legacy provenance and updates only from actual user evidence', async t => {
  const { manager, dataDir } = fixture(t, { extractDelayMs: 0, getWriter: () => ({ async complete(request) {
    const row = JSON.parse(request.messages[1].content).events[0];
    return { text: JSON.stringify({ facts: [fact({ id: row.id, userText: row.speakers.user }, 'name', 'Adi', {
      supersedes: [JSON.parse(request.messages[1].content).existingFacts.find(old => old.predicate === 'name').id] })] }) };
  } }) });
  fs.writeFileSync(path.join(dataDir, 'memory.json'), JSON.stringify({ profile: { userName: 'Budi' }, lastSeen: 1000 }));
  const prior = await manager.retrieve('Budi');
  assert.equal(prior.facts[0].status, 'legacy');
  manager.archiveCompleted(event('rename', 'Ralat, namaku Adi.')); await manager.processJobs();
  assert.equal(manager.memory.profile.userName, 'Adi');
  const name = manager.memory.profile.facts.find(row => row.predicate === 'name' && row.status === 'active');
  manager.deleteFact(name.id);
  assert.equal(manager.memory.profile.userName, 'Budi');
  assert.equal(manager.memory.profile.facts.find(row => row.predicate === 'name').origin, 'legacy');
});

test('multi-quote facts render all evidence together or omit the complete oversized group', () => {
  const quotes = Array.from({ length: 3 }, (_, index) => ({ eventId: 'event_' + index, speaker: 'user', text: 'Aku suka Hikari. ' + index }));
  const bundle = { facts: [{ id: 'fact', subject: 'user', predicate: 'likes', value: 'Hikari', status: 'active', origin: 'extracted', quotes }] };
  const normal = renderBundle(bundle, 2000);
  for (const quote of quotes) assert.equal(normal.includes(quote.text), true);
  const oversized = renderBundle({ facts: [{ ...bundle.facts[0], quotes: [...quotes, { eventId: 'long', speaker: 'user', text: 'x'.repeat(3000) }] }] }, 2000);
  assert.equal(oversized.includes('"kind":"fact"'), false);
});

test('invalid writer output and unsupported quotes fail durably and require explicit retry', async t => {
  let valid = false;
  const writer = { async complete(request) {
    const row = JSON.parse(request.messages[1].content).events[0];
    return { text: valid ? JSON.stringify({ facts: [fact({ id: row.id, userText: row.speakers.user }, 'likes')] }) : '{"facts":["invented"]}' };
  } };
  const { manager } = fixture(t, { getWriter: () => writer, extractDelayMs: 0 });
  manager.archiveCompleted(event('original', 'Aku suka Hikari.'));
  await manager.processJobs();
  let failed = manager.status().jobs.find(job => job.type === 'extract');
  assert.equal(failed.state, 'failed'); assert.equal(failed.errorCode, 'INVALID_EVIDENCE');
  assert.equal(manager.memory.profile.facts.length, 0);
  valid = true; manager.retryJob(failed.id); await manager.processJobs();
  assert.equal(manager.status().jobs.find(job => job.id === failed.id).state, 'complete');
  assert.equal(manager.memory.profile.facts.length, 1);
});

test('transient extraction retries follow 60/300/1200 seconds, then remain failed without transcript errors', async t => {
  const writer = { async complete() { throw Object.assign(new Error('PRIVATE TRANSCRIPT'), { code: 'RATE_LIMIT' }); } };
  const { manager, advance, time } = fixture(t, { getWriter: () => writer, extractDelayMs: 0 });
  manager.archiveCompleted(event('original'));
  for (const delay of [60000, 300000, 1200000]) {
    await manager.processJobs();
    const job = manager.status().jobs.find(row => row.type === 'extract');
    assert.equal(job.state, 'retry'); assert.equal(job.dueAt, time() + delay);
    advance(delay);
  }
  await manager.processJobs();
  const state = manager.status();
  assert.equal(state.jobs.find(job => job.type === 'extract').state, 'failed');
  assert.equal(JSON.stringify(state).includes('PRIVATE TRANSCRIPT'), false);
});

test('crash between original archive and publication recovers the event and its persistent jobs', t => {
  const { manager, dataDir } = fixture(t);
  manager.ensure();
  manager.store.writeEvent({ id: 'orphan', timestamp: 12345, origin: 'conversation', sessionId: 's', turnId: 't', speechId: 'p',
    userText: 'Aku suka Hikari.', assistantText: 'Okay.' });
  assert.equal(manager.status().counts.events, 0);
  const restored = new MemoryManager({ dataDir });
  t.after(() => restored.dispose());
  assert.equal(restored.status().counts.events, 1);
  assert.equal(restored.status().jobs.length, 2);
});

test('single writer lock prevents competing managers from processing the same job', async t => {
  let resolve;
  let calls = 0;
  const writer = { complete: () => { calls++; return new Promise(done => { resolve = done; }); } };
  const { manager, dataDir } = fixture(t, { getWriter: () => writer, extractDelayMs: 0 });
  manager.archiveCompleted(event('original'));
  const processing = manager.processJobs(); await new Promise(done => setImmediate(done));
  const other = new MemoryManager({ dataDir, getWriter: () => writer }); t.after(() => other.dispose());
  await other.processJobs(); assert.equal(calls, 1);
  resolve({ text: '{"facts":[]}' }); await processing;
  assert.equal(manager.status().jobs.find(job => job.type === 'extract').state, 'complete');
});

test('restart recovers a crashed running job without discarding original dialogue', async t => {
  const { manager, dataDir } = fixture(t, { extractDelayMs: 0 });
  manager.archiveCompleted(event('original'));
  manager.store.transact(state => { const job = state.jobs.find(row => row.type === 'extract'); job.state = 'running'; job.ownerPid = 2147483647; });
  const restored = new MemoryManager({ dataDir, getWriter: () => ({ complete: async () => ({ text: '{"facts":[]}' }) }) });
  t.after(() => restored.dispose());
  await restored.processJobs();
  assert.equal(restored.status().counts.events, 1);
  assert.equal(restored.status().jobs.find(job => job.type === 'extract').state, 'complete');
});

test('revision conflicts reject writes; deletion cascades remove supporting speech, facts, vectors and retrieval cache', async t => {
  const provider = embedding();
  const { manager } = fixture(t, { getEmbedding: () => provider, extractDelayMs: 0,
    getWriter: () => ({ async complete(request) { const row = JSON.parse(request.messages[1].content).events[0];
      return { text: JSON.stringify({ facts: [fact({ id: row.id, userText: row.speakers.user })] }) }; } }) });
  manager.archiveCompleted(event('original'));
  await manager.processJobs(); await manager.processJobs(); await manager.processJobs();
  const recalled = await manager.retrieve('Hikari');
  const record = manager.memory.profile.facts[0];
  const revision = manager.revision;
  manager.addFact('A manual unrelated fact');
  assert.throws(() => manager.deleteFact(record.id, { expectedRevision: revision }), { code: 'CONFLICT' });
  const impact = manager.deletionImpact('fact', record.id);
  assert.equal(impact.eventCount, 1); assert.equal(impact.factCount, 1);
  const generation = manager.generation;
  manager.deleteFact(record.id, { expectedRevision: manager.revision });
  assert.notEqual(manager.generation, generation);
  assert.equal(manager.status().counts.events, 0);
  assert.equal(manager.status().counts.vectors, 0);
  assert.equal(manager.queryCache.size, 0);
  assert.equal(manager.render(recalled), '');
  assert.equal((await manager.retrieve('Hikari')).events.length, 0);
});

test('clear fences pending archives and in-flight extraction, purges legacy backups, and never remigrates', async t => {
  let finish;
  const writer = { complete: () => new Promise(resolve => { finish = resolve; }) };
  const { manager, dataDir } = fixture(t, { getWriter: () => writer, extractDelayMs: 0 });
  fs.writeFileSync(path.join(dataDir, 'memory.json'), JSON.stringify({ profile: { facts: ['Old Hikari memory'] } }));
  const generation = manager.generation;
  const original = manager.archiveCompleted(event('original'));
  const work = manager.processJobs(); await new Promise(resolve => setImmediate(resolve));
  manager.clearMemory();
  finish({ text: JSON.stringify({ facts: [fact(original)] }) }); await work;
  assert.equal(manager.status().counts.events, 0); assert.equal(manager.status().counts.facts, 0);
  assert.equal(manager.status().jobs.length, 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'memory.json')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'memory-v2/legacy-backup.json')), false);
  assert.throws(() => manager.archiveCompleted(event('pending'), { generation }), { code: 'MEMORY_STALE' });
  const restored = new MemoryManager({ dataDir }); t.after(() => restored.dispose());
  assert.equal(restored.status().counts.facts, 0);
});

test('clear while query is in flight rejects late recall and cannot refill deleted vector cache', async t => {
  const provider = embedding();
  const { manager } = fixture(t, { getEmbedding: () => provider });
  manager.archiveCompleted(event('original')); await manager.processJobs();
  let finish;
  provider.embed = () => new Promise(resolve => { finish = resolve; });
  const pending = manager.retrieve('Hikari'); await new Promise(resolve => setImmediate(resolve));
  manager.clearMemory();
  finish({ model: provider.model, dimensions: 3, revision: provider.revision, vectors: [[1, 0, 0]] });
  await assert.rejects(pending, { code: 'MEMORY_STALE' });
  assert.equal(manager.queryCache.size, 0);
});

test('deletion of one source preserves unrelated float32 vectors and rejects obsolete model-session work', async t => {
  const provider = embedding();
  const { manager } = fixture(t, { getEmbedding: () => provider });
  manager.archiveCompleted(event('original')); manager.archiveCompleted(event('coffee', 'Aku suka kopi.'));
  await manager.processJobs(); await manager.processJobs();
  manager.deleteEvent('original');
  assert.equal(manager.status().counts.vectors, 1);
  assert.equal((await manager.retrieve('kopi')).events[0].id, 'coffee');
  assert.throws(() => manager.deletionImpact('fact', 'coffee'), { code: 'NOT_FOUND' });
});

test('cancelled query never publishes a result; public pagination is bounded and validates cursors', async t => {
  const { manager } = fixture(t);
  manager.archiveCompleted(event('original'));
  const controller = new AbortController(); controller.abort(new MemoryError('ABORTED', 499));
  await assert.rejects(manager.retrieve('Hikari', { signal: controller.signal }), { code: 'ABORTED' });
  assert.throws(() => manager.listEvents({ limit: 101 }), { code: 'INVALID_MEMORY' });
  assert.throws(() => manager.listFacts({ cursor: '../bad' }), { code: 'INVALID_MEMORY' });
  manager.addFact('Manual fact one'); manager.addFact('Manual fact two');
  const first = manager.listFacts({ limit: 1 });
  assert.equal(first.nextCursor, '1');
  assert.equal(manager.listFacts({ cursor: first.nextCursor, limit: 1 }).items.length, 1);
});

test('unknown lock ownership and linked event paths are refused', t => {
  const { manager, dataDir } = fixture(t);
  manager.ensure();
  fs.writeFileSync(path.join(dataDir, 'memory-v2/state.json.lock'), '{}');
  assert.throws(() => manager.addFact('Safe manual fact'), { code: 'LOCK_UNKNOWN' });
  fs.unlinkSync(path.join(dataDir, 'memory-v2/state.json.lock'));
  const lock = lease(path.join(dataDir, 'memory-v2/state.json.lock'));
  assert.throws(() => manager.addFact('Safe manual fact'), { code: 'LOCK_BUSY' }); lock();
  assert.throws(() => manager.archiveCompleted(event('..')), { code: 'INVALID_MEMORY' });
});
