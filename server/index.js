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

const app = express();
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

// Pesan berat khusus Vision Monitor — jangan dikirim ke browser companion.
const MONITOR_ONLY_TYPES = new Set(['monitor_frame']);
// Socket companion yang sedang share screen (untuk deteksi putus koneksi).
const sharingSockets = new Set();
// Socket Vision Monitor yang terhubung (untuk conditional continuous capture).
const monitorSockets = new Set();
// Pesan audio/avatar khusus companion — tidak perlu sampai ke Vision Monitor.
const COMPANION_ONLY_TYPES = new Set([
  'audio_output', 'audio_end', 'emotion', 'amika_replied', 'vision',
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

  let conversationState = 'idle'; // 'idle' | 'processing' | 'speaking'
  let safetyTimer = null;

  function clearSafetyTimer() {
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
  }

  function setConversationState(newState) {
    if (conversationState === newState) return;
    clearSafetyTimer();
    const oldState = conversationState;
    conversationState = newState;
    console.log(`[turn] State transition: ${oldState} -> ${newState}`);
    send({ type: 'conversation_state', state: conversationState });

    if (conversationState !== 'idle') {
      safetyTimer = setTimeout(() => {
        console.warn(`[turn] Safety timeout (30s) reached while in state "${conversationState}". Forcing reset to idle.`);
        setConversationState('idle');
      }, 100000);
    }
  }

  socket.once('close', () => {
    clearSafetyTimer();
    companionSessionClosed();
    if (sharingSockets.delete(socket) && sharingSockets.size === 0) {
      console.log('[vision] Companion yang share screen terputus -> share dianggap berhenti');
      streamingVisionManager.setScreenShareStatus(false);
    }
  });

  const history = []; // histori percakapan per-koneksi
  const send = (obj) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
  };

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
    state: conversationState,
  });

  // Kirim status awal vision streaming ke client yang baru terhubung
  sendVisionInit(socket);

  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // 0. Sinyal selesai playback dari client untuk turn-taking
    if (msg.type === 'playback_finished') {
      console.log(`[turn] Client playback_finished received (current state: ${conversationState})`);
      setConversationState('idle');
      return;
    }

    // 1. Continuous frame capture dari screen share di companion utama
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
      if (conversationState !== 'idle') {
        console.log(`[spontaneous] Diabaikan: percakapan sedang "${conversationState}"`);
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
      broadcastToAll({ type: 'emotion', emotion });

      if (isVoiceConfigured()) {
        try {
          let sentFirstChunk = false;
          for await (const chunk of generateSpeech(text, emotion)) {
            if (!sentFirstChunk) {
              sentFirstChunk = true;
              setConversationState('speaking');
            }
            broadcastToAll({
              type: 'audio_output',
              data: chunk.toString('base64'),
              format: 'mp3',
            });
          }
          broadcastToAll({ type: 'audio_end' });
          if (!sentFirstChunk) {
            setConversationState('idle');
          }
        } catch (err) {
          console.error('[tts:spontaneous] Gagal TTS komentar spontan:', err.message);
          setConversationState('idle');
        }
      }

      broadcastToAll({ type: 'amika_replied', text, emotion });
      return;
    }

    if (msg.type !== 'audio_input' && msg.type !== 'text_input') return;
    const isTyped = msg.type === 'text_input';

    // Turn-taking: jika bukan IDLE (sedang PROCESSING atau SPEAKING), abaikan input baru
    if (conversationState !== 'idle') {
      console.log(`[turn] Ignored ${msg.type}: current state is "${conversationState}"`);
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

    try {
      let buf = null;
      if (!isTyped) {
        buf = Buffer.from(data, 'base64');
        if (buf.length < 512) return;
      }

      // Input valid mulai diproses -> masuk state PROCESSING
      setConversationState('processing');

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
        text = await transcribeAudio(buf, `audio.${extFromMime(mime)}`);
        tSttEnd = performance.now();
        console.log(`[timing] STT: ${ms(tSttStart, tSttEnd)}ms (t+${ms(tPipe, tSttEnd)})`);
      }

      // Filter noise: transkripsi kosong / terlalu pendek -> skip seluruh
      // pipeline (jangan buang API call untuk napas/dengkuran/suara latar).
      // ponytail: kalau Whisper masih halusinasi ("terima kasih") pas hening,
      // ganti sttTranscribe ke verbose_json & saring no_speech_prob.
      if (!isTyped && text.length < 3) {
        console.log('[stt] skip, noise/pendek:', JSON.stringify(text));
        setConversationState('idle');
        return;
      }
      send({ type: 'user_said', text });
      markConversationActivity();

      // 2) Vision — periksa intent & pisahkan source (screen vs webcam)
      let vision = null;
      if (detectVisionIntent(text)) {
        const route = resolveVisionSource(text, {
          hasCamera: Boolean(image),
          hasScreen: Boolean(screenImage),
        });
        const { source, requested, available } = route;
        console.log(
          `[vision] intent: diminta=${requested ?? 'ambigu'}, dipakai=${source ?? 'none'},` +
            ` kamera aktif=${Boolean(image)}, layar aktif=${Boolean(screenImage)}`,
        );

        if (source === null) {
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
          const frame = source === 'screen' ? screenImage : image;
          const label = source === 'screen' ? 'Layar' : 'Kamera';
          try {
            const tVisStart = performance.now();
            let desc;

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

            // Fallback one-shot: buffer kosong atau sumber = kamera
            if (!desc) {
              desc = await describeFrame(frame, source);
            }

            console.log(`[timing] vision (${source}): ${ms(tVisStart)}ms (t+${ms(tPipe)})`);
            send({ type: 'vision', text: `[${label}] ${desc}` });
            // Konteks eksplisit: vision BERHASIL, jawab berdasarkan ini.
            vision = `(${label} aktif & berhasil dilihat) ${desc}`;
          } catch (err) {
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
      const ttsOn = isVoiceConfigured();
      let ttsChain = Promise.resolve();

      // Milestone timing (di-set sekali; 0 = belum kejadian).
      let tLlmFirstToken = 0;
      let tLlmFirstSentence = 0;
      let tTtsStart = 0;
      let tTtsFirstChunk = 0;
      let tFirstAudioOut = 0;
      let sentenceIdx = 0;
      let sentFirstAudio = false;

      let replyEmotion = 'netral';

      async function speak(sentence, idx) {
        try {
          const isFirst = idx === 0;
          if (isFirst) tTtsStart = performance.now();
          for await (const chunk of generateSpeech(sentence, replyEmotion)) {
            if (!sentFirstAudio) {
              sentFirstAudio = true;
              setConversationState('speaking');
            }
            if (isFirst && !tTtsFirstChunk) tTtsFirstChunk = performance.now();
            send({
              type: 'audio_output',
              data: chunk.toString('base64'),
              format: 'mp3',
            });
            if (isFirst && !tFirstAudioOut) {
              tFirstAudioOut = performance.now();
              // Ringkasan satu baris: audio_input -> audio pertama terdengar.
              console.log(
                `[timing] STT selesai: ${ms(tPipe, tSttEnd)}ms` +
                  ` | LLM first token: ${ms(tPipe, tLlmFirstToken)}ms` +
                  ` | LLM first sentence: ${ms(tPipe, tLlmFirstSentence)}ms` +
                  ` | TTS req->first chunk: ${ms(tTtsStart, tTtsFirstChunk)}ms` +
                  ` | total to first audio: ${ms(tPipe, tFirstAudioOut)}ms`,
              );
            }
          }
          send({ type: 'audio_end' }); // penanda satu kalimat mp3 selesai
        } catch (err) {
          // TTS gagal -> log & skip, jangan macetkan percakapan.
          console.error('[tts] gagal, skip kalimat:', err.message);
        }
      }

      const tLlmStart = performance.now(); // = saat request LLM dimulai
      for await (const ev of generateReplyStream(history, text, vision)) {
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
          if (ttsOn) {
            const idx = sentenceIdx++;
            ttsChain = ttsChain.then(() => speak(ev.text, idx));
          }
        }
      }
      await ttsChain; // pastikan semua audio ke-flush sebelum turn ditutup
      send({ type: 'amika_replied', text: full, emotion: replyEmotion });

      // Jika tidak ada audio TTS yang terkirim (misal TTS nonaktif atau gagal),
      // kembalikan state ke IDLE karena tidak akan ada event playback_finished dari client
      if (!sentFirstAudio) {
        console.log('[turn] Tidak ada audio TTS yang dikirim; mereset state ke idle');
        setConversationState('idle');
      }

      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: full });
      if (history.length > HISTORY_MESSAGE_LIMIT) {
        history.splice(0, history.length - HISTORY_MESSAGE_LIMIT);
      }
    } catch (err) {
      console.error('[stt] error:', err);
      setConversationState('idle');
      send({ type: 'error', message: err.message ?? 'STT gagal.' });
    }
  });
});

const PORT = process.env.PORT || 8787;
server.listen(PORT, () => {
  console.log(
    `[server] 9inference + STT proxy jalan di http://localhost:${PORT} (ws: /ws)`,
  );
  void warmUpModels();
});
