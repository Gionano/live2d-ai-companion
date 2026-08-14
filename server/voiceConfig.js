// ---------------------------------------------------------------------------
// voiceConfig.js
// Konfigurasi suara waifu untuk Fish Audio TTS.
//
// WAIFU_VOICE_REFERENCE_ID: id voice dari Fish Audio voice library.
// Ganti placeholder di bawah dengan id asli (mis. voice "Klee") — ambil dari
// halaman voice di https://fish.audio (bagian "Reference ID").
// ---------------------------------------------------------------------------
export const WAIFU_VOICE_REFERENCE_ID = '3095f8e1d1fa4b82acaa8aca720a7f83';

// TTS baru aktif kalau reference id sudah diisi (bukan placeholder).
export function isVoiceConfigured() {
  const id = WAIFU_VOICE_REFERENCE_ID;
  return Boolean(id) && !id.includes('<') && !id.includes('ISI_DENGAN');
}
