// ---------------------------------------------------------------------------
// moderation.js  (server-side, modul selfie / pap)
// Pembatas konten untuk permintaan selfie user dan prompt akhir.
// Menolak konten eksplisit/dewasa dan kekerasan secara sopan in-character tanpa ceramah.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import { loadSelfieConfig } from './config.js';

let cachedModeration = null;
let lastModerationPath = null;
let lastMtime = 0;

/**
 * Muat daftar kata terlarang dan kalimat penolakan dari JSON.
 */
export function loadModeration(moderationPath) {
  if (!moderationPath) {
    const cfg = loadSelfieConfig();
    moderationPath = cfg.moderationPath;
  }

  try {
    const stats = fs.statSync(moderationPath);
    if (cachedModeration && lastModerationPath === moderationPath && stats.mtimeMs === lastMtime) {
      return cachedModeration;
    }
    const raw = fs.readFileSync(moderationPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const forbiddenWords = (parsed.forbiddenWords || []).map((w) => w.trim().toLowerCase()).filter(Boolean);
    const compoundAllowlist = (parsed.compoundAllowlist || []).map((w) => w.trim().toLowerCase()).filter(Boolean);
    const refusalPhrases = parsed.refusalPhrases || [
      'Eits, jangan minta yang aneh-aneh ya sayang~ foto yang manis aja yaa.',
    ];
    const refusalEmotion = parsed.refusalEmotion || 'malu';

    cachedModeration = { forbiddenWords, compoundAllowlist, refusalPhrases, refusalEmotion };
    lastModerationPath = moderationPath;
    lastMtime = stats.mtimeMs;
    return cachedModeration;
  } catch (err) {
    // Log peringatan saat fallback — jangan silent
    console.warn('[selfie] [moderation] Gagal memuat selfieModeration.json, menggunakan fallback:', err.message);
    return {
      forbiddenWords: [
        'telanjang', 'bugil', 'nude', 'naked', 'nsfw', 'porn', 'vagina', 'penis', 'memek', 'kontol',
        'darah', 'bunuh', 'mutilasi', 'gore', 'blood', 'suicide', 'corpse', 'hentai', 'topless',
        'bikini', 'mandi', 'lingerie', 'underwear',
      ],
      compoundAllowlist: ['darah tinggi', 'tekanan darah', 'golongan darah', 'donor darah'],
      refusalPhrases: [
        'Eits, jangan minta yang aneh-aneh ya sayang~ foto yang manis aja yaa.',
      ],
      refusalEmotion: 'malu',
    };
  }
}

/**
 * Reset internal cache — untuk testing.
 */
export function _resetModerationCache() {
  cachedModeration = null;
  lastModerationPath = null;
  lastMtime = 0;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deteksi leetspeak sederhana: 5ex → sex, b1k1ni → bikini, dsb.
 * Ganti angka/simbol umum ke huruf yang sering dipalsukan.
 */
function normalizeLeetspeak(text) {
  return text
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's');
}

/**
 * Periksa apakah teks memicu pembatas konten kata terlarang.
 * @param {string} text - Teks permintaan user atau prompt yang disusun
 * @param {object} [options] - Opsional { moderationPath, config }
 * @returns {{ blocked: boolean, reason?: string, matchedWord?: string, refusalText?: string, emotion?: string }}
 */
export function checkModeration(text, options = {}) {
  if (!text || typeof text !== 'string') {
    return { blocked: false };
  }

  const moderationPath = options.moderationPath || (options.config && options.config.moderationPath);
  const { forbiddenWords, compoundAllowlist, refusalPhrases, refusalEmotion } = loadModeration(moderationPath);

  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s\u00C0-\u024F\u1E00-\u1EFF]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Versi leetspeak-normalized untuk deteksi tambahan
  const leetNormalized = normalizeLeetspeak(normalized);

  // Cek apakah teks mengandung frasa compound allowlist (mis. "darah tinggi")
  // Jika ya, jangan blokir berdasarkan sub-kata dari allowlist tsb.
  const activeAllowlist = (compoundAllowlist || []).filter((phrase) => normalized.includes(phrase));

  for (const word of forbiddenWords) {
    if (!word) continue;

    // Jika kata ini merupakan bagian dari compound yang di-allowlist, lewati
    if (activeAllowlist.some((compound) => compound.includes(word))) {
      continue;
    }

    // Jika kata majemuk (ada spasi), cek substring di normalized text
    if (word.includes(' ')) {
      if (normalized.includes(word)) {
        return buildRefusal(word, refusalPhrases, refusalEmotion);
      }
      // Cek juga pada leetspeak
      if (leetNormalized !== normalized && leetNormalized.includes(word)) {
        return buildRefusal(word, refusalPhrases, refusalEmotion);
      }
      continue;
    }

    // Jika kata tunggal, cek word boundary di teks asli
    const wordRegex = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i');
    if (wordRegex.test(normalized)) {
      return buildRefusal(word, refusalPhrases, refusalEmotion);
    }

    // Cek word boundary pada versi leetspeak-normalized
    if (leetNormalized !== normalized && wordRegex.test(leetNormalized)) {
      return buildRefusal(word, refusalPhrases, refusalEmotion);
    }

    // Cek obfuskasi spasi (mis. "b u g i l") — tapi HANYA dengan word-boundary
    // pada versi squashed. Squash spasi HANYA dari kata-kata pendek berulang
    // (menghindari false positive "skill" → "kill").
    // Strategi: jangan gunakan squashed substring. Cukup word-boundary + leetspeak.
    // Obfuskasi spasi ditangani oleh pengecekan kata yang sudah di-normalize
    // karena "b u g i l" → normalized → "b u g i l" → masih mengandung spasi.
    // Yang berbahaya adalah "b-u-g-i-l" → normalized → "b u g i l" (strip tanda hubung).
    // Jadi kita cek apakah menghapus spasi di antara karakter tunggal menghasilkan kata terlarang.
    if (word.length >= 4) {
      // Deteksi pola "b u g i l" atau "b.u.g.i.l" (karakter tunggal dipisah spasi)
      const spaced = normalized.match(/(?:^|\s)([a-z](?:\s[a-z]){3,})(?:\s|$)/g);
      if (spaced) {
        for (const segment of spaced) {
          const collapsed = segment.replace(/\s+/g, '');
          if (collapsed === word) {
            return buildRefusal(word, refusalPhrases, refusalEmotion);
          }
        }
      }
    }
  }

  return { blocked: false };
}

function buildRefusal(matchedWord, phrases, emotion) {
  const chosenPhrase = phrases[Math.floor(Math.random() * phrases.length)] || phrases[0];
  return {
    blocked: true,
    reason: 'FORBIDDEN_CONTENT',
    matchedWord,
    refusalText: chosenPhrase,
    emotion,
  };
}
