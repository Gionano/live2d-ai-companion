// ---------------------------------------------------------------------------
// slotMatcher.js  (server-side, modul selfie / pap)
// Validasi dan normalisasi slot adegan selfie terhadap whitelist.
// Jika slot tidak valid atau di luar whitelist: mencocokkan alias, mencari slot terdekat
// (Levenshtein distance), atau kembali ke nilai default.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';

/**
 * Hitung jarak Levenshtein antara dua string.
 */
export function levenshteinDistance(a, b) {
  const s1 = String(a || '').toLowerCase();
  const s2 = String(b || '').toLowerCase();
  const m = s1.length;
  const n = s2.length;
  if (!m) return n;
  if (!n) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}

/**
 * Cari kandidat whitelist terdekat berdasarkan jarak edit (Levenshtein).
 */
export function findClosestMatch(val, candidates, maxRelativeDist = 0.45) {
  if (!val || !candidates || candidates.length === 0) return null;
  const target = String(val).toLowerCase().trim().replace(/[-_\s]+/g, '_');

  let bestMatch = null;
  let bestDist = Infinity;

  for (const cand of candidates) {
    const candNorm = cand.toLowerCase().replace(/[-_\s]+/g, '_');
    if (candNorm === target) return cand;

    const dist = levenshteinDistance(target, candNorm);
    const maxLen = Math.max(target.length, candNorm.length);
    const relDist = dist / maxLen;

    if (dist < bestDist && relDist <= maxRelativeDist) {
      bestDist = dist;
      bestMatch = cand;
    }
  }

  return bestMatch;
}

/**
 * Normalisasi satu nilai slot berdasarkan whitelist, alias, dan nilai default.
 */
export function matchSlot(rawVal, slotName, whitelistObj, aliasesObj = {}, defaultVal = '') {
  if (!rawVal && rawVal !== 0) return defaultVal;

  const candidates = Array.isArray(whitelistObj)
    ? whitelistObj
    : Object.keys(whitelistObj || {});

  const clean = String(rawVal).toLowerCase().trim();
  const cleanWithUnderscore = clean.replace(/[\s-]+/g, '_');

  // 1. Cek exact match langsung di whitelist keys
  const exact = candidates.find((c) => c.toLowerCase() === clean || c.toLowerCase() === cleanWithUnderscore);
  if (exact) return exact;

  // 2. Cek alias map
  if (aliasesObj) {
    if (aliasesObj[clean]) return aliasesObj[clean];
    if (aliasesObj[cleanWithUnderscore]) return aliasesObj[cleanWithUnderscore];
  }

  // 3. Cek closest match di alias keys terlebih dahulu
  if (aliasesObj) {
    const aliasKeys = Object.keys(aliasesObj);
    const matchedAlias = findClosestMatch(clean, aliasKeys, 0.4);
    if (matchedAlias && aliasesObj[matchedAlias]) {
      return aliasesObj[matchedAlias];
    }
  }

  // 4. Cek closest match langsung di whitelist candidates
  const closest = findClosestMatch(cleanWithUnderscore, candidates, 0.45);
  if (closest) return closest;

  // 5. Fallback ke default
  return defaultVal;
}

/**
 * Validasi dan normalisasi seluruh objek slot dari hasil output LLM planner.
 * @param {object} rawSlots - Objek hasil parse JSON dari planner LLM
 * @param {object} characterCard - Data kartu karakter
 * @param {string[]} [availableReferences] - Daftar nama file gambar referensi yang ada di disk
 * @returns {object} Objek slot yang sudah bersih dan terjamin ada di whitelist
 */
export function normalizeSlots(rawSlots, characterCard, availableReferences = []) {
  const card = characterCard || {};
  const wl = card.whitelist || {};
  const aliases = card.aliases || {};
  const defs = card.defaults || {};

  const input = rawSlots && typeof rawSlots === 'object' ? rawSlots : {};

  // Pose
  const pose = matchSlot(input.pose, 'pose', wl.pose, aliases.pose, defs.pose || 'holding_camera');

  // Ekspresi
  const ekspresi = matchSlot(input.ekspresi, 'ekspresi', wl.ekspresi, aliases.ekspresi, defs.ekspresi || 'smile');

  // Latar
  const latar = matchSlot(input.latar, 'latar', wl.latar, aliases.latar, defs.latar || 'living_room');

  // Sudut kamera
  const sudut_kamera = matchSlot(
    input.sudut_kamera || input.sudutKamera || input.camera_angle,
    'sudut_kamera',
    wl.sudut_kamera,
    aliases.sudut_kamera,
    defs.sudut_kamera || 'selfie_angle',
  );

  // Pencahayaan
  const pencahayaan = matchSlot(
    input.pencahayaan || input.lighting,
    'pencahayaan',
    wl.pencahayaan,
    aliases.pencahayaan,
    defs.pencahayaan || 'natural_daylight',
  );

  // Pakaian (harus berupa nama file referensi yang ada)
  const allowedRefs = availableReferences.length > 0
    ? availableReferences
    : Object.keys(wl.pakaian || { 'default.jpg': '' });
  
  const rawPakaian = String(input.pakaian || input.outfit || '').trim();
  let pakaian = defs.pakaian || 'default.jpg';

  if (rawPakaian) {
    const directHit = allowedRefs.find((f) => f.toLowerCase() === rawPakaian.toLowerCase());
    if (directHit) {
      pakaian = directHit;
    } else {
      // Coba tambah ekstensi bila user/LLM hanya menulis nama tanpa .jpg/.png
      const withExt = allowedRefs.find(
        (f) => path.parse(f).name.toLowerCase() === rawPakaian.toLowerCase(),
      );
      if (withExt) {
        pakaian = withExt;
      } else {
        const closestRef = findClosestMatch(rawPakaian, allowedRefs, 0.45);
        if (closestRef) pakaian = closestRef;
      }
    }
  }

  // Emotion
  const allowedEmotions = Array.isArray(wl.emotion)
    ? wl.emotion
    : ['terkejut', 'marah', 'bingung', 'jengkel', 'malu', 'kesal', 'sedih', 'kagum', 'sayang', 'jahil', 'penasaran', 'netral'];
  const rawEmotion = String(input.emotion || '').trim().toLowerCase();
  const emotion = allowedEmotions.includes(rawEmotion)
    ? rawEmotion
    : (defs.emotion || 'sayang');

  // Caption (ucapan avatar)
  let caption = typeof input.caption === 'string' ? input.caption.trim() : '';
  if (!caption) {
    caption = defs.caption || 'Ini fotonya buat kamu sayang~ Gimana menurutmu?';
  }
  // Batasi panjang caption maksimal 250 karakter
  if (caption.length > 250) {
    caption = caption.slice(0, 247) + '...';
  }

  return {
    pose,
    ekspresi,
    latar,
    pakaian,
    sudut_kamera,
    pencahayaan,
    emotion,
    caption,
  };
}
