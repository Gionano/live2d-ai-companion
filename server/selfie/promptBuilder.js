// ---------------------------------------------------------------------------
// promptBuilder.js  (server-side, modul selfie / pap)
// Penyusunan prompt gambar secara deterministik dari template di characterCard.json.
// Penampilan fisik karakter & baju sudah dibawa oleh gambar referensi (LoadImage node),
// sehingga prompt TIDAK menyalin deskripsi detail rambut atau gaun, melainkan fokus
// pada instruksi perubahan (pose, ekspresi, latar, sudut kamera, pencahayaan) dalam bahasa Inggris.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import { loadSelfieConfig } from './config.js';

let cachedCard = null;
let lastCardPath = null;
let lastMtime = 0;

/**
 * Muat data characterCard dari path JSON.
 */
export function loadCharacterCard(cardPath) {
  if (!cardPath) {
    const cfg = loadSelfieConfig();
    cardPath = cfg.characterCardPath;
  }

  try {
    const stats = fs.statSync(cardPath);
    if (cachedCard && lastCardPath === cardPath && stats.mtimeMs === lastMtime) {
      return cachedCard;
    }
    const raw = fs.readFileSync(cardPath, 'utf-8');
    cachedCard = JSON.parse(raw);
    lastCardPath = cardPath;
    lastMtime = stats.mtimeMs;
    return cachedCard;
  } catch (err) {
    throw new Error(`Gagal membaca characterCard di "${cardPath}": ${err.message}`);
  }
}

/**
 * Reset internal cache — untuk testing.
 */
export function _resetCardCache() {
  cachedCard = null;
  lastCardPath = null;
  lastMtime = 0;
}

/**
 * Default template yang selaras dengan spec: pertahankan karakter referensi apa adanya
 * (termasuk art style), HANYA ubah pose/ekspresi/latar/kamera/pencahayaan.
 * JANGAN mendorong "photographic aesthetic" jika referensi adalah anime/ilustrasi.
 */
const DEFAULT_TEMPLATE =
  'Keep the character exactly as in the reference image (same face, hair, outfit, and art style). ' +
  'Change only the following: pose — {pose}; expression — {expression}; background — {background}; ' +
  'camera angle — {cameraAngle}; lighting — {lighting}. ' +
  'High quality, detailed, crisp focus.';

const DEFAULT_NEGATIVE =
  'nsfw, nude, naked, cleavage, sexual, suggestive, explicit, nipples, exposed breasts, ' +
  'lingerie, bikini, underwear, violence, gore, blood, weapons, bad anatomy, deformed, distorted, blurry, ' +
  'low quality, duplicate, extra limbs, bad hands, mutated fingers, watermark, text';

/**
 * Placeholder yang diharapkan ada di template.
 */
const PLACEHOLDERS = ['{pose}', '{expression}', '{background}', '{cameraAngle}', '{lighting}'];

/**
 * Susun prompt positif dan negatif deterministik dari slot yang sudah dinormalisasi.
 * @param {object} slots - Objek slot ter-normalisasi { pose, ekspresi, latar, pakaian, sudut_kamera, pencahayaan, caption, emotion }
 * @param {object} [characterCard] - Kartu karakter (jika tidak disediakan, dimuat dari config)
 * @param {object} [config] - Opsi konfigurasi tambahan
 * @returns {{ positivePrompt: string, negativePrompt: string, referenceImage: string, slots: object, caption: string, emotion: string }}
 */
export function buildPrompt(slots, characterCard = null, config = null) {
  const card = characterCard || loadCharacterCard(config?.characterCardPath);
  const wl = card.whitelist || {};

  const poseDesc = wl.pose?.[slots.pose] || slots.pose || 'holding smartphone taking front selfie';
  const exprDesc = wl.ekspresi?.[slots.ekspresi] || slots.ekspresi || 'gentle smile';
  const bgDesc = wl.latar?.[slots.latar] || slots.latar || 'indoor living room background';
  const angleDesc = wl.sudut_kamera?.[slots.sudut_kamera] || slots.sudut_kamera || 'selfie angle from arm length';
  const lightDesc = wl.pencahayaan?.[slots.pencahayaan] || slots.pencahayaan || 'natural daylight';

  const template = card.promptTemplate || DEFAULT_TEMPLATE;

  // Gunakan replaceAll agar SEMUA kemunculan placeholder terganti (bukan hanya yang pertama)
  const replacements = {
    '{pose}': poseDesc,
    '{expression}': exprDesc,
    '{background}': bgDesc,
    '{cameraAngle}': angleDesc,
    '{lighting}': lightDesc,
  };

  let positivePrompt = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    positivePrompt = positivePrompt.replaceAll(placeholder, value);
  }

  // Periksa apakah ada placeholder yang belum terganti (template salah isi)
  const remaining = positivePrompt.match(/\{[a-zA-Z_]+\}/g);
  if (remaining) {
    console.warn(
      `[selfie] [promptBuilder] Template masih memiliki placeholder yang tidak terganti: ${remaining.join(', ')}. ` +
      `Placeholder yang didukung: ${PLACEHOLDERS.join(', ')}.`,
    );
  }

  const negativePrompt = config?.negativePrompt || card.negativePrompt || DEFAULT_NEGATIVE;

  return {
    positivePrompt,
    negativePrompt,
    referenceImage: slots.pakaian || 'default.jpg',
    slots,
    caption: slots.caption,
    emotion: slots.emotion,
  };
}
