import { validateBaseUrl, validateProviderHeaders } from '../providers/baseUrl.js';

export const SETTINGS_LIMIT = 64 * 1024;
export const SLOT_NAMES = ['llm', 'planner', 'vision', 'visionFilter', 'stt', 'tts'];
export const ADAPTER_NAMES = ['openaiCompatible', 'anthropicNative', 'fishAudio'];
export const PROFILE_FIELDS = ['id', 'adapter', 'baseUrl', 'apiKeyEnv', 'flags', 'headerNames',
  'bodyExtras', 'omitParams', 'capabilities', 'anthropicVersion', 'defaultMaxTokens', 'models'];
export const MODEL_FIELDS = ['flags', 'capabilities', 'bodyExtras', 'omitParams', 'anthropicVersion', 'defaultMaxTokens'];
export const FLAGS = ['supportsImages', 'supportsStt', 'supportsVerboseStt', 'supportsJsonMode', 'supportsStreamUsage'];
export const CAPABILITIES = ['llm', 'images', 'jsonMode', 'stt', 'tts'];
export const PARAMS = ['temperature', 'maxTokens', 'json', 'language', 'prompt', 'voice', 'format', 'bodyExtras', 'omitParams'];
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'safety', 'moderation', 'selfiemoderation',
  'persona', 'personality', 'system', 'instructions', 'messages', 'tools', 'toolchoice']);

export class SettingsError extends Error {
  constructor(code, status = 400) {
    const messages = {
      INVALID_SETTINGS: 'Settings do not match the supported schema.',
      CONFLICT: 'Settings changed. Reload the current version and retry.',
      LOCK_BUSY: 'Another settings writer is active. Wait and retry.',
      LOCK_UNKNOWN: 'Lock ownership cannot be verified. Stop all writers and inspect the lock locally.',
      LOCK_RECOVERY: 'Lock recovery is active or interrupted. Retry; if it persists, stop all writers and inspect the recovery guard locally.',
      TOO_LARGE: 'Settings exceed the size limit.',
      STORAGE: 'Settings storage is unavailable.',
      SECRET_STORAGE: 'Secret storage is unavailable or could not be decrypted.',
      READ_ONLY: 'This secret backend is read-only.',
      ORIGIN_CHANGE: 'Changing the origin requires replacement secrets or confirmation to delete the old secrets.',
      IN_USE: 'A slot still uses this profile. Reassign it or explicitly force deletion.',
      NOT_FOUND: 'The requested settings entry does not exist.',
      FORBIDDEN: 'Settings require an authorized same-origin loopback request.',
      RATE_LIMIT: 'Too many provider tests. Try again later.',
      TIMEOUT: 'The provider test exceeded its deadline.',
    };
    super(messages[code] || messages.INVALID_SETTINGS);
    this.code = code;
    this.status = status;
  }
}

export const invalid = () => { throw new SettingsError('INVALID_SETTINGS'); };
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function object(value, allowed) {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
  return value;
}
export function bounded(value, maximum = SETTINGS_LIMIT) {
  if (Buffer.byteLength(JSON.stringify(value)) > maximum) throw new SettingsError('TOO_LARGE', 413);
  return value;
}
export function isCredentialName(name) {
  return /(?:key|token|secret|password|passwd|authorization|credential|cookie)/i.test(name);
}
export function looksLikeSecret(value) {
  return typeof value === 'string' && /(?:\bBearer\s+\S+|\b(?:sk-|gsk_|gh[pousr]_|github_pat_|hf_|AIza)[a-z0-9_-]{12,})/i.test(value);
}
export function looksLikeLocalPath(value) {
  return typeof value === 'string' && /(?:\\\\|\$\{LOCAL\}|file:\/\/|(?:^|[\s"'=(])(?:[a-z]:[\\/]|~[\\/]|\/(?!\/)[^\s]))/i.test(value);
}
export function text(value, max = 512) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)
    || looksLikeSecret(value) || looksLikeLocalPath(value)) invalid();
  return value;
}
export function identifier(value) {
  text(value, 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) || UNSAFE_KEYS.has(value.toLowerCase())) invalid();
  return value;
}
export function headerName(value) {
  text(value, 80);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(value)) invalid();
  try { validateProviderHeaders({ [value]: 'fixture' }); } catch { invalid(); }
  return value.toLowerCase();
}
function strings(value, validator = text) {
  if (!Array.isArray(value) || value.length > 32) invalid();
  value.forEach(item => validator(item));
}
function booleans(value, names) {
  object(value, names);
  if (Object.values(value).some(item => typeof item !== 'boolean')) invalid();
}
function number(value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) invalid();
}
function omittedParam(value) {
  text(value, 80);
  const normalized = value.replace(/[_-]/g, '').toLowerCase();
  if (UNSAFE_KEYS.has(value) || UNSAFE_KEYS.has(normalized) || /safety|moderat|persona|systemprompt/.test(normalized)) invalid();
}

// Explicit extension map: credentials are separated before non-secret persistence.
export function splitExtras(value = {}, { allowSecrets = false, depth = 0 } = {}) {
  if (value === null) return { publicValues: null, secrets: {} };
  if (!isObject(value) || depth > 6 || Object.keys(value).length > 64) invalid();
  const publicValues = {};
  const secrets = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/g, '').toLowerCase();
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(key) || UNSAFE_KEYS.has(key) || UNSAFE_KEYS.has(normalized)
      || /safety|moderat|persona|systemprompt/.test(normalized)) invalid();
    if (isCredentialName(key) || looksLikeSecret(item)) {
      if (!allowSecrets || typeof item !== 'string' || !item || item.length > 8192) invalid();
      secrets[key] = item;
    } else if (isObject(item)) {
      const nested = splitExtras(item, { allowSecrets, depth: depth + 1 });
      if (Object.keys(nested.publicValues).length) publicValues[key] = nested.publicValues;
      if (Object.keys(nested.secrets).length) secrets[key] = nested.secrets;
    } else if (item === null || typeof item === 'boolean' || Number.isFinite(item)) publicValues[key] = item;
    else if (typeof item === 'string') publicValues[key] = text(item, 2048);
    else invalid();
  }
  return { publicValues, secrets };
}

export function validateProfile(value, { allowSecrets = false } = {}) {
  object(value, PROFILE_FIELDS);
  if (!ADAPTER_NAMES.includes(value.adapter)) invalid();
  try { validateBaseUrl(value.baseUrl, { websocket: value.adapter === 'fishAudio' }); } catch { invalid(); }
  if (value.id !== undefined) identifier(value.id);
  if (value.apiKeyEnv != null && (typeof value.apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,79}$/.test(value.apiKeyEnv))) invalid();
  if (value.flags !== undefined) booleans(value.flags, FLAGS);
  if (value.capabilities !== undefined) booleans(value.capabilities, CAPABILITIES);
  if (value.headerNames !== undefined) strings(value.headerNames, headerName);
  if (value.omitParams !== undefined) strings(value.omitParams, omittedParam);
  if (value.anthropicVersion !== undefined && (typeof value.anthropicVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.anthropicVersion))) invalid();
  if (value.defaultMaxTokens !== undefined) number(value.defaultMaxTokens, 1, 1000000);
  if (value.models !== undefined) {
    if (!isObject(value.models) || Object.keys(value.models).length > 32) invalid();
    for (const [model, override] of Object.entries(value.models)) {
      text(model, 256);
      if (!model.trim()) invalid();
      if (UNSAFE_KEYS.has(model)) invalid();
      object(override, MODEL_FIELDS);
      // Per-model options cannot change credential routing or carry credentials.
      validateProfile({ adapter: value.adapter, baseUrl: value.baseUrl, ...override });
    }
  }
  const result = structuredClone(value);
  const extras = splitExtras(value.bodyExtras, { allowSecrets });
  if (value.bodyExtras !== undefined) result.bodyExtras = extras.publicValues;
  if (result.headerNames) result.headerNames = [...new Set(result.headerNames.map(headerName))];
  return { profile: bounded(result), secrets: extras.secrets };
}

export function validateSlot(value, { allowSecrets = false } = {}) {
  if (value === null) return { slot: null, secrets: {} };
  if (value?.followLlm === true) { object(value, ['followLlm']); return { slot: { followLlm: true }, secrets: {} }; }
  object(value, ['profile', 'model', 'params', 'timeouts']);
  identifier(value.profile);
  if (!text(value.model, 256).trim() || value.model.startsWith('REPLACE_WITH_')) invalid();
  const result = structuredClone(value);
  const params = value.params === undefined ? {} : value.params;
  object(params, PARAMS);
  if (params.temperature != null) number(params.temperature, 0, 2);
  if (params.maxTokens != null) number(params.maxTokens, 1, 1000000);
  if (params.json !== undefined && typeof params.json !== 'boolean') invalid();
  for (const key of ['language', 'prompt', 'voice', 'format']) if (params[key] !== undefined) text(params[key], key === 'prompt' ? 2048 : 256);
  if (params.omitParams != null) strings(params.omitParams, omittedParam);
  const extras = splitExtras(params.bodyExtras, { allowSecrets });
  if (params.bodyExtras !== undefined) result.params.bodyExtras = extras.publicValues;
  if (value.timeouts !== undefined) {
    object(value.timeouts, ['firstByteMs', 'idleMs', 'totalMs']);
    Object.values(value.timeouts).forEach(item => number(item, 0, 300000));
  }
  return { slot: bounded(result), secrets: extras.secrets };
}

export const emptySettings = () => ({ schemaVersion: 1, version: 0, profiles: {}, slots: {}, ui: { language: 'id' } });
export function validateDocument(value, { persisted = false } = {}) {
  bounded(value);
  object(value, persisted ? ['schemaVersion', 'version', 'profiles', 'slots', 'ui'] : ['schemaVersion', 'profiles', 'slots', 'ui']);
  if (value.schemaVersion !== 1) invalid();
  if (persisted && (!Number.isSafeInteger(value.version) || value.version < 0)) invalid();
  if (!isObject(value.profiles) || Object.keys(value.profiles).length > 32) invalid();
  for (const [id, profile] of Object.entries(value.profiles)) {
    identifier(id);
    if (profile !== null) {
      validateProfile(profile);
      if (profile.id !== undefined && profile.id !== id) invalid();
    }
  }
  object(value.slots, SLOT_NAMES);
  Object.entries(value.slots).forEach(([name, slot]) => {
    validateSlot(slot);
    if (slot?.followLlm && !['planner', 'visionFilter'].includes(name)) invalid();
  });
  object(value.ui, ['language']);
  if (!['id', 'en'].includes(value.ui.language)) invalid();
  return structuredClone(value);
}
