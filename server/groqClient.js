// ---------------------------------------------------------------------------
// groqClient.js  (server-side)
// Satu instance Groq client (dari groq-sdk) untuk STT. API key dari env
// (GROQ_API_KEY) — server-side only, tidak pernah ke browser.
// ---------------------------------------------------------------------------
import 'dotenv/config';
import Groq from 'groq-sdk';

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.warn('[groq] GROQ_API_KEY belum di-set. Isi file .env dulu.');
}

export const groq = new Groq({ 
  apiKey,
  defaultHeaders: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
  },
});
