// ---------------------------------------------------------------------------
// voiceConfig.js
// Konfigurasi suara waifu untuk Fish Audio TTS.
// ---------------------------------------------------------------------------
import { getServerTuning } from './serverConfig.js';

export const DEFAULT_VOICE_ID = '3095f8e1d1fa4b82acaa8aca720a7f83';

export function getVoiceId() {
  return getServerTuning('models', 'voiceId', DEFAULT_VOICE_ID);
}

// A blank Settings field selects the existing Fish voice, just like an omitted ID.
export function resolveFishVoiceId(voice) {
  const value = typeof voice === 'string' ? voice.trim() : voice;
  return value === undefined || value === null || value === '' ? getVoiceId() : value;
}

// Backward compatible export (reads dynamically)
export const WAIFU_VOICE_REFERENCE_ID = DEFAULT_VOICE_ID;

// TTS baru aktif kalau reference id sudah diisi (bukan placeholder).
export function isVoiceConfigured() {
  const id = getVoiceId();
  return Boolean(id) && !id.includes('<') && !id.includes('ISI_DENGAN');
}
