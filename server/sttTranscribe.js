// ---------------------------------------------------------------------------
// sttTranscribe.js  (server-side)
// Speech-to-Text via Groq Whisper. transcribeAudio() menerima Buffer rekaman
// (webm/wav/m4a dari MediaRecorder browser) dan mengembalikan teks transkripsi.
// Model whisper-large-v3-turbo dipilih untuk kecepatan (percakapan real-time).
// ---------------------------------------------------------------------------
import { toFile } from 'groq-sdk';
import { groq } from './groqClient.js';

const STT_MODEL = 'whisper-large-v3';

// Prompt awal memberikan konteks ejaan, tanda baca, dan gaya bahasa santai 
// yang secara drastis menaikkan akurasi Whisper untuk bahasa Indonesia.
const STT_PROMPT = 'Umm, halo sayang? Ini adalah percakapan santai. Kamu lagi ngapain?';

// audioBuffer: Buffer audio mentah. `filename` dipakai Groq untuk menebak
// container — samakan ekstensinya dengan mime rekaman (default webm).
export async function transcribeAudio(audioBuffer, filename = 'audio.webm') {
  const file = await toFile(audioBuffer, filename);
  const res = await groq.audio.transcriptions.create({
    file,
    model: STT_MODEL,
    language: 'id', // Bahasa Indonesia — akurasi lebih baik
    response_format: 'verbose_json',
    prompt: STT_PROMPT,
  });

  // Filter halusinasi berdasarkan no_speech_prob (khas Whisper saat mendengar ketukan/noise)
  if (res.segments && res.segments.length > 0) {
    // Ambil rata-rata no_speech_prob dari semua segmen
    const noSpeechProb = res.segments.reduce((acc, seg) => acc + seg.no_speech_prob, 0) / res.segments.length;
    // Jika kemungkinan besar bukan suara (> 0.5), anggap sebagai noise dan buang
    if (noSpeechProb > 0.5) {
      console.log(`[STT] Filtered non-speech audio (ketukan/noise). no_speech_prob: ${noSpeechProb.toFixed(2)}`);
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
