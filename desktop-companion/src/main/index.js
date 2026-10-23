import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, globalShortcut, ipcMain, screen, session } from 'electron';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import {
  assertTrustedSender,
  configureSessionSecurity,
  hardenWindowNavigation,
  registerTrustedOrigin,
  registerTrustedDesktopWindow,
} from './security.js';
import { startProductionStaticServer } from './staticServer.js';
import { clampBoundsToWorkArea, windowStateStore } from './windowStateStore.js';
import { TrayManager } from './trayManager.js';
import { loadShortcutConfig, registerShortcuts } from './shortcutManager.js';
import { captureService } from './captureService.js';
import { selfieWindowManager } from './selfieWindowManager.js';
import { resolveLocalSelfieOutputDir } from './selfieOutputDir.js';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Izinkan WebAudio / TTS autoplay tanpa harus menunggu klik pertama di dalam jendela
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Dukungan pengujian multi-DPI (100%, 125%, 150%) lewat env FORCE_DEVICE_SCALE_FACTOR
if (process.env.FORCE_DEVICE_SCALE_FACTOR) {
  app.commandLine.appendSwitch('high-dpi-support', '1');
  app.commandLine.appendSwitch(
    'force-device-scale-factor',
    String(process.env.FORCE_DEVICE_SCALE_FACTOR),
  );
}

// 1. Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  logger.warn('Main', 'Another instance is already running; exiting this launch without registering shortcuts.', {
    logFile: logger.getLogFilePath(),
  });
  app.quit();
  process.exit(0);
}

let overlayWindow = null;
let backendProcess = null;
let staticServerInstance = null;
let trayManager = null;
let shortcutStates = {};
let muteRevision = 0;
let focusRequested = false;
let isApplyingProgrammaticBounds = false;
const selfieCommands = new Map();

function sendSelfieCommand(message) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      selfieCommands.delete(requestId);
      resolve(false);
    }, 2000);
    selfieCommands.set(requestId, { resolve, timer });
    try {
      overlayWindow.webContents.send('desktop:selfie-command', { requestId, message });
    } catch {
      clearTimeout(timer);
      selfieCommands.delete(requestId);
      resolve(false);
    }
  });
}

async function resolveSelfieOutputDir() {
  return resolveLocalSelfieOutputDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    serverRoot: CONFIG.backendWorkingDir,
    configPath: process.env.SELFIE_CONFIG_PATH,
  });
}

/**
 * Opsi opsional (default: off) untuk menjalankan backend sebagai child process.
 * Diaktifkan hanya jika env SPAWN_BACKEND=true.
 */
function maybeSpawnBackend() {
  if (!CONFIG.spawnBackend) {
    logger.info('Backend', 'SPAWN_BACKEND=false (default). Menggunakan backend eksternal.');
    return;
  }

  if (!fs.existsSync(CONFIG.backendScriptPath)) {
    logger.error('Backend', 'File server/index.js tidak ditemukan untuk SPAWN_BACKEND', {
      scriptPath: CONFIG.backendScriptPath,
    });
    return;
  }

  logger.info('Backend', 'Menjalankan backend sebagai child process...', {
    script: CONFIG.backendScriptPath,
    cwd: CONFIG.backendWorkingDir,
  });

  backendProcess = spawn(process.execPath, [CONFIG.backendScriptPath], {
    cwd: CONFIG.backendWorkingDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  backendProcess.stdout?.on('data', (chunk) => {
    logger.info('BackendChild', chunk.toString().trim());
  });

  backendProcess.stderr?.on('data', (chunk) => {
    logger.warn('BackendChild', chunk.toString().trim());
  });

  backendProcess.on('exit', (code, signal) => {
    logger.info('Backend', 'Child process backend berhenti', { code, signal });
    backendProcess = null;
  });
}

function stopBackendProcess() {
  if (!backendProcess) return;
  logger.info('Backend', 'Menghentikan child process backend...');
  try {
    backendProcess.kill();
  } catch (err) {
    logger.error('Backend', 'Gagal menghentikan child process backend', { error: err.message });
  }
  backendProcess = null;
}

/**
 * Menambahkan query parameter ?mode=overlay pada URL frontend.
 */
function appendOverlayQuery(baseUrl) {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set('mode', 'overlay');
  return parsed.toString();
}

/**
 * Menentukan sumber URL frontend:
 * - Mode Dev: memuat FRONTEND_URL (default http://localhost:5173) + ?mode=overlay
 * - Mode Produksi: memuat build statis dari folder resources/frontend-dist + ?mode=overlay
 */
async function resolveFrontendEntryUrl(useOverlayMode = true) {
  const isDevMode = !app.isPackaged && process.env.USE_STATIC_BUILD !== 'true';
  if (isDevMode) {
    registerTrustedOrigin(CONFIG.frontendUrl);
    const targetUrl = useOverlayMode
      ? appendOverlayQuery(CONFIG.frontendUrl)
      : CONFIG.frontendUrl;
    logger.info('Main', 'Mode Dev aktif: memuat URL frontend Vite', {
      url: targetUrl,
    });
    return { type: 'url', target: targetUrl };
  }

  // Mode Produksi: cari di process.resourcesPath/frontend-dist terlebih dahulu
  const resourcesDistPath = path.join(process.resourcesPath, 'frontend-dist');
  const localDistFallback = path.resolve(__dirname, '../../../dist');
  const staticDir = fs.existsSync(resourcesDistPath) ? resourcesDistPath : localDistFallback;

  if (!fs.existsSync(path.join(staticDir, 'index.html'))) {
    logger.error('Main', 'Build statis frontend tidak ditemukan di folder resources!', {
      resourcesDistPath,
      localDistFallback,
    });
    throw new Error(`Static frontend build not found at ${staticDir}`);
  }

  try {
    const { server, url } = await startProductionStaticServer(staticDir);
    staticServerInstance = server;
    registerTrustedOrigin(url);
    const targetUrl = useOverlayMode ? appendOverlayQuery(url) : url;
    return { type: 'url', target: targetUrl };
  } catch (err) {
    logger.warn('Main', 'Fallback ke loadFile langsung karena server statis gagal dibuat', {
      error: err.message,
    });
    return {
      type: 'file',
      target: path.join(staticDir, 'index.html'),
      query: useOverlayMode ? { mode: 'overlay' } : undefined,
    };
  }
}

/**
 * Mempertahankan flag keamanan & properti jendela overlay:
 * - setContentProtection(true)
 * - setAlwaysOnTop(true, 'screen-saver')
 * - setIgnoreMouseEvents sesuai status clickThrough & editMode
 * - setResizable & setAspectRatio sesuai preset aktif
 */
function enforceOverlayWindowFlags() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const snapshot = windowStateStore.getSnapshot();
  const preset = snapshot.presetConfig;
  const effectiveClickThrough = Boolean(snapshot.clickThrough && !snapshot.editMode);

  if (CONFIG.overlay.contentProtection) {
    overlayWindow.setContentProtection(true);
  }
  overlayWindow.setAlwaysOnTop(true, CONFIG.overlay.alwaysOnTopLevel);
  overlayWindow.setResizable(Boolean(snapshot.editMode));

  if (preset?.aspectRatio) {
    overlayWindow.setAspectRatio(preset.aspectRatio);
  }

  if (effectiveClickThrough) {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    overlayWindow.setIgnoreMouseEvents(false);
  }
}

/**
 * Mengirimkan snapshot state overlay terbaru ke renderer via IPC.
 */
function broadcastOverlayState(reason = 'state-updated') {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    const snapshot = {
      ...windowStateStore.getSnapshot(),
      muteRevision,
      shortcuts: shortcutStates,
      editShortcut: shortcutStates.toggleEditMode?.activeLabel || null,
      reason,
      windowBounds: overlayWindow.getBounds(),
    };
    overlayWindow.webContents.send('desktop:overlay-state-changed', snapshot);
  }
  trayManager?.rebuildMenu();
}

/**
 * Menerapkan bounds ke overlayWindow secara aman di Windows tanpa tertahan
 * oleh kunci aspectRatio atau resizable=false dari preset sebelumnya.
 */
function applyBoundsToOverlayWindow(targetBounds, presetConfig) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  isApplyingProgrammaticBounds = true;
  try {
    overlayWindow.setAspectRatio(0);
    overlayWindow.setMinimumSize(
      presetConfig.minWidth || CONFIG.overlay.minWidth,
      presetConfig.minHeight || CONFIG.overlay.minHeight,
    );
    const wasResizable = overlayWindow.isResizable();
    if (!wasResizable) overlayWindow.setResizable(true);

    overlayWindow.setBounds(
      {
        x: Math.round(targetBounds.x),
        y: Math.round(targetBounds.y),
        width: Math.round(targetBounds.width),
        height: Math.round(targetBounds.height),
      },
      false,
    );

    if (!wasResizable) overlayWindow.setResizable(false);
    if (presetConfig.aspectRatio) {
      overlayWindow.setAspectRatio(presetConfig.aspectRatio);
    }
  } finally {
    isApplyingProgrammaticBounds = false;
  }
  enforceOverlayWindowFlags();
}

/**
 * Mengganti preset tampilan ('with-wings' | 'without-wings'):
 * 1. Simpan posisi/ukuran preset sebelumnya
 * 2. Ambil & validasi posisi/ukuran preset baru agar tetap di dalam workArea monitor
 * 3. Terapkan ukuran, kunci rasio aspek, dan pertahankan click-through, always-on-top, contentProtection
 * 4. Beritahu renderer agar mengganti status sayap & menghitung ulang Fit-to-Bounds
 */
function switchOverlayPreset(newPresetId, reason = 'preset-switched') {
  if (!CONFIG.overlay.presets[newPresetId]) {
    logger.warn('Main', 'Preset tidak dikenal saat switchOverlayPreset', { newPresetId });
    return null;
  }

  // Simpan posisi/ukuran preset yang sedang aktif sebelum berpindah
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    const currentPresetId = windowStateStore.getActivePresetId();
    const currentBounds = overlayWindow.getBounds();
    windowStateStore.updatePresetBounds(currentPresetId, currentBounds, true);
  }

  const { presetId, presetConfig, bounds } = windowStateStore.setActivePreset(newPresetId);
  applyBoundsToOverlayWindow(bounds, presetConfig);

  logger.info('Main', 'Preset tampilan overlay diubah', {
    presetId,
    label: presetConfig.label,
    showWings: presetConfig.showWings,
    wingParamValue: presetConfig.wingParamValue,
    bounds,
    aspectRatio: presetConfig.aspectRatio,
  });

  broadcastOverlayState(reason);
  return windowStateStore.getSnapshot();
}

/**
 * Mengatur status Mode Edit (Fase 2 Poin 9):
 * - Saat aktif (true): mouse events aktif (setIgnoreMouseEvents(false)), jendela bisa digeser & di-resize
 *   dengan rasio aspek terkunci sesuai preset.
 * - Saat keluar (false): otomatis menyimpan posisi & ukuran terbaru ke userData (per monitor & per preset),
 *   mengunci kembali ukuran jendela, dan mengaktifkan kembali Click-Through (setIgnoreMouseEvents(true, { forward: true })).
 */
function applyEditModeState(enabled, reason = 'toggle-edit-mode') {
  const nextEditMode = Boolean(enabled);

  if (!nextEditMode && overlayWindow && !overlayWindow.isDestroyed()) {
    const presetId = windowStateStore.getActivePresetId();
    const preset = windowStateStore.getActivePresetConfig();
    const rawBounds = overlayWindow.getBounds();
    const clamped = windowStateStore.updatePresetBounds(presetId, rawBounds, true);
    applyBoundsToOverlayWindow(clamped, preset);
  }

  windowStateStore.setEditMode(nextEditMode);
  enforceOverlayWindowFlags();

  const currentBounds =
    overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow.getBounds() : null;
  logger.info(
    'Main',
    nextEditMode
      ? 'Mode Edit diaktifkan: mouse events aktif, jendela dapat digeser & di-resize.'
      : 'Mode Edit dinonaktifkan: posisi disimpan & Click-Through aktif kembali.',
    {
      reason,
      editMode: nextEditMode,
      clickThrough: Boolean(windowStateStore.state.clickThrough && !nextEditMode),
      activePreset: windowStateStore.getActivePresetId(),
      activeDisplayId: windowStateStore.state.activeDisplayId,
      bounds: currentBounds,
    },
  );

  broadcastOverlayState(reason);
  return {
    ...windowStateStore.getSnapshot(),
    windowBounds: currentBounds,
  };
}

/**
 * Mereset posisi & ukuran preset aktif ke pojok kanan bawah workArea monitor aktif.
 */
function resetActivePresetBounds(reason = 'reset-bounds') {
  const presetId = windowStateStore.getActivePresetId();
  const preset = windowStateStore.getActivePresetConfig();
  const freshBounds = windowStateStore.resetPresetBounds(presetId);
  applyBoundsToOverlayWindow(freshBounds, preset);
  logger.info('Main', 'Ukuran & posisi preset di-reset ke default', {
    reason,
    presetId,
    freshBounds,
  });
  broadcastOverlayState(reason);
  return {
    ...windowStateStore.getSnapshot(),
    windowBounds: freshBounds,
  };
}

/**
 * Mengumpulkan diagnostik jendela dari Main Process (DIP, fisik, scaleFactor, workArea).
 */
function getMainWindowDiagnostics() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return null;
  const dipBounds = overlayWindow.getBounds();
  const contentBounds = overlayWindow.getContentBounds();
  const display = screen.getDisplayMatching(dipBounds);
  const scaleFactor = display?.scaleFactor ?? 1;
  return {
    activePreset: windowStateStore.getActivePresetId(),
    dipBounds,
    contentBounds,
    physicalSize: {
      width: Math.round(dipBounds.width * scaleFactor),
      height: Math.round(dipBounds.height * scaleFactor),
    },
    displayId: display?.id,
    scaleFactor,
    forcedScaleFactor: process.env.FORCE_DEVICE_SCALE_FACTOR
      ? Number(process.env.FORCE_DEVICE_SCALE_FACTOR)
      : null,
    workArea: display?.workArea,
    alwaysOnTop: overlayWindow.isAlwaysOnTop(),
    clickThrough: Boolean(
      windowStateStore.state.clickThrough && !windowStateStore.state.editMode,
    ),
    editMode: Boolean(windowStateStore.state.editMode),
    contentProtection: Boolean(CONFIG.overlay.contentProtection),
  };
}

/**
 * Registrasi IPC Handlers dengan validasi pengirim ketat di setiap handler.
 */
function registerIpcHandlers() {
  ipcMain.on('desktop:selfie-command-result', (event, payload) => {
    try {
      assertTrustedSender(event, 'desktop:selfie-command-result');
    } catch { return; }
    const pending = selfieCommands.get(payload?.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    selfieCommands.delete(payload.requestId);
    pending.resolve(payload.sent === true);
  });
  ipcMain.handle('desktop:get-app-info', (event) => {
    assertTrustedSender(event, 'desktop:get-app-info');
    return {
      name: app.getName(),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      overlayFpsLimit: CONFIG.overlay.fpsLimit,
      subtitleHideDelayMs: CONFIG.overlay.subtitleHideDelayMs,
    };
  });

  ipcMain.handle('desktop:get-overlay-state', (event) => {
    assertTrustedSender(event, 'desktop:get-overlay-state');
    return {
      ...windowStateStore.getSnapshot(),
      muteRevision,
      shortcuts: shortcutStates,
      editShortcut: shortcutStates.toggleEditMode?.activeLabel || null,
      windowBounds: overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow.getBounds() : null,
    };
  });

  ipcMain.on('desktop:mic-state-applied', (event, payload) => {
    try {
      assertTrustedSender(event, 'desktop:mic-state-applied');
    } catch { return; }
    if (!payload || payload.revision !== muteRevision || payload.muted !== windowStateStore.state.muteMic) return;
    const report = {
      revision: muteRevision,
      muted: payload.muted,
      captureActive: payload.captureActive === true,
      recording: payload.recording === true,
      indicatorMuted: payload.indicatorMuted === true,
    };
    const applied = !report.muted || (!report.captureActive && !report.recording && report.indicatorMuted);
    logger[applied ? 'info' : 'warn']('Mic', 'Renderer applied microphone state', report);
    trayManager?.rebuildMenu();
  });

  ipcMain.handle('desktop:set-overlay-preset', (event, presetId) => {
    assertTrustedSender(event, 'desktop:set-overlay-preset');
    return switchOverlayPreset(String(presetId || ''), 'ipc-set-preset');
  });

  ipcMain.handle('desktop:set-edit-mode', (event, enabled) => {
    assertTrustedSender(event, 'desktop:set-edit-mode');
    return applyEditModeState(Boolean(enabled), 'ipc-set-edit-mode');
  });

  ipcMain.handle('desktop:reset-overlay-bounds', (event) => {
    assertTrustedSender(event, 'desktop:reset-overlay-bounds');
    return resetActivePresetBounds('ipc-reset-bounds');
  });

  ipcMain.handle('desktop:set-mute-mic', (event, enabled) => {
    assertTrustedSender(event, 'desktop:set-mute-mic');
    toggleMuteMic(Boolean(enabled), 'ipc-set-mute-mic');
    return windowStateStore.state.muteMic;
  });

  ipcMain.handle('desktop:set-screen-vision', (event, enabled) => {
    assertTrustedSender(event, 'desktop:set-screen-vision');
    toggleScreenVision(Boolean(enabled), 'ipc-set-screen-vision');
    return windowStateStore.state.screenVision;
  });

  ipcMain.handle('desktop:get-displays', (event) => {
    assertTrustedSender(event, 'desktop:get-displays');
    return captureService.getDisplays();
  });

  ipcMain.handle('desktop:capture-screen', async (event, options) => {
    assertTrustedSender(event, 'desktop:capture-screen');
    try {
      const data = await captureService.captureScreen(options || {});
      return { ok: true, data };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: err.code || 'CAPTURE_ERROR',
          message: err.message || 'Gagal melakukan capture layar.',
          spokenMessage:
            err.spokenMessage || 'layarnya tidak bisa kulihat, coba mode borderless',
          retryAfterMs: err.retryAfterMs || null,
        },
      };
    }
  });

  ipcMain.on('desktop:move-overlay-window', (event, payload) => {
    try {
      assertTrustedSender(event, 'desktop:move-overlay-window');
    } catch {
      return;
    }
    if (!overlayWindow || overlayWindow.isDestroyed() || !payload) return;
    const rawX = Math.round(Number(payload.x));
    const rawY = Math.round(Number(payload.y));
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return;

    const currentBounds = overlayWindow.getBounds();
    const presetId = windowStateStore.getActivePresetId();
    const clamped = clampBoundsToWorkArea(
      {
        x: rawX,
        y: rawY,
        width: currentBounds.width,
        height: currentBounds.height,
      },
      presetId,
      false,
    );

    overlayWindow.setBounds(
      {
        x: clamped.x,
        y: clamped.y,
        width: currentBounds.width,
        height: currentBounds.height,
      },
      false,
    );
  });

  ipcMain.handle('desktop:report-overlay-diagnostics', async (event, rendererDiag) => {
    assertTrustedSender(event, 'desktop:report-overlay-diagnostics');
    const windowDiag = getMainWindowDiagnostics();
    const fullReport = {
      window: windowDiag,
      renderer: rendererDiag,
    };
    logger.info('OverlayDiag', 'Diagnostik Jendela & Live2D Overlay', fullReport);

    if (process.env.CAPTURE_DIAG_PNG && overlayWindow && !overlayWindow.isDestroyed()) {
      try {
        const img = await overlayWindow.webContents.capturePage();
        fs.mkdirSync(path.dirname(process.env.CAPTURE_DIAG_PNG), { recursive: true });
        fs.writeFileSync(process.env.CAPTURE_DIAG_PNG, img.toPNG());
        logger.info('OverlayDiag', 'Saved diagnostic PNG', {
          path: process.env.CAPTURE_DIAG_PNG,
          preset: windowDiag?.activePreset,
          scaleFactor: windowDiag?.scaleFactor,
        });
      } catch (err) {
        logger.error('OverlayDiag', 'Failed to capture diagnostic PNG', { error: err.message });
      }
      setTimeout(() => app.quit(), 250);
    }

    if (process.env.TEST_CAPTURE_SCREEN_PATH && overlayWindow && !overlayWindow.isDestroyed()) {
      try {
        const rendererTest = await overlayWindow.webContents.executeJavaScript(`
          (async () => {
            const displays = await window.desktopBridge.getDisplays();
            const shot = await window.desktopBridge.captureScreen();
            let rateLimitErrorCode = null;
            try {
              await window.desktopBridge.captureScreen();
            } catch (e) {
              rateLimitErrorCode = e.code || e.message;
            }
            return { displays, shot, rateLimitErrorCode };
          })()
        `);
        const shot = rendererTest.shot;
        fs.mkdirSync(path.dirname(process.env.TEST_CAPTURE_SCREEN_PATH), { recursive: true });
        fs.writeFileSync(process.env.TEST_CAPTURE_SCREEN_PATH, Buffer.from(shot.base64, 'base64'));
        logger.info('CaptureTest', 'Saved Fase 4 renderer desktopBridge.captureScreen() JPEG (avatar excluded)', {
          path: process.env.TEST_CAPTURE_SCREEN_PATH,
          width: shot.width,
          height: shot.height,
          displayId: shot.displayId,
          avgLuma: shot.avgLuma,
          base64Length: shot.base64.length,
          displaysCount: rendererTest.displays?.length,
          rateLimitCheck: rendererTest.rateLimitErrorCode,
        });
      } catch (err) {
        logger.error('CaptureTest', 'Failed Fase 4 direct screen capture test', {
          code: err.code,
          error: err.message,
          spokenMessage: err.spokenMessage,
        });
      }
      setTimeout(() => app.quit(), 250);
    }

    return fullReport;
  });
}

async function createOverlayWindow() {
  const preloadPath = path.join(__dirname, '../preload/preload.cjs');
  windowStateStore.load();

  if (process.env.TEST_EDIT_MODE === 'true') {
    windowStateStore.setEditMode(true);
  }

  const activePresetId = windowStateStore.getActivePresetId();
  const presetConfig = windowStateStore.getActivePresetConfig();
  const initialBounds = windowStateStore.getPresetBounds(activePresetId);
  const entry = await resolveFrontendEntryUrl(true);

  overlayWindow = new BrowserWindow({
    x: initialBounds.x,
    y: initialBounds.y,
    width: initialBounds.width,
    height: initialBounds.height,
    minWidth: presetConfig.minWidth || CONFIG.overlay.minWidth,
    minHeight: presetConfig.minHeight || CONFIG.overlay.minHeight,
    enableLargerThanScreen: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    backgroundColor: '#00000000',
    title: 'Amika Overlay Companion',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  const trustedOverlayUrl = entry.type === 'file' ? pathToFileURL(entry.target).href : entry.target;
  registerTrustedOrigin(trustedOverlayUrl);
  registerTrustedDesktopWindow(overlayWindow, trustedOverlayUrl);
  selfieWindowManager.init({
    overlayWindow,
    webSocketSender: sendSelfieCommand,
    resolveOutputDir: resolveSelfieOutputDir,
    trustedOverlayUrl,
    onContentProtectionUpdated: () => captureService.markContentProtectionUpdated(),
  });
  selfieWindowManager.setSelfieEnabled(windowStateStore.state.selfieEnabled);

  // WAJIB (Fase 4 Poin 15): panggil setContentProtection(true) SEGERA saat jendela overlay dibuat
  // jauh sebelum capture pertama supaya avatar tidak ikut tertangkap.
  enforceOverlayWindowFlags();
  captureService.markContentProtectionUpdated();

  overlayWindow.on('show', () => {
    if (CONFIG.overlay.contentProtection && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setContentProtection(true);
    }
    captureService.markContentProtectionUpdated();
  });

  hardenWindowNavigation(overlayWindow);

  // Tangani perubahan posisi & ukuran jendela (termasuk saat mode edit atau pindah monitor/DPI)
  let boundsSaveTimer = null;
  const handleWindowGeometryChange = (eventType) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || isApplyingProgrammaticBounds) return;
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (!overlayWindow || overlayWindow.isDestroyed() || isApplyingProgrammaticBounds) return;
      const presetId = windowStateStore.getActivePresetId();
      const preset = windowStateStore.getActivePresetConfig();
      const rawBounds = overlayWindow.getBounds();
      const isResize = eventType === 'window-resized';
      const clamped = windowStateStore.updatePresetBounds(presetId, rawBounds, isResize);

      if (
        Math.abs(clamped.x - rawBounds.x) > 2 ||
        Math.abs(clamped.y - rawBounds.y) > 2 ||
        (isResize &&
          (Math.abs(clamped.width - rawBounds.width) > 2 ||
            Math.abs(clamped.height - rawBounds.height) > 2))
      ) {
        applyBoundsToOverlayWindow(clamped, preset);
      } else {
        enforceOverlayWindowFlags();
      }
      broadcastOverlayState(eventType);
    }, 120);
  };

  overlayWindow.on('moved', () => handleWindowGeometryChange('window-moved'));
  overlayWindow.on('resized', () => handleWindowGeometryChange('window-resized'));

  if (entry.type === 'file') {
    await overlayWindow.loadFile(entry.target, entry.query ? { query: entry.query } : undefined);
  } else {
    await overlayWindow.loadURL(entry.target);
  }

  if (process.argv.includes('--devtools')) {
    overlayWindow.webContents.openDevTools({ mode: 'detach' });
  }

  overlayWindow.on('closed', () => {
    selfieWindowManager.destroy();
    overlayWindow = null;
  });

  logger.info('Main', 'Jendela Overlay Transparan berhasil dimuat (Fase 4 - Capture Layar Langsung)', {
    entry: entry.target,
    activePreset: activePresetId,
    activeDisplayId: windowStateStore.state.activeDisplayId,
    bounds: initialBounds,
    aspectRatio: presetConfig.aspectRatio,
    clickThrough: Boolean(windowStateStore.state.clickThrough && !windowStateStore.state.editMode),
    editMode: Boolean(windowStateStore.state.editMode),
    contentProtection: Boolean(CONFIG.overlay.contentProtection),
    alwaysOnTopLevel: CONFIG.overlay.alwaysOnTopLevel,
    logFile: logger.getLogFilePath(),
  });
}

function setupDisplayChangeListeners() {
  const revalidateOnDisplayChange = (reason) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const presetId = windowStateStore.getActivePresetId();
    const preset = windowStateStore.getActivePresetConfig();
    const currentBounds = overlayWindow.getBounds();
    const clamped = windowStateStore.updatePresetBounds(presetId, currentBounds, true);
    applyBoundsToOverlayWindow(clamped, preset);
    logger.info('Main', 'Perubahan monitor/DPI terdeteksi; posisi & ukuran divalidasi ulang', {
      reason,
      presetId,
      clamped,
    });
    broadcastOverlayState(reason);
  };

  screen.on('display-metrics-changed', (_event, _display, changedMetrics) => {
    revalidateOnDisplayChange(`display-metrics-changed:${changedMetrics.join(',')}`);
  });
  screen.on('display-added', () => revalidateOnDisplayChange('display-added'));
  screen.on('display-removed', () => revalidateOnDisplayChange('display-removed'));
}

function setupGlobalShortcuts() {
  const filePath = process.env.DESKTOP_SHORTCUTS_PATH
    ? path.resolve(process.env.DESKTOP_SHORTCUTS_PATH)
    : path.join(app.getPath('userData'), CONFIG.storage.shortcutConfigFileName);
  const shortcuts = loadShortcutConfig({ filePath, defaults: CONFIG.shortcuts, logger });
  shortcutStates = registerShortcuts({
    globalShortcut,
    shortcuts,
    logger,
    notify: (title, body) => trayManager?.notify(title, body),
    handlers: {
      toggleEditMode: {
      label: 'Mode Edit',
      handler: (accelerator) => {
        const next = !windowStateStore.state.editMode;
        applyEditModeState(next, `shortcut:${accelerator}`);
      },
      },
      toggleMuteMic: {
      label: 'Mute Mikrofon',
      handler: (accelerator) => {
        const next = !windowStateStore.state.muteMic;
        toggleMuteMic(next, `shortcut:${accelerator}`);
      },
      },
      toggleAvatarVisibility: {
      label: 'Tampilkan/Sembunyikan Avatar',
      handler: (accelerator) => {
        if (!overlayWindow || overlayWindow.isDestroyed()) return;
        if (overlayWindow.isVisible()) {
          overlayWindow.hide();
        } else {
          overlayWindow.show();
          enforceOverlayWindowFlags();
        }
        broadcastOverlayState(`shortcut:${accelerator}`);
      },
      },
    },
  });
  broadcastOverlayState('shortcuts-registered');
}

/**
 * Mengaktifkan atau mematikan mute mikrofon.
 * Mengirimkan status ke renderer via IPC agar pipeline mic/VAD ikut berhenti/jalan.
 */
function toggleMuteMic(enabled, reason = 'toggle-mute-mic') {
  const muted = windowStateStore.setMuteMic(enabled);
  muteRevision += 1;
  logger.info('Main', 'Microphone mute toggled; sending renderer IPC', { muteMic: muted, reason, revision: muteRevision });
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('desktop:mute-mic-changed', muted, {
      revision: muteRevision,
      shortcut: shortcutStates.toggleMuteMic?.activeLabel || null,
    });
  }
  broadcastOverlayState(reason);
}

/**
 * Mengaktifkan atau mematikan Screen Vision (capture layar).
 */
function toggleScreenVision(enabled, reason = 'toggle-screen-vision') {
  const active = windowStateStore.setScreenVision(enabled);
  logger.info('Main', 'Status Screen Vision diubah', { screenVision: active, reason });
  broadcastOverlayState(reason);
}

/**
 * Pindahkan overlay ke monitor tertentu (memulihkan posisi tersimpan di monitor tsb atau pojok kanan bawah).
 */
function selectMonitor(displayId, reason = 'select-monitor') {
  const allDisplays = screen.getAllDisplays();
  const targetDisplay = allDisplays.find((d) => String(d.id) === String(displayId));
  if (!targetDisplay) {
    logger.warn('Main', 'Monitor yang dipilih tidak ditemukan', { displayId });
    return;
  }

  const presetId = windowStateStore.getActivePresetId();
  const preset = windowStateStore.getActivePresetConfig();

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    windowStateStore.updatePresetBounds(presetId, overlayWindow.getBounds(), false);
  }

  const savedOnTarget = windowStateStore.state.byDisplay?.[String(targetDisplay.id)]?.presets?.[presetId];
  const targetBounds = savedOnTarget
    ? windowStateStore.updatePresetBounds(
        presetId,
        { ...savedOnTarget, displayId: targetDisplay.id },
        true,
      )
    : windowStateStore.resetPresetBounds(presetId, targetDisplay);

  applyBoundsToOverlayWindow(targetBounds, preset);
  logger.info('Main', 'Overlay dipindahkan ke monitor yang dipilih', {
    reason,
    displayId: targetDisplay.id,
    bounds: targetBounds,
  });
  broadcastOverlayState(reason);
}

function setupSystemTray() {
  trayManager = new TrayManager({
    getState: () => ({
      activePreset: windowStateStore.getActivePresetId(),
      activeDisplayId: windowStateStore.state.activeDisplayId,
      editMode: windowStateStore.state.editMode,
      clickThrough: windowStateStore.state.clickThrough,
      muteMic: windowStateStore.state.muteMic,
      shortcuts: shortcutStates,
      screenVision: windowStateStore.state.screenVision,
      selfieEnabled: windowStateStore.state.selfieEnabled,
      isVisible: Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()),
    }),
    onToggleVisible: () => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      if (overlayWindow.isVisible()) {
        overlayWindow.hide();
      } else {
        overlayWindow.show();
        enforceOverlayWindowFlags();
      }
      trayManager?.rebuildMenu();
    },
    onSelectPreset: (presetId) => {
      switchOverlayPreset(presetId, 'tray-select-preset');
    },
    onSelectMonitor: (displayId) => {
      selectMonitor(displayId, 'tray-select-monitor');
    },
    onToggleEditMode: (enabled) => {
      applyEditModeState(enabled, 'tray-toggle-edit-mode');
    },
    onToggleClickThrough: (enabled) => {
      windowStateStore.setClickThrough(enabled);
      enforceOverlayWindowFlags();
      logger.info('Main', 'Status Click-Through diubah dari tray', { clickThrough: enabled });
      broadcastOverlayState('tray-toggle-click-through');
    },
    onToggleMuteMic: (enabled) => {
      toggleMuteMic(enabled, 'tray-toggle-mute-mic');
    },
    onToggleScreenVision: (enabled) => {
      toggleScreenVision(enabled, 'tray-toggle-screen-vision');
    },
    onToggleSelfie: (enabled) => {
      const active = windowStateStore.setSelfieEnabled(enabled);
      selfieWindowManager.setSelfieEnabled(active);
      broadcastOverlayState('tray-toggle-selfie');
    },
    onOpenSelfieGallery: () => {
      void selfieWindowManager.openGalleryFolder().then((result) => {
        if (!result.ok) trayManager?.notify('Galeri Pap', 'Folder foto belum bisa dibuka.');
      });
    },
    onResetPresetBounds: () => {
      resetActivePresetBounds('tray-reset-bounds');
    },
    onQuit: () => {
      app.quit();
    },
  });

  trayManager.init();
}

function focusOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (overlayWindow.isMinimized()) overlayWindow.restore();
    overlayWindow.show();
    enforceOverlayWindowFlags();
    overlayWindow.focus();
    focusRequested = false;
  } else {
    focusRequested = true;
  }
}

app.on('second-instance', () => {
  logger.info('Main', 'Second launch detected; focusing the first instance. No shortcuts will be registered by the second instance.');
  focusOverlayWindow();
});

app.whenReady().then(async () => {
  logger.info('Main', 'Amika Desktop Companion mulai dijalankan (Fase 4 - Capture Layar Langsung)', {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    userData: app.getPath('userData'),
    logFile: logger.getLogFilePath(),
  });

  maybeSpawnBackend();
  configureSessionSecurity(session.defaultSession);
  registerIpcHandlers();
  setupDisplayChangeListeners();

  try {
    await createOverlayWindow();
    setupSystemTray();
    captureService.init((title, body) => trayManager?.notify(title, body));
    setupGlobalShortcuts();
    if (focusRequested) focusOverlayWindow();
  } catch (err) {
    logger.error('Main', 'Gagal membuat jendela overlay', { error: err.message });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
  } catch {
    // Abaikan error saat unregister shortcut
  }
});

app.on('before-quit', () => {
  selfieWindowManager.destroy();
  for (const { resolve, timer } of selfieCommands.values()) {
    clearTimeout(timer);
    resolve(false);
  }
  selfieCommands.clear();
  trayManager?.destroy();
  captureService.destroy();
  stopBackendProcess();
  if (staticServerInstance) {
    try {
      staticServerInstance.close();
    } catch {
      // Abaikan error saat penutupan server statis
    }
  }
});
