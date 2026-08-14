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
const MAIN_COMPANION_WS_URL = process.env.MAIN_COMPANION_WS_URL || 'ws://localhost:8787/ws';

const app = express();
app.use(express.json({ limit: '20mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws-monitor' });

// Cached state from companion
let lastKnownState = {
  active: false,
  settings: {
    intervalSeconds: 1,
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

companionClient.onStatusChange = (status) => {
  broadcastToUI({
    type: 'companion_status',
    status,
    url: MAIN_COMPANION_WS_URL,
  });
};

// Relay incoming messages from Companion Utama to Vision Monitor UI
companionClient.onMessage = (msg) => {
  if (!msg) return;

  if (msg.type === 'init_vision_state' || msg.type === 'screen_share_status') {
    if (typeof msg.active === 'boolean') lastKnownState.active = msg.active;
    if (msg.settings) lastKnownState.settings = { ...lastKnownState.settings, ...msg.settings };
    if (msg.stats) lastKnownState.stats = { ...lastKnownState.stats, ...msg.stats };
  } else if (msg.type === 'config_updated') {
    if (msg.settings) lastKnownState.settings = { ...lastKnownState.settings, ...msg.settings };
  } else if (msg.type === 'stats_update') {
    if (msg.stats) lastKnownState.stats = { ...lastKnownState.stats, ...msg.stats };
  } else if (msg.type === 'vision_entry') {
    if (typeof msg.bufferCount === 'number') lastKnownState.bufferCount = msg.bufferCount;
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
    state: lastKnownState,
  });
});

// WebSocket connection handling for UI Clients
wss.on('connection', (ws) => {
  console.log('[server] UI Client terhubung ke /ws-monitor');

  // Kirim initial state ke UI client yang baru buka
  ws.send(
    JSON.stringify({
      type: 'init_state',
      companionStatus: companionClient.status,
      companionUrl: MAIN_COMPANION_WS_URL,
      state: lastKnownState,
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
      console.log('[server] Meneruskan update konfigurasi ke Companion Utama:', msg.settings);
      companionClient.send({
        type: 'update_vision_config',
        settings: msg.settings,
      });
    } else if (msg.type === 'reset_stats') {
      companionClient.send({ type: 'reset_stats' });
    }
  });

  ws.on('close', () => {
    console.log('[server] UI Client terputus dari /ws-monitor');
  });
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`  Vision Monitor Bridge running on http://localhost:${PORT}`);
  console.log(`  WebSocket Endpoint: ws://localhost:${PORT}/ws-monitor`);
  console.log(`  Target Companion WS: ${MAIN_COMPANION_WS_URL}`);
  console.log(`=======================================================`);
});
