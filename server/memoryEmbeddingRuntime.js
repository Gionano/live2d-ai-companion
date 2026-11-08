import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createLocalPaths } from './selfie/localPaths.js';
import { resolveSlot, effectiveProfile } from './providers/config.js';
import { validateLocalEmbeddingUrl } from './providers/adapters/localEmbedding.js';
import { atomicWrite } from './settings/files.js';
import { inspectMemoryInstallation, verifyMemoryInstallation } from '../setup/memorySetup.js';
import { acquireSetupLock } from '../setup/setupLock.js';

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Managed lifecycle never installs anything and owns only children it spawned. */
export class MemoryEmbeddingRuntime {
  constructor({ registry, getConfig = () => ({}), paths = createLocalPaths(), spawnProcess = spawn,
    inspect = inspectMemoryInstallation, verify = verifyMemoryInstallation,
    probe = (provider, signal) => provider.health({ signal }), acquireLock = acquireSetupLock,
    now = Date.now, startupTimeoutMs = 90000, pollMs = 500 } = {}) {
    Object.assign(this, { registry, getConfig, paths, spawnProcess, inspect, verify, probe, acquireLock,
      now, startupTimeoutMs, pollMs });
    this.generation = 0;
    this.currentFingerprint = null;
    this.child = null;
    this.controller = null;
    this.operation = null;
    this.closed = false;
    this.snapshot = { ready: false, state: 'not_started', managed: true, reason: 'MEMORY_SETUP_REQUIRED' };
  }

  status() { return { ...this.snapshot }; }

  start() { return this.reconcile(); }

  reconcile({ force = false } = {}) {
    if (this.closed) return Promise.resolve(this.status());
    const config = { managedEmbedding: true, embeddingDevice: 'auto', ...this.getConfig() };
    const slot = resolveSlot(this.registry?.config ?? {}, 'memoryEmbedding');
    const profile = effectiveProfile(this.registry?.config ?? {}, slot);
    const availability = this.registry?.getSlotStatus('memoryEmbedding');
    const fingerprint = JSON.stringify({ config, profile: slot?.profile, model: slot?.model, baseUrl: profile?.baseUrl,
      adapter: profile?.adapter, capabilities: profile?.capabilities, available: availability?.available });
    if (!force && this.currentFingerprint === fingerprint && this.operation) return this.operation;
    if (!force && this.currentFingerprint === fingerprint && this.snapshot.ready) {
      this.rememberRevision(this.snapshot.revision);
      return Promise.resolve(this.status());
    }
    this.currentFingerprint = fingerprint;
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    this.operation = this.run({ config, slot, profile, generation, signal }).finally(() => {
      if (generation === this.generation) this.operation = null;
    });
    return this.operation;
  }

  async run({ config, slot, profile, generation, signal }) {
    const current = () => !signal.aborted && !this.closed && generation === this.generation;
    const set = state => {
      if (!current()) return;
      this.snapshot = { managed: config.managedEmbedding, ...state };
      if (state.ready) this.rememberRevision(state.revision);
    };
    try {
      await this.stopOwned();
      if (!current()) return this.status();
      if (!slot || !this.registry?.getSlotStatus('memoryEmbedding').available || profile?.adapter !== 'localEmbedding') {
        set({ ready: false, state: 'disabled', reason: 'UNCONFIGURED' });
        return this.status();
      }
      const url = new URL(validateLocalEmbeddingUrl(profile.baseUrl).url);
      const provider = this.registry.getEmbedding();
      set({ ready: false, state: 'checking', reason: null, model: slot.model });
      try {
        const health = await this.probe(provider, signal);
        if (current()) set({ ready: true, state: 'external', reason: null, model: health.model,
          device: health.device, revision: health.revision ?? null, owned: false });
        return this.status();
      } catch (error) {
        if (!current()) return this.status();
        if (error.code !== 'NETWORK') {
          set({ ready: false, state: 'unavailable', reason: 'INCOMPATIBLE_EMBEDDING_SERVICE', model: slot.model });
          return this.status();
        }
      }
      if (!config.managedEmbedding) {
        set({ ready: false, state: 'external', reason: 'EMBEDDING_OFFLINE', model: slot.model, owned: false });
        return this.status();
      }
      if (url.protocol !== 'http:') {
        set({ ready: false, state: 'unavailable', reason: 'MANAGED_ENDPOINT_UNSUPPORTED', model: slot.model });
        return this.status();
      }
      let installed = this.inspect(this.paths);
      if (!installed.valid) {
        set({ ready: false, state: 'setup_required', reason: installed.code, model: slot.model });
        return this.status();
      }
      const release = await this.acquireLock(this.paths.localDir, { signal });
      try {
        set({ ready: false, state: 'verifying', reason: null, model: slot.model });
        installed = await this.verify(this.paths, { signal });
        if (!current()) return this.status();
        if (!installed.valid) {
          set({ ready: false, state: 'setup_required', reason: installed.code, model: slot.model });
          return this.status();
        }
        if (fs.existsSync(installed.processPath)) {
          let owner;
          try { owner = JSON.parse(fs.readFileSync(installed.processPath, 'utf8')); } catch { throw Object.assign(new Error(), { code: 'MEMORY_PROCESS_UNKNOWN' }); }
          if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw Object.assign(new Error(), { code: 'MEMORY_PROCESS_UNKNOWN' });
          try { process.kill(owner.pid, 0); throw Object.assign(new Error(), { code: 'MEMORY_SERVICE_RUNNING' }); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
          fs.unlinkSync(installed.processPath);
        }
        const id = randomUUID();
        const child = this.spawnProcess(installed.pythonPath, [installed.servicePath, '--model-dir', installed.modelDir,
          '--device', config.embeddingDevice, '--host', url.hostname.replace(/^\[|\]$/g, ''),
          '--port', url.port || (url.protocol === 'https:' ? '443' : '80'), '--revision', installed.marker.modelRevision],
        { windowsHide: true, stdio: 'ignore', env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
          HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' } });
        this.child = { process: child, id, processPath: installed.processPath };
        child.once('error', () => {
          if (current()) set({ ready: false, state: 'failed', reason: 'EMBEDDING_START_FAILED', model: slot.model });
        });
        child.once('exit', () => {
          this.removeOwnedMarker(id, installed.processPath);
          if (this.child?.id === id) this.child = null;
          if (current()) set({ ready: false, state: 'failed', reason: 'EMBEDDING_PROCESS_EXITED', model: slot.model });
        });
        if (Number.isInteger(child.pid) && child.pid > 0) atomicWrite(installed.processPath,
          JSON.stringify({ id, pid: child.pid, parentPid: process.pid, modelRevision: installed.marker.modelRevision }));
        else throw Object.assign(new Error(), { code: 'EMBEDDING_START_FAILED' });
      } finally { await release(); }
      set({ ready: false, state: 'starting', reason: null, model: slot.model, owned: true });
      const deadline = this.now() + this.startupTimeoutMs;
      while (current() && this.child && this.now() < deadline) {
        try {
          const health = await this.probe(provider, signal);
          if (!current()) return this.status();
          if (health.revision !== installed.marker.modelRevision) throw Object.assign(new Error(), { code: 'BAD_RESPONSE' });
          set({ ready: true, state: 'running', reason: null, model: health.model, device: health.device,
            revision: health.revision, owned: true });
          return this.status();
        } catch (error) {
          if (!current()) return this.status();
          if (error.code !== 'NETWORK' && error.code !== 'TIMEOUT') throw error;
        }
        await pause(this.pollMs, signal);
      }
      if (current()) {
        await this.stopOwned();
        set({ ready: false, state: 'failed', reason: 'EMBEDDING_START_TIMEOUT', model: slot.model });
      }
    } catch (error) {
      if (current()) {
        await this.stopOwned();
        set({ ready: false, state: 'failed', reason: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'EMBEDDING_START_FAILED' });
      }
    }
    return this.status();
  }

  removeOwnedMarker(id, filename) {
    try { if (JSON.parse(fs.readFileSync(filename, 'utf8')).id === id) fs.unlinkSync(filename); }
    catch { /* A retired child cannot remove a newer owner's marker. */ }
  }

  rememberRevision(revision) {
    // Settings reload replaces adapter instances even when the selected service
    // is unchanged. Preserve its observed immutable identity without probing.
    const provider = this.registry?.getEmbedding();
    if (provider) provider.revision = revision ?? null;
  }

  async stopOwned() {
    const owned = this.child;
    if (!owned) return;
    this.child = null;
    const child = owned.process;
    if (child.exitCode == null && child.signalCode == null) {
      await new Promise(resolve => {
        let timer;
        const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(); };
        child.once('exit', done);
        timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} done(); }, 1000);
        try { child.kill('SIGTERM'); } catch { done(); }
      });
    }
    this.removeOwnedMarker(owned.id, owned.processPath);
  }

  retry() { return this.reconcile({ force: true }); }

  async dispose() {
    this.closed = true;
    this.generation++;
    this.controller?.abort();
    await this.stopOwned();
    this.snapshot = { ready: false, state: 'disposed', managed: this.snapshot.managed, reason: null };
  }
}
