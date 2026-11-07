import { Live2DCompanion } from './live2dCompanion.js';

const canvas = document.getElementById('app');
const status = document.getElementById('status');
const companion = new Live2DCompanion(canvas, status);

// Speech cues are scheduled against the audio playback clock.
window.addEventListener('waifu-speech-cue', (event) => companion.queueSpeechCue(event.detail));
window.addEventListener('waifu-speech-cancel', (event) => companion.cancelSpeechCue(event.detail?.speechId));

// Early expression cues are only shown while no speech is queued.
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
