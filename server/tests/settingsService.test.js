import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsService } from '../settings/service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { emptySettings, validateDocument, validateProfile, validateSlot } from '../settings/schema.js';

const KEY = 'fixture-private-key-value-12345678';
const HEADER = 'fixture-private-header-value';
const REPLACEMENT = 'replacement-fixture-value';
const STORED = 'stored-fixture-value';
const profile = { adapter: 'openaiCompatible', baseUrl: 'https://example.invalid/v1' };
const selection = { profile: 'sample', model: 'fixture-model' };
const base = () => ({ profiles: { sample: structuredClone(profile) }, slots: { llm: structuredClone(selection),
  planner: null, vision: null, visionFilter: null, stt: null, tts: null } });
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new SettingsService({ repoRoot: root, localDir: root, env: {}, platform: 'linux',
    allowPlaintext: true, layers: { defaults: base(), dev: {} }, ...options });
  const registry = new ProviderRegistry({ config: service.config(), secretResolver: service.resolver() });
  const events = [];
  service.attach(registry, event => events.push(event));
  return { root, service, registry, events };
}
const invalid = fn => assert.throws(fn, { code: 'INVALID_SETTINGS' });
const version = service => service.effective().version;
const requestProfile = (service, value, more = {}) => ({ version: version(service), profile: value, ...more });

for (const [name, patch] of [
  ['unknown profile field', { extraHeaders: { 'x-private': HEADER } }],
  ['unknown flag', { flags: { safety: false } }],
  ['array environment reference', { apiKeyEnv: ['FIXTURE_API_KEY'] }],
  ['array version header', { anthropicVersion: ['2026-01-01'] }],
  ['nested moderation', { bodyExtras: { options: { moderation_enabled: false } } }],
  ['persona omission', { omitParams: ['system'] }],
  ['prompt omission', { omitParams: ['messages'] }],
  ['per-model origin', { models: { fixture: { baseUrl: 'https://other.invalid' } } }],
  ['per-model secret', { models: { fixture: { bodyExtras: { token: KEY } } } }],
]) test('settings schema rejects ' + name, () => invalid(() => validateProfile({ ...profile, ...patch })));

test('document and slot schemas reject unsupported choices', () => {
  invalid(() => validateDocument({ ...emptySettings(), safety: {} }, { persisted: true }));
  invalid(() => validateSlot({ ...selection, params: { personality: 'changed' } }));
  invalid(() => validateSlot({ ...selection, timeouts: { connectMs: 10 } }));
  invalid(() => validateSlot({ ...selection, params: null }));
  invalid(() => validateDocument({ ...emptySettings(), ui: { language: 'fr' } }, { persisted: true }));
  invalid(() => validateProfile({ ...profile, bodyExtras: JSON.parse('{"__proto__":{"token":"fixture"}}') }));
});

test('layers report final field sources and ignore environment endpoint/model choices', t => {
  const defaults = base();
  defaults.profiles.sample.flags = { supportsImages: false };
  defaults.profiles.sample.baseUrlEnv = 'EXPLABS_BASE_URL';
  defaults.profiles.sample.apiKeyEnv = 'FIXTURE_API_KEY';
  defaults.slots.llm.modelEnv = 'EXPLABS_MODEL';
  const { service, root } = fixture(t, { layers: { defaults, dev: {
    profiles: { sample: { baseUrl: 'https://dev.invalid/v1' } }, slots: { llm: { params: { temperature: 0.2 } } },
  } }, env: { EXPLABS_BASE_URL: 'https://environment.invalid', EXPLABS_MODEL: 'env-model', FIXTURE_API_KEY: KEY } });
  let effective = service.effective();
  assert.equal(effective.settings.profiles.sample.baseUrl, 'https://dev.invalid/v1');
  assert.equal(effective.settings.slots.llm.model, 'fixture-model');
  assert.equal(effective.sources['profiles.sample.baseUrl'], 'dev-file');
  assert.equal(effective.sources['profiles.sample.flags.supportsImages'], 'default');
  assert.equal(effective.sources['profiles.sample.secrets.apiKey'], 'env');
  assert.equal(effective.sources['ui.language'], 'default');
  assert.equal(fs.existsSync(path.join(root, 'settings.json')), false);
  service.putSlot('llm', { version: 0, slot: { ...selection, model: 'chosen' } });
  effective = service.effective();
  assert.equal(effective.sources['slots.llm.model'], 'settings');
  assert.equal(effective.settings.slots.llm.params.temperature, 0.2);
});

test('developer projection drops unknown nested data and masks known credentials everywhere', t => {
  const { service, registry } = fixture(t, { layers: { defaults: base(), dev: {
    profiles: { sample: { extraHeaders: { 'x-fixture': KEY },
      flags: { unknown: HEADER }, capabilities: { unexpected: HEADER },
      models: { safe: { flags: { supportsImages: true }, ignored: KEY } } } },
    slots: { llm: { model: KEY, params: { unknown: HEADER }, timeouts: { unknown: HEADER } } },
  } } });
  const serialized = JSON.stringify([service.effective(), service.status(), service.export(), service.config(), registry]);
  assert.equal(serialized.includes(KEY), false);
  assert.equal(serialized.includes(HEADER), false);
  assert.deepEqual(service.config().profiles.sample.flags, {});
});

test('secrets stay private while presence and per-field sources remain available', t => {
  const { service, root, events, registry } = fixture(t);
  service.putProfile('sample', requestProfile(service, { ...profile, bodyExtras: { mode: 'fast', token: KEY } },
    { secrets: { apiKey: KEY, headers: { 'X-Fixture': HEADER } } }));
  service.putSlot('llm', { version: version(service), slot: { ...selection, params: { bodyExtras: { session_token: HEADER } } } });
  const effective = service.effective();
  assert.deepEqual(effective.secrets.sample.apiKey, { has: true, last4: '5678' });
  assert.deepEqual(effective.secrets.sample.headers['x-fixture'], { has: true });
  assert.equal(effective.secrets.sample.bodyExtras.has, true);
  assert.equal(effective.secrets.sample.slotBodyExtras.llm.has, true);
  assert.equal(effective.sources['profiles.sample.secrets.headers.x-fixture'], 'settings');
  assert.equal(effective.sources['profiles.sample.secrets.bodyExtras.token'], 'settings');
  const settings = fs.readFileSync(path.join(root, 'settings.json'), 'utf8');
  const publicData = JSON.stringify([effective, service.status(), service.export(), service, registry, events]);
  for (const secret of [KEY, HEADER]) {
    assert.equal(settings.includes(secret), false);
    assert.equal(publicData.includes(secret), false);
  }
  assert.deepEqual(events[0], { type: 'settings_changed', slots: ['llm', 'planner', 'vision', 'visionFilter', 'stt', 'tts'] });
});

test('known secret duplication is rejected before public persistence', t => {
  const { service, root } = fixture(t);
  service.putSecret('sample', { version: 0, values: { apiKey: KEY } });
  invalid(() => service.putSlot('llm', { version: 1, slot: { ...selection, model: KEY } }));
  invalid(() => service.putProfile('sample', requestProfile(service, { ...profile, bodyExtras: { label: HEADER } },
    { secrets: { headers: { 'x-fixture': HEADER } } })));
  assert.equal(version(service), 1);
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8').includes(KEY), false);
});

test('inactive environment and orphaned stored credentials stay out of public projections', t => {
  const defaults = base();
  defaults.profiles.sample = { ...profile, baseUrl: 'REPLACE_WITH_HTTPS_BASE_URL', apiKeyEnv: 'FIXTURE_API_KEY' };
  defaults.slots.llm.model = KEY;
  const { service } = fixture(t, { layers: { defaults, dev: {} }, env: { FIXTURE_API_KEY: KEY } });
  assert.equal(JSON.stringify([service.config(), service.effective(), service.export()]).includes(KEY), false);
  service.secrets.set('orphan', 'https://old.invalid', { apiKey: HEADER });
  invalid(() => service.putSlot('llm', { version: 0, slot: { ...selection, model: HEADER } }));
});

test('origin change requires replacement or deletion confirmation', t => {
  const { service } = fixture(t);
  service.putSecret('sample', { version: 0, values: { apiKey: KEY, headers: { 'x-fixture': HEADER } } });
  const changed = { ...profile, baseUrl: 'https://other.invalid/v1' };
  assert.throws(() => service.putProfile('sample', requestProfile(service, changed)), { code: 'ORIGIN_CHANGE' });
  service.putProfile('sample', requestProfile(service, changed, { secrets: { apiKey: REPLACEMENT } }));
  let values = service.resolver().profileSecrets('sample', service.config().profiles.sample);
  assert.equal(values.apiKey, REPLACEMENT);
  assert.deepEqual(values.headers, {});
  service.putProfile('sample', requestProfile(service, profile, { confirmDeleteSecrets: true }));
  values = service.resolver().profileSecrets('sample', service.config().profiles.sample);
  assert.equal(values.apiKey, undefined);
  assert.equal(service.secrets.has('sample'), false);
});

test('empty secret bundles cannot authorize an origin change', t => {
  const { service } = fixture(t);
  service.putSecret('sample', { version: 0, values: { apiKey: KEY } });
  for (const empty of [{}, { headers: {} }, { bodyExtras: {} }, { slotBodyExtras: { llm: {} } }]) {
    invalid(() => service.putProfile('sample', requestProfile(service,
      { ...profile, baseUrl: 'https://other.invalid' }, { secrets: empty })));
    invalid(() => service.putSecret('sample', { version: 1, values: empty }));
  }
  assert.equal(service.config().profiles.sample.baseUrl, profile.baseUrl);
  assert.equal(service.secrets.get('sample', 'https://example.invalid').apiKey, KEY);
});

test('path-only URL edits preserve secrets and environment wins until origin detachment', t => {
  const defaults = base();
  defaults.profiles.sample.apiKeyEnv = 'FIXTURE_API_KEY';
  const { service } = fixture(t, { layers: { defaults, dev: {} }, env: { FIXTURE_API_KEY: KEY } });
  service.putSecret('sample', { version: 0, values: { apiKey: STORED } });
  service.putProfile('sample', requestProfile(service, { ...profile, baseUrl: 'https://example.invalid/v2' }));
  assert.equal(service.resolver().profileSecrets('sample', service.config().profiles.sample).apiKey, KEY);
  service.putProfile('sample', requestProfile(service, { ...profile, baseUrl: 'https://other.invalid' }, { confirmDeleteSecrets: true }));
  assert.equal(service.config().profiles.sample.apiKeyEnv, null);
  assert.equal(service.resolver().profileSecrets('sample', service.config().profiles.sample).apiKey, undefined);
});

test('slot-only developer credentials also enforce origin binding', t => {
  const defaults = base();
  defaults.slots.llm.params = { bodyExtras: { token: KEY } };
  const { service } = fixture(t, { layers: { defaults, dev: {} } });
  assert.throws(() => service.putProfile('sample', requestProfile(service, { ...profile, baseUrl: 'https://other.invalid' })), { code: 'ORIGIN_CHANGE' });
});

test('header name removal stops sending its stored value', t => {
  const { service } = fixture(t);
  service.putSecret('sample', { version: 0, values: { headers: { 'x-fixture': HEADER } } });
  service.putProfile('sample', requestProfile(service, { ...profile, headerNames: [] }));
  assert.deepEqual(service.resolver().profileSecrets('sample', service.config().profiles.sample).headers, {});
  invalid(() => service.putSlot('llm', { version: version(service), slot: { ...selection, model: HEADER } }));
});

test('forced profile deletion unassigns its slots and removes stale sources', t => {
  const { service } = fixture(t);
  assert.throws(() => service.deleteProfile('sample', { version: 0 }), { code: 'IN_USE' });
  service.deleteProfile('sample', { version: 0, force: true });
  const effective = service.effective();
  assert.equal(effective.settings.profiles.sample, null);
  assert.equal(effective.settings.slots.llm, null);
  assert.equal(effective.sources['profiles.sample'], 'settings');
  assert.equal(effective.sources['profiles.sample.baseUrl'], undefined);
});

test('export/import round trip copies choices without credentials', t => {
  const first = fixture(t);
  first.service.putSecret('sample', { version: 0, values: { apiKey: KEY, headers: { 'x-fixture': HEADER } } });
  first.service.putUi({ version: 1, ui: { language: 'en' } });
  const exported = first.service.export();
  const second = fixture(t);
  second.service.import({ version: 0, settings: exported });
  assert.deepEqual(second.service.export(), exported);
  assert.equal(second.service.effective().secrets.sample.apiKey.has, false);
  assert.equal(second.service.effective().settings.ui.language, 'en');
  assert.equal(first.service.secrets.has('sample'), true);
  assert.equal(second.service.secrets.has('sample'), false);
});

test('import cannot reroute, remove, or revive a differently bound secret', t => {
  const { service } = fixture(t);
  service.putSecret('sample', { version: 0, values: { apiKey: KEY } });
  const input = service.export();
  input.profiles.sample.baseUrl = 'https://other.invalid';
  assert.throws(() => service.import({ version: 1, settings: input }), { code: 'ORIGIN_CHANGE' });
  delete input.profiles.sample;
  input.slots.llm = null;
  assert.throws(() => service.import({ version: 1, settings: input }), { code: 'ORIGIN_CHANGE' });
  service.secrets.set('orphan', 'https://old.invalid', { apiKey: HEADER });
  const restored = service.export();
  restored.profiles.orphan = { ...profile, baseUrl: 'https://new.invalid' };
  assert.throws(() => service.import({ version: 1, settings: restored }), { code: 'ORIGIN_CHANGE' });
  assert.throws(() => service.putProfile('orphan', requestProfile(service, restored.profiles.orphan)), { code: 'ORIGIN_CHANGE' });
});

test('legacy migration is explicit, names-only, and leaves environment keys in place', t => {
  const defaults = base();
  defaults.profiles.sample = { ...profile, baseUrl: 'REPLACE_WITH_HTTPS_BASE_URL',
    baseUrlEnv: 'EXPLABS_BASE_URL', apiKeyEnv: 'EXPLABS_API_KEY' };
  defaults.slots.llm.modelEnv = 'EXPLABS_MODEL';
  const environment = { EXPLABS_BASE_URL: 'https://migrated.invalid/v1', EXPLABS_MODEL: 'legacy-model', EXPLABS_API_KEY: KEY };
  const { service, root } = fixture(t, { layers: { defaults, dev: {} }, env: environment });
  assert.equal(service.config().profiles.sample.baseUrl, 'REPLACE_WITH_HTTPS_BASE_URL');
  assert.equal(service.legacy().env.includes('EXPLABS_API_KEY'), true);
  assert.equal(JSON.stringify(service.legacy()).includes(KEY), false);
  assert.equal(fs.existsSync(path.join(root, 'settings.json')), false);
  service.importLegacy({ version: 0 });
  assert.equal(service.config().profiles.sample.baseUrl, environment.EXPLABS_BASE_URL);
  assert.equal(service.config().slots.llm.model, environment.EXPLABS_MODEL);
  assert.equal(service.resolver().profileSecrets('sample', service.config().profiles.sample).apiKey, KEY);
  assert.equal(fs.existsSync(path.join(root, 'secrets.dat')), false);
  assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8').includes(KEY), false);
});

test('legacy import preserves explicit developer and settings choices', t => {
  const defaults = base();
  defaults.profiles.sample.baseUrlEnv = 'EXPLABS_BASE_URL';
  defaults.slots.llm.modelEnv = 'EXPLABS_MODEL';
  const { service } = fixture(t, { layers: { defaults, dev: { profiles: { sample: { baseUrl: 'https://dev.invalid' } } } },
    env: { EXPLABS_BASE_URL: 'https://legacy.invalid', EXPLABS_MODEL: 'legacy-model' } });
  service.putSlot('llm', { version: 0, slot: { ...selection, model: 'settings-model' } });
  service.importLegacy({ version: 1 });
  assert.equal(service.config().profiles.sample.baseUrl, 'https://dev.invalid');
  assert.equal(service.config().slots.llm.model, 'settings-model');
});

test('optimistic concurrency across service instances permits exactly one writer', async t => {
  const { service, root } = fixture(t);
  const other = new SettingsService({ repoRoot: root, localDir: root, env: {}, platform: 'linux',
    allowPlaintext: true, layers: { defaults: base(), dev: {} } });
  const results = await Promise.allSettled([Promise.resolve().then(() => service.putUi({ version: 0, ui: { language: 'en' } })),
    Promise.resolve().then(() => other.putUi({ version: 0, ui: { language: 'id' } }))]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.code, 'CONFLICT');
});

test('failed settings write restores previously committed secret bytes', t => {
  const { service, root } = fixture(t);
  service.putSecret('sample', { version: 0, values: { apiKey: KEY } });
  const before = fs.readFileSync(path.join(root, 'secrets.dat'));
  // A wide/deep extension is compact enough for schema validation but exceeds
  // the persisted, indented document limit after a secret write has occurred.
  let extras = Object.fromEntries(Array.from({ length: 64 }, (_, i) => ['field' + i, 'x'.repeat(3)]));
  for (let i = 0; i < 4; i++) extras = { level: extras };
  const large = {};
  for (let i = 0; i < 32; i++) large['entry' + i] = structuredClone(extras);
  assert.throws(() => service.putProfile('sample', requestProfile(service, { ...profile, bodyExtras: large },
    { secrets: { apiKey: REPLACEMENT } })), { code: 'TOO_LARGE' });
  assert.deepEqual(fs.readFileSync(path.join(root, 'secrets.dat')), before);
  assert.equal(service.secrets.get('sample', 'https://example.invalid').apiKey, KEY);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'settings.json'))).version, 1);
});

test('status exposes backend/plaintext, insecure transport, missing slots and first run', t => {
  const defaults = base();
  defaults.profiles.sample.baseUrl = 'http://127.0.0.1:1234/v1';
  const { service } = fixture(t, { layers: { defaults, dev: {} } });
  const status = service.status();
  assert.equal(status.backendName, 'plaintext-file');
  assert.equal(status.firstRun, false);
  assert.equal(status.slots.llm.insecureTransport, true);
  assert.equal(status.warnings.some(value => /plaintext/.test(value)), true);
  service.deleteProfile('sample', { version: 0, force: true });
  assert.equal(service.status().firstRun, true);
});

test('readonly environment backend permits choices and refuses secret persistence', t => {
  const { service } = fixture(t, { allowPlaintext: false });
  service.putUi({ version: 0, ui: { language: 'en' } });
  assert.equal(service.status().backendName, 'env');
  assert.throws(() => service.putSecret('sample', { version: 1, values: { apiKey: KEY } }), { code: 'READ_ONLY' });
  assert.equal(version(service), 1);
});
