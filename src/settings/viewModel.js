import { validateBaseUrl } from '../../server/providers/baseUrl.js';
export { validateBaseUrl };
export const SLOT_LABELS = { llm: 'slot.llm', vision: 'slot.vision', stt: 'slot.stt', tts: 'slot.tts', planner: 'slot.planner', visionFilter: 'slot.visionFilter' };
export const TAB_LABELS = { connections: 'tab.connections', status: 'tab.status', privacy: 'tab.privacy', diagnostics: 'tab.diagnostics', language: 'tab.language' };
export const ERROR_KEYS = { CONFLICT: 'error.conflict', ORIGIN_CHANGE: 'error.origin', IN_USE: 'error.inUse',
  FORBIDDEN: 'error.forbidden', AUTH: 'error.auth', RATE_LIMIT: 'error.rate', TIMEOUT: 'error.timeout',
  LOCK_BUSY: 'error.lockBusy', LOCK_UNKNOWN: 'error.lockUnknown', LOCK_RECOVERY: 'error.lockRecovery',
  READ_ONLY: 'error.readOnly', INVALID_SETTINGS: 'error.invalid', NETWORK: 'error.network' };
export const friendlyError = code => ERROR_KEYS[code] || 'error.generic';
export const STATUS_WARNING_KEYS = { SECRET_STORAGE: 'warning.secretStorage', SETTINGS_RECOVERED: 'warning.recovered' };
export function canOpenSettings({ hostname, mobile = false }) {
  return !mobile && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(String(hostname).toLowerCase());
}
export function profileOrigin(profile) {
  try { return validateBaseUrl(profile.baseUrl, { websocket: profile.adapter === 'fishAudio' }).origin; } catch { return ''; }
}
export function originNeedsConfirmation(previous, next, metadata) {
  return profileOrigin(previous || {}) !== profileOrigin(next) && (metadata?.apiKey?.has
    || Object.values(metadata?.headers || {}).some(item => item.has) || metadata?.bodyExtras?.has
    || Object.values(metadata?.slotBodyExtras || {}).some(item => item.has));
}
export function parseAdvanced(value) {
  let parsed;
  try { parsed = JSON.parse(value || '{}'); } catch { throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some(key => !['bodyExtras', 'omitParams'].includes(key))
    || parsed.omitParams != null && (!Array.isArray(parsed.omitParams) || parsed.omitParams.some(item => typeof item !== 'string'))) {
    throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' });
  }
  const scan = (data, depth = 0) => {
    if (depth > 6) throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' });
    if (data && typeof data === 'object') for (const [key, item] of Object.entries(data)) {
      if (/^(?:__proto__|constructor|prototype)$|safety|moderat|persona|system|messages|instructions|tools/i.test(key)) throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' });
      scan(item, depth + 1);
    }
  };
  scan(parsed);
  return { value: parsed, credentials: /key|token|secret|password|authorization|credential|cookie/i.test(value) };
}
export function makeSlot(fields, previous = {}) {
  if (!fields.profile || !fields.model?.trim()) throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' });
  const slot = { ...previous, profile: fields.profile, model: fields.model.trim(), params: { ...previous.params }, timeouts: {} };
  for (const [key, max] of [['temperature', 2], ['maxTokens', 1000000]]) {
    if (fields[key] !== '') {
      const number = Number(fields[key]);
      if (!Number.isFinite(number) || number < (key === 'maxTokens' ? 1 : 0) || number > max) throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' });
      slot.params[key] = number;
    }
  }
  for (const key of ['language', 'voice', 'format']) if (fields[key] !== undefined) slot.params[key] = fields[key];
  for (const key of ['firstByteMs', 'idleMs', 'totalMs']) {
    const value = Number(fields[key]);
    if (!Number.isFinite(value) || value < 0 || value > 300000) throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' });
    slot.timeouts[key] = value;
  }
  return { ...slot, params: { ...slot.params, ...parseAdvanced(fields.advanced).value } };
}
export function privacyFlows(settings) {
  return [['privacy.microphone', 'stt', '#mic-status'], ['privacy.chat', 'llm', '#chat-form'],
    ['privacy.frames', 'vision', '#screen-share-btn'], ['privacy.spoken', 'tts', '#mic-status']].map(([label, slot, toggle]) => ({
    label, origin: profileOrigin(settings.profiles?.[settings.slots?.[slot]?.profile] || {}), toggle,
  }));
}
export async function withSecret(field, operation) {
  let value = field.value;
  field.value = '';
  try { return await operation(value); } finally { value = ''; field.value = ''; }
}
