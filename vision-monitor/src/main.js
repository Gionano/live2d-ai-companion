// ---------------------------------------------------------------------------
// main.js (vision-monitor frontend)
// Observation & Remote Configuration Panel.
// Receives stream frames, perception logs, and filter events from Main Companion,
// and sends realtime capture configuration updates back to the companion.
// ---------------------------------------------------------------------------

const USD_TO_IDR_RATE = 16200;

// State
let ws = null;
let isScreenShareActive = false;
let sessionStartEpoch = null;
let sessionTimerId = null;
let bufferCount = 0;
let bufferDurationSec = 30;
let captureIntervalSec = 1;
let nextFilterSeconds = 30;
let countdownTimerId = null;

// DOM Elements
const backendStatusPill = document.getElementById('backend-status-pill');
const companionStatusPill = document.getElementById('companion-status-pill');
const monitoringBadge = document.getElementById('monitoring-badge');
const streamStatusTitle = document.getElementById('stream-status-title');
const streamStatusDesc = document.getElementById('stream-status-desc');
const sessionTimerEl = document.getElementById('session-timer');

const intervalSlider = document.getElementById('interval-slider');
const intervalValDisplay = document.getElementById('interval-val-display');
const bufferSlider = document.getElementById('buffer-slider');
const bufferValDisplay = document.getElementById('buffer-val-display');
const maxTokensInput = document.getElementById('max-tokens-input');
const tokensValDisplay = document.getElementById('tokens-val-display');
const configSyncBadge = document.getElementById('config-sync-badge');

const livePreviewImg = document.getElementById('live-preview-img');
const videoPlaceholder = document.getElementById('video-placeholder');
const captureFlash = document.getElementById('capture-flash-overlay');
const streamSourceBadge = document.getElementById('stream-source-badge');
const hudRes = document.getElementById('hud-res');
const hudLastTime = document.getElementById('hud-last-time');

const liveBufferCount = document.getElementById('live-buffer-count');
const filterCountdown = document.getElementById('filter-countdown');

const statFrames = document.getElementById('stat-frames');
const statVisionCalls = document.getElementById('stat-vision-calls');
const statFilterCalls = document.getElementById('stat-filter-calls');
const statComments = document.getElementById('stat-comments');
const costVision = document.getElementById('cost-vision');
const costFilter = document.getElementById('cost-filter');
const costTotalUsd = document.getElementById('cost-total-usd');
const costTotalIdr = document.getElementById('cost-total-idr');
const resetStatsBtn = document.getElementById('reset-stats-btn');

const descriptionLogList = document.getElementById('description-log-list');
const emptyLogMessage = document.getElementById('empty-log-message');
const logCountTag = document.getElementById('log-count-tag');
const autoscrollToggle = document.getElementById('autoscroll-toggle');
const clearLogsBtn = document.getElementById('clear-logs-btn');

let totalLogsCount = 0;

// ---------------------------------------------------------------------------
// WebSocket Connection to Backend Bridge
// ---------------------------------------------------------------------------
function connectWebSocket() {
  const wsHost = window.location.hostname || 'localhost';
  const wsUrl = `ws://${wsHost}:3001/ws-monitor`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[WS] Terhubung ke Vision Monitor Bridge Server');
    setBackendStatus('connected', 'Monitor Server: Online');
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'init_state': {
        if (msg.companionStatus) {
          updateCompanionStatusUI(msg.companionStatus);
        }
        if (msg.state) {
          applyState(msg.state);
        }
        break;
      }

      case 'init_vision_state':
      case 'screen_share_status': {
        isScreenShareActive = Boolean(msg.active);
        updateStreamStatusUI(isScreenShareActive);
        if (msg.settings) applySettings(msg.settings);
        if (msg.stats) updateStatsUI(msg.stats);
        break;
      }

      case 'companion_status': {
        updateCompanionStatusUI(msg.status);
        break;
      }

      case 'monitor_frame': {
        renderIncomingFrame(msg.image, msg.timestamp);
        break;
      }

      case 'vision_entry': {
        appendRawDescription(msg.entry);
        updateBufferCountUI(msg.bufferCount);
        if (msg.stats) updateStatsUI(msg.stats);
        break;
      }

      case 'filter_start': {
        console.log(`[WS] Filter dimulai untuk ${msg.bufferSize} entries`);
        filterCountdown.textContent = 'Filtering...';
        break;
      }

      case 'filter_result': {
        appendFilterResult(msg);
        updateBufferCountUI(0);
        resetFilterCountdown();
        if (msg.stats) updateStatsUI(msg.stats);
        break;
      }

      case 'stats_update': {
        if (msg.stats) updateStatsUI(msg.stats);
        break;
      }

      case 'config_updated': {
        if (msg.settings) {
          applySettings(msg.settings);
          showConfigSyncFlash();
        }
        break;
      }
    }
  };

  ws.onclose = () => {
    setBackendStatus('disconnected', 'Monitor Server: Offline');
    setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = () => {
    setBackendStatus('disconnected', 'Monitor Server: Error');
  };
}

function sendWs(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function setBackendStatus(status, text) {
  backendStatusPill.className = `status-pill ${status}`;
  backendStatusPill.querySelector('.status-text').textContent = text;
}

function updateCompanionStatusUI(status) {
  if (status === 'connected') {
    companionStatusPill.className = 'status-pill connected';
    companionStatusPill.querySelector('.status-text').textContent = 'Companion WS: Terhubung';
  } else if (status === 'reconnecting') {
    companionStatusPill.className = 'status-pill reconnecting';
    companionStatusPill.querySelector('.status-text').textContent = 'Companion WS: Reconnecting...';
  } else {
    companionStatusPill.className = 'status-pill disconnected';
    companionStatusPill.querySelector('.status-text').textContent = 'Companion WS: Terputus';
  }
}

// ---------------------------------------------------------------------------
// Apply State & UI Sync
// ---------------------------------------------------------------------------
function applyState(state) {
  if (typeof state.active === 'boolean') {
    isScreenShareActive = state.active;
    updateStreamStatusUI(isScreenShareActive);
  }
  if (state.settings) {
    applySettings(state.settings);
  }
  if (state.stats) {
    updateStatsUI(state.stats);
  }
  if (typeof state.bufferCount === 'number') {
    updateBufferCountUI(state.bufferCount);
  }
}

function applySettings(settings) {
  if (typeof settings.intervalSeconds === 'number') {
    captureIntervalSec = settings.intervalSeconds;
    intervalSlider.value = captureIntervalSec;
    intervalValDisplay.textContent = `${captureIntervalSec} detik`;
  }
  if (typeof settings.bufferDurationSec === 'number') {
    bufferDurationSec = settings.bufferDurationSec;
    bufferSlider.value = bufferDurationSec;
    bufferValDisplay.textContent = `${bufferDurationSec} detik`;
    resetFilterCountdown();
  }
  if (typeof settings.maxTokens === 'number') {
    maxTokensInput.value = settings.maxTokens;
    tokensValDisplay.textContent = `${settings.maxTokens} tokens`;
  }
}

function updateStreamStatusUI(active) {
  if (active) {
    monitoringBadge.className = 'badge active';
    monitoringBadge.textContent = 'STREAM AKTIF';
    streamStatusTitle.textContent = `Screen Share Aktif (${captureIntervalSec}s capture)`;
    streamStatusDesc.textContent = 'Frame di-capture dari halaman companion utama dan diproses secara otomatis.';
    streamSourceBadge.textContent = `Screen Feed (${captureIntervalSec} FPS)`;
    videoPlaceholder.style.display = 'none';
    livePreviewImg.style.display = 'block';

    if (!sessionStartEpoch) sessionStartEpoch = Date.now();
    startSessionTimer();
    startFilterCountdown();
  } else {
    monitoringBadge.className = 'badge idle';
    monitoringBadge.textContent = 'MENUNGGU STREAM';
    streamStatusTitle.textContent = 'Screen Share Belum Aktif';
    streamStatusDesc.textContent = 'Klik tombol "Share Screen" di halaman avatar companion untuk memulai capture.';
    streamSourceBadge.textContent = 'Menunggu Stream...';
    videoPlaceholder.style.display = 'flex';
    livePreviewImg.style.display = 'none';

    stopSessionTimer();
    stopFilterCountdown();
  }
}

function renderIncomingFrame(dataUrl, timestamp) {
  if (!dataUrl) return;

  livePreviewImg.src = dataUrl;
  videoPlaceholder.style.display = 'none';
  livePreviewImg.style.display = 'block';

  // Green Flash Animation on frame received
  captureFlash.classList.add('active');
  setTimeout(() => captureFlash.classList.remove('active'), 120);

  // Update HUD
  hudLastTime.textContent = new Date(timestamp || Date.now()).toLocaleTimeString();
  if (livePreviewImg.naturalWidth) {
    hudRes.textContent = `${livePreviewImg.naturalWidth} × ${livePreviewImg.naturalHeight}`;
  }
}

function showConfigSyncFlash() {
  configSyncBadge.textContent = 'Tersinkron ✓';
  configSyncBadge.style.borderColor = 'var(--accent-emerald)';
  configSyncBadge.style.color = 'var(--accent-emerald)';
  setTimeout(() => {
    configSyncBadge.style.borderColor = '';
    configSyncBadge.style.color = '';
  }, 1200);
}

// ---------------------------------------------------------------------------
// Timers & Countdowns
// ---------------------------------------------------------------------------
function startSessionTimer() {
  if (sessionTimerId) clearInterval(sessionTimerId);
  sessionTimerId = setInterval(() => {
    if (!sessionStartEpoch) return;
    const diff = Math.floor((Date.now() - sessionStartEpoch) / 1000);
    const hrs = String(Math.floor(diff / 3600)).padStart(2, '0');
    const mins = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
    const secs = String(diff % 60).padStart(2, '0');
    sessionTimerEl.textContent = `${hrs}:${mins}:${secs}`;
  }, 1000);
}

function stopSessionTimer() {
  if (sessionTimerId) {
    clearInterval(sessionTimerId);
    sessionTimerId = null;
  }
}

function resetFilterCountdown() {
  nextFilterSeconds = bufferDurationSec;
  filterCountdown.textContent = `${nextFilterSeconds}s`;
}

function startFilterCountdown() {
  if (countdownTimerId) clearInterval(countdownTimerId);
  countdownTimerId = setInterval(() => {
    if (!isScreenShareActive) return;
    if (nextFilterSeconds > 0) {
      nextFilterSeconds--;
      filterCountdown.textContent = `${nextFilterSeconds}s`;
    } else {
      filterCountdown.textContent = `Filtering...`;
    }
  }, 1000);
}

function stopFilterCountdown() {
  if (countdownTimerId) {
    clearInterval(countdownTimerId);
    countdownTimerId = null;
  }
  filterCountdown.textContent = '--';
}

function updateBufferCountUI(count) {
  bufferCount = count;
  liveBufferCount.textContent = `${count} frame`;
}

// ---------------------------------------------------------------------------
// Stats & Cost Update
// ---------------------------------------------------------------------------
function updateStatsUI(stats) {
  statFrames.textContent = stats.totalFramesCaptured || 0;
  statVisionCalls.textContent = stats.totalVisionCalls || 0;
  statFilterCalls.textContent = stats.totalFilterCalls || 0;
  statComments.textContent = stats.totalCommentsSent || 0;

  const vCost = stats.totalVisionCostUsd || 0;
  const fCost = stats.totalFilterCostUsd || 0;
  const totalCost = vCost + fCost;
  const totalIdr = Math.round(totalCost * USD_TO_IDR_RATE);

  costVision.textContent = `$${vCost.toFixed(4)}`;
  costFilter.textContent = `$${fCost.toFixed(4)}`;
  costTotalUsd.textContent = `$${totalCost.toFixed(4)}`;
  costTotalIdr.textContent = `(~Rp ${totalIdr.toLocaleString('id-ID')})`;
}

// ---------------------------------------------------------------------------
// Feed & Log Rendering
// ---------------------------------------------------------------------------
function appendRawDescription(entry) {
  if (emptyLogMessage) emptyLogMessage.style.display = 'none';

  const item = document.createElement('div');
  item.className = 'feed-item';

  const costStr = entry.costUsd ? `$${entry.costUsd.toFixed(5)}` : '$0.0001';

  item.innerHTML = `
    <div class="feed-item-header">
      <span class="feed-badge badge-raw">Qwen 3.8 27B</span>
      <span class="mono">${entry.timestamp}</span>
    </div>
    <div class="feed-content">${escapeHtml(entry.description)}</div>
    <div class="feed-meta">
      <span>Tokens: ${entry.tokens || 0}</span>
      <span>Latency: ${entry.latencyMs || 0}ms</span>
      <span>Cost: ${costStr}</span>
    </div>
  `;

  descriptionLogList.appendChild(item);
  totalLogsCount++;
  logCountTag.textContent = `(${totalLogsCount} log)`;

  if (autoscrollToggle.checked) {
    descriptionLogList.scrollTop = descriptionLogList.scrollHeight;
  }
}

function appendFilterResult(msg) {
  if (emptyLogMessage) emptyLogMessage.style.display = 'none';

  const item = document.createElement('div');

  if (msg.action === 'COMMENT') {
    item.className = 'feed-item filter-comment';
    item.innerHTML = `
      <div class="feed-item-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="feed-badge">DeepSeek V4 Filter</span>
          <span class="comment-emotion-pill">${escapeHtml(msg.emotion || 'netral')}</span>
        </div>
        <span class="mono">${msg.timestamp || new Date().toLocaleTimeString()}</span>
      </div>
      <div class="comment-text-quote">"${escapeHtml(msg.text)}"</div>
      <div class="feed-meta">
        <span class="comment-sent-badge">💬 Amika Berbicara (TTS & Avatar)</span>
        <span>Dari ${msg.sourceCount || 0} frame buffer</span>
        <span>${msg.latencyMs || 0}ms</span>
      </div>
    `;
  } else {
    item.className = 'feed-item filter-skip';
    item.innerHTML = `
      <div class="feed-item-header">
        <span class="feed-badge">Filter: SKIP</span>
        <span class="mono">${msg.timestamp || new Date().toLocaleTimeString()}</span>
      </div>
      <div class="feed-content" style="color: var(--text-muted);">
        Tidak ada momen yang cukup menarik (${escapeHtml(msg.reason || 'Dilewati')}).
      </div>
      <div class="feed-meta">
        <span>Evaluasi ${msg.sourceCount || 0} frame buffer</span>
        <span>${msg.latencyMs || 0}ms</span>
      </div>
    `;
  }

  descriptionLogList.appendChild(item);
  totalLogsCount++;
  logCountTag.textContent = `(${totalLogsCount} log)`;

  if (autoscrollToggle.checked) {
    descriptionLogList.scrollTop = descriptionLogList.scrollHeight;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Remote Configuration Event Listeners
// ---------------------------------------------------------------------------
intervalSlider.addEventListener('input', (e) => {
  captureIntervalSec = parseInt(e.target.value, 10);
  intervalValDisplay.textContent = `${captureIntervalSec} detik`;
  sendWs({
    type: 'update_vision_config',
    settings: { intervalSeconds: captureIntervalSec },
  });
});

bufferSlider.addEventListener('input', (e) => {
  bufferDurationSec = parseInt(e.target.value, 10);
  bufferValDisplay.textContent = `${bufferDurationSec} detik`;
  resetFilterCountdown();
  sendWs({
    type: 'update_vision_config',
    settings: { bufferDurationSec },
  });
});

maxTokensInput.addEventListener('change', (e) => {
  const maxTokens = parseInt(e.target.value, 10) || 100;
  tokensValDisplay.textContent = `${maxTokens} tokens`;
  sendWs({
    type: 'update_vision_config',
    settings: { maxTokens },
  });
});

clearLogsBtn.addEventListener('click', () => {
  descriptionLogList.innerHTML = '';
  totalLogsCount = 0;
  logCountTag.textContent = `(0 log)`;
  if (emptyLogMessage) {
    descriptionLogList.appendChild(emptyLogMessage);
    emptyLogMessage.style.display = 'block';
  }
});

resetStatsBtn.addEventListener('click', () => {
  if (confirm('Reset semua statistik dan estimasi biaya sesi ini?')) {
    sendWs({ type: 'reset_stats' });
  }
});

// Initialize WebSocket on Load
connectWebSocket();
