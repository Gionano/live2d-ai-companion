// ---------------------------------------------------------------------------
// visionCapture.js  (server-side)
// Vision perception router & intent detection.
// Distinguishes between "screen" vs "webcam" requests and calls
// Qwen 3.8 27B (Groq) for frame description.
// ---------------------------------------------------------------------------
import { groq } from './groqClient.js';

const VISION_MODEL = 'qwen/qwen3.8-27b';

const WEBCAM_PROMPT =
  'Deskripsikan secara singkat 1-2 kalimat apa yang sedang ditunjukkan atau terlihat di kamera/webcam ini.';

const SCREEN_PROMPT =
  'Deskripsikan secara ringkas dan padat dalam 1-2 kalimat apa yang sedang terjadi atau terlihat di layar/monitor/game ini (fokus pada aksi penting, status UI, teks utama, atau objek).';

/**
 * Send a frame to vision model — Qwen 3.8 27B (Groq)
 * @param {string} imageDataUrl - "data:image/jpeg;base64,..."
 * @param {'webcam'|'screen'} source
 */
export async function describeFrame(imageDataUrl, source = 'webcam') {
  const promptText = source === 'screen' ? SCREEN_PROMPT : WEBCAM_PROMPT;

  const startTime = performance.now();

  const res = await groq.chat.completions.create({
    model: VISION_MODEL,
    reasoning_effort: 'none',   // Non-thinking / instruct mode for fast response
    max_tokens: 150,
    temperature: 0.2,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageDataUrl } },
          { type: 'text', text: promptText },
        ],
      },
    ],
  });

  const latencyMs = Math.round(performance.now() - startTime);
  const description = res.choices[0]?.message?.content?.trim() ?? '';

  console.log(`[vision] Qwen 3.8 27B (Groq) ${source} — ${latencyMs}ms | "${description.slice(0, 80)}..."`);

  return description;
}

// Keyword categorizations for source routing
export const SCREEN_HINTS = [
  'layar', 'monitor', 'screen', 'share screen', 'sharescreen',
  'yang aku buka', 'yang lagi aku buka', 'lagi buka apa', 'aku buka apa',
  'yang lagi aku mainkan', 'yang aku mainkan', 'aku main apa', 'lagi main apa',
  'game aku', 'game ini', 'game-ku', 'gameku', 'gameplay',
  'di layar', 'di monitor', 'layarku', 'tampilan layar',
  'aplikasi ini', 'aplikasiku', 'codingan ini', 'kodingan ini', 'kodinganku',
  'buka apa', 'buka tab', 'halaman ini', 'web ini', 'browser',
];

export const WEBCAM_HINTS = [
  'kamera', 'webcam', 'kameraku', 'di kamera',
  'wajah', 'wajahku', 'mukaku', 'muka aku', 'muka saya',
  'tangan', 'tanganku', 'tangan aku', 'jari', 'jariku',
  'ini apa', 'apa ini', 'apa nih', 'ini apaan', 'benda ini', 'barang ini', 'ini namanya',
  'coba lihat ini', 'coba liat ini', 'lihat ini', 'liat ini',
  'kamu lihat ini', 'kamu liat ini', 'tunjukkan ini', 'tunjukin', 'tunjukin ini',
  'aku tunjukkan', 'aku tunjukkin', 'aku pegang', 'aku bawa', 'aku pakai',
  'warna apa', 'ini warna', 'bajuku', 'kamarku',
];

export const GENERAL_VISION_HINTS = [
  'lihat', 'liat', 'perhatikan', 'perhatiin', 'coba lihat', 'coba liat',
  'kamu lihat', 'kamu liat', 'menurut kamu ini', 'gimana ini', 'kelihatan nggak', 'keliatan ga',
];

/**
 * Detect whether the user wants to inspect "screen" or "webcam".
 * Uses keyword matching first; if ambiguous (only general hints like "lihat"),
 * falls back based on which sources are currently active.
 * @param {string} text
 * @param {{ hasWebcam?: boolean, hasScreen?: boolean }} availability
 * @returns {'screen'|'webcam'}
 */
export function detectVisionSource(text, availability = {}) {
  if (!text) return 'webcam';
  const t = text.toLowerCase();
  const { hasWebcam = true, hasScreen = false } = availability;

  // 1. Cek kecocokan eksplisit ke screen/layar
  if (SCREEN_HINTS.some((k) => t.includes(k))) {
    return 'screen';
  }

  // 2. Cek kecocokan eksplisit ke webcam/tunjuk fisik
  if (WEBCAM_HINTS.some((k) => t.includes(k))) {
    return 'webcam';
  }

  // 3. Ambigu (hanya general hints seperti "lihat", "perhatikan") →
  //    pilih berdasarkan sumber yang sedang aktif.
  //    Dua-duanya aktif → default ke webcam (kamera lebih natural).
  //    Hanya layar aktif → pakai layar.
  if (!hasWebcam && hasScreen) return 'screen';
  return 'webcam';
}

/**
 * Detect whether the utterance has any vision intent.
 * @param {string} text
 * @returns {boolean}
 */
export function detectVisionIntent(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    SCREEN_HINTS.some((k) => t.includes(k)) ||
    WEBCAM_HINTS.some((k) => t.includes(k)) ||
    GENERAL_VISION_HINTS.some((k) => t.includes(k))
  );
}

// Self-check: `node server/visionCapture.js`
if (process.argv[1] && process.argv[1].endsWith('visionCapture.js')) {
  const assert = (c, m) => {
    if (!c) throw new Error('FAIL: ' + m);
  };
  // Intent detection
  assert(detectVisionIntent('coba lihat layar aku') === true, 'intent screen');
  assert(detectVisionIntent('coba lihat yang di kamera ada apa') === true, 'intent kamera');
  assert(detectVisionIntent('halo apa kabar') === false, 'negatif intent');

  // Source detection — explicit keywords
  assert(detectVisionSource('coba lihat layar aku') === 'screen', 'source screen 1');
  assert(detectVisionSource('game aku lagi ngapain nih?') === 'screen', 'source screen 2');
  assert(detectVisionSource('ini apa sih?') === 'webcam', 'source webcam 1');
  assert(detectVisionSource('coba lihat ini') === 'webcam', 'source webcam 2');
  assert(detectVisionSource('coba lihat yang di kamera ada apa') === 'webcam', 'source kamera→webcam');
  assert(detectVisionSource('lihat wajahku dong') === 'webcam', 'source wajah→webcam');

  // Source detection — ambiguous with availability
  assert(detectVisionSource('coba lihat dong', { hasWebcam: true, hasScreen: true }) === 'webcam', 'ambigu both→webcam');
  assert(detectVisionSource('coba lihat dong', { hasWebcam: false, hasScreen: true }) === 'screen', 'ambigu only-screen→screen');
  assert(detectVisionSource('coba lihat dong', { hasWebcam: true, hasScreen: false }) === 'webcam', 'ambigu only-webcam→webcam');
  assert(detectVisionSource('coba lihat dong') === 'webcam', 'ambigu default→webcam');

  console.log('visionCapture self-check OK: all source & intent tests passed!');
}
