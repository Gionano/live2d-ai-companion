// ---------------------------------------------------------------------------
// server.js (vision-monitor backend)
// Express + WebSocket Server on port 3001.
// Acts as an observation bridge between the Main Companion App and the Vision Monitor UI.
// ---------------------------------------------------------------------------
import 'dotenv/config';
import http from 'http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { CompanionWsClient } from './companionWsClient.js';

const PORT = process.env.PORT || 3001;
const MAIN_COMPANION_WS_URL = process.env.MAIN_COMPANION_WS_URL || 'ws://127.0.0.1:8787/ws';

const app = express();
app.use(express.json({ limit: '20mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws-monitor' });
const uiClients = new Set();

// Cached state from companion
let lastKnownState = {
  active: false,
  settings: {
    intervalSeconds: 1,
    minInferenceIntervalMs: 2000,
    freshnessMs: 5000,
    bufferDurationSec: 30,
    maxTokens: 100,
  },
  stats: {
    sessionStartTime: null,
    totalFramesCaptured: 0,
    totalVisionCalls: 0,
    totalFilterCalls: 0,
    totalVisionCostUsd: 0,
    totalFilterCostUsd: 0,
    totalCommentsSent: 0,
    totalSkips: 0,
  },
  bufferCount: 0,
  sources: {},
  frames: {},
  descriptions: {},
  logs: [],
};

// Broadcast to all UI clients connected to /ws-monitor
function broadcastToUI(data) {
  const json = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

// WebSocket Client to Companion Utama
const companionClient = new CompanionWsClient(MAIN_COMPANION_WS_URL);

function reportMonitorPresence() {
  if (companionClient.status === 'connected') {
    companionClient.send({ type: 'monitor_presence', active: uiClients.size > 0 });
  }
}

companionClient.onStatusChange = (status) => {
  if (status === 'connected') reportMonitorPresence();
  broadcastToUI({
    type: 'companion_status',
    status,
    url: MAIN_COMPANION_WS_URL,
  });
  if (status !== 'connected') {
    // Keep observed telemetry, but never present a disconnected source as live.
    lastKnownState.active = false;
    lastKnownState.sources = Object.fromEntries(Object.entries(lastKnownState.sources).map(([source, state]) =>
      [source, { ...state, active: false, freshness: 'off', pending: false, inFlight: false }]));
    broadcastToUI({ type: 'screen_share_status', active: false, settings: lastKnownState.settings,
      stats: lastKnownState.stats, sources: lastKnownState.sources });
  }
};

function snapshotState() {
  const state = { ...lastKnownState };
  state.sources = Object.fromEntries(Object.entries(state.sources).map(([source, observed]) => {
    const elapsedMs = Math.max(0, Date.now() - (observed.receivedAt ?? Date.now()));
    const age = observed.lastCaptureAgeMs == null ? null : observed.lastCaptureAgeMs + elapsedMs;
    return [source, { ...observed, lastCaptureAgeMs: age,
      lastInferenceAgeMs: observed.lastInferenceAgeMs == null ? null : observed.lastInferenceAgeMs + elapsedMs,
      freshness: observed.active && age != null && age > state.settings.freshnessMs ? 'expired' : observed.freshness }];
  }));
  if (state.sync) {
    const aged = Math.round((Date.now() - state.sync.receivedAt) / 1000);
    state.sync = { ...state.sync, filterElapsedSec: (state.sync.filterElapsedSec ?? 0) + aged };
  }
  return state;
}

function cacheSources(sources) {
  for (const source of ['screen', 'webcam']) {
    if (!sources?.[source]) continue;
    const previous = lastKnownState.sources[source];
    const observed = sources[source];
    if (previous && Object.hasOwn(observed, 'sessionId') && previous.sessionId !== observed.sessionId) {
      delete lastKnownState.frames[source];
      delete lastKnownState.descriptions[source];
    }
    lastKnownState.sources[source] = { ...previous, ...observed, receivedAt: Date.now() };
  }
  if (Object.keys(lastKnownState.sources).length) {
    lastKnownState.active = Object.values(lastKnownState.sources).some(source => source.active);
  }
}

// Relay incoming messages from Companion Utama to Vision Monitor UI
companionClient.onMessage = (msg) => {
  if (!msg) return;

  if (msg.sync) {
    lastKnownState.bufferCount = msg.sync.bufferCount ?? lastKnownState.bufferCount;
    lastKnownState.sync = { ...msg.sync, receivedAt: Date.now() };
  }

  if (msg.sources) cacheSources(msg.sources);
  if (msg.type === 'monitor_frame' && ['screen', 'webcam'].includes(msg.source)) {
    lastKnownState.frames[msg.source] = { source: msg.source, image: msg.image,
      timestamp: msg.timestamp, sessionId: msg.sessionId };
  }
  if (msg.type === 'vision_entry' && msg.entry) {
    const source = msg.source || msg.entry.source || 'screen';
    lastKnownState.descriptions[source] = msg.entry;
  }
  if (['vision_entry', 'filter_result', 'vision_error'].includes(msg.type)) {
    lastKnownState.logs = [...lastKnownState.logs, msg].slice(-100);
  }

  if (msg.type === 'init_vision_state' || msg.type === 'screen_share_status') {
    if (!msg.sources && typeof msg.active === 'boolean') lastKnownState.active = msg.active;
    if (msg.settings) lastKnownState.settings = { ...lastKnownState.settings, ...msg.settings };
    if (msg.stats) lastKnownState.stats = { ...lastKnownState.stats, ...msg.stats };
    if (typeof msg.bufferCount === 'number') lastKnownState.bufferCount = msg.bufferCount;
  } else if (msg.type === 'config_updated') {
    if (msg.settings) lastKnownState.settings = { ...lastKnownState.settings, ...msg.settings };
  } else if (msg.type === 'stats_update') {
    if (msg.stats) lastKnownState.stats = { ...lastKnownState.stats, ...msg.stats };
  } else if (msg.type === 'vision_entry') {
    if (typeof msg.bufferCount === 'number') lastKnownState.bufferCount = msg.bufferCount;
    if (msg.stats) lastKnownState.stats = { ...lastKnownState.stats, ...msg.stats };
  } else if (msg.type === 'filter_result') {
    if (typeof msg.sync?.bufferCount !== 'number') {
      lastKnownState.bufferCount = Object.values(lastKnownState.sources)
        .reduce((total, source) => total + (source.bufferCount || 0), 0);
    }
    if (msg.stats) lastKnownState.stats = { ...lastKnownState.stats, ...msg.stats };
  }

  // Forward all telemetries directly to UI
  broadcastToUI(msg);
};

// Auto-connect to companion
companionClient.connect();

// Health check / status API
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    companionWsStatus: companionClient.status,
    state: snapshotState(),
  });
});

// WebSocket connection handling for UI Clients
wss.on('connection', (ws) => {
  console.log('[server] UI Client terhubung ke /ws-monitor');
  uiClients.add(ws);
  reportMonitorPresence();

  // Kirim initial state ke UI client yang baru buka
  ws.send(
    JSON.stringify({
      type: 'init_state',
      companionStatus: companionClient.status,
      companionUrl: MAIN_COMPANION_WS_URL,
      state: snapshotState(),
    })
  );

  ws.on('message', (messageData) => {
    let msg;
    try {
      msg = JSON.parse(messageData.toString());
    } catch {
      return;
    }

    // Teruskan konfigurasi dari UI ke Companion Utama
    if (msg.type === 'update_vision_config') {
      const settings = { ...msg.settings };
      // Older monitor clients used intervalSeconds for this control. Capture is fixed at 1 Hz.
      if (typeof settings.intervalSeconds === 'number' && settings.minInferenceIntervalMs == null) {
        settings.minInferenceIntervalMs = settings.intervalSeconds * 1000;
      }
      delete settings.intervalSeconds;
      if (Number.isFinite(settings.minInferenceIntervalMs)) {
        settings.minInferenceIntervalMs = Math.max(2000, Math.min(30000, settings.minInferenceIntervalMs));
      }
      console.log('[server] Meneruskan update konfigurasi ke Companion Utama:', settings);
      companionClient.send({
        type: 'update_vision_config',
        settings,
      });
    } else if (msg.type === 'reset_stats') {
      companionClient.send({ type: 'reset_stats' });
    }
  });

  ws.on('close', () => {
    console.log('[server] UI Client terputus dari /ws-monitor');
    uiClients.delete(ws);
    reportMonitorPresence();
  });
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  Vision Monitor Bridge running on http://localhost:${PORT}`);
  console.log(`  WebSocket Endpoint: ws://localhost:${PORT}/ws-monitor`);
  console.log(`  Target Companion WS: ${MAIN_COMPANION_WS_URL}`);
  console.log(`=======================================================`);
});
