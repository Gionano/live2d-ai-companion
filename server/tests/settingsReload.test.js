import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { SettingsService } from '../settings/service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { SLOT_NAMES } from '../settings/schema.js';
import { ADAPTER_CASES, SECRET, collect, fixture, requestFor } from './providerFixtures.js';

function setup(t, { profile, slot = 'llm', env = {}, dev = {} }) {
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-reload-'));
  t.after(() => fs.rmSync(localDir, { recursive: true, force: true }));
  const service = new SettingsService({ localDir, env, allowPlaintext: true,
    layers: { defaults: { profiles: { fixture: profile }, slots: {
      ...Object.fromEntries(SLOT_NAMES.map(name => [name, null])),
      [slot]: { profile: 'fixture', model: 'fixture-model',
        timeouts: { firstByteMs: 2000, idleMs: 2000, totalMs: 5000 } },
    } }, dev } });
  const registry = new ProviderRegistry({ config: service.config(), secretResolver: service.resolver(),
    adapterOptions: { resilience: { baseDelayMs: 1, random: () => 0 } } });
  const events = [];
  service.attach(registry, event => events.push(event));
  return { localDir, service, registry, events };
}

function assertPrivate({ service, registry, events }, values) {
  const serialized = JSON.stringify([service.effective(), service.status(), service.export(),
    registry, registry.config, [...registry.instances.values()], events]);
  for (const value of values) assert.equal(serialized.includes(value), false);
}

for (const spec of ADAPTER_CASES) {
  test(`${spec.id}: settings credentials reach only the fake provider transport`, async t => {
    const remote = await fixture(t, spec);
    const slot = spec.audio ? 'tts' : 'llm';
    const context = setup(t, { profile: { ...remote.profile, adapter: spec.id }, slot });
    const { service, registry, events, localDir } = context;
    const headerValue = 'fixture-header-value-never-public';
    const bodyValue = 'fixture-body-value-never-public';
    service.putSecret('fixture', { version: 0, values: {
      apiKey: SECRET, headers: { 'X-Fixture-Secret': headerValue },
      ...(!spec.audio && { bodyExtras: { options: { token: bodyValue } } }),
    } });
    const provider = spec.audio ? registry.getTts() : registry.getLlm();
    assert.ok(provider);
    await collect(provider.stream(requestFor(spec)));
    const request = remote.state.requests[0];
    assert.equal(request.headers[spec.id === 'anthropicNative' ? 'x-api-key' : 'authorization'],
      spec.id === 'anthropicNative' ? SECRET : `Bearer ${SECRET}`);
    assert.equal(request.headers['x-fixture-secret'], headerValue);
    if (!spec.audio) assert.equal(JSON.parse(request.body).options.token, bodyValue);
    assert.deepEqual(events, [{ type: 'settings_changed', slots: SLOT_NAMES }]);
    const settingsFile = fs.readFileSync(path.join(localDir, 'settings.json'), 'utf8');
    for (const value of [SECRET, headerValue, bodyValue]) assert.equal(settingsFile.includes(value), false);
    assertPrivate(context, [SECRET, headerValue, bodyValue]);
  });

  test(`${spec.id}: provider rejection cannot expose stored credentials in errors or settings events`, async t => {
    const remote = await fixture(t, spec, { status: 401 });
    const context = setup(t, { profile: { ...remote.profile, adapter: spec.id }, slot: spec.audio ? 'tts' : 'llm' });
    context.service.putSecret('fixture', { version: 0, values: { apiKey: SECRET } });
    const provider = spec.audio ? context.registry.getTts() : context.registry.getLlm();
    await assert.rejects(collect(provider.stream(requestFor(spec))), error => {
      assert.equal(error.code, 'AUTH');
      assert.equal(JSON.stringify(error).includes(SECRET), false);
      assert.equal(String(error).includes(SECRET), false);
      return true;
    });
    assert.equal(remote.state.attempts, 1);
    assertPrivate(context, [SECRET]);
  });
}

test('OpenAI-compatible STT resolves stored key and headers without exposing multipart credentials', async t => {
  const remote = await fixture(t, ADAPTER_CASES[0]);
  const context = setup(t, { profile: { ...remote.profile, adapter: 'openaiCompatible' }, slot: 'stt' });
  const { service, registry } = context;
  const headerValue = 'fixture-stt-header-never-public';
  service.putSecret('fixture', { version: 0, values: { apiKey: SECRET, headers: { 'x-extra-key': headerValue } } });
  const result = await registry.getStt().transcribe({ audio: Buffer.from('synthetic-audio'),
    filename: 'fixture.wav', mime: 'audio/wav' });
  assert.equal(result.text, 'Aku sedang membaca.');
  assert.equal(remote.state.requests[0].headers.authorization, `Bearer ${SECRET}`);
  assert.equal(remote.state.requests[0].headers['x-extra-key'], headerValue);
  assert.match(remote.state.requests[0].headers['content-type'], /multipart\/form-data/);
  assert.equal(remote.state.requests[0].body.includes(SECRET), false);
  assertPrivate(context, [SECRET, headerValue]);
});

for (const spec of ADAPTER_CASES.filter(item => !item.audio)) {
  test(`${spec.id}: profile and slot credential extras merge only inside outgoing bodies`, async t => {
    const remote = await fixture(t, spec);
    const context = setup(t, { profile: { ...remote.profile, adapter: spec.id,
      bodyExtras: { options: { mode: 'fixture' } } } });
    const { service, registry, localDir } = context;
    const profileValue = 'fixture-profile-extra-never-public';
    const slotValue = 'fixture-slot-extra-never-public';
    service.putSecret('fixture', { version: 0, values: { apiKey: SECRET,
      bodyExtras: { options: { api_token: profileValue } } } });
    service.putSlot('llm', { version: 1, slot: { profile: 'fixture', model: 'fixture-model',
      params: { bodyExtras: { options: { mode: 'slot', access_token: slotValue } } } } });
    await registry.getLlm().complete(requestFor(spec));
    assert.deepEqual(JSON.parse(remote.state.requests[0].body).options,
      { mode: 'slot', api_token: profileValue, access_token: slotValue });
    const settingsFile = fs.readFileSync(path.join(localDir, 'settings.json'), 'utf8');
    assert.equal(settingsFile.includes(profileValue), false);
    assert.equal(settingsFile.includes(slotValue), false);
    assertPrivate(context, [SECRET, profileValue, slotValue]);
  });
}

test('environment key overrides stored key while settings choose endpoint and model', async t => {
  const remote = await fixture(t, ADAPTER_CASES[0]);
  const environmentKey = 'fixture-environment-key-never-public';
  const context = setup(t, { profile: { ...remote.profile, adapter: 'openaiCompatible' },
    env: { FIXTURE_KEY: environmentKey, EXPLABS_BASE_URL: 'https://unused.invalid', EXPLABS_MODEL: 'unused-model' } });
  const { service, registry } = context;
  service.putSecret('fixture', { version: 0, values: { apiKey: SECRET } });
  await registry.getLlm().complete(requestFor(ADAPTER_CASES[0]));
  assert.equal(remote.state.requests[0].headers.authorization, `Bearer ${environmentKey}`);
  assert.equal(JSON.parse(remote.state.requests[0].body).model, 'fixture-model');
  assert.equal(service.effective().sources['profiles.fixture.secrets.apiKey'], 'env');
  assertPrivate(context, [SECRET, environmentKey]);
});

test('reload preserves an in-flight stream and its credentials while new requests use current settings', async t => {
  const requests = [];
  let oldResponse;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) });
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"first "}}]}\n\n');
    if (req.url.startsWith('/old/')) oldResponse = res;
    else res.end('data: {"choices":[{"delta":{"content":"new"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const context = setup(t, { profile: { adapter: 'openaiCompatible', baseUrl: `${baseUrl}/old` } });
  const { service, registry, events } = context;
  const oldKey = 'fixture-old-key-never-public';
  const newKey = 'fixture-new-key-never-public';
  service.putSecret('fixture', { version: 0, values: { apiKey: oldKey } });
  const provider = registry.getLlm();
  const controller = new AbortController();
  const stream = provider.stream({ messages: [{ role: 'user', content: 'fixture' }], signal: controller.signal });
  assert.deepEqual((await stream.next()).value, { type: 'text', delta: 'first ' });
  service.putProfile('fixture', { version: 1, profile: { adapter: 'openaiCompatible', baseUrl: `${baseUrl}/new` },
    secrets: { apiKey: newKey } });
  service.putSlot('llm', { version: 2, slot: { profile: 'fixture', model: 'new-fixture-model' } });
  assert.notEqual(registry.getLlm(), provider);
  assert.equal((await registry.getLlm().complete({ messages: [{ role: 'user', content: 'fixture' }] })).text, 'first new');
  oldResponse.end('data: {"choices":[{"delta":{"content":"old"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  const remainder = await collect(stream);
  assert.equal(remainder.filter(event => event.type === 'text').map(event => event.delta).join(''), 'old');
  assert.equal(controller.signal.aborted, false);
  assert.equal(requests[0].url, '/old/chat/completions');
  assert.equal(requests[0].headers.authorization, `Bearer ${oldKey}`);
  assert.equal(requests[0].body.model, 'fixture-model');
  assert.equal(requests[1].url, '/new/chat/completions');
  assert.equal(requests[1].headers.authorization, `Bearer ${newKey}`);
  assert.equal(requests[1].body.model, 'new-fixture-model');
  assert.deepEqual(events, Array.from({ length: 3 }, () => ({ type: 'settings_changed', slots: SLOT_NAMES })));
  assertPrivate(context, [oldKey, newKey]);
});

test('a retained provider keeps its credential snapshot even when first used after key rotation', async t => {
  const remote = await fixture(t, ADAPTER_CASES[0]);
  const context = setup(t, { profile: { ...remote.profile, adapter: 'openaiCompatible' } });
  const { service, registry } = context;
  const replacementKey = 'fixture-rotated-key-never-public';
  service.putSecret('fixture', { version: 0, values: { apiKey: SECRET } });
  const retained = registry.getLlm();
  service.putSecret('fixture', { version: 1, values: { apiKey: replacementKey } });
  await retained.complete(requestFor(ADAPTER_CASES[0]));
  await registry.getLlm().complete(requestFor(ADAPTER_CASES[0]));
  assert.equal(remote.state.requests[0].headers.authorization, `Bearer ${SECRET}`);
  assert.equal(remote.state.requests[1].headers.authorization, `Bearer ${replacementKey}`);
  assertPrivate(context, [SECRET, replacementKey]);
});

test('Fish validates privately resolved headers before opening its websocket', async t => {
  const remote = await fixture(t, ADAPTER_CASES[2], { adapterOptions: { secretResolver: {
    profileSecrets: () => ({ apiKey: SECRET, headers: { Host: 'unused.invalid' } }),
  } } });
  await assert.rejects(collect(remote.adapter.stream(requestFor(ADAPTER_CASES[2]))), error => error.code === 'BAD_REQUEST');
  assert.equal(remote.state.attempts, 0);
});

for (const spec of ADAPTER_CASES.filter(item => !item.audio)) {
  test(`${spec.id}: safe developer model options survive the settings projection`, async t => {
    const remote = await fixture(t, spec);
    const context = setup(t, { profile: { ...remote.profile, adapter: spec.id }, dev: { profiles: { fixture: {
      models: { 'fixture-model': { flags: { supportsImages: false, supportsStreamUsage: false },
        capabilities: { images: false }, bodyExtras: { options: { mode: 'per-model' } },
        omitParams: ['temperature'], defaultMaxTokens: 321 } },
    } } } });
    const { service, registry } = context;
    service.putSecret('fixture', { version: 0, values: { apiKey: SECRET } });
    await registry.getLlm().complete(requestFor(spec));
    const body = JSON.parse(remote.state.requests[0].body);
    assert.equal(body.options.mode, 'per-model');
    assert.equal(registry.getLlm().capabilities.images, false);
    assert.equal(service.effective().sources['profiles.fixture.models.fixture-model.defaultMaxTokens'], 'dev-file');
    if (spec.id === 'openaiCompatible') assert.equal(body.stream_options, undefined);
    else assert.equal(body.max_tokens, 321);
    assertPrivate(context, [SECRET]);
  });
}
