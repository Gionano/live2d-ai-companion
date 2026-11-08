import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsService } from '../settings/service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { validateDocument, validateMemorySettings, validateProfile } from '../settings/schema.js';

function fixture(t, defaults = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const service = new SettingsService({ repoRoot: directory, localDir: directory, env: {}, allowPlaintext: true,
    layers: { defaults: { profiles: { chat: { adapter: 'openaiCompatible', baseUrl: 'https://example.invalid/v1' } },
      slots: { llm: { profile: 'chat', model: 'test-chat' } }, ...defaults }, dev: {} } });
  const registry = new ProviderRegistry({ config: service.config(), secretResolver: service.resolver() });
  service.attach(registry);
  return { service, registry, directory };
}

test('older settings receive optional memory roles and local runtime defaults', t => {
  const { service, registry } = fixture(t);
  assert.deepEqual(service.config().memory, { managedEmbedding: true, embeddingDevice: 'auto' });
  assert.deepEqual(service.config().slots.memoryWriter, { followLlm: true });
  assert.equal(service.config().slots.memoryEmbedding.profile, 'localBge');
  assert.equal(service.config().slots.memoryEmbedding.model, 'bge-m3-d768');
  assert.equal(service.config().profiles.localBge.adapter, 'localEmbedding');
  assert.equal(registry.getSlotStatus('memoryEmbedding').available, true);
  assert.equal(registry.getSlotStatus('memoryWriter').model, 'test-chat');
  assert.equal(service.effective().sources['memory.managedEmbedding'], 'default');
  assert.equal(service.status().firstRun, false);
});

test('default memory embedding assignment does not complete the first-run wizard', t => {
  const { service } = fixture(t, { slots: { llm: null } });
  assert.equal(service.status().firstRun, true);
});

test('memory runtime selection persists atomically with settings version checks', t => {
  const { service, directory } = fixture(t);
  const version = service.effective().version;
  assert.equal(service.putMemory({ version, memory: { managedEmbedding: false, embeddingDevice: 'cpu' } }).version, version + 1);
  assert.deepEqual(service.config().memory, { managedEmbedding: false, embeddingDevice: 'cpu' });
  assert.equal(service.effective().sources['memory.embeddingDevice'], 'settings');
  assert.throws(() => service.putMemory({ version, memory: { managedEmbedding: true } }), { code: 'CONFLICT' });
  const recreated = new SettingsService({ localDir: directory, repoRoot: directory, env: {}, allowPlaintext: true,
    layers: { defaults: {}, dev: {} } });
  assert.deepEqual(recreated.config().memory, { managedEmbedding: false, embeddingDevice: 'cpu' });
});

test('explicit disabled memory roles survive refresh and export/import', t => {
  const { service } = fixture(t);
  service.putSlot('memoryWriter', { version: 0, slot: null });
  service.putSlot('memoryEmbedding', { version: 1, slot: null });
  service.refresh();
  assert.equal(service.config().slots.memoryWriter, null);
  assert.equal(service.config().slots.memoryEmbedding, null);
  const exported = service.export();
  assert.equal(exported.slots.memoryWriter, null);
  assert.equal(exported.slots.memoryEmbedding, null);
  service.import({ version: 2, settings: exported });
  assert.equal(service.config().slots.memoryWriter, null);
  assert.equal(service.config().slots.memoryEmbedding, null);
});

test('older imported documents receive memory defaults without becoming memory archives', t => {
  const { service } = fixture(t);
  service.import({ version: 0, settings: { schemaVersion: 1,
    profiles: { chat: { adapter: 'openaiCompatible', baseUrl: 'https://example.invalid/v1' } },
    slots: { llm: { profile: 'chat', model: 'test-chat' } }, ui: { language: 'id' } } });
  assert.deepEqual(service.config().slots.memoryWriter, { followLlm: true });
  assert.equal(service.config().slots.memoryEmbedding.model, 'bge-m3-d768');
  const exported = service.export();
  assert.deepEqual(exported.memory, { managedEmbedding: true, embeddingDevice: 'auto' });
  assert.equal(Object.hasOwn(exported.memory, 'events'), false);
  assert.equal(Object.hasOwn(exported.memory, 'facts'), false);
  assert.equal(Object.hasOwn(exported, 'jobs'), false);
});

test('memory schema rejects transcript import, commands, arbitrary devices and nonlocal embedding endpoints', () => {
  for (const value of [{ events: [] }, { command: 'install' }, { managedEmbedding: 'yes' }, { embeddingDevice: 'vulkan' }]) {
    assert.throws(() => validateMemorySettings(value), { code: 'INVALID_SETTINGS' });
  }
  assert.throws(() => validateDocument({ schemaVersion: 1, profiles: {}, slots: {}, ui: { language: 'id' }, memory: { facts: [] } }), { code: 'INVALID_SETTINGS' });
  assert.throws(() => validateProfile({ adapter: 'localEmbedding', baseUrl: 'http://192.168.1.10:8011' }), { code: 'INVALID_SETTINGS' });
  assert.equal(validateProfile({ adapter: 'localEmbedding', baseUrl: 'http://127.0.0.1:8011', capabilities: { embeddings: true } }).profile.adapter, 'localEmbedding');
});
