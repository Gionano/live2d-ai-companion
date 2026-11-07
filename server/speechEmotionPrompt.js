import { FISH_EMOTION_NAMES } from './fishEmotionTags.js';

export function normalizeSpeechEmotion(value) {
  return typeof value === 'string' && FISH_EMOTION_NAMES.includes(value) ? value : undefined;
}

// Availability is checked by each caller; writing style and voice selection are independent.
export function speechEmotionPrompt(params = {}, kind = 'chat') {
  if (params.expression?.selection === 'mapped') return '';
  const format = kind === 'chat'
    ? 'Return ordered JSON {"segments":[{"emotion":"existing avatar label","speechEmotion":"catalogue name","text":"spoken segment"}]}; place both emotion fields before text in every segment.'
    : `Add the optional top-level speechEmotion field to the existing ${kind === 'selfie' ? 'selfie plan' : 'vision comment'} JSON. Keep every existing field and rule.`;
  return [
    kind === 'chat'
      ? 'Speech emotion metadata: choose one Fish emotion per coherent spoken segment, based on its meaning and tone. Use a new segment when the tone changes naturally; do not force a change or split individual words.'
      : 'Speech emotion metadata: choose exactly one Fish emotion for the entire spoken reply, based on its meaning and tone.',
    `speechEmotion must be one canonical name without brackets: ${FISH_EMOTION_NAMES.join(', ')}.`,
    format,
    'Keep emotion as an existing avatar label; it controls the avatar separately from speechEmotion.',
    'Do not put emotion tags or metadata in spoken text. Do not change the persona, image whitelist, image prompt, or moderation rules.',
  ].join(' ');
}
