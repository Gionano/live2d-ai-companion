import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsService } from '../settings/service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { DEFAULT_CONFIG, resolveSlot } from '../providers/config.js';
import { emptySettings } from '../settings/schema.js';
import { ConversationVisionRouter } from '../visionRouting.js';
import { testSlot } from '../providers/testSlot.js';

const KEY = 'routing-fixture-credential-123456';
function fixture(t, { env = { GROQ_API_KEY: KEY } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const defaults = structuredClone(DEFAULT_CONFIG);
  const service = new SettingsService({ repoRoot: root, localDir: root, env, platform: 'linux', allowPlaintext: true,
    layers: { defaults, dev: { profiles: { groq: { flags: { supportsImages: true }, bodyExtras: { fixture: 'preserved' } } } } } });
  const registry = new ProviderRegistry({ config: service.config(), secretResolver: service.resolver() });
  service.attach(registry);
  return { root, service, registry };
}

test('old settings receive explicit Groq router defaults without changing other providers', t => {
  const h = fixture(t);
  assert.equal(h.service.config().slots.router.model, 'openai/gpt-oss-20b');
  assert.equal(h.service.config().slots.router.profile, 'groq');
  assert.equal(h.service.config().slots.router.params.bodyExtras.reasoning_effort, 'low');
  assert.equal(h.service.config().slots.router.timeouts.totalMs, 5000);
  assert.equal(h.service.config().profiles.groq.flags.supportsImages, true);
  assert.equal(h.service.config().profiles.groq.bodyExtras.fixture, 'preserved');
  assert.equal(h.registry.getSlotStatus('router').available, true);
  assert.equal(h.service.config().slots.llm, null);
  assert.equal(h.service.status().firstRun, true);
  assert.equal(resolveSlot({ slots: { router: null } }, 'router'), null);
});

test('router selection persists, supports version conflicts and preserves explicit null', t => {
  const h = fixture(t);
  const chosen = { profile: 'groq', model: 'another-model', params: { temperature: 0.1 } };
  const effective = { ...structuredClone(DEFAULT_CONFIG.slots.router), ...chosen,
    params: { ...structuredClone(DEFAULT_CONFIG.slots.router.params), ...chosen.params } };
  h.service.putSlot('router', { version: 0, slot: chosen });
  assert.deepEqual(h.service.config().slots.router, effective);
  assert.throws(() => h.service.putSlot('router', { version: 0, slot: null }), { code: 'CONFLICT' });
  h.service.refresh();
  assert.deepEqual(h.service.config().slots.router, effective);
  h.service.putSlot('router', { version: 1, slot: null });
  h.service.refresh();
  assert.equal(h.service.config().slots.router, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.root, 'settings.json'), 'utf8')).slots.router, null);
});

test('older imports migrate router and share existing Groq credentials without exporting them', t => {
  const h = fixture(t);
  const legacy = emptySettings();
  delete legacy.version;
  h.service.import({ version: 0, settings: legacy });
  assert.equal(h.service.config().slots.router.model, 'openai/gpt-oss-20b');
  assert.equal(h.registry.getSlotStatus('router').available, true);
  assert.doesNotMatch(JSON.stringify([h.service.effective(), h.service.export(), h.service.status()]), new RegExp(KEY));
  const exported = h.service.export();
  exported.slots.router = null;
  h.service.import({ version: 1, settings: exported });
  assert.equal(h.service.config().slots.router, null);
});

test('router uses the shared adapter, exact Groq model and secret accessor with text-only context', async t => {
  const h = fixture(t);
  const requests = [];
  const registry = new ProviderRegistry({ config: h.service.config(), secretResolver: h.service.resolver(),
    adapterOptions: { fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      const chunk = { choices: [{ delta: { content: '{"target":"conversation"}' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } } });
  const router = new ConversationVisionRouter({ registry });
  t.after(() => router.dispose());
  assert.equal((await router.route('Kenapa Manaka ini suka Tsumugu?')).target, 'conversation');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer ' + KEY);
  assert.equal(requests[0].body.model, 'openai/gpt-oss-20b');
  assert.equal(requests[0].body.reasoning_effort, 'low');
  assert.equal(requests[0].body.max_tokens, 512);
  assert.equal(requests[0].body.temperature, 0);
  assert.equal(requests[0].body.fixture, 'preserved');
  assert.ok(requests[0].body.messages.every(message => typeof message.content === 'string'));
  assert.doesNotMatch(JSON.stringify(requests[0].body), /data:image|image_url/);
});

test('missing Groq credentials leave ordinary conversation available through routing fallback', async t => {
  const h = fixture(t, { env: {} });
  const router = new ConversationVisionRouter({ registry: h.registry });
  t.after(() => router.dispose());
  assert.equal(h.registry.getSlotStatus('router').available, false);
  assert.equal((await router.route('Kenapa Manaka ini suka Tsumugu?', { availability: { webcam: true } })).target, 'conversation');
});

test('router connection probe requests JSON with the configured output budget and discards private output', async t => {
  const h = fixture(t);
  const requests = [];
  const registry = new ProviderRegistry({ config: h.service.config(), secretResolver: h.service.resolver(),
    adapterOptions: { fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      const chunk = { choices: [{ delta: { content: '{"ok":true}' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } } });
  const result = await testSlot('router', { registry });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].max_tokens, 512);
  assert.match(requests[0].messages[0].content, /JSON/);
  assert.doesNotMatch(JSON.stringify(result), /routing-fixture-credential|\{"ok":true\}/);
});

test('legacy imports preserve an explicitly retired Groq profile', t => {
  const h = fixture(t, { env: {} });
  const legacy = emptySettings();
  delete legacy.version;
  legacy.profiles.groq = null;
  h.service.import({ version: 0, settings: legacy });
  assert.equal(h.service.config().profiles.groq, null);
  assert.equal(h.service.config().slots.router, null);
  assert.equal(h.registry.getSlotStatus('router').available, false);
  const older = emptySettings();
  delete older.version;
  h.service.import({ version: 1, settings: older });
  assert.equal(h.service.config().profiles.groq, null);
  assert.equal(h.service.config().slots.router, null);
});
