import { setTimeout as delay } from 'node:timers/promises';
import { loadSelfieConfig } from '../selfie/config.js';
import { ImageInstallService } from './imageInstallService.js';
import { CLOUD_IMAGE_MODEL, IMAGE_PROVIDERS, validateImageSettings } from './imageFields.js';
import { SettingsError } from './schema.js';

// One coordinator owns file/UI reloads and installation admission leases.
export class ImageSettingsService {
  constructor({ service, manager, repoRoot, env = process.env, installer, loadConfig = loadSelfieConfig } = {}) {
    this.service = service;
    this.manager = manager;
    this.repoRoot = repoRoot;
    this.env = env;
    this.loadConfig = loadConfig;
    this.revision = 0;
    this.appliedVersion = null;
    this.pending = false;
    this.installing = false;
    this.closed = false;
    this.error = null;
    this.controller = new AbortController();
    this.task = null;
    this.installer = installer || new ImageInstallService({ repoRoot, env,
      beforeInstall: context => this.beforeInstall(context),
      afterInstall: context => this.afterInstall(context) });
    service.setImageObserver(() => this.reload(), images => this.compose(images));
  }

  compose(images = this.service.imageOverrides(), overrides = {}) {
    const config = this.loadConfig(overrides, { repoRoot: this.repoRoot, env: this.env, settingsImages: images });
    config.cloudCredentials = this.service.imageCredentialResolver(config.cloud?.accountId);
    return config;
  }

  async status() {
    const config = this.compose();
    const readiness = this.manager.getProviderStatus();
    const provider = IMAGE_PROVIDERS.includes(readiness?.active) ? readiness.active : null;
    return { version: this.service.effective().version, appliedVersion: this.appliedVersion,
      pending: this.pending, error: this.error, ready: Boolean(provider) && !this.pending && !this.installing,
      provider, images: { provider: config.provider, preset: config.preset, comfyuiUrl: config.comfyUrl,
        variant: config.runtimeVariant || 'auto', cloud: { accountId: config.cloud?.accountId || '', model: CLOUD_IMAGE_MODEL } },
      sources: this.service.effective().sources, ...this.service.imageSecretStatus(),
      readiness, installation: await this.installer.latest() };
  }

  reload() {
    if (this.closed) return Promise.resolve();
    this.revision++;
    this.pending = true;
    this.manager.admissionBlocks.add('image-settings');
    if (!this.task) {
      this.task = this.applyPending().catch(() => { this.error = 'RELOAD_FAILED'; }).finally(() => { this.task = null; });
    }
    return this.task;
  }

  async waitIdle(signal = this.controller.signal) {
    while (this.manager.activeJob || this.manager.queue.length || this.manager._runTasks.size) {
      await delay(50, undefined, { signal });
    }
    await this.manager._lastReleasePromise;
    signal.throwIfAborted();
  }

  async applyPending() {
    while (!this.closed && this.pending) {
      await this.waitIdle();
      if (this.installing) return;
      const revision = this.revision;
      const version = this.service.effective().version;
      await this.manager.updateConfig(this.compose());
      if (revision !== this.revision) continue;
      this.appliedVersion = version;
      this.pending = false;
      this.error = null;
      this.manager.admissionBlocks.delete('image-settings');
    }
  }

  async test({ provider, signal } = {}) {
    if (this.installing || this.pending) throw new SettingsError('IN_USE', 409);
    if (provider !== undefined && !IMAGE_PROVIDERS.includes(provider)) throw new SettingsError('INVALID_SETTINGS');
    const config = this.compose(this.service.imageOverrides(), provider ? { provider } : {});
    // A preview check must not alter the manager's selected provider.
    const { ProviderResolver } = await import('../selfie/providerResolver.js');
    const resolver = new ProviderResolver(config, { initializeManaged: null });
    try {
      const result = await resolver.checkReady({ force: true, signal });
      return { ready: result.ready === true, code: result.code, generationTested: false,
        message: result.ready ? 'Koneksi siap. Pembuatan foto belum diuji.'
          : result.publicMessage || 'Generator belum siap. Periksa konfigurasi dan kredensial.' };
    } finally { await resolver.shutdown(); }
  }

  plan(request) {
    validateImageSettings(request);
    return this.installer.plan(request);
  }

  async beforeInstall({ signal }) {
    this.installing = true;
    this.manager.admissionBlocks.add('image-install');
    await this.task;
    await this.waitIdle(signal);
    const provider = this.manager.provider || await this.manager._providerPromise;
    await provider?.shutdown?.();
    this.manager.provider = null;
    this.manager._providerPromise = null;
  }

  async afterInstall() {
    this.installing = false;
    try { await this.reload(); }
    finally { this.manager.admissionBlocks.delete('image-install'); }
  }

  async shutdown() {
    this.closed = true;
    this.controller.abort();
    await this.installer.shutdown();
    await this.task;
  }
}
