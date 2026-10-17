// ---------------------------------------------------------------------------
// experientialClient.js  (server-side)
// Client OpenAI-compatible untuk Experiential Labs (https://api.experientiallabs.ai/v1)
// Dipakai untuk LLM Chat utama (qwen3.8-flash-next-uncensored).
// ---------------------------------------------------------------------------
import 'dotenv/config';
import OpenAI from 'openai';

export const EXPLABS_BASE_URL =
  process.env.EXPLABS_BASE_URL || 'https://api.experientiallabs.ai/v1';

const apiKey = process.env.EXPLABS_API_KEY;
if (!apiKey) {
  console.warn(
    '[explabs] EXPLABS_API_KEY belum di-set di .env — isi API key Experiential Labs dulu.',
  );
}

export const explabs = new OpenAI({
  baseURL: EXPLABS_BASE_URL,
  apiKey: apiKey || '',
  timeout: 120000,
});
