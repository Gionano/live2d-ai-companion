import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { mountMemorySettings } from '../../src/settings/memorySettings.js';
import { createSettingsClient } from '../../src/settings/apiClient.js';
import { translator } from '../../src/settings/i18n.js';

const translations = JSON.parse(fs.readFileSync(new URL('../../src/i18n/id.json', import.meta.url), 'utf8'));
const english = JSON.parse(fs.readFileSync(new URL('../../src/i18n/en.json', import.meta.url), 'utf8'));
const XSS = '<img src=x onerror=alert(1)>';
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

async function fixture(t, { confirmation = true, state = 'setup_required' } = {}) {
  const dom = new JSDOM('<!doctype html><html lang="id"><body><main></main></body></html>', { url: 'http://localhost/?settings=1' });
  t.after(() => dom.window.close());
  const parent = dom.window.document.querySelector('main');
  const calls = [];
  const errors = [];
  const confirmations = [];
  const timers = [];
  let revision = 2;
  let version = 1;
  const configuration = { managedEmbedding: true, embeddingDevice: 'auto' };
  const fact = { id: 'fact-one', text: XSS, origin: 'verified', quotes: [{ eventId: 'event-one', speaker: 'user', text: 'Aku suka Hikari.' }] };
  const event = { id: 'event-one', userText: 'Aku suka Hikari.', assistantText: XSS, timestamp: 1720000000000, origin: 'conversation' };
  const snapshot = () => ({ version, configuration: { ...configuration }, status: { revision,
    counts: { events: 1, facts: 1, episodes: 0 }, jobs: [{ id: 'job-one', type: 'write', state: 'blocked', attempt: 1, errorCode: 'INVALID_MEMORY' }] },
  embedding: { state, ready: false } });
  const api = {
    get: async path => {
      calls.push(['GET', path]);
      if (path === '/memory') return snapshot();
      if (path.startsWith('/memory/facts?')) return { items: path.includes('cursor') ? [{ ...fact, id: 'fact-two', origin: 'legacy' }] : [fact], nextCursor: path.includes('cursor') ? null : 'second-page' };
      if (path.startsWith('/memory/events?')) return { items: [event], nextCursor: null };
      if (path.endsWith('/impact')) return { revision, eventCount: 1, factCount: 2, episodeCount: 0 };
      throw Object.assign(new Error(), { code: 'NOT_FOUND' });
    },
    write: async (path, body, method = 'PUT') => {
      calls.push([method, path, body]);
      if (path === '/memory/config') { version++; Object.assign(configuration, body.memory); return snapshot(); }
      if (path === '/memory/search') return { facts: [fact], events: [event], diagnostics: { method: 'keyword', durationMs: 2 } };
      if (body.memoryRevision !== undefined) { assert.equal(body.memoryRevision, revision); revision++; }
      return snapshot();
    },
  };
  const versions = [];
  const controller = mountMemorySettings(parent, { document: dom.window.document, api,
    t: translator('id', { id: translations, en: english }), fail: error => errors.push(error.code),
    confirm: message => { confirmations.push(message); return confirmation; }, onVersion: value => versions.push(value),
    setTimer: callback => { timers.push(callback); return 1; }, clearTimer: value => calls.push(['clearTimer', value]) });
  t.after(() => controller.dispose());
  await controller.ready;
  return { dom, parent, calls, errors, confirmations, timers, controller, versions };
}

test('memory panel uses Indonesian evidence labels, renders quotes safely and offers explicit setup only', async t => {
  const f = await fixture(t);
  assert.match(f.parent.textContent, /Memori/);
  assert.match(f.parent.textContent, /BGE-M3 belum terpasang/);
  assert.match(f.parent.textContent, /Kutipan asli pengguna/);
  assert.match(f.parent.textContent, /Aku suka Hikari\./);
  assert.match(f.parent.textContent, /--accept-license=bge-m3/);
  assert.equal(f.parent.querySelector('img'), null);
  assert.ok(f.parent.textContent.includes(XSS));
  assert.equal(f.calls.some(([method]) => method !== 'GET'), false);
  assert.deepEqual(f.errors, []);
});

test('memory polling retains unsaved configuration and manual fact drafts', async t => {
  const f = await fixture(t);
  const device = f.parent.querySelector('select');
  const manual = f.parent.querySelector('textarea');
  device.value = 'cpu'; manual.value = 'My unsaved preference.';
  f.timers[0](); await turn();
  assert.equal(device.value, 'cpu'); assert.equal(manual.value, 'My unsaved preference.');
  const form = device.closest('form'); form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await turn(); await turn();
  const saved = f.calls.find(([, path]) => path === '/memory/config');
  assert.deepEqual(saved, ['PUT', '/memory/config', { version: 1, memory: { managedEmbedding: true, embeddingDevice: 'cpu' } }]);
  assert.ok(f.versions.includes(2));
  assert.equal(manual.value, 'My unsaved preference.');
});

test('memory deletion confirms supporting dialogue counts and uses reviewed memory revision', async t => {
  const f = await fixture(t);
  f.parent.querySelector('[data-memory-fact] button').click();
  await turn(); await turn();
  assert.ok(f.confirmations[0].includes('1 percakapan, 2 fakta'));
  assert.deepEqual(f.calls.find(([method]) => method === 'DELETE'), ['DELETE', '/memory/facts/fact-one', { memoryRevision: 2 }]);
});

test('declining memory deletion does not submit a mutation', async t => {
  const f = await fixture(t, { confirmation: false });
  f.parent.querySelector('[data-memory-fact] button').click();
  await turn();
  assert.equal(f.calls.some(([method]) => method === 'DELETE'), false);
});

test('memory search and pagination stay outside dialogue and persist no browser data', async t => {
  const f = await fixture(t);
  const query = f.parent.querySelector('input[maxlength="4096"]');
  query.value = 'Hikari'; query.closest('form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await turn();
  assert.match(f.parent.querySelector('[data-memory-search-results]').textContent, /Aku suka Hikari\./);
  assert.deepEqual(f.calls.find(([, path]) => path === '/memory/search'), ['POST', '/memory/search', { query: 'Hikari' }]);
  const factsSection = f.parent.querySelector('[data-memory-facts]').parentElement;
  [...factsSection.children].find(item => item.tagName === 'BUTTON').click(); await turn();
  assert.ok(f.calls.some(([, path]) => path === '/memory/facts?limit=20&cursor=second-page'));
  assert.equal(f.parent.querySelectorAll('[data-memory-facts] [data-memory-fact]').length, 2);
  assert.match(f.parent.querySelector('[data-memory-facts]').textContent, /Catatan lama/);
  assert.equal(f.dom.window.localStorage.length, 0);
});

test('disposing memory panel cancels polling and ignores late reads', async () => {
  const dom = new JSDOM('<main></main>');
  const parent = dom.window.document.querySelector('main');
  const reads = [];
  const cancelled = [];
  const api = { get: () => new Promise(resolve => reads.push(resolve)) };
  const controller = mountMemorySettings(parent, { document: dom.window.document, api,
    t: translator('id', { id: translations, en: english }), setTimer: () => 3, clearTimer: value => cancelled.push(value) });
  const before = parent.textContent;
  controller.dispose();
  reads[0]({ version: 1, status: { revision: 1 }, embedding: { state: 'running' } });
  reads[1]({ items: [], nextCursor: null }); reads[2]({ items: [], nextCursor: null });
  await controller.ready;
  assert.deepEqual(cancelled, [3]); assert.equal(parent.textContent, before);
  dom.window.close();
});

test('settings API client accepts only bounded memory paths and keeps search text out of URLs', async () => {
  const calls = [];
  const client = createSettingsClient(async (url, options) => {
    calls.push([url, options]);
    return new Response(JSON.stringify(url.endsWith('/bootstrap') ? { token: 'f'.repeat(64) } : {}), { headers: { 'content-type': 'application/json' } });
  });
  await client.get('/memory/facts?limit=20&cursor=next');
  await client.write('/memory/search', { query: 'Aku suka Hikari.' }, 'POST');
  assert.equal(calls.some(([url]) => url.includes('Hikari')), false);
  assert.equal(calls.at(-1)[1].headers['X-Settings-Token'], 'f'.repeat(64));
  for (const invalid of ['/memory/search?query=Hikari', '/memory/facts?limit=101', '/memory/facts?limit=20&limit=5', '/memory/events?url=https://bad.invalid', '/memory/../../secrets']) {
    await assert.rejects(client.get(invalid), { code: 'INVALID_SETTINGS' });
  }
});
