// ---------------------------------------------------------------------------
// framingConfig.js
// Kamera / Viewport Framing presets untuk tampilan avatar Live2D.
// Model tetap full-body, hanya projection matrix yang di-scale & offset
// sehingga bagian bawah ter-crop di luar viewport tanpa merusak skeleton.
// ---------------------------------------------------------------------------

export const FRAMING_PRESETS = {
  desktop: {
    full: { scale: 1.0, x: 0.0, y: 0.0, label: 'Full Body' },
    half: { scale: 2.0, x: 0.0, y: -0.85, label: 'Half Body' },
    closeup: { scale: 3.0, x: 0.0, y: -1.5, label: 'Close-up' },
  },
  mobile: {
    full: { scale: 1.0, x: 0.0, y: 0.0, label: 'Full Body' },
    half: { scale: 1.9, x: 0.0, y: -0.65, label: 'Half Body' },
    closeup: { scale: 2.8, x: 0.0, y: -1.15, label: 'Close-up' },
  },
};

export const STORAGE_KEY_PREFIX = 'live2d_framing_';

/**
 * Deteksi layout aktif (desktop vs mobile PiP)
 * @returns {'desktop'|'mobile'}
 */
export function getActiveLayout() {
  return window.innerWidth <= 768 ? 'mobile' : 'desktop';
}

/**
 * Dapatkan preset yang tersimpan di localStorage per layout
 * @param {'desktop'|'mobile'} [layout]
 * @returns {string}
 */
export function getSavedPreset(layout = null) {
  const currentLayout = layout || getActiveLayout();
  const key = `${STORAGE_KEY_PREFIX}${currentLayout}`;
  try {
    const saved = localStorage.getItem(key);
    if (saved && FRAMING_PRESETS[currentLayout]?.[saved]) {
      return saved;
    }
  } catch (_) {}
  // Default: mobile PiP lebih pas half-body, desktop full-body
  return currentLayout === 'mobile' ? 'half' : 'full';
}

/**
 * Simpan preset framing per layout ke localStorage
 * @param {'desktop'|'mobile'} layout
 * @param {string} presetName
 */
export function savePreset(layout, presetName) {
  const key = `${STORAGE_KEY_PREFIX}${layout}`;
  try {
    localStorage.setItem(key, presetName);
  } catch (_) {}
}
