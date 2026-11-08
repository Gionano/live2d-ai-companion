import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MemoryEmbeddingRuntime } from '../memoryEmbeddingRuntime.js';
import { ProviderRegistry } from '../providers/registry.js';
import { DEFAULT_CONFIG } from '../providers/config.js';
import { createLocalPaths } from '../selfie/localPaths.js';

const health = { ok: true, model: 'bge-m3-d768', dimensions: 768, device: 'cpu', revision: 'a'.repeat(40) };
const network = () => Object.assign(new Error(), { code: 'NETWORK' });
function fixture(t, overrides = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-runtime-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const paths = createLocalPaths({ repoRoot, env: {} });
  fs.mkdirSync(paths.runtimeDir('memory'), { recursive: true });
  const registry = new ProviderRegistry({ config: structuredClone(DEFAULT_CONFIG) });
  let config = { managedEmbedding: true, embeddingDevice: 'auto' };
  const installed = { valid: true, pythonPath: 'fixture-python', servicePath: 'fixture-service.py',
    modelDir: 'fixture-model', marker: { modelRevision: 'a'.repeat(40) },
    processPath: path.join(paths.runtimeDir('memory'), 'process.json') };
  const children = [];
  const kills = [];
  const starts = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter(); child.pid = 900000 + children.length;
    child.kill = signal => { kills.push(signal); child.signalCode = signal; queueMicrotask(() => child.emit('exit')); return true; };
    children.push(child); starts.push({ command, args, options }); return child;
  };
  const runtime = new MemoryEmbeddingRuntime({ registry, paths, getConfig: () => config,
    inspect: () => installed, verify: async () => installed, acquireLock: async () => async () => {},
    spawnProcess, pollMs: 1, startupTimeoutMs: 100, ...overrides });
  t.after(() => runtime.dispose());
  return { runtime, registry, paths, installed, children, kills, starts, setConfig: value => { config = value; } };
}

test('runtime reuses a compatible external embedder and never owns or kills it', async t => {
  const context = fixture(t, { probe: async () => health });
  assert.equal(context.runtime.status().state, 'not_started');
  assert.equal((await context.runtime.start()).state, 'external');
  assert.equal(context.children.length, 0);
  await context.runtime.dispose();
  assert.deepEqual(context.kills, []);
});

test('runtime startup uses cached verified paths with offline environment and hidden window', async t => {
  let calls = 0;
  const context = fixture(t, { probe: async () => { if (++calls === 1) throw network(); return health; } });
  const status = await context.runtime.start();
  assert.equal(status.ready, true);
  assert.equal(status.state, 'running');
  assert.equal(context.starts[0].options.windowsHide, true);
  assert.equal(context.starts[0].options.env.HF_HUB_OFFLINE, '1');
  assert.equal(context.starts[0].args.includes('--download'), false);
  assert.equal(context.starts[0].args.at(-1), 'a'.repeat(40));
  assert.equal(fs.existsSync(context.installed.processPath), true);
  await context.runtime.dispose();
  assert.deepEqual(context.kills, ['SIGTERM']);
  assert.equal(fs.existsSync(context.installed.processPath), false);
});

test('uninstalled service never spawns or downloads', async t => {
  const context = fixture(t, { probe: async () => { throw network(); },
    inspect: () => ({ valid: false, code: 'MEMORY_SETUP_REQUIRED' }) });
  assert.equal((await context.runtime.start()).state, 'setup_required');
  assert.equal(context.children.length, 0);
});

test('incompatible occupied port remains untouched', async t => {
  const context = fixture(t, { probe: async () => { throw Object.assign(new Error(), { code: 'BAD_RESPONSE' }); } });
  assert.equal((await context.runtime.start()).reason, 'INCOMPATIBLE_EMBEDDING_SERVICE');
  assert.equal(context.children.length, 0);
});

test('external-only mode and explicit null prevent managed startup', async t => {
  const context = fixture(t, { probe: async () => { throw network(); } });
  context.setConfig({ managedEmbedding: false, embeddingDevice: 'cpu' });
  assert.equal((await context.runtime.start()).reason, 'EMBEDDING_OFFLINE');
  context.registry.config.slots.memoryEmbedding = null;
  assert.equal((await context.runtime.reconcile()).state, 'disabled');
  assert.equal(context.children.length, 0);
});

test('late startup verification is rejected after provider selection changes', async t => {
  let release;
  const context = fixture(t, { probe: async () => { throw network(); },
    verify: () => new Promise(resolve => { release = resolve; }) });
  const pending = context.runtime.start();
  await new Promise(resolve => setTimeout(resolve, 0));
  context.registry.config.slots.memoryEmbedding = null;
  await context.runtime.reconcile();
  release(context.installed);
  await pending;
  assert.equal(context.runtime.status().state, 'disabled');
  assert.equal(context.children.length, 0);
});

test('device changes stop an owned child and launch the current configuration', async t => {
  let context;
  const available = new Set();
  context = fixture(t, { probe: async () => {
    const current = context?.children.at(-1);
    if (!current || current.signalCode) throw network();
    return { ...health, device: available.has('cpu') ? 'cpu' : 'cuda' };
  } });
  assert.equal((await context.runtime.start()).device, 'cuda');
  context.setConfig({ managedEmbedding: true, embeddingDevice: 'cpu' });
  available.add('cpu');
  assert.equal((await context.runtime.reconcile()).device, 'cpu');
  assert.equal(context.children.length, 2);
  assert.deepEqual(context.kills, ['SIGTERM']);
  assert.ok(context.starts[1].args.includes('cpu'));
});

test('startup timeout cleans up only its owned process and can retry explicitly', async t => {
  const context = fixture(t, { probe: async () => { throw network(); }, startupTimeoutMs: 5 });
  assert.equal((await context.runtime.start()).reason, 'EMBEDDING_START_TIMEOUT');
  assert.equal(context.runtime.child, null);
  assert.equal(fs.existsSync(context.installed.processPath), false);
  context.runtime.probe = async () => health;
  assert.equal((await context.runtime.retry()).state, 'external');
});

test('status is non-probing and full hash failure blocks startup', async t => {
  let probes = 0;
  const context = fixture(t, { probe: async () => { probes++; throw network(); },
    verify: async () => ({ valid: false, code: 'MEMORY_INSTALL_INVALID' }) });
  context.runtime.status(); context.runtime.status();
  assert.equal(probes, 0);
  assert.equal((await context.runtime.start()).reason, 'MEMORY_INSTALL_INVALID');
  assert.equal(context.children.length, 0);
});

test('same model tag with a different immutable revision cannot become ready', async t => {
  let calls = 0;
  const context = fixture(t, { probe: async () => {
    if (++calls === 1) throw network();
    return { ...health, revision: 'b'.repeat(40) };
  } });
  assert.equal((await context.runtime.start()).ready, false);
  assert.equal(context.runtime.status().reason, 'BAD_RESPONSE');
  assert.deepEqual(context.kills, ['SIGTERM']);
});

test('unchanged service after registry reload retains its observed revision without a probe', async t => {
  let calls = 0;
  const context = fixture(t, { probe: async () => { calls++; return health; } });
  await context.runtime.start();
  context.registry.reload(structuredClone(DEFAULT_CONFIG));
  const replacement = context.registry.getEmbedding();
  assert.equal(replacement.revision, undefined);
  assert.equal((await context.runtime.reconcile()).ready, true);
  assert.equal(replacement.revision, health.revision);
  assert.equal(calls, 1);
});

test('capability or adapter changes cannot retain cached-ready state', async t => {
  const context = fixture(t, { probe: async () => health });
  await context.runtime.start();
  context.registry.config.profiles.localBge.capabilities = { embeddings: false };
  context.registry.config.profiles.localBge.models['bge-m3-d768'].capabilities.embeddings = false;
  assert.equal((await context.runtime.reconcile()).ready, false);
  assert.equal(context.runtime.status().state, 'disabled');
  delete context.registry.config.profiles.localBge.capabilities;
  context.registry.config.profiles.localBge.models['bge-m3-d768'].capabilities.embeddings = true;
  await context.runtime.reconcile();
  context.registry.config.profiles.localBge.adapter = 'openaiCompatible';
  context.registry.config.profiles.localBge.capabilities = { embeddings: true };
  assert.equal((await context.runtime.reconcile()).ready, false);
  assert.equal(context.runtime.status().state, 'disabled');
});
