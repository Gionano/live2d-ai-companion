// Pure text/config helpers shared by the backend and local settings editor.
import { FISH_EMOTION_NAMES } from './fishEmotionTags.js';
export const DEFAULT_EMOTION_TAG_MAP = {
  senang: '[happy]',
  terkejut: '[surprised]', marah: '[angry]', bingung: '[confused]',
  jengkel: '[frustrated]', malu: '[embarrassed]', kesal: '[upset]',
  sedih: '[sad]', kagum: '[excited]', sayang: '[empathetic]',
  jahil: '[sarcastic]', penasaran: '[curious]', netral: '[calm] [warm]',
};

export const DEFAULT_TTS_PARAMS = {
  temperature: 0.8, topP: 0.7, latency: 'balanced',
  prosody: { speed: 1, volume: 0 }, debug: false,
  expression: { selection: 'native', emotionTagMap: DEFAULT_EMOTION_TAG_MAP, tagPlacement: 'every-sentence',
    earlyFirstSentence: true, sentencePauseMs: 200, segmentPauseMs: 150,
    maxTagsPerSentence: 2, mergeShortSentences: { enabled: true, minChars: 25, maxChars: 180 } },
  inlineTags: { enabled: false, allowList: ['laughs', 'sigh', 'pause', 'whisper', 'chuckle', 'emphasis', 'break'], maxPerSentence: 2 },
  speechStyle: { enabled: true },
};

export function resolveTtsParams(params = {}, overrides = {}) {
  const merge = (base, next) => {
    const result = { ...base };
    for (const [key, value] of Object.entries(next ?? {})) {
      if (value === undefined) continue;
      result[key] = value && typeof value === 'object' && !Array.isArray(value)
        ? merge(base?.[key] ?? {}, value) : value;
    }
    return result;
  };
  const result = merge(merge(structuredClone(DEFAULT_TTS_PARAMS), params), overrides);
  const pause = result.expression.segmentPauseMs;
  result.expression.segmentPauseMs = Number.isFinite(pause) ? Math.max(0, Math.min(400, pause)) : 150;
  const sentencePause = result.expression.sentencePauseMs;
  result.expression.sentencePauseMs = Number.isFinite(sentencePause) ? Math.max(0, Math.min(400, sentencePause)) : 200;
  return result;
}

const LEGACY_TAGS = new Set((
  FISH_EMOTION_NAMES.join(' ') + ' ' +
  'shy neutral warm laughs sigh pause whisper chuckle emphasis break ' + Object.keys(DEFAULT_EMOTION_TAG_MAP).join(' ')
).split(' '));

function inlineTag(content, parenthesis, params) {
  const name = content.trim().toLowerCase();
  const inline = params.inlineTags;
  if (inline.enabled && inline.allowList.includes(name)) return `[${name}]`;
  const customLegacy = Object.values(params.expression.emotionTagMap).some(value =>
    (Array.isArray(value) ? value.join(' ') : String(value)).toLowerCase().includes(`[${name}]`));
  return parenthesis && !LEGACY_TAGS.has(name) && !customLegacy ? `(${content})` : '';
}

function tagPolicy(params) {
  const names = [...LEGACY_TAGS, ...params.inlineTags.allowList,
    ...Object.values(params.expression.emotionTagMap).map(value =>
      Array.isArray(value) ? value.join(' ') : String(value))];
  return { params, maxNameLength: Math.max(...names.map(name => Math.max(name.length, name.toLowerCase().length))) };
}

// Match each delimiter kind independently, including malformed mixed delimiters.
function delimiterPositions(text) {
  const ends = new Int32Array(text.length);
  const nextRoundClose = new Int32Array(text.length + 1);
  const previousNonSpace = new Int32Array(text.length + 1);
  const round = [];
  const square = [];
  let lastNonSpace = -1;
  previousNonSpace[0] = lastNonSpace;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!/\s/.test(char)) lastNonSpace = index;
    previousNonSpace[index + 1] = lastNonSpace;
    if (char === '(') round.push(index);
    else if (char === '[') square.push(index);
    else if (char === ')' && round.length) ends[round.pop()] = index;
    else if (char === ']' && square.length) ends[square.pop()] = index;
  }
  let next = -1;
  nextRoundClose[text.length] = next;
  for (let index = text.length - 1; index >= 0; index--) {
    if (text[index] === ')') next = index;
    nextRoundClose[index] = next;
  }
  return { ends, nextRoundClose, previousNonSpace };
}

// Buffer unfinished tag delimiters so split LLM chunks cannot leak tags to UI.
export class StreamingTagSanitizer {
  constructor(params = {}) {
    this.params = resolveTtsParams(params);
    this.pending = '';
    this.inlineCount = 0;
  }

  push(chunk, final = false) {
    this.pending += chunk;
    const text = this.pending;
    const { ends, nextRoundClose, previousNonSpace } = delimiterPositions(text);
    let displayText = '';
    let ttsText = '';
    const root = { index: 0, end: text.length, policy: tagPolicy(this.params),
      inlineCount: this.inlineCount, maxInline: Math.min(2, this.params.inlineTags.maxPerSentence),
      tagCount: 0, final, close: false };
    const frames = [root];
    let labelPolicy;
    while (frames.length) {
      const frame = frames.at(-1);
      if (frame.index >= frame.end) {
        frames.pop();
        if (frame.close) { displayText += ')'; ttsText += ')'; }
        if (frames.length && frame.parenthesis) {
          frames.at(-1).inlineCount += frame.tagCount;
          frames.at(-1).tagCount += frame.tagCount;
        }
        continue;
      }
      const index = frame.index;
      const char = text[index];
      if (char === '[' || char === '(') {
        const parenthesis = char === '(';
        const matched = ends[index];
        const end = matched > index && matched < frame.end ? matched : -1;
        if (end < 0 && !frame.final) break;
        if (!parenthesis && end >= 0) {
          // A link label is spoken text, rather than an unknown performance tag.
          if (end + 1 === frame.end && !frame.final) break;
          if (end + 1 < frame.end && text[end + 1] === '(') {
            const next = nextRoundClose[end + 2];
            const linkEnd = next >= 0 && next < frame.end ? next : -1;
            if (linkEnd < 0 && !frame.final) break;
            if (/^(?:https?:\/\/|www\.)/i.test(text.slice(end + 2, Math.min(frame.end, end + 10)))) {
              labelPolicy ??= tagPolicy(resolveTtsParams());
              frame.index = linkEnd < 0 ? frame.end : linkEnd + 1;
              frames.push({ index: index + 1, end, policy: labelPolicy, inlineCount: 0,
                maxInline: 0, tagCount: 0, final: true, close: false });
              continue;
            }
          }
        }
        const contentEnd = end < 0 ? frame.end : end;
        let start = index + 1;
        while (start < contentEnd && /\s/.test(text[start])) start++;
        const stop = Math.max(start, previousNonSpace[contentEnd] + 1);
        // Only configured/legacy names need copying; prose stays in source ranges.
        const content = stop - start <= frame.policy.maxNameLength ? text.slice(start, stop) : null;
        const tag = end < 0 ? (parenthesis && !LEGACY_TAGS.has(content?.toLowerCase()) ? '(' : '')
          : content === null ? (parenthesis ? '(' : '') : inlineTag(content, parenthesis, frame.policy.params);
        frame.index = end < 0 ? frame.end : end + 1;
        if (tag.startsWith('[')) {
          if (frame.inlineCount < frame.maxInline) { ttsText += tag; frame.inlineCount++; frame.tagCount++; }
        } else if (parenthesis && tag) {
          displayText += '('; ttsText += '(';
          frames.push({ index: index + 1, end: contentEnd, policy: frame.policy, inlineCount: 0,
            maxInline: Math.max(0, frame.maxInline - frame.inlineCount), tagCount: 0,
            final: true, parenthesis: true, close: end >= 0 });
        }
        continue;
      }
      frame.index++;
      if (char === ']') continue;
      displayText += char;
      ttsText += char;
      if ('.!?…\n'.includes(char) && !(char === '.' && index > 0 && /\d/.test(text[index - 1])
        && index + 1 < frame.end && /\d/.test(text[index + 1]))) frame.inlineCount = 0;
    }
    this.pending = text.slice(root.index);
    this.inlineCount = root.inlineCount;
    return { displayText, ttsText };
  }

  finish() { return this.push('', true); }
}

export function sanitizeSpeechText(text, params = {}) {
  const sanitizer = new StreamingTagSanitizer(params);
  const first = sanitizer.push(String(text ?? ''));
  const tail = sanitizer.finish();
  return { displayText: first.displayText + tail.displayText, ttsText: first.ttsText + tail.ttsText };
}

export function stripSpeechTags(text) {
  return sanitizeSpeechText(text).displayText;
}

export function normalizeTtsText(text) {
  return String(text ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\((?:https?:\/\/|www\.)[^)]*\)/gi, '$1')
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, value => value.match(/[!?.,…]+$/)?.[0] ?? '')
    .replace(/(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*|[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3)/gu, '')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/[*`_~]/g, '')
    .replace(/[\p{Cc}\p{Cf}\uFE0F]/gu, value => /[\r\n\t]/.test(value) ? ' ' : '')
    .replace(/[.!?,…—]{4,}/g, value => value.slice(0, 3))
    .replace(/\s+/g, ' ').trim();
}

export function splitSpeechSentences(text) {
  const result = [];
  let start = 0;
  let delimiter = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '[' || char === '(') delimiter = char === '[' ? ']' : ')';
    if (delimiter) { if (char === delimiter) delimiter = null; continue; }
    if (!'.!?…\n'.includes(char)) continue;
    if (char === '.' && /\d/.test(text[index - 1] ?? '') && /\d/.test(text[index + 1] ?? '')) continue;
    while (index + 1 < text.length && '.!?…\n'.includes(text[index + 1])) index++;
    if (index + 1 < text.length && !/\s/.test(text[index + 1])) continue;
    const sentence = text.slice(start, index + 1).trim();
    if (sentence) result.push(sentence);
    start = index + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

export function spokenSentenceCount(text) {
  return splitSpeechSentences(text).filter(sentence => /[\p{L}\p{N}]/u.test(normalizeTtsText(stripSpeechTags(sentence)))).length;
}

export class SentenceMerger {
  constructor(params = {}) {
    this.options = resolveTtsParams(Object.hasOwn(params, 'minChars') || Object.hasOwn(params, 'enabled')
      ? { expression: { mergeShortSentences: params } } : params).expression.mergeShortSentences;
    this.pending = '';
  }

  push(sentence) {
    if (!sentence) return [];
    if (!this.options.enabled) return [sentence];
    const output = [];
    const length = value => normalizeTtsText(stripSpeechTags(value)).length;
    if (this.pending && length(this.pending + ' ' + sentence) > this.options.maxChars) {
      output.push(this.pending); this.pending = '';
    }
    this.pending = this.pending ? `${this.pending} ${sentence}` : sentence;
    if (length(this.pending) >= this.options.minChars) { output.push(this.pending); this.pending = ''; }
    return output;
  }

  finish() { const output = this.pending ? [this.pending] : []; this.pending = ''; return output; }
}

const ENGLISH_ALIASES = { shy: 'malu', neutral: 'netral' };
export function prepareTtsText(text, emotion = 'netral', params = {}, sentenceIndex = 0, tagOverride, speechEmotion) {
  const options = resolveTtsParams(params);
  // Preserve Markdown link words before stripping unknown square-bracket tags.
  const unlinked = String(text).replace(/\[([^\]]*)\]\((?:https?:\/\/|www\.)[^)]*\)/gi, '$1');
  const sanitized = sanitizeSpeechText(unlinked, options).ttsText;
  const cap = Math.max(0, Math.min(2, options.expression.maxTagsPerSentence));
  const nativeTag = options.expression.selection === 'native' && FISH_EMOTION_NAMES.includes(speechEmotion)
    ? `[${speechEmotion}]` : undefined;
  let offset = 0;
  return splitSpeechSentences(sanitized).map(sentence => {
    const inline = sentence.match(/\[[^\]]*\]/g) ?? [];
    const spoken = normalizeTtsText(sentence.replace(/\[[^\]]*\]/g, ''));
    if (!/[\p{L}\p{N}]/u.test(spoken)) return '';
    let mapping = options.expression.emotionTagMap[emotion] ?? options.expression.emotionTagMap[ENGLISH_ALIASES[emotion]];
    if (mapping === undefined && FISH_EMOTION_NAMES.includes(emotion)) mapping = `[${emotion}]`;
    const placed = options.expression.tagPlacement !== 'first-only' || sentenceIndex + offset === 0;
    const expression = placed ? tagOverride ?? nativeTag ?? mapping ?? '' : '';
    offset++;
    const tags = (Array.isArray(expression) ? expression.join(' ') : String(expression)).match(/\[[^\[\]\r\n]+\]/g) ?? [];
    const prefix = [...tags, ...inline].slice(0, cap).join(' ');
    return prefix ? `${prefix} ${spoken}` : spoken;
  }).filter(Boolean).join(' ');
}
