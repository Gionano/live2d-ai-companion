// ---------------------------------------------------------------------------
// llmChat.js  (server-side)
// Percakapan utama waifu lewat model "deepseek-v4-flash" (streaming).
// generateReply() adalah async generator: yield potongan teks (delta) begitu
// datang, supaya route /api/chat bisa mem-forward token demi token ke browser
// (dan nanti gampang dipecah per-kalimat untuk TTS).
// ---------------------------------------------------------------------------
import { client } from './nineInferenceClient.js';
import { CHAT_MODEL } from './modelConfig.js';
import { WAIFU_SYSTEM_PROMPT } from './personality.js';
export const HISTORY_MESSAGE_LIMIT = 8;
export const HISTORY_TOKEN_LIMIT = 700;
export const REPLY_EMOTIONS = new Set([
  'terkejut', 'marah', 'bingung', 'jengkel', 'malu', 'kesal',
  'sedih', 'kagum', 'sayang', 'jahil', 'penasaran', 'netral',
]);

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

// Parse the ordered JSON object incrementally so emotion can reach the avatar
// before the first complete sentence is sent to TTS. This preserves streaming.
export class StructuredReplyParser {
  constructor() {
    this.raw = '';
    this.emotion = null;
    this.textStarted = false;
    this.textFinished = false;
    this.scanAt = 0;
  }

  push(chunk) {
    this.raw += chunk;
    const events = [];

    if (!this.emotion) {
      const hit = this.raw.match(/"emotion"\s*:\s*"([^"]+)"/);
      if (hit) {
        this.emotion = normalizeEmotion(hit[1]);
        events.push({ type: 'emotion', emotion: this.emotion });
      }
    }

    if (!this.textStarted) {
      const hit = /"text"\s*:\s*"/.exec(this.raw);
      if (!hit) return events;
      this.textStarted = true;
      this.scanAt = hit.index + hit[0].length;
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

export async function* generateReply(
  conversationHistory,
  userMessage,
  visionDescription,
) {
  const rawHistory = Array.isArray(conversationHistory)
    ? conversationHistory
    : [];
  const trimmedHistory = trimConversationHistory(rawHistory);
  const messages = [{ role: 'system', content: WAIFU_SYSTEM_PROMPT }];

  for (const turn of trimmedHistory) messages.push(turn);

  if (visionDescription) {
    messages.push({
      role: 'system',
      content: `[User sedang menunjukkan: ${visionDescription}]`,
    });
  }

  messages.push({ role: 'user', content: userMessage });

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

  const stream = await client.chat.completions.create({
    model: CHAT_MODEL,
    messages,
    stream: true,
    response_format: { type: 'json_object' },
  });
  const parser = new StructuredReplyParser();

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (!delta) continue;
    for (const event of parser.push(delta)) yield event;
  }
  for (const event of parser.finish()) yield event;
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
) {
  let buf = '';
  for await (const event of generateReply(
    conversationHistory,
    userMessage,
    visionDescription,
  )) {
    if (event.type === 'emotion') {
      yield event;
      continue;
    }
    const delta = event.text;
    yield { type: 'delta', text: delta };
    buf += delta;
    let hit;
    while ((hit = takeSentence(buf))) {
      yield { type: 'sentence', text: hit.sentence };
      buf = hit.rest;
    }
  }
  const tail = buf.trim();
  if (tail) yield { type: 'sentence', text: tail };
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
    ...parser.push('```json\n{"emotion":"happy","te'),
    ...parser.push('xt":"Halo\nSayang!"}\n```'),
    ...parser.finish(),
  ];
  assert(events[0]?.type === 'emotion' && events[0].emotion === 'happy', 'json-emotion');
  assert(events.filter((e) => e.type === 'delta').map((e) => e.text).join('') === 'Halo\nSayang!', 'json-text');
  const unicodeParser = new StructuredReplyParser();
  const unicodeEvents = [
    ...unicodeParser.push('{"emotion":"shy","text":"Aku \\u00'),
    ...unicodeParser.push('e9 malu"}'),
  ];
  assert(unicodeEvents.filter((e) => e.type === 'delta').map((e) => e.text).join('') === 'Aku ' + String.fromCharCode(0x00e9) + ' malu', 'split-unicode');
  console.log('llmChat self-check OK');
}
