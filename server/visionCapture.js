// ---------------------------------------------------------------------------
// visionCapture.js  (server-side)
// Vision perception router & intent detection.
// Distinguishes between "screen" vs "webcam" requests and calls MiniMax M3.
// ---------------------------------------------------------------------------
import { client } from './nineInferenceClient.js';
import { VISION_MODEL } from './modelConfig.js';

const WEBCAM_PROMPT =
  'Deskripsikan secara singkat 1-2 kalimat apa yang sedang ditunjukkan atau terlihat di kamera/webcam ini.';

const SCREEN_PROMPT =
  'Deskripsikan secara ringkas dan padat dalam 1-2 kalimat apa yang sedang terjadi atau terlihat di layar/monitor/game ini (fokus pada aksi penting, status UI, teks utama, atau objek).';

/**
 * Send a frame to vision model (MiniMax M3)
 * @param {string} imageDataUrl - "data:image/jpeg;base64,..."
 * @param {'webcam'|'screen'} source
 */
export async function describeFrame(imageDataUrl, source = 'webcam') {
  const promptText = source === 'screen' ? SCREEN_PROMPT : WEBCAM_PROMPT;

  const res = await client.chat.completions.create({
    model: VISION_MODEL,
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

  return res.choices[0]?.message?.content?.trim() ?? '';
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

/**
 * Detect whether the user wants to inspect "screen" or "webcam".
 * Default to "webcam" if ambiguous.
 * @param {string} text
 * @returns {'screen'|'webcam'}
 */
export function detectVisionSource(text) {
  if (!text) return 'webcam';
  const t = text.toLowerCase();

  // 1. Cek kecocokan eksplisit ke screen/layar
  if (SCREEN_HINTS.some((k) => t.includes(k))) {
    return 'screen';
  }

  // 2. Cek kecocokan eksplisit ke webcam/tunjuk fisik
  if (WEBCAM_HINTS.some((k) => t.includes(k))) {
    return 'webcam';
  }

  // 3. Default ke webcam untuk intent umum ("coba lihat", dsb)
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
  assert(detectVisionIntent('coba lihat layar aku') === true, 'intent screen');
  assert(detectVisionSource('coba lihat layar aku') === 'screen', 'source screen 1');
  assert(detectVisionSource('game aku lagi ngapain nih?') === 'screen', 'source screen 2');
  assert(detectVisionSource('ini apa sih?') === 'webcam', 'source webcam 1');
  assert(detectVisionSource('coba lihat ini') === 'webcam', 'source webcam 2');
  assert(detectVisionSource('coba lihat dong') === 'webcam', 'source default webcam');
  assert(detectVisionIntent('halo apa kabar') === false, 'negatif intent');
  console.log('visionCapture self-check OK: all source & intent tests passed!');
}
