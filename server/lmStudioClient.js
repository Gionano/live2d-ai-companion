// ---------------------------------------------------------------------------
// lmStudioClient.js  (server-side)
// Client OpenAI-compatible untuk LM Studio lokal (LLM Chat utama).
// Env: LMSTUDIO_BASE_URL (default http://localhost:1234/v1),
//      LMSTUDIO_API_KEY  (token LM Studio, wajib jika auth aktif).
// ---------------------------------------------------------------------------
import 'dotenv/config';
import OpenAI from 'openai';

export const LMSTUDIO_BASE_URL =
  process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1';

const apiKey = process.env.LMSTUDIO_API_KEY;
if (!apiKey) {
  console.warn(
    '[lmstudio] LMSTUDIO_API_KEY belum di-set di .env — LM Studio meminta API token.',
  );
}

export const lmStudio = new OpenAI({
  baseURL: LMSTUDIO_BASE_URL,
  apiKey: apiKey || 'lm-studio',
  timeout: 120000,
});
