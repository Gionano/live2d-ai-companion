// ---------------------------------------------------------------------------
// sttTranscribe.js  (server-side)
// Speech-to-Text via Groq Whisper. transcribeAudio() menerima Buffer rekaman
// (webm/wav/m4a dari MediaRecorder browser) dan mengembalikan teks transkripsi.
// Model whisper-large-v3-turbo dipilih untuk kecepatan (percakapan real-time).
// ---------------------------------------------------------------------------
import { getProviderRegistry } from './providers/registry.js';
import { getServerTuning } from './serverConfig.js';

// audioBuffer: Buffer audio mentah. `filename` dipakai Groq untuk menebak
// container — samakan ekstensinya dengan mime rekaman (default webm).
export async function transcribeAudio(audioBuffer, filename = 'audio.webm', { signal, mime,
  registry = getProviderRegistry() } = {}) {
  signal?.throwIfAborted();
  if (!registry.getSlotStatus('stt').available) return '';
  const extension = filename.split('.').pop().toLowerCase();
  const type = mime ?? ({ wav: 'audio/wav', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4' }[extension] || 'audio/webm');
  const res = await registry.getStt().transcribe({ audio: audioBuffer, mime: type, filename, signal });
  signal?.throwIfAborted();

  // Filter halusinasi berdasarkan no_speech_prob (khas Whisper saat mendengar ketukan/noise)
  if (res.segments?.length && res.segments.every(segment => Number.isFinite(segment.noSpeechProb))) {
    // Ambil rata-rata no_speech_prob dari semua segmen
    const noSpeechProb = res.segments.reduce((acc, seg) => acc + seg.noSpeechProb, 0) / res.segments.length;
    const threshold = getServerTuning('vad', 'noSpeechThreshold', 0.5);
    // Jika kemungkinan besar bukan suara, anggap sebagai noise dan buang
    if (noSpeechProb > threshold) {
      console.log(`[STT] Filtered non-speech audio (ketukan/noise). no_speech_prob: ${noSpeechProb.toFixed(2)} (threshold: ${threshold})`);
      return '';
    }
  }

  let text = (res.text ?? '').trim();

  // Fallback: saringan manual untuk halusinasi klasik Whisper yang lolos
  const lower = text.toLowerCase();
  const hallucinations = [
    'terima kasih.', 'terima kasih', 'terima kasih banyak.', 
    'thank you.', 'thank you', 'subscribe.', 'subscribe ya.',
    'halo.', 'halo', 'sampai jumpa.'
  ];
  if (hallucinations.includes(lower)) {
    console.log(`[STT] Filtered Whisper hallucination: "${text}"`);
    return '';
  }

  return text;
}
