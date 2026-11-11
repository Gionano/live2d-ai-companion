import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateProfile, validateSlot, validateDocument } from '../settings/schema.js';
import { SettingsService } from '../settings/service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { listModels } from '../settings/models.js';

const KEY = 'eleven-private-fixture-12345678';
const profile = { adapter: 'elevenLabs', baseUrl: 'https://api.elevenlabs.io/v1', apiKeyEnv: 'ELEVENLABS_API_KEY' };
const params = { voice: 'fixture-voice', format: 'mp3', elevenLabs: {
  stability: 0.5, similarityBoost: 0.75, speed: 1.1, emotionTags: true,
}, expression: { sentencePauseMs: 175, segmentPauseMs: 150, mergeShortSentences: { enabled: true, minChars: 25, maxChars: 180 } } };
const slot = (options = {}) => ({ profile: 'eleven', model: 'eleven_flash_v2_5', params: structuredClone(params), ...options });
const config = () => ({ profiles: { eleven: structuredClone(profile), fish: { adapter: 'fishAudio', baseUrl: 'wss://example.invalid/tts' } },
  slots: { tts: slot(), llm: null, stt: null, vision: null, planner: null, visionFilter: null } });
const registryFor = value => new ProviderRegistry({ config: value, secretResolver: { resolve: () => KEY } });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eleven-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = { repoRoot: directory, localDir: directory, env: { ELEVENLABS_API_KEY: KEY }, platform: 'linux',
    allowPlaintext: true, layers: { defaults: config(), dev: {} } };
  return { directory, options, service: new SettingsService(options) };
}
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const modelService = (credentials = { apiKey: KEY }) => ({ config: () => config(),
  resolver: () => ({ profileSecrets: () => credentials }), secrets: { containsSecret: value => value.includes(KEY) } });

test('ElevenLabs profile and namespace retain schema version 1 and accept partial values', () => {
  assert.deepEqual(validateProfile(profile).profile, profile);
  for (const elevenLabs of [{}, { stability: 0 }, { stability: 1 }, { similarityBoost: 0 }, { speed: 0.7 },
    { speed: 1.2 }, { emotionTags: false }, params.elevenLabs]) {
    const choice = slot({ params: { elevenLabs } });
    assert.deepEqual(validateSlot(choice).slot, choice);
  }
  const document = { schemaVersion: 1, profiles: { eleven: profile }, slots: { tts: slot() }, ui: { language: 'id' } };
  assert.deepEqual(validateDocument(document), document);
});

test('ElevenLabs namespace rejects unsupported fields, wrong types and ranges', () => {
  for (const elevenLabs of [null, [], { stability: '0.5' }, { stability: -0.1 }, { stability: 1.1 },
    { similarityBoost: 1.1 }, { speed: 0.69 }, { speed: 1.21 }, { speed: NaN }, { emotionTags: 1 },
    { voice_settings: {} }, { apiKey: KEY }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => validateSlot(slot({ params: { elevenLabs } })), { code: 'INVALID_SETTINGS' });
  }
  for (const stability of [0, 0.5, 1]) validateSlot(slot({ model: 'eleven_v3', params: { elevenLabs: { stability } } }));
  assert.throws(() => validateSlot(slot({ model: 'eleven_v3', params: { elevenLabs: { stability: 0.25 } } })), { code: 'INVALID_SETTINGS' });
});

test('ElevenLabs registry requires its own explicit voice, supported model and MP3 without network calls', () => {
  const value = config();
  const registry = registryFor(value);
  assert.equal(registry.getSlotStatus('tts').available, true);
  assert.equal(registry.getSlotStatus('tts').adapter, 'elevenLabs');
  assert.equal(registry.getTts().capabilities.tts, true);
  assert.equal(registry.getTts().capabilities.llm, false);
  for (const voice of [undefined, '', ' ', '<voice>', 'ISI_DENGAN_VOICE']) {
    value.slots.tts = slot({ params: { voice } }); registry.reload(value);
    assert.equal(registry.getSlotStatus('tts').available, false);
    assert.match(registry.getSlotStatus('tts').reason, /Voice ID/);
  }
  value.slots.tts = slot({ model: 'eleven_v4' }); registry.reload(value);
  assert.equal(registry.getSlotStatus('tts').available, false);
  value.slots.tts = slot({ params: { ...params, format: 'wav' } }); registry.reload(value);
  assert.match(registry.getSlotStatus('tts').reason, /MP3/);
  value.slots.tts = slot({ params: { ...params, elevenLabs: { speed: 2 } } }); registry.reload(value);
  assert.match(registry.getSlotStatus('tts').reason, /voice settings/);
  value.slots.llm = slot(); registry.reload(value);
  assert.equal(registry.getSlotStatus('llm').available, false);
});

test('TTS overrides clear cross-adapter voice and apply transient explicit voice without mutating saved settings', () => {
  const value = config();
  value.slots.tts = { profile: 'fish', model: 'fish-model', params: { voice: 'fish-voice', topP: 0.7 } };
  const registry = registryFor(value);
  const unconfigured = registry.withSlotOverride('tts', { profile: 'eleven', model: 'eleven_flash_v2_5' });
  assert.equal(unconfigured.getSlotStatus('tts').available, false);
  assert.equal(unconfigured.config.slots.tts.params.voice, undefined);
  const available = registry.withSlotOverride('tts', { profile: 'eleven', model: 'eleven_flash_v2_5', voice: 'eleven-voice' });
  assert.equal(available.getSlotStatus('tts').available, true);
  assert.equal(available.getTts().params.voice, 'eleven-voice');
  assert.equal(registry.config.slots.tts.params.voice, 'fish-voice');
  assert.equal(registry.withSlotOverride('llm', { voice: 'unused' }).config.slots.llm.params?.voice, undefined);
});

test('ElevenLabs slot status checks stored credentials when no environment name is selected', () => {
  const value = config();
  value.profiles.eleven.apiKeyEnv = null;
  const missing = registryFor(value);
  assert.match(missing.getSlotStatus('tts').reason, /Missing ElevenLabs API key/);
  const stored = new ProviderRegistry({ config: value, secretResolver: { hasKey: () => true, profileSecrets: () => ({ apiKey: KEY }) } });
  assert.equal(stored.getSlotStatus('tts').available, true);
});

test('ElevenLabs namespace survives save, registry reload and export/import without exposing credentials', t => {
  const { service, options } = fixture(t);
  const registry = new ProviderRegistry({ config: service.config(), secretResolver: service.resolver() });
  service.attach(registry);
  const replacement = slot({ model: 'eleven_v3', params: { ...params, elevenLabs: { ...params.elevenLabs, stability: 1, emotionTags: false } } });
  service.putSlot('tts', { version: 0, slot: replacement });
  assert.deepEqual(service.effective().settings.slots.tts, replacement);
  assert.deepEqual(registry.getTts().params, replacement.params);
  assert.deepEqual(new SettingsService(options).config().slots.tts, replacement);
  const exported = service.export();
  assert.equal(exported.schemaVersion, 1);
  assert.equal(JSON.stringify([service.effective(), service.status(), exported]).includes(KEY), false);
  service.import({ version: service.effective().version, settings: exported });
  assert.deepEqual(service.export(), exported);
});

test('ElevenLabs model listing uses xi-api-key and selects supported speech model IDs', async () => {
  const calls = [];
  const result = await listModels(modelService({ apiKey: KEY, headers: { 'x-private': 'secret-header' } }), { profile: 'eleven', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return json([
      { model_id: 'eleven_flash_v2_5', can_do_text_to_speech: true },
      { model_id: 'eleven_v3', can_do_text_to_speech: true },
      { model_id: 'eleven_v3', can_do_text_to_speech: true },
      { model_id: 'eleven_v4', can_do_text_to_speech: true },
      { model_id: 'eleven_multilingual_v2', can_do_text_to_speech: false },
      { model_id: KEY, can_do_text_to_speech: true },
    ]);
  } });
  assert.deepEqual(result, { models: ['eleven_flash_v2_5', 'eleven_v3'], reason: null });
  assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/models');
  assert.equal(calls[0].options.headers['xi-api-key'], KEY);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.headers['x-private'], 'secret-header');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('ElevenLabs model listing handles missing keys, malformed data, errors and redirect cleanup safely', async () => {
  const noKey = await listModels(modelService({}), { profile: 'eleven', fetchImpl: () => { throw new Error('Must not connect'); } });
  assert.deepEqual(noKey, { models: [], reason: 'AUTH' });
  for (const body of [null, { data: [] }, 'wrong']) {
    assert.deepEqual(await listModels(modelService(), { profile: 'eleven', fetchImpl: async () => json(body) }), { models: [], reason: 'BAD_RESPONSE' });
  }
  assert.deepEqual(await listModels(modelService(), { profile: 'eleven', fetchImpl: async () => json([]) }), { models: [], reason: 'EMPTY' });
  const unauthorized = await listModels(modelService(), { profile: 'eleven', fetchImpl: async () => new Response(KEY, { status: 401 }) });
  assert.deepEqual(unauthorized, { models: [], reason: 'AUTH' });
  let cancelled = false;
  const redirected = await listModels(modelService(), { profile: 'eleven', fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { location: 'https://other.invalid' } }) });
  assert.deepEqual(redirected, { models: [], reason: 'BAD_REQUEST' });
  assert.equal(cancelled, true);
});

test('ElevenLabs model listing bounds responses and releases the response body', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel() { cancelled = true; } }));
  const result = await listModels(modelService(), { profile: 'eleven', fetchImpl: async () => response });
  assert.deepEqual(result, { models: [], reason: 'TOO_LARGE' });
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});
