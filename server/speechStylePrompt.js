import { resolveTtsParams } from './ttsExpression.js';

export function speechStylePrompt(params = {}) {
  const options = resolveTtsParams(params);
  if (!options.speechStyle.enabled) return '';
  const instructions = [
    'Gaya bicara: tulis balasan untuk diucapkan dengan alami dalam bahasa Indonesia.',
    'Gunakan kalimat singkat yang bervariasi, interjeksi alami, dan tanda baca ekspresif seperti !, ?, ..., koma, atau —.',
    'Jangan gunakan emoji, markdown, atau URL. Pertahankan persona dan format JSON yang sudah ditentukan.',
  ];
  if (options.inlineTags.enabled) {
    const tags = options.inlineTags.allowList.map(tag => `[${tag}]`).join(', ');
    instructions.push(`Opsional, gunakan hanya tag penampilan berikut: ${tags}. Maksimal ${Math.min(2, options.inlineTags.maxPerSentence)} tag per kalimat; jangan tulis tag emosi.`);
  } else instructions.push('Jangan tulis tag penampilan atau tag emosi di dalam teks.');
  return instructions.join(' ');
}
