// ---------------------------------------------------------------------------
// _timingProbe.js  (diagnostik, bukan bagian app)
// Ukur latensi dua tahap network-bound yang paling mungkin jadi biang delay
// ~8 detik: LLM (9inference / deepseek-v4-flash) dan TTS (Fish Audio).
// STT (Groq Whisper) TIDAK diukur di sini karena butuh sample audio suara asli
// — itu terukur live dari log [timing] server saat kamu benar-benar bicara.
//
// Jalankan:  node server/_timingProbe.js [jumlah_run]   (default 3)
//
// Mengukur, dengan client REAL (jadi angka = latensi jaringan sebenarnya):
//   - LLM req -> token pertama (time-to-first-token)
//   - LLM req -> kalimat pertama utuh (yang jadi trigger TTS pertama)
//   - LLM req -> selesai total
//   - TTS req kalimat-1 -> chunk audio pertama, dan -> selesai
// ---------------------------------------------------------------------------
import { generateReplyStream } from './llmChat.js';
import { generateSpeech } from './ttsGenerate.js';
import { isVoiceConfigured } from './voiceConfig.js';

const ms = (a, b) => Math.round((b ?? performance.now()) - a);
const PROMPT = 'Halo Amika, apa kabar hari ini? Ceritakan sedikit soal dirimu ya.';

async function once(run) {
  let tFirstToken = 0;
  let tFirstSentence = 0;
  let firstSentence = '';
  let full = '';

  const tLlm = performance.now();
  for await (const ev of generateReplyStream([], PROMPT, null)) {
    if (ev.type === 'delta') {
      if (!tFirstToken) tFirstToken = performance.now();
      full += ev.text;
    } else if (ev.type === 'sentence') {
      if (!tFirstSentence) {
        tFirstSentence = performance.now();
        firstSentence = ev.text;
      }
    }
  }
  const tLlmDone = performance.now();

  let ttsLine = 'TTS: (voice belum dikonfigurasi -> skip)';
  if (isVoiceConfigured() && firstSentence) {
    const tTts = performance.now();
    let tChunk = 0;
    let bytes = 0;
    let n = 0;
    for await (const chunk of generateSpeech(firstSentence)) {
      if (!tChunk) tChunk = performance.now();
      bytes += chunk.length;
      n++;
    }
    const tTtsDone = performance.now();
    ttsLine =
      `TTS req->first chunk: ${ms(tTts, tChunk)}ms | TTS selesai: ${ms(tTts, tTtsDone)}ms` +
      ` (${n} chunk, ${bytes}B)`;
  }

  console.log(
    `[probe #${run}] LLM ttft: ${ms(tLlm, tFirstToken)}ms` +
      ` | LLM first sentence: ${ms(tLlm, tFirstSentence)}ms` +
      ` | LLM selesai: ${ms(tLlm, tLlmDone)}ms (${full.length} char)`,
  );
  console.log(`           ${ttsLine}`);
  console.log(`           kalimat-1: "${firstSentence}"`);
}

const RUNS = Number(process.argv[2] || 3);
for (let i = 1; i <= RUNS; i++) {
  try {
    await once(i);
  } catch (e) {
    console.error(`[probe #${i}] gagal:`, e.message);
  }
}
