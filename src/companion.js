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

function log(text, cls = '') {
  const div = document.createElement('div');
  div.className = `log-line ${cls}`.trim();
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight; // auto-scroll ke bawah
  return div;
}

function setMicStatus(live, label) {
  micStatusEl.classList.toggle('live', live);
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

function sendContinuousFrame() {
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
      screenShareBtn.textContent = `🖥️ Screen On (${captureIntervalSeconds}s)`;
    }
    log(`🖥️ Share screen aktif (capture ${captureIntervalSeconds}s).`, 'muted');

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'screen_share_status', active: true }));
    }

    startContinuousCapture();

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
  return canvas.toDataURL('image/jpeg', 0.7);
}

function captureScreenFrame() {
  if (!screenStream || !screenVideo.videoWidth || !screenVideo.videoHeight) {
    return null;
  }
  const w = Math.min(screenVideo.videoWidth, 1280);
  const h = Math.round((w / screenVideo.videoWidth) * screenVideo.videoHeight);
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(screenVideo, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.75);
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
let pendingChunks = []; // chunk mp3 kalimat yang sedang diterima
let pendingEmotion = 'netral';
let scheduledEmotionEnd = 0;

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
    audioCtx.currentTime < Math.max(playCursor, scheduledEmotionEnd) + SPEAK_TAIL;
}

// Amplitudo audio yang lagi diputar -> 0..1 buat buka mulut.
function sampleMouth() {
  if (!analyser) return 0;
  analyser.getByteFrequencyData(freqData);
  let sum = 0;
  for (let i = 0; i < freqData.length; i++) sum += freqData[i];
  const avg = sum / freqData.length / 255;
  return Math.min(1, avg * 1.8);
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

async function playSentenceAudio(chunks) {
  ensureAudio();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

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

  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(analyser);
  const startAt = Math.max(audioCtx.currentTime, playCursor);
  const endAt = startAt + buffer.duration;
  const emotion = pendingEmotion;
  src.start(startAt);
  playCursor = endAt; // dipakai VAD untuk tahu amika masih bicara
  scheduledEmotionEnd = Math.max(scheduledEmotionEnd, endAt);
  window.dispatchEvent(new CustomEvent('waifu-emotion-cue', {
    detail: { emotion, startAt, endAt },
  }));
}

// ---------------------------------------------------------------------------
// WebSocket: terima user_said / amika_replied (log) + audio_output (suara).
// ---------------------------------------------------------------------------
let ws = null;

function connectWS() {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProtocol}//${location.host}/ws`);
  ws.addEventListener('message', (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'user_said':
        log(`Kamu: ${msg.text}`, 'user');
        break;
      case 'vision':
        log(`👁️ ${msg.text}`, 'vision');
        break;
      case 'amika_replied':
        log(`amika: ${msg.text}`, 'assistant');
        break;
      case 'emotion':
        pendingEmotion = msg.emotion || 'netral';
        window.dispatchEvent(new CustomEvent('waifu-emotion-cue', {
          detail: { emotion: pendingEmotion },
        }));
        break;
      case 'audio_output':
        pendingChunks.push(b64ToUint8(msg.data));
        break;
      case 'audio_end': {
        const cs = pendingChunks;
        pendingChunks = [];
        if (cs.length) {
          playSentenceAudio(cs);
          // Notify Live2D Layer 2: a sentence just completed → trigger motion.
          window.dispatchEvent(new CustomEvent('waifu-sentence-break'));
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
            if (screenStream) {
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
  ws.addEventListener('close', () => setTimeout(connectWS, 1500)); // sambung ulang
  ws.addEventListener('error', () => ws.close());
}
connectWS();

// ---------------------------------------------------------------------------
// Hands-free listening (VAD)
// Mic -> AnalyserNode; loop rAF baca RMS. State machine: diam -> (volume naik)
// mulai rekam segmen -> (hening SILENCE_MS) stop & kirim -> ulang. Saat amika
// bicara, VAD di-pause (playCursor > sekarang) biar tak dengar suara sendiri.
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

// Tuning knobs (ponytail: setel di sini kalau kepekaan kurang/lebih):
const VAD_START = 0.055; // ambang mulai bicara (RMS 0..1)
const VAD_STOP = 0.035; // ambang hening (hysteresis, < START biar stabil)
const SILENCE_MS = 900; // hening selama ini -> anggap kalimat selesai
const MIN_SEG_MS = 400; // segmen < ini -> buang (noise/ketuk)
const SPEAK_TAIL = 0.15; // detik ekstra setelah TTS selesai sebelum dengar lagi

function isamikaSpeaking() {
  return audioCtx && playCursor > audioCtx.currentTime + SPEAK_TAIL;
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

// Batalkan segmen berjalan tanpa kirim (mis. amika keburu mulai bicara).
function abortSegment() {
  if (segRecorder && segRecorder.state === 'recording') {
    segRecorder.onstop = null;
    segRecorder.stop();
  }
  segRecorder = null;
  segChunks = [];
  speaking = false;
  silenceStart = 0;
}

async function flushSegment() {
  const dur = performance.now() - segStartAt;
  const type = (segRecorder && segRecorder.mimeType) || 'audio/webm';
  const blob = new Blob(segChunks, { type });
  segRecorder = null;
  segChunks = [];
  if (dur < MIN_SEG_MS || blob.size < 1024) return; // noise pendek -> buang

  const data = await new Promise((res) => {
    const r = new FileReader();
    r.onloadend = () => res(String(r.result).split(',')[1]); // buang prefix data URL
    r.readAsDataURL(blob);
  });
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
        durationMs: dur,
      }),
    );
  }
}

function vadLoop() {
  requestAnimationFrame(vadLoop);
  if (!vadAnalyser) return;

  // amika lagi bicara -> jangan dengar (cegah loop suara sendiri).
  if (isamikaSpeaking()) {
    if (segRecorder) abortSegment();
    setMicStatus(false, 'amika bicara…');
    return;
  }

  const level = micLevel();
  const now = performance.now();
  if (!speaking) {
    setMicStatus(true, 'Mendengarkan…');
    if (level > VAD_START) {
      speaking = true;
      silenceStart = 0;
      beginSegment();
    }
  } else {
    setMicStatus(true, '● Merekam…');
    if (level > VAD_STOP) {
      silenceStart = 0;
    } else if (!silenceStart) {
      silenceStart = now;
    } else if (now - silenceStart > SILENCE_MS) {
      speaking = false;
      silenceStart = 0;
      endSegment();
    }
  }
}

async function startListening() {
  if (listening) return;
  listening = true;
  try {
    ensureAudio();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    vadAnalyser = audioCtx.createAnalyser();
    vadAnalyser.fftSize = 512;
    vadData = new Uint8Array(vadAnalyser.fftSize);
    // Sambung mic -> analyser SAJA (jangan ke destination, nanti feedback).
    audioCtx.createMediaStreamSource(micStream).connect(vadAnalyser);
    setMicStatus(true, 'Mendengarkan…');
    requestAnimationFrame(vadLoop);
  } catch (err) {
    listening = false;
    setMicStatus(false, 'Mic gagal');
    log(`Mic gagal: ${err.message}`, 'error');
  }
}

// Satu gesture untuk unlock AudioContext + izin mic (aturan browser).
setMicStatus(false, 'Klik untuk mulai');
const kick = () => startListening();
document.addEventListener('pointerdown', kick, { once: true });
document.addEventListener('keydown', kick, { once: true });

initWebcam();
