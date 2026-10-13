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
  'ini apa', 'apa ini', 'apa nih', 'ini apaan', 'benda ini', 'barang ini', 'ini namanya',
  'coba lihat ini', 'coba liat ini', 'lihat ini', 'liat ini',
  'kamu lihat ini', 'kamu liat ini', 'tunjukkan ini', 'tunjukin', 'tunjukin ini',
  'aku tunjukkan', 'aku tunjukkin', 'aku pegang', 'aku bawa', 'aku pakai',
  'warna apa', 'ini warna', 'wajahku', 'bajuku', 'kamarku', 'muka aku',
];

export const GENERAL_VISION_HINTS = [
  'lihat', 'liat', 'perhatikan', 'perhatiin', 'coba lihat', 'coba liat',
  'kamu lihat', 'kamu liat', 'menurut kamu ini', 'gimana ini', 'kelihatan nggak', 'keliatan ga',
];

// Kata kunci eksplisit KAMERA (kuat). "ini" sendirian = lemah, hanya dipakai
// kalau tidak ada kata layar.
const CAMERA_STRONG = [
  'kamera', 'webcam', 'wajah', 'muka', 'tanganku', 'tangan aku',
  'tangan ku', 'bajuku', 'kamarku',
];
const SCREEN_STRONG = ['layar', 'screen', 'game', 'monitor', 'gameplay'];

function firstIndex(t, keys) {
  let best = -1;
  for (const k of keys) {
    const i = t.indexOf(k);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
}

/**
 * Tentukan sumber yang DIMINTA user dari isi ucapan.
 * @returns {'screen'|'webcam'|null} null = ambigu (hanya "lihat" dsb)
 */
export function detectExplicitSource(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const cam = firstIndex(t, CAMERA_STRONG);
  const scr = [firstIndex(t, SCREEN_STRONG), firstIndex(t, SCREEN_HINTS)]
    .filter((i) => i !== -1)
    .reduce((a, b) => Math.min(a, b), Infinity);
  const hasScr = scr !== Infinity;
  // Keduanya disebut -> yang disebut duluan menang (satu sumber saja).
  if (cam !== -1 && hasScr) return cam <= scr ? 'webcam' : 'screen';
  if (cam !== -1) return 'webcam';
  if (hasScr) return 'screen';
  if (WEBCAM_HINTS.some((k) => t.includes(k)) || /\bini\b/.test(t)) return 'webcam';
  return null;
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
    detectExplicitSource(text) !== null ||
    GENERAL_VISION_HINTS.some((k) => t.includes(k))
  );
}

/**
 * Routing final: pilih TEPAT SATU sumber berdasarkan ucapan + ketersediaan.
 * source = sumber yang dipakai (null kalau tak ada yang aktif);
 * requested = sumber eksplisit yang diminta user (null kalau ambigu);
 * available = apakah source yang dipilih benar-benar aktif.
 * @param {string} text
 * @param {{hasCamera:boolean, hasScreen:boolean}} avail
 */
export function resolveVisionSource(text, { hasCamera, hasScreen }) {
  const requested = detectExplicitSource(text);
  if (requested === 'webcam') {
    return { source: 'webcam', requested, available: hasCamera };
  }
  if (requested === 'screen') {
    return { source: 'screen', requested, available: hasScreen };
  }
  // Ambigu: pakai yang aktif; keduanya aktif -> kamera.
  if (hasCamera) return { source: 'webcam', requested, available: true };
  if (hasScreen) return { source: 'screen', requested, available: true };
  return { source: null, requested, available: false };
}

// Self-check: `node server/visionCapture.js`
if (process.argv[1] && process.argv[1].endsWith('visionCapture.js')) {
  const assert = (c, m) => {
    if (!c) throw new Error('FAIL: ' + m);
  };
  const both = { hasCamera: true, hasScreen: true };
  const camOnly = { hasCamera: true, hasScreen: false };
  const scrOnly = { hasCamera: false, hasScreen: true };
  const none = { hasCamera: false, hasScreen: false };
  const r = (t, a) => resolveVisionSource(t, a);
  assert(detectVisionIntent('coba lihat layar aku') === true, 'intent screen');
  assert(r('coba lihat yang di kamera ada apa', both).source === 'webcam', 'kamera eksplisit');
  assert(r('coba lihat yang di kamera ada apa', scrOnly).available === false, 'kamera off');
  assert(r('lihat layar aku', both).source === 'screen', 'layar eksplisit');
  assert(r('lihat layar aku', camOnly).available === false, 'layar off');
  assert(r('game ini seru ga', both).source === 'screen', 'game ini = layar');
  assert(r('ini apa sih?', both).source === 'webcam', 'ini = kamera');
  assert(r('coba lihat dong', both).source === 'webcam', 'ambigu both -> kamera');
  assert(r('coba lihat dong', scrOnly).source === 'screen', 'ambigu screen only');
  assert(r('coba lihat dong', none).source === null, 'ambigu none');
  assert(detectVisionIntent('halo apa kabar') === false, 'negatif intent');
  console.log('visionCapture self-check OK: all source & intent tests passed!');
}
