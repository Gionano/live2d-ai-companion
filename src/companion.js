// ---------------------------------------------------------------------------
// companion.js  (browser-side) — HANDS-FREE
// Mic selalu mendengar. VAD sederhana pakai Web Audio: deteksi mulai bicara
// (volume naik) & selesai bicara (hening ~SILENCE_MS), potong segmen, kirim ke
// server via WS. Server balas: user_said / amika_replied (untuk log) +
// audio_output (suara TTS -> lip-sync). Mic otomatis di-pause saat amika bicara
// biar tak "dengar dirinya sendiri" dan looping.
//
// Butuh SATU interaksi (klik/ketik) di halaman untuk unlock AudioContext + izin
// mic — aturan autoplay/permission browser, bukan tombol rekam.
//
// API key TIDAK ada di sini — semua lewat server (WS /ws).
// ---------------------------------------------------------------------------
const logEl = document.getElementById('chat-log');
const video = document.getElementById('webcam');
const canvas = document.getElementById('capture-canvas');
const micStatusEl = document.getElementById('mic-status');
const micLabelEl = document.getElementById('mic-label');
const overlaySubtitleEl = document.getElementById('overlay-subtitle');
import { tuning } from './tuningConfig.js';
import { SpeechPlayback, TurnState } from './speechPlayback.js';
import { handleBrowserSelfieModal } from './browserSelfieModal.js';

const isOverlay = new URLSearchParams(window.location.search).get('mode') === 'overlay';
// Wait for the main-process mute snapshot before opening the desktop microphone.
let isMicMutedByDesktop = Boolean(window.desktopBridge);
let micMuteRevision = -1;
let activeMuteShortcut = null;
let overlaySubtitleHideDelayMs = 6500;
let overlaySubtitleTimer = null;

if (window.desktopBridge?.getAppInfo) {
  window.desktopBridge
    .getAppInfo()
    .then((info) => {
      if (info && typeof info.subtitleHideDelayMs === 'number' && info.subtitleHideDelayMs > 0) {
        overlaySubtitleHideDelayMs = info.subtitleHideDelayMs;
      }
    })
    .catch(() => {});
}

function showOverlaySubtitle(text) {
  if (!isOverlay || !overlaySubtitleEl || !text) return;
  overlaySubtitleEl.textContent = text;
  overlaySubtitleEl.classList.add('visible');
  if (overlaySubtitleTimer) clearTimeout(overlaySubtitleTimer);
  overlaySubtitleTimer = setTimeout(() => {
    overlaySubtitleEl.classList.remove('visible');
  }, overlaySubtitleHideDelayMs);
}

function isMobile() {
  if (isOverlay) return false;
  return window.innerWidth <= 768;
}

function log(text, cls = '') {
  const div = document.createElement('div');
  div.className = `log-line ${cls}`.trim();
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight; // auto-scroll ke bawah
  return div;
}

function setMicStatus(live, label, stateClass = '') {
  if (isMicMutedByDesktop) {
    live = false;
    label = '🔇 Mikrofon di-mute';
    stateClass = '';
  }
  micStatusEl.classList.remove('live', 'processing', 'speaking', 'recording');
  if (stateClass) {
    micStatusEl.classList.add(stateClass);
  } else if (live) {
    micStatusEl.classList.add('live');
  }
  micLabelEl.textContent = label;
}

let currentFacingMode = 'user';

async function initWebcam(facingMode = 'user') {
  try {
    // Hentikan stream lama jika ada
    if (video.srcObject) {
      video.srcObject.getTracks().forEach(track => track.stop());
    }
    
    video.classList.add('camera-loading');
    
    const stream = await navigator.mediaDevices.getUserMedia({ 
      video: { facingMode: { ideal: facingMode } } 
    });
    
    video.srcObject = stream;
    await video.play();
    currentFacingMode = facingMode; // Simpan mode yang aktif jika sukses
  } catch (err) {
    log(`Webcam gagal: ${err.message}`, 'error');
    // Fallback: coba kembali ke mode sebelumnya jika pergantian gagal
    if (facingMode !== currentFacingMode) {
      log(`Mencoba kembali ke kamera sebelumnya...`, 'error');
      initWebcam(currentFacingMode);
    }
  } finally {
    video.classList.remove('camera-loading');
  }
}

async function toggleCamera() {
  const newMode = currentFacingMode === 'user' ? 'environment' : 'user';
  await initWebcam(newMode);
}

// Pasang event listener ke tombol switch
const switchBtn = document.getElementById('camera-switch-btn');
if (switchBtn) {
  switchBtn.addEventListener('click', toggleCamera);
}

let screenStream = null;
let continuousCaptureTimer = null;
let captureIntervalSeconds = 1; // default 1 frame per detik

const screenVideo = document.createElement('video');
screenVideo.autoplay = true;
screenVideo.playsInline = true;
screenVideo.muted = true;

const screenShareBtn = document.getElementById('screen-share-btn');

// ---------------------------------------------------------------------------
// Desktop Companion (Electron): capture layar langsung lewat desktopBridge,
// TANPA popup getDisplayMedia. Di browser biasa/mobile jalur lama tidak berubah.
// "Aktif" di sini = toggle Screen Vision di tray.
// ---------------------------------------------------------------------------
const isDesktopCapture = typeof window.desktopBridge?.captureScreen === 'function';
let desktopScreenVision = false; // disinkronkan dari main process (tray)
let desktopCaptureInFlight = false;

/** Apakah sumber layar sedang aktif (Share Screen di browser / Screen Vision di Electron). */
function isScreenActive() {
  return isDesktopCapture ? desktopScreenVision : Boolean(screenStream);
}

/** Metadata tambahan untuk audio_input/text_input agar backend tahu klien desktop. */
function desktopInputMeta() {
  return isDesktopCapture ? { desktop: true, screenVisionOn: desktopScreenVision } : {};
}

/** Ambil satu frame lewat desktopBridge; retry sekali jika kena rate limit main process. */
async function captureDesktopFrame() {
  const opts = { maxWidth: tuning.get('vision.screenMaxWidth') ?? 1280 };
  try {
    return await window.desktopBridge.captureScreen(opts);
  } catch (err) {
    if (err?.code === 'RATE_LIMITED') {
      await new Promise((r) => setTimeout(r, (err.retryAfterMs || 500) + 30));
      return window.desktopBridge.captureScreen(opts);
    }
    throw err;
  }
}

/** Beritahu backend status sumber layar (dipakai untuk continuous capture). */
function syncDesktopScreenStatus() {
  if (!isDesktopCapture) return;
  if (!desktopScreenVision) stopContinuousCapture(); // jangan capture saat toggle off
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'screen_share_status', active: desktopScreenVision }));
  }
}

function applyDesktopScreenVision(enabled) {
  const next = Boolean(enabled);
  if (next === desktopScreenVision) return;
  desktopScreenVision = next;
  console.log(`[ScreenVision] Toggle tray: ${next ? 'ON' : 'OFF'}`);
  syncDesktopScreenStatus();
}

if (isDesktopCapture) {
  window.desktopBridge
    .getOverlayState?.()
    .then((state) => {
      if (state && typeof state.screenVision === 'boolean') {
        applyDesktopScreenVision(state.screenVision);
      }
    })
    .catch(() => {});
  window.desktopBridge.onOverlayStateChanged?.((state) => {
    if (state && typeof state.screenVision === 'boolean') {
      applyDesktopScreenVision(state.screenVision);
    }
  });
}

function startContinuousCapture() {
  stopContinuousCapture();
  console.log(`[ScreenShare] Memulai capture loop kontinu: 1 frame setiap ${captureIntervalSeconds} detik`);
  
  // Kirim frame pertama langsung
  sendContinuousFrame();

  continuousCaptureTimer = setInterval(() => {
    sendContinuousFrame();
  }, captureIntervalSeconds * 1000);
}

function stopContinuousCapture() {
  if (continuousCaptureTimer) {
    clearInterval(continuousCaptureTimer);
    continuousCaptureTimer = null;
  }
}

async function sendDesktopContinuousFrame() {
  if (!desktopScreenVision || desktopCaptureInFlight) return;
  desktopCaptureInFlight = true;
  try {
    const shot = await captureDesktopFrame();
    // Toggle bisa dimatikan selama capture berjalan -> buang frame
    if (!desktopScreenVision) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'continuous_frame',
        image: `data:image/jpeg;base64,${shot.base64}`,
        timestamp: Date.now(),
      }));
    }
  } catch (err) {
    if (err?.code !== 'RATE_LIMITED' && err?.code !== 'SCREEN_VISION_DISABLED') {
      console.warn('[ScreenVision] Capture kontinu gagal:', err?.code, err?.message);
    }
  } finally {
    desktopCaptureInFlight = false;
  }
}

function sendContinuousFrame() {
  if (isDesktopCapture) {
    void sendDesktopContinuousFrame();
    return;
  }
  if (!screenStream || !screenVideo.videoWidth) return;
  const frame = captureScreenFrame();
  if (frame && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'continuous_frame',
      image: frame,
      timestamp: Date.now(),
    }));
  }
}

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' },
      audio: false,
    });
    screenVideo.srcObject = screenStream;
    await screenVideo.play();

    if (screenShareBtn) {
      screenShareBtn.classList.add('active');
      screenShareBtn.textContent = '🖥️ Screen On';
    }
    log('🖥️ Share screen aktif.', 'muted');

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'screen_share_status', active: true }));
    }

    // Continuous capture TIDAK dimulai di sini — dikendalikan oleh backend
    // via pesan 'continuous_capture_control' (hanya aktif jika Vision Monitor
    // terhubung).

    screenStream.getVideoTracks()[0].onended = () => {
      stopScreenShare();
    };
  } catch (err) {
    console.warn('[ScreenShare] Dibatalkan atau gagal:', err.message);
  }
}

function stopScreenShare() {
  stopContinuousCapture();

  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }
  screenVideo.srcObject = null;

  if (screenShareBtn) {
    screenShareBtn.classList.remove('active');
    screenShareBtn.textContent = '🖥️ Share Screen';
  }
  log('🖥️ Share screen dimatikan.', 'muted');

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'screen_share_status', active: false }));
  }
}

if (screenShareBtn) {
  screenShareBtn.addEventListener('click', () => {
    if (isDesktopCapture) {
      // Electron: tombol hanya mengubah toggle Screen Vision (tanpa popup Share Screen)
      window.desktopBridge.setScreenVision?.(!desktopScreenVision);
      return;
    }
    if (screenStream) {
      stopScreenShare();
    } else {
      startScreenShare();
    }
  });
}

function captureWebcamFrame() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(video, 0, 0, w, h);
  const q = tuning.get('vision.webcamJpegQuality') ?? 0.7;
  return canvas.toDataURL('image/jpeg', q);
}

function captureScreenFrame() {
  if (!screenStream || !screenVideo.videoWidth || !screenVideo.videoHeight) {
    return null;
  }
  const maxW = tuning.get('vision.screenMaxWidth') ?? 1280;
  const w = Math.min(screenVideo.videoWidth, maxW);
  const h = Math.round((w / screenVideo.videoWidth) * screenVideo.videoHeight);
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(screenVideo, 0, 0, w, h);
  const q = tuning.get('vision.screenJpegQuality') ?? 0.75;
  return canvas.toDataURL('image/jpeg', q);
}

function captureFrame() {
  return captureWebcamFrame();
}

// ---------------------------------------------------------------------------
// TTS playback + lip-sync (Web Audio API)
// Audio dari server datang per-kalimat: banyak {audio_output} lalu {audio_end}.
// Tiap kalimat digabung jadi satu mp3 utuh, di-decode, dijadwalkan berurutan
// (playCursor) supaya nyambung. Lewat AnalyserNode biar amplitudo-nya dibaca
// main.js buat gerak mulut avatar.
// ---------------------------------------------------------------------------
let audioCtx = null;
let analyser = null;
let freqData = null;
let playCursor = 0; // waktu AudioContext untuk kalimat berikutnya
let pendingEmotion = 'netral';
let scheduledEmotionEnd = 0;

let currentConversationState = 'idle'; // 'idle' | 'processing' | 'speaking'
const turnState = new TurnState();
const activeAudioSources = new Set();
const speechPlayback = new SpeechPlayback({
  playAudio: (chunks, emotion, options) => playSentenceAudio(chunks.map(b64ToUint8), emotion, options),
  onFinished: (speechId) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'playback_finished', speechId }));
    }
  },
  onChange: () => updateUiForState(playbackState()),
});

function playbackState() {
  return turnState.playbackState(speechPlayback);
}

function updateUiForState(state, isPttRecording = false) {
  const chatInputEl = document.getElementById('chat-input');
  const chatSendEl = document.getElementById('chat-send');
  if (chatInputEl && chatSendEl) {
    const busy = state !== 'idle' || speechPlayback.busy;
    const wasDisabled = chatInputEl.disabled;
    chatInputEl.disabled = busy;
    chatSendEl.disabled = busy;
    chatInputEl.placeholder = busy ? 'Amika sedang merespons…' : 'Ketik pesan…';
    if (wasDisabled && !busy && !isMobile()) chatInputEl.focus();
  }
  const mobile = isMobile();

  if (mobile) {
    if (state === 'idle') {
      if (isPttRecording) {
        setMicStatus(true, '● Merekam…', 'recording');
      } else {
        setMicStatus(true, 'Diam');
      }
    } else if (state === 'processing') {
      setMicStatus(false, 'Amika sedang berpikir…', 'processing');
    } else if (state === 'speaking') {
      setMicStatus(false, 'Amika sedang bicara…', 'speaking');
    }
  } else {
    // Desktop layout
    if (state === 'idle') {
      if (speaking) {
        setMicStatus(true, '● Merekam…', 'recording');
      } else {
        setMicStatus(true, 'Mendengarkan…');
      }
    } else if (state === 'processing') {
      setMicStatus(false, 'Amika sedang berpikir…', 'processing');
    } else if (state === 'speaking') {
      setMicStatus(false, 'Amika sedang bicara…', 'speaking');
    }
  }
}

function ensureAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.6;
  freqData = new Uint8Array(analyser.frequencyBinCount);
  analyser.connect(audioCtx.destination);
  window.__waifuLipSync = sampleMouth; // jembatan ke main.js (VRM)
  window.__waifuAudioTime = () => audioCtx.currentTime;
  window.__waifuIsSpeaking = () =>
    audioCtx.currentTime < Math.max(playCursor, scheduledEmotionEnd) + (tuning.get('vad.speakTail') ?? 0.15);
}

// Amplitudo audio yang lagi diputar -> 0..1 buat buka mulut.
function sampleMouth() {
  if (!analyser) return 0;
  analyser.getByteFrequencyData(freqData);
  let sum = 0;
  for (let i = 0; i < freqData.length; i++) sum += freqData[i];
  const avg = sum / freqData.length / 255;
  const gain = tuning.get('talking.lipSyncGain') ?? 1.8;
  return Math.min(1, avg * gain);
}

// Debug audio sample: a short speech-like oscillator pattern routed through the
// same AnalyserNode and playback state as Fish Audio.
window.__waifuTestLipSync = async () => {
  ensureAudio();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const now = audioCtx.currentTime;
  const oscillator = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  oscillator.type = 'triangle';
  oscillator.frequency.setValueAtTime(170, now);
  oscillator.frequency.linearRampToValueAtTime(235, now + 1.2);
  oscillator.frequency.linearRampToValueAtTime(145, now + 2.7);
  gain.gain.setValueAtTime(0.0001, now);
  for (let i = 0; i < 12; i++) {
    const at = now + i * 0.23;
    gain.gain.linearRampToValueAtTime(0.11 + (i % 3) * 0.025, at + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.008, at + 0.19);
  }
  oscillator.connect(gain).connect(analyser);
  oscillator.start(now);
  oscillator.stop(now + 2.8);
  playCursor = Math.max(playCursor, now + 2.8);
};

function b64ToUint8(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

async function playSentenceAudio(chunks, emotion = 'netral', { signal } = {}) {
  if (signal?.aborted) return;
  ensureAudio();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (signal?.aborted) return;

  // Gabung chunk kalimat ini jadi satu mp3 utuh (decodeAudioData butuh file
  // lengkap, bukan potongan).
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }

  let buffer;
  try {
    buffer = await audioCtx.decodeAudioData(merged.buffer);
  } catch (err) {
    log(`Audio decode gagal: ${err.message}`, 'error');
    return;
  }

  if (signal?.aborted) return;
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(analyser);
  const startAt = Math.max(audioCtx.currentTime, playCursor);
  const endAt = startAt + buffer.duration;
  const onAbort = () => {
    src.stop();
    playCursor = audioCtx.currentTime;
    scheduledEmotionEnd = audioCtx.currentTime;
  };
  const played = new Promise((resolve, reject) => {
    activeAudioSources.add(src);
    src.onended = () => {
      activeAudioSources.delete(src);
      resolve();
    };
    try {
      src.start(startAt);
    } catch (err) {
      activeAudioSources.delete(src);
      reject(err);
    }
  });
  playCursor = endAt; // dipakai VAD untuk tahu amika masih bicara
  scheduledEmotionEnd = Math.max(scheduledEmotionEnd, endAt);
  window.dispatchEvent(new CustomEvent('waifu-emotion-cue', {
    detail: { emotion, startAt, endAt },
  }));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    await played;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// WebSocket: terima user_said / amika_replied (log) + audio_output (suara).
// ---------------------------------------------------------------------------
let ws = null;
let desktopSelfieEnabled = true;

function sendSelfieMessage(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

if (window.desktopBridge?.notifySelfieEvent) {
  window.desktopBridge.onSelfieCommand?.(sendSelfieMessage);
  let liveSelfieSettingsReceived = false;
  const applySelfieSettings = (state) => {
    if (typeof state?.selfieEnabled !== 'boolean') return;
    if (desktopSelfieEnabled === state.selfieEnabled) return;
    desktopSelfieEnabled = state.selfieEnabled;
    sendSelfieMessage({ type: 'selfie_feature', enabled: desktopSelfieEnabled });
  };
  window.desktopBridge.onOverlayStateChanged?.((state) => {
    if (typeof state?.selfieEnabled !== 'boolean') return;
    liveSelfieSettingsReceived = true;
    applySelfieSettings(state);
  });
  window.desktopBridge.getOverlayState?.().then((state) => {
    if (!liveSelfieSettingsReceived) applySelfieSettings(state);
  }).catch(() => {});
}

function connectWS() {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProtocol}//${location.host}/ws`);
  ws.addEventListener('open', () => {
    if (window.desktopBridge) {
      ws.send(JSON.stringify({ type: 'mic_mute', muted: isMicMutedByDesktop }));
    }
    if (window.desktopBridge?.notifySelfieEvent) {
      sendSelfieMessage({ type: 'selfie_feature', enabled: desktopSelfieEnabled });
    }
    if (isScreenActive()) {
      ws.send(JSON.stringify({ type: 'screen_share_status', active: true }));
    }
  });
  ws.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'selfie_feature') {
      return;
    }
    if (['selfie_started', 'selfie_progress', 'selfie_ready', 'selfie_failed', 'selfie_cancelled', 'selfie_snapshot'].includes(msg.type)) {
      if (window.desktopBridge?.notifySelfieEvent) {
        window.desktopBridge.notifySelfieEvent(msg);
      } else {
        handleBrowserSelfieModal(msg, (jobId) => sendSelfieMessage({ type: 'selfie_cancel', jobId }));
      }
      return;
    }
    const speechEvent = ['speech_start', 'speech_end', 'stop_speech', 'audio_output', 'audio_end'].includes(msg.type);
    if (!speechEvent && !turnState.handle(msg)) return;
    switch (msg.type) {
      case 'conversation_state':
      case 'turn_cancelled':
      case 'input_rejected':
        currentConversationState = turnState.state;
        updateUiForState(playbackState());
        break;
      case 'user_said':
        log(`Kamu: ${msg.text}`, 'user');
        break;
      case 'vision':
        log(`👁️ ${msg.text}`, 'vision');
        break;
      case 'amika_replied':
        log(`Amika: ${msg.text}`, 'assistant');
        showOverlaySubtitle(msg.text);
        break;
      case 'emotion':
        speechPlayback.handle(msg);
        pendingEmotion = msg.emotion || 'netral';
        window.dispatchEvent(new CustomEvent('waifu-emotion-cue', {
          detail: { emotion: pendingEmotion },
        }));
        break;
      case 'speech_start':
      case 'speech_end':
      case 'stop_speech':
      case 'audio_output':
      case 'audio_end':
        speechPlayback.handle(msg);
        if (msg.type === 'audio_end') {
          window.dispatchEvent(new CustomEvent('waifu-sentence-break'));
        }
        break;
      case 'request_screen_capture': {
        // Backend meminta satu frame layar (intent "lihat layar"). Hanya relevan di Electron.
        const requestId = msg.requestId;
        const reply = (payload) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'screen_frame', requestId, ...payload }));
          }
        };
        if (!isDesktopCapture) {
          reply({ error: { code: 'NOT_SUPPORTED', message: 'Capture layar langsung tidak tersedia.' } });
          break;
        }
        if (!desktopScreenVision) {
          reply({
            error: {
              code: 'SCREEN_VISION_DISABLED',
              message: 'Screen Vision sedang dimatikan di tray.',
              spokenMessage: 'Fitur lihat layar sedang dimatikan di pengaturan tray.',
            },
          });
          break;
        }
        captureDesktopFrame()
          .then((shot) => {
            reply({
              base64: shot.base64,
              mimeType: shot.mimeType || 'image/jpeg',
              width: shot.width,
              height: shot.height,
              displayId: shot.displayId,
            });
          })
          .catch((err) => {
            console.warn('[ScreenVision] Capture on-demand gagal:', err?.code, err?.message);
            reply({
              error: {
                code: err?.code || 'CAPTURE_ERROR',
                message: err?.message || 'Gagal capture layar.',
                spokenMessage: err?.spokenMessage || 'layarnya tidak bisa kulihat, coba mode borderless',
              },
            });
          });
        break;
      }
      case 'continuous_capture_control': {
        // Backend mengendalikan continuous capture berdasarkan status Vision Monitor.
        if (msg.enabled && isScreenActive()) {
          console.log('[ScreenShare] Backend meminta mulai continuous capture');
          startContinuousCapture();
          if (screenShareBtn) {
            screenShareBtn.textContent = `🖥️ Screen On (${captureIntervalSeconds}s)`;
          }
        } else {
          console.log('[ScreenShare] Backend meminta stop continuous capture');
          stopContinuousCapture();
          if (screenShareBtn && isScreenActive()) {
            screenShareBtn.textContent = '🖥️ Screen On';
          }
        }
        break;
      }
      case 'config_updated':
      case 'init_vision_state': {
        if (msg.settings && typeof msg.settings.intervalSeconds === 'number') {
          const newInterval = msg.settings.intervalSeconds;
          if (newInterval !== captureIntervalSeconds) {
            captureIntervalSeconds = newInterval;
            console.log(`[ScreenShare] Interval capture diperbarui ke ${captureIntervalSeconds}s`);
            // Restart loop hanya jika continuous capture sedang jalan
            if (continuousCaptureTimer && isScreenActive()) {
              if (screenShareBtn) {
                screenShareBtn.textContent = `🖥️ Screen On (${captureIntervalSeconds}s)`;
              }
              startContinuousCapture();
            }
          }
        }
        break;
      }
      case 'error':
        log(`⚠️ ${msg.message}`, 'error');
        break;
    }
  });
  ws.addEventListener('close', () => {
    currentConversationState = 'idle';
    turnState.handle({ type: 'conversation_state', state: 'idle' });
    speechPlayback.reset();
    for (const source of activeAudioSources) source.stop();
    updateUiForState('idle');
    setTimeout(connectWS, 1500);
  }); // sambung ulang
  ws.addEventListener('error', () => ws.close());
}
connectWS();

// ---------------------------------------------------------------------------
// Mobile Push-to-Talk (Press-and-Hold)
// Khusus layout mobile (<=768px): Continuous VAD digantikan tombol tekan-tahan.
// ---------------------------------------------------------------------------
let pttRecorder = null;
let pttChunks = [];
let pttStartAt = 0;
let isPttRecording = false;

async function startPttRecording() {
  if (playbackState() !== 'idle') {
    console.log('[ptt] Diabaikan: status percakapan saat ini adalah', currentConversationState);
    return;
  }
  if (isPttRecording || isMicMutedByDesktop) return;

  try {
    ensureAudio();
    if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
    if (!micStream) {
      await startListening();
    }
  } catch (err) {
    log(`Mic gagal: ${err.message}`, 'error');
    return;
  }

  if (isMicMutedByDesktop || !micStream || isPttRecording || playbackState() !== 'idle') return;
  const revision = micMuteRevision;
  isPttRecording = true;
  pttChunks = [];
  pttStartAt = performance.now();

  try {
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    pttRecorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
    pttRecorder.ondataavailable = (ev) => {
      if (ev.data.size) pttChunks.push(ev.data);
    };
    pttRecorder.onstop = async () => {
      const dur = performance.now() - pttStartAt;
      const type = (pttRecorder && pttRecorder.mimeType) || 'audio/webm';
      const blob = new Blob(pttChunks, { type });
      pttChunks = [];
      pttRecorder = null;
      if (isMicMutedByDesktop || revision !== micMuteRevision) return;

      if (dur < 400 || blob.size < 512) {
        console.log('[ptt] Audio terlalu pendek / noise, dibatalkan:', dur);
        updateUiForState(playbackState());
        return;
      }

      // Langsung perbarui UI ke state processing
      updateUiForState('processing');

      const data = await new Promise((res) => {
        const r = new FileReader();
        r.onloadend = () => res(String(r.result).split(',')[1]);
        r.readAsDataURL(blob);
      });
      if (isMicMutedByDesktop || revision !== micMuteRevision) {
        updateUiForState(playbackState());
        return;
      }
      const image = captureWebcamFrame();
      const screenImage = captureScreenFrame();

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'audio_input',
            data,
            mime: blob.type,
            image,
            screenImage,
            ...desktopInputMeta(),
            durationMs: dur,
          }),
        );
      }
    };
    pttRecorder.start();
    updateUiForState('idle', true);
  } catch (err) {
    isPttRecording = false;
    pttRecorder = null;
    console.error('[ptt] Gagal start MediaRecorder:', err);
    updateUiForState(playbackState());
  }
}

function stopPttRecording() {
  if (!isPttRecording) return;
  isPttRecording = false;
  if (pttRecorder && pttRecorder.state === 'recording') {
    pttRecorder.stop();
  } else {
    updateUiForState(playbackState());
  }
}

function abortPttRecording() {
  if (!isPttRecording && !pttRecorder) return;
  isPttRecording = false;
  if (pttRecorder) {
    pttRecorder.ondataavailable = null;
    pttRecorder.onstop = null;
    if (pttRecorder.state === 'recording') pttRecorder.stop();
  }
  pttRecorder = null;
  pttChunks = [];
  updateUiForState(playbackState());
}

const companionPanel = document.getElementById('companion-panel');
if (companionPanel) {
  companionPanel.addEventListener('contextmenu', (e) => e.preventDefault());
}

let pttTouchStartX = 0;
let pttTouchStartY = 0;
let isPttScrolling = false;

window.addEventListener('pointerdown', (e) => {
  if (!isMobile()) return;
  // Abaikan jika menekan tombol kontrol interaktif
  if (e.target.closest('#screen-share-btn, #camera-switch-btn, button, select, a')) {
    return;
  }
  // Area sekitar UI: pada #companion-panel atau area layar sekitarnya (bagian bawah)
  const isAroundUi = Boolean(e.target.closest('#companion-panel')) || e.clientY >= window.innerHeight * 0.40;
  if (!isAroundUi) return;

  if (playbackState() !== 'idle') return;

  pttTouchStartX = e.clientX;
  pttTouchStartY = e.clientY;
  isPttScrolling = false;

  startPttRecording();
});

window.addEventListener('pointermove', (e) => {
  if (!isMobile() || !isPttRecording) return;
  const dx = Math.abs(e.clientX - pttTouchStartX);
  const dy = Math.abs(e.clientY - pttTouchStartY);
  // Jika user menggeser (misal scroll riwayat chat), batalkan rekaman
  if (dx > 12 || dy > 12) {
    isPttScrolling = true;
    abortPttRecording();
  }
});

const handlePointerRelease = () => {
  if (!isMobile() || !isPttRecording) return;
  if (isPttScrolling) {
    abortPttRecording();
    return;
  }
  stopPttRecording();
};

window.addEventListener('pointerup', handlePointerRelease);
window.addEventListener('pointercancel', handlePointerRelease);

// ---------------------------------------------------------------------------
// Hands-free listening (VAD - Khusus Desktop)
// Mic -> AnalyserNode; loop rAF baca RMS. State machine: diam -> (volume naik)
// mulai rekam segmen -> (hening SILENCE_MS) stop & kirim -> ulang. Saat amika
// bicara atau turn bukan IDLE, VAD di-pause.
// ---------------------------------------------------------------------------
let micStream = null;
let vadAnalyser = null;
let vadData = null;
let segRecorder = null;
let segChunks = [];
let segStartAt = 0;
let speaking = false; // user sedang bicara (segmen berjalan)
let silenceStart = 0; // timestamp mulai hening
let listening = false;
let micStartPromise = null;
let vadFrame = null;

function reportDesktopMicState() {
  if (micMuteRevision < 0) return;
  window.desktopBridge?.reportMicState?.({
    revision: micMuteRevision,
    muted: isMicMutedByDesktop,
    captureActive: Boolean(micStream?.getAudioTracks().some(track => track.readyState !== 'ended' && track.enabled)),
    recording: [segRecorder, pttRecorder].some(recorder => recorder?.state === 'recording'),
    indicatorMuted: micLabelEl.textContent === '🔇 Mikrofon di-mute'
      && !micStatusEl.classList.contains('live') && !micStatusEl.classList.contains('recording'),
  });
}

function applyDesktopMicMute(muted, notifySubtitle = false, details = {}) {
  if (!Number.isInteger(details.revision) || details.revision < micMuteRevision) return;
  micMuteRevision = details.revision;
  activeMuteShortcut = details.shortcut || null;
  const nextMuted = Boolean(muted);
  const changed = isMicMutedByDesktop !== nextMuted;
  isMicMutedByDesktop = nextMuted;

  if (changed && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'mic_mute', muted: nextMuted }));
    } catch (err) {
      console.warn('[mic] Could not synchronize microphone state:', err.message);
    }
  }

  if (nextMuted) {
    abortSegment();
    abortPttRecording();
    micStream?.getTracks().forEach(track => track.stop());
    micStream = null;
    vadAnalyser = null;
    vadData = null;
    if (vadFrame !== null) cancelAnimationFrame(vadFrame);
    vadFrame = null;
    setMicStatus(false, '🔇 Mikrofon di-mute');
    if (notifySubtitle && changed) {
      showOverlaySubtitle(`🔇 Mikrofon di-mute (${activeMuteShortcut || 'shortcut tidak tersedia'})`);
    }
  } else {
    if (listening) startListening();
    if (notifySubtitle && changed) {
      showOverlaySubtitle('🎙️ Mikrofon aktif kembali');
    }
  }
  updateUiForState(playbackState());
  reportDesktopMicState();
}

if (window.desktopBridge) {
  const applySnapshot = (state) => {
    if (typeof state?.muteMic !== 'boolean') return;
    applyDesktopMicMute(state.muteMic, false, {
      revision: state.muteRevision,
      shortcut: state.shortcuts?.toggleMuteMic?.activeLabel,
    });
  };
  window.desktopBridge
    .getOverlayState?.()
    .then(applySnapshot)
    .catch(() => {});

  window.desktopBridge.onOverlayStateChanged?.(applySnapshot);
  window.desktopBridge.onMuteMicChanged?.((muted, details) => {
    applyDesktopMicMute(muted, true, details);
  });
}

function isamikaSpeaking() {
  const speakTail = tuning.get('vad.speakTail') ?? 0.15;
  return audioCtx && playCursor > audioCtx.currentTime + speakTail;
}

function micLevel() {
  vadAnalyser.getByteTimeDomainData(vadData);
  let sum = 0;
  for (let i = 0; i < vadData.length; i++) {
    const v = (vadData[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / vadData.length); // RMS 0..1
}

function beginSegment() {
  segChunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  segRecorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined);
  segStartAt = performance.now();
  segRecorder.ondataavailable = (ev) => {
    if (ev.data.size) segChunks.push(ev.data);
  };
  segRecorder.onstop = flushSegment;
  segRecorder.start();
}

function endSegment() {
  if (segRecorder && segRecorder.state === 'recording') segRecorder.stop(); // -> flushSegment
}

// Batalkan segmen berjalan tanpa kirim (mis. amika keburu mulai bicara atau turn berganti).
function abortSegment() {
  if (segRecorder) {
    segRecorder.ondataavailable = null;
    segRecorder.onstop = null;
    if (segRecorder.state === 'recording') segRecorder.stop();
  }
  segRecorder = null;
  segChunks = [];
  speaking = false;
  silenceStart = 0;
}

async function flushSegment() {
  const revision = micMuteRevision;
  const dur = performance.now() - segStartAt;
  const type = (segRecorder && segRecorder.mimeType) || 'audio/webm';
  const blob = new Blob(segChunks, { type });
  segRecorder = null;
  segChunks = [];
  if (isMicMutedByDesktop) return;
  const minSeg = tuning.get('vad.minSegMs') ?? 400;
  if (dur < minSeg || blob.size < 1024) return; // noise pendek -> buang

  updateUiForState('processing');

  const data = await new Promise((res) => {
    const r = new FileReader();
    r.onloadend = () => res(String(r.result).split(',')[1]); // buang prefix data URL
    r.readAsDataURL(blob);
  });
  if (isMicMutedByDesktop || revision !== micMuteRevision) {
    updateUiForState(playbackState());
    return;
  }
  const image = captureWebcamFrame();
  const screenImage = captureScreenFrame();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'audio_input',
        data,
        mime: blob.type,
        image,
        screenImage,
        ...desktopInputMeta(),
        durationMs: dur,
      }),
    );
  }
}

function vadLoop() {
  vadFrame = requestAnimationFrame(vadLoop);
  if (!vadAnalyser) return;

  // Layout mobile tidak memakai VAD (menggunakan Push-to-Talk)
  if (isMobile()) return;

  // Stop VAD while the desktop microphone is muted.
  if (isMicMutedByDesktop) {
    if (segRecorder) abortSegment();
    setMicStatus(false, '🔇 Mikrofon di-mute');
    return;
  }

  // Turn-taking: jika bukan IDLE (sedang PROCESSING atau SPEAKING), nonaktifkan deteksi
  if (playbackState() !== 'idle') {
    if (segRecorder) abortSegment();
    updateUiForState(playbackState());
    return;
  }

  // amika lagi bicara -> jangan dengar (cegah loop suara sendiri).
  if (isamikaSpeaking()) {
    if (segRecorder) abortSegment();
    setMicStatus(false, 'Amika sedang bicara…', 'speaking');
    return;
  }

  const level = micLevel();
  const now = performance.now();
  const vadStart = tuning.get('vad.vadStart') ?? 0.055;
  const vadStop = tuning.get('vad.vadStop') ?? 0.035;
  const silenceMs = tuning.get('vad.silenceMs') ?? 900;

  if (!speaking) {
    setMicStatus(true, 'Mendengarkan…');
    if (level > vadStart) {
      speaking = true;
      silenceStart = 0;
      beginSegment();
    }
  } else {
    setMicStatus(true, '● Merekam…', 'recording');
    if (level > vadStop) {
      silenceStart = 0;
    } else if (!silenceStart) {
      silenceStart = now;
    } else if (now - silenceStart > silenceMs) {
      speaking = false;
      silenceStart = 0;
      endSegment();
    }
  }
}

async function startListening() {
  if (micStartPromise) return micStartPromise;
  if (listening && micStream) return;
  listening = true;
  if (isMicMutedByDesktop) return;
  micStartPromise = (async () => {
    try {
      ensureAudio();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      if (isMicMutedByDesktop) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (isMicMutedByDesktop) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      micStream = stream;

      if (!isMobile()) {
        vadAnalyser = audioCtx.createAnalyser();
        vadAnalyser.fftSize = 512;
        vadData = new Uint8Array(vadAnalyser.fftSize);
        // Connect only to the analyser to avoid microphone feedback.
        audioCtx.createMediaStreamSource(micStream).connect(vadAnalyser);
        vadFrame = requestAnimationFrame(vadLoop);
      }
      updateUiForState(playbackState());
    } catch (err) {
      listening = false;
      setMicStatus(false, 'Mic gagal');
      log(`Mic gagal: ${err.message}`, 'error');
    }
  })().finally(() => {
    micStartPromise = null;
    reportDesktopMicState();
  });
  return micStartPromise;
}

// ---------------------------------------------------------------------------
// Input teks (khusus desktop): ketik di box output -> kirim 'text_input'.
// Server memakai pipeline yang sama dengan suara (tanpa STT).
// ---------------------------------------------------------------------------
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
if (chatForm && chatInput) {
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (isMobile()) return;
    const text = chatInput.value.trim();
    if (!text) return;
    if (playbackState() !== 'idle') return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log('Belum terhubung ke server.', 'error');
      return;
    }
    ensureAudio(); // gesture user -> unlock audio untuk playback TTS
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    ws.send(JSON.stringify({
      type: 'text_input',
      text,
      image: captureWebcamFrame(),
      screenImage: captureScreenFrame(),
      ...desktopInputMeta(),
    }));
    chatInput.value = '';
    updateUiForState('processing');
  });
}

// Tampilan awal sesuai layout
if (isMobile()) {
  updateUiForState('idle');
} else {
  setMicStatus(false, 'Klik untuk mulai');
}

// Satu gesture untuk unlock AudioContext + izin mic (aturan browser).
const kick = () => startListening();
document.addEventListener('pointerdown', kick, { once: true });
document.addEventListener('keydown', kick, { once: true });

// Pada mode overlay / Electron companion (autoplay-policy sudah diizinkan),
// langsung aktifkan listening hands-free tanpa menunggu klik di dalam jendela.
if (isOverlay || window.desktopBridge?.isDesktopCompanion) {
  startListening();
}

// Responsif saat resize browser
window.addEventListener('resize', () => {
  updateUiForState(playbackState());
  if (!isMobile() && micStream && !vadAnalyser) {
    vadAnalyser = audioCtx.createAnalyser();
    vadAnalyser.fftSize = 512;
    vadData = new Uint8Array(vadAnalyser.fftSize);
    audioCtx.createMediaStreamSource(micStream).connect(vadAnalyser);
    vadFrame = requestAnimationFrame(vadLoop);
  }
});

initWebcam();
