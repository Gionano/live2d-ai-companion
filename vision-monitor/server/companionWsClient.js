// ---------------------------------------------------------------------------
// companionWsClient.js (vision-monitor backend)
// WebSocket Client connecting to the Main Companion App (ws://localhost:8787/ws)
// Receives stream frames, vision logs, filter outcomes, and relays remote configs.
// ---------------------------------------------------------------------------
import WebSocket from 'ws';

export class CompanionWsClient {
  constructor(url = process.env.MAIN_COMPANION_WS_URL || 'ws://localhost:8787/ws') {
    this.url = url;
    this.ws = null;
    this.status = 'disconnected'; // 'connected' | 'disconnected' | 'reconnecting'
    this.onStatusChange = null;
    this.onMessage = null;
    this.retryTimeout = null;
    this.retryDelay = 2000;
    this.maxRetryDelay = 10000;
    this.shouldConnect = true;
  }

  connect() {
    this.shouldConnect = true;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this._setStatus('reconnecting');
    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        console.log(`[CompanionWsClient] Terhubung ke Companion Utama di ${this.url}`);
        this.retryDelay = 2000;
        this._setStatus('connected');
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (this.onMessage) {
            this.onMessage(msg);
          }
        } catch {
          // ignore non-json messages
        }
      });

      this.ws.on('close', () => {
        console.warn('[CompanionWsClient] Koneksi ke Companion Utama terputus.');
        this.ws = null;
        this._setStatus('disconnected');
        if (this.shouldConnect) {
          this._scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        console.warn(`[CompanionWsClient] WebSocket error: ${err.message}`);
        this.ws = null;
        this._setStatus('disconnected');
      });
    } catch (err) {
      console.error(`[CompanionWsClient] Gagal inisialisasi WS: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.retryTimeout) clearTimeout(this.retryTimeout);
    this.retryTimeout = setTimeout(() => {
      if (this.shouldConnect) {
        console.log(`[CompanionWsClient] Mencoba menyambung kembali ke ${this.url}...`);
        this.connect();
        this.retryDelay = Math.min(this.retryDelay * 1.5, this.maxRetryDelay);
      }
    }, this.retryDelay);
  }

  _setStatus(status) {
    this.status = status;
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }
  }

  send(dataObj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(dataObj));
      return true;
    }
    console.warn('[CompanionWsClient] Gagal kirim pesan: WebSocket ke companion utama belum OPEN.');
    return false;
  }

  disconnect() {
    this.shouldConnect = false;
    if (this.retryTimeout) clearTimeout(this.retryTimeout);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._setStatus('disconnected');
  }
}
