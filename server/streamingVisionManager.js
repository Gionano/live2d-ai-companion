// ---------------------------------------------------------------------------
// streamingVisionManager.js (Main Companion Server)
// Handles real-time continuous frame description via Qwen 3.8 27B (Groq),
// buffer accumulation, periodic filtering via DeepSeek V4 Flash (9inference),
// spontaneous voice commentary execution, and telemetry broadcast to Vision Monitor.
// ---------------------------------------------------------------------------
import { groq } from './groqClient.js';
import { client } from './nineInferenceClient.js';
import { CHAT_MODEL } from './modelConfig.js';
import { generateSpeech } from './ttsGenerate.js';
import { isVoiceConfigured } from './voiceConfig.js';
import { markConversationActivity } from './modelWarmup.js';
import { HISTORY_MESSAGE_LIMIT } from './llmChat.js';

const VISION_MODEL = 'qwen/qwen3.8-27b';

// Cost constants (Groq vision is free-tier / very cheap; 9inference for filter)
const VISION_COST_PER_1K_TOKENS = 0.0002; // Qwen 3.8 27B (Groq) — estimate
const FILTER_COST_PER_1K_TOKENS = 0.0003; // DeepSeek V4 Flash (9inference)

const VALID_EMOTIONS = new Set([
  'terkejut', 'marah', 'bingung', 'jengkel', 'malu', 'kesal',
  'sedih', 'kagum', 'sayang', 'jahil', 'penasaran', 'netral',
]);

const SCREEN_VISION_PROMPT =
  'Deskripsikan secara ringkas dan padat dalam 1 kalimat apa yang sedang terjadi atau terlihat di layar/game ini (fokus pada aksi penting, status UI, gameplay, atau objek utama).';

const FILTER_SYSTEM_PROMPT = `
Kamu adalah pemilih momen spontan untuk AI companion "Amika" (istri anime yang manis, ceria, perhatian, dan playful).
Kamu menerima runtutan deskripsi visual apa yang terlihat di layar / game user selama beberapa detik terakhir.

Tugas:
Analisis runtutan deskripsi visual tersebut untuk memutuskan apakah ada momen yang menarik, unik, lucu, mengejutkan, atau pencapaian penting yang pantas dikomentari oleh Amika secara spontan.

Aturan Output:
1. Jika tidak ada momen istimewa (hanya rutinitas biasa, layar statis, atau perubahan kecil yang membosankan) -> WAJIB SKIP.
   Kembalikan format JSON:
   {"action": "SKIP", "reason": "Alasan singkat mengapa di-skip"}

2. Jika ada momen menarik yang layak dikomentari -> Kembalikan format JSON:
   {
     "action": "COMMENT",
     "emotion": "<pilih salah satu: terkejut, marah, bingung, jengkel, malu, kesal, sedih, kagum, sayang, jahil, penasaran, netral>",
     "text": "<1-2 kalimat komentar spontan Amika yang natural, ceria/perhatian seolah baru saja melihat momen tersebut secara langsung>"
   }

Format output WAJIB tepat satu JSON valid tanpa blok markdown (\`\`\`json) atau teks lain.
`.trim();

class StreamingVisionManager {
  constructor() {
    this.isScreenShareActive = false;
    this.isDescribingInProgress = false;
    this.isFilteringInProgress = false;
    this.lastFilterTimestamp = Date.now();

    this.settings = {
      intervalSeconds: 1,      // capture interval in seconds
      bufferDurationSec: 30,  // filter evaluation window
      maxTokens: 100,         // max tokens for vision description
    };

    this.buffer = [];

    this.stats = {
      sessionStartTime: null,
      totalFramesCaptured: 0,
      totalVisionCalls: 0,
      totalFilterCalls: 0,
      totalVisionCostUsd: 0,
      totalFilterCostUsd: 0,
      totalCommentsSent: 0,
      totalSkips: 0,
    };

    this.broadcastFn = null;
    this.historyRef = null;

    this.initPeriodicFilter();
  }

  setBroadcaster(fn) {
    this.broadcastFn = fn;
  }

  setHistoryRef(history) {
    this.historyRef = history;
  }

  broadcast(obj) {
    if (this.broadcastFn) {
      this.broadcastFn(obj);
    }
  }

  updateSettings(newSettings) {
    if (!newSettings) return;
    if (typeof newSettings.intervalSeconds === 'number') {
      this.settings.intervalSeconds = Math.max(1, Math.min(30, Math.round(newSettings.intervalSeconds)));
    }
    if (typeof newSettings.bufferDurationSec === 'number') {
      this.settings.bufferDurationSec = Math.max(5, Math.min(300, Math.round(newSettings.bufferDurationSec)));
    }
    if (typeof newSettings.maxTokens === 'number') {
      this.settings.maxTokens = Math.max(20, Math.min(500, Math.round(newSettings.maxTokens)));
    }

    console.log('[StreamingVision] Settings updated:', this.settings);
    this.broadcast({
      type: 'config_updated',
      settings: this.settings,
    });
  }

  setScreenShareStatus(active) {
    this.isScreenShareActive = Boolean(active);
    if (this.isScreenShareActive && !this.stats.sessionStartTime) {
      this.stats.sessionStartTime = Date.now();
    }
    console.log(`[StreamingVision] Screen share status: ${this.isScreenShareActive ? 'ACTIVE' : 'INACTIVE'}`);
    this.broadcast({
      type: 'screen_share_status',
      active: this.isScreenShareActive,
      settings: this.settings,
      stats: this.stats,
    });
  }

  async handleContinuousFrame(imageDataUrl) {
    if (!imageDataUrl) return;
    this.stats.totalFramesCaptured++;

    // Push frame preview to vision-monitor immediately
    this.broadcast({
      type: 'monitor_frame',
      image: imageDataUrl,
      timestamp: Date.now(),
    });

    // Avoid stacking Qwen 3.8 27B (Groq) calls if previous call is still processing
    if (this.isDescribingInProgress) {
      return;
    }

    this.isDescribingInProgress = true;
    const timeStr = new Date().toLocaleTimeString();
    const startTime = performance.now();

    try {
      this.stats.totalVisionCalls++;

      const response = await groq.chat.completions.create({
        model: VISION_MODEL,
        reasoning_effort: 'none',   // Non-thinking / instruct mode for speed
        max_tokens: this.settings.maxTokens,
        temperature: 0.2,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageDataUrl } },
              { type: 'text', text: SCREEN_VISION_PROMPT },
            ],
          },
        ],
      });

      const latencyMs = Math.round(performance.now() - startTime);
      const description = response.choices?.[0]?.message?.content?.trim() || '(Tidak ada deskripsi)';
      const totalTokens = response.usage?.total_tokens || 120;
      const costUsd = (totalTokens / 1000) * VISION_COST_PER_1K_TOKENS;
      this.stats.totalVisionCostUsd += costUsd;

      console.log(`[StreamingVision] Qwen 3.8 27B (Groq) — ${latencyMs}ms | "${description.slice(0, 60)}..."`);

      const entry = {
        id: 'desc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        timestamp: timeStr,
        description,
        tokens: totalTokens,
        latencyMs,
        costUsd,
      };

      this.buffer.push(entry);

      // Broadcast entry to vision-monitor
      this.broadcast({
        type: 'vision_entry',
        entry,
        bufferCount: this.buffer.length,
        stats: this.stats,
      });
    } catch (err) {
      console.error('[StreamingVision] Gagal mendeskripsikan frame (Qwen 3.8 27B Groq):', err.message);
    } finally {
      this.isDescribingInProgress = false;
    }
  }

  initPeriodicFilter() {
    setInterval(async () => {
      if (!this.isScreenShareActive) return;
      if (this.isFilteringInProgress) return;

      const now = Date.now();
      const elapsedSec = (now - this.lastFilterTimestamp) / 1000;

      if (elapsedSec >= this.settings.bufferDurationSec && this.buffer.length > 0) {
        this.isFilteringInProgress = true;
        this.lastFilterTimestamp = now;

        const currentBuffer = [...this.buffer];
        this.buffer = []; // clear buffer for the next window

        this.broadcast({
          type: 'filter_start',
          bufferSize: currentBuffer.length,
          timestamp: new Date().toLocaleTimeString(),
        });

        try {
          this.stats.totalFilterCalls++;
          const result = await this.evaluateFilter(currentBuffer);
          this.stats.totalFilterCostUsd += result.costUsd || 0;

          if (result.action === 'COMMENT' && result.text) {
            this.stats.totalCommentsSent++;
            console.log(`[StreamingVision] Momen terpilih! Amika berkomentar: "${result.text}" (${result.emotion})`);

            // 1. Eksekusi langsung ke Companion Utama (TTS & Avatar Speech)
            await this.executeSpontaneousCommentary(result.text, result.emotion);

            // 2. Broadcast hasil filter ke Vision Monitor
            this.broadcast({
              type: 'filter_result',
              action: 'COMMENT',
              text: result.text,
              emotion: result.emotion,
              tokens: result.tokens,
              latencyMs: result.latencyMs,
              costUsd: result.costUsd,
              sourceCount: currentBuffer.length,
              stats: this.stats,
              timestamp: new Date().toLocaleTimeString(),
            });
          } else {
            this.stats.totalSkips++;
            this.broadcast({
              type: 'filter_result',
              action: 'SKIP',
              reason: result.reason || 'Tidak ada momen yang cukup menarik',
              tokens: result.tokens,
              latencyMs: result.latencyMs,
              costUsd: result.costUsd,
              sourceCount: currentBuffer.length,
              stats: this.stats,
              timestamp: new Date().toLocaleTimeString(),
            });
          }
        } catch (err) {
          console.error('[StreamingVision] Error saat filter DeepSeek V4 Flash:', err.message);
        } finally {
          this.isFilteringInProgress = false;
          this.broadcast({ type: 'stats_update', stats: this.stats });
        }
      }
    }, 500);
  }

  async evaluateFilter(bufferEntries) {
    const startTime = performance.now();
    const formatted = bufferEntries
      .map((item, idx) => `[${idx + 1}] (${item.timestamp}) ${item.description}`)
      .join('\n');

    const userPrompt = `
Berikut adalah ${bufferEntries.length} deskripsi visual pemantauan layar terakhir:
${formatted}

Putuskan apakah Amika harus berkomentar secara spontan sekarang atau SKIP:
`.trim();

    try {
      const response = await client.chat.completions.create({
        model: CHAT_MODEL,
        temperature: 0.3,
        max_tokens: 150,
        messages: [
          { role: 'system', content: FILTER_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      });

      const latencyMs = Math.round(performance.now() - startTime);
      const rawContent = response.choices?.[0]?.message?.content?.trim() || '';
      const totalTokens = response.usage?.total_tokens || 200;
      const costUsd = (totalTokens / 1000) * FILTER_COST_PER_1K_TOKENS;

      const cleanJson = rawContent
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const parsed = JSON.parse(cleanJson);

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
        reason: parsed.reason || 'Dilewati',
        tokens: totalTokens,
        latencyMs,
        costUsd,
      };
    } catch (err) {
      console.warn('[StreamingVision] Gagal parse filter result, fallback to SKIP:', err.message);
      return {
        action: 'SKIP',
        reason: err.message,
        tokens: 0,
        latencyMs: Math.round(performance.now() - startTime),
        costUsd: 0,
      };
    }
  }

  async executeSpontaneousCommentary(text, emotion) {
    markConversationActivity();

    if (this.historyRef && Array.isArray(this.historyRef)) {
      this.historyRef.push({ role: 'assistant', content: text });
      if (this.historyRef.length > HISTORY_MESSAGE_LIMIT) {
        this.historyRef.splice(0, this.historyRef.length - HISTORY_MESSAGE_LIMIT);
      }
    }

    this.broadcast({ type: 'vision', text: `[Spontan] ${text}` });
    this.broadcast({ type: 'emotion', emotion });

    if (isVoiceConfigured()) {
      try {
        for await (const chunk of generateSpeech(text, emotion)) {
          this.broadcast({
            type: 'audio_output',
            data: chunk.toString('base64'),
            format: 'mp3',
          });
        }
        this.broadcast({ type: 'audio_end' });
      } catch (err) {
        console.error('[StreamingVision:tts] Gagal generate TTS:', err.message);
      }
    }

    this.broadcast({ type: 'amika_replied', text, emotion });
  }
}

export const streamingVisionManager = new StreamingVisionManager();
