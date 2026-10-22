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
  constructor() {
    this.popupWindow = null;
    this.overlayWindow = null;
    this.webSocketSender = null;
    this.currentJobId = null;
    this.currentImageUrl = null;
    this.currentFilePath = null;
    this.outputDir = path.join(os.homedir(), 'Pictures', 'WaifuSelfies');
    this.selfieEnabled = true; // Status toggle dari tray
    this._ipcRegistered = false;
  }

  init({ overlayWindow, webSocketSender, outputDir }) {
    this.overlayWindow = overlayWindow;
    this.webSocketSender = webSocketSender;
    if (outputDir) this.outputDir = outputDir;
    this._registerIpcHandlers();
  }

  setSelfieEnabled(enabled) {
    this.selfieEnabled = Boolean(enabled);
    logger.info('SelfiePopup', `Fitur selfie diubah: ${this.selfieEnabled ? 'ON' : 'OFF'}`);
  }

  isSelfieEnabled() {
    return this.selfieEnabled;
  }

  getOutputDir() {
    return this.outputDir;
  }

  openGalleryFolder() {
    try {
      if (!fs.existsSync(this.outputDir)) {
        fs.mkdirSync(this.outputDir, { recursive: true });
      }
      shell.openPath(this.outputDir);
    } catch (err) {
      logger.error('SelfiePopup', 'Gagal membuka folder galeri:', { error: err.message });
    }
  }

  _getOrCreateWindow() {
    if (this.popupWindow && !this.popupWindow.isDestroyed()) {
      return this.popupWindow;
    }

    const preloadPath = path.resolve(__dirname, '../preload/selfiePreload.cjs');
    const htmlPath = path.resolve(__dirname, '../popup/selfiePopup.html');

    this.popupWindow = new BrowserWindow({
      width: CONFIG.selfiePopup?.toastWidth || 320,
      height: CONFIG.selfiePopup?.toastHeight || 120,
      frame: false,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Keamanan ketat & proteksi tangkapan layar (Point 17 & 20)
    this.popupWindow.setContentProtection(true);
    this.popupWindow.setAlwaysOnTop(true, CONFIG.selfiePopup?.alwaysOnTopLevel || 'screen-saver');
    this.popupWindow.setIgnoreMouseEvents(false); // TIDAK click-through, tombol dapat diklik

    this.popupWindow.loadFile(htmlPath);

    this.popupWindow.on('closed', () => {
      this.popupWindow = null;
    });

    return this.popupWindow;
  }

  /**
   * Posisikan jendela dekat avatar tanpa menutupinya, dibatasi di work area monitor aktif (Point 17).
   */
  positionNearAvatar(targetWidth, targetHeight) {
    if (!this.popupWindow || this.popupWindow.isDestroyed()) return;

    let overlayBounds = { x: 100, y: 100, width: 400, height: 600 };
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      overlayBounds = this.overlayWindow.getBounds();
    }

    const currentDisplay = screen.getDisplayMatching(overlayBounds);
    const workArea = currentDisplay.workArea;

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
    const minX = workArea.x + 8;
    const maxX = workArea.x + workArea.width - targetWidth - 8;
    const minY = workArea.y + 8;
    const maxY = workArea.y + workArea.height - targetHeight - 8;

    targetX = Math.max(minX, Math.min(targetX, maxX));
    targetY = Math.max(minY, Math.min(targetY, maxY));

    this.popupWindow.setBounds({
      x: Math.round(targetX),
      y: Math.round(targetY),
      width: Math.round(targetWidth),
      height: Math.round(targetHeight),
    });
  }

  /**
   * Tangani event WebSocket selfie_* dan sinkronkan dengan UI popup.
   */
  handleSelfieEvent(event) {
    if (!event || !event.type) return;

    if (!this.selfieEnabled) {
      logger.info('SelfiePopup', 'Event selfie diabaikan karena fitur dimatikan lewat tray');
      return;
    }

    const win = this._getOrCreateWindow();

    switch (event.type) {
      case 'selfie_started': {
        this.currentJobId = event.jobId;
        const width = CONFIG.selfiePopup?.toastWidth || 320;
        const height = CONFIG.selfiePopup?.toastHeight || 120;
        this.positionNearAvatar(width, height);
        win.showInactive();
        win.webContents.send('selfie:event-to-popup', event);
        break;
      }

      case 'selfie_progress': {
        if (win.isVisible()) {
          win.webContents.send('selfie:event-to-popup', event);
        }
        break;
      }

      case 'selfie_ready': {
        this.currentImageUrl = event.imageUrl;
        this.currentJobId = event.jobId;
        const width = CONFIG.selfiePopup?.cardWidth || 360;
        const height = CONFIG.selfiePopup?.cardHeight || 520;
        this.positionNearAvatar(width, height);
        win.showInactive();
        win.webContents.send('selfie:event-to-popup', {
          ...event,
          autoCloseSeconds: CONFIG.selfiePopup?.autoCloseSeconds || 30,
        });
        break;
      }

      case 'selfie_failed':
      case 'selfie_cancelled': {
        if (win.isVisible()) {
          win.webContents.send('selfie:event-to-popup', event);
        }
        setTimeout(() => {
          if (this.popupWindow && !this.popupWindow.isDestroyed()) {
            this.popupWindow.hide();
          }
        }, 1200);
        break;
      }
    }
  }

  _registerIpcHandlers() {
    if (this._ipcRegistered) return;
    this._ipcRegistered = true;

    // Batalkan job
    ipcMain.handle('selfie:cancel-job', async (_event, jobId) => {
      logger.info('SelfiePopup', `Membatalkan job selfie: ${jobId}`);
      if (typeof this.webSocketSender === 'function') {
        this.webSocketSender({ type: 'selfie_cancel', jobId });
      }
      return { ok: true };
    });

    // Simpan gambar (Save As)
    ipcMain.handle('selfie:save-image', async (_event, imageUrl) => {
      try {
        const defaultFilename = `amika_selfie_${Date.now()}.png`;
        const { canceled, filePath } = await dialog.showSaveDialog({
          title: 'Simpan Foto Amika',
          defaultPath: path.join(os.homedir(), 'Pictures', defaultFilename),
          filters: [{ name: 'Images', extensions: ['png', 'jpg'] }],
        });

        if (canceled || !filePath) return { saved: false };

        // Fetch gambar dari endpoint HTTP localhost
        const targetUrl = imageUrl.startsWith('http')
          ? imageUrl
          : `${CONFIG.backendUrl}${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
        const resp = await fetch(targetUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const arrayBuf = await resp.arrayBuffer();
        fs.writeFileSync(filePath, Buffer.from(arrayBuf));

        logger.info('SelfiePopup', `Foto berhasil disimpan ke: ${filePath}`);
        return { saved: true, filePath };
      } catch (err) {
        logger.error('SelfiePopup', 'Gagal menyimpan foto:', { error: err.message });
        return { saved: false, error: err.message };
      }
    });

    // Salin gambar ke clipboard via nativeImage
    ipcMain.handle('selfie:copy-image', async (_event, imageUrl) => {
      try {
        const targetUrl = imageUrl.startsWith('http')
          ? imageUrl
          : `${CONFIG.backendUrl}${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
        const resp = await fetch(targetUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const arrayBuf = await resp.arrayBuffer();
        const img = nativeImage.createFromBuffer(Buffer.from(arrayBuf));
        clipboard.writeImage(img);

        logger.info('SelfiePopup', 'Foto berhasil disalin ke clipboard');
        return { copied: true };
      } catch (err) {
        logger.error('SelfiePopup', 'Gagal menyalin foto ke clipboard:', { error: err.message });
        return { copied: false, error: err.message };
      }
    });

    // Buka folder output
    ipcMain.handle('selfie:open-folder', async () => {
      this.openGalleryFolder();
      return { ok: true };
    });

    // Tutup popup
    ipcMain.handle('selfie:close-popup', async () => {
      if (this.popupWindow && !this.popupWindow.isDestroyed()) {
        this.popupWindow.hide();
      }
      return { ok: true };
    });

    // Resize popup secara dinamis
    ipcMain.handle('selfie:resize-popup', async (_event, { width, height }) => {
      this.positionNearAvatar(width, height);
      return { ok: true };
    });
  }
}

export const selfieWindowManager = new SelfieWindowManager();
