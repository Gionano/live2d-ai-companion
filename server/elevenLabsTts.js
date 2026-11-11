// Pure ElevenLabs settings and text helpers shared with the settings editor.
import { normalizeTtsText, splitSpeechSentences, stripSpeechTags } from './ttsExpression.js';

export const ELEVENLABS_MODELS = Object.freeze([
  'eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2', 'eleven_v3',
]);
export const DEFAULT_ELEVENLABS_PARAMS = Object.freeze({
  stability: 0.5, similarityBoost: 0.75, speed: 1, emotionTags: true,
});

export function isElevenLabsVoice(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
    && value !== '.' && value !== '..' && value === value.trim() && !/[\x00-\x1f\x7f<>]/.test(value)
    && !/^(?:REPLACE_WITH_|ISI_DENGAN)/i.test(value);
}

export function resolveElevenLabsParams(params = {}, overrides = {}, model) {
  const result = { ...DEFAULT_ELEVENLABS_PARAMS };
  for (const values of [params, overrides]) {
    if (!values || typeof values !== 'object' || Array.isArray(values)
      || Object.keys(values).some(key => !Object.hasOwn(DEFAULT_ELEVENLABS_PARAMS, key))) {
      throw new TypeError('Invalid ElevenLabs voice settings.');
    }
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) result[key] = value;
    }
  }
  for (const [key, min, max] of [['stability', 0, 1], ['similarityBoost', 0, 1], ['speed', 0.7, 1.2]]) {
    if (!Number.isFinite(result[key]) || result[key] < min || result[key] > max) {
      throw new TypeError('Invalid ElevenLabs voice settings.');
    }
  }
  if (typeof result.emotionTags !== 'boolean'
    || model === 'eleven_v3' && ![0, 0.5, 1].includes(result.stability)) {
    throw new TypeError('Invalid ElevenLabs voice settings.');
  }
  return result;
}

const AVATAR_TAGS = Object.freeze({
  senang: '[excited]', kagum: '[excited]', terkejut: '[surprised]', marah: '[angry]',
  bingung: '[curious]', penasaran: '[curious]', jengkel: '[frustrated]', kesal: '[frustrated]',
  sedih: '[sad]', sayang: '[warmly]', malu: '[whispers]', jahil: '[mischievously]', netral: '',
});
const NATIVE_TAGS = Object.freeze({
  happy: '[excited]', excited: '[excited]', amazed: '[excited]', surprised: '[surprised]',
  angry: '[angry]', confused: '[curious]', curious: '[curious]', frustrated: '[frustrated]',
  upset: '[frustrated]', annoyed: '[frustrated]', sad: '[sad]', affectionate: '[warmly]',
  empathetic: '[warmly]', compassionate: '[warmly]', sympathetic: '[warmly]', warm: '[warmly]',
  shy: '[whispers]', embarrassed: '[whispers]', playful: '[mischievously]',
  mischievous: '[mischievously]', sarcastic: '[mischievously]', calm: '', neutral: '',
});

export function prepareElevenLabsText(text, emotion = 'netral', speechEmotion, params = {}, model) {
  // Preserve link words before removing Fish and other inline speech cues.
  const unlinked = String(text).replace(/!?\[([^\]]*)\]\((?:https?:\/\/|www\.)[^)]*\)/gi, '$1');
  const spoken = normalizeTtsText(stripSpeechTags(unlinked));
  if (!/[\p{L}\p{N}]/u.test(spoken)) return '';
  const mapped = (map, name) => Object.hasOwn(map, name) ? map[name] : undefined;
  const tag = model === 'eleven_v3' && params.emotionTags
    ? mapped(NATIVE_TAGS, speechEmotion) ?? mapped(AVATAR_TAGS, emotion) ?? mapped(NATIVE_TAGS, emotion) ?? '' : '';
  return tag ? splitSpeechSentences(spoken).map(sentence =>
    /[\p{L}\p{N}]/u.test(sentence) ? `${tag} ${sentence}` : '').filter(Boolean).join(' ') : spoken;
}
