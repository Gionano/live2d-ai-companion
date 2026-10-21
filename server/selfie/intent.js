// ---------------------------------------------------------------------------
// intent.js  (server-side, modul selfie / pap)
// Mendeteksi intent permintaan selfie/foto avatar dari teks STT atau input teks.
// Daftar kata kunci dan pola dibaca dari file konfigurasi (selfieKeywords.json).
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { loadSelfieConfig } from './config.js';

let cachedKeywords = null;
let lastKeywordsPath = null;
let lastMtime = 0;

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
    const phrases = (parsed.phrases || []).map((p) => p.trim().toLowerCase()).filter(Boolean);
    const wordPatterns = (parsed.wordPatterns || []).map((p) => new RegExp(p, 'i'));

    cachedKeywords = { phrases, wordPatterns };
    lastKeywordsPath = keywordsPath;
    lastMtime = stats.mtimeMs;
    return cachedKeywords;
  } catch (err) {
    // Fallback aman jika file belum terbaca
    const fallback = {
      phrases: [
        'pap', 'selfie', 'minta foto', 'minta selfie', 'minta pap',
        'foto dong', 'fotoin dong', 'fotoin dirimu', 'fotoin kamu',
        'kirim foto', 'kirim gambar', 'bagi foto', 'spill foto',
        'lihat kamu dong', 'coba pap', 'pap dong',
      ],
      wordPatterns: [/\bpap\b/i, /\bselfie\b/i],
    };
    return fallback;
  }
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
  const { phrases, wordPatterns } = loadKeywords(keywordsPath);

  // 1. Cek regex word pattern (misal \bpap\b) agar tidak salah tangkap "papua" atau "papan"
  for (const regex of wordPatterns) {
    if (regex.test(normalized)) {
      const match = normalized.match(regex);
      return { isSelfie: true, matchedKeyword: match ? match[0] : regex.source };
    }
  }

  // 2. Cek phrase inclusion
  for (const phrase of phrases) {
    if (!phrase) continue;
    // Jika single word (mis. "pap"), pastikan batasan kata utuh
    if (!phrase.includes(' ')) {
      const singleWordRegex = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i');
      if (singleWordRegex.test(normalized)) {
        return { isSelfie: true, matchedKeyword: phrase };
      }
    } else if (normalized.includes(phrase)) {
      return { isSelfie: true, matchedKeyword: phrase };
    }
  }

  return { isSelfie: false, matchedKeyword: null };
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
