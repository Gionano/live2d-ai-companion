import { FISH_EMOTION_NAMES } from './fishEmotionTags.js';

export function normalizeSpeechEmotion(value) {
  return typeof value === 'string' && FISH_EMOTION_NAMES.includes(value) ? value : undefined;
}

export const SPEECH_REGISTERS = Object.freeze(['polite', 'casual', 'serious', 'intimate', 'whisper']);

export function normalizeSpeechRegister(value) {
  return SPEECH_REGISTERS.includes(value) ? value : 'casual';
}

export const SPEECH_REGISTER_PROMPT = 'Choose a register for each spoken sentence: polite for courteous public speech; casual for relaxed everyday conversation; serious for a firm or important point; intimate for private affection; whisper for a hushed, close manner. Register is an attitude, not an emotion intensity. Let register inform wording and the supported Fish emotion choice; do not invent voice tags.';

// Availability is checked by each caller; writing style and voice selection are independent.
export function speechEmotionPrompt(params = {}, kind = 'chat') {
  if (params.expression?.selection === 'mapped') return '';
  const format = kind === 'chat'
    ? 'Return ordered JSON {"segments":[{"register":"casual","emotion":"existing avatar label","speechEmotion":"catalogue name","text":"spoken sentence"}]}; place register and both emotion fields before text in every segment.'
    : `Add the optional top-level speechEmotion field to the existing ${kind === 'selfie' ? 'selfie plan' : 'vision comment'} JSON. Keep every existing field and rule.`;
  return [
    kind === 'chat'
      ? 'Speech emotion metadata: choose one Fish emotion per natural spoken sentence, based on its meaning and tone. Prefer one sentence per segment. Adjacent sentences may keep the same emotion; do not force changes or split individual words.'
      : 'Speech emotion metadata: choose exactly one Fish emotion for the entire spoken reply, based on its meaning and tone.',
    `speechEmotion must be one canonical name without brackets: ${FISH_EMOTION_NAMES.join(', ')}.`,
    format,
    ...(kind === 'chat' ? [SPEECH_REGISTER_PROMPT] : []),
    'Keep emotion as an existing avatar label; it controls the avatar separately from speechEmotion.',
    'Do not put emotion tags or metadata in spoken text. Do not change the persona, image whitelist, image prompt, or moderation rules.',
  ].join(' ');
}
