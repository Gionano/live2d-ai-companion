// ---------------------------------------------------------------------------
// index.js  (server entry)
// Node/Express proxy kecil yang memegang API key 9inference di sisi server.
// Browser TIDAK pernah memegang key — ia memanggil /api/* yang di-proxy Vite
// (lihat vite.config.js) ke server ini.
//
//   POST /api/vision  { image }                          -> { description }
//   POST /api/chat    { history, message, visionDescription } -> SSE token stream
// ---------------------------------------------------------------------------
import http from 'http';
import { logger as console } from '../src/logging.js';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { describeFrame } from './visionCapture.js';
import { ConversationVisionRouter } from './visionRouting.js';
import { inspectVision } from './explicitVision.js';
import { StreamingVisionManager, streamingVisionManager } from './streamingVisionManager.js';
import { ProactiveConversation, proactiveSpeechInstruction } from './proactiveConversation.js';
import { VisionMonitorPresence } from './visionMonitorPresence.js';
import { getServerTuning } from './serverConfig.js';
import {
  generateReply,
  HISTORY_MESSAGE_LIMIT,
  trimConversationHistory,
} from './llmChat.js';
import { playConversationReply } from './conversationSpeech.js';
import { migrateConversationDefaults } from '../src/conversationDefaults.js';
import { transcribeAudio } from './sttTranscribe.js';
import { generateSpeech, isSpeechConfigured as isVoiceConfigured } from './ttsGenerate.js';
import { getProviderRegistry, getSlotStatus, UNAVAILABLE_MESSAGES } from './providers/registry.js';
import { getSettingsService } from './settings/service.js';
import { installSettingsRoutes } from './settings/routes.js';
import { ImageSettingsService } from './settings/imageSettingsService.js';
import { SpeechController } from './speechController.js';
import {
  companionSessionClosed,
  companionSessionOpened,
  markConversationActivity,
  warmUpModels,
} from './modelWarmup.js';
import multer from 'multer';
import {
  scanAvailableModels,
  getActiveModelPath,
  setActiveModelPath,
  extractZipModel,
} from './modelManager.js';
import { memoryManager } from './memoryManager.js';
import { SpeechMemoryRecorder } from './speechMemory.js';
import { MemoryEmbeddingRuntime } from './memoryEmbeddingRuntime.js';
import { detectSelfieIntent } from './selfie/intent.js';
import { planSelfie } from './selfie/planner.js';
import { jobManager } from './selfie/jobManager.js';
import { installSelfieLifecycle, prepareSelfieJob } from './selfie/backendLifecycle.js';
import { installSelfieFeatureControl, disabledSelfieResult } from './selfie/featureControl.js';
import { installSelfieImagePolicy, installSelfieImageRoutes } from './selfie/imageRoutes.js';
import { watchSelfieConfig } from './selfie/config.js';

const app = express();
const providerSettings = getSettingsService();
const imageSettings = new ImageSettingsService({ service: providerSettings, manager: jobManager });
const memoryEmbeddingRuntime = new MemoryEmbeddingRuntime({ registry: getProviderRegistry(),
  getConfig: () => providerSettings.effective().settings.memory });
memoryManager.configure({ getWriter: () => getProviderRegistry().getLlm('memoryWriter'),
  getEmbedding: () => getProviderRegistry().getEmbedding() });
const speechMemoryRecorder = new SpeechMemoryRecorder({ manager: memoryManager,
  onError: code => console.warn('[memory] Storage operation failed:', code) });
installSettingsRoutes(app, { service: providerSettings, registry: getProviderRegistry(),
  imageStatus: () => jobManager.getProviderStatus(), imageService: imageSettings,
  memoryService: { manager: memoryManager, runtime: memoryEmbeddingRuntime } });
installSelfieImagePolicy(app, jobManager);
// Frame base64 bisa lumayan besar — naikkan limit body JSON.
app.use(express.json({ limit: '12mb' }));

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __serverFilename = fileURLToPath(import.meta.url);
const __serverDir = path.dirname(__serverFilename);
const CONFIG_FILE_PATH = path.resolve(__serverDir, '../config/animationConfig.json');

app.get('/api/config', async (req, res) => {
  try {
    const raw = await fs.promises.readFile(CONFIG_FILE_PATH, 'utf-8');
    res.json(migrateConversationDefaults(JSON.parse(raw)));
  } catch (err) {
    console.error('[config] Failed to read config:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config', async (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') {
      return res.status(400).json({ error: 'Config object required' });
    }

    let current = {};
    try {
      current = migrateConversationDefaults(JSON.parse(await fs.promises.readFile(CONFIG_FILE_PATH, 'utf-8')));
    } catch (_) {}

    // Merge values while keeping schema metadata (min, max, step, desc, default)
    for (const [group, entries] of Object.entries(newConfig)) {
      if (!current[group]) current[group] = {};
      for (const [key, val] of Object.entries(entries)) {
        if (current[group][key]) {
          current[group][key].value = typeof val === 'object' && val !== null && 'value' in val ? val.value : val;
        } else if (typeof val === 'object' && val !== null) {
          current[group][key] = val;
        }
      }
    }

    await fs.promises.writeFile(CONFIG_FILE_PATH, JSON.stringify(current, null, 2), 'utf-8');
    console.log('[config] animationConfig.json updated successfully on disk.');
    res.json({ success: true, config: current });
  } catch (err) {
    console.error('[config] Failed to write config:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB limit
});

// --- Model Switcher APIs ---
app.get('/api/models', (req, res) => {
  try {
    const data = scanAvailableModels();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/models/active', (req, res) => {
  try {
    const activeModelPath = getActiveModelPath();
    res.json({ activeModelPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/models/active', (req, res) => {
  try {
    const { modelPath } = req.body ?? {};
    if (!modelPath) {
      return res.status(400).json({ error: 'Field "modelPath" wajib diisi.' });
    }
    const success = setActiveModelPath(modelPath);
    res.json({ success, activeModelPath: modelPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/models/upload', upload.single('modelFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'File upload tidak ditemukan.' });
    }
    const originalName = req.file.originalname || 'model.zip';
    if (!originalName.toLowerCase().endsWith('.zip')) {
      return res.status(400).json({ error: 'Format file harus berupa arsip .zip Live2D.' });
    }
    const result = await extractZipModel(req.file.buffer, originalName);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    console.error('[upload] error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/vision', async (req, res) => {
  try {
    const { image } = req.body ?? {};
    if (!image) {
      return res.status(400).json({ error: 'Field "image" (data URL) wajib.' });
    }
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const description = await describeFrame(image, 'webcam', { signal: controller.signal });
    res.json({ description });
  } catch (err) {
    console.error('[vision] error:', err);
    res.status(500).json({ error: err.message ?? 'Vision gagal.' });
  }
});

app.post('/api/chat', async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  // Server-Sent Events: satu event per potongan token.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const { history, message, visionDescription } = req.body ?? {};
    if (!message) {
      res.write(
        `data: ${JSON.stringify({ error: 'Field "message" wajib.' })}\n\n`,
      );
      return res.end();
    }
    markConversationActivity();
    for await (const event of generateReply(history, message, visionDescription, { signal: controller.signal })) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('[chat] error:', err);
    res.write(`data: ${JSON.stringify({ error: err.message ?? 'Chat gagal.' })}\n\n`);
    res.end();
  }
});

installSelfieImageRoutes(app, jobManager);

// --- WebSocket: STT hands-free (VAD dari browser) -> (vision) -> chat -------
// Protokol pesan:
//   client -> server: { type:'audio_input', data:<base64>, mime, image?, durationMs }
//   server -> client: { type:'user_said', text } | { type:'vision', text }
//                     | { type:'audio_output', data, format } | { type:'audio_end' }
//                     | { type:'amika_replied', text } | { type:'error', message }
function extFromMime(mime) {
  if (!mime) return 'webm';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) {
    return 'm4a';
  }
  return 'webm';
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Desktop Companion (Electron): backend meminta frame layar lewat
// { type:'request_screen_capture' } dan klien menjawab { type:'screen_frame' }.
const SCREEN_CAPTURE_TIMEOUT_MS = Number(process.env.SCREEN_CAPTURE_TIMEOUT_MS) || 5000;
const SCREEN_FRAME_MAX_BASE64_CHARS = 8 * 1024 * 1024; // batas keamanan ~6 MB biner
const SCREEN_FAIL_SPOKEN = 'layarnya tidak bisa kulihat, coba mode borderless';

// Pesan berat khusus Vision Monitor — jangan dikirim ke browser companion.
const MONITOR_ONLY_TYPES = new Set(['monitor_frame', 'routing_status']);
// Socket companion yang sedang share screen (untuk deteksi putus koneksi).
const sharingSockets = new Set();
// Socket Vision Monitor yang terhubung (untuk conditional continuous capture).
const monitorSockets = new Set();
const visionSessions = new Map();
const visionMonitorPresence = new VisionMonitorPresence(active => {
  streamingVisionManager.setMonitorConnected(active);
  for (const manager of visionSessions.values()) manager.setMonitorConnected(active);
  broadcastToCompanions({ type: 'vision_monitor_status', active });
});
// Pesan audio/avatar/selfie khusus companion — tidak perlu sampai ke Vision Monitor.
const COMPANION_ONLY_TYPES = new Set([
  'audio_output', 'audio_end', 'speech_start', 'speech_end', 'stop_speech', 'emotion', 'amika_replied', 'vision',
  'selfie_started', 'selfie_progress', 'selfie_ready', 'selfie_failed', 'selfie_cancelled',
]);

// Kirim pesan hanya ke companion (non-monitor) sockets.
function broadcastToCompanions(obj) {
  const json = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.isMonitor) continue;
    client.send(json);
  }
}

// Hubungkan broadcaster JobManager ke semua socket companion
jobManager.setBroadcaster(broadcastToCompanions);
providerSettings.setBroadcaster(event => {
  broadcastToCompanions(event);
  if (event.type === 'settings_changed') {
    void memoryEmbeddingRuntime.reconcile().catch(error =>
      console.warn('[memory] Embedding settings could not be applied:', error.code ?? 'EMBEDDING_UNAVAILABLE'));
  }
});
void imageSettings.reload().catch((err) => {
  console.warn(`[selfie] Provider startup check failed: ${err.message}`);
});
const stopSelfieConfigWatch = watchSelfieConfig(
  () => void imageSettings.reload().catch((err) => {
    console.warn(`[selfie] Provider config refresh failed: ${err.message}`);
  }),
  { onError: err => console.warn(`[selfie] Config watch failed: ${err.message}`) },
);

// One controller owns turn state and speech IDs for every spoken output.
const speechController = new SpeechController({ generateSpeech, isVoiceConfigured,
  onPlaybackReleased: ({ recipients, memoryContext, spokenText, ...info }) => {
    speechMemoryRecorder.released({ ...info, memoryContext, spokenText });
    for (const socket of recipients) proactiveConversation.playbackCompleted(socket, info);
  } });
const proactiveConversation = new ProactiveConversation({ registry: getProviderRegistry(),
  enabled: getServerTuning('conversation', 'proactiveEnabled', 'on') === 'on',
  decisionTimeoutMs: getServerTuning('conversation', 'proactiveDecisionTimeoutMs', 30000),
  onError: error => console.warn('[proactive] Decision failed:', error.code ?? error.name),
  delaySeconds: getServerTuning('conversation', 'proactiveDelaySeconds', 30) });

function playSpokenMessage(text, emotion = 'sayang', socket, turnId) {
  return speechController.play({ text, emotion, recipients: [socket], turnId });
}

function enqueueSpeech(text, emotion = 'sayang', { speechEmotion, origin = 'selfie' } = {}) {
  return speechController.play({ text, emotion, speechEmotion, deferred: true, origin });
}

jobManager.setSpeechHandler(({ text, emotion, speechEmotion }) => {
  void enqueueSpeech(text, emotion, { speechEmotion });
});
streamingVisionManager.setSpeechHandler((text, emotion, options) => enqueueSpeech(text, emotion, options));

function sendVisionInit(sock, manager = [...visionSessions.values()].at(-1) || streamingVisionManager) {
  if (sock.readyState !== WebSocket.OPEN) return;
  sock.send(JSON.stringify({
    type: 'init_vision_state',
    monitorActive: visionMonitorPresence.active,
    proactive: proactiveConversation.getStatus(sock.isMonitor ? undefined : sock),
    active: Object.values(manager.getSourceSnapshot()).some(source => source.active),
    settings: manager.settings,
    stats: manager.stats,
    sources: manager.getSourceSnapshot(),
    routing: manager.routingStatus,
    bufferCount: manager.buffer.length,
    sync: manager.syncInfo(),
  }));
}

wss.on('connection', (socket, req) => {
  // Vision-monitor bridge konek dengan ws://host:8787/ws?role=monitor
  let isMonitor = false;
  try {
    isMonitor = new URL(req.url, 'http://localhost').searchParams.get('role') === 'monitor';
  } catch {
    // URL tidak valid -> anggap companion biasa
  }

  if (isMonitor) {
    // Observer saja: tanpa sesi percakapan, tanpa history, tanpa keepalive.
    socket.isMonitor = true;
    monitorSockets.add(socket);
    visionMonitorPresence.add(socket);
    console.log(`[monitor] Vision Monitor bridge terhubung (total: ${monitorSockets.size})`);
    sendVisionInit(socket);

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'monitor_presence') {
        visionMonitorPresence.update(socket, msg.active);
      } else if (msg.type === 'update_vision_config') {
        streamingVisionManager.updateSettings(msg.settings || msg);
        for (const manager of visionSessions.values()) manager.updateSettings(msg.settings || msg);
      } else if (msg.type === 'reset_stats') {
        streamingVisionManager.resetStats();
        for (const manager of visionSessions.values()) manager.resetStats();
      } else if (msg.type === 'spontaneous_vision_comment') {
        const conversation = msg.conversationId
          ? [...visionSessions.keys()].find(client => client.visionSessionId === msg.conversationId)
          : proactiveConversation.latestSession;
        if (conversation) void visionSessions.get(conversation)?.considerExternalCommentary(msg)
          .catch(() => console.warn('[vision] External commentary skipped.'));
      }
    });
    socket.once('close', () => {
      monitorSockets.delete(socket);
      visionMonitorPresence.remove(socket);
      console.log(`[monitor] Vision Monitor bridge terputus (sisa: ${monitorSockets.size})`);

    });
    return;
  }

  companionSessionOpened();

  const send = (obj) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
  };
  speechController.register(socket, send);
  const history = []; // Conversation and visual caches belong to this connection.
  const visionManager = new StreamingVisionManager();
  const visionRouter = new ConversationVisionRouter({ onStatus: status => {
    visionManager.routingStatus = status;
    console.info('[routing]', status.status, { method: status.method, target: status.target,
      latencyMs: status.latencyMs, ready: status.ready, reason: status.reason });
    const event = JSON.stringify({ ...status, conversationId: socket.visionSessionId });
    for (const monitor of monitorSockets) if (monitor.readyState === WebSocket.OPEN) monitor.send(event);
  } });
  visionManager.setMonitorConnected(visionMonitorPresence.active);
  visionSessions.set(socket, visionManager);
  socket.visionSessionId = randomUUID();
  socket.captureSessions = { screen: { sessionId: null, active: false }, webcam: { sessionId: null, active: false } };
  socket.explicitVisionControllers = new Map();
  socket.userInputActive = false;
  socket.proactiveEnabled = getServerTuning('conversation', 'proactiveEnabled', 'on') === 'on';
  socket.proactiveDelaySeconds = getServerTuning('conversation', 'proactiveDelaySeconds', 30);

  socket.once('close', () => {
    visionRouter.dispose();
    for (const controller of socket.explicitVisionControllers.values()) controller.abort();
    socket.explicitVisionControllers.clear();
    proactiveConversation.unregister(socket);
    visionManager.dispose();
    visionSessions.delete(socket);
    proactiveConversation.updateSettings({ enabled: [...visionSessions.keys()].some(client => client.proactiveEnabled),
      delaySeconds: proactiveConversation.latestSession?.proactiveDelaySeconds ?? 30 });
    speechController.unregister(socket);
    companionSessionClosed();
    for (const pending of pendingCaptures.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, code: 'DISCONNECTED', spoken: SCREEN_FAIL_SPOKEN });
    }
    pendingCaptures.clear();
    if (sharingSockets.delete(socket) && sharingSockets.size === 0) {
      console.log('[vision] Companion yang share screen terputus -> share dianggap berhenti');
      streamingVisionManager.setScreenShareStatus(false);
    }
  });

  // Minta satu frame layar ke klien desktop. Selalu resolve (tidak pernah reject):
  //   { ok:true, dataUrl, width, height } | { ok:false, code, spoken }
  const pendingCaptures = new Map();
  function requestScreenCapture() {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const t0 = performance.now();
      const timer = setTimeout(() => {
        pendingCaptures.delete(requestId);
        console.warn(`[vision] request_screen_capture timeout (${SCREEN_CAPTURE_TIMEOUT_MS}ms)`);
        resolve({
          ok: false,
          code: 'TIMEOUT',
          spoken: 'aku nggak berhasil lihat layarmu barusan, coba bilang lagi ya',
        });
      }, SCREEN_CAPTURE_TIMEOUT_MS);
      pendingCaptures.set(requestId, {
        timer,
        resolve: (r) => {
          if (r.ok) console.log(`[vision] screen_frame diterima dalam ${Math.round(performance.now() - t0)}ms (${r.width}x${r.height})`);
          resolve(r);
        },
      });
      send({ type: 'request_screen_capture', requestId });
    });
  }

  function handleScreenFrame(msg) {
    const pending = pendingCaptures.get(msg.requestId);
    if (!pending) return; // terlambat / tidak dikenal -> abaikan
    pendingCaptures.delete(msg.requestId);
    clearTimeout(pending.timer);
    if (msg.error) {
      console.warn(`[vision] screen_frame error: ${msg.error.code} - ${msg.error.message}`);
      pending.resolve({
        ok: false,
        code: String(msg.error.code || 'CAPTURE_ERROR'),
        spoken: String(msg.error.spokenMessage || SCREEN_FAIL_SPOKEN).slice(0, 200),
      });
      return;
    }
    const b64 = msg.base64;
    if (typeof b64 !== 'string' || b64.length < 100 || b64.length > SCREEN_FRAME_MAX_BASE64_CHARS) {
      pending.resolve({ ok: false, code: 'INVALID_FRAME', spoken: SCREEN_FAIL_SPOKEN });
      return;
    }
    pending.resolve({
      ok: true,
      dataUrl: `data:image/jpeg;base64,${b64}`,
      width: msg.width,
      height: msg.height,
    });
  }

  const broadcastToAll = (obj) => {
    const json = JSON.stringify(obj);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.isMonitor && COMPANION_ONLY_TYPES.has(obj.type)) continue;
      if (!client.isMonitor && MONITOR_ONLY_TYPES.has(obj.type)) continue;
      client.send(json);
    }
  };

  visionManager.setBroadcaster((obj) => {
    const event = { ...obj, conversationId: socket.visionSessionId };
    if (!MONITOR_ONLY_TYPES.has(obj.type)) send(event);
    const json = JSON.stringify(event);
    for (const monitor of monitorSockets) {
      if (monitor.readyState === WebSocket.OPEN && !COMPANION_ONLY_TYPES.has(obj.type)) monitor.send(json);
    }
  });
  visionManager.setHistoryRef(history);
  visionManager.setCommentaryAdmission(() => !socket.userInputActive && !speechController.isBusy(socket)
    && !speechController.activeSpeech && speechController.queue.length === 0
    && [...visionSessions.keys()].every(client => !client.userInputActive && !speechController.isBusy(client)));
  visionManager.setSpeechHandler((text, emotion, { speechEmotion, signal, onAdmitted } = {}) => {
    if (signal?.aborted || !visionManager.commentaryAvailable()) return;
    return speechController.play({ signal, recipients: [socket], origin: 'vision',
      memoryContext: speechMemoryRecorder.context({ sessionId: socket.visionSessionId, origin: 'vision' }),
      produce: async ({ say, signal: playbackSignal }) => {
        if (!playbackSignal.aborted && onAdmitted?.()) await say(text, emotion, () => {}, { speechEmotion });
      } });
  });
  proactiveConversation.register(socket, {
    history: () => history,
    getVisionContext: () => visionManager.getConversationContext(),
    isAvailable: () => socket.proactiveEnabled && getSlotStatus('llm').available && getSlotStatus('tts').available,
    isBusy: () => socket.userInputActive || speechController.isBusy(socket)
      || Boolean(speechController.activeSpeech) || speechController.queue.length > 0,
    onStatus: status => {
      const key = status.status + ':' + status.reason;
      if (socket.lastProactiveLogKey !== key) {
        socket.lastProactiveLogKey = key;
        console.info('[proactive]', status.status, status.reason ?? '',
          { remainingMs: status.remainingMs, unanswered: status.unanswered });
      }
      const event = { ...status, conversationId: socket.visionSessionId };
      send(event);
      const json = JSON.stringify(event);
      for (const monitor of monitorSockets) {
        if (monitor.readyState === WebSocket.OPEN) monitor.send(json);
      }
    },
    onCancel: ({ reason }) => speechController.cancelProactive(socket, { drain: reason !== 'user_activity' }),
    onSpeak: async ({ topic, cue, reason, signal, visionContext }) => {
      const turn = speechController.beginTurn(socket, { origin: 'proactive' });
      if (!turn || signal.aborted) return { ok: false };
      const abort = () => speechController.cancelProactive(socket, { drain: false });
      signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await playConversationReply({ controller: speechController, socket, turnId: turn.turnId,
          history, userMessage: null, vision: visionContext, origin: 'proactive',
          memoryContext: speechMemoryRecorder.context({ sessionId: socket.visionSessionId,
            turnId: turn.turnId, origin: 'proactive' }),
          guidance: () => proactiveConversation.consumeGuidance(socket),
          internalInstruction: proactiveSpeechInstruction({ reason, topic, cue }),
        });
        if (signal.aborted || !speechController.isCurrentTurn(socket, turn.turnId) || !result.text.trim()) return { ok: false };
        history.push({ role: 'assistant', content: result.text });
        if (history.length > HISTORY_MESSAGE_LIMIT) history.splice(0, history.length - HISTORY_MESSAGE_LIMIT);
        visionManager.setAssistantContext(result.text);
        if (result.reflectionRequest) proactiveConversation.requestReflection(socket, {
          request: result.reflectionRequest, turnId: turn.turnId, speechId: result.speechId,
        });
        return { ...result, ok: result.ok !== false };
      } finally {
        signal.removeEventListener('abort', abort);
        speechController.completeTurn(socket, turn.turnId);
      }
    },
  });

  // Kirim status awal percakapan ke client
  send({
    type: 'conversation_state',
    state: socket.conversationState,
  });

  // Kirim status awal vision streaming ke client yang baru terhubung
  sendVisionInit(socket, visionManager);

  const handleSelfieFeature = installSelfieFeatureControl({ socket, manager: jobManager, send });
  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (handleSelfieFeature(msg)) return;

    if (msg.type === 'conversation_ready') {
      if (typeof msg.audioReady !== 'boolean') return;
      proactiveConversation.setReady(socket, msg.audioReady);
      proactiveConversation.updateSettings({ enabled: [...visionSessions.keys()].some(client => client.proactiveEnabled),
        delaySeconds: proactiveConversation.latestSession?.proactiveDelaySeconds ?? socket.proactiveDelaySeconds });
      if (!msg.audioReady) speechController.cancelProactive(socket, { drain: false });
      return;
    }

    if (msg.type === 'user_activity') {
      if (!['start', 'end'].includes(msg.phase)) return;
      socket.userInputActive = msg.phase === 'start';
      if (socket.userInputActive) visionManager.conversationActivity();
      proactiveConversation.updateSettings({ enabled: [...visionSessions.keys()].some(client => client.proactiveEnabled),
        delaySeconds: socket.proactiveDelaySeconds });
      proactiveConversation.setUserActive(socket, socket.userInputActive);
      speechController.cancelProactive(socket, { drain: false });
      return;
    }
    if (msg.type === 'proactive_config') {
      if (typeof msg.enabled !== 'boolean') return;
      socket.proactiveEnabled = msg.enabled;
      socket.proactiveDelaySeconds = Number.isFinite(msg.delaySeconds) ? Math.max(30, Math.min(300, msg.delaySeconds)) : 30;
      proactiveConversation.updateSettings({ enabled: [...visionSessions.keys()].some(client => client.proactiveEnabled),
        delaySeconds: proactiveConversation.latestSession?.proactiveDelaySeconds ?? socket.proactiveDelaySeconds });
      if (!msg.enabled) {
        proactiveConversation.cancel(socket, 'disabled');
        speechController.cancelProactive(socket);
      }
      return;
    }

    if (msg.type === 'mic_mute') {
      if (typeof msg.muted !== 'boolean') return;
      socket.micMuted = msg.muted;
      if (socket.micMuted && socket.userInputActive) {
        socket.userInputActive = false;
        proactiveConversation.setUserActive(socket, false);
      }
      console.log('[mic] Microphone mute state:', socket.micMuted);
      if (socket.micMuted && socket.sttTurnId) {
        speechController.cancelTurn(socket, socket.sttTurnId, 'MIC_MUTED');
      }
      return;
    }

    // 0. Sinyal selesai playback dari client untuk turn-taking
    if (msg.type === 'playback_finished') {
      speechController.acknowledge(socket, msg.speechId);
      return;
    }

    // Sinyal pembatalan selfie dari client (Point 13 & 16)
    if (msg.type === 'selfie_cancel') {
      console.log(`[selfie] Client meminta pembatalan selfie [jobId: ${msg.jobId}]`);
      void jobManager.cancelJob(msg.jobId);
      return;
    }

    // 1. Continuous frame capture dari screen share di companion utama
    if (msg.type === 'screen_frame') {
      handleScreenFrame(msg);
      return;
    }

    if (msg.type === 'continuous_frame') {
      void visionManager.handleContinuousFrame(msg.image, msg).catch(error => {
        console.warn('[vision] Continuous capture failed:', error.message);
      });
      return;
    }

    if (msg.type === 'vision_capture_status') {
      if (!['screen', 'webcam'].includes(msg.source) || typeof msg.active !== 'boolean'
        || typeof msg.sessionId !== 'string' || !msg.sessionId.trim() || msg.sessionId.length > 128) return;
      const previous = socket.captureSessions[msg.source];
      socket.captureSessions[msg.source] = { sessionId: msg.sessionId, active: msg.active };
      if (previous.sessionId !== msg.sessionId || previous.active !== msg.active) {
        visionRouter.retireSource(msg.source);
        socket.explicitVisionControllers.get(msg.source)?.abort();
      }
      return;
    }

    if (msg.type === 'vision_source_status') {
      if (!['screen', 'webcam'].includes(msg.source) || typeof msg.active !== 'boolean') return;
      const previous = visionManager.getSourceSnapshot()[msg.source];
      if (!msg.active || previous?.sessionId !== msg.sessionId) visionRouter.retireSource(msg.source);
      visionManager.setSourceStatus(msg.source, msg.active, msg.sessionId);
      return;
    }

    // 2. Status screen share aktif / nonaktif dari companion utama
    if (msg.type === 'screen_share_status') {
      if (msg.active) sharingSockets.add(socket);
      else sharingSockets.delete(socket);
      visionManager.setScreenShareStatus(Boolean(msg.active));
      const enableCapture = msg.active && visionMonitorPresence.active && getSlotStatus('vision').available;
      send({ type: 'continuous_capture_control', enabled: enableCapture });
      return;
    }

    // 3. Update konfigurasi vision (interval, maxTokens, buffer) dari Vision Monitor
    if (msg.type === 'update_vision_config') {
      visionManager.updateSettings(msg.settings || msg);
      return;
    }

    // External proposals use the same relevance and admission gate as continuous observations.
    if (msg.type === 'spontaneous_vision_comment') {
      await visionManager.considerExternalCommentary(msg);
      return;
    }

    if (msg.type !== 'audio_input' && msg.type !== 'text_input') return;
    visionManager.conversationActivity();
    const isTyped = msg.type === 'text_input';
    if (!isTyped && socket.micMuted) {
      speechController.rejectInput(socket, 'MIC_MUTED');
      return;
    }

    const { data, mime, image, screenImage, durationMs } = msg;
    const typedText = isTyped ? String(msg.text ?? '').trim().slice(0, 1000) : '';
    if (isTyped ? !typedText : typeof data !== 'string' || !data || (typeof durationMs === 'number' && durationMs < 400)) return;
    const audioBuffer = isTyped ? null : Buffer.from(data, 'base64');
    if (audioBuffer && audioBuffer.length < 512) return;

    // Reject input explicitly so the client can restore its optimistic UI.
    proactiveConversation.updateSettings({ enabled: [...visionSessions.keys()].some(client => client.proactiveEnabled),
      delaySeconds: socket.proactiveDelaySeconds });
    proactiveConversation.setUserActive(socket, false);
    speechController.cancelProactive(socket, { drain: false });
    socket.userInputActive = false;
    if (speechController.isBusy(socket)) {
      speechController.rejectInput(socket, 'BUSY');
      return;
    }

    let turn = null;
    try {
      const buf = audioBuffer;

      turn = speechController.beginTurn(socket);
      if (!turn) return;
      const isCurrent = () => speechController.isCurrentTurn(socket, turn.turnId);
      const send = (event) => speechController.sendTurn(socket, turn.turnId, event);
      if (!isTyped && !getSlotStatus('stt').available) {
        await playSpokenMessage(UNAVAILABLE_MESSAGES.stt, 'netral', socket, turn.turnId);
        return;
      }

      // --- timing diagnostics (ponytail: hapus blok [timing] kalau tak perlu) --
      // Semua durasi relatif ke saat input valid diterima (tPipe).
      const tPipe = performance.now();
      const ms = (a, b) => Math.round((b ?? performance.now()) - a);

      // 1) STT (Groq Whisper) — dilewati untuk teks ketikan
      let text;
      let tSttEnd = performance.now();
      if (isTyped) {
        text = typedText;
        console.log(`[typed] input teks: ${JSON.stringify(text)}`);
      } else {
        const tSttStart = performance.now();
        socket.sttTurnId = turn.turnId;
        try {
          text = await transcribeAudio(buf, `audio.${extFromMime(mime)}`, { signal: turn.signal, mime });
        } finally {
          if (socket.sttTurnId === turn.turnId) socket.sttTurnId = null;
        }
        if (!isCurrent()) return;
        tSttEnd = performance.now();
        console.log(`[timing] STT: ${ms(tSttStart, tSttEnd)}ms (t+${ms(tPipe, tSttEnd)})`);
      }

      // Filter noise: transkripsi kosong / terlalu pendek -> skip seluruh
      // pipeline (jangan buang API call untuk napas/dengkuran/suara latar).
      // ponytail: kalau Whisper masih halusinasi ("terima kasih") pas hening,
      // ganti sttTranscribe ke verbose_json & saring no_speech_prob.
      if (!isTyped && text.length < 3) {
        console.log('[stt] skip, noise/pendek:', JSON.stringify(text));
        return;
      }
      send({ type: 'user_said', text });
      markConversationActivity();

      // --- 2a) Modul Selfie (PAP): deteksi intent SEBELUM jalur percakapan biasa ---
      const selfieIntent = detectSelfieIntent(text);
      if (selfieIntent.isSelfie) {
        console.log(`[selfie] Intent selfie terdeteksi: "${text}" (keyword: ${selfieIntent.matchedKeyword})`);

        const result = disabledSelfieResult(socket) || await prepareSelfieJob({
          manager: jobManager,
          planner: planSelfie,
          userText: text,
          history,
          signal: turn.signal,
        });
        if (!isCurrent()) return;
        if (!result.ok) {
          console.log(`[selfie] Request rejected: ${result.reason}`);
          await playSpokenMessage(result.text, result.emotion, socket, turn.turnId);
          if (!isCurrent()) return;
          history.push({ role: 'user', content: text });
          history.push({ role: 'assistant', content: result.text });
          return;
        }

        history.push({ role: 'user', content: text });
        history.push({ role: 'assistant', content: result.plan.caption });

        // Ucapkan ucapan awal segera lewat pipeline TTS ("tunggu ya, aku pose dulu")
        const initialText = result.initialText || jobManager.pickPhrase('initial') || 'Tunggu ya sayang, aku pose dulu sebentar...';
        await playSpokenMessage(initialText, 'sayang', socket, turn.turnId);
        return;
      }

      // 2) Vision routing is private and precedes explicit inspection and spoken stages.
      const memoryContext = speechMemoryRecorder.context({ sessionId: socket.visionSessionId,
        turnId: turn.turnId, userText: text });
      // Retrieval overlaps routing and fresh inspection whenever those are needed.
      const memoryBundle = Promise.resolve().then(() => memoryManager.retrieve(text,
        { history: trimConversationHistory(history), signal: turn.signal })).catch(() => null);
      const inspectionSnapshot = structuredClone({ captureSessions: socket.captureSessions,
        sources: visionManager.getSourceSnapshot() });
      const decision = await visionRouter.route(text, { history, signal: turn.signal, turnId: turn.turnId,
        availability: { webcam: Boolean(image), screen: Boolean(screenImage) || msg.desktop === true && msg.screenVisionOn === true },
        observations: visionManager.getRoutingObservations(), captureSessions: socket.captureSessions });
      if (!isCurrent()) return;
      let vision = visionManager.getConversationContext();
      if (decision.sources.length && !getSlotStatus('vision').available) {
        await playSpokenMessage(UNAVAILABLE_MESSAGES.vision, 'netral', socket, turn.turnId);
        return;
      }
      if (decision.sources.length) {
        const successfulSources = [];
        vision = await inspectVision({ decision, socket, manager: visionManager, input: msg, image, screenImage,
          captureSnapshot: inspectionSnapshot,
          signal: turn.signal, isCurrent, send, captureScreen: requestScreenCapture,
          onSuccess: source => successfulSources.push(source) });
        if (!isCurrent()) return;
        visionRouter.remember(successfulSources, socket.captureSessions);
      }

      // Surface and deeper speech share one turn, ordered audio, and history.
      let tLlmFirstToken = 0;
      let tLlmFirstSentence = 0;
      let tTtsStart = 0;
      let tFirstAudioOut = 0;
      const reply = await playConversationReply({ controller: speechController, socket, turnId: turn.turnId,
        history, userMessage: text, vision, memoryContext, memoryBundle,
        guidance: () => proactiveConversation.consumeGuidance(socket),
        onEvent: event => {
          if (event.type === 'delta' && !tLlmFirstToken) tLlmFirstToken = performance.now();
          if (event.type === 'sentence' && !tLlmFirstSentence) tLlmFirstSentence = performance.now();
          if (event.type === 'tts_start' && !tTtsStart) tTtsStart = performance.now();
          if (event.type === 'tts_chunk' && !tFirstAudioOut) {
            tFirstAudioOut = performance.now();
            console.log(`[timing] STT: ${ms(tPipe, tSttEnd)}ms` +
              ` | first token: ${ms(tPipe, tLlmFirstToken)}ms` +
              ` | first sentence: ${ms(tPipe, tLlmFirstSentence)}ms` +
              ` | TTS first chunk: ${ms(tTtsStart, tFirstAudioOut)}ms` +
              ` | total first audio: ${ms(tPipe, tFirstAudioOut)}ms`);
          }
          if (event.type === 'stage_error') console.warn('[conversation]', event.stage, 'stage failed');
        },
      });
      if (!isCurrent()) return;

      history.push({ role: 'user', content: text });
      if (reply.text.trim()) history.push({ role: 'assistant', content: reply.text });
      visionManager.setAssistantContext(reply.text);
      if (history.length > HISTORY_MESSAGE_LIMIT) {
        history.splice(0, history.length - HISTORY_MESSAGE_LIMIT);
      }

      // Original dialogue is archived by the playback-release callback.
      if (reply.reflectionRequest) proactiveConversation.requestReflection(socket, {
        request: reply.reflectionRequest, turnId: turn.turnId, speechId: reply.speechId,
      });
    } catch (err) {
      if (!turn || !speechController.isCurrentTurn(socket, turn.turnId)) return;
      console.error('[stt] error:', err);
      speechController.sendTurn(socket, turn.turnId, { type: 'error', message: err.message ?? 'STT gagal.' });
    } finally {
      if (turn) speechController.completeTurn(socket, turn.turnId);
    }
  });
});

// Install after role assignment so monitor sockets do not receive selfie snapshots.
installSelfieLifecycle({ manager: jobManager, server, wss, beforeShutdown: async () => {
  memoryManager.dispose();
  await memoryEmbeddingRuntime.dispose();
  await imageSettings.shutdown();
} });
server.once('close', stopSelfieConfigWatch);
server.once('close', () => {
  proactiveConversation.dispose();
  memoryManager.dispose();
  void memoryEmbeddingRuntime.dispose();
  for (const manager of visionSessions.values()) manager.dispose();
});

const PORT = process.env.PORT || 8787;
server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[server] 9inference + STT proxy jalan di http://localhost:${PORT} (ws: /ws)`,
  );
  try { memoryManager.start(); } catch (error) {
    console.warn('[memory] Background processing unavailable:', error.code ?? 'MEMORY_STORAGE');
  }
  void memoryEmbeddingRuntime.start().catch(error => console.warn('[memory] Embedding service unavailable:', error.code ?? 'EMBEDDING_UNAVAILABLE'));
  void warmUpModels();
});
