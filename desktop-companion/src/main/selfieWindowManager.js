// ---------------------------------------------------------------------------
// selfieWindowManager.js  (main process Electron, Fase D)
// Mengelola jendela popup terpisah untuk fitur selfie / pap:
// - Frameless, always-on-top, TIDAK click-through, setContentProtection(true)
// - Diposisikan dekat avatar tanpa menutupinya, dibatasi di work area monitor aktif
// - Menangani transisi toast kompak (progress/ETA) dan kartu foto selesai (fade-in, zoom, aksi)
// - Menangani IPC simpan (Save As), salin clipboard (nativeImage), dan buka folder
// ---------------------------------------------------------------------------
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, clipboard, dialog, nativeImage, screen, shell, ipcMain } from 'electron';
import { CONFIG } from './config.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class SelfieWindowManager {
  constructor(dependencies = {}) {
    this.dependencies = { BrowserWindow, clipboard, dialog, nativeImage, screen, shell, ipcMain, fetch, config: CONFIG, ...dependencies };
    this.popupWindow = null;
    this.overlayWindow = null;
    this.webSocketSender = null;
    this.currentJobId = null;
    this.currentImageUrl = null;
    this.outputDir = path.join(os.homedir(), 'Pictures', 'WaifuSelfies');
    this.selfieEnabled = true; // Status toggle dari tray
    this._ipcRegistered = false;
    this._popupReady = false;
    this._pendingEvents = [];
    this._eventSnapshot = new Map();
    this._hideTimer = null;
    this._jobState = null;
    this._previousJobs = new Set();
    this._ipcHandlers = new Map();
    this._destroyed = false;
    this._reposition = () => {
      if (this.popupWindow && !this.popupWindow.isDestroyed()) {
        const { width, height } = this.popupWindow.getBounds();
        this.positionNearAvatar(width, height, this._isZoomed);
      }
    };
    this.backendOrigin = null;
    try {
      const backend = new URL(this.dependencies.config.backendUrl);
      if (['http:', 'https:'].includes(backend.protocol)
        && ['localhost', '127.0.0.1', '[::1]'].includes(backend.hostname)
        && !backend.username && !backend.password) this.backendOrigin = backend.origin;
    } catch { /* An invalid backend origin must never allow remote image access. */ }
  }

  init({ overlayWindow, webSocketSender, outputDir, onContentProtectionUpdated }) {
    this.overlayWindow = overlayWindow;
    this.webSocketSender = webSocketSender;
    if (outputDir) this.outputDir = outputDir;
    this.onContentProtectionUpdated = onContentProtectionUpdated;
    this._registerIpcHandlers();
    for (const eventName of ['display-added', 'display-removed', 'display-metrics-changed']) {
      this.dependencies.screen.on(eventName, this._reposition);
    }
    this.overlayWindow?.on('move', this._reposition);
    this.overlayWindow?.on('resize', this._reposition);
  }

  setSelfieEnabled(enabled) {
    this.selfieEnabled = Boolean(enabled);
    if (!this.selfieEnabled) {
      this._hidePopup();
      this._pendingEvents = [];
      this._eventSnapshot.clear();
      this.currentJobId = null;
      this.currentImageUrl = null;
      this._jobState = null;
    }
    logger.info('SelfiePopup', `Fitur selfie diubah: ${this.selfieEnabled ? 'ON' : 'OFF'}`);
    return this.selfieEnabled;
  }

  isSelfieEnabled() {
    return this.selfieEnabled;
  }

  getOutputDir() {
    return this.outputDir;
  }

  async openGalleryFolder() {
    try {
      if (!fs.existsSync(this.outputDir)) {
        fs.mkdirSync(this.outputDir, { recursive: true });
      }
      const error = await this.dependencies.shell.openPath(this.outputDir);
      return error ? { ok: false, error } : { ok: true };
    } catch (err) {
      logger.error('SelfiePopup', 'Gagal membuka folder galeri:', { error: err.message });
      return { ok: false, error: err.message };
    }
  }

  _getOrCreateWindow() {
    if (this.popupWindow && !this.popupWindow.isDestroyed()) {
      return this.popupWindow;
    }

    const preloadPath = path.resolve(__dirname, '../preload/selfiePreload.cjs');
    const htmlPath = path.resolve(__dirname, '../popup/selfiePopup.html');

    const config = this.dependencies.config;
    const win = new this.dependencies.BrowserWindow({
      width: config.selfiePopup?.toastWidth ?? 320,
      height: config.selfiePopup?.toastHeight ?? 120,
      frame: false,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
      webPreferences: {
        preload: preloadPath,
        partition: 'selfie-popup',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.popupWindow = win;
    this._popupReady = false;
    this._pendingEvents = [...this._eventSnapshot.values()];

    // Keamanan ketat & proteksi tangkapan layar (Point 17 & 20)
    this.popupWindow.setContentProtection(true);
    this.popupWindow.setAlwaysOnTop(true, config.selfiePopup?.alwaysOnTopLevel || 'screen-saver');
    this.popupWindow.setIgnoreMouseEvents(false); // TIDAK click-through, tombol dapat diklik
    this.onContentProtectionUpdated?.();
    win.on('show', () => this.onContentProtectionUpdated?.());
    win.webContents.session?.setPermissionCheckHandler(() => false);
    win.webContents.session?.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-frame-navigate', (event) => event.preventDefault());
    win.webContents.on('will-redirect', (event) => event.preventDefault());
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.on('did-start-loading', () => {
      this._popupReady = false;
      this._clearHideTimer();
      this._pendingEvents = [...this._eventSnapshot.values()];
    });

    win.loadFile(htmlPath, { query: { imageOrigin: this.backendOrigin || '' } }).catch((err) => {
      logger.error('SelfiePopup', 'Failed to load popup:', { error: err.message });
      if (!win.isDestroyed()) win.destroy();
    });

    win.on('closed', () => {
      if (this.popupWindow === win) {
        this._clearHideTimer();
        this.popupWindow = null;
        this._popupReady = false;
        this._pendingEvents = [];
      }
    });

    return this.popupWindow;
  }

  /**
   * Posisikan jendela dekat avatar tanpa menutupinya, dibatasi di work area monitor aktif (Point 17).
   */
  positionNearAvatar(targetWidth, targetHeight, zoomed = false) {
    if (!this.popupWindow || this.popupWindow.isDestroyed()) return;
    if (!Number.isFinite(targetWidth) || !Number.isFinite(targetHeight) || targetWidth <= 0 || targetHeight <= 0) return;

    let overlayBounds = { x: 100, y: 100, width: 400, height: 600 };
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      overlayBounds = this.overlayWindow.getBounds();
    }

    const currentDisplay = this.dependencies.screen.getDisplayMatching(overlayBounds);
    const workArea = currentDisplay.workArea;
    const margin = Math.min(8, workArea.width / 4, workArea.height / 4);
    const config = this.dependencies.config.selfiePopup;
    const widthFraction = zoomed ? Math.min(0.8, config?.zoomMaxWidthPercent ?? 0.8) : 1;
    const heightFraction = zoomed ? Math.min(0.8, config?.zoomMaxHeightPercent ?? 0.8) : 1;
    targetWidth = Math.max(1, Math.min(targetWidth, workArea.width * widthFraction, workArea.width - margin * 2));
    targetHeight = Math.max(1, Math.min(targetHeight, workArea.height * heightFraction, workArea.height - margin * 2));
    this._isZoomed = zoomed;

    // Deteksi apakah avatar berada di paruh kanan atau kiri monitor
    const avatarCenterX = overlayBounds.x + overlayBounds.width / 2;
    const screenCenterX = workArea.x + workArea.width / 2;
    const isAvatarOnRight = avatarCenterX >= screenCenterX;

    let targetX = 0;
    if (isAvatarOnRight) {
      // Tempatkan di sisi kiri avatar
      targetX = overlayBounds.x - targetWidth - 14;
    } else {
      // Tempatkan di sisi kanan avatar
      targetX = overlayBounds.x + overlayBounds.width + 14;
    }

    // Posisikan sejajar bagian atas dada / bahu avatar
    let targetY = overlayBounds.y + 40;

    // Batasi strictly di dalam workArea monitor aktif
    const minX = workArea.x + margin;
    const maxX = workArea.x + workArea.width - targetWidth - margin;
    const minY = workArea.y + margin;
    const maxY = workArea.y + workArea.height - targetHeight - margin;

    // Prefer a free side when clamping would otherwise overlap the avatar.
    const candidates = [
      { x: overlayBounds.x - targetWidth - 14, y: targetY },
      { x: overlayBounds.x + overlayBounds.width + 14, y: targetY },
      { x: targetX, y: overlayBounds.y - targetHeight - 14 },
      { x: targetX, y: overlayBounds.y + overlayBounds.height + 14 },
    ];
    const freePosition = candidates.map(({ x, y }) => ({
      x: Math.max(minX, Math.min(x, maxX)),
      y: Math.max(minY, Math.min(y, maxY)),
    })).find(({ x, y }) => x + targetWidth <= overlayBounds.x || x >= overlayBounds.x + overlayBounds.width
      || y + targetHeight <= overlayBounds.y || y >= overlayBounds.y + overlayBounds.height);
    if (freePosition) ({ x: targetX, y: targetY } = freePosition);

    targetX = Math.max(minX, Math.min(targetX, maxX));
    targetY = Math.max(minY, Math.min(targetY, maxY));

    this.popupWindow.setBounds({
      x: Math.round(targetX),
      y: Math.round(targetY),
      width: Math.floor(targetWidth),
      height: Math.floor(targetHeight),
    });
    return this.popupWindow.getBounds();
  }

  /**
   * Tangani event WebSocket selfie_* dan sinkronkan dengan UI popup.
   */
  handleSelfieEvent(event) {
    const types = ['selfie_started', 'selfie_progress', 'selfie_ready', 'selfie_failed', 'selfie_cancelled'];
    if (this._destroyed || !event || !types.includes(event.type)
      || typeof event.jobId !== 'string' || !event.jobId || event.jobId.length > 128) return false;
    if (event.type === 'selfie_started' && event.status === 'queued') return false;
    if (!this.currentJobId && !['selfie_started', 'selfie_ready'].includes(event.type)) return false;
    const imageUrl = event.type === 'selfie_ready' ? this._resolveImageUrl(event.imageUrl) : null;
    if (event.type === 'selfie_ready' && !imageUrl) {
      if (event.jobId === this.currentJobId && this._jobState === 'running') {
        return this.handleSelfieEvent({ type: 'selfie_failed', jobId: event.jobId, reason: 'Alamat foto tidak valid.' });
      }
      return false;
    }

    if (!this.selfieEnabled) {
      logger.info('SelfiePopup', 'Event selfie diabaikan karena fitur dimatikan lewat tray');
      return false;
    }

    if (event.jobId !== this.currentJobId) {
      if (this._previousJobs.has(event.jobId) || (event.type !== 'selfie_started' && this.currentJobId)) return false;
      if (this.currentJobId) this._previousJobs.add(this.currentJobId);
      if (this._previousJobs.size > 100) this._previousJobs.delete(this._previousJobs.values().next().value);
      this.currentJobId = event.jobId;
      this._jobState = null;
      this.currentImageUrl = null;
      this._pendingEvents = [];
      this._eventSnapshot.clear();
      this._clearHideTimer();
    }
    if (event.type === 'selfie_started' && this._jobState && this._jobState !== 'running') return false;
    if (event.type === 'selfie_progress' && this._jobState !== 'running') return false;
    if (['selfie_failed', 'selfie_cancelled'].includes(event.type) && this._jobState !== 'running') return false;
    if (event.type === 'selfie_ready' && this._jobState && !['running', 'ready'].includes(this._jobState)) return false;

    const previousWindow = this.popupWindow;
    const win = this._getOrCreateWindow();
    const config = this.dependencies.config.selfiePopup;

    switch (event.type) {
      case 'selfie_started': {
        this._clearHideTimer();
        this._jobState = 'running';
        const width = config?.toastWidth ?? 320;
        const height = config?.toastHeight ?? 120;
        this.positionNearAvatar(width, height);
        win.showInactive();
        this._sendPopupEvent(event);
        break;
      }

      case 'selfie_progress': {
        if (win !== previousWindow) {
          this.positionNearAvatar(config?.toastWidth ?? 320, config?.toastHeight ?? 120);
          win.showInactive();
        }
        this._sendPopupEvent(event);
        break;
      }

      case 'selfie_ready': {
        this._clearHideTimer();
        this.currentImageUrl = imageUrl;
        this._jobState = 'ready';
        const width = config?.cardWidth ?? 360;
        const height = config?.cardHeight ?? 520;
        const bounds = this.positionNearAvatar(width, height);
        win.showInactive();
        this._sendPopupEvent({
          ...event,
          imageUrl,
          replaceJob: true,
          cardSize: { width: bounds.width, height: bounds.height },
          autoCloseSeconds: config?.autoCloseSeconds ?? 30,
        });
        break;
      }

      case 'selfie_failed':
      case 'selfie_cancelled': {
        this._jobState = event.type;
        this._clearHideTimer();
        this._sendPopupEvent(event);
        break;
      }
    }
    return true;
  }

  _sendPopupEvent(event) {
    if (event.type === 'selfie_ready') this._eventSnapshot.clear();
    this._eventSnapshot.set(event.type, event);
    if (this._popupReady && this.popupWindow && !this.popupWindow.isDestroyed()) {
      this.popupWindow.webContents.send('selfie:event-to-popup', event);
      if (['selfie_failed', 'selfie_cancelled'].includes(event.type)) {
        const win = this.popupWindow;
        const jobId = event.jobId;
        this._clearHideTimer();
        this._hideTimer = setTimeout(() => {
          this._hideTimer = null;
          if (this.currentJobId === jobId && this.popupWindow === win && !win.isDestroyed()) win.hide();
        }, 1200);
        this._hideTimer.unref?.();
      }
      return;
    }
    this._pendingEvents = this._pendingEvents.filter(({ type }) => type !== event.type);
    this._pendingEvents.push(event);
  }

  _clearHideTimer() {
    if (this._hideTimer) clearTimeout(this._hideTimer);
    this._hideTimer = null;
  }

  _hidePopup() {
    this._clearHideTimer();
    if (this.popupWindow && !this.popupWindow.isDestroyed()) this.popupWindow.hide();
  }

  _isTrustedSender(event, window) {
    return Boolean(window && !window.isDestroyed() && event?.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame);
  }

  _resolveImageUrl(value) {
    if (!this.backendOrigin || typeof value !== 'string') return null;
    try {
      const url = new URL(value, this.backendOrigin);
      if (url.origin !== this.backendOrigin || url.username || url.password || url.search || url.hash
        || !/^\/api\/selfies\/[a-f0-9]{32}$/.test(url.pathname)) return null;
      return url.href;
    } catch { return null; }
  }

  async _fetchImage(imageUrl) {
    const targetUrl = this._resolveImageUrl(imageUrl);
    if (!targetUrl || targetUrl !== this.currentImageUrl || this._jobState !== 'ready') throw new Error('Invalid selfie image');
    const response = await this.dependencies.fetch(targetUrl, { redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  _registerIpcHandlers() {
    if (this._ipcRegistered) return;
    this._ipcRegistered = true;
    const { ipcMain } = this.dependencies;
    this._relayHandler = (event, data) => {
      if (this._isTrustedSender(event, this.overlayWindow)) this.handleSelfieEvent(data);
    };
    ipcMain.on('desktop:selfie-event', this._relayHandler);
    const handle = (channel, callback) => {
      const handler = async (event, ...args) => {
        if (!this._isTrustedSender(event, this.popupWindow)) return { ok: false, error: 'Untrusted sender' };
        return callback(...args);
      };
      this._ipcHandlers.set(channel, handler);
      ipcMain.handle(channel, handler);
    };

    handle('selfie:popup-ready', () => {
      this._popupReady = true;
      const pendingEvents = this._pendingEvents;
      this._pendingEvents = [];
      pendingEvents.forEach((event) => this._sendPopupEvent(event));
      return { ok: true };
    });

    // Batalkan job
    handle('selfie:cancel-job', async (jobId) => {
      if (jobId !== this.currentJobId || this._jobState !== 'running') return { ok: false, cancelled: false, error: 'No active job' };
      logger.info('SelfiePopup', `Membatalkan job selfie: ${jobId}`);
      try {
        const sent = typeof this.webSocketSender === 'function'
          && await this.webSocketSender({ type: 'selfie_cancel', jobId });
        return { ok: sent === true, cancelled: sent === true };
      } catch (err) {
        return { ok: false, cancelled: false, error: err.message };
      }
    });

    // Simpan gambar (Save As)
    handle('selfie:save-image', async (imageUrl) => {
      try {
        if (!this._resolveImageUrl(imageUrl) || this._resolveImageUrl(imageUrl) !== this.currentImageUrl
          || this._jobState !== 'ready') throw new Error('Invalid selfie image');
        const defaultFilename = `amika_selfie_${Date.now()}.png`;
        const { canceled, filePath } = await this.dependencies.dialog.showSaveDialog(this.popupWindow, {
          title: 'Simpan Foto Amika',
          defaultPath: path.join(os.homedir(), 'Pictures', defaultFilename),
          filters: [{ name: 'Images', extensions: ['png', 'jpg'] }],
        });

        if (canceled || !filePath) return { saved: false, cancelled: true };

        const image = await this._fetchImage(imageUrl);
        await fs.promises.writeFile(filePath, image);

        logger.info('SelfiePopup', `Foto berhasil disimpan ke: ${filePath}`);
        return { saved: true, filePath };
      } catch (err) {
        logger.error('SelfiePopup', 'Gagal menyimpan foto:', { error: err.message });
        return { saved: false, error: err.message };
      }
    });

    // Salin gambar ke clipboard via nativeImage
    handle('selfie:copy-image', async (imageUrl) => {
      try {
        const buffer = await this._fetchImage(imageUrl);
        const img = this.dependencies.nativeImage.createFromBuffer(buffer);
        if (img.isEmpty()) throw new Error('Invalid selfie image data');
        this.dependencies.clipboard.writeImage(img);

        logger.info('SelfiePopup', 'Foto berhasil disalin ke clipboard');
        return { copied: true };
      } catch (err) {
        logger.error('SelfiePopup', 'Gagal menyalin foto ke clipboard:', { error: err.message });
        return { copied: false, error: err.message };
      }
    });

    // Buka folder output
    handle('selfie:open-folder', () => this.openGalleryFolder());

    // Tutup popup
    handle('selfie:close-popup', () => {
      this._hidePopup();
      return { ok: true };
    });

    // Resize popup secara dinamis
    handle('selfie:resize-popup', (size) => {
      if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)
        || size.width <= 0 || size.height <= 0 || this._jobState !== 'ready') return { ok: false };
      const bounds = this.positionNearAvatar(size.width, size.height, size.zoomed !== false);
      return { ok: true, bounds };
    });
  }

  destroy() {
    this._destroyed = true;
    this._clearHideTimer();
    for (const eventName of ['display-added', 'display-removed', 'display-metrics-changed']) {
      this.dependencies.screen.removeListener(eventName, this._reposition);
    }
    this.overlayWindow?.removeListener('move', this._reposition);
    this.overlayWindow?.removeListener('resize', this._reposition);
    for (const channel of this._ipcHandlers.keys()) this.dependencies.ipcMain.removeHandler(channel);
    this._ipcHandlers.clear();
    if (this._relayHandler) this.dependencies.ipcMain.removeListener('desktop:selfie-event', this._relayHandler);
    this._ipcRegistered = false;
    if (this.popupWindow && !this.popupWindow.isDestroyed()) this.popupWindow.destroy();
    this.popupWindow = null;
    this.overlayWindow = null;
    this.webSocketSender = null;
    this._pendingEvents = [];
    this._eventSnapshot.clear();
  }
}

export const selfieWindowManager = new SelfieWindowManager();
