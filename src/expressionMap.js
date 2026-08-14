// ---------------------------------------------------------------------------
// expressionMap.js  (browser-side)
// Mapping terpusat: emotion Indonesia (dari LLM) → nama expression Live2D
// (file .exp3.json), intensity profile untuk bias animasi bicara.
//
// KOSTUM / AKSESORIS dipisahkan — tidak masuk enum LLM, dikontrol manual
// lewat panel debug.
// ---------------------------------------------------------------------------

/**
 * Setiap emotion yang bisa dikembalikan LLM dipetakan ke:
 *  - expression: nama expression persis di model3.json (string Mandarin).
 *                null berarti "clear / netral".
 *  - intensity:  kategori amplitudo gerak saat bicara (Layer 1 & 2).
 */
export const EMOTION_MAP = {
  terkejut:  { expression: '惊讶',   intensity: 'tinggi' },
  marah:     { expression: '生气',   intensity: 'tinggi' },
  bingung:   { expression: '疑惑',   intensity: 'sedang' },
  jengkel:   { expression: '白眼',   intensity: 'sedang' },
  malu:      { expression: '脸红',   intensity: 'rendah' },
  kesal:     { expression: '脸黑',   intensity: 'rendah' },
  sedih:     { expression: '流泪',   intensity: 'rendah' },
  kagum:     { expression: '星星眼', intensity: 'tinggi' },
  sayang:    { expression: '爱心眼', intensity: 'sedang' },
  jahil:     { expression: '舌头',   intensity: 'tinggi' },
  penasaran: { expression: '←歪嘴',  intensity: 'sedang' },
  netral:    { expression: null,     intensity: 'sedang' },
};

/** Daftar semua emotion valid (dipakai server-side juga via shared constant). */
export const VALID_EMOTIONS = Object.keys(EMOTION_MAP);

/**
 * Pengali magnitude untuk Layer 1 (procedural body sway) dan bias frekuensi
 * trigger Layer 2 (discrete motion clips).
 */
export const INTENSITY_MULTIPLIER = {
  tinggi: 1.6,
  sedang: 1.0,
  rendah: 0.5,
};

/**
 * Expression-expression ini adalah toggle kostum/aksesoris, BUKAN emosi.
 * Dikontrol manual lewat panel debug, tidak berubah otomatis dari LLM.
 */
export const COSTUME_TOGGLES = [
  { name: '手柄',     label: 'Handle / Gamepad' },
  { name: '披发',     label: 'Rambut Terurai' },
  { name: '猫耳',     label: 'Kuping Kucing' },
  { name: '王冠',     label: 'Mahkota' },
  { name: '直播套装', label: 'Outfit Live' },
  { name: '翅膀',     label: 'Sayap' },
  { name: '马尾',     label: 'Kuncir Kuda' },
  { name: '金钱眼',   label: 'Mata Uang' },
  { name: '歪嘴→',    label: 'Mulut Kanan' },
];
