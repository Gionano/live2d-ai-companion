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
    const refusalPhrases = parsed.refusalPhrases || [
      'Eits, jangan minta yang aneh-aneh ya sayang~ foto yang manis aja yaa.',
    ];
    const refusalEmotion = parsed.refusalEmotion || 'malu';

    cachedModeration = { forbiddenWords, refusalPhrases, refusalEmotion };
    lastModerationPath = moderationPath;
    lastMtime = stats.mtimeMs;
    return cachedModeration;
  } catch (err) {
    return {
      forbiddenWords: [
        'telanjang', 'bugil', 'nude', 'naked', 'nsfw', 'porn', 'vagina', 'penis', 'memek', 'kontol',
        'darah', 'bunuh', 'mutilasi', 'gore', 'blood', 'suicide', 'corpse',
      ],
      refusalPhrases: [
        'Eits, jangan minta yang aneh-aneh ya sayang~ foto yang manis aja yaa.',
      ],
      refusalEmotion: 'malu',
    };
  }
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const { forbiddenWords, refusalPhrases, refusalEmotion } = loadModeration(moderationPath);

  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s\u00C0-\u024F\u1E00-\u1EFF]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Versi squashed tanpa spasi untuk mendeteksi obfuskasi sederhana (mis. "b u g i l")
  const squashed = normalized.replace(/\s+/g, '');

  for (const word of forbiddenWords) {
    if (!word) continue;

    // Jika kata majemuk (ada spasi), cek substring di normalized text
    if (word.includes(' ')) {
      if (normalized.includes(word)) {
        return buildRefusal(word, refusalPhrases, refusalEmotion);
      }
      continue;
    }

    // Jika kata tunggal, cek word boundary
    const wordRegex = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i');
    if (wordRegex.test(normalized)) {
      return buildRefusal(word, refusalPhrases, refusalEmotion);
    }

    // Cek squashed untuk kata minimal 4 huruf (hindari false positive kata pendek)
    if (word.length >= 4 && squashed.includes(word)) {
      return buildRefusal(word, refusalPhrases, refusalEmotion);
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
