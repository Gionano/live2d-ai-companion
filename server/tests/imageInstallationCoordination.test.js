import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobManager } from '../selfie/jobManager.js';
import { ProviderResolver } from '../selfie/providerResolver.js';
import { ImageSettingsService } from '../settings/imageSettingsService.js';
import { ImageInstallService } from '../settings/imageInstallService.js';
import { licenseKey } from '../../setup/install.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function deadline(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Coordination did not complete.')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pap-setup-queue-'));
  const localDir = path.join(root, 'local');
  const outputDir = path.join(root, 'output');
  await fs.mkdir(outputDir);
  const config = { provider: 'sdcpp', localDir, rootDir: root, outputDir, limitsStorePath: null,
    maxQueue: 2, cooldownMs: 0, dailyLimit: 20, freeVramAfter: true, preset: 'cepat', phrases: {},
    etaStorePath: path.join(root, 'durations.json'), etaHistorySize: 5,
    presets: { cepat: { resolution: 768, steps: 12, cfg: 3 } } };
  const gates = [deferred(), deferred()];
  const started = [deferred(), deferred()];
  const cleanupStarted = deferred();
  const cleanup = deferred();
  const events = [];
  const generationProviders = [];
  const order = [];
  let generations = 0;
  let releases = 0;
  const engine = {
    checkReady: async () => ({ ready: true, code: 'READY' }),
    async generate(_params, _progress, signal, onStarted) {
      const index = generations++;
      generationProviders.push('sdcpp');
      onStarted();
      started[index].resolve();
      await gates[index].promise;
      signal.throwIfAborted();
      const imagePath = path.join(outputDir, `${index}.png`);
      await fs.writeFile(imagePath, 'fixture image');
      order.push(`generated-${index}`);
      return { imagePath, seed: index };
    },
    async release() {
      releases++;
      if (releases === 2) {
        cleanupStarted.resolve();
        await cleanup.promise;
      }
      order.push(`cleanup-${releases}`);
    },
    async cancel() {},
    async shutdown() { order.push('owned-provider-stopped'); },
  };
  const manager = new JobManager(config);
  manager.setBroadcaster(event => events.push(event));
  manager.getProvider = async () => {
    manager.provider ||= new ProviderResolver(manager.config, { initializeManaged: null,
      createProvider: async name => name === 'sdcpp' ? engine : {
        checkReady: async () => ({ ready: true, code: 'READY' }), shutdown: async () => {},
      } });
    return manager.provider;
  };
  let images = { provider: 'sdcpp' };
  let version = 1;
  const service = { imageOverrides: () => ({ ...images }),
    imageCredentialResolver: () => async () => ({}), imageSecretStatus: () => ({ hasKey: false }),
    effective: () => ({ version, sources: {} }), setImageObserver() {} };
  const component = { id: 'sd-cli:vulkan', name: 'Fixture runtime', sha256: 'a'.repeat(64), sizeBytes: 7,
    destination: 'runtime/sdcpp/vulkan', variant: 'vulkan', engines: ['sdcpp'], role: 'runtime',
    url: 'https://example.invalid/runtime.zip', licenseName: 'Fixture license', licenseUrl: 'https://example.invalid/license',
    installed: false, status: 'missing' };
  const plan = { components: [component], downloadBytes: 7, requiredDiskBytes: 14, freeBytes: 1000,
    licenses: [{ key: licenseKey(component), name: component.licenseName, url: component.licenseUrl, accepted: false }],
    blockers: [], fingerprint: 'pinned-fixture', variant: 'vulkan', hardware: { gpuVendor: 'any' } };
  let settings;
  let installations = 0;
  const installer = new ImageInstallService({ repoRoot: root, env: {}, platform: 'win32',
    beforeInstall: context => settings.beforeInstall(context), afterInstall: context => settings.afterInstall(context),
    dependencies: { createSetupPlan: async () => plan, runSetup: async () => {
      installations++;
      order.push('installation');
      assert.equal(manager.activeJob, null);
      assert.equal(manager.queue.length, 0);
      assert.equal(releases, 2);
    } } });
  settings = new ImageSettingsService({ service, manager, installer, repoRoot: root, env: {},
    loadConfig: (overrides, options) => ({ ...config, ...options.settingsImages, ...overrides }) });
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    cleanup.resolve();
    await settings.shutdown();
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, localDir, manager, settings, installer, gates, started, cleanup, cleanupStarted,
    events, order, generationProviders, get installations() { return installations; },
    changeProvider(provider) { images = { provider }; version++; return settings.reload(); } };
}

const plan = { slots: {}, caption: 'Foto untuk kamu.', positivePrompt: 'fixture portrait', referenceImage: 'default.jpg' };

test('reviewed UI setup and pending settings preserve both admitted PAP jobs and wait for cleanup', async t => {
  const f = await fixture(t);
  const first = await f.manager.submitJob({ plan, skipInitialSpeech: true });
  await deadline(f.started[0].promise);
  const second = await f.manager.submitJob({ plan, skipInitialSpeech: true });
  assert.equal(second.queued, true);
  const reviewed = await f.installer.plan({ provider: 'sdcpp' });
  const changed = f.changeProvider('cloud');
  const setup = await f.installer.start({ planId: reviewed.planId, acceptedLicenses: reviewed.licenses.map(license => license.key) });
  const finished = f.installer.running;
  assert.equal(setup.state, 'queued');
  assert.equal(f.installations, 0);
  assert.equal((await f.settings.status()).pending, true);
  f.gates[0].resolve();
  await deadline(f.started[1].promise);
  assert.equal(f.installations, 0);
  f.gates[1].resolve();
  await deadline(f.cleanupStarted.promise);
  assert.equal(f.installations, 0);
  f.cleanup.resolve();
  await deadline(finished);
  await changed;
  assert.deepEqual(f.events.filter(event => event.type === 'selfie_ready').map(event => event.jobId), [first.jobId, second.jobId]);
  assert.equal(f.events.some(event => ['selfie_failed', 'selfie_cancelled'].includes(event.type)), false);
  assert.deepEqual(f.generationProviders, ['sdcpp', 'sdcpp']);
  assert.ok(f.order.indexOf('installation') > f.order.indexOf('cleanup-2'));
  assert.equal(f.installations, 1);
  assert.equal((await f.installer.get(setup.id)).state, 'completed');
  assert.equal(f.manager.config.provider, 'cloud');
  assert.equal(f.settings.appliedVersion, 2);
  assert.equal(f.manager.admissionBlocks.size, 0);
  assert.equal(await fs.stat(path.join(f.localDir, 'runtime.lock')).catch(() => null), null);
  assert.equal(await fs.stat(path.join(f.localDir, 'setup.lock')).catch(() => null), null);
});

test('cancelling a setup waiting behind PAP preserves the existing queue and does not install', async t => {
  const f = await fixture(t);
  const first = await f.manager.submitJob({ plan, skipInitialSpeech: true });
  await deadline(f.started[0].promise);
  const second = await f.manager.submitJob({ plan, skipInitialSpeech: true });
  const reviewed = await f.installer.plan({ provider: 'sdcpp' });
  const setup = await f.installer.start({ planId: reviewed.planId, acceptedLicenses: reviewed.licenses.map(license => license.key) });
  const finished = f.installer.running;
  await f.installer.cancel(setup.id);
  f.gates[0].resolve();
  await deadline(f.started[1].promise);
  f.gates[1].resolve();
  await deadline(f.cleanupStarted.promise);
  f.cleanup.resolve();
  await deadline(finished);
  assert.deepEqual(f.events.filter(event => event.type === 'selfie_ready').map(event => event.jobId), [first.jobId, second.jobId]);
  assert.equal(f.events.some(event => ['selfie_failed', 'selfie_cancelled'].includes(event.type)), false);
  assert.equal(f.installations, 0);
  assert.equal((await f.installer.get(setup.id)).state, 'cancelled');
  assert.equal(f.manager.admissionBlocks.size, 0);
});

test('cancelling an unsubmitted queued reservation releases the lease retained by its completed predecessor', async t => {
  const f = await fixture(t);
  await f.manager.submitJob({ plan, skipInitialSpeech: true });
  await deadline(f.started[0].promise);
  const planning = f.manager.tryAdmit();
  assert.equal(planning.allowed, true);
  const running = [...f.manager._runTasks];
  f.gates[0].resolve();
  await deadline(Promise.all(running));
  assert.equal(f.manager.activeJob.jobId, planning.jobId);
  assert.equal(f.manager.activeJob.running, false);
  await f.manager.cancelJob(planning.jobId);
  assert.equal(f.manager.activeJob, null);
  assert.equal(f.manager.queue.length, 0);
  assert.equal(await fs.stat(path.join(f.localDir, 'runtime.lock')).catch(() => null), null);
  assert.equal(f.manager.admissionBlocks.size, 0);
});

test('refunding an invalid queued plan releases the lease retained by its completed predecessor', async t => {
  const f = await fixture(t);
  await f.manager.submitJob({ plan, skipInitialSpeech: true });
  await deadline(f.started[0].promise);
  const planning = f.manager.tryAdmit();
  const running = [...f.manager._runTasks];
  f.gates[0].resolve();
  await deadline(Promise.all(running));
  const rejected = await f.manager.submitJob({ plan: { caption: '' }, admission: planning });
  assert.equal(rejected.reason, 'INVALID_PLAN');
  await deadline(f.manager._runtimeReleaseTask);
  assert.equal(f.manager.activeJob, null);
  assert.equal(f.manager.queue.length, 0);
  assert.equal(await fs.stat(path.join(f.localDir, 'runtime.lock')).catch(() => null), null);
  assert.equal(f.manager.admissionBlocks.size, 0);
});
