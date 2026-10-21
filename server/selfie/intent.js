// ---------------------------------------------------------------------------
// intent.js  (server-side, modul selfie / pap)
// Mendeteksi intent permintaan selfie/foto avatar dari teks STT atau input teks.
// Daftar kata kunci dan pola dibaca dari file konfigurasi (selfieKeywords.json).
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import { loadSelfieConfig } from './config.js';

let cachedKeywords = null;
let lastKeywordsPath = null;
let lastMtime = 0;

/**
 * Escape karakter spesial regex.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Buat regex word-boundary-aware untuk sebuah frasa.
 * Bahasa Indonesia tidak punya spasi natural-boundary yang sempurna,
 * jadi kita gunakan \b (atau look-around untuk awal/akhir string) pada
 * SELURUH frasa, bukan per kata.
 *
 * Contoh: frasa "minta foto" hanya match "minta foto" sebagai token utuh,
 * BUKAN substring dari "meninta fotonya" (tapi ini sudah ditangani \b cukup baik).
 * Kasus khusus: "ambil foto" dihapus karena terlalu generik (bisa berarti screenshot).
 */
function phraseToWordBoundaryRegex(phrase) {
  // Untuk frasa multi-kata: gunakan \b di awal dan akhir frasa
  // Untuk single-word: \b di kedua sisi
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i');
}

/**
 * Muat daftar kata kunci dari file JSON dengan auto-reload jika file berubah.
 */
export function loadKeywords(keywordsPath) {
  if (!keywordsPath) {
    const cfg = loadSelfieConfig();
    keywordsPath = cfg.keywordsPath;
  }

  try {
    const stats = fs.statSync(keywordsPath);
    if (cachedKeywords && lastKeywordsPath === keywordsPath && stats.mtimeMs === lastMtime) {
      return cachedKeywords;
    }
    const raw = fs.readFileSync(keywordsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const rawPhrases = (parsed.phrases || []).map((p) => p.trim().toLowerCase()).filter(Boolean);

    // Compile setiap frasa jadi regex word-boundary-aware
    const phraseRegexes = rawPhrases.map((p) => ({
      phrase: p,
      regex: phraseToWordBoundaryRegex(p),
    }));

    const wordPatterns = (parsed.wordPatterns || []).map((p) => new RegExp(p, 'i'));

    cachedKeywords = { phraseRegexes, wordPatterns };
    lastKeywordsPath = keywordsPath;
    lastMtime = stats.mtimeMs;
    return cachedKeywords;
  } catch (err) {
    // Fallback aman jika file belum terbaca — log peringatan
    console.warn('[selfie] [intent] Gagal memuat selfieKeywords.json, menggunakan fallback:', err.message);
    const fallbackPhrases = [
      'pap', 'selfie', 'minta foto', 'minta selfie', 'minta pap',
      'foto dong', 'fotoin dong', 'fotoin dirimu', 'fotoin kamu',
      'kirim fotomu', 'kirim gambarmu', 'spill foto',
      'coba pap', 'pap dong', 'pap muka',
    ];
    const fallback = {
      phraseRegexes: fallbackPhrases.map((p) => ({
        phrase: p,
        regex: phraseToWordBoundaryRegex(p),
      })),
      wordPatterns: [/\bpap\b/i, /\bselfie\b/i],
    };
    return fallback;
  }
}

/**
 * Reset internal cache — untuk testing.
 */
export function _resetCache() {
  cachedKeywords = null;
  lastKeywordsPath = null;
  lastMtime = 0;
}

/**
 * Deteksi apakah teks masukan user merupakan permintaan selfie / pap.
 * @param {string} text - Teks dari STT atau typed input
 * @param {object} [options] - Opsional { keywordsPath, config }
 * @returns {{ isSelfie: boolean, matchedKeyword: string | null }}
 */
export function detectSelfieIntent(text, options = {}) {
  if (!text || typeof text !== 'string') {
    return { isSelfie: false, matchedKeyword: null };
  }

  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s\u00C0-\u024F\u1E00-\u1EFF]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return { isSelfie: false, matchedKeyword: null };
  }

  const keywordsPath = options.keywordsPath || (options.config && options.config.keywordsPath);
  const { phraseRegexes, wordPatterns } = loadKeywords(keywordsPath);

  // 1. Cek regex word pattern (misal \bpap\b) agar tidak salah tangkap "papua" atau "papan"
  for (const regex of wordPatterns) {
    if (regex.test(normalized)) {
      const match = normalized.match(regex);
      return { isSelfie: true, matchedKeyword: match ? match[0] : regex.source };
    }
  }

  // 2. Cek frasa dengan word-boundary regex (bukan .includes())
  for (const { phrase, regex } of phraseRegexes) {
    if (regex.test(normalized)) {
      return { isSelfie: true, matchedKeyword: phrase };
    }
  }

  return { isSelfie: false, matchedKeyword: null };
}
