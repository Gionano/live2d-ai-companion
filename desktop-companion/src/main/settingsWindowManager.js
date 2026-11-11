export function settingsMenuItem(open) { return { label: 'Settings…', click: open }; }

export class SettingsWindowManager {
  constructor({ BrowserWindow }) { this.BrowserWindow = BrowserWindow; this.window = null; }
  async open(frontendUrl) {
    const url = new URL(frontendUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password) throw new Error('Settings require a loopback frontend.');
    url.search = ''; url.hash = 'settings';
    if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); return; }
    const win = new this.BrowserWindow({ width: 1040, height: 800, minWidth: 360, minHeight: 480,
      show: false, autoHideMenuBar: true, backgroundColor: '#F7F4FC',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, partition: 'settings-ui' } });
    this.window = win;
    win.setContentProtection(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event, target) => {
      try {
        const next = new URL(target);
        if (next.origin === url.origin && next.pathname === url.pathname && !next.search) return;
      } catch {}
      event.preventDefault();
    };
    win.webContents.on('will-navigate', guard);
    win.webContents.on('will-redirect', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.webContents.session.setPermissionCheckHandler(() => false);
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' " + url.origin.replace(/^http/, 'ws') + "; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"],
    } }));
    win.on('closed', () => { if (this.window === win) this.window = null; });
    win.once('ready-to-show', () => win.show());
    try { await win.loadURL(url.href); }
    catch { win.close(); throw new Error('Settings frontend could not be loaded.'); }
  }
  close() { if (this.window && !this.window.isDestroyed()) this.window.close(); }
}
