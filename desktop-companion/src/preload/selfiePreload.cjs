const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script khusus Popup Selfie (Fase D Poin 20).
 * Keamanan ketat: sandboxed, contextIsolation: true, nodeIntegration: false.
 * Hanya mengekspos API sempit window.selfieApi tanpa akses Node.js atau remote content.
 */
contextBridge.exposeInMainWorld('selfieApi', {
  // Flush buffered events only after the popup has installed its listener.
  ready: () => ipcRenderer.invoke('selfie:popup-ready'),

  // Berlangganan event perubahan status dari main process
  onSelfieEvent: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('selfie:event-to-popup', handler);
    return () => ipcRenderer.removeListener('selfie:event-to-popup', handler);
  },

  // Batalkan proses generasi gambar
  cancelJob: (jobId) => ipcRenderer.invoke('selfie:cancel-job', jobId),

  // Simpan gambar (Save As via dialog native)
  saveImage: (imageUrl) => ipcRenderer.invoke('selfie:save-image', imageUrl),

  // Salin gambar ke clipboard via nativeImage
  copyImage: (imageUrl) => ipcRenderer.invoke('selfie:copy-image', imageUrl),

  // Buka folder output di Windows Explorer
  openFolder: () => ipcRenderer.invoke('selfie:open-folder'),

  // Tutup popup
  closePopup: () => ipcRenderer.invoke('selfie:close-popup'),

  // Ubah ukuran jendela popup secara aman dari UI
  resizeWindow: (width, height, zoomed = true) => ipcRenderer.invoke('selfie:resize-popup', { width, height, zoomed }),
});
