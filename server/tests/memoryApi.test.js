import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { SettingsService } from '../settings/service.js';
import { installSettingsRoutes } from '../settings/routes.js';

const request = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = http.request(url, { method, headers: { connection: 'close', ...headers,
    ...(bytes && { 'content-type': 'application/json', 'content-length': bytes.length }) } }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()) }));
  });
  req.on('error', reject); req.end(bytes);
});

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-api-'));
  let revision = 1;
  const calls = [];
  const facts = [{ id: 'fact-one', text: 'Suka Hikari', quotes: [{ eventId: 'event-one', speaker: 'user', text: 'Aku suka Hikari.' }] }];
  const events = [{ id: 'event-one', userText: 'Aku suka Hikari.', assistantText: 'Aku mengerti.', origin: 'conversation' }];
  const check = options => { if (options?.expectedRevision !== undefined && options.expectedRevision !== revision) {
    throw Object.assign(new Error('private fixture text'), { code: 'CONFLICT', status: 409 });
  } };
  const manager = {
    get memory() { return { lastSeen: 123, profile: { userName: '', nickname: 'sayang', facts }, episodes: [] }; },
    status: () => ({ revision, counts: { facts: facts.length, events: events.length, episodes: 0 }, jobs: [] }),
    formatTimeElapsed: () => 'Baru saja.', getMemoryPrompt: () => 'Memory metadata only.',
    listFacts: options => { calls.push(['facts', options]); return { items: facts, nextCursor: null }; },
    listEvents: options => { calls.push(['events', options]); return { items: events, nextCursor: null }; },
    search: async (query, options) => { calls.push(['search', query, options.signal]); return { facts, events, diagnostics: { method: 'keyword' } }; },
    addFact: (text, category, options) => { check(options); facts.push({ id: 'fact-added', text, category }); revision++; calls.push(['add', text, category]); },
    deletionImpact: (kind, id) => ({ kind, id, eventCount: 1, factCount: 1, episodeCount: 0, revision }),
    deleteFact: (id, options) => { check(options); facts.splice(0); events.splice(0); revision++; calls.push(['deleteFact', id]); },
    deleteEvent: (id, options) => { check(options); facts.splice(0); events.splice(0); revision++; calls.push(['deleteEvent', id]); },
    clearMemory: options => { check(options); facts.splice(0); events.splice(0); revision++; calls.push(['clear']); },
    retryJob: (id, options) => { check(options); revision++; calls.push(['retry', id]); return { id }; },
    reindex: options => { check(options); revision++; calls.push(['reindex']); return { id: 'reindex-one' }; },
  };
  let runtimeCalls = 0;
  const runtime = { status: () => ({ state: 'setup_required', ready: false }), retry: async () => { runtimeCalls++; } };
  const service = new SettingsService({ repoRoot: directory, localDir: directory, env: {}, allowPlaintext: true,
    layers: { defaults: {}, dev: {} } });
  const app = express();
  app.use((_req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
  installSettingsRoutes(app, { service, memoryService: { manager, runtime } });
  const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const bootstrap = await request(url + '/api/settings/bootstrap', { headers: { origin: url } });
  const headers = { origin: url, 'x-settings-token': bootstrap.body.token };
  return { url, headers, calls, manager, service, runtimeCalls: () => runtimeCalls };
}

test('memory reads and legacy aliases require same-origin loopback evidence and never expose CORS', async t => {
  const f = await fixture(t);
  for (const route of ['/api/settings/memory', '/api/memory']) {
    const denied = await request(f.url + route);
    assert.equal(denied.status, 403);
    const result = await request(f.url + route, { headers: f.headers });
    assert.equal(result.status, 200);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal(Object.keys(result.headers).some(name => name.startsWith('access-control-')), false);
  }
  assert.equal((await request(f.url + '/api/memory', { headers: { ...f.headers, origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal(f.runtimeCalls(), 0);
});

test('new memory mutations require token and memory revision; legacy mutation shapes remain accepted with token', async t => {
  const f = await fixture(t);
  const path = f.url + '/api/settings/memory/fact';
  assert.equal((await request(path, { method: 'POST', headers: { origin: f.url }, body: { text: 'Suka Hikari.', memoryRevision: 1 } })).status, 403);
  assert.equal((await request(path, { method: 'POST', headers: f.headers, body: { text: 'Suka Hikari.' } })).status, 400);
  const accepted = await request(path, { method: 'POST', headers: f.headers, body: { text: 'Suka Hikari.', category: 'manual', memoryRevision: 1 } });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.status.revision, 2);
  const conflict = await request(path, { method: 'POST', headers: f.headers, body: { text: 'Other fact.', memoryRevision: 1 } });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'CONFLICT');
  assert.equal(JSON.stringify(conflict.body).includes('private fixture'), false);
  const legacy = await request(f.url + '/api/memory/fact', { method: 'POST', headers: f.headers, body: { text: 'Manual legacy fact.' } });
  assert.equal(legacy.status, 200); assert.equal(legacy.body.success, true); assert.ok(Array.isArray(legacy.body.facts));
});

test('memory pagination, quote retrieval, bounded search and delete impact use private interfaces', async t => {
  const f = await fixture(t);
  const page = await request(f.url + '/api/settings/memory/facts?limit=5&cursor=next', { headers: f.headers });
  assert.equal(page.status, 200); assert.equal(page.body.items[0].quotes[0].text, 'Aku suka Hikari.');
  assert.deepEqual(f.calls[0], ['facts', { cursor: 'next', limit: 5 }]);
  assert.equal((await request(f.url + '/api/settings/memory/events?limit=101', { headers: f.headers })).status, 400);
  assert.equal((await request(f.url + '/api/settings/memory/events?unexpected=x', { headers: f.headers })).status, 400);
  assert.equal((await request(f.url + '/api/settings/memory/events?limit[]=20', { headers: f.headers })).status, 400);
  const result = await request(f.url + '/api/settings/memory/search', { method: 'POST', headers: f.headers, body: { query: 'Hikari' } });
  assert.equal(result.status, 200); assert.equal(result.body.events[0].userText, 'Aku suka Hikari.');
  const impact = await request(f.url + '/api/settings/memory/facts/fact-one/impact', { headers: f.headers });
  assert.equal(impact.body.eventCount, 1);
  const deleted = await request(f.url + '/api/settings/memory/facts/fact-one', { method: 'DELETE', headers: f.headers, body: { memoryRevision: impact.body.revision } });
  assert.equal(deleted.status, 200); assert.equal(deleted.body.status.counts.events, 0);
});

test('memory configuration uses settings version and setup starts only through an explicit retry', async t => {
  const f = await fixture(t);
  const result = await request(f.url + '/api/settings/memory/config', { method: 'PUT', headers: f.headers,
    body: { version: 0, memory: { managedEmbedding: false, embeddingDevice: 'cpu' } } });
  assert.equal(result.status, 200); assert.equal(result.body.version, 1);
  assert.equal(result.body.configuration.embeddingDevice, 'cpu');
  assert.equal(f.runtimeCalls(), 0);
  assert.equal((await request(f.url + '/api/settings/memory/config', { method: 'PUT', headers: f.headers,
    body: { version: 0, memory: {} } })).status, 409);
  assert.equal((await request(f.url + '/api/settings/memory/embedding/retry', { method: 'POST', headers: f.headers, body: {} })).status, 200);
  assert.equal(f.runtimeCalls(), 1);
});

test('memory processing, clearing and malformed requests preserve revision fences', async t => {
  const f = await fixture(t);
  assert.equal((await request(f.url + '/api/settings/memory/jobs/job-one/retry', { method: 'POST', headers: f.headers, body: { memoryRevision: 1 } })).status, 200);
  assert.equal((await request(f.url + '/api/settings/memory/reindex', { method: 'POST', headers: f.headers, body: { memoryRevision: 2 } })).status, 200);
  assert.equal((await request(f.url + '/api/settings/memory/clear', { method: 'POST', headers: f.headers, body: { memoryRevision: 1 } })).status, 409);
  assert.equal((await request(f.url + '/api/settings/memory/clear', { method: 'POST', headers: f.headers, body: { memoryRevision: 3 } })).status, 200);
  for (const body of [{ query: '' }, { query: 'x'.repeat(4097) }, { query: 'Hikari', images: [] }]) {
    assert.equal((await request(f.url + '/api/settings/memory/search', { method: 'POST', headers: f.headers, body })).status, 400);
  }
  assert.equal((await request(f.url + '/api/settings/memory/fact', { method: 'POST', headers: f.headers, body: { text: 'safe', memoryRevision: 4, command: 'download' } })).status, 400);
});
