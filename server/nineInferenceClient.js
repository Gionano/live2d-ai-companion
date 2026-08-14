// ---------------------------------------------------------------------------
// nineInferenceClient.js  (server-side)
// Satu instance OpenAI client yang dipakai BARENG oleh modul vision & LLM.
// Jangan bikin dua client terpisah — cukup import { client } dari sini.
//
// Provider: 9inference.cloud (OpenAI-compatible). API key dibaca dari env
// (NINEINFERENCE_API_KEY) dan HANYA hidup di sisi server — tidak pernah
// ikut ter-bundle ke browser.
// ---------------------------------------------------------------------------
import 'dotenv/config';
import OpenAI from 'openai';

const apiKey = process.env.NINEINFERENCE_API_KEY;
if (!apiKey) {
  console.warn(
    '[9inference] NINEINFERENCE_API_KEY belum di-set. Isi file .env dulu.',
  );
}

export const client = new OpenAI({
  baseURL: 'https://9inference.cloud/v1',
  apiKey,
  defaultHeaders: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
  },
});
