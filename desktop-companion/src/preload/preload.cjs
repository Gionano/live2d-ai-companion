const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script (sandboxed: true, contextIsolation: true, nodeIntegration: false).
 * Mengekspos API sempit window.desktopBridge ke renderer tanpa membocorkan
 * objek ipcRenderer mentah atau variabel environment.
 */
const desktopBridge = Object.freeze({
  isDesktopCompanion: true,

  /**
   * Mengambil informasi dasar aplikasi & konfigurasi runtime non-rahasia (FPS overlay, mode, versi).
   */
  getAppInfo: () => ipcRenderer.invoke('desktop:get-app-info'),

  /**
   * Mengambil state overlay saat ini (preset aktif, konfigurasi framing, status editMode & clickThrough).
   */
  getOverlayState: () => ipcRenderer.invoke('desktop:get-overlay-state'),

  /**
   * Mengganti preset tampilan overlay ('with-wings' | 'without-wings').
   */
  setOverlayPreset: (presetId) => ipcRenderer.invoke('desktop:set-overlay-preset', presetId),

  /**
   * Mengaktifkan atau mematikan Mode Edit Posisi & Ukuran dari UI overlay.
   */
  setEditMode: (enabled) => ipcRenderer.invoke('desktop:set-edit-mode', Boolean(enabled)),

  /**
   * Mereset posisi & ukuran preset aktif ke pojok kanan bawah monitor saat ini.
   */
  resetOverlayBounds: () => ipcRenderer.invoke('desktop:reset-overlay-bounds'),

  /**
   * Menggeser posisi jendela overlay secara langsung (mendukung koordinat di luar/tembus border Windows).
   */
  moveOverlayWindow: (x, y) =>
    ipcRenderer.send('desktop:move-overlay-window', {
      x: Math.round(Number(x) || 0),
      y: Math.round(Number(y) || 0),
    }),

  /**
   * Mengaktifkan atau mematikan mute mikrofon dari renderer.
   */
  setMuteMic: (enabled) => ipcRenderer.invoke('desktop:set-mute-mic', Boolean(enabled)),

  /**
   * Mengaktifkan atau mematikan Screen Vision dari renderer.
   */
  setScreenVision: (enabled) => ipcRenderer.invoke('desktop:set-screen-vision', Boolean(enabled)),

  /**
   * Mengambil daftar seluruh display/monitor yang sedang terhubung (Fase 4 Poin 16).
   */
  getDisplays: () => ipcRenderer.invoke('desktop:get-displays'),

  /**
   * Mengambil tangkapan layar langsung tanpa popup izin browser (Fase 4 Poin 14-17).
   * @param {{ displayId?: number|string, maxWidth?: number }} [options]
   * @returns {Promise<{ base64: string, dataUrl: string, width: number, height: number, displayId: number }>}
   */
  captureScreen: async (options = {}) => {
    const safeOptions = {};
    if (options && typeof options === 'object') {
      if (options.displayId !== undefined && options.displayId !== null) {
        safeOptions.displayId = options.displayId;
      }
      if (options.maxWidth !== undefined && options.maxWidth !== null) {
        safeOptions.maxWidth = Number(options.maxWidth);
      }
    }
    const res = await ipcRenderer.invoke('desktop:capture-screen', safeOptions);
    if (res && res.ok === false) {
      const err = new Error(res.error?.message || 'Gagal melakukan capture layar.');
      err.code = res.error?.code || 'CAPTURE_ERROR';
      err.spokenMessage =
        res.error?.spokenMessage || 'layarnya tidak bisa kulihat, coba mode borderless';
      if (res.error?.retryAfterMs) err.retryAfterMs = res.error.retryAfterMs;
      throw err;
    }
    return res?.data ?? res;
  },

  /**
   * Subscribe to microphone mute changes and their revision/active shortcut.
   */
  onMuteMicChanged: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, muted, details) => callback(muted, details);
    ipcRenderer.on('desktop:mute-mic-changed', handler);
    return () => ipcRenderer.removeListener('desktop:mute-mic-changed', handler);
  },

  // Report only microphone/indicator state; never expose a raw Electron object.
  reportMicState: (state) => ipcRenderer.send('desktop:mic-state-applied', {
    revision: Number(state?.revision),
    muted: state?.muted === true,
    captureActive: state?.captureActive === true,
    recording: state?.recording === true,
    indicatorMuted: state?.indicatorMuted === true,
  }),

  /**
   * Berlangganan event perubahan state/preset/ukuran overlay dari main process.
   */
  onOverlayStateChanged: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('desktop:overlay-state-changed', handler);
    return () => ipcRenderer.removeListener('desktop:overlay-state-changed', handler);
  },

  /**
   * Mengirim data diagnostik overlay dari renderer ke file log main process.
   */
  reportOverlayDiagnostics: (payload) =>
    ipcRenderer.invoke('desktop:report-overlay-diagnostics', payload),

  /**
   * Mengirim event selfie_* dari WebSocket renderer ke main process agar popup Electron tampil.
   */
  notifySelfieEvent: (event) => ipcRenderer.send('desktop:selfie-event', event),

  // Return whether a narrow selfie command reached the connected backend socket.
  onSelfieCommand: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = async (_event, payload) => {
      let sent = false;
      try {
        if (payload?.message?.type === 'selfie_cancel') sent = await callback(payload.message) === true;
      } catch {}
      ipcRenderer.send('desktop:selfie-command-result', { requestId: payload?.requestId, sent });
    };
    ipcRenderer.on('desktop:selfie-command', handler);
    return () => ipcRenderer.removeListener('desktop:selfie-command', handler);
  },

  /**
   * Berlangganan permintaan pembatalan selfie dari popup window untuk diteruskan ke WebSocket backend.
   */
  onSelfieCancelRequested: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('desktop:selfie-cancel-requested', handler);
    return () => ipcRenderer.removeListener('desktop:selfie-cancel-requested', handler);
  },
});

contextBridge.exposeInMainWorld('desktopBridge', desktopBridge);
