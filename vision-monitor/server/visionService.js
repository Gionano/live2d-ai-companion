// ---------------------------------------------------------------------------
// visionService.js (vision-monitor backend)
// Sends image frame base64 to MiniMax M3 (minimax-m3) via 9inference
// ---------------------------------------------------------------------------
import { client } from './nineInferenceClient.js';

export const VISION_MODEL = 'minimax-m3';

// Estimasi biaya MiniMax M3 ($0.001 per 1K tokens / roughly ~$0.0005 per visual request)
const COST_PER_1K_TOKENS_USD = 0.001;

const DEFAULT_VISION_PROMPT =
  'Deskripsikan secara ringkas dan padat dalam 1 kalimat apa yang sedang terjadi di layar/kamera ini. Fokus pada aksi visual penting, interaksi antarmuka, gameplay, atau objek utama.';

/**
 * Describe a single frame using MiniMax M3
 * @param {string} imageDataUrl - "data:image/jpeg;base64,..."
 * @param {number} maxTokens - max output tokens (default 100)
 * @returns {Promise<{ description: string, tokens: number, latencyMs: number, costUsd: number }>}
 */
export async function describeFrame(imageDataUrl, maxTokens = 100) {
  const startTime = performance.now();

  try {
    const response = await client.chat.completions.create({
      model: VISION_MODEL,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: imageDataUrl,
              },
            },
            {
              type: 'text',
              text: DEFAULT_VISION_PROMPT,
            },
          ],
        },
      ],
    });

    const latencyMs = Math.round(performance.now() - startTime);
    const description = response.choices?.[0]?.message?.content?.trim() || '(Tidak ada deskripsi)';
    const totalTokens = response.usage?.total_tokens || 120;
    const costUsd = (totalTokens / 1000) * COST_PER_1K_TOKENS_USD;

    return {
      description,
      tokens: totalTokens,
      latencyMs,
      costUsd,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime);
    console.error('[visionService] Error calling MiniMax M3:', error.message);
    return {
      description: `[Error: ${error.message}]`,
      tokens: 0,
      latencyMs,
      costUsd: 0,
      error: error.message,
    };
  }
}
