// ---------------------------------------------------------------------------
// filterService.js (vision-monitor backend)
// Periodic LLM filter using DeepSeek V4 Flash (deepseek-v4-flash)
// Evaluates buffer of visual descriptions to pick notable moments or SKIP.
// ---------------------------------------------------------------------------
import { client } from './nineInferenceClient.js';

export const FILTER_MODEL = 'deepseek-v4-flash';

// Estimasi biaya DeepSeek V4 Flash ($0.0003 per 1K tokens)
const COST_PER_1K_TOKENS_USD = 0.0003;

const VALID_EMOTIONS = new Set([
  'terkejut', 'marah', 'bingung', 'jengkel', 'malu', 'kesal',
  'sedih', 'kagum', 'sayang', 'jahil', 'penasaran', 'netral',
]);

const SYSTEM_PROMPT = `
Kamu adalah sistem pemilih momen spontan untuk AI companion "Amika" (istri anime yang manis, perhatian, dan playful).
Kamu menerima runtutan deskripsi visual apa yang terlihat di layar / kamera user selama window waktu beberapa detik terakhir.

Tugas:
Analisis runtutan deskripsi visual tersebut untuk memutuskan apakah ada momen yang menarik, unik, lucu, mengejutkan, atau pencapaian penting yang pantas dikomentari oleh Amika secara spontan.

Aturan Output:
1. Jika tidak ada momen istimewa (hanya rutinitas biasa, layar statis, atau perubahan kecil yang membosankan) -> WAJIB SKIP.
   Kembalikan format JSON persis:
   {"action": "SKIP", "reason": "Alasan singkat mengapa di-skip"}

2. Jika ada momen menarik yang layak dikomentari -> Kembalikan format JSON:
   {
     "action": "COMMENT",
     "emotion": "<pilih salah satu: terkejut, marah, bingung, jengkel, malu, kesal, sedih, kagum, sayang, jahil, penasaran, netral>",
     "text": "<1-2 kalimat komentar spontan Amika yang natural, ceria/perhatian seolah baru saja melihat momen tersebut secara langsung>"
   }

Contoh gaya komentar Amika:
- "Wah, kamu berhasil lewatin level yang tadi ya? Keren banget!"
- "Ehh, kenapa layarnya tiba-tiba merah gitu? Kamu kalah ya? Hehe~"
- "Hmm, kamu lagi ngetik kode apa tuh? Serius banget kelihatannya."

Format output WAJIB tepat satu JSON valid tanpa blok markdown (\`\`\`json) atau teks pengantar/penutup.
`.trim();

/**
 * Filter an array of buffer descriptions using DeepSeek V4 Flash
 * @param {Array<{ timestamp: string, description: string }>} bufferEntries
 * @returns {Promise<{ action: 'COMMENT'|'SKIP', emotion?: string, text?: string, reason?: string, tokens: number, latencyMs: number, costUsd: number }>}
 */
export async function filterBuffer(bufferEntries) {
  if (!bufferEntries || bufferEntries.length === 0) {
    return {
      action: 'SKIP',
      reason: 'Buffer kosong',
      tokens: 0,
      latencyMs: 0,
      costUsd: 0,
    };
  }

  const startTime = performance.now();

  const formattedDescriptions = bufferEntries
    .map((item, idx) => `[${idx + 1}] (${item.timestamp}) ${item.description}`)
    .join('\n');

  const userPrompt = `
Berikut adalah ${bufferEntries.length} deskripsi visual dari pemantauan detik-demi-detik terakhir:
${formattedDescriptions}

Putuskan apakah Amika harus berkomentar secara spontan sekarang atau SKIP:
`.trim();

  try {
    const response = await client.chat.completions.create({
      model: FILTER_MODEL,
      temperature: 0.3,
      max_tokens: 150,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });

    const latencyMs = Math.round(performance.now() - startTime);
    const rawContent = response.choices?.[0]?.message?.content?.trim() || '';
    const totalTokens = response.usage?.total_tokens || 200;
    const costUsd = (totalTokens / 1000) * COST_PER_1K_TOKENS_USD;

    let parsed;
    try {
      const cleanJson = rawContent
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      parsed = JSON.parse(cleanJson);
    } catch {
      console.warn('[filterService] Gagal parse JSON dari DeepSeek V4 Flash, fallback to SKIP. Raw:', rawContent);
      return {
        action: 'SKIP',
        reason: 'Gagal parse respon JSON filter',
        raw: rawContent,
        tokens: totalTokens,
        latencyMs,
        costUsd,
      };
    }

    if (parsed.action === 'COMMENT' && parsed.text) {
      let emotion = (parsed.emotion || 'netral').toLowerCase();
      if (!VALID_EMOTIONS.has(emotion)) emotion = 'netral';

      return {
        action: 'COMMENT',
        emotion,
        text: parsed.text.trim(),
        tokens: totalTokens,
        latencyMs,
        costUsd,
      };
    }

    return {
      action: 'SKIP',
      reason: parsed.reason || 'Tidak ada momen penting',
      tokens: totalTokens,
      latencyMs,
      costUsd,
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime);
    console.error('[filterService] Error calling DeepSeek V4 Flash:', error.message);
    return {
      action: 'SKIP',
      reason: `Error: ${error.message}`,
      tokens: 0,
      latencyMs,
      costUsd: 0,
    };
  }
}
