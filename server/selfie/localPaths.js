import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Objects merge recursively; arrays, null and scalar values replace earlier values. */
export function deepMerge(...sources) {
  const result = {};
  for (const source of sources) {
    if (!isObject(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      result[key] = isObject(value) ? deepMerge(isObject(result[key]) ? result[key] : {}, value)
        : Array.isArray(value) ? value.map(item => isObject(item) ? deepMerge(item) : item) : value;
    }
  }
  return result;
}

export function createLocalPaths({ repoRoot = ROOT_DIR, env = process.env } = {}) {
  repoRoot = path.resolve(repoRoot);
  const localDir = path.resolve(repoRoot, env.WAIFU_LOCAL_DIR?.trim() || 'local');
  const resolvePath = (value, { baseDir = repoRoot, fallback = '' } = {}) => {
    let normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) return fallback;
    normalized = normalized.replace(/\$\{LOCAL\}/g, localDir);
    if (normalized === '~' || /^~[/\\]/.test(normalized)) {
      normalized = path.join(os.homedir(), normalized.slice(1));
    }
    return path.isAbsolute(normalized) ? path.normalize(normalized) : path.resolve(baseDir, normalized);
  };
  const expandLocal = value => typeof value !== 'string' ? value : value.startsWith('${LOCAL}') ? resolvePath(value)
    : value.replace(/\$\{LOCAL\}/g, localDir);
  return {
    repoRoot, localDir, resolvePath, expandLocal,
    modelsDir: (kind = '') => path.join(localDir, 'models', kind),
    runtimeDir: engine => path.join(localDir, 'runtime', engine),
    outputsDir: () => path.join(localDir, 'outputs'),
    logsDir: () => path.join(localDir, 'logs'),
  };
}

function isDirectory(filename) {
  try { return fs.statSync(filename).isDirectory(); } catch { return false; }
}

function isFile(filename) {
  try { return fs.statSync(filename).isFile(); } catch { return false; }
}

export const RUNTIME_WARNING_MESSAGES = {
  LOCAL_COMFYUI_RUNTIME_FALLBACK: 'Local ComfyUI runtime is incomplete; using the explicitly configured legacy installation. Run npm run doctor.',
  LOCAL_SDCLI_RUNTIME_FALLBACK: 'Local sd-cli runtime is invalid; using the explicitly configured legacy binary. Run npm run doctor.',
};

export function inspectManagedRuntime(paths = createLocalPaths()) {
  const installDir = paths.runtimeDir('comfyui');
  const candidates = ['python_embeded/python.exe', 'python_embedded/python.exe', 'python_embeded/python', 'python_embedded/python']
    .map(value => path.join(installDir, value));
  const pythonPath = candidates.find(isFile) || candidates[0];
  const mainScript = path.join(installDir, 'ComfyUI', 'main.py');
  const missing = [pythonPath, mainScript].filter(value => !isFile(value));
  const exists = fs.existsSync(installDir);
  const valid = isDirectory(installDir) && missing.length === 0;
  const publicMissing = missing.map(value => path.relative(installDir, value).replace(/\\/g, '/'));
  return { exists, valid, installDir, pythonPath, mainScript, missing,
    code: valid ? 'READY' : 'LOCAL_COMFYUI_RUNTIME_MISSING',
    message: valid ? 'Local ComfyUI runtime files are present.' : `Local ComfyUI runtime is missing required files: ${missing.join(', ')}.`,
    publicMessage: valid ? 'Local ComfyUI runtime files are present.' : `Local ComfyUI runtime is missing: ${publicMissing.join(', ')}.`,
  };
}

export function inspectSdRuntimeStructure(paths = createLocalPaths()) {
  const engineRoot = paths.runtimeDir('sdcpp');
  const compatibilityRoot = paths.runtimeDir('sd-cli');
  const root = fs.existsSync(engineRoot) || !fs.existsSync(compatibilityRoot) ? engineRoot : compatibilityRoot;
  const variants = ['cuda12', 'vulkan'].filter(value => isDirectory(path.join(root, value)));
  let activeVariant = null;
  let markerError = null;
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(paths.localDir, 'installed.json'), 'utf8'));
    activeVariant = installed.activeVariants?.sdcpp || null;
    if (activeVariant && !['cuda12', 'vulkan'].includes(activeVariant)) markerError = 'The active sd-cli variant is not cuda12 or vulkan.';
  } catch (error) { if (error.code !== 'ENOENT') markerError = 'local/installed.json cannot be read as valid JSON.'; }
  const exists = fs.existsSync(root);
  const selectionRequired = exists && Boolean(markerError || (!activeVariant && variants.length > 1));
  const variant = selectionRequired ? null : activeVariant || variants[0] || null;
  const runtimeDir = variant ? path.join(root, variant) : root;
  const candidates = [process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli', 'sd-cli.exe',
    process.platform === 'win32' ? 'bin/sd-cli.exe' : 'bin/sd-cli', process.platform === 'win32' ? 'bin/sd-cli' : 'bin/sd-cli.exe']
    .map(value => path.join(runtimeDir, value));
  const binaryPath = selectionRequired ? '' : candidates.find(isFile) || candidates[0];
  const missing = selectionRequired ? [] : isFile(binaryPath) ? [] : [binaryPath];
  const structurallyValid = !selectionRequired && isDirectory(runtimeDir) && missing.length === 0;
  const code = selectionRequired ? 'SDCLI_VARIANT_SELECTION_REQUIRED' : structurallyValid ? 'READY' : 'LOCAL_SDCLI_BINARY_MISSING';
  const publicMessage = selectionRequired
    ? `${markerError || 'Multiple sd-cli variants exist without an active selection.'} Select one with npm run setup:sdcli -- --variant=cuda12 or --variant=vulkan.`
    : structurallyValid ? 'Local sd-cli binary is present.' : `Local sd-cli is missing: ${path.relative(paths.localDir, binaryPath).replace(/\\/g, '/')}.`;
  return { exists, valid: false, structurallyValid, root, runtimeDir, binaryPath, variant, variants, missing, selectionRequired,
    code, publicMessage, message: selectionRequired ? publicMessage : structurallyValid ? publicMessage : `Local sd-cli is missing: ${missing.join(', ')}.` };
}

export function resolveManagedPaths(settings = {}, paths = createLocalPaths()) {
  const local = inspectManagedRuntime(paths);
  const legacy = settings._legacyPaths || {
    installDir: paths.resolvePath(settings.installDir),
    pythonPath: paths.resolvePath(settings.pythonPath, { baseDir: paths.resolvePath(settings.installDir) || paths.repoRoot }),
    mainScript: paths.resolvePath(settings.mainScript, { baseDir: paths.resolvePath(settings.installDir) || paths.repoRoot }),
  };
  const hasLegacy = Boolean(legacy.installDir || legacy.pythonPath || legacy.mainScript);
  const selected = local.valid || (local.exists && !hasLegacy) ? local : legacy;
  const { installDir, pythonPath, mainScript } = selected;
  const warnings = local.exists && !local.valid && hasLegacy
    ? [{ code: 'LOCAL_COMFYUI_RUNTIME_FALLBACK', message: RUNTIME_WARNING_MESSAGES.LOCAL_COMFYUI_RUNTIME_FALLBACK }] : [];
  const expand = paths.expandLocal;
  return { ...settings, installDir, pythonPath, mainScript, _legacyPaths: legacy, _localRuntime: local, _runtimeWarnings: warnings,
    ...(Array.isArray(settings.args) && { args: settings.args.map(expand) }),
    ...(settings.profiles && { profiles: Object.fromEntries(Object.entries(settings.profiles).map(([name, profile]) =>
      [name, { ...profile, ...(Array.isArray(profile.args) && { args: profile.args.map(expand) }) }])) }),
    ...(settings.env && { env: Object.fromEntries(Object.entries(settings.env).map(([name, value]) => [name, expand(value)])) }),
  };
}

export function resolveSdCliBinary(value, paths = createLocalPaths(), { baseDir = paths.repoRoot } = {}) {
  const local = inspectSdRuntimeStructure(paths);
  const legacy = paths.resolvePath(value, { baseDir });
  return local.structurallyValid ? local.binaryPath : legacy || (local.exists ? local.binaryPath : '');
}

/** Apply path rules to both loaded and directly constructed provider configurations. */
export function resolveSelfiePaths(cfg = {}, { repoRoot = cfg.rootDir || ROOT_DIR, env = process.env } = {}) {
  const paths = createLocalPaths({ repoRoot, env: { ...env,
    WAIFU_LOCAL_DIR: env.WAIFU_LOCAL_DIR || cfg.localDir || '' } });
  const result = { ...cfg, rootDir: paths.repoRoot, localDir: paths.localDir };
  result.outputDir = paths.resolvePath(cfg.outputDir, { fallback: paths.outputsDir() });
  result.referenceDir = paths.resolvePath(cfg.referenceDir, { fallback: path.join(paths.repoRoot, 'assets', 'references') });
  for (const [key, fileKey, fallback] of [
    ['workflowPath', 'workflowFile', 'workflows/selfie.api.json'],
    ['mappingPath', 'mappingFile', 'selfie.mapping.json'],
  ]) result[key] = paths.resolvePath(cfg[key] || cfg[fileKey], { fallback: path.join(paths.repoRoot, fallback) });
  if (cfg.logPath || cfg.logFile) result.logPath = paths.resolvePath(cfg.logPath || cfg.logFile);
  if (cfg.comfyuiManaged) result.comfyuiManaged = resolveManagedPaths(cfg.comfyuiManaged, paths);
  if (cfg.sdcpp) {
    result.sdcpp = { ...cfg.sdcpp };
    const legacyBase = cfg.sdcppBaseDir || (cfg.userDataDir
      ? path.join(paths.resolvePath(cfg.userDataDir), 'models', 'sdcpp') : null);
    result.sdcpp._legacyBinaryPath = Object.hasOwn(cfg.sdcpp, '_legacyBinaryPath') ? cfg.sdcpp._legacyBinaryPath
      : paths.resolvePath(cfg.sdcpp.binaryPath, { baseDir: legacyBase || paths.repoRoot });
    result.sdcpp.binaryPath = resolveSdCliBinary(result.sdcpp._legacyBinaryPath, paths, { baseDir: legacyBase || paths.repoRoot });
    for (const [key, kind] of Object.entries({ diffusionModel: 'diffusion_models', vae: 'vae', llm: 'text_encoders', llmVision: 'text_encoders' })) {
      result.sdcpp[key] = cfg.sdcpp[key] === null ? null
        : paths.resolvePath(cfg.sdcpp[key], { baseDir: legacyBase || paths.modelsDir(kind) });
    }
    if (cfg.sdcpp.initImage && cfg.sdcpp.initImage !== 'reference') {
      result.sdcpp.initImage = paths.resolvePath(cfg.sdcpp.initImage);
    }
    for (const key of ['args', 'extraArgs', 'modelArgs']) {
      if (Array.isArray(cfg.sdcpp[key])) result.sdcpp[key] = cfg.sdcpp[key].map(paths.expandLocal);
    }
  }
  if (cfg.presets) {
    result.presets = Object.fromEntries(Object.entries(cfg.presets).map(([name, preset]) => {
      if (!preset.sdcpp) return [name, preset];
      const sd = { ...preset.sdcpp };
      if (sd.initImage && sd.initImage !== 'reference') sd.initImage = paths.resolvePath(sd.initImage);
      for (const key of ['args', 'modelArgs']) {
        if (Array.isArray(sd[key])) sd[key] = sd[key].map(paths.expandLocal);
      }
      return [name, { ...preset, sdcpp: sd }];
    }));
  }
  return result;
}
