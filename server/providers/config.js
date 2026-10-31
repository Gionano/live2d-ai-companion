import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createLocalPaths, deepMerge, ROOT_DIR } from '../selfie/localPaths.js';
import { providerCapabilities } from './contracts.js';
import { capabilities as openai } from './adapters/openaiCompatible.js';
import { capabilities as anthropic } from './adapters/anthropicNative.js';
import { capabilities as fish } from './adapters/fishAudio.js';
import { validateBaseUrl, validateProviderHeaders } from './baseUrl.js';

export const ADAPTER_CAPABILITIES = { openaiCompatible: openai, anthropicNative: anthropic, fishAudio: fish };
export const SLOT_CAPABILITIES = { llm: 'llm', planner: 'llm', visionFilter: 'llm', vision: 'images', stt: 'stt', tts: 'tts' };
export const DEFAULT_CONFIG = JSON.parse(fs.readFileSync(new URL('../../providers.config.json', import.meta.url), 'utf8'));

function readConfig(filename) {
  try {
    const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
    return config;
  }
  catch (error) {
    if (error.code === 'ENOENT') return {};
    // JSON parser errors can contain file contents, including credentials.
    throw new Error('Provider configuration must be a readable JSON object. Check providers.config.local.json.');
  }
}

export function loadProvidersConfig({ repoRoot = ROOT_DIR, env = process.env,
  configPath = path.join(repoRoot, 'providers.config.json'), localPath = path.join(repoRoot, 'providers.config.local.json'),
  overrides = {} } = {}) {
  const shared = deepMerge(DEFAULT_CONFIG, readConfig(configPath));
  for (const profile of Object.values(shared.profiles ?? {})) {
    if (profile?.baseUrlEnv && env[profile.baseUrlEnv]) {
      profile.baseUrl = env[profile.baseUrlEnv].replace(/\/$/, '') + (profile.baseUrlEnvSuffix ?? '');
    }
  }
  for (const slot of Object.values(shared.slots ?? {})) {
    if (slot?.modelEnv && env[slot.modelEnv]) slot.model = env[slot.modelEnv];
  }
  const result = deepMerge(shared, readConfig(localPath), overrides);
  const paths = createLocalPaths({ repoRoot, env });
  const expand = value => typeof value === 'string' ? paths.expandLocal(value)
    : Array.isArray(value) ? value.map(expand)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) : value;
  return expand(result);
}

export function resolveSlot(config, slot) {
  const value = config.slots?.[slot];
  return value === undefined && ['planner', 'visionFilter'].includes(slot) ? config.slots?.llm : value;
}

export function effectiveProfile(config, slotConfig) {
  const profile = config.profiles?.[slotConfig?.profile];
  return profile ? deepMerge(profile, profile.models?.[slotConfig.model]) : undefined;
}

export function slotProblem(config, slot, resolver = { resolve: name => process.env[name] }) {
  if (!Object.hasOwn(SLOT_CAPABILITIES, slot)) return 'Unknown slot. Use llm, planner, vision, visionFilter, stt or tts.';
  const settings = resolveSlot(config, slot);
  if (!settings?.profile) return 'Slot is unconfigured. Set its profile and model in providers.config.local.json.';
  const profile = effectiveProfile(config, settings);
  if (!profile) return 'Unknown profile. Add the referenced profile to providers.config.local.json.';
  if (!Object.hasOwn(ADAPTER_CAPABILITIES, profile.adapter)) return 'Unknown adapter. Use openaiCompatible, anthropicNative or fishAudio.';
  if (typeof settings.model !== 'string' || !settings.model.trim() || settings.model.startsWith('REPLACE_WITH_')) {
    return 'Missing model. Replace the template value in slots.<slot>.model.';
  }
  const capabilities = providerCapabilities(ADAPTER_CAPABILITIES[profile.adapter], profile, settings.model);
  const operation = slot === 'vision' ? 'llm' : SLOT_CAPABILITIES[slot];
  const implementsOperation = operation === 'stt' ? profile.adapter === 'openaiCompatible'
    : ADAPTER_CAPABILITIES[profile.adapter][operation];
  if (!implementsOperation || !capabilities[SLOT_CAPABILITIES[slot]] || (slot === 'vision' && !capabilities.llm)) {
    return 'Adapter or model lacks the required slot capability. Choose a compatible profile or enable its supported capability flag.';
  }
  if (profile.apiKeyEnv != null) {
    if (typeof profile.apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/i.test(profile.apiKeyEnv)) return 'apiKeyEnv must name an environment variable.';
    try {
      if (!resolver.resolve(profile.apiKeyEnv)) return `Missing key environment variable ${profile.apiKeyEnv}. Set it in the backend environment.`;
    } catch { return 'The secret resolver could not read the configured key. Check the backend environment.'; }
  }
  try {
    validateBaseUrl(profile.baseUrl, { websocket: profile.adapter === 'fishAudio' });
    validateProviderHeaders(profile.extraHeaders);
  } catch (error) { return error.message; }
  for (const [key, value] of Object.entries(settings.timeouts ?? {})) {
    if (!['firstByteMs', 'idleMs', 'totalMs'].includes(key) || !Number.isFinite(value) || value < 0) {
      return 'timeouts must contain non-negative firstByteMs, idleMs and totalMs values in milliseconds.';
    }
  }
  return null;
}

export function validateConfig(config, resolver) {
  return Object.keys(SLOT_CAPABILITIES).flatMap(slot => {
    const reason = slotProblem(config, slot, resolver);
    return reason ? [{ slot, reason }] : [];
  });
}
