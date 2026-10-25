import path from 'node:path';
import { ImageProvider, ImageProviderError, IMAGE_ERROR } from '../imageProvider.js';
import { ComfyUiManagedProcess } from '../comfyuiManagedProcess.js';
import { SdCppMemoryMonitor } from '../sdcppMemory.js';
import { normalizeMemoryPeaks } from '../etaStore.js';
import { appendSelfieRun } from '../selfieExperiments.js';
import { selfieWarn as warn } from '../log.js';
import { ComfyUiProvider } from './comfyuiProvider.js';
import { resolveSelfiePaths } from '../localPaths.js';

/** Own only the local process; workflow, progress and prompt cancellation stay in ComfyUiProvider. */
export class ComfyUiManagedProvider extends ImageProvider {
  constructor(cfg, {
    lifecycle = null, processOptions = {},
    createComfyProvider = config => new ComfyUiProvider(config),
    monitor = new SdCppMemoryMonitor(cfg, { workingSetMode: 'current' }), appendRun = appendSelfieRun,
    warner = warn,
  } = {}) {
    super();
    Object.assign(cfg, resolveSelfiePaths(cfg));
    this.cfg = cfg;
    this.createComfyProvider = createComfyProvider;
    this.monitor = monitor;
    this.appendRun = appendRun;
    this.warn = warner;
    this.delegate = null;
    this.delegatePid = null;
    this.active = null;
    this.lastPeaks = null;
    this.lastTimings = { coldStartMs: 0, generateMs: 0 };
    this.readiness = { ready: false, code: 'UNAVAILABLE' };
    this.statusListener = null;
    this.needsRelease = false;
    this.releasePromise = null;
    this.shutdownPromise = null;
    this.jobAdmissionActive = false;
    this.lifecycle = lifecycle || new ComfyUiManagedProcess(cfg, {
      ...processOptions,
      onChild: child => {
        this._startTelemetry(child.pid, child);
        processOptions.onChild?.(child);
      },
    });
    this.lifecycle.setStatusListener?.(() => this._notify());
  }

  get name() { return 'comfyui-managed'; }

  setStatusListener(listener) {
    this.statusListener = typeof listener === 'function' ? listener : null;
  }

  _notify() {
    try { this.statusListener?.(this.getStatus()); } catch { /* Status observers cannot fail a job. */ }
  }

  getStatus() {
    const processStatus = this.lifecycle.getStatus();
    return {
      ready: this.readiness.ready, code: this.readiness.code,
      profile: processStatus.profile ?? this.cfg.comfyuiManaged?.profile ?? null,
      running: processStatus.running, starting: processStatus.starting === true,
      ...(processStatus.warnings?.length && { warnings: processStatus.warnings.map(value => ({ ...value })) }),
      coldStartMs: this.lastTimings.coldStartMs,
      lastPeaks: normalizeMemoryPeaks(this.lastPeaks),
    };
  }

  getGenerationPeaks() { return normalizeMemoryPeaks(this.lastPeaks); }
  getGenerationTimings() { return { ...this.lastTimings }; }
  getFinalArgv() { return this.lifecycle.launchArgs ? [...this.lifecycle.launchArgs] : null; }

  onJobAdmitted() {
    this.jobAdmissionActive = true;
    this.lifecycle.cancelIdleStop();
  }

  onJobsIdle() {
    this.jobAdmissionActive = false;
    if (!this.active && !this.shutdownPromise) this.lifecycle.armIdleStop();
  }

  async checkReady(signal) {
    signal?.throwIfAborted();
    const local = await this.lifecycle.checkReady(signal);
    if (!local.ready) {
      const message = local.message || local.reasons?.join('; ') || 'Managed ComfyUI cannot launch.';
      this.readiness = { ready: false, code: local.code || 'COMFYUI_MANAGED_CONFIG', message,
        publicMessage: local.publicMessage || 'Managed ComfyUI launch configuration is unavailable; see backend logs.' };
    } else if (this.lifecycle.getStatus().running) {
      this._connect(this.lifecycle.baseUrl, this.lifecycle.getStatus().pid);
      this.readiness = await this.delegate.checkReady(signal);
    } else {
      this.readiness = { ready: true, code: 'READY', message: 'Managed ComfyUI can launch; nodes and models will be checked after start.' };
    }
    const warnings = this.lifecycle.getStatus().warnings;
    if (warnings?.length) {
      const warningText = warnings.map(value => value.message).join(' ');
      this.readiness = { ...this.readiness, warnings,
        message: `${this.readiness.message} Warning: ${warningText}`,
        publicMessage: `${this.readiness.publicMessage || this.readiness.code} Warning: ${warningText}` };
    }
    this._notify();
    return { ...this.readiness };
  }

  async isAvailable(signal) { return (await this.checkReady(signal)).ready; }

  _connect(baseUrl, pid) {
    if (this.delegate && this.delegatePid === pid && this.delegate.baseUrl === baseUrl) return;
    this.delegate = this.createComfyProvider({
      ...this.cfg, comfyUrl: baseUrl, comfyHealthPath: this.cfg.comfyuiManaged?.healthPath || '/system_stats',
      freeVramAfter: false,
    });
    this.delegatePid = pid;
  }

  async ensureRunning(signal) {
    const startedAt = Date.now();
    let started;
    try {
      started = await this.lifecycle.ensureRunning(signal);
    } finally {
      // Failed cold starts also retain their duration for the CLI and run log.
      this.lastTimings.coldStartMs = started?.coldStartMs ?? Math.max(0, Date.now() - startedAt);
      this._notify();
    }
    this._connect(started.baseUrl, started.pid);
    this.readiness = await this.delegate.checkReady(signal);
    this._notify();
    if (!this.readiness.ready) {
      throw new ImageProviderError(this.readiness.code, this.readiness.message, {
        generationStarted: false, publicMessage: this.readiness.publicMessage,
      });
    }
    return started;
  }

  _startTelemetry(pid, child = null) {
    const active = this.active;
    if (!active || active.sampler || this.cfg.telemetry?.enabled === false) return;
    try {
      active.sampler = this.monitor.start(pid, {
        onPeaks: peaks => {
          if (this.active !== active || active.telemetryStopped) return;
          this.lastPeaks = normalizeMemoryPeaks(peaks);
          this._notify();
        },
      });
      if (child) {
        active.telemetryChild = child;
        active.onChildExit = () => this._stopTelemetry(active);
        child.once('exit', active.onChildExit);
      }
    } catch (err) { this.warn(`comfyui-managed telemetry could not start: ${err.message}`); }
  }

  _stopTelemetry(active) {
    if (active.telemetryStopped) return;
    active.telemetryStopped = true;
    active.telemetryChild?.off('exit', active.onChildExit);
    try {
      const peaks = active.sampler?.stop();
      if (peaks) this.lastPeaks = normalizeMemoryPeaks(peaks);
    } catch (err) { this.warn(`comfyui-managed telemetry could not stop: ${err.message}`); }
    this._notify();
  }

  async generate(params, onProgress = () => {}, signal, onStarted = () => {}) {
    if (this.shutdownPromise || this.active) {
      throw new ImageProviderError(IMAGE_ERROR.UNAVAILABLE, 'Managed ComfyUI is stopping or already has a job.', { generationStarted: false });
    }
    const controller = new AbortController();
    const active = { controller, started: false, sampler: null, telemetryStopped: false, finishing: false };
    active.done = new Promise(resolve => { active.finish = resolve; });
    this.active = active;
    this.lastPeaks = null;
    this.lastTimings = { coldStartMs: 0, generateMs: 0 };
    this.needsRelease = true;
    this.releasePromise = null;
    this.lifecycle.cancelIdleStop();
    const runStartedAt = Date.now();
    let generationStartedAt;
    let result;
    let status = 'failed';
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timeout = setTimeout(() => controller.abort(new ImageProviderError(IMAGE_ERROR.TIMEOUT,
      `Managed ComfyUI job exceeded ${this.cfg.jobTimeoutMs}ms.`)), this.cfg.jobTimeoutMs || 240000);
    try {
      controller.signal.throwIfAborted();
      await this.ensureRunning(controller.signal);
      this._startTelemetry(this.lifecycle.getStatus().pid, this.lifecycle.child);
      generationStartedAt = Date.now();
      result = await this.delegate.generate(params, onProgress, controller.signal, () => {
        active.started = true;
        onStarted(this.name);
      });
      status = 'success';
      this.lastTimings = { ...result.timings, coldStartMs: this.lastTimings.coldStartMs,
        totalMs: Date.now() - runStartedAt };
      result = { ...result, provider: this.name, profile: this.getStatus().profile, timings: this.lastTimings };
      return result;
    } catch (err) {
      const failure = controller.signal.aborted
        ? new ImageProviderError(controller.signal.reason?.code === IMAGE_ERROR.TIMEOUT ? IMAGE_ERROR.TIMEOUT : IMAGE_ERROR.CANCELLED,
          controller.signal.reason?.message || 'Managed ComfyUI job was cancelled.', { generationStarted: active.started || err.generationStarted === true })
        : err;
      if (failure.generationStarted === undefined) failure.generationStarted = active.started;
      status = failure.code || 'failed';
      this.lastTimings.generateMs = generationStartedAt === undefined ? 0 : Date.now() - generationStartedAt;
      this.lastTimings.totalMs = Date.now() - runStartedAt;
      throw failure;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      this._stopTelemetry(active);
      if (result) result.peaks = this.getGenerationPeaks();
      active.finishing = true;
      try {
        await this.release();
        if (params.recordRun !== false) {
          const preset = this.cfg.presets?.[params.preset || this.cfg.preset] || {};
          await this.appendRun({ provider: this.name, profile: this.getStatus().profile, status,
            width: params.width ?? params.resolution ?? preset.resolution,
            height: params.height ?? params.resolution ?? preset.resolution,
            steps: params.steps ?? preset.steps, cfg: params.cfgScale ?? preset.cfg,
            seed: result?.seed ?? params.seed, timings: this.getGenerationTimings(), peaks: this.getGenerationPeaks(),
            args: this.lifecycle.launchArgs || [], imagePath: result?.imagePath,
            reference: path.join(this.cfg.referenceDir || '', params.referenceImage || this.cfg.defaultReference || ''),
          }).catch(err => this.warn(`comfyui-managed run log failed: ${err.message}`));
        }
      } finally {
        if (this.active === active) this.active = null;
        active.finish();
      }
    }
  }

  async cancel() {
    this.active?.controller.abort(new ImageProviderError(IMAGE_ERROR.CANCELLED, 'Managed ComfyUI job was cancelled.'));
    await this.delegate?.cancel();
  }

  async release() {
    if (this.active && !this.active.finishing) await this.active.done;
    if (!this.needsRelease) return this.releasePromise;
    this.needsRelease = false;
    this.releasePromise = (async () => {
      try {
        const owned = this.lifecycle.getStatus();
        if (owned.running && owned.pid === this.delegatePid) await this.delegate?.release();
      } finally {
        if (this.jobAdmissionActive) this.lifecycle.cancelIdleStop();
        else this.lifecycle.armIdleStop();
      }
    })();
    return this.releasePromise;
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      try {
        await this.cancel().catch(err => this.warn(`comfyui-managed cancel failed during shutdown: ${err.message}`));
        if (this.active) await this.active.done;
        await this.release();
      } finally { await this.lifecycle.stop(); }
    })();
    return this.shutdownPromise;
  }
}
