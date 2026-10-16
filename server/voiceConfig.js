// ---------------------------------------------------------------------------
// voiceConfig.js
// Konfigurasi suara waifu untuk Fish Audio TTS.
// ---------------------------------------------------------------------------
import { getServerTuning } from './serverConfig.js';

export const DEFAULT_VOICE_ID = 'be67ba79424149ec8a4564cebd3e7938';

export function getVoiceId() {
  return getServerTuning('models', 'voiceId', DEFAULT_VOICE_ID);
}

// Backward compatible export (reads dynamically)
export const WAIFU_VOICE_REFERENCE_ID = DEFAULT_VOICE_ID;

// TTS baru aktif kalau reference id sudah diisi (bukan placeholder).
export function isVoiceConfigured() {
  const id = getVoiceId();
  return Boolean(id) && !id.includes('<') && !id.includes('ISI_DENGAN');
}
