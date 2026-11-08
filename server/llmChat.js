// ---------------------------------------------------------------------------
// llmChat.js  (server-side)
// Percakapan utama waifu lewat model "qwen3.8-flash-next-uncensored" via
// Experiential Labs (streaming).
// generateReply() adalah async generator: yield potongan teks (delta) begitu
// datang, supaya route /api/chat bisa mem-forward token demi token ke browser
// (dan nanti gampang dipecah per-kalimat untuk TTS).
// ---------------------------------------------------------------------------
import { getProviderRegistry, UNAVAILABLE_MESSAGES } from './providers/registry.js';
import { logger as console } from '../src/logging.js';
import { WAIFU_SYSTEM_PROMPT } from './personality.js';
import { memoryManager } from './memoryManager.js';
import { recallConversation, renderConversationMemory } from './conversationMemory.js';
import { speechStylePrompt } from './speechStylePrompt.js';
import { normalizeSpeechEmotion, normalizeSpeechRegister, speechEmotionPrompt } from './speechEmotionPrompt.js';
import { resolveTtsParams, StreamingTagSanitizer, SentenceMerger, spokenSentenceCount } from './ttsExpression.js';
import { ReplyContinuationGuard } from './replyContinuation.js';
import { VALID_EMOTIONS } from '../src/expressionMap.js';
export const HISTORY_MESSAGE_LIMIT = 8;
export const HISTORY_TOKEN_LIMIT = 700;
export const REPLY_EMOTIONS = new Set(VALID_EMOTIONS);

// Estimasi konservatif tanpa menambah tokenizer dependency. Untuk teks campuran
// Indonesia/Inggris, ~4 karakter per token cukup berguna untuk logging/budget.
export function estimateTokensFromChars(characters) {
  return Math.ceil(characters / 4);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  return JSON.stringify(content ?? '');
}

export function trimConversationHistory(conversationHistory) {
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const selectedNewestFirst = [];
  let selectedTokens = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    if (selectedNewestFirst.length >= HISTORY_MESSAGE_LIMIT) break;

    const turn = history[i];
    if (!turn || !['user', 'assistant'].includes(turn.role)) continue;
    const content = contentText(turn.content);
    const turnTokens = estimateTokensFromChars(content.length);

    // Always retain the newest valid message, even if that message alone is
    // above budget; otherwise stop before crossing the history token budget.
    if (
      selectedNewestFirst.length > 0 &&
      selectedTokens + turnTokens > HISTORY_TOKEN_LIMIT
    ) {
      break;
    }

    selectedNewestFirst.push({ role: turn.role, content });
    selectedTokens += turnTokens;
  }

  return selectedNewestFirst.reverse();
}

function messageStats(messages) {
  const characters = messages.reduce(
    (total, message) => total + contentText(message.content).length,
    0,
  );
  return { characters, estimatedTokens: estimateTokensFromChars(characters) };
}

function normalizeEmotion(value) {
  return REPLY_EMOTIONS.has(value) ? value : 'netral';
}

function readJsonString(raw, start) {
  for (let index = start + 1; index < raw.length; index++) {
    if (raw[index] === '\\') { index++; continue; }
    if (raw[index] !== '"') continue;
    try { return { value: JSON.parse(raw.slice(start, index + 1)), end: index + 1 }; }
    catch { return { value: undefined, end: index + 1 }; }
  }
  return null;
}

function readHeaderValue(raw, start) {
  if (raw[start] === '"') return readJsonString(raw, start);
  let depth = 0;
  for (let index = start; index < raw.length; index++) {
    const char = raw[index];
    if (char === '"') {
      const string = readJsonString(raw, index);
      if (!string) return null;
      index = string.end - 1;
    } else if ('[{'.includes(char)) depth++;
    else if (']}'.includes(char)) {
      if (depth === 0) return { value: undefined, end: index };
      if (--depth === 0) return { value: undefined, end: index + 1 };
    } else if (char === ',' && depth === 0) return { value: undefined, end: index };
  }
  return null;
}

// Scan JSON members, not text patterns, so nested objects and quoted prose cannot
// change reply metadata. Stop at the opening quote of the top-level text field.
function scanReplyHeader(raw, { stopAtSpeech = true } = {}) {
  const start = raw.indexOf('{');
  const fields = [];
  if (start < 0) return { fields };
  let index = start + 1;
  while (index < raw.length) {
    while (/\s|,/.test(raw[index] ?? '') && index < raw.length) index++;
    if (raw[index] !== '"') break;
    const key = readJsonString(raw, index);
    if (!key) break;
    index = key.end;
    while (/\s/.test(raw[index] ?? '') && index < raw.length) index++;
    if (raw[index++] !== ':') break;
    while (/\s/.test(raw[index] ?? '') && index < raw.length) index++;
    if (stopAtSpeech && key.value === 'text' && raw[index] === '"') return { fields, textStart: index + 1 };
    if (stopAtSpeech && key.value === 'segments' && raw[index] === '[') return { fields, segmentsStart: index + 1 };
    const value = readHeaderValue(raw, index);
    if (!value) break;
    fields.push({ key: key.value, value: value.value });
    index = value.end;
    while (/\s/.test(raw[index] ?? '') && index < raw.length) index++;
    if (raw[index] !== ',') break;
    index++;
  }
  return { fields };
}

// Parse the ordered JSON object incrementally so emotion can reach the avatar
// before the first complete sentence is sent to TTS. This preserves streaming.
class LegacyReplyParser {
  constructor() {
    this.raw = '';
    this.emotion = null;
    this.speechEmotion = undefined;
    this.speechEmotionSeen = false;
    this.register = undefined;
    this.registerSeen = false;
    this.textStarted = false;
    this.textFinished = false;
    this.scanAt = 0;
  }

  push(chunk) {
    this.raw += chunk;
    const events = [];

    // Fallback: model lokal (LM Studio) kadang membalas teks biasa, bukan JSON.
    // Kalau output tidak diawali '{' atau '```', anggap seluruhnya teks balasan.
    if (this.plain === undefined) {
      const head = this.raw.trimStart();
      if (head.length > 0) this.plain = !(head[0] === '{' || head[0] === '`');
    }
    if (this.plain) {
      events.push({ type: 'delta', text: chunk });
      return events;
    }

    if (!this.textStarted) {
      const header = scanReplyHeader(this.raw);
      for (const field of header.fields) {
        if (field.key === 'emotion' && !this.emotion) {
          this.emotion = normalizeEmotion(field.value);
          events.push({ type: 'emotion', emotion: this.emotion });
        }
        if (field.key === 'speechEmotion' && !this.speechEmotionSeen) {
          this.speechEmotionSeen = true;
          this.speechEmotion = normalizeSpeechEmotion(field.value);
          if (this.speechEmotion) events.push({ type: 'speechEmotion', speechEmotion: this.speechEmotion });
        }
        if (field.key === 'register' && !this.registerSeen) {
          this.registerSeen = true;
          this.register = normalizeSpeechRegister(field.value);
          events.push({ type: 'register', register: this.register });
        }
      }
      if (header.textStart === undefined) return events;
      this.textStarted = true;
      this.scanAt = header.textStart;
      if (!this.emotion) {
        this.emotion = 'netral';
        events.push({ type: 'emotion', emotion: this.emotion });
      }
    }

    let decoded = '';
    while (this.scanAt < this.raw.length && !this.textFinished) {
      const char = this.raw[this.scanAt];
      if (char === '"') {
        this.scanAt++;
        this.textFinished = true;
        break;
      }
      if (char !== '\\') {
        decoded += char;
        this.scanAt++;
        continue;
      }

      // Keep an incomplete escape buffered until the next network chunk.
      if (this.scanAt + 1 >= this.raw.length) break;
      const escaped = this.raw[this.scanAt + 1];
      if (escaped === 'u') {
        const hex = this.raw.slice(this.scanAt + 2, this.scanAt + 6);
        if (hex.length < 4) break;
        decoded += /^[0-9a-f]{4}$/i.test(hex)
          ? String.fromCharCode(parseInt(hex, 16))
          : `\\u${hex}`;
        this.scanAt += 6;
      } else {
        decoded += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[escaped] ?? escaped;
        this.scanAt += 2;
      }
    }
    if (decoded) events.push({ type: 'delta', text: decoded });
    return events;
  }

  finish() {
    const events = [];
    if (!this.emotion) {
      this.emotion = 'netral';
      events.push({ type: 'emotion', emotion: this.emotion });
    }
    return events;
  }
}

// Each segment uses the existing string decoder; the outer scanner only tracks
// JSON boundaries, so escaped quotes and nested metadata cannot become speech.
export class StructuredReplyParser {
  constructor() {
    this.raw = '';
    this.legacy = new LegacyReplyParser();
    this.segmented = false;
    this.scanAt = 0;
    this.segmentIndex = 0;
    this.current = null;
    this.done = false;
    this.metadata = {};
    this.metadataSeen = new Set();
  }

  readMetadata(fields, final = false) {
    const changed = {};
    for (const { key, value } of fields) {
      if (!['mode', 'status', 'reflectionRequest'].includes(key) || this.metadataSeen.has(key)
        || key === 'reflectionRequest' && !final) continue;
      this.metadataSeen.add(key);
      if (key === 'mode' && ['say', 'say+think', 'think'].includes(value)
        || key === 'status' && ['ok', 'unfinished', 'not-for-me'].includes(value)) changed[key] = value;
      else if (key === 'reflectionRequest' && typeof value === 'string') {
        const request = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500);
        if (request) changed.reflectionRequest = request;
      }
    }
    Object.assign(this.metadata, changed);
    return Object.keys(changed).length ? [{ type: 'reply_metadata', ...changed }] : [];
  }

  push(chunk) {
    this.raw += chunk;
    const structured = /^[{`]/.test(this.raw.trimStart());
    const metadata = structured ? this.readMetadata(scanReplyHeader(this.raw).fields) : [];
    if (!this.segmented) {
      const head = this.raw.trimStart();
      if (head && head[0] !== '{' && head[0] !== '`') return [...metadata, ...this.legacy.push(chunk)];
      const header = scanReplyHeader(this.raw);
      if (header.segmentsStart === undefined || this.legacy.textStarted || this.legacy.plain) {
        return [...metadata, ...this.legacy.push(chunk)];
      }
      this.segmented = true;
      this.scanAt = header.segmentsStart;
    }
    const events = [...metadata];
    while (this.scanAt < this.raw.length && !this.done) {
      if (!this.current) {
        while (this.scanAt < this.raw.length && /\s|,/.test(this.raw[this.scanAt])) this.scanAt++;
        if (this.scanAt >= this.raw.length) break;
        if (this.raw[this.scanAt] === ']') { this.done = true; break; }
        if (this.raw[this.scanAt] !== '{') {
          const skipped = readHeaderValue(this.raw, this.scanAt);
          if (!skipped || skipped.end <= this.scanAt) break;
          this.scanAt = skipped.end;
          continue;
        }
        this.current = { parser: new LegacyReplyParser(), segmentId: this.segmentIndex++,
          feedAt: this.scanAt, depth: 0, quoted: false, escaped: false, started: false };
      }
      const segment = this.current;
      while (this.scanAt < this.raw.length) {
        const char = this.raw[this.scanAt++];
        if (segment.quoted) {
          if (segment.escaped) segment.escaped = false;
          else if (char === '\\') segment.escaped = true;
          else if (char === '"') segment.quoted = false;
        } else if (char === '"') segment.quoted = true;
        else if ('{['.includes(char)) segment.depth++;
        else if ('}]'.includes(char) && --segment.depth === 0) break;
      }
      const parsed = segment.parser.push(this.raw.slice(segment.feedAt, this.scanAt));
      segment.feedAt = this.scanAt;
      events.push(...this.segmentEvents(segment, parsed));
      if (segment.depth !== 0) break;
      if (segment.started) events.push({ type: 'segment_end', segmentId: segment.segmentId });
      this.current = null;
    }
    return events;
  }

  segmentEvents(segment, parsed) {
    const events = [];
    if (!segment.started && segment.parser.textStarted) {
      segment.started = true;
      events.push({ type: 'segment_start', segmentId: segment.segmentId,
        emotion: segment.parser.emotion || 'netral', speechEmotion: segment.parser.speechEmotion,
        ...(segment.parser.register !== undefined && { register: segment.parser.register }) });
      events.push({ type: 'emotion', emotion: segment.parser.emotion || 'netral', segmentId: segment.segmentId });
    }
    for (const event of parsed) if (event.type === 'delta' && segment.started) {
      events.push({ ...event, segmentId: segment.segmentId });
    }
    return events;
  }

  finish() {
    let metadata = [];
    try {
      const raw = this.raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = this.readMetadata(scanReplyHeader(raw, { stopAtSpeech: false }).fields, true);
      }
    } catch { /* Partial or plain replies have no final control metadata. */ }
    if (!this.segmented) return [...this.legacy.finish(), ...metadata];
    if (!this.current?.started) return metadata;
    const event = { type: 'segment_end', segmentId: this.current.segmentId };
    this.current = null;
    return [event, ...metadata];
  }
}

export async function* generateReply(
  conversationHistory,
  userMessage,
  visionDescription,
  { signal, registry = getProviderRegistry(), includeSpeechText = false, includeMetadata = false,
    internalInstruction, role = 'llm', systemPrompt = WAIFU_SYSTEM_PROMPT, maxTokens,
    memory = memoryManager, memoryBundle } = {},
) {
  signal?.throwIfAborted();
  if (!registry.getSlotStatus(role).available) {
    yield { type: 'emotion', emotion: 'netral' };
    yield { type: 'delta', text: UNAVAILABLE_MESSAGES.llm };
    return;
  }
  const rawHistory = Array.isArray(conversationHistory)
    ? conversationHistory
    : [];
  const trimmedHistory = trimConversationHistory(rawHistory);
  const recall = await recallConversation(memory, userMessage, trimmedHistory, { signal, bundle: memoryBundle });
  const memoryContext = renderConversationMemory(memory, recall, role);
  const systemParts = [systemPrompt, memoryContext];
  const ttsParams = resolveTtsParams(registry.getTts?.()?.params);
  const nativeSelection = registry.getSlotStatus('tts').available && ttsParams.expression.selection !== 'mapped';
  if (registry.getSlotStatus('tts').available) {
    const style = speechStylePrompt(ttsParams);
    if (style) systemParts.push(style);
    const selection = speechEmotionPrompt(ttsParams);
    if (selection) systemParts.push(selection);
  }
  if (visionDescription) {
    systemParts.push(`[User sedang menunjukkan: ${visionDescription}]`);
  }
  if (typeof internalInstruction === 'string' && internalInstruction.trim()) {
    systemParts.push(internalInstruction.trim());
  }
  const systemContent = systemParts.join('\n\n');
  const messages = [{ role: 'system', content: systemContent }];

  for (const turn of trimmedHistory) messages.push(turn);

  if (userMessage !== undefined && userMessage !== null) messages.push({ role: 'user', content: userMessage });

  const context = messageStats(messages);
  const historyStats = messageStats(trimmedHistory);
  console.log(
    `[llm-context] rawHistory=${rawHistory.length} messages` +
      ` | includedHistory=${trimmedHistory.length}/${HISTORY_MESSAGE_LIMIT}` +
      ` messages, ${historyStats.characters} chars, ~${historyStats.estimatedTokens}` +
      ` tokens (budget ~${HISTORY_TOKEN_LIMIT})` +
      ` | request=${messages.length} messages, ${context.characters} chars,` +
      ` ~${context.estimatedTokens} tokens`,
  );

  const stream = registry.getLlm(role).stream({ messages, json: true, signal,
    ...(maxTokens !== undefined && { maxTokens }) });
  const parser = new StructuredReplyParser();
  let sanitizer = new StreamingTagSanitizer(ttsParams);
  let gotText = false;
  let displayEnd = '';
  let boundaryPending = false;
  const displayDelta = (displayText, ttsText, segmentId) => {
    if (displayText) {
      if (boundaryPending && displayEnd && !/\s$/.test(displayEnd) && !/^\s/.test(displayText)) displayText = ' ' + displayText;
      boundaryPending = false;
      displayEnd = displayText.slice(-1);
    }
    return { type: 'delta', text: displayText, ...(segmentId !== undefined && { segmentId }),
      ...(includeSpeechText && { speechText: ttsText }) };
  };
  const processEvent = function* (event) {
    if (event.type === 'reply_metadata') {
      if (includeMetadata) yield event;
    } else if (event.type === 'register') {
      if (includeSpeechText) yield event;
    } else if (event.type === 'segment_start') {
      sanitizer = new StreamingTagSanitizer(ttsParams);
      boundaryPending = Boolean(displayEnd);
      if (includeSpeechText) yield { ...event, speechEmotion: nativeSelection ? event.speechEmotion : undefined };
    } else if (event.type === 'segment_end') {
      const tail = sanitizer.finish();
      if (tail.displayText || includeSpeechText && tail.ttsText) yield displayDelta(tail.displayText, tail.ttsText, event.segmentId);
      if (includeSpeechText) yield event;
    } else if (event.type === 'delta') {
      gotText = true;
      const { displayText, ttsText } = sanitizer.push(event.text);
      if (displayText || includeSpeechText && ttsText) yield displayDelta(displayText, ttsText, event.segmentId);
    } else if (event.type !== 'speechEmotion' || nativeSelection && includeSpeechText) yield event;
  };

  for await (const chunk of stream) {
    signal?.throwIfAborted();
    const delta = chunk.type === 'text' ? chunk.delta : '';
    if (!delta) continue;
    for (const event of parser.push(delta)) {
      signal?.throwIfAborted();
      yield* processEvent(event);
    }
  }
  if (!gotText) {
    console.warn(
      '[llm-chat] Provider returned no reply text.',
    );
  }
  signal?.throwIfAborted();
  for (const event of parser.finish()) {
    signal?.throwIfAborted();
    yield* processEvent(event);
  }
  const tail = sanitizer.finish();
  if (tail.displayText || includeSpeechText && tail.ttsText) yield displayDelta(tail.displayText, tail.ttsText);
}

// Ambil kalimat lengkap paling awal dari `buf`. Return { sentence, rest } atau
// null kalau belum ada kalimat utuh. Batas kalimat = . ! ? … atau newline yang
// diikuti spasi/akhir. Titik desimal ("3.14") tidak dihitung sebagai batas.
export function takeSentence(buf) {
  const ENDERS = '.!?…\n';
  for (let i = 0; i < buf.length; i++) {
    if (!ENDERS.includes(buf[i])) continue;
    // Titik desimal: digit "." digit -> bukan akhir kalimat.
    if (buf[i] === '.' && /\d/.test(buf[i - 1] ?? '') && /\d/.test(buf[i + 1] ?? '')) {
      continue;
    }
    // Serap tanda baca beruntun (?!, …).
    let j = i;
    while (j + 1 < buf.length && ENDERS.includes(buf[j + 1])) j++;
    const after = buf[j + 1];
    // Butuh whitespace sesudahnya biar tak motong ".!?" di tengah token. TAPI
    // newline itu sendiri sudah jadi pemisah -> selalu valid. Kalau ender di
    // ujung buffer (after undefined) & bukan newline, tunggu token berikutnya.
    if (after === ' ' || after === '\n' || after === '\t' || buf[j] === '\n') {
      const sentence = buf.slice(0, j + 1).trim();
      const rest = buf.slice(j + 1).replace(/^\s+/, '');
      if (sentence) return { sentence, rest };
    }
  }
  return null;
}

// Bungkus generateReply: yield {type:'delta', text} tiap token (buat streaming
// teks ke browser) DAN {type:'sentence', text} tiap kalimat selesai (buat TTS).
export async function* generateReplyStream(
  conversationHistory,
  userMessage,
  visionDescription,
  { signal, registry = getProviderRegistry(), internalInstruction, role = 'llm', systemPrompt, maxTokens,
    continuationText, memory = memoryManager, memoryBundle } = {},
) {
  let buf = '';
  let speechEmotion;
  let register;
  let segment = null;
  let firstSentenceSent = false;
  let spokeAny = false;
  const params = resolveTtsParams(registry.getTts?.()?.params);
  // A sentence pause needs an individual audio boundary; merging sentences
  // would hide those boundaries inside one provider request.
  if (!registry.getSlotStatus('tts').available || params.expression.sentencePauseMs > 0) {
    params.expression.mergeShortSentences.enabled = false;
  }
  let merger = new SentenceMerger(params);
  const emitSentences = function* (sentences) {
    for (const text of sentences) {
      if (!spokenSentenceCount(text)) continue;
      const metadata = segment ? { emotion: segment.emotion, segmentId: segment.segmentId,
        pauseBeforeMs: !segment.emitted && spokeAny
          ? Math.max(0, params.expression.segmentPauseMs - params.expression.sentencePauseMs) : 0 } : {};
      const nativeEmotion = segment ? segment.speechEmotion : speechEmotion;
      const selectedRegister = segment ? segment.register : register;
      yield { type: 'sentence', text, ...metadata, pauseAfterMs: params.expression.sentencePauseMs,
        ...(selectedRegister !== undefined && { register: selectedRegister }),
        ...(nativeEmotion && { speechEmotion: nativeEmotion }) };
      if (segment) segment.emitted = true;
      firstSentenceSent = true;
      spokeAny = true;
    }
  };
  const pushSentence = function* (sentence, complete = true) {
    if (!firstSentenceSent && complete && params.expression.earlyFirstSentence && spokenSentenceCount(sentence)) {
      const pending = merger.finish();
      yield* emitSentences([pending.length ? pending.join(' ') + ' ' + sentence : sentence]);
    } else yield* emitSentences(merger.push(sentence));
  };
  const flushSegment = function* () {
    let hit;
    while ((hit = takeSentence(buf + ' '))) {
      yield* pushSentence(hit.sentence);
      buf = hit.rest;
    }
    if (buf.trim()) yield* pushSentence(buf.trim(), false);
    buf = '';
    yield* emitSentences(merger.finish());
  };
  const continuation = new ReplyContinuationGuard({ spokenText: continuationText });
  const acceptedEvents = async function* () {
    for await (const event of generateReply(conversationHistory, userMessage, visionDescription,
      { signal, registry, includeSpeechText: true, includeMetadata: true, internalInstruction, role, systemPrompt, maxTokens,
        memory, memoryBundle })) {
      signal?.throwIfAborted();
      if (continuationText && event.type === 'delta') yield { type: 'generation_progress' };
      yield* continuation.push(event);
    }
    signal?.throwIfAborted();
    yield* continuation.finish();
    if (continuation.removedSentences > 0) yield { type: 'opening_suppressed' };
  };
  for await (const event of acceptedEvents()) {
    signal?.throwIfAborted();
    if (event.type === 'segment_start') {
      yield* flushSegment();
      segment = { segmentId: event.segmentId, emotion: event.emotion,
        speechEmotion: event.speechEmotion, register: event.register, emitted: false };
      merger = new SentenceMerger(params);
      continue;
    }
    if (event.type === 'segment_end') {
      yield* flushSegment();
      segment = null;
      continue;
    }
    if (event.type === 'emotion') {
      yield event;
      continue;
    }
    if (event.type === 'reply_metadata') {
      yield event;
      continue;
    }
    if (event.type === 'opening_suppressed' || event.type === 'generation_progress') {
      yield event;
      continue;
    }
    if (event.type === 'register') {
      register = event.register;
      continue;
    }
    if (event.type === 'speechEmotion') {
      speechEmotion = event.speechEmotion;
      continue;
    }
    if (event.type !== 'delta') continue;
    const delta = event.text;
    yield { type: 'delta', text: delta };
    buf += event.speechText ?? delta;
    let hit;
    while ((hit = takeSentence(buf))) {
      signal?.throwIfAborted();
      yield* pushSentence(hit.sentence);
      buf = hit.rest;
    }
  }
  signal?.throwIfAborted();
  yield* flushSegment();
}

// Self-check parser: `node server/llmChat.js`
if (process.argv[1] && process.argv[1].endsWith('llmChat.js')) {
  const assert = (c, m) => {
    if (!c) throw new Error('FAIL: ' + m);
  };
  const a = takeSentence('Halo dunia. Sisa teks');
  assert(a && a.sentence === 'Halo dunia.' && a.rest === 'Sisa teks', 'kalimat-1');
  assert(takeSentence('Belum selesai tanpa titik') === null, 'belum-lengkap');
  assert(takeSentence('Harga 3.14 dolar ') === null, 'desimal-bukan-batas');
  const b = takeSentence('Wah, keren?! Terus?');
  assert(b && b.sentence === 'Wah, keren?!' && b.rest === 'Terus?', 'punct-beruntun');
  const c = takeSentence('Baris satu\nBaris dua');
  assert(c && c.sentence === 'Baris satu' && c.rest === 'Baris dua', 'newline-batas');
  const parser = new StructuredReplyParser();
  const events = [
    ...parser.push('```json\n{"emotion":"kagum","te'),
    ...parser.push('xt":"Halo\nSayang!"}\n```'),
    ...parser.finish(),
  ];
  assert(events[0]?.type === 'emotion' && events[0].emotion === 'kagum', 'json-emotion');
  assert(events.filter((e) => e.type === 'delta').map((e) => e.text).join('') === 'Halo\nSayang!', 'json-text');
  const unicodeParser = new StructuredReplyParser();
  const unicodeEvents = [
    ...unicodeParser.push('{"emotion":"malu","text":"Aku \\u00'),
    ...unicodeParser.push('e9 malu"}'),
  ];
  assert(unicodeEvents.filter((e) => e.type === 'delta').map((e) => e.text).join('') === 'Aku ' + String.fromCharCode(0x00e9) + ' malu', 'split-unicode');
  console.log('llmChat self-check OK');
}
