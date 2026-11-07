// ---------------------------------------------------------------------------
// streamingVisionManager.js (Main Companion Server)
// Per-conversation visual perception, source-bound commentary, and monitor telemetry.
// ---------------------------------------------------------------------------
import { getProviderRegistry, UNAVAILABLE_MESSAGES } from './providers/registry.js';
import { logger as console, formatLogTime } from '../src/logging.js';
import { imagePartFromDataUrl, totalTokens as countTokens } from './providers/adapters/shared.js';
import { markConversationActivity } from './modelWarmup.js';
import { HISTORY_MESSAGE_LIMIT } from './llmChat.js';
import { getServerTuning } from './serverConfig.js';
import { normalizeSpeechEmotion, speechEmotionPrompt } from './speechEmotionPrompt.js';
import { resolveTtsParams, sanitizeSpeechText } from './ttsExpression.js';
import { ContinuousVisionSource } from './continuousVisionSource.js';

// Cost constants (Groq vision is free-tier / very cheap; 9inference for filter)
const VISION_COST_PER_1K_TOKENS = 0.0002; // Qwen 3.8 27B (Groq) — estimate
const FILTER_COST_PER_1K_TOKENS = 0.0003; // DeepSeek V4 Flash (9inference)

const VALID_EMOTIONS = new Set([
  'terkejut', 'marah', 'bingung', 'jengkel', 'malu', 'kesal',
  'sedih', 'kagum', 'sayang', 'jahil', 'penasaran', 'netral',
]);

const SYNC_TYPES = new Set([
  'screen_share_status', 'config_updated', 'stats_update',
  'filter_start', 'filter_result', 'vision_entry',
]);

const SCREEN_VISION_PROMPT =
  'Deskripsikan secara ringkas dan padat dalam 1 kalimat apa yang sedang terjadi atau terlihat di layar/game ini (fokus pada aksi penting, status UI, gameplay, atau objek utama).';
const WEBCAM_VISION_PROMPT =
  'Deskripsikan dalam 1-2 kalimat apa yang terlihat di kamera, terutama orang, benda, tindakan, dan lingkungan. Jangan menebak hal yang tidak terlihat.';

const FILTER_SYSTEM_PROMPT = `
Kamu adalah pemilih momen spontan untuk AI companion "Amika" (istri anime yang manis, ceria, perhatian, dan playful).
Kamu menerima runtutan deskripsi visual dari layar, game, atau kamera user selama beberapa detik terakhir.

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

export class StreamingVisionManager {
  constructor({ registry = getProviderRegistry(), startTimer = true, now = () => Date.now(), settings = {} } = {}) {
    this.registry = registry;
    this.now = now;
    this.disposed = false;
    this.assistantContext = '';
    this.promptVersion = 0;
    this.isScreenShareActive = false;
    this.isDescribingInProgress = false;
    this.isFilteringInProgress = false;
    this.lastFilterTimestamp = this.now();
    // Continuous perception runs only while a monitor dashboard is connected.
    this.monitorConnected = false;

    this.settings = {
      intervalSeconds: getServerTuning('vision', 'captureInterval', 1),
      bufferDurationSec: getServerTuning('vision', 'bufferDuration', 30),
      maxTokens: getServerTuning('vision', 'visionMaxTokens', 100),
      minInferenceIntervalMs: getServerTuning('vision', 'minInferenceIntervalMs', 2000),
      freshnessMs: getServerTuning('vision', 'freshnessMs', 5000),
      screenChangeThreshold: getServerTuning('vision', 'screenChangeThreshold', 3),
      webcamChangeThreshold: getServerTuning('vision', 'webcamChangeThreshold', 5),
      ...settings,
    };
    this.settings.minInferenceIntervalMs = Number.isFinite(this.settings.minInferenceIntervalMs)
      ? Math.max(2000, Math.min(30000, this.settings.minInferenceIntervalMs)) : 2000;
    this.settings.freshnessMs = Number.isFinite(this.settings.freshnessMs)
      ? Math.max(1000, Math.min(5000, this.settings.freshnessMs)) : 5000;
    this.sources = Object.fromEntries(['screen', 'webcam'].map(source => [source, new ContinuousVisionSource(source, this)]));

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
    this.speechHandler = null;

    if (startTimer) this.initPeriodicFilter();
  }

  setBroadcaster(fn) {
    this.broadcastFn = fn;
  }

  setHistoryRef(history) {
    this.historyRef = history;
  }

  setSpeechHandler(fn) {
    this.speechHandler = fn;
  }

  setMonitorConnected(connected) {
    const next = Boolean(connected);
    if (this.monitorConnected === next) return;
    this.monitorConnected = next;
    if (!next) {
      for (const source of Object.values(this.sources)) this.setSourceStatus(source.source, false);
    }
    console.log(`[StreamingVision] Monitor terhubung: ${this.monitorConnected}`);
  }

  // Ambil deskripsi terbaru dari buffer untuk dipakai sebagai konteks vision
  // on-demand (saat user bertanya "lihat layar" dan monitor sedang aktif).
  // Mengembalikan string gabungan atau null jika buffer kosong.
  getLatestDescriptions(count = 5) {
    const slice = this.buffer.filter(entry => this.sources[entry.source]?.active
      && this.now() - entry.capturedAt <= this.settings.freshnessMs).slice(-count);
    if (slice.length === 0) return null;
    return slice.map(e => `[${e.timestamp}] ${e.description}`).join('\n');
  }

  // Info sinkronisasi untuk Vision Monitor (nilai relatif, tahan clock skew).
  syncInfo() {
    return {
      bufferCount: this.buffer.length,
      filterElapsedSec: Math.round((this.now() - this.lastFilterTimestamp) / 1000),
    };
  }

  broadcast(obj) {
    if (!this.broadcastFn || this.disposed) return;
    if (SYNC_TYPES.has(obj.type)) obj = { ...obj, sync: this.syncInfo() };
    this.broadcastFn(obj);
  }

  resetStats() {
    this.stats = {
      sessionStartTime: Object.values(this.sources).some(source => source.active) ? this.now() : null,
      totalFramesCaptured: 0,
      totalVisionCalls: 0,
      totalFilterCalls: 0,
      totalVisionCostUsd: 0,
      totalFilterCostUsd: 0,
      totalCommentsSent: 0,
      totalSkips: 0,
    };
    this.buffer = [];
    for (const source of Object.values(this.sources)) {
      for (const name of Object.keys(source.stats)) source.stats[name] = 0;
      source.window = [];
      source.lastFilterAt = this.now();
    }
    this.lastFilterTimestamp = this.now();
    console.log('[StreamingVision] Stats di-reset dari Vision Monitor');
    this.broadcast({ type: 'stats_update', stats: this.stats, sources: this.getSourceSnapshot() });
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
    for (const [name, min, max] of [['minInferenceIntervalMs', 2000, 30000], ['freshnessMs', 1000, 5000],
      ['screenChangeThreshold', 0.1, 255], ['webcamChangeThreshold', 0.1, 255]]) {
      if (Number.isFinite(newSettings[name])) this.settings[name] = Math.max(min, Math.min(max, newSettings[name]));
    }

    console.log('[StreamingVision] Settings updated:', this.settings);
    this.broadcast({
      type: 'config_updated',
      settings: this.settings,
      sources: this.getSourceSnapshot(),
    });
  }

  setScreenShareStatus(active) {
    return this.setSourceStatus('screen', Boolean(active), 'legacy-screen');
  }

  setSourceStatus(source, active, sessionId) {
    if (active && !this.monitorConnected) return false;
    if (!Object.hasOwn(this.sources, source)) return false;
    const state = this.sources[source];
    if (!state || this.disposed || !state.setStatus(active, sessionId)) return false;
    this.isScreenShareActive = this.sources.screen.active;
    if (active && this.stats.sessionStartTime === null) this.stats.sessionStartTime = this.now();
    this.broadcast({ type: 'screen_share_status', source, active, sessionId: state.sessionId,
      settings: this.settings, stats: this.stats, sources: this.getSourceSnapshot() });
    return true;
  }

  setAssistantContext(text) {
    const next = typeof text === 'string' ? text.trim().slice(-1000) : '';
    if (next === this.assistantContext) return;
    this.assistantContext = next;
    this.promptVersion++;
  }

  getSourceSnapshot() {
    return Object.fromEntries(Object.entries(this.sources).map(([source, state]) => [source, state.snapshot()]));
  }

  getConversationContext() {
    if (this.disposed) return null;
    return Object.values(this.sources).map(source => source.context()).filter(Boolean).join('\n') || null;
  }

  refreshBuffer() {
    this.buffer = Object.values(this.sources).flatMap(source => source.window)
      .sort((left, right) => left.generatedAt - right.generatedAt);
  }

  updateBusy() {
    this.isDescribingInProgress = Object.values(this.sources).some(source => !!source.inflight);
    this.isFilteringInProgress = Object.values(this.sources).some(source => !!source.filterController);
  }

  publishStats() {
    this.broadcast({ type: 'stats_update', stats: this.stats, sources: this.getSourceSnapshot() });
  }

  async handleContinuousFrame(image, options = {}) {
    if (this.disposed || !image || !this.monitorConnected) return { accepted: false };
    const legacy = !Object.hasOwn(options, 'source');
    const source = legacy ? 'screen' : options.source;
    if (!Object.hasOwn(this.sources, source)) return { accepted: false };
    const state = this.sources[source];
    if (!state) return { accepted: false };
    if (legacy && !state.active) this.setScreenShareStatus(true);
    return state.handle(image, legacy ? { ...options, legacy: true,
      sessionId: state.sessionId, sequence: state.lastSequence + 1 } : options);
  }

  async describeContinuousFrame(frame, source, signal) {
    const startedAt = performance.now();
    let firstResponseMs = null;
    const prompt = source === 'webcam' ? WEBCAM_VISION_PROMPT : SCREEN_VISION_PROMPT;
    const context = this.assistantContext ? '\nKonteks percakapan, Amika baru saja berkata: '
      + JSON.stringify(this.assistantContext) + '. Tetap hanya jelaskan hal yang terlihat.' : '';
    const response = await this.registry.getLlm('vision').complete({
      signal, maxTokens: this.settings.maxTokens,
      onProgress: stage => {
        if (stage === 'first_byte' && firstResponseMs === null) firstResponseMs = Math.round(performance.now() - startedAt);
      },
      temperature: getServerTuning('vision', 'visionTemperature', 0.2),
      messages: [{ role: 'user', content: [imagePartFromDataUrl(frame.image), { type: 'text', text: prompt + context }] }],
    });
    const tokens = countTokens(response, 120);
    const costUsd = (tokens / 1000) * VISION_COST_PER_1K_TOKENS;
    this.stats.totalVisionCostUsd += costUsd;
    return { id: 'desc_' + this.now() + '_' + Math.random().toString(36).slice(2, 6),
      source, sessionId: frame.sessionId, sequence: frame.sequence,
      timestamp: formatLogTime(new Date(frame.capturedAt)), capturedAt: frame.capturedAt,
      generatedAt: this.now(), description: response.text.trim() || '(Tidak ada deskripsi)',
      tokens, latencyMs: Math.round(performance.now() - startedAt), firstResponseMs, costUsd };
  }

  initPeriodicFilter() {
    clearInterval(this.filterTimer);
    this.filterTimer = setInterval(() => {
      void this.runPeriodicFilter();
      this.publishStats();
    }, 500);
    this.filterTimer.unref?.();
  }

  async runPeriodicFilter() {
    if (this.disposed || !this.registry.getSlotStatus('visionFilter').available) return;
    await Promise.all(Object.values(this.sources).map(source => this.filterSource(source)));
  }

  async filterSource(state) {
    if (!state.active || state.filterController || !state.isFresh() || !state.window.length
      || this.now() - state.lastFilterAt < this.settings.bufferDurationSec * 1000) return;
    const entries = state.window.filter(entry => entry.sessionId === state.sessionId
      && this.now() - entry.capturedAt <= this.settings.bufferDurationSec * 1000);
    state.window = [];
    state.lastFilterAt = this.now();
    this.lastFilterTimestamp = this.now();
    this.refreshBuffer();
    if (!entries.length) return;
    const epoch = state.epoch;
    const controller = new AbortController();
    state.filterController = controller;
    this.updateBusy();
    this.broadcast({ type: 'filter_start', source: state.source, bufferSize: entries.length,
      timestamp: formatLogTime(new Date(this.now())) });
    this.stats.totalFilterCalls++;
    try {
      const result = await this.evaluateFilter(entries, { signal: controller.signal });
      if (this.disposed || !state.active || epoch !== state.epoch || controller.signal.aborted || !state.isFresh()) return;
      this.stats.totalFilterCostUsd += result.costUsd || 0;
      if (result.action === 'COMMENT' && result.text) {
        this.stats.totalCommentsSent++;
        await this.executeSpontaneousCommentary(result.speechText ?? result.text, result.emotion,
          { speechEmotion: result.speechEmotion, source: state.source, signal: controller.signal });
      } else {
        this.stats.totalSkips++;
      }
      if (controller.signal.aborted || epoch !== state.epoch || this.disposed) return;
      this.broadcast({ type: 'filter_result', source: state.source, ...result,
        sourceCount: entries.length, stats: this.stats, timestamp: formatLogTime(new Date(this.now())) });
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed && epoch === state.epoch) {
        this.broadcast({ type: 'vision_error', source: state.source,
          message: 'Komentar visual belum tersedia.' });
      }
    } finally {
      if (state.filterController === controller) state.filterController = null;
      this.updateBusy();
      this.publishStats();
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.filterTimer);
    this.filterTimer = null;
    for (const source of Object.values(this.sources)) source.dispose();
    this.buffer = [];
    this.isScreenShareActive = this.isDescribingInProgress = this.isFilteringInProgress = false;
    this.broadcastFn = this.historyRef = this.speechHandler = null;
  }

  async evaluateFilter(bufferEntries, { signal } = {}) {
    if (!this.registry.getSlotStatus('visionFilter').available) {
      return { action: 'SKIP', reason: UNAVAILABLE_MESSAGES.vision, tokens: 0, latencyMs: 0, costUsd: 0 };
    }
    const startTime = performance.now();
    const formatted = bufferEntries
      .map((item, idx) => `[${idx + 1}] (${item.source === 'webcam' ? 'Kamera' : 'Layar'} ${item.timestamp}) ${item.description}`)
      .join('\n');

    const userPrompt = `
Berikut adalah ${bufferEntries.length} deskripsi visual dari sumber yang sama selama jendela pemantauan terakhir:
${formatted}

Putuskan apakah Amika harus berkomentar secara spontan sekarang atau SKIP:
`.trim();

    try {
      const filterTemp = getServerTuning('vision', 'filterTemperature', 0.3);
      const filterMaxTok = getServerTuning('vision', 'filterMaxTokens', 150);
      const ttsParams = resolveTtsParams(this.registry.getTts?.()?.params);
      const nativePrompt = this.registry.getSlotStatus('tts').available
        ? speechEmotionPrompt(ttsParams, 'vision') : '';

      const response = await this.registry.getLlm('visionFilter').complete({
        signal,
        temperature: filterTemp,
        maxTokens: filterMaxTok,
        messages: [
          { role: 'system', content: [FILTER_SYSTEM_PROMPT, nativePrompt].filter(Boolean).join('\n\n') },
          { role: 'user', content: userPrompt },
        ],
      });

      const latencyMs = Math.round(performance.now() - startTime);
      const rawContent = response.text.trim() || '';
      const totalTokens = countTokens(response, 200);
      const costUsd = (totalTokens / 1000) * FILTER_COST_PER_1K_TOKENS;

      const cleanJson = rawContent
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const parsed = JSON.parse(cleanJson);

      if (parsed.action === 'COMMENT' && typeof parsed.text === 'string' && parsed.text.trim()) {
        let emotion = typeof parsed.emotion === 'string' ? parsed.emotion.toLowerCase() : 'netral';
        if (!VALID_EMOTIONS.has(emotion)) emotion = 'netral';
        const speechEmotion = nativePrompt ? normalizeSpeechEmotion(parsed.speechEmotion) : undefined;
        const text = sanitizeSpeechText(parsed.text.trim(), ttsParams);
        return {
          action: 'COMMENT',
          emotion,
          text: text.displayText,
          ...(speechEmotion && { speechEmotion }),
          ...(text.ttsText !== text.displayText && { speechText: text.ttsText }),
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

  async executeSpontaneousCommentary(text, emotion, { speechEmotion, source, signal } = {}) {
    if (this.disposed || signal?.aborted) return;
    markConversationActivity();
    const sanitized = sanitizeSpeechText(text, this.registry.getTts?.()?.params);
    const nativeEmotion = normalizeSpeechEmotion(speechEmotion);

    if (this.historyRef && Array.isArray(this.historyRef)) {
      this.historyRef.push({ role: 'assistant', content: sanitized.displayText });
      if (this.historyRef.length > HISTORY_MESSAGE_LIMIT) {
        this.historyRef.splice(0, this.historyRef.length - HISTORY_MESSAGE_LIMIT);
      }
    }

    this.broadcast({ type: 'vision', text: `[Spontan] ${sanitized.displayText}` });
    await this.speechHandler?.(sanitized.ttsText, emotion, { ...(nativeEmotion && { speechEmotion: nativeEmotion }),
      ...(source && { source, origin: 'vision', signal }) });
  }
}

export const streamingVisionManager = new StreamingVisionManager();
