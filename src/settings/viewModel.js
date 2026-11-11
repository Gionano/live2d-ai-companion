import { validateBaseUrl } from '../../server/providers/baseUrl.js';
import { DEFAULT_TTS_PARAMS } from '../../server/ttsExpression.js';
import { DEFAULT_ELEVENLABS_PARAMS, ELEVENLABS_MODELS, isElevenLabsVoice, resolveElevenLabsParams } from '../../server/elevenLabsTts.js';
import { FISH_EMOTION_GROUPS, FISH_EMOTION_NAMES, FISH_EMOTION_TAGS } from '../../server/fishEmotionTags.js';
export { validateBaseUrl };
export { DEFAULT_TTS_PARAMS };
export { DEFAULT_ELEVENLABS_PARAMS, ELEVENLABS_MODELS };
export { FISH_EMOTION_GROUPS, FISH_EMOTION_TAGS };
export const SLOT_LABELS = { llm: 'slot.llm', surface: 'slot.surface', reflection: 'slot.reflection', router: 'slot.router', vision: 'slot.vision', stt: 'slot.stt', tts: 'slot.tts', planner: 'slot.planner', visionFilter: 'slot.visionFilter', memoryWriter: 'slot.memoryWriter', memoryEmbedding: 'slot.memoryEmbedding' };
export const TAB_LABELS = { chat: 'tab.chat', voice: 'tab.voice', vision: 'tab.vision', images: 'tab.images', memory: 'tab.memory', connections: 'tab.connections', language: 'tab.language', status: 'tab.status', privacy: 'tab.privacy', diagnostics: 'tab.diagnostics' };
export const ERROR_KEYS = { CONFLICT: 'error.conflict', ORIGIN_CHANGE: 'error.origin', IN_USE: 'error.inUse',
  FORBIDDEN: 'error.forbidden', AUTH: 'error.auth', RATE_LIMIT: 'error.rate', TIMEOUT: 'error.timeout',
  LOCK_BUSY: 'error.lockBusy', LOCK_UNKNOWN: 'error.lockUnknown', LOCK_RECOVERY: 'error.lockRecovery',
  READ_ONLY: 'error.readOnly', INVALID_SETTINGS: 'error.invalid', NETWORK: 'error.network',
  INVALID_MEMORY: 'error.invalid', MEMORY_STALE: 'error.conflict', MEMORY_STORAGE: 'error.generic', MEMORY_CORRUPT: 'error.generic',
  LEGACY_MEMORY_CORRUPT: 'error.generic', LEGACY_MEMORY_CHANGED: 'error.conflict', REINDEX_REQUIRED: 'memory.reindexRequired' };
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
    if (fields[key] !== '' && fields[key] !== undefined) {
      const number = Number(fields[key]);
      if (!Number.isFinite(number) || number < (key === 'maxTokens' ? 1 : 0) || number > max) throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' });
      slot.params[key] = number;
    }
  }
  for (const key of ['language', 'voice', 'format']) if (fields[key] !== undefined) slot.params[key] = fields[key];
  if (fields.format !== undefined && !['mp3', 'wav', 'pcm', 'opus'].includes(fields.format)) {
    throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' });
  }
  if (fields.tts) Object.assign(slot.params, makeTtsParams(fields.tts, previous.params));
  if (fields.ttsTiming) slot.params.expression = makeTtsTiming(fields.ttsTiming, previous.params?.expression);
  if (fields.elevenLabs) {
    if (!ELEVENLABS_MODELS.includes(slot.model) || fields.format !== 'mp3' || !isElevenLabsVoice(fields.voice)) {
      throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' });
    }
    slot.params.elevenLabs = makeElevenLabsParams(fields.elevenLabs, previous.params?.elevenLabs, slot.model);
  }
  if (fields.adapter === 'fishAudio' && fields.voice !== undefined) {
    if (typeof fields.voice !== 'string') throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' });
    const voice = fields.voice.trim();
    if (voice) slot.params.voice = voice;
    else delete slot.params.voice;
  }
  for (const key of ['firstByteMs', 'idleMs', 'totalMs']) {
    const value = Number(fields[key]);
    if (!Number.isFinite(value) || value < 0 || value > 300000) throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' });
    slot.timeouts[key] = value;
  }
  return { ...slot, params: { ...slot.params, ...parseAdvanced(fields.advanced).value } };
}
export function makeElevenLabsParams(fields, previous = {}, model) {
  const invalid = () => { throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' }); };
  const numeric = key => {
    if (fields[key] === '' || fields[key] === undefined) invalid();
    const value = Number(fields[key]);
    if (!Number.isFinite(value)) invalid();
    return value;
  };
  const overrides = { stability: numeric('stability'), emotionTags: fields.emotionTags };
  for (const key of ['similarityBoost', 'speed']) if (fields[key] !== undefined) overrides[key] = numeric(key);
  try { return resolveElevenLabsParams(previous, overrides, model); }
  catch { return invalid(); }
}
export function makeTtsTiming(fields, previous = {}) {
  const invalid = () => { throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' }); };
  const numeric = (key, min, max) => {
    if (fields[key] === '' || fields[key] === undefined) invalid();
    const value = Number(fields[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) invalid();
    return value;
  };
  if (typeof fields.earlyFirstSentence !== 'boolean' || typeof fields.mergeEnabled !== 'boolean') invalid();
  const minChars = numeric('minChars', 1, 1000);
  const maxChars = numeric('maxChars', 1, 4000);
  if (minChars > maxChars) invalid();
  return { ...previous, earlyFirstSentence: fields.earlyFirstSentence,
    segmentPauseMs: numeric('segmentPauseMs', 0, 400), sentencePauseMs: numeric('sentencePauseMs', 0, 400),
    mergeShortSentences: { ...previous.mergeShortSentences, enabled: fields.mergeEnabled, minChars, maxChars } };
}
export function makeTtsParams(fields, previous = {}) {
  const invalid = () => { throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' }); };
  const numeric = (key, min, max, integer = false) => {
    if (fields[key] === '' || fields[key] === undefined) invalid();
    const value = Number(fields[key]);
    if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) invalid();
    return value;
  };
  const topP = numeric('topP', 0, 1);
  const selection = fields.selection === undefined
    ? previous.expression?.selection ?? DEFAULT_TTS_PARAMS.expression.selection : fields.selection;
  if (topP === 0 || !['normal', 'balanced', 'low'].includes(fields.latency)
    || !['every-sentence', 'first-only'].includes(fields.tagPlacement)
    || !['native', 'mapped'].includes(selection)) invalid();
  let emotionTagMap;
  try { emotionTagMap = JSON.parse(fields.emotionTagMap); } catch { invalid(); }
  const emotions = new Set([...Object.keys(DEFAULT_TTS_PARAMS.expression.emotionTagMap), ...FISH_EMOTION_NAMES, 'shy', 'neutral']);
  if (!emotionTagMap || typeof emotionTagMap !== 'object' || Array.isArray(emotionTagMap)
    || Object.entries(emotionTagMap).some(([emotion, tags]) => !emotions.has(emotion)
      || (Array.isArray(tags) ? tags : [tags]).length > 8
      || (Array.isArray(tags) ? tags : [tags]).some(tag => typeof tag !== 'string' || tag.length > 256
        || !/^(?:\[[^\[\]\x00-\x1f\x7f]{1,80}\]\s*)+$/.test(tag)))) invalid();
  const minChars = numeric('minChars', 1, 1000, true);
  const maxChars = numeric('maxChars', 1, 4000, true);
  if (maxChars < minChars) invalid();
  const earlyFirstSentence = fields.earlyFirstSentence === undefined
    ? previous.expression?.earlyFirstSentence ?? DEFAULT_TTS_PARAMS.expression.earlyFirstSentence
    : fields.earlyFirstSentence;
  if (typeof earlyFirstSentence !== 'boolean') invalid();
  const segmentPauseMs = fields.segmentPauseMs === undefined
    ? previous.expression?.segmentPauseMs ?? DEFAULT_TTS_PARAMS.expression.segmentPauseMs
    : numeric('segmentPauseMs', 0, 400, true);
  if (!Number.isSafeInteger(segmentPauseMs) || segmentPauseMs < 0 || segmentPauseMs > 400) invalid();
  const sentencePauseMs = fields.sentencePauseMs === undefined
    ? previous.expression?.sentencePauseMs ?? DEFAULT_TTS_PARAMS.expression.sentencePauseMs
    : numeric('sentencePauseMs', 0, 400, true);
  if (!Number.isSafeInteger(sentencePauseMs) || sentencePauseMs < 0 || sentencePauseMs > 400) invalid();
  const allowList = String(fields.inlineAllowList || '').split(',').map(value => value.trim()).filter(Boolean);
  if (allowList.length > 32 || allowList.some(value => value.length > 80 || !/^[a-z][a-z0-9 _-]*$/.test(value))) invalid();
  for (const key of ['mergeEnabled', 'inlineEnabled', 'speechStyleEnabled', 'debug']) if (typeof fields[key] !== 'boolean') invalid();
  return {
    topP, latency: fields.latency,
    prosody: { ...previous.prosody, speed: numeric('speed', 0.5, 2), volume: numeric('volume', -20, 20) },
    expression: { ...previous.expression, selection, emotionTagMap, tagPlacement: fields.tagPlacement,
      earlyFirstSentence, segmentPauseMs, sentencePauseMs,
      maxTagsPerSentence: numeric('maxTagsPerSentence', 0, 2, true),
      mergeShortSentences: { enabled: fields.mergeEnabled, minChars, maxChars } },
    inlineTags: { enabled: fields.inlineEnabled, allowList: [...new Set(allowList)],
      maxPerSentence: numeric('inlineMaxPerSentence', 0, 2, true) },
    speechStyle: { enabled: fields.speechStyleEnabled }, debug: fields.debug,
  };
}
export function emotionMapSelections(map, emotion) {
  const value = map[emotion] ?? DEFAULT_TTS_PARAMS.expression.emotionTagMap[emotion] ?? [];
  const tags = (Array.isArray(value) ? value.join(' ') : String(value)).match(/\[[^\[\]\x00-\x1f\x7f]{1,80}\]/g) ?? [];
  return [tags[0] ?? '', tags[1] ?? ''];
}
export function updateEmotionSelection(map, emotion, first, second) {
  if (!map || typeof map !== 'object' || Array.isArray(map)
    || !Object.hasOwn(DEFAULT_TTS_PARAMS.expression.emotionTagMap, emotion)
    || [first, second].some(tag => typeof tag !== 'string' || tag && !/^\[[^\[\]\x00-\x1f\x7f]{1,80}\]$/.test(tag))) {
    throw Object.assign(new Error(), { code: 'INVALID_SETTINGS' });
  }
  const tags = [first, second].filter(Boolean);
  return { ...map, [emotion]: tags.length ? tags.join(' ') : [] };
}
export function privacyFlows(settings) {
  return [['privacy.microphone', 'stt', '#mic-status'], ['privacy.chat', 'llm', '#chat-form'],
    ['privacy.reaction', 'surface', '#chat-form'], ['privacy.reflection', 'reflection', '#chat-form'],
    ['privacy.routing', 'router', '#chat-form'],
    ['privacy.memoryWriter', 'memoryWriter', '?settings=1'], ['privacy.memoryEmbedding', 'memoryEmbedding', '?settings=1'],
    ['privacy.frames', 'vision', '#screen-share-btn'], ['privacy.spoken', 'tts', '#mic-status']].map(([label, slot, toggle]) => {
    const current = settings.slots?.[slot];
    const assignment = current?.followLlm || current === undefined && ['surface', 'reflection', 'memoryWriter'].includes(slot)
      ? settings.slots?.llm : current;
    return { label, origin: profileOrigin(settings.profiles?.[assignment?.profile] || {}), toggle };
  });
}
export async function withSecret(field, operation) {
  let value = field.value;
  field.value = '';
  try { return await operation(value); } finally { value = ''; field.value = ''; }
}
