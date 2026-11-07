import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsService } from '../settings/service.js';
import { emptySettings, validateDocument } from '../settings/schema.js';
import { CLOUD_IMAGE_MODEL, validateImageSettings } from '../settings/imageFields.js';
import { loadSelfieConfig } from '../selfie/config.js';
import { ImageSettingsService } from '../settings/imageSettingsService.js';
import { JobManager } from '../selfie/jobManager.js';

const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'private-cloudflare-fixture-token-12345';
function fixture(t, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new SettingsService({ repoRoot: root, localDir: path.join(root, 'local'), env,
    platform: 'linux', allowPlaintext: true, layers: { defaults: { profiles: {}, slots: {} }, dev: {} } });
  return { root, service };
}
function coordinator(t, service, extra = {}) {
  const updates = [];
  const manager = { config: {}, admissionBlocks: new Set(), queue: [], activeJob: null, _runTasks: new Set(),
    getProviderStatus: () => ({ active: 'cloud', reasons: {} }),
    async updateConfig(config) { updates.push(config); this.config = config; } };
  const installer = { latest: () => null, shutdown: async () => {} };
  const settings = new ImageSettingsService({ service, manager, installer,
    loadConfig: (overrides, options) => ({ provider: 'auto', preset: 'cepat', comfyUrl: 'http://localhost:8000',
      ...options.settingsImages, ...overrides }), ...extra });
  t.after(() => settings.shutdown());
  return { settings, manager, updates };
}

test('legacy documents remain valid and image schema rejects execution fields', () => {
  assert.deepEqual(validateDocument(emptySettings(), { persisted: true }), emptySettings());
  for (const bad of [{ provider: 'auto' }, { args: ['--cpu'] }, { variant: 'cpu' },
    { cloud: { accountId: [ACCOUNT] } }, { cloud: { token: TOKEN } }, { cloud: { model: 'another' } },
    { comfyuiUrl: 'file:///private' }, { downloadUrl: 'https://example.invalid' }]) {
    assert.throws(() => validateImageSettings(bad), { code: 'INVALID_SETTINGS' });
  }
});

test('image settings persist, export/import, reset, and preserve version conflicts', t => {
  const { root, service } = fixture(t);
  const images = { provider: 'cloud', cloud: { accountId: ACCOUNT, model: CLOUD_IMAGE_MODEL } };
  service.putImages({ version: 0, images });
  assert.equal(service.effective().sources['images.provider'], 'settings');
  assert.throws(() => service.putImages({ version: 0, images }), { code: 'CONFLICT' });
  assert.deepEqual(service.export().images, images);
  const restarted = new SettingsService({ repoRoot: root, localDir: path.join(root, 'local'), env: {},
    platform: 'linux', allowPlaintext: true, layers: { defaults: { profiles: {}, slots: {} }, dev: {} } });
  assert.deepEqual(restarted.imageOverrides(), images);
  service.import({ version: 1, settings: service.export() });
  assert.deepEqual(service.imageOverrides(), images);
  service.putImages({ version: 2, images: {} });
  assert.deepEqual(service.imageOverrides(), {});
});

test('cloud secrets remain private, versioned, and immutable for admitted work', async t => {
  const { root, service } = fixture(t);
  service.putImages({ version: 0, images: { provider: 'cloud', cloud: { accountId: ACCOUNT } } });
  service.putImageSecret({ version: 1, key: TOKEN });
  const original = service.imageCredentialResolver();
  assert.equal((await original()).token, TOKEN);
  assert.equal(service.imageSecretStatus().hasKey, true);
  assert.equal(JSON.stringify([service.effective(), service.config(), service.export(), service.status()]).includes(TOKEN), false);
  assert.equal(fs.readFileSync(path.join(root, 'local', 'settings.json'), 'utf8').includes(TOKEN), false);
  service.putImageSecret({ version: 2, key: 'replacement-private-fixture-token' });
  assert.equal((await original()).token, TOKEN);
  service.deleteImageSecret({ version: 3 });
  assert.equal(service.imageSecretStatus().hasKey, false);
  assert.throws(() => service.putSecret('pap-cloudflare', { version: 4, values: { apiKey: TOKEN } }), { code: 'INVALID_SETTINGS' });
});

test('environment cloud credentials are redacted and retain priority', async t => {
  const { service } = fixture(t, { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
  service.putImageSecret({ version: 0, key: 'stored-private-fixture-token' });
  assert.equal((await service.imageCredentialResolver()()).token, TOKEN);
  assert.equal(service.imageSecretStatus().source, 'env');
  assert.equal(JSON.stringify(service.effective()).includes(TOKEN), false);
});

test('saved image selections override files while explicit CLI options win', t => {
  const { root, service } = fixture(t);
  fs.writeFileSync(path.join(root, 'selfie.config.json'), JSON.stringify({ provider: 'comfyui' }));
  fs.writeFileSync(path.join(root, 'selfie.config.local.json'), JSON.stringify({ provider: 'sdcpp' }));
  const options = { repoRoot: root, env: { WAIFU_LOCAL_DIR: path.join(root, 'local') } };
  assert.equal(loadSelfieConfig({}, options).provider, 'sdcpp');
  service.putImages({ version: 0, images: { provider: 'cloud', cloud: { accountId: ACCOUNT } } });
  assert.equal(loadSelfieConfig({}, options).provider, 'cloud');
  assert.equal(loadSelfieConfig({ provider: 'comfyui-managed' }, options).provider, 'comfyui-managed');
  assert.equal(loadSelfieConfig({}, { ...options, settingsImages: {} }).provider, 'sdcpp');
});

test('CLI cloud config reuses the saved backend token without exposing it publicly', async t => {
  const { root, service } = fixture(t);
  service.putImages({ version: 0, images: { provider: 'cloud', cloud: { accountId: ACCOUNT } } });
  service.putImageSecret({ version: 1, key: TOKEN });
  const config = loadSelfieConfig({}, { repoRoot: root,
    env: { WAIFU_LOCAL_DIR: path.join(root, 'local'), WAIFU_ALLOW_PLAINTEXT_SECRETS: '1' } });
  assert.equal((await config.cloudCredentials()).token, TOKEN);
  assert.equal(JSON.stringify(config).includes(TOKEN), false);
});

test('provider changes wait for admitted jobs and apply the latest selection', async t => {
  const { service } = fixture(t);
  const { settings, manager, updates } = coordinator(t, service);
  manager.activeJob = { jobId: 'original' };
  service.putImages({ version: 0, images: { provider: 'comfyui' } });
  const pending = settings.task;
  service.putImages({ version: 1, images: { provider: 'cloud' } });
  assert.equal((await settings.status()).pending, true);
  assert.equal((await settings.status()).ready, false);
  assert.equal(manager.admissionBlocks.has('image-settings'), true);
  assert.equal(updates.length, 0);
  manager.activeJob = null;
  await pending;
  assert.equal(updates.length, 1);
  assert.equal(updates[0].provider, 'cloud');
  assert.equal(settings.appliedVersion, 2);
  assert.equal(settings.pending, false);
  assert.equal(manager.admissionBlocks.size, 0);
});

test('installation waits for cleanup and shuts down only the owned provider', async t => {
  const { service } = fixture(t);
  const { settings, manager, updates } = coordinator(t, service);
  let stopped = 0;
  manager.provider = { shutdown: async () => { stopped++; } };
  let release;
  manager._lastReleasePromise = new Promise(resolve => { release = resolve; });
  const before = settings.beforeInstall({ signal: new AbortController().signal });
  assert.equal(manager.admissionBlocks.has('image-install'), true);
  assert.equal(stopped, 0);
  release(); await before;
  assert.equal(stopped, 1);
  assert.equal(manager.provider, null);
  await settings.afterInstall();
  assert.equal(updates.length, 1);
  assert.equal(manager.admissionBlocks.size, 0);
});

test('PAP admission is synchronously blocked during settings and installation changes', () => {
  const manager = new JobManager({ limitsStorePath: null, cooldownMs: 0, dailyLimit: 20, maxQueue: 1, phrases: {} });
  manager.admissionBlocks.add('image-install');
  assert.equal(manager.tryAdmit().reason, 'BUSY');
  assert.equal(manager.activeJob, null);
  manager.admissionBlocks.delete('image-install');
  assert.equal(manager.tryAdmit().allowed, true);
});
