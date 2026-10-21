// ---------------------------------------------------------------------------
// config.js  (server-side, modul selfie / pap)
// Memuat selfie.config.json + default aman. Semua konstanta tuning ada di file JSON.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG_PATH = path.join(ROOT_DIR, 'selfie.config.json');

const DEFAULTS = {
  provider: 'comfyui',
  comfyUrl: 'http://127.0.0.1:8000',
  outputDir: '',
  filenamePrefix: 'waifu_selfie',
  jobTimeoutMs: 600000,
  freeVramAfter: true,
  maxQueue: 1,
  cooldownMs: 60000,
  dailyLimit: 20,
  preset: 'cepat',
  presets: {
    cepat: { resolution: 768, steps: 12 },
    kualitas: { resolution: 1024, steps: 20 },
  },
  referenceDir: 'assets/references',
  defaultReference: '',
  workflowFile: 'workflows/selfie.api.json',
  mappingFile: 'selfie.mapping.json',
  keywordsFile: 'config/selfieKeywords.json',
  characterCardFile: 'config/characterCard.json',
  moderationFile: 'config/selfieModeration.json',
  plannerTimeoutMs: 20000,
  healthCheckTimeoutMs: 3000,
  pollIntervalMs: 1500,
  cacheRetries: 1,
  etaHistorySize: 5,
  etaStoreFile: 'data/selfie-durations.json',
  sdcpp: {},
};

export const PROVIDERS = ['comfyui', 'sdcpp', 'cloud'];

function resolveDir(value, fallback) {
  const v = (value || '').trim();
  if (!v) return fallback;
  if (v === '~' || v.startsWith('~/') || v.startsWith('~\\')) {
    return path.join(os.homedir(), v.slice(1));
  }
  return path.isAbsolute(v) ? v : path.resolve(ROOT_DIR, v);
}

/**
 * Muat konfigurasi. `overrides` (mis. dari CLI) menimpa isi file.
 * Melempar Error berpesan jelas bila provider/preset tidak valid.
 */
export function loadSelfieConfig(overrides = {}) {
  let fileCfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      throw new Error(`selfie.config.json tidak valid: ${err.message}`);
    }
  }
  const cfg = {
    ...DEFAULTS,
    ...fileCfg,
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined && v !== '')),
  };
  cfg.presets = { ...DEFAULTS.presets, ...(fileCfg.presets || {}) };
  cfg.sdcpp = { ...(fileCfg.sdcpp || {}) };
  cfg.comfyUrl = String(cfg.comfyUrl).replace(/\/+$/, '');

  if (!PROVIDERS.includes(cfg.provider)) {
    throw new Error(`selfie.config.json: provider "${cfg.provider}" tidak dikenal. Pilihan: ${PROVIDERS.join(', ')}`);
  }
  if (!cfg.presets[cfg.preset]) {
    throw new Error(
      `selfie.config.json: preset "${cfg.preset}" tidak ada. Pilihan: ${Object.keys(cfg.presets).join(', ')}`,
    );
  }

  cfg.outputDir = resolveDir(cfg.outputDir, path.join(os.homedir(), 'Pictures', 'WaifuSelfies'));
  cfg.referenceDir = resolveDir(cfg.referenceDir, path.join(ROOT_DIR, 'assets', 'references'));
  cfg.workflowPath = resolveDir(cfg.workflowFile, path.join(ROOT_DIR, 'workflows', 'selfie.api.json'));
  cfg.mappingPath = resolveDir(cfg.mappingFile, path.join(ROOT_DIR, 'selfie.mapping.json'));
  cfg.etaStorePath = resolveDir(cfg.etaStoreFile, path.join(ROOT_DIR, 'data', 'selfie-durations.json'));
  cfg.keywordsPath = resolveDir(cfg.keywordsFile, path.join(ROOT_DIR, 'config', 'selfieKeywords.json'));
  cfg.characterCardPath = resolveDir(cfg.characterCardFile, path.join(ROOT_DIR, 'config', 'characterCard.json'));
  cfg.moderationPath = resolveDir(cfg.moderationFile, path.join(ROOT_DIR, 'config', 'selfieModeration.json'));
  return cfg;
}
