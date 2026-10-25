import { ImageProvider, ImageProviderError, IMAGE_ERROR } from './imageProvider.js';
import { etaStore, normalizeMemoryPeaks } from './etaStore.js';
import { RUNTIME_WARNING_MESSAGES } from './localPaths.js';

const PROVIDER_NAMES = ['comfyui', 'comfyui-managed', 'sdcpp'];
const DEFAULT_AVAILABILITY_CACHE_MS = 30000;

async function initializeManagedComfyUi(config) {
  const { cleanupManagedComfyUiOnStartup } = await import('./comfyuiManagedProcess.js');
  await cleanupManagedComfyUiOnStartup(config);
}

async function defaultProviderFactory(name, config) {
  if (name === 'comfyui') {
    const { ComfyUiProvider } = await import('./providers/comfyuiProvider.js');
    return new ComfyUiProvider(config);
  }
  if (name === 'sdcpp') {
    const { SdCppProvider } = await import('./providers/sdcppProvider.js');
    return new SdCppProvider(config);
  }
  if (name === 'comfyui-managed') {
    const { ComfyUiManagedProvider } = await import('./providers/comfyuiManagedProvider.js');
    return new ComfyUiManagedProvider(config);
  }
  throw new Error(`Unknown selfie provider: ${name}`);
}

function normalizeReadyResult(name, result) {
  if (result && typeof result === 'object' && typeof result.ready === 'boolean') {
    const warnings = normalizeRuntimeWarnings(result.warnings);
    return {
      ready: result.ready,
      code: String(result.code || (result.ready ? 'READY' : 'UNAVAILABLE')),
      message: String(result.message || (result.ready
        ? `${name} is ready.`
        : `${name} is unavailable.`)),
      publicMessage: String(result.publicMessage || result.code || 'UNAVAILABLE'),
      ...(warnings.length && { warnings }),
    };
  }
  const ready = Boolean(result);
  return {
    ready,
    code: ready ? 'READY' : 'UNAVAILABLE',
    message: ready ? `${name} is ready.` : `${name} is unavailable.`,
    publicMessage: ready ? `${name} is ready.` : `${name} is unavailable.`,
  };
}

function normalizeOptions(value) {
  if (value && typeof value === 'object' && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function') {
    return { signal: value };
  }
  return value && typeof value === 'object' ? value : {};
}

function cloneStatus(status) {
  return {
    active: status.active,
    reasons: { ...status.reasons },
    ...(status.sdcpp && { sdcpp: normalizeSdcppStatus(status.sdcpp) }),
    ...(status.comfyuiManaged && { comfyuiManaged: normalizeManagedStatus(status.comfyuiManaged) }),
  };
}

function normalizeManagedStatus(value) {
  const warnings = normalizeRuntimeWarnings(value?.warnings);
  return {
    ready: value?.ready === true,
    code: /^[A-Z0-9_]{1,64}$/.test(value?.code) ? value.code : 'UNAVAILABLE',
    profile: typeof value?.profile === 'string' ? value.profile.replace(/[\r\n\0]/g, '').slice(0, 200) : '',
    running: value?.running === true,
    coldStartMs: Number.isFinite(value?.coldStartMs) && value.coldStartMs >= 0 ? value.coldStartMs : null,
    lastPeaks: normalizeMemoryPeaks(value?.lastPeaks),
    ...(warnings.length && { warnings }),
  };
}

function normalizeSdcppStatus(value) {
  const backend = String(value?.backend || '').toLowerCase();
  const warnings = normalizeRuntimeWarnings(value?.warnings);
  return {
    ready: value?.ready === true,
    code: /^[A-Z0-9_]{1,64}$/.test(value?.code) ? value.code : 'UNAVAILABLE',
    backend: ['cuda', 'vulkan', 'cpu'].includes(backend) ? backend : null,
    deviceName: typeof value?.deviceName === 'string' ? value.deviceName.replace(/[\r\n\0]/g, '').slice(0, 200) : null,
    memoryTier: ['ok', 'tight', 'insufficient'].includes(value?.memoryTier) ? value.memoryTier : null,
    memoryMessage: typeof value?.memoryMessage === 'string' ? value.memoryMessage.slice(0, 512) : null,
    lastPeaks: normalizeMemoryPeaks(value?.lastPeaks),
    ...(warnings.length && { warnings }),
  };
}

function normalizeRuntimeWarnings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(value => value?.code).filter(code => Object.hasOwn(RUNTIME_WARNING_MESSAGES, code)))]
    .map(code => ({ code, message: RUNTIME_WARNING_MESSAGES[code] }));
}

function availabilityCacheMs(config) {
  const value = Number(config?.availabilityCacheMs);
  return Number.isFinite(value) && value >= 0
    ? value : DEFAULT_AVAILABILITY_CACHE_MS;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function allowsPreGenerationFailover(error, generationStarted, signal) {
  if (generationStarted || signal?.aborted) return false;
  if (error?.code === IMAGE_ERROR.CANCELLED) return false;
  return error?.beforeGeneration === true || error?.generationStarted === false;
}

function applyPresetOverride(params, providerName) {
  const override = params?.providerOverrides?.[providerName]
    ?? (providerName === 'comfyui-managed' ? params?.providerOverrides?.comfyui : undefined);
  if (!override) return params;
  return {
    ...params,
    resolution: override.resolution ?? params.resolution,
    steps: override.steps ?? params.steps,
    cfgScale: override.cfg ?? params.cfgScale,
  };
}

export class ProviderResolver extends ImageProvider {
  constructor(config, {
    createProvider = defaultProviderFactory,
    initializeManaged = createProvider === defaultProviderFactory ? initializeManagedComfyUi : null,
    onStatus = null,
    now = () => Date.now(),
  } = {}) {
    super();
    this.config = config;
    this.createProvider = createProvider;
    this.onStatus = onStatus;
    this.now = now;
    this.initializeManaged = initializeManaged;
    this.initializationPromise = null;
    this.providers = new Map();
    this.readiness = new Map();
    this.readinessInFlight = new Map();
    this.configRevision = 0;
    this.selectionRevision = 0;
    this.currentProvider = null;
    this.currentProviderName = null;
    this.providersToRelease = new Set();
    this.allProviders = new Set();
    this.managedProviders = new Set();
    this.providerPromises = new Set();
    this.providerShutdowns = new Map();
    this.managedJobs = new Map();
    this.managedRetirement = Promise.resolve();
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.status = {
      active: null,
      reasons: { comfyui: 'Not checked.', 'comfyui-managed': 'Not checked.', sdcpp: 'Not checked.' },
    };
    this.publicReasons = { ...this.status.reasons };
    this.managesGenerationStart = true;
  }

  get name() {
    return this.currentProviderName || this.config.provider || 'auto';
  }

  getStatus() {
    return cloneStatus(this.status);
  }

  getPublicStatus() {
    return { ...cloneStatus(this.status), reasons: { ...this.publicReasons } };
  }

  getGenerationStatus() {
    const status = this.currentProvider?.getStatus?.();
    if (this.currentProviderName === 'sdcpp' && status) return normalizeSdcppStatus(status);
    if (this.currentProviderName === 'comfyui-managed' && status) return normalizeManagedStatus(status);
    return null;
  }

  getGenerationTimings() {
    const value = this.currentProvider?.getGenerationTimings?.();
    if (!value) return null;
    return Object.fromEntries(['coldStartMs', 'generateMs'].map(key => [key,
      Number.isFinite(value[key]) && value[key] >= 0 ? value[key] : null]));
  }

  getFinalArgv() {
    return this.currentProvider?.getFinalArgv?.() || null;
  }

  getEffectiveConfig() {
    return this.currentProvider?.getEffectiveConfig?.() || null;
  }

  getSanityWarnings() {
    return this.currentProvider?.getSanityWarnings?.() || [];
  }

  getGenerationPeaks() {
    return normalizeMemoryPeaks(this.currentProvider?.getGenerationPeaks?.());
  }

  _handleSdcppStatus(value, config = this.config) {
    const sdcpp = normalizeSdcppStatus(value);
    sdcpp.lastPeaks ||= this.status.sdcpp?.lastPeaks || etaStore.getLastPeaks(config.preset, config.etaStorePath);
    this._publishStatus({ sdcpp, active: this.status.active });
  }

  _handleManagedStatus(value) {
    this._publishStatus({ comfyuiManaged: normalizeManagedStatus(value), active: this.status.active });
  }

  _providerOrder(config = this.config) {
    if (config.provider !== 'auto') return [config.provider];
    const configured = Array.isArray(config.autoOrder) ? config.autoOrder : PROVIDER_NAMES;
    const unique = configured.filter((name, index) => PROVIDER_NAMES.includes(name)
      && configured.indexOf(name) === index);
    return unique.length ? unique : [...PROVIDER_NAMES];
  }

  _publishStatus(next, revision = this.selectionRevision) {
    if (revision !== this.selectionRevision) return false;
    const nextReasons = next.reasons || {};
    const normalized = {
      active: next.active || null,
      reasons: {
        comfyui: Object.hasOwn(nextReasons, 'comfyui')
          ? nextReasons.comfyui : this.status.reasons.comfyui,
        'comfyui-managed': Object.hasOwn(nextReasons, 'comfyui-managed')
          ? nextReasons['comfyui-managed'] : this.status.reasons['comfyui-managed'],
        sdcpp: Object.hasOwn(nextReasons, 'sdcpp')
          ? nextReasons.sdcpp : this.status.reasons.sdcpp,
      },
      ...((Object.hasOwn(next, 'sdcpp') ? next.sdcpp : this.status.sdcpp) && {
        sdcpp: normalizeSdcppStatus(Object.hasOwn(next, 'sdcpp') ? next.sdcpp : this.status.sdcpp),
      }),
      ...((Object.hasOwn(next, 'comfyuiManaged') ? next.comfyuiManaged : this.status.comfyuiManaged) && {
        comfyuiManaged: normalizeManagedStatus(Object.hasOwn(next, 'comfyuiManaged') ? next.comfyuiManaged : this.status.comfyuiManaged),
      }),
    };
    const publicReasons = { ...this.publicReasons, ...next.publicReasons };
    const changed = JSON.stringify(normalized) !== JSON.stringify(this.status)
      || JSON.stringify(publicReasons) !== JSON.stringify(this.publicReasons);
    this.status = normalized;
    this.publicReasons = publicReasons;
    if (changed && typeof this.onStatus === 'function') {
      try {
        this.onStatus(cloneStatus(normalized), this.getPublicStatus());
      } catch {
        // Status observers must not break provider selection.
      }
    }
    return true;
  }

  async _getProvider(name, {
    config = this.config,
    configRevision = this.configRevision,
  } = {}) {
    if (!PROVIDER_NAMES.includes(name)) throw new Error(`Unknown selfie provider: ${name}`);
    if (this.shuttingDown) throw new Error('Selfie providers are shutting down.');
    if (configRevision !== this.configRevision) {
      return this._createProvider(name, config);
    }
    let entry = this.providers.get(name);
    if (!entry || entry.configRevision !== configRevision) {
      entry = {
        configRevision,
        promise: this._createProvider(name, config).then((provider) => {
          if (['sdcpp', 'comfyui-managed'].includes(name) && typeof provider.setStatusListener === 'function') {
            provider.setStatusListener((status) => {
              if (configRevision === this.configRevision && this.providers.get(name) === entry) {
                if (name === 'sdcpp') this._handleSdcppStatus(status, config);
                else this._handleManagedStatus(status);
              }
            });
          }
          return provider;
        }),
      };
      this.providers.set(name, entry);
    }
    try {
      return await entry.promise;
    } catch (error) {
      if (this.providers.get(name) === entry) this.providers.delete(name);
      throw error;
    }
  }

  _createProvider(name, config) {
    const retirement = this.managedRetirement;
    const promise = Promise.resolve().then(async () => {
      if (name === 'comfyui-managed') await retirement;
      if (this.shuttingDown) throw new Error('Selfie providers are shutting down.');
      const provider = await this.createProvider(name, config);
      this.allProviders.add(provider);
      if (name === 'comfyui-managed') this.managedProviders.add(provider);
      return provider;
    });
    this.providerPromises.add(promise);
    promise.finally(() => this.providerPromises.delete(promise)).catch(() => {});
    return promise;
  }

  async _checkProvider(name, {
    force = false,
    signal,
    config = this.config,
    configRevision = this.configRevision,
    selectionRevision = this.selectionRevision,
  } = {}) {
    signal?.throwIfAborted();
    const cached = this.readiness.get(name);
    const cacheMs = availabilityCacheMs(config);
    if (!force && cached
      && cached.configRevision === configRevision
      && cached.selectionRevision === selectionRevision
      && this.now() - cached.checkedAt < cacheMs) {
      return cached.result;
    }

    let entry = this.readinessInFlight.get(name);
    if (!entry || entry.configRevision !== configRevision
      || entry.selectionRevision !== selectionRevision) {
      const controller = new AbortController();
      entry = {
        configRevision,
        selectionRevision,
        controller,
        waiters: 0,
        settled: false,
        promise: (async () => {
          let result;
          let checkedProvider;
          try {
            const provider = await this._getProvider(name, { config, configRevision });
            checkedProvider = provider;
            controller.signal.throwIfAborted();
            result = typeof provider.checkReady === 'function'
              ? normalizeReadyResult(name, await provider.checkReady(controller.signal))
              : normalizeReadyResult(name, await provider.isAvailable(controller.signal));
            controller.signal.throwIfAborted();
          } catch (error) {
            controller.signal.throwIfAborted();
            result = {
              ready: false,
              code: String(error?.code || 'CHECK_FAILED'),
              message: String(error?.message || `${name} readiness check failed.`),
            };
          }
          if (configRevision === this.configRevision
            && selectionRevision === this.selectionRevision) {
            this.readiness.set(name, {
              configRevision,
              selectionRevision,
              checkedAt: this.now(),
              result,
            });
            if (name === 'sdcpp') {
              const details = checkedProvider?.getStatus?.();
              if (details) this._handleSdcppStatus({ ...details, ready: result.ready, code: result.code }, config);
            }
            if (name === 'comfyui-managed') {
              const details = checkedProvider?.getStatus?.();
              if (details) this._handleManagedStatus({ ...details, ready: result.ready, code: result.code });
            }
          }
          return result;
        })(),
      };
      this.readinessInFlight.set(name, entry);
      entry.promise.finally(() => {
        entry.settled = true;
        if (this.readinessInFlight.get(name) === entry) this.readinessInFlight.delete(name);
      }).catch(() => {});
    }
    entry.waiters += 1;
    try {
      return await waitWithSignal(entry.promise, signal);
    } finally {
      entry.waiters -= 1;
      if (entry.waiters === 0 && !entry.settled) entry.controller.abort();
    }
  }

  async resolveProvider(options = {}) {
    const { force = false, signal, exclude = [] } = normalizeOptions(options);
    signal?.throwIfAborted();
    await this._initialize(signal);
    const context = {
      config: this.config,
      configRevision: this.configRevision,
      selectionRevision: this.selectionRevision,
    };
    const order = this._providerOrder(context.config);
    const excluded = new Set(exclude);
    const results = new Map();

    for (const name of order) {
      if (excluded.has(name)) continue;
      results.set(name, await this._checkProvider(name, { force, signal, ...context }));
    }

    if (context.configRevision !== this.configRevision
      || context.selectionRevision !== this.selectionRevision) {
      return this.resolveProvider({ force, signal, exclude });
    }

    const selectedName = order.find(name => !excluded.has(name) && results.get(name)?.ready) || null;
    const reasons = { ...this.status.reasons };
    const publicReasons = { ...this.publicReasons };
    for (const [name, result] of results) {
      const warnings = normalizeRuntimeWarnings(result.warnings);
      const warningReason = warnings.length ? `Warning: ${warnings.map(value => value.message).join(' ')}` : null;
      reasons[name] = result.ready ? warningReason : result.message;
      publicReasons[name] = result.ready ? warningReason : result.publicMessage || 'Readiness check failed.';
    }
    this._publishStatus({ active: selectedName, reasons, publicReasons }, context.selectionRevision);

    if (!selectedName) return { provider: null, name: null, status: this.getStatus() };
    const provider = await this._getProvider(selectedName, context);
    if (context.configRevision !== this.configRevision
      || context.selectionRevision !== this.selectionRevision) {
      return this.resolveProvider({ force, signal, exclude });
    }
    return { provider, name: selectedName, status: this.getStatus() };
  }

  async _initialize(signal) {
    if (!this.initializeManaged) return;
    if (!this.initializationPromise) {
      this.initializationPromise = Promise.resolve().then(() => this.initializeManaged(this.config));
      this.initializationPromise.catch(error => {
        this._publishStatus({ active: null,
          reasons: { 'comfyui-managed': String(error?.message || 'Managed ComfyUI startup cleanup failed.') },
          publicReasons: { 'comfyui-managed': 'Managed ComfyUI startup cleanup failed; see backend logs.' } });
      });
    }
    await waitWithSignal(this.initializationPromise, signal);
  }

  async checkReady(options = {}) {
    const resolved = await this.resolveProvider(options);
    if (resolved.provider) {
      return {
        ...(resolved.name === 'sdcpp' && this.status.sdcpp),
        ...(resolved.name === 'comfyui-managed' && this.status.comfyuiManaged),
        ready: true,
        code: 'READY',
        message: `${resolved.name} is ready.`,
      };
    }
    const order = this._providerOrder();
    const message = order.map(name => `${name}: ${resolved.status.reasons[name]}`).join('; ');
    return {
      ...(this.config.provider === 'sdcpp' && this.status.sdcpp),
      ...(this.config.provider === 'comfyui-managed' && this.status.comfyuiManaged),
      ready: false,
      code: this.config.provider === 'sdcpp' ? this.status.sdcpp?.code || IMAGE_ERROR.UNAVAILABLE
        : this.config.provider === 'comfyui-managed' ? this.status.comfyuiManaged?.code || IMAGE_ERROR.UNAVAILABLE : IMAGE_ERROR.UNAVAILABLE,
      message: message || 'No selfie image provider is ready.',
    };
  }

  async isAvailable(options = {}) {
    return (await this.checkReady(options)).ready;
  }

  invalidate(name = null, reason = 'Not checked.', publicReason = 'Not checked.') {
    const names = name ? [name] : PROVIDER_NAMES;
    this.selectionRevision += 1;
    for (const [providerName, cached] of this.readiness) {
      if (!names.includes(providerName)) {
        this.readiness.set(providerName, {
          ...cached,
          selectionRevision: this.selectionRevision,
        });
      }
    }
    for (const providerName of names) {
      this.readiness.delete(providerName);
      this.readinessInFlight.delete(providerName);
    }
    const reasons = { ...this.status.reasons };
    const publicReasons = { ...this.publicReasons };
    for (const providerName of names) {
      reasons[providerName] = reason;
      publicReasons[providerName] = publicReason;
    }
    this._publishStatus({
      active: names.includes(this.status.active) ? null : this.status.active,
      reasons,
      publicReasons,
      ...(names.includes('sdcpp') && this.status.sdcpp && {
        sdcpp: { ...this.status.sdcpp, ready: false,
          code: this.status.sdcpp.ready ? 'UNAVAILABLE' : this.status.sdcpp.code },
      }),
      ...(names.includes('comfyui-managed') && this.status.comfyuiManaged && {
        comfyuiManaged: { ...this.status.comfyuiManaged, ready: false,
          code: this.status.comfyuiManaged.ready ? 'UNAVAILABLE' : this.status.comfyuiManaged.code },
      }),
    });
  }

  updateConfig(config) {
    const retiring = this.providers.get('comfyui-managed');
    if (retiring) {
      const previousRetirement = this.managedRetirement;
      this.managedRetirement = Promise.all([previousRetirement, retiring.promise]).then(async ([, provider]) => {
        await this.managedJobs.get(provider);
        try {
          await provider.release?.();
        } finally {
          await this._shutdownProvider(provider);
        }
        this.providersToRelease.delete(provider);
      });
      this.managedRetirement.catch(() => {});
    }
    this.config = config;
    this.configRevision += 1;
    this.selectionRevision += 1;
    this.providers.clear();
    this.readiness.clear();
    this.readinessInFlight.clear();
    this._publishStatus({
      active: null,
      reasons: { comfyui: 'Not checked.', 'comfyui-managed': 'Not checked.', sdcpp: 'Not checked.' },
      publicReasons: { comfyui: 'Not checked.', 'comfyui-managed': 'Not checked.', sdcpp: 'Not checked.' },
      sdcpp: null,
      comfyuiManaged: null,
    });
  }

  async generate(params, onProgress = () => {}, signal, onStarted = () => {}) {
    const attempted = [];
    while (true) {
      signal?.throwIfAborted();
      const resolved = await this.resolveProvider({ signal, exclude: attempted });
      if (!resolved.provider) {
        throw new ImageProviderError(
          IMAGE_ERROR.UNAVAILABLE,
          this._providerOrder().map(name => `${name}: ${this.status.reasons[name]}`).join('; '),
        );
      }

      const { provider, name } = resolved;
      this.currentProvider = provider;
      this.currentProviderName = name;
      // Config reloads and later jobs may replace currentProvider while ComfyUI stays warm.
      this.providersToRelease.add(provider);
      let generationStarted = false;
      const markStarted = () => {
        if (generationStarted) return;
        generationStarted = true;
        onStarted(name);
      };
      let finishManagedJob;
      if (name === 'comfyui-managed') {
        this.managedJobs.set(provider, new Promise(resolve => { finishManagedJob = resolve; }));
      }

      try {
        const result = await provider.generate(
          applyPresetOverride(params, name),
          onProgress,
          signal,
          markStarted,
        );
        return { ...result, provider: name };
      } catch (error) {
        const beforeGeneration = allowsPreGenerationFailover(error, generationStarted, signal);
        const cancelled = error?.code === IMAGE_ERROR.CANCELLED || signal?.aborted;
        const reason = String(error?.message || `${name} generation failed.`);
        if (!cancelled) this.invalidate(name, reason, 'Image provider failed; see backend logs.');
        if (this.config.provider !== 'auto' || !beforeGeneration) throw error;
        attempted.push(name);
      } finally {
        finishManagedJob?.();
        if (finishManagedJob) this.managedJobs.delete(provider);
      }
    }
  }

  async cancel() {
    await this.currentProvider?.cancel?.();
  }

  onJobAdmitted() {
    for (const provider of this.managedProviders) provider.onJobAdmitted?.();
  }

  onJobsIdle() {
    if (this.shuttingDown) return;
    for (const provider of this.managedProviders) provider.onJobsIdle?.();
  }

  async release() {
    const releases = await Promise.allSettled([...this.providersToRelease].map(async (provider) => {
      await provider.release?.();
      this.providersToRelease.delete(provider);
    }));
    const errors = releases.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Selfie provider release failed.');
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    for (const entry of this.readinessInFlight.values()) entry.controller.abort();
    this.shutdownPromise = (async () => {
      await Promise.allSettled([...this.providerPromises]);
      const results = await Promise.allSettled([
        this.initializationPromise,
        this.managedRetirement,
        ...[...this.allProviders].map(provider => this._shutdownProvider(provider)),
      ]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Selfie provider shutdown failed.');
    })();
    return this.shutdownPromise;
  }

  _shutdownProvider(provider) {
    if (!this.providerShutdowns.has(provider)) {
      this.providerShutdowns.set(provider, Promise.resolve().then(() => provider.shutdown?.()));
    }
    return this.providerShutdowns.get(provider);
  }
}
