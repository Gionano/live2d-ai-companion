import { Live2DCompanion } from './live2dCompanion.js';
import {
  getActiveLayout,
  getSavedPreset,
  savePreset,
} from './framingConfig.js';

const canvas = document.getElementById('app');
const status = document.getElementById('status');
const companion = new Live2DCompanion(canvas, status);

// ---------------------------------------------------------------------------
// Camera Framing (Full Body / Half Body / Close-up)
// ---------------------------------------------------------------------------
const framingSelect = document.getElementById('framing-select');
let currentLayout = getActiveLayout();

function applyFraming(immediate = false) {
  const preset = getSavedPreset(currentLayout);
  if (framingSelect) {
    framingSelect.value = preset;
  }
  companion.setFramingPreset(preset, currentLayout, immediate);
}

if (framingSelect) {
  framingSelect.addEventListener('change', (e) => {
    const selected = e.target.value;
    savePreset(currentLayout, selected);
    companion.setFramingPreset(selected, currentLayout, false);
  });
}

// Layout change detection on window resize (desktop vs mobile PiP)
window.addEventListener('resize', () => {
  const newLayout = getActiveLayout();
  if (newLayout !== currentLayout) {
    currentLayout = newLayout;
    applyFraming(false);
  }
});

// Set initial framing
applyFraming(true);

// Emotion cue dari companion.js (via CustomEvent).
window.addEventListener('waifu-emotion-cue', (event) => {
  companion.setEmotionCue(event.detail?.emotion ?? 'netral', event.detail?.endAt ?? 0);
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------
companion.initialize().then(() => {
  applyFraming(true);
}).catch((error) => {
  console.error('[Live2D] Gagal load:', error);
  status.textContent = `Live2D gagal: ${error.message}`;
});
