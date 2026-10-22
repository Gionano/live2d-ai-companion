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
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  describeFrame,
  detectVisionIntent,
  resolveVisionSource,
} from './visionCapture.js';
import { streamingVisionManager } from './streamingVisionManager.js';
import {
  generateReply,
  generateReplyStream,
  HISTORY_MESSAGE_LIMIT,
} from './llmChat.js';
import { transcribeAudio } from './sttTranscribe.js';
import { generateSpeech } from './ttsGenerate.js';
import { isVoiceConfigured } from './voiceConfig.js';
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
import { detectSelfieIntent } from './selfie/intent.js';
import { planSelfie } from './selfie/planner.js';
import { jobManager } from './selfie/jobManager.js';
import { installSelfieLifecycle, prepareSelfieJob } from './selfie/backendLifecycle.js';
import { installSelfieFeatureControl, disabledSelfieResult } from './selfie/featureControl.js';
import { installSelfieImagePolicy, installSelfieImageRoutes } from './selfie/imageRoutes.js';

const app = express();
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
    res.json(JSON.parse(raw));
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
      current = JSON.parse(await fs.promises.readFile(CONFIG_FILE_PATH, 'utf-8'));
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
    const description = await describeFrame(image);
    res.json({ description });
  } catch (err) {
    console.error('[vision] error:', err);
    res.status(500).json({ error: err.message ?? 'Vision gagal.' });
  }
});

// --- Long-Term Memory & Episodic Recall APIs ---
app.get('/api/memory', (req, res) => {
  res.json({
    lastSeen: memoryManager.memory.lastSeen,
    lastSeenText: memoryManager.formatTimeElapsed(memoryManager.memory.lastSeen),
    profile: memoryManager.memory.profile,
    episodes: memoryManager.memory.episodes,
    promptPreview: memoryManager.getMemoryPrompt(),
  });
});

app.post('/api/memory/clear', (req, res) => {
  memoryManager.clearMemory();
  res.json({ success: true, message: 'Memori jangka panjang berhasil di-reset.' });
});

app.post('/api/memory/fact', (req, res) => {
  const { text, category } = req.body ?? {};
  if (!text) {
    return res.status(400).json({ error: 'Field "text" wajib diisi.' });
  }
  memoryManager.addFact(text, category || 'manual');
  res.json({ success: true, facts: memoryManager.memory.profile.facts });
});

app.post('/api/chat', async (req, res) => {
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
    for await (const event of generateReply(history, message, visionDescription)) {
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
const MONITOR_ONLY_TYPES = new Set(['monitor_frame']);
// Socket companion yang sedang share screen (untuk deteksi putus koneksi).
const sharingSockets = new Set();
// Socket Vision Monitor yang terhubung (untuk conditional continuous capture).
const monitorSockets = new Set();
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

// One controller owns turn state and speech IDs for every spoken output.
const speechController = new SpeechController({ generateSpeech, isVoiceConfigured });

function playSpokenMessage(text, emotion = 'sayang', socket, turnId) {
  return speechController.play({ text, emotion, recipients: [socket], turnId });
}

function enqueueSpeech(text, emotion = 'sayang') {
  return speechController.play({ text, emotion, deferred: true });
}

jobManager.setSpeechHandler(({ text, emotion }) => {
  void enqueueSpeech(text, emotion);
});
streamingVisionManager.setSpeechHandler((text, emotion) => enqueueSpeech(text, emotion));

function sendVisionInit(sock) {
  if (sock.readyState !== WebSocket.OPEN) return;
  sock.send(JSON.stringify({
    type: 'init_vision_state',
    active: streamingVisionManager.isScreenShareActive,
    settings: streamingVisionManager.settings,
    stats: streamingVisionManager.stats,
    bufferCount: streamingVisionManager.buffer.length,
    sync: streamingVisionManager.syncInfo(),
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
    streamingVisionManager.setMonitorConnected(true);
    console.log(`[monitor] Vision Monitor bridge terhubung (total: ${monitorSockets.size})`);
    sendVisionInit(socket);

    // Monitor baru konek & share aktif → mulai continuous capture di companion
    if (monitorSockets.size === 1 && sharingSockets.size > 0) {
      broadcastToCompanions({ type: 'continuous_capture_control', enabled: true });
    }

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'update_vision_config') {
        streamingVisionManager.updateSettings(msg.settings || msg);
      } else if (msg.type === 'reset_stats') {
        streamingVisionManager.resetStats();
      }
    });
    socket.once('close', () => {
      monitorSockets.delete(socket);
      const stillHasMonitor = monitorSockets.size > 0;
      streamingVisionManager.setMonitorConnected(stillHasMonitor);
      console.log(`[monitor] Vision Monitor bridge terputus (sisa: ${monitorSockets.size})`);

      // Monitor terakhir pergi & share masih aktif → stop continuous capture
      if (!stillHasMonitor && sharingSockets.size > 0) {
        broadcastToCompanions({ type: 'continuous_capture_control', enabled: false });
      }
    });
    return;
  }

  companionSessionOpened();

  const send = (obj) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
  };
  speechController.register(socket, send);

  socket.once('close', () => {
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

  const history = []; // Conversation history remains per connection.

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

  streamingVisionManager.setBroadcaster(broadcastToAll);
  streamingVisionManager.setHistoryRef(history);

  // Kirim status awal percakapan ke client
  send({
    type: 'conversation_state',
    state: socket.conversationState,
  });

  // Kirim status awal vision streaming ke client yang baru terhubung
  sendVisionInit(socket);

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
      streamingVisionManager.handleContinuousFrame(msg.image);
      return;
    }

    // 2. Status screen share aktif / nonaktif dari companion utama
    if (msg.type === 'screen_share_status') {
      if (msg.active) sharingSockets.add(socket);
      else sharingSockets.delete(socket);
      streamingVisionManager.setScreenShareStatus(sharingSockets.size > 0);
      // Continuous capture hanya jalan jika ada monitor terhubung
      const enableCapture = msg.active && monitorSockets.size > 0;
      send({ type: 'continuous_capture_control', enabled: enableCapture });
      return;
    }

    // 3. Update konfigurasi vision (interval, maxTokens, buffer) dari Vision Monitor
    if (msg.type === 'update_vision_config') {
      streamingVisionManager.updateSettings(msg.settings || msg);
      return;
    }

    // 4. Handler untuk komentar spontan eksternal (jika ada)
    if (msg.type === 'spontaneous_vision_comment') {
      if (speechController.isBusy(socket)) {
        console.log(`[spontaneous] Diabaikan: percakapan sedang "${socket.conversationState}"`);
        return;
      }
      const { text, emotion = 'netral' } = msg;
      if (!text) return;
      console.log(`[spontaneous] Komentar visual diterima dari vision-monitor: "${text}" (${emotion})`);

      markConversationActivity();
      history.push({ role: 'assistant', content: text });
      if (history.length > HISTORY_MESSAGE_LIMIT) {
        history.splice(0, history.length - HISTORY_MESSAGE_LIMIT);
      }

      broadcastToAll({ type: 'vision', text: `[Spontan] ${text}` });
      await enqueueSpeech(text, emotion);
      return;
    }

    if (msg.type !== 'audio_input' && msg.type !== 'text_input') return;
    const isTyped = msg.type === 'text_input';

    // Reject input explicitly so the client can restore its optimistic UI.
    if (speechController.isBusy(socket)) {
      speechController.rejectInput(socket, 'BUSY');
      return;
    }

    const { data, mime, image, screenImage, durationMs } = msg;
    const typedText = isTyped ? String(msg.text ?? '').trim().slice(0, 1000) : '';

    // Guard: audio kosong / terlalu pendek -> skip diam-diam. VAD kadang kirim
    // blip pendek; jangan spam error di log hands-free.
    if (isTyped) {
      if (!typedText) return;
    } else if (!data || (typeof durationMs === 'number' && durationMs < 400)) {
      return;
    }

    let turn = null;
    try {
      let buf = null;
      if (!isTyped) {
        buf = Buffer.from(data, 'base64');
        if (buf.length < 512) return;
      }

      turn = speechController.beginTurn(socket);
      if (!turn) return;
      const isCurrent = () => speechController.isCurrentTurn(socket, turn.turnId);
      const send = (event) => speechController.sendTurn(socket, turn.turnId, event);

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
        text = await transcribeAudio(buf, `audio.${extFromMime(mime)}`, { signal: turn.signal });
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

      // 2) Vision — periksa intent & pisahkan source (screen vs webcam)
      let vision = null;
      if (detectVisionIntent(text)) {
        // Klien Electron: layar "aktif" = Screen Vision di tray ON; frame diminta
        // on-demand lewat request_screen_capture (bukan Share Screen browser).
        const isDesktop = msg.desktop === true;
        const desktopScreenOn = isDesktop && msg.screenVisionOn === true;
        const route = resolveVisionSource(text, {
          hasCamera: Boolean(image),
          hasScreen: Boolean(screenImage) || desktopScreenOn,
        });
        const { source, requested, available } = route;
        console.log(
          `[vision] intent: diminta=${requested ?? 'ambigu'}, dipakai=${source ?? 'none'},` +
            ` kamera aktif=${Boolean(image)}, layar aktif=${Boolean(screenImage) || desktopScreenOn}` +
            (isDesktop ? ' (desktop)' : ''),
        );

        if (isDesktop && (source === null || (!available && source === 'screen'))) {
          // Electron: JANGAN minta klik Share Screen — toggle ada di tray.
          if (source === null) {
            vision = 'KAMERA_DAN_LAYAR_MATI: user minta kamu melihat sesuatu, tetapi kamera belum aktif dan fitur lihat layar sedang dimatikan di pengaturan tray. Minta user menyalakan kamera atau mengaktifkan Screen Vision lewat ikon tray. Jangan menyebut Share Screen.';
            send({ type: 'vision', text: 'Kamera belum aktif dan Screen Vision sedang off.' });
          } else {
            vision = 'LAYAR_DIMATIKAN: user meminta kamu melihat layar/game/aplikasinya, tetapi fitur lihat layar sedang dimatikan di pengaturan tray. Minta user mengaktifkan Screen Vision lewat ikon tray. Jangan menyebut Share Screen.';
            send({ type: 'vision', text: 'Screen Vision sedang off. Aktifkan lewat menu tray.' });
          }
        } else if (source === null) {
          // Ambigu & tidak ada sumber aktif. JANGAN sebut Share Screen saja.
          vision = 'KAMERA_DAN_LAYAR_MATI: user minta kamu melihat sesuatu, tetapi kamera dan share screen sama-sama belum aktif. Minta user menyalakan kamera atau share screen.';
          send({ type: 'vision', text: '⚠️ Kamera dan layar belum aktif.' });
        } else if (!available) {
          if (source === 'screen') {
            // Hanya muncul kalau user EKSPLISIT minta layar & layar mati.
            vision = 'LAYAR_MATI: user meminta kamu melihat layar/game/aplikasinya, tetapi Share Screen belum diaktifkan. Minta user klik tombol Share Screen.';
            send({ type: 'vision', text: '⚠️ Layar belum di-share. Aktifkan tombol "Share Screen" terlebih dahulu.' });
          } else {
            vision = 'KAMERA_MATI: user meminta kamu melihat lewat kamera, tetapi kamera belum aktif/diizinkan. Minta user menyalakan kamera. Jangan menyebut Share Screen.';
            send({ type: 'vision', text: '⚠️ Kamera belum aktif.' });
          }
        } else {
          let frame = source === 'screen' ? screenImage : image;
          const label = source === 'screen' ? 'Layar' : 'Kamera';
          try {
            const tVisStart = performance.now();
            let desc;
            let captureFailure = null;

            // Smart routing: kalau sumber = layar DAN monitor terhubung,
            // ambil deskripsi dari buffer continuous capture (jauh lebih cepat,
            // tanpa API call tambahan). Kalau buffer kosong → fallback one-shot.
            if (source === 'screen' && monitorSockets.size > 0) {
              const bufferDesc = streamingVisionManager.getLatestDescriptions();
              if (bufferDesc) {
                desc = bufferDesc;
                console.log(`[vision] Menggunakan buffer monitor (${streamingVisionManager.buffer.length} entri)`);
              }
            }

            // Electron: minta frame layar langsung ke klien (timeout 5 dtk)
            if (!desc && source === 'screen' && !frame && desktopScreenOn) {
              const cap = await requestScreenCapture();
              if (!isCurrent()) return;
              if (cap.ok) frame = cap.dataUrl;
              else captureFailure = cap;
            }

            if (captureFailure) {
              console.warn(`[vision] capture layar gagal (${captureFailure.code})`);
              vision = `LAYAR_GAGAL: user meminta kamu melihat layarnya, tetapi layar tidak berhasil ditangkap (${captureFailure.code}). Sampaikan dengan natural, kurang lebih: "${captureFailure.spoken}". Jangan pura-pura melihat dan jangan menyebut Share Screen.`;
              send({ type: 'vision', text: captureFailure.spoken });
            } else {
              // Fallback one-shot: buffer kosong atau sumber = kamera
              if (!desc) {
                desc = await describeFrame(frame, source);
                if (!isCurrent()) return;
              }

              console.log(`[timing] vision (${source}): ${ms(tVisStart)}ms (t+${ms(tPipe)})`);
              send({ type: 'vision', text: `[${label}] ${desc}` });
              // Konteks eksplisit: vision BERHASIL, jawab berdasarkan ini.
              vision = `(${label} aktif & berhasil dilihat) ${desc}`;
            }
          } catch (err) {
            if (!isCurrent()) return;
            console.error(`[vision:${source}] error:`, err);
            send({ type: 'error', message: `Vision ${label.toLowerCase()} gagal: ${err.message}` });
          }
        }
      }

      // 3) Chat streaming + TTS per kalimat. generateReplyStream yield
      // {type:'delta'} (akumulasi teks) & {type:'sentence'} (kalimat utuh ->
      // TTS). Audio antar-kalimat di-serialize lewat ttsChain biar urut.
      // Streaming SUDAH benar: TTS kalimat pertama jalan begitu {sentence}
      // pertama muncul, tak nunggu LLM selesai (lihat [timing] di bawah).
      let full = '';
      let ttsChain = Promise.resolve();

      // Milestone timing (di-set sekali; 0 = belum kejadian).
      let tLlmFirstToken = 0;
      let tLlmFirstSentence = 0;
      let tTtsStart = 0;
      let tTtsFirstChunk = 0;
      let tFirstAudioOut = 0;
      let sentenceIdx = 0;

      let replyEmotion = 'netral';

      async function speak(sentence, idx, say, emotion) {
        const isFirst = idx === 0;
        if (isFirst) tTtsStart = performance.now();
        await say(sentence, emotion, () => {
          if (isFirst && !tTtsFirstChunk) tTtsFirstChunk = performance.now();
          if (isFirst && !tFirstAudioOut) {
            tFirstAudioOut = performance.now();
            console.log(
              `[timing] STT selesai: ${ms(tPipe, tSttEnd)}ms` +
                ` | LLM first token: ${ms(tPipe, tLlmFirstToken)}ms` +
                ` | LLM first sentence: ${ms(tPipe, tLlmFirstSentence)}ms` +
                ` | TTS req->first chunk: ${ms(tTtsStart, tTtsFirstChunk)}ms` +
                ` | total to first audio: ${ms(tPipe, tFirstAudioOut)}ms`,
            );
          }
        });
      }

      await speechController.play({
        recipients: [socket],
        turnId: turn.turnId,
        produce: async ({ say, signal }) => {
          try {
            const tLlmStart = performance.now(); // = saat request LLM dimulai
            for await (const ev of generateReplyStream(history, text, vision, { signal })) {
              if (signal.aborted || !isCurrent()) break;
              if (ev.type === 'emotion') {
                replyEmotion = ev.emotion;
                send({ type: 'emotion', emotion: replyEmotion });
                console.log(`[emotion] LLM selected: ${replyEmotion}`);
              } else if (ev.type === 'delta') {
                if (!tLlmFirstToken) {
                  tLlmFirstToken = performance.now();
                  console.log(`[timing] LLM first token: ${ms(tLlmStart, tLlmFirstToken)}ms (req->ttft, t+${ms(tPipe)})`);
                }
                full += ev.text;
              } else if (ev.type === 'sentence') {
                if (!tLlmFirstSentence) {
                  tLlmFirstSentence = performance.now();
                  console.log(`[timing] LLM first sentence: ${ms(tLlmStart, tLlmFirstSentence)}ms (req->sentence, t+${ms(tPipe)})`);
                }
                const idx = sentenceIdx++;
                const emotion = replyEmotion;
                ttsChain = ttsChain.then(() => speak(ev.text, idx, say, emotion));
              }
            }
          } finally {
            await ttsChain;
            if (!signal.aborted && isCurrent()) send({ type: 'amika_replied', text: full, emotion: replyEmotion });
          }
        },
      });
      if (!isCurrent()) return;

      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: full });
      if (history.length > HISTORY_MESSAGE_LIMIT) {
        history.splice(0, history.length - HISTORY_MESSAGE_LIMIT);
      }

      // Catat & ekstrak memori jangka panjang di latar belakang (non-blocking)
      void memoryManager.recordTurnAndExtract(text, full);
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
installSelfieLifecycle({ manager: jobManager, server, wss });

const PORT = process.env.PORT || 8787;
server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[server] 9inference + STT proxy jalan di http://localhost:${PORT} (ws: /ws)`,
  );
  void warmUpModels();
});
