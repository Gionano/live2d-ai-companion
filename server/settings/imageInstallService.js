import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLocalPaths } from '../selfie/localPaths.js';
import { assertContained, createSetupPlan, runSetup, licenseKey } from '../../setup/install.js';
import { acquireSetupLock, acquireSetupReservation, assertRuntimeIdle } from '../../setup/setupLock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const fail = (code, message) => Object.assign(new Error(message), { code });
const clone = value => value ? structuredClone(value) : null;

/** Durable, single-flight setup jobs. Only server-reviewed plans can execute. */
export class ImageInstallService {
  constructor({ repoRoot = ROOT, env = process.env, manifestPath, platform = process.platform,
    beforeInstall = async () => {}, afterInstall = async () => {}, dependencies = {}, now = Date.now } = {}) {
    this.options = { repoRoot, env, ...(manifestPath && { manifestPath }), platform, dependencies };
    this.paths = createLocalPaths({ repoRoot, env });
    this.journalPath = assertContained(this.paths.localDir, path.join(this.paths.localDir, 'image-install-job.json'));
    this.beforeInstall = beforeInstall;
    this.afterInstall = afterInstall;
    this.now = now;
    this.plans = new Map();
    this.job = null;
    this.controller = null;
    this.running = null;
    this.writes = Promise.resolve();
    this.closed = false;
    this.initialized = this._recover();
  }

  async _recover() {
    let record;
    try { record = JSON.parse(await fs.readFile(this.journalPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw fail('STORAGE', 'Installation journal cannot be read.'); }
    if (record.schemaVersion !== 1 || !record.job || !/^[a-f0-9-]{36}$/.test(record.job.id || '') ||
      !['comfyui-managed', 'sdcpp'].includes(record.job.provider) ||
      !['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted'].includes(record.job.state)) {
      throw fail('STORAGE', 'Installation journal has invalid metadata.');
    }
    this.job = record.job;
    if (ACTIVE.has(this.job.state)) {
      this.job.state = 'interrupted';
      this.job.phase = 'interrupted';
      this.job.error = { code: 'INTERRUPTED', message: 'Setup was interrupted by a backend restart. Review the plan and retry to resume downloaded files.' };
      await this._persist();
    }
  }

  _persist() {
    const snapshot = JSON.stringify({ schemaVersion: 1, job: this.job }, null, 2) + '\n';
    const write = async () => {
      await fs.mkdir(this.paths.localDir, { recursive: true });
      const temporary = assertContained(this.paths.localDir, `${this.journalPath}.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, snapshot, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, this.journalPath);
      } finally { await fs.rm(temporary, { force: true }); }
    };
    this.writes = this.writes.then(write);
    return this.writes;
  }

  _update(values, { persist = true } = {}) {
    Object.assign(this.job, values, { updatedAt: new Date(this.now()).toISOString() });
    if (persist) return this._persist();
    return Promise.resolve();
  }

  async plan(input = {}) {
    await this.initialized;
    if (this.closed) throw fail('IN_USE', 'Installation service is stopping.');
    if (Object.keys(input).some(key => !['provider', 'variant'].includes(key)) ||
      !['comfyui-managed', 'sdcpp'].includes(input.provider) ||
      input.variant !== undefined && !['cuda12', 'vulkan'].includes(input.variant)) {
      throw fail('INVALID_SETTINGS', 'Only managed ComfyUI and sd.cpp have downloadable setup plans.');
    }
    const engine = input.provider === 'comfyui-managed' ? 'comfyui' : 'sdcpp';
    const internal = await (this.options.dependencies.createSetupPlan || createSetupPlan)({ ...this.options, engine, variant: input.variant });
    const planId = randomUUID();
    const result = { planId, provider: input.provider, variant: internal.variant, hardware: internal.hardware,
      components: internal.components.map(component => ({ id: component.id, name: component.name, sizeBytes: component.sizeBytes,
        installed: component.installed, status: component.status, licenseKey: licenseKey(component),
        licenseName: component.licenseName, licenseUrl: component.licenseUrl })),
      downloadBytes: internal.downloadBytes, requiredDiskBytes: internal.requiredDiskBytes, freeBytes: internal.freeBytes,
      licenses: internal.licenses, blockers: internal.blockers };
    this.plans.set(planId, { input: { provider: input.provider, ...(input.variant && { variant: input.variant }) },
      engine, internal, result, createdAt: this.now() });
    while (this.plans.size > 16) this.plans.delete(this.plans.keys().next().value);
    return clone(result);
  }

  async start(input = {}) {
    await this.initialized;
    if (this.closed) throw fail('IN_USE', 'Installation service is stopping.');
    if (Object.keys(input).some(key => !['planId', 'acceptedLicenses'].includes(key)) ||
      !Array.isArray(input.acceptedLicenses) || input.acceptedLicenses.length > 32 ||
      input.acceptedLicenses.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))) {
      throw fail('INVALID_SETTINGS', 'Installation requires a reviewed plan and its license acceptance keys.');
    }
    if (this.running || this.job && ACTIVE.has(this.job.state)) throw fail('IN_USE', 'An installation is already active.');
    const reviewed = this.plans.get(input.planId);
    if (!reviewed || this.now() - reviewed.createdAt > 15 * 60 * 1000) throw fail('CONFLICT', 'Setup plan expired. Review the plan again.');
    if (reviewed.internal.blockers.length) throw fail('UNSUPPORTED', 'Setup plan has unresolved prerequisites or metadata.');
    const available = new Set(reviewed.internal.licenses.map(license => license.key));
    if (input.acceptedLicenses.some(key => !available.has(key)) || reviewed.internal.licenses.some(license => !license.accepted && !input.acceptedLicenses.includes(license.key))) {
      throw fail('INVALID_SETTINGS', 'Accept every license displayed in the reviewed plan.');
    }
    const release = await acquireSetupReservation(this.paths.localDir);
    try {
      // File/manifest changes after review cannot silently alter the installation.
      const fresh = await (this.options.dependencies.createSetupPlan || createSetupPlan)({ ...this.options, engine: reviewed.engine, variant: reviewed.input.variant });
      if (fresh.fingerprint !== reviewed.internal.fingerprint || fresh.blockers.length ||
        JSON.stringify(fresh.components.map(c => [c.id, c.installed])) !== JSON.stringify(reviewed.internal.components.map(c => [c.id, c.installed]))) {
        throw fail('CONFLICT', 'Setup changed after review. Review the plan again.');
      }
      this.controller = new AbortController();
      const startedAt = new Date(this.now()).toISOString();
      this.job = { id: randomUUID(), state: 'queued', phase: 'waiting', provider: reviewed.input.provider,
        variant: fresh.variant, componentId: null, component: null, downloadedBytes: 0, totalBytes: fresh.downloadBytes,
        error: null, startedAt, updatedAt: startedAt };
      await this._persist();
      this.plans.delete(input.planId);
      const result = clone(this.job);
      this.running = this._run(reviewed, fresh, release).finally(() => { this.running = null; this.controller = null; });
      this.running.catch(() => {});
      return result;
    } catch (error) { await release(); throw error; }
  }

  async _run(reviewed, fresh, release) {
    const signal = this.controller.signal;
    let state = 'failed';
    let lastPersist = 0;
    let releasePublication;
    try {
      await this.beforeInstall({ provider: reviewed.input.provider, signal });
      signal.throwIfAborted();
      releasePublication = await acquireSetupLock(this.paths.localDir, { signal });
      await assertRuntimeIdle(this.paths.localDir, { repoRoot: this.options.repoRoot });
      await this._update({ state: 'running', phase: 'preparing' });
      const acceptedNames = fresh.licenses.map(license => license.name);
      await (this.options.dependencies.runSetup || runSetup)('plan', { ...this.options,
        engine: reviewed.engine, variant: fresh.variant || undefined, installPlan: true, leaseHeld: true,
        yes: true, force: false, acceptLicenses: acceptedNames, signal, log: () => {},
        onProgress: progress => {
          const time = this.now();
          const persist = progress.phase !== 'downloading' || time - lastPersist >= 500;
          if (persist) lastPersist = time;
          this._update(progress, { persist }).catch(() => this.controller?.abort(fail('STORAGE', 'Installation progress could not be saved.')));
        } });
      signal.throwIfAborted();
      state = 'completed';
    } catch (error) {
      state = signal.aborted ? 'cancelled' : 'failed';
      this.job.error = { code: typeof error.code === 'string' ? error.code : state === 'cancelled' ? 'CANCELLED' : 'FAILED',
        message: state === 'cancelled' ? 'Installation cancelled. Downloaded partial files are retained for retry.' : String(error.message || 'Installation failed.').slice(0, 1500) };
    } finally {
      // The settings hook reopens PAP admission, so publication must release its lease first.
      try { try { await releasePublication?.(); } finally { await release(); } }
      catch (error) { state = 'failed'; this.job.error = { code: 'LOCK_BUSY', message: 'Installation completed but its runtime lease could not be released.' }; }
      try { await this.afterInstall({ provider: reviewed.input.provider, state }); }
      catch (error) { state = 'failed'; this.job.error = { code: 'FAILED', message: `Readiness refresh failed: ${String(error.message).slice(0, 1000)}` }; }
      await this._update({ state, phase: state });
    }
  }

  async get(id) {
    await this.initialized;
    if (!this.job || this.job.id !== id) throw fail('NOT_FOUND', 'Installation job not found.');
    return clone(this.job);
  }

  async latest() { await this.initialized; return clone(this.job); }

  async cancel(id) {
    await this.initialized;
    if (!this.job || this.job.id !== id) throw fail('NOT_FOUND', 'Installation job not found.');
    if (this.controller && ACTIVE.has(this.job.state)) {
      await this._update({ state: 'cancelling', phase: 'cancelling' });
      this.controller.abort();
    }
    return clone(this.job);
  }

  async shutdown() {
    this.closed = true;
    this.controller?.abort();
    await this.running;
    await this.writes;
  }
}
