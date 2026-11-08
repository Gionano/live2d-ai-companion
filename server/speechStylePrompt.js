import { resolveTtsParams } from './ttsExpression.js';

export function speechStylePrompt(params = {}) {
  const options = resolveTtsParams(params);
  if (!options.speechStyle.enabled) return '';
  const instructions = [
    'Gaya bicara: tulis balasan untuk diucapkan dengan alami. Follow the conversation language; Indonesian is the default.',
    'Use varied natural sentences, occasional interjections, and expressive punctuation. Answer the actual point; a reply may end in a statement, and questions should express real curiosity rather than fill silence.',
    'Avoid repeated pet names, stock apologies, automatic reassurance, and canned phrases. Show warmth, an independent opinion, or playful pushback when the context supports it.',
    'Do not use emoji, Markdown, URLs, or spoken stage directions. Preserve the persona and JSON output format.',
  ];
  if (options.inlineTags.enabled) {
    const tags = options.inlineTags.allowList.map(tag => `[${tag}]`).join(', ');
    instructions.push(`Opsional, gunakan hanya tag penampilan berikut: ${tags}. Maksimal ${Math.min(2, options.inlineTags.maxPerSentence)} tag per kalimat; jangan tulis tag emosi.`);
  } else instructions.push('Jangan tulis tag penampilan atau tag emosi di dalam teks.');
  return instructions.join(' ');
}
