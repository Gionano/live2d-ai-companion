import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import viteConfig from '../../vite.config.js';
import { startProductionStaticServer } from '../../desktop-companion/src/main/staticServer.js';
import { SettingsService } from '../settings/service.js';
import { installSettingsRoutes, isSettingsRequestAllowed } from '../settings/routes.js';
import { SLOT_NAMES } from '../settings/schema.js';

const PROFILE = { adapter: 'openaiCompatible', baseUrl: 'http://127.0.0.1:1234/v1' };
const quietLogger = { info() {}, warn() {}, error() {} };
const fixtureKey = ['fixture', 'credential', 'for', 'api', 'tests'].join('-');

function request(url, { headers = {}, method = 'GET', body, raw } = {}) {
  const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const outgoing = http.request(url, { method, headers: {
      connection: 'close',
      ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...headers,
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        resolve({ status: response.statusCode, headers: response.headers, body, text });
      });
    });
    outgoing.setTimeout(7000, () => outgoing.destroy(new Error('Fixture request exceeded its deadline.')));
    outgoing.on('error', reject);
    outgoing.end(data);
  });
}

function privateResponse(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(Object.keys(response.headers).some(name => name.startsWith('access-control-')), false);
}

async function closeServer(server) {
  server.closeAllConnections?.();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-api-'));
  const service = new SettingsService({ repoRoot: directory, localDir: directory, env: {}, allowPlaintext: true,
    layers: { defaults: { profiles: { fixture: PROFILE },
      slots: Object.fromEntries(SLOT_NAMES.map(name => [name, null])) }, dev: {} } });
  const app = express();
  const requests = [];
  app.use((req, res, next) => {
    requests.push({ peer: req.socket.remoteAddress, headers: { ...req.headers } });
    // Settings must suppress even CORS headers supplied by earlier middleware.
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  });
  const installed = installSettingsRoutes(app, { service, ...options });
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await closeServer(server);
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'settings-api-')));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await request(baseUrl + '/api/settings/bootstrap', { headers: { origin: baseUrl } });
  privateResponse(bootstrap, 200);
  return { directory, service, server, baseUrl, requests, ...installed,
    auth: { origin: baseUrl, 'x-settings-token': bootstrap.body.token } };
}

test('settings bootstrap and reads require verified local same-origin evidence', async t => {
  const backend = await fixture(t);
  for (const route of ['', '/bootstrap', '/status', '/legacy']) {
    const url = backend.baseUrl + '/api/settings' + route;
    for (const headers of [
      { origin: backend.baseUrl }, { 'sec-fetch-site': 'same-origin' },
      { origin: backend.baseUrl, 'sec-fetch-site': 'same-origin' },
    ]) privateResponse(await request(url, { headers }), 200);
    for (const headers of [
      {}, { 'sec-fetch-site': 'none' }, { origin: 'null' }, { origin: 'http://foreign.example' },
      { origin: backend.baseUrl + '/' }, { origin: backend.baseUrl, 'sec-fetch-site': 'cross-site' },
      { origin: backend.baseUrl, 'sec-fetch-site': 'same-site' },
      { origin: backend.baseUrl.replace('127.0.0.1', 'localhost') },
      { origin: backend.baseUrl.replace('http:', 'https:') },
    ]) privateResponse(await request(url, { headers }), 403);
  }
});

test('P3 probe deadline bounds and streamed phases use the protected API', async t => {
  const observed = [];
  const backend = await fixture(t, { probe: async (_slot, options) => {
    observed.push(options.registry.config.slots.llm.timeouts.totalMs);
    options.onProgress('first_byte'); options.onProgress('done');
    return { ok: true, ttftMs: 10, latencyMs: 15 };
  } });
  backend.service.putSlot('llm', { version: 0, slot: { profile: 'fixture', model: 'fixture' } });
  for (const timeoutMs of [0, -1, 999, 60001, '20000', 1.5]) {
    privateResponse(await request(backend.baseUrl + '/api/settings/test', { method: 'POST', headers: backend.auth, body: { slot: 'llm', timeoutMs } }), 400);
  }
  const response = await request(backend.baseUrl + '/api/settings/test', { method: 'POST',
    headers: { ...backend.auth, accept: 'application/x-ndjson' }, body: { slot: 'llm', timeoutMs: 60000 } });
  privateResponse(response, 200);
  const events = response.text.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(value => value.phase).map(value => value.phase), ['connecting', 'first_byte', 'done']);
  assert.equal(events.at(-1).result.ok, true);
  assert.deepEqual(observed, [60000]);
});

test('P3 real models, secret save and doctor integration remain private', async t => {
  const provider = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ' + fixtureKey) { res.writeHead(401); res.end('denied'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fixture-model' }, { id: fixtureKey }, { id: '<script>fixture</script>' }] }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening'); t.after(() => closeServer(provider));
  const backend = await fixture(t);
  const call = (route, body, method = 'POST') => request(backend.baseUrl + '/api/settings' + route, { method, headers: backend.auth, body });
  privateResponse(await call('/profiles/fixture', { version: 0, profile: { ...PROFILE, baseUrl: `http://127.0.0.1:${provider.address().port}/v1` }, secrets: { apiKey: fixtureKey } }, 'PUT'), 200);
  const before = fs.readFileSync(path.join(backend.directory, 'secrets.dat'));
  assert.deepEqual((await call('/models', { profile: 'fixture' })).body, { models: ['fixture-model'], reason: null });
  const doctor = await call('/diagnostics', {});
  privateResponse(doctor, 200); assert.equal(doctor.body.selfTest.ok, true);
  assert.equal(doctor.text.includes(fixtureKey), false);
  assert.equal(doctor.text.includes(backend.directory), false);
  assert.deepEqual(fs.readFileSync(path.join(backend.directory, 'secrets.dat')), before);
  for (const route of ['/models', '/diagnostics']) privateResponse(await request(backend.baseUrl + '/api/settings' + route,
    { method: 'POST', headers: { origin: backend.baseUrl }, body: {} }), 403);
});

test('P3 models and probes share one rate limit and one active operation', async t => {
  const backend = await fixture(t, { testLimit: 1, models: async () => ({ models: [], reason: 'EMPTY' }) });
  privateResponse(await request(backend.baseUrl + '/api/settings/models', { method: 'POST', headers: backend.auth, body: { profile: 'fixture' } }), 200);
  privateResponse(await request(backend.baseUrl + '/api/settings/test', { method: 'POST', headers: backend.auth, body: { slot: 'llm' } }), 429);
  privateResponse(await request(backend.baseUrl + '/api/settings/diagnostics', { method: 'POST', headers: backend.auth, body: {} }), 429);
});

test('settings reject remote peers, invalid Host and every untrusted forwarded hop', async t => {
  const backend = await fixture(t);
  const base = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost', origin: 'http://localhost' } };
  for (const peer of ['192.168.2.10', '10.1.2.3', '::', 'fe80::1%12', 'invalid', '']) {
    assert.equal(isSettingsRequestAllowed({ ...base, socket: { remoteAddress: peer },
      headers: { ...base.headers, 'x-forwarded-for': '127.0.0.1' } }), false);
  }
  for (const peer of ['127.0.0.2', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isSettingsRequestAllowed({ ...base, socket: { remoteAddress: peer } }), true);
  }
  for (const headers of [
    { host: 'foreign.example' }, { host: '127.0.0.1.foreign.example' }, { host: 'localhost:99999' },
    { host: 'localhost.' }, { host: ['localhost', 'foreign.example'].join('@') },
    { 'x-forwarded-host': 'foreign.example' }, { 'x-forwarded-host': 'localhost,foreign.example' },
    { 'x-forwarded-host': '' }, { 'x-forwarded-host': 'localhost,' },
    { 'x-forwarded-for': '' }, { 'x-forwarded-for': '127.0.0.1,192.168.2.10' },
    { 'x-forwarded-for': '192.168.2.10,127.0.0.1' }, { 'x-forwarded-for': 'fe80::1%12' },
    { 'x-forwarded-proto': 'ftp' }, { 'x-forwarded-proto': 'http,' },
  ]) privateResponse(await request(backend.baseUrl + '/api/settings', {
    headers: { 'sec-fetch-site': 'same-origin', ...headers },
  }), 403);
  assert.equal(isSettingsRequestAllowed({ socket: { remoteAddress: '::1' },
    headers: { host: '[::1]:8787', origin: 'http://[::1]:8787' } }), true);
  privateResponse(await request(backend.baseUrl + '/api/settings', { headers: {
    origin: backend.baseUrl, 'x-forwarded-for': '127.0.0.1,::1,::ffff:127.0.0.1',
  } }), 200);
});

test('all mutations and secret paths require this backend session token', async t => {
  const backend = await fixture(t);
  const other = await fixture(t);
  const writes = [
    ['PUT', '/profiles/fixture', { version: 0, profile: PROFILE }],
    ['DELETE', '/profiles/fixture', { version: 0 }],
    ['PUT', '/slots/llm', { version: 0, slot: null }],
    ['PUT', '/ui', { version: 0, ui: { language: 'en' } }],
    ['PUT', '/secrets/fixture', { version: 0, values: { apiKey: fixtureKey } }],
    ['DELETE', '/secrets/fixture', { version: 0 }],
    ['POST', '/export', {}], ['POST', '/import', {}], ['POST', '/legacy/import', { version: 0 }],
    ['POST', '/test', { slot: 'llm' }],
  ];
  for (const [method, route, body] of writes) {
    for (const token of [undefined, '', 'invalid', 'f'.repeat(64), '\u00e9'.repeat(64), other.auth['x-settings-token']]) {
      privateResponse(await request(backend.baseUrl + '/api/settings' + route, {
        method, body, headers: { origin: backend.baseUrl, ...(token !== undefined && { 'x-settings-token': token }) },
      }), 403);
    }
    privateResponse(await request(backend.baseUrl + '/api/settings' + route, {
      method, body, headers: { ...backend.auth, origin: 'http://foreign.example' },
    }), 403);
  }
  for (const route of ['/secrets/fixture', '/SECRETS/fixture']) {
    privateResponse(await request(backend.baseUrl + '/api/settings' + route, { headers: { origin: backend.baseUrl } }), 403);
    privateResponse(await request(backend.baseUrl + '/api/settings' + route, { headers: backend.auth }), 404);
  }
  assert.equal(backend.service.effective().version, 0);
});

test('settings body limits, schema errors and unknown routes never echo submitted values', async t => {
  const backend = await fixture(t);
  for (const [method, route, raw, status, headers] of [
    ['PUT', '/profiles/fixture', '{"secret":"' + fixtureKey, 400],
    ['PUT', '/profiles/fixture', JSON.stringify({ version: 0, profile: { ...PROFILE, safety: fixtureKey } }), 400],
    ['PUT', '/ui', JSON.stringify({ version: 0, ui: { language: 'en', personality: fixtureKey } }), 400],
    ['POST', '/test', JSON.stringify({ slot: 'llm', prompt: fixtureKey }), 400],
    ['POST', '/import', JSON.stringify({ version: 0, secret: fixtureKey }), 400],
    ['PUT', '/ui', JSON.stringify({ content: 'x'.repeat(65536) }), 413],
    ['PUT', '/ui', '{}', 400, { 'content-encoding': 'gzip' }],
    ['POST', '/unknown', '{}', 404],
  ]) {
    const response = await request(backend.baseUrl + '/api/settings' + route, {
      method, raw, headers: { ...backend.auth, ...headers },
    });
    privateResponse(response, status);
    assert.equal(response.text.includes(fixtureKey), false);
    assert.equal(response.text.includes(backend.directory), false);
  }
  privateResponse(await request(backend.baseUrl + '/api/settings/ui', { method: 'PUT', raw: '{broken',
    headers: { 'x-settings-token': backend.auth['x-settings-token'], origin: 'http://foreign.example' } }), 403);
});

test('successful API writes stay write-only and version conflicts preserve state', async t => {
  const backend = await fixture(t);
  const events = [];
  backend.service.setBroadcaster(event => events.push(event));
  const writes = [
    ['/profiles/fixture', { version: 0, profile: { ...PROFILE, apiKeyEnv: 'FIXTURE_KEY' } }],
    ['/secrets/fixture', { version: 1, values: { apiKey: fixtureKey, headers: { 'x-api-key': fixtureKey } } }],
    ['/slots/llm', { version: 2, slot: { profile: 'fixture', model: 'fixture-model' } }],
  ];
  for (const [route, body] of writes) {
    const response = await request(backend.baseUrl + '/api/settings' + route, { method: 'PUT', headers: backend.auth, body });
    privateResponse(response, 200);
    assert.deepEqual(response.body, { version: body.version + 1 });
  }
  const outcomes = await Promise.all(['en', 'id'].map(language => request(backend.baseUrl + '/api/settings/ui', {
    method: 'PUT', headers: backend.auth, body: { version: 3, ui: { language } },
  })));
  assert.deepEqual(outcomes.map(value => value.status).sort(), [200, 409]);
  const effective = await request(backend.baseUrl + '/api/settings', { headers: backend.auth });
  assert.equal(effective.body.version, 4);
  assert.deepEqual(effective.body.secrets.fixture.apiKey, { has: true, last4: fixtureKey.slice(-4) });
  assert.equal(effective.body.secrets.fixture.headers['x-api-key'].has, true);
  const exported = await request(backend.baseUrl + '/api/settings/export', { method: 'POST', headers: backend.auth, body: {} });
  privateResponse(exported, 200);
  const status = await request(backend.baseUrl + '/api/settings/status', { headers: backend.auth });
  assert.equal(status.body.slots.llm.available, true);
  for (const value of [effective.body, exported.body, status.body, events, backend.service.config(), backend.service]) {
    assert.equal(JSON.stringify(value).includes(fixtureKey), false);
  }
  assert.equal(events.length, 4);
  for (const event of events) assert.deepEqual(event, { type: 'settings_changed', slots: SLOT_NAMES });
  privateResponse(await request(backend.baseUrl + '/api/settings/profiles/fixture', {
    method: 'DELETE', headers: backend.auth, body: { version: 4 },
  }), 409);
  privateResponse(await request(backend.baseUrl + '/api/settings/profiles/fixture', {
    method: 'DELETE', headers: backend.auth, body: { version: 4, force: true },
  }), 200);
});

test('provider tests sanitize output and apply overrides without persisting them', async t => {
  let probeRegistry;
  let probeSignal;
  const backend = await fixture(t, { probe: async (slot, { registry, signal }) => {
    assert.equal(slot, 'llm'); probeRegistry = registry; probeSignal = signal;
    return { ok: true, latencyMs: 3, ttftMs: fixtureKey,
      tokens: { inputTokens: 1, outputTokens: fixtureKey }, details: fixtureKey,
      error: { code: fixtureKey, message: fixtureKey } };
  } });
  const response = await request(backend.baseUrl + '/api/settings/test', {
    method: 'POST', headers: backend.auth, body: { slot: 'llm', profile: 'fixture', model: 'probe-model' },
  });
  privateResponse(response, 200);
  assert.deepEqual(response.body, { ok: true, latencyMs: 3, tokens: { inputTokens: 1 },
    error: { code: 'BAD_RESPONSE', message: 'Provider test failed. Check the slot status and credentials.' } });
  assert.equal(probeRegistry.config.slots.llm.model, 'probe-model');
  assert.equal(probeRegistry.config.slots.llm.timeouts.totalMs, 20000);
  assert.equal(backend.registry.config.slots.llm, null);
  assert.equal(backend.service.effective().version, 0);
  assert.equal(probeSignal.aborted, true);
});

test('provider tests enforce rolling rate limits and recover after the window', async t => {
  let clock = 1000;
  let calls = 0;
  const backend = await fixture(t, { now: () => clock, testLimit: 2, testWindowMs: 1000,
    probe: async () => { calls++; return { ok: true, latencyMs: 1 }; } });
  const run = () => request(backend.baseUrl + '/api/settings/test', {
    method: 'POST', headers: backend.auth, body: { slot: 'llm' },
  });
  privateResponse(await run(), 200);
  privateResponse(await run(), 200);
  privateResponse(await run(), 429);
  assert.equal(calls, 2);
  clock += 1000;
  privateResponse(await run(), 200);
});

for (const slot of ['planner', 'visionFilter']) {
  for (const inheritance of ['implicit', 'explicit']) {
    test(`P3 ${slot} ${inheritance} inheritance honors ephemeral probe overrides`, async t => {
      const observed = [];
      const backend = await fixture(t, { probe: async (name, { registry }) => {
        observed.push(registry.getSlotStatus(name));
        assert.equal(registry.config.slots[name].timeouts.totalMs, 45000);
        return { ok: true };
      } });
      backend.service.putSlot('llm', { version: 0, slot: { profile: 'fixture', model: 'chat-model',
        timeouts: { totalMs: 9000 } } });
      if (inheritance === 'explicit') backend.service.putSlot(slot, { version: 1, slot: { followLlm: true } });
      else delete backend.registry.config.slots[slot];
      backend.registry.config.profiles.alternate = { ...PROFILE };
      const before = structuredClone(backend.registry.config);
      const saved = fs.readFileSync(path.join(backend.directory, 'settings.json'));
      for (const override of [{ model: 'probe-model' }, { profile: 'alternate' }, { profile: 'alternate', model: 'probe-model' }]) {
        const response = await request(backend.baseUrl + '/api/settings/test', { method: 'POST', headers: backend.auth,
          body: { slot, ...override, timeoutMs: 45000 } });
        privateResponse(response, 200);
        assert.equal(response.body.ok, true);
        assert.equal(observed.at(-1).profile, override.profile || 'fixture');
        assert.equal(observed.at(-1).model, override.model || 'chat-model');
      }
      assert.deepEqual(backend.registry.config, before);
      assert.deepEqual(fs.readFileSync(path.join(backend.directory, 'settings.json')), saved);
    });
  }
}

test('concurrent rejected probes cannot release the active test lock', async t => {
  let release;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const backend = await fixture(t, { probe: () => { began(); return new Promise(resolve => { release = resolve; }); } });
  const run = () => request(backend.baseUrl + '/api/settings/test', {
    method: 'POST', headers: backend.auth, body: { slot: 'llm' },
  });
  const pending = run();
  await started;
  privateResponse(await run(), 429);
  privateResponse(await run(), 429);
  release({ ok: true, latencyMs: 1 });
  privateResponse(await pending, 200);
});

test('provider test deadlines abort the provider and return a fixed error', async t => {
  let signal;
  const backend = await fixture(t, { testTimeoutMs: 30, probe: (_slot, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  const response = await request(backend.baseUrl + '/api/settings/test', {
    method: 'POST', headers: backend.auth, body: { slot: 'llm' },
  });
  privateResponse(response, 504);
  assert.equal(response.body.error.code, 'TIMEOUT');
  assert.equal(signal.aborted, true);
});

test('provider test exceptions never return provider text or storage paths', async t => {
  const backend = await fixture(t, { probe: async () => { throw new Error(fixtureKey); } });
  const response = await request(backend.baseUrl + '/api/settings/test', {
    method: 'POST', headers: backend.auth, body: { slot: 'llm' },
  });
  privateResponse(response, 400);
  assert.equal(response.text.includes(fixtureKey), false);
});

test('settings use the shared probe against a fake provider and refuse redirects', async t => {
  let calls = 0;
  let destinationCalls = 0;
  const destination = http.createServer((_req, res) => { destinationCalls++; res.end(); });
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  t.after(() => closeServer(destination));
  const provider = http.createServer((req, res) => {
    calls++;
    req.resume();
    assert.equal(req.headers['x-fixture'], fixtureKey);
    if (req.url.startsWith('/redirect/')) {
      res.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/capture` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: fixtureKey } }] }) + '\n\ndata: [DONE]\n\n');
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => closeServer(provider));
  const backend = await fixture(t);
  const profile = { ...PROFILE, baseUrl: `http://127.0.0.1:${provider.address().port}/v1` };
  backend.service.putProfile('fixture', { version: 0, profile, secrets: { headers: { 'x-fixture': fixtureKey } } });
  backend.service.putSlot('llm', { version: 1, slot: { profile: 'fixture', model: 'fixture-model' } });
  const run = () => request(backend.baseUrl + '/api/settings/test', {
    method: 'POST', headers: backend.auth, body: { slot: 'llm' },
  });
  const success = await run();
  privateResponse(success, 200);
  assert.equal(success.body.ok, true);
  assert.equal(typeof success.body.ttftMs, 'number');
  assert.equal(success.text.includes(fixtureKey), false);
  assert.equal(calls, 1);
  backend.service.putProfile('fixture', { version: 2, profile: {
    ...profile, baseUrl: `http://127.0.0.1:${provider.address().port}/redirect/v1`,
  } });
  const redirected = await run();
  privateResponse(redirected, 200);
  assert.equal(redirected.body.ok, false);
  assert.equal(destinationCalls, 0);
  assert.equal(redirected.text.includes(fixtureKey), false);
});

test('closing the settings test response aborts its provider request', { timeout: 3000 }, async t => {
  let began;
  let stopped;
  const started = new Promise(resolve => { began = resolve; });
  const aborted = new Promise(resolve => { stopped = resolve; });
  const backend = await fixture(t, { probe: (_slot, { signal }) => {
    began();
    return new Promise(resolve => signal.addEventListener('abort', () => {
      stopped(); resolve({ ok: false, latencyMs: 1 });
    }, { once: true }));
  } });
  const outgoing = http.request(backend.baseUrl + '/api/settings/test', {
    method: 'POST', headers: { ...backend.auth, 'content-type': 'application/json' },
  });
  outgoing.on('error', () => {});
  outgoing.end(JSON.stringify({ slot: 'llm' }));
  await started;
  outgoing.destroy();
  await aborted;
});

for (const frontend of ['Vite', 'Electron']) {
  test(`${frontend} settings proxy preserves origin, Host, forwarded-hop and no-CORS policy`, async t => {
    const backend = await fixture(t);
    let baseUrl;
    if (frontend === 'Vite') {
      fs.writeFileSync(path.join(backend.directory, 'package.json'), '{"name":"settings-proxy-fixture","private":true,"workspaces":[]}');
      const vite = await createViteServer({ ...viteConfig, root: backend.directory,
        cacheDir: path.join(backend.directory, 'vite-cache'), configFile: false, logLevel: 'silent',
        optimizeDeps: { noDiscovery: true, include: [] }, css: { postcss: { plugins: [] } },
        server: { ...viteConfig.server, host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [backend.directory] },
          proxy: { '/api': { ...viteConfig.server.proxy['/api'], target: backend.baseUrl } } },
      });
      await vite.listen();
      baseUrl = `http://127.0.0.1:${vite.httpServer.address().port}`;
      t.after(() => vite.close());
    } else {
      const proxy = await startProductionStaticServer(backend.directory, { backendUrl: backend.baseUrl, logger: quietLogger });
      baseUrl = proxy.url;
      t.after(() => closeServer(proxy.server));
    }
    const url = baseUrl + '/api/settings';
    const bootstrap = await request(url + '/bootstrap', { headers: { origin: baseUrl } });
    privateResponse(bootstrap, 200);
    const auth = { origin: baseUrl, 'x-settings-token': bootstrap.body.token };
    privateResponse(await request(url + '/ui', { method: 'PUT', headers: auth,
      body: { version: 0, ui: { language: 'en' } } }), 200);
    assert.equal(backend.requests.at(-1).headers.host, new URL(backend.baseUrl).host);
    assert.equal(backend.requests.at(-1).headers['x-forwarded-host'].split(',').at(-1), new URL(baseUrl).host);
    const provider = http.createServer(async (req, res) => {
      req.resume();
      assert.equal(req.headers.authorization, 'Bearer ' + fixtureKey);
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'proxy-model' }, { id: fixtureKey }] }));
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
      }
    });
    provider.listen(0, '127.0.0.1'); await once(provider, 'listening'); t.after(() => closeServer(provider));
    const call = (route, body, method = 'POST', headers = auth) => request(url + route, { method, headers, body });
    const deadOwner = spawnSync(process.execPath, ['-e', ''], { env: process.env, windowsHide: true });
    assert.equal(deadOwner.status, 0);
    fs.writeFileSync(path.join(backend.directory, 'settings.json.lock'), JSON.stringify({ pid: deadOwner.pid,
      createdAt: Date.now() - 90000000, nonce: 'proxy-fixture' }));
    privateResponse(await call('/profiles/fixture', { version: 1,
      profile: { ...PROFILE, baseUrl: `http://127.0.0.1:${provider.address().port}/v1` }, secrets: { apiKey: fixtureKey } }, 'PUT'), 200);
    assert.equal(fs.existsSync(path.join(backend.directory, 'settings.json.lock')), false);
    privateResponse(await call('/slots/llm', { version: 2, slot: { profile: 'fixture', model: 'proxy-model' } }, 'PUT'), 200);
    assert.deepEqual((await call('/models', { profile: 'fixture' })).body, { models: ['proxy-model'], reason: null });
    for (const timeoutMs of [999, 60001]) privateResponse(await call('/test', { slot: 'llm', timeoutMs }), 400);
    const tested = await call('/test', { slot: 'llm', timeoutMs: 60000 }, 'POST', { ...auth, accept: 'application/x-ndjson' });
    privateResponse(tested, 200);
    const events = tested.text.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.filter(event => event.phase).map(event => event.phase), ['connecting', 'first_byte', 'done']);
    assert.equal(events.at(-1).result.ok, true);
    const secretsBeforeDoctor = fs.readFileSync(path.join(backend.directory, 'secrets.dat'));
    const doctor = await call('/diagnostics', {});
    privateResponse(doctor, 200); assert.equal(doctor.body.selfTest.ok, true);
    assert.equal(doctor.text.includes(fixtureKey), false);
    assert.deepEqual(fs.readFileSync(path.join(backend.directory, 'secrets.dat')), secretsBeforeDoctor);
    for (const headers of [
      { origin: 'http://foreign.example' }, { 'sec-fetch-site': 'cross-site' },
      { host: 'foreign.example', 'x-forwarded-host': 'localhost' },
      { origin: 'http://localhost', 'x-forwarded-host': 'localhost' },
      { origin: baseUrl.replace('http:', 'https:'), 'x-forwarded-proto': 'https' },
      { 'x-forwarded-for': '192.168.2.10' }, { 'x-forwarded-for': '127.0.0.1,192.168.2.10' },
      { 'x-forwarded-host': 'foreign.example' }, { 'x-forwarded-proto': 'file' },
    ]) privateResponse(await request(url + '/bootstrap', { headers: { origin: baseUrl, ...headers } }), 403);
    privateResponse(await request(url + '/ui', { method: 'PUT', headers: auth, raw: '{broken' }), 400);
    const preflight = await request(url + '/ui', { method: 'OPTIONS', headers: {
      origin: 'http://foreign.example', 'access-control-request-method': 'PUT',
      'access-control-request-headers': 'x-settings-token',
    } });
    assert.equal(preflight.headers['cache-control'], 'no-store');
    assert.equal(Object.keys(preflight.headers).some(name => name.startsWith('access-control-')), false);
    await closeServer(backend.server);
    privateResponse(await request(url + '/status', { headers: auth }), frontend === 'Vite' ? 500 : 502);
  });
}
