import { CONFIG } from './config.js';
import { logger } from './logger.js';

let trustedOrigins = new Set();
let trustedDesktopWindow = null;

export function registerTrustedDesktopWindow(win) {
  trustedDesktopWindow = win;
}

/**
 * Inisialisasi daftar origin lokal yang dipercaya (dev Vite maupun server statis lokal produksi).
 */
export function registerTrustedOrigin(urlStr) {
  try {
    const parsed = new URL(urlStr);
    trustedOrigins.add(parsed.origin);
    // Tambahkan ekuivalen localhost <-> 127.0.0.1 pada port yang sama
    if (parsed.hostname === 'localhost') {
      trustedOrigins.add(`${parsed.protocol}//127.0.0.1:${parsed.port}`);
    } else if (parsed.hostname === '127.0.0.1') {
      trustedOrigins.add(`${parsed.protocol}//localhost:${parsed.port}`);
    }
    logger.info('Security', 'Origin lokal terdaftar sebagai trusted', {
      origins: Array.from(trustedOrigins),
    });
  } catch (err) {
    logger.error('Security', `Gagal mem-parsing origin: ${urlStr}`, { error: err.message });
  }
}

// Daftarkan default frontendUrl sejak awal
registerTrustedOrigin(CONFIG.frontendUrl);

/**
 * Memeriksa apakah sebuah URL string berasal dari origin lokal yang diizinkan.
 */
export function isTrustedUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol === 'file:') {
      return true;
    }
    return trustedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

/**
 * Validasi pengirim di setiap handler IPC (ipcMain.handle / ipcMain.on).
 * Menolak eksekusi jika pengirim bukan main frame atau berasal dari origin asing.
 */
export function assertTrustedSender(event, channelName = 'unknown') {
  const senderFrame = event?.senderFrame;
  const senderUrl = senderFrame?.url || event?.sender?.getURL?.() || '';

  if (!trustedDesktopWindow || trustedDesktopWindow.isDestroyed()
    || event?.sender !== trustedDesktopWindow.webContents
    || senderFrame !== trustedDesktopWindow.webContents.mainFrame
    || !isTrustedUrl(senderUrl)) {
    logger.warn('Security', `Menolak IPC '${channelName}' dari pengirim tidak dikenal`, {
      senderUrl,
    });
    throw new Error(`Untrusted IPC sender for channel: ${channelName}`);
  }
  return true;
}

/**
 * Pasang Content Security Policy (CSP) dan permission handler pada session Electron.
 */
export function configureSessionSecurity(session) {
  const backendOrigin = (() => {
    try {
      return new URL(CONFIG.backendUrl).origin;
    } catch {
      return 'http://localhost:8787';
    }
  })();

  const backendWsOrigin = backendOrigin.replace(/^http/, 'ws');

  // 1. Permission Check & Request Handler: Hanya izinkan 'media' (mic) dari origin lokal
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const urlToCheck = requestingOrigin || webContents?.getURL() || '';
    if (permission === 'media' && isTrustedUrl(urlToCheck)) {
      return true;
    }
    return false;
  });

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const reqUrl = details?.requestingUrl || webContents?.getURL() || '';
    if (permission === 'media' && isTrustedUrl(reqUrl)) {
      logger.info('Security', 'Mengizinkan akses media (mikrofon) untuk origin lokal', {
        reqUrl,
      });
      callback(true);
      return;
    }

    logger.warn('Security', 'Menolak permintaan permission', {
      permission,
      reqUrl,
    });
    callback(false);
  });

  // 2. Content Security Policy (CSP)
  session.webRequest.onHeadersReceived((details, callback) => {
    // Hanya terapkan CSP pada dokumen utama/subresource dari origin lokal kita
    if (!isTrustedUrl(details.url)) {
      callback({ cancel: false });
      return;
    }

    const allowedOriginsList = Array.from(trustedOrigins).join(' ');
    const allowedWsList = Array.from(trustedOrigins)
      .map((o) => o.replace(/^http/, 'ws'))
      .join(' ');

    const csp = [
      `default-src 'self' ${allowedOriginsList}`,
      // 'unsafe-inline' & 'wasm-unsafe-eval' diperlukan oleh Vite HMR (dev) dan Live2D Cubism Core WASM/JS
      `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' 'unsafe-eval' ${allowedOriginsList}`,
      `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com ${allowedOriginsList}`,
      `font-src 'self' data: https://fonts.gstatic.com`,
      `img-src 'self' data: blob: ${allowedOriginsList}`,
      `media-src 'self' data: blob:`,
      `connect-src 'self' ${allowedOriginsList} ${allowedWsList} ${backendOrigin} ${backendWsOrigin} ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*`,
      `object-src 'none'`,
      `base-uri 'self'`,
      `frame-ancestors 'none'`,
    ].join('; ');

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

/**
 * Kunci navigasi BrowserWindow agar tidak pernah bisa diarahkan ke situs eksternal/remote.
 */
export function hardenWindowNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    logger.warn('Security', 'Memblokir pembukaan jendela baru (window.open)', { url });
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isTrustedUrl(targetUrl)) {
      logger.warn('Security', 'Memblokir navigasi ke URL eksternal', { targetUrl });
      event.preventDefault();
    }
  });
}
