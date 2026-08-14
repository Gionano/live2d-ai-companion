// ---------------------------------------------------------------------------
// nineInferenceClient.js (vision-monitor backend)
// OpenAI-compatible client for 9inference.cloud API
// ---------------------------------------------------------------------------
import 'dotenv/config';
import OpenAI from 'openai';

const apiKey = process.env.NINEINFERENCE_API_KEY;
if (!apiKey) {
  console.warn('[vision-monitor:9inference] NINEINFERENCE_API_KEY belum di-set di .env.');
}

export const client = new OpenAI({
  baseURL: 'https://9inference.cloud/v1',
  apiKey: apiKey || 'dummy-key',
  defaultHeaders: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
  },
});
