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
  detectVisionSource,
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

wss.on('connection', (socket) => {
  companionSessionOpened();
  socket.once('close', companionSessionClosed);

  const history = []; // histori percakapan per-koneksi
  const send = (obj) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
  };

  const broadcastToAll = (obj) => {
    const json = JSON.stringify(obj);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(json);
      }
    }
  };

  streamingVisionManager.setBroadcaster(broadcastToAll);
  streamingVisionManager.setHistoryRef(history);

  // Kirim status awal vision streaming ke client yang baru terhubung
  send({
    type: 'init_vision_state',
    active: streamingVisionManager.isScreenShareActive,
    settings: streamingVisionManager.settings,
    stats: streamingVisionManager.stats,
    bufferCount: streamingVisionManager.buffer.length,
  });

  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // 1. Continuous frame capture dari screen share di companion utama
    if (msg.type === 'continuous_frame') {
      streamingVisionManager.handleContinuousFrame(msg.image);
      return;
    }

    // 2. Status screen share aktif / nonaktif dari companion utama
    if (msg.type === 'screen_share_status') {
      streamingVisionManager.setScreenShareStatus(msg.active);
      return;
    }

    // 3. Update konfigurasi vision (interval, maxTokens, buffer) dari Vision Monitor
    if (msg.type === 'update_vision_config') {
      streamingVisionManager.updateSettings(msg.settings || msg);
      return;
    }

    // 4. Handler untuk komentar spontan eksternal (jika ada)
    if (msg.type === 'spontaneous_vision_comment') {
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
          for await (const chunk of generateSpeech(text, emotion)) {
            broadcastToAll({
              type: 'audio_output',
              data: chunk.toString('base64'),
              format: 'mp3',
            });
          }
          broadcastToAll({ type: 'audio_end' });
        } catch (err) {
          console.error('[tts:spontaneous] Gagal TTS komentar spontan:', err.message);
        }
      }

      broadcastToAll({ type: 'amika_replied', text, emotion });
      return;
    }

    if (msg.type !== 'audio_input') return;

    const { data, mime, image, screenImage, durationMs } = msg;

    // Guard: audio kosong / terlalu pendek -> skip diam-diam. VAD kadang kirim
    // blip pendek; jangan spam error di log hands-free.
    if (!data || (typeof durationMs === 'number' && durationMs < 400)) return;

    try {
      const buf = Buffer.from(data, 'base64');
      if (buf.length < 512) return;

      // --- timing diagnostics (ponytail: hapus blok [timing] kalau tak perlu) --
      // Semua durasi relatif ke saat audio_input valid diterima (tPipe).
      const tPipe = performance.now();
      const ms = (a, b) => Math.round((b ?? performance.now()) - a);

      // 1) STT (Groq Whisper)
      const tSttStart = performance.now();
      const text = await transcribeAudio(buf, `audio.${extFromMime(mime)}`);
      const tSttEnd = performance.now();
      console.log(`[timing] STT: ${ms(tSttStart, tSttEnd)}ms (t+${ms(tPipe, tSttEnd)})`);

      // Filter noise: transkripsi kosong / terlalu pendek -> skip seluruh
      // pipeline (jangan buang API call untuk napas/dengkuran/suara latar).
      // ponytail: kalau Whisper masih halusinasi ("terima kasih") pas hening,
      // ganti sttTranscribe ke verbose_json & saring no_speech_prob.
      if (text.length < 3) {
        console.log('[stt] skip, noise/pendek:', JSON.stringify(text));
        return;
      }
      send({ type: 'user_said', text });
      markConversationActivity();

      // 2) Vision — periksa intent & pisahkan source (screen vs webcam)
      let vision = null;
      if (detectVisionIntent(text)) {
        const source = detectVisionSource(text);
        const isStreamActive = source === 'screen' ? Boolean(screenImage) : Boolean(image);
        console.log(`[vision] intent terdeteksi: source=${source}, stream aktif=${isStreamActive}`);

        if (source === 'screen') {
          if (screenImage) {
            try {
              const tVisStart = performance.now();
              vision = await describeFrame(screenImage, 'screen');
              console.log(`[timing] vision (screen): ${ms(tVisStart)}ms (t+${ms(tPipe)})`);
              send({ type: 'vision', text: `[Layar] ${vision}` });
            } catch (err) {
              console.error('[vision:screen] error:', err);
              send({ type: 'error', message: `Vision layar gagal: ${err.message}` });
            }
          } else {
            // Screen share TIDAK aktif -> jangan fallback ke webcam diam-diam!
            vision = 'screen belum di-share. User meminta kamu melihat layar/game/aplikasinya, tetapi user belum mengaktifkan Share Screen.';
            send({ type: 'vision', text: `⚠️ Layar belum di-share. Aktifkan tombol "Share Screen" terlebih dahulu.` });
          }
        } else {
          // source === 'webcam'
          if (image) {
            try {
              const tVisStart = performance.now();
              vision = await describeFrame(image, 'webcam');
              console.log(`[timing] vision (webcam): ${ms(tVisStart)}ms (t+${ms(tPipe)})`);
              send({ type: 'vision', text: `[Kamera] ${vision}` });
            } catch (err) {
              console.error('[vision:webcam] error:', err);
              send({ type: 'error', message: `Vision kamera gagal: ${err.message}` });
            }
          } else {
            vision = 'kamera belum aktif.';
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

      let replyEmotion = 'netral';

      async function speak(sentence, idx) {
        try {
          const isFirst = idx === 0;
          if (isFirst) tTtsStart = performance.now();
          for await (const chunk of generateSpeech(sentence, replyEmotion)) {
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

      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: full });
      if (history.length > HISTORY_MESSAGE_LIMIT) {
        history.splice(0, history.length - HISTORY_MESSAGE_LIMIT);
      }
    } catch (err) {
      console.error('[stt] error:', err);
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
