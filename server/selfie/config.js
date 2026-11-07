// ---------------------------------------------------------------------------
// config.js  (server-side, modul selfie / pap)
// Memuat selfie.config.json + default aman. Semua konstanta tuning ada di file JSON.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT_DIR, createLocalPaths, deepMerge, resolveManagedPaths, resolveSelfiePaths } from './localPaths.js';
import { SettingsStore } from '../settings/store.js';
import { CLOUD_IMAGE_ORIGIN, CLOUD_IMAGE_SECRET_ID, imageOverridesToSelfie } from '../settings/imageFields.js';

export { ROOT_DIR } from './localPaths.js';
const CONFIG_PATH = path.join(ROOT_DIR, 'selfie.config.json');

const DEFAULTS = {
  provider: 'auto',
  autoOrder: ['comfyui', 'comfyui-managed', 'sdcpp'],
  availabilityCacheMs: 30000,
  healthTimeoutMs: 1500,
  cloud: { accountId: '', model: '@cf/black-forest-labs/flux-2-klein-9b', healthTimeoutMs: 10000 },
  comfyUrl: 'http://127.0.0.1:8000',
  outputDir: '',
  autoCloseSeconds: 30,
  allowLan: false,
  filenamePrefix: 'waifu_selfie',
  jobTimeoutMs: 600000,
  freeVramAfter: true,
  maxQueue: 1,
  cooldownMs: 60000,
  dailyLimit: 20,
  preset: 'cepat',
  presets: {
    cepat: { resolution: 768, steps: 12, cfg: 3 },
    kualitas: { resolution: 1024, steps: 20, cfg: 3 },
    hemat: { resolution: 768, steps: 12, cfg: 3, sdcpp: { args: [], modelArgs: [] } },
  },
  referenceDir: 'assets/references',
  defaultReference: '',
  workflowFile: 'workflows/selfie.api.json',
  mappingFile: 'selfie.mapping.json',
  keywordsFile: 'config/selfieKeywords.json',
  characterCardFile: 'config/characterCard.json',
  moderationFile: 'config/selfieModeration.json',
  plannerTimeoutMs: 20000,
  pollIntervalMs: 1500,
  cacheRetries: 1,
  etaHistorySize: 5,
  etaStoreFile: 'data/selfie-durations.json',
  limitsStoreFile: 'data/selfie-limits.json',
  logFile: '${LOCAL}/logs/selfie.log',
  telemetry: { enabled: true, intervalMs: 2000, probeTimeoutMs: 1500 },
  comfyuiManaged: {
    installDir: '',
    pythonPath: '',
    mainScript: '',
    host: '127.0.0.1',
    port: 'auto',
    args: [],
    env: {},
    startTimeoutMs: 120000,
    idleStopSeconds: 90,
    healthPath: '/system_stats',
    profiles: {},
    profile: '',
  },
  phrases: {
    initial: ['Tunggu ya sayang, aku pose dulu sebentar...'],
    busy: ['Masih fotoin yang tadi ya sayang, tunggu sebentar yaa~'],
    cooldown: ['Baru aja selesai foto nih sayang, bentar ya napas dulu sebentar~'],
    dailyLimit: ['Wah hari ini udah banyak banget fotonya sayang, besok lagi yaa~'],
    providerUnavailable: ['Aduh sayang, sekarang aku belum bisa foto. Studio gambarku belum siap nih.'],
    failed: ['Yah sayang, fotonya gagal diproses nih. Nanti kita coba lagi yaa.'],
    cancelled: ['Oke sayang, pengambilan fotonya sudah aku batalkan yaa.'],
  },
  sdcpp: {
    binaryPath: '',
    diffusionModel: '',
    vae: '',
    llm: '',
    llmVision: null,
    allowCpu: false,
    forceRun: false,
    args: ['--sampling-method', 'euler', '--offload-to-cpu'],
    modelArgs: [],
    memory: {
      minFreeRamGB: 4, minFreeVramGB: 1, commitHeadroomGB: 8,
      computeBufferGB: 2.5, marginGB: 2, hardFailRatio: 0.6,
    },
    extraArgs: [],
    helpTimeoutMs: 5000,
    deviceTimeoutMs: 5000,
    stderrTailBytes: 8192,
  },
};

export const PROVIDERS = ['auto', 'comfyui', 'comfyui-managed', 'sdcpp', 'cloud'];
const LOCAL_PROVIDERS = ['comfyui', 'comfyui-managed', 'sdcpp'];

export function normalizeAutoCloseSeconds(value) {
  return Number.isFinite(value) && value >= 0 ? value : DEFAULTS.autoCloseSeconds;
}

function defaultUserDataDir(env = process.env) {
  if (env.SELFIE_USER_DATA_DIR) return path.resolve(env.SELFIE_USER_DATA_DIR);
  if (env.APPDATA) return path.join(env.APPDATA, 'Amika Desktop Companion');
  return path.join(os.homedir(), '.amika');
}

function normalizeManagedConfig(paths, ...sources) {
  if (sources.some(source => !source || typeof source !== 'object' || Array.isArray(source))) {
    throw new Error('selfie.config.json: comfyuiManaged must be an object.');
  }
  const options = Object.assign({}, ...sources);
  const fail = (key, requirement) => {
    throw new Error(`selfie.config.json: comfyuiManaged.${key} ${requirement}.`);
  };
  const stringValue = (key, value) => {
    if (typeof value !== 'string' || value.includes('\0')) fail(key, 'must be a string without null bytes');
    return value.trim();
  };
  const normalizeArgs = (values, key) => {
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || value.includes('\0'))) {
      fail(key, 'must be a string array');
    }
    return [...values];
  };
  options.installDir = paths.resolvePath(stringValue('installDir', options.installDir));
  for (const key of ['pythonPath', 'mainScript']) {
    options[key] = paths.resolvePath(stringValue(key, options[key]), { baseDir: options.installDir || paths.repoRoot });
  }
  options.host = stringValue('host', options.host);
  if (!['127.0.0.1', 'localhost', '::1'].includes(options.host)) fail('host', 'must be a loopback host');
  if (options.port !== 'auto' && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    fail('port', 'must be "auto" or an integer between 1 and 65535');
  }
  options.args = normalizeArgs(options.args, 'args');
  const env = Object.assign({}, ...sources.map(source => source.env));
  for (const source of sources) {
    if (source.env === undefined) continue;
    if (!source.env || typeof source.env !== 'object' || Array.isArray(source.env)) fail('env', 'must be an object');
  }
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) {
      fail('env', 'must map environment variable names to strings without null bytes');
    }
  }
  options.env = env;
  if (!Number.isInteger(options.startTimeoutMs) || options.startTimeoutMs < 1) fail('startTimeoutMs', 'must be a positive integer');
  if (!Number.isFinite(options.idleStopSeconds) || options.idleStopSeconds < 0) fail('idleStopSeconds', 'must be a nonnegative number');
  options.healthPath = stringValue('healthPath', options.healthPath);
  if (!/^\/(?!\/)[^?#\r\n]*$/.test(options.healthPath)) fail('healthPath', 'must be an absolute HTTP path');
  for (const source of sources) {
    if (source.profiles === undefined) continue;
    if (!source.profiles || typeof source.profiles !== 'object' || Array.isArray(source.profiles)) fail('profiles', 'must be an object');
  }
  options.profiles = Object.fromEntries(Object.entries(Object.assign({}, ...sources.map(source => source.profiles)))
    .map(([name, profile]) => {
      if (!name || /[\r\n\0]/.test(name) || !profile || typeof profile !== 'object' || Array.isArray(profile)) {
        fail('profiles', 'must map profile names to argument objects');
      }
      return [name, { args: normalizeArgs(profile.args ?? [], `profiles.${name}.args`) }];
    }));
  options.profile = stringValue('profile', options.profile);
  if (options.profile && !Object.hasOwn(options.profiles, options.profile)) {
    fail('profile', `names an unknown profile "${options.profile}"`);
  }
  return resolveManagedPaths(options, paths);
}

function normalizeSdcppArgs(options, label) {
  const result = {};
  for (const key of ['args', 'modelArgs']) {
    const values = options[key] ?? [];
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || value.includes('\0'))) {
      throw new Error(`selfie.config.json: ${label}.${key} must be a string array.`);
    }
    if (key === 'modelArgs' && values.some(value => value.indexOf('=') <= 0)) {
      throw new Error(`selfie.config.json: ${label}.modelArgs must contain key=value entries.`);
    }
    result[key] = [...values];
  }
  if (Object.hasOwn(options, 'initImage')) {
    const value = options.initImage;
    if (value !== null && (typeof value !== 'string' || value.includes('\0'))) {
      throw new Error(`selfie.config.json: ${label}.initImage must be an image path or "reference".`);
    }
    result.initImage = value === null ? null : value.trim();
  }
  if (Object.hasOwn(options, 'strength')) {
    const value = options.strength;
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`selfie.config.json: ${label}.strength must be between 0 and 1.`);
    }
    result.strength = value;
  }
  return result;
}

function normalizePreset(name, ...sources) {
  const merged = deepMerge(...sources);
  const resolution = Number(merged.resolution);
  const steps = Number(merged.steps);
  const cfg = Number(merged.cfg ?? 3);
  if (!Number.isInteger(resolution) || resolution <= 0 || resolution % 32 !== 0) {
    throw new Error(`selfie.config.json: preset "${name}" resolution must be a positive multiple of 32.`);
  }
  if (!Number.isInteger(steps) || steps <= 0 || !Number.isFinite(cfg) || cfg <= 0) {
    throw new Error(`selfie.config.json: preset "${name}" steps/cfg are invalid.`);
  }
  const providers = {};
  const providerSources = sources.map(source => source?.providers).filter(Boolean);
  for (const provider of LOCAL_PROVIDERS) {
    const override = Object.assign({}, ...providerSources.map(source => source?.[provider]).filter(Boolean));
    if (!Object.keys(override).length) continue;
    const normalized = {
      resolution: override.resolution === undefined ? resolution : Number(override.resolution),
      steps: override.steps === undefined ? steps : Number(override.steps),
      cfg: override.cfg === undefined ? cfg : Number(override.cfg),
    };
    if (!Number.isInteger(normalized.resolution) || normalized.resolution <= 0 || normalized.resolution % 32 !== 0
      || !Number.isInteger(normalized.steps) || normalized.steps <= 0
      || !Number.isFinite(normalized.cfg) || normalized.cfg <= 0) {
      throw new Error(`selfie.config.json: preset "${name}" override for ${provider} is invalid.`);
    }
    providers[provider] = normalized;
  }
  const sdcppSources = sources.map(source => source?.sdcpp).filter(Boolean);
  const sdcpp = sdcppSources.length
    ? normalizeSdcppArgs(Object.assign({}, ...sdcppSources), `presets.${name}.sdcpp`) : null;
  return { resolution, steps, cfg, providers, ...(sdcpp && { sdcpp }) };
}

/**
 * Muat konfigurasi. `overrides` (mis. dari CLI) menimpa isi file.
 * Melempar Error berpesan jelas bila provider/preset tidak valid.
 */
export function loadSelfieConfig(overrides = {}, { repoRoot = ROOT_DIR, env = process.env, settingsImages } = {}) {
  const paths = createLocalPaths({ repoRoot, env });
  let fileCfg = {};
  for (const filename of ['selfie.config.json', 'selfie.config.local.json']) {
    const configPath = path.join(paths.repoRoot, filename);
    if (!fs.existsSync(configPath)) continue;
    try {
      const source = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('must contain an object');
      fileCfg = deepMerge(fileCfg, source);
    } catch (err) {
      throw new Error(`${filename} is invalid: ${err.message}`);
    }
  }
  const savedImages = settingsImages ?? new SettingsStore({ localDir: paths.localDir }).read().images ?? {};
  const cleanOverrides = deepMerge(imageOverridesToSelfie(savedImages), Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined && value !== ''),
  ));
  const cfg = deepMerge(DEFAULTS, fileCfg, cleanOverrides);
  cfg.presets = {};
  for (const name of new Set([
    ...Object.keys(DEFAULTS.presets),
    ...Object.keys(fileCfg.presets || {}),
    ...Object.keys(cleanOverrides.presets || {}),
  ])) {
    cfg.presets[name] = normalizePreset(
      name,
      DEFAULTS.presets[name],
      fileCfg.presets?.[name],
      cleanOverrides.presets?.[name],
    );
  }
  Object.assign(cfg.sdcpp, normalizeSdcppArgs(cfg.sdcpp, 'sdcpp'));
  const offloadSource = [cleanOverrides.sdcpp, fileCfg.sdcpp]
    .find(source => source && Object.hasOwn(source, 'offloadToCpu'));
  cfg.sdcpp.offloadToCpu = offloadSource
    ? offloadSource.offloadToCpu : cfg.sdcpp.args.includes('--offload-to-cpu');
  cfg.sdcpp.memory = {
    ...DEFAULTS.sdcpp.memory, ...fileCfg.sdcpp?.memory, ...cleanOverrides.sdcpp?.memory,
  };
  cfg.telemetry = { ...DEFAULTS.telemetry, ...fileCfg.telemetry, ...cleanOverrides.telemetry };
  cfg.comfyuiManaged = normalizeManagedConfig(paths, DEFAULTS.comfyuiManaged,
    fileCfg.comfyuiManaged === undefined ? {} : fileCfg.comfyuiManaged,
    cleanOverrides.comfyuiManaged === undefined ? {} : cleanOverrides.comfyuiManaged);
  for (const key of ['allowCpu', 'forceRun', 'offloadToCpu']) {
    if (typeof cfg.sdcpp[key] !== 'boolean') throw new Error(`selfie.config.json: sdcpp.${key} must be boolean.`);
  }
  for (const [key, value] of Object.entries(cfg.sdcpp.memory)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`selfie.config.json: sdcpp.memory.${key} is invalid.`);
  }
  if (cfg.sdcpp.memory.hardFailRatio <= 0 || cfg.sdcpp.memory.hardFailRatio > 1) {
    throw new Error('selfie.config.json: sdcpp.memory.hardFailRatio must be greater than 0 and at most 1.');
  }
  if (typeof cfg.telemetry.enabled !== 'boolean') throw new Error('selfie.config.json: telemetry.enabled must be boolean.');
  for (const key of ['intervalMs', 'probeTimeoutMs']) {
    if (!Number.isInteger(cfg.telemetry[key]) || cfg.telemetry[key] < 1) {
      throw new Error(`selfie.config.json: telemetry.${key} must be a positive integer.`);
    }
  }
  if (!Array.isArray(cfg.autoOrder)) throw new Error('selfie.config.json: autoOrder must be an array.');
  cfg.autoOrder = [...new Set(cfg.autoOrder)];
  cfg.comfyUrl = String(cfg.comfyUrl).replace(/\/+$/, '');
  cfg.autoCloseSeconds = normalizeAutoCloseSeconds(cfg.autoCloseSeconds);

  if (!PROVIDERS.includes(cfg.provider)) {
    throw new Error(`selfie.config.json: provider "${cfg.provider}" tidak dikenal. Pilihan: ${PROVIDERS.join(', ')}`);
  }
  if (!cfg.autoOrder.length || cfg.autoOrder.some(provider => !LOCAL_PROVIDERS.includes(provider))) {
    throw new Error('selfie.config.json: autoOrder may contain only "comfyui", "comfyui-managed", and "sdcpp".');
  }
  if (!cfg.cloud || typeof cfg.cloud !== 'object' || Array.isArray(cfg.cloud)
    || typeof cfg.cloud.accountId !== 'string' || cfg.cloud.accountId && !/^[a-f0-9]{32}$/i.test(cfg.cloud.accountId)
    || cfg.cloud.model !== DEFAULTS.cloud.model || !Number.isInteger(cfg.cloud.healthTimeoutMs) || cfg.cloud.healthTimeoutMs < 1) {
    throw new Error('selfie.config.json: cloud account, model, or health timeout is invalid.');
  }
  for (const key of ['availabilityCacheMs', 'healthTimeoutMs', 'jobTimeoutMs']) {
    if (!Number.isFinite(cfg[key]) || cfg[key] < (key === 'availabilityCacheMs' ? 0 : 1)) {
      throw new Error(`selfie.config.json: ${key} is invalid.`);
    }
  }
  for (const key of ['helpTimeoutMs', 'deviceTimeoutMs', 'stderrTailBytes']) {
    if (!Number.isInteger(cfg.sdcpp[key]) || cfg.sdcpp[key] < 1) {
      throw new Error(`selfie.config.json: sdcpp.${key} must be a positive integer.`);
    }
  }
  if (!cfg.presets[cfg.preset]) {
    throw new Error(
      `selfie.config.json: preset "${cfg.preset}" tidak ada. Pilihan: ${Object.keys(cfg.presets).join(', ')}`,
    );
  }

  const explicitUserDataDir = cfg.userDataDir;
  cfg.rootDir = paths.repoRoot;
  cfg.localDir = paths.localDir;
  for (const [key, fileKey, fallback] of [
    ['etaStorePath', 'etaStoreFile', 'data/selfie-durations.json'],
    ['limitsStorePath', 'limitsStoreFile', 'data/selfie-limits.json'],
    ['logPath', 'logFile', '${LOCAL}/logs/selfie.log'],
    ['keywordsPath', 'keywordsFile', 'config/selfieKeywords.json'],
    ['characterCardPath', 'characterCardFile', 'config/characterCard.json'],
    ['moderationPath', 'moderationFile', 'config/selfieModeration.json'],
  ]) cfg[key] = paths.resolvePath(cfg[fileKey] || fallback);
  if (explicitUserDataDir) {
    cfg.userDataDir = paths.resolvePath(explicitUserDataDir);
    cfg.sdcppBaseDir = path.join(cfg.userDataDir, 'models', 'sdcpp');
  }
  const resolved = resolveSelfiePaths(cfg, { repoRoot: paths.repoRoot, env });
  Object.assign(cfg, resolved);
  cfg.userDataDir = explicitUserDataDir ? cfg.userDataDir : paths.resolvePath('', { fallback: defaultUserDataDir(env) });
  cfg.sdcppBaseDir ||= paths.modelsDir();
  cfg.sdcpp.llmVision ||= null;
  for (const options of [cfg.sdcpp, ...Object.values(cfg.presets).map(preset => preset.sdcpp).filter(Boolean)]) {
    if (options.initImage && options.initImage !== 'reference') {
      options.initImage = paths.resolvePath(options.initImage);
    }
  }
  cfg.sdcpp.extraArgs = Array.isArray(cfg.sdcpp.extraArgs) ? cfg.sdcpp.extraArgs.map(String) : [];
  if (cfg.provider === 'cloud' && !cfg.cloudCredentials) {
    let stored;
    cfg.cloudCredentials = async () => {
      if (!env.CLOUDFLARE_API_TOKEN) {
        stored ||= import('../settings/secretStore.js').then(({ SecretStore }) => new SecretStore({ localDir: paths.localDir,
          allowPlaintext: env.WAIFU_ALLOW_PLAINTEXT_SECRETS === '1' }).snapshot());
      }
      return { accountId: cfg.cloud.accountId || env.CLOUDFLARE_ACCOUNT_ID || '',
        token: env.CLOUDFLARE_API_TOKEN || (await stored)(CLOUD_IMAGE_SECRET_ID, CLOUD_IMAGE_ORIGIN)?.apiKey || '' };
    };
  }
  return cfg;
}

export function watchSelfieConfig(onChange, { debounceMs = 100, onError = () => {} } = {}) {
  let timer = null;
  const watcher = fs.watch(path.dirname(CONFIG_PATH), { persistent: false }, (_event, filename) => {
    if (filename && !['selfie.config.json', 'selfie.config.local.json'].includes(path.basename(String(filename)))) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        onChange(loadSelfieConfig());
      } catch (err) {
        onError(err);
      }
    }, debounceMs);
  });
  watcher.on('error', onError);
  watcher.unref?.();
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
