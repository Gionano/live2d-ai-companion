import { Live2DCompanion } from './live2dCompanion.js';

const canvas = document.getElementById('app');
const status = document.getElementById('status');
const companion = new Live2DCompanion(canvas, status);

// Emotion cue dari companion.js (via CustomEvent).
window.addEventListener('waifu-emotion-cue', (event) => {
  companion.setEmotionCue(event.detail?.emotion ?? 'netral', event.detail?.endAt ?? 0);
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------
companion.initialize().catch((error) => {
  console.error('[Live2D] Gagal load:', error);
  status.textContent = `Live2D gagal: ${error.message}`;
});
