import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Portrait defaults for Witch; the renderer measures the rig for fitting.
const WITCH_DEFAULT_WIDTH = 420;
const WITCH_DEFAULT_HEIGHT = 640;
const WITCH_ASPECT_RATIO = WITCH_DEFAULT_WIDTH / WITCH_DEFAULT_HEIGHT;

/**
 * Konfigurasi terpusat untuk Amika Desktop Companion.
 * Seluruh konstanta tuning (FPS, preset tampilan overlay, ukuran jendela, kualitas JPEG,
 * rate limit, shortcut) disimpan di satu file ini agar mudah diubah dan didiagnosis.
 */
export const CONFIG = {
  // URL Frontend & Backend (Mode Dev vs Produksi)
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  backendUrl: process.env.BACKEND_URL || 'http://localhost:8787',

  // Opsi menyalakan backend otomatis sebagai child process (default: false / off)
  spawnBackend: process.env.SPAWN_BACKEND === 'true',
  backendScriptPath: path.resolve(__dirname, '../../../server/index.js'),
  backendWorkingDir: path.resolve(__dirname, '../../..'),

  // Konfigurasi Jendela Normal (Fase 0 / mode non-overlay)
  normalWindow: {
    width: 1120,
    height: 760,
  },

  // Konfigurasi Jendela Overlay & Preset Tampilan (Fase 1 & 2)
  overlay: {
    defaultPreset: 'witch',
    defaultWidth: WITCH_DEFAULT_WIDTH,
    defaultHeight: WITCH_DEFAULT_HEIGHT,
    minWidth: 260,
    minHeight: 340,
    marginRight: 16,
    marginBottom: 16,
    fpsLimit: 30,
    subtitleHideDelayMs: 6500,
    alwaysOnTopLevel: 'screen-saver',
    contentProtection: true,

    // Fit the Witch rig without overriding its ear or accessory controls.
    fitPadding: 0.04,
    hiddenHalfBodyPartIds: [],
    presets: {
      witch: {
        id: 'witch',
        label: 'Penyihir',
        defaultWidth: WITCH_DEFAULT_WIDTH,
        defaultHeight: WITCH_DEFAULT_HEIGHT,
        aspectRatio: WITCH_ASPECT_RATIO,
        minWidth: 260,
        minHeight: Math.round(260 / WITCH_ASPECT_RATIO),
        framing: {
          padding: 0.04,
          scaleMultiplier: 1.0,
          offsetX: 0.0,
          offsetY: 0.0,
          motionMargin: { left: 0.016, right: 0.016, top: 0.022, bottom: 0.010 },
        },
      },
    },
  },

  // Konfigurasi Capture Layar Langsung (Fase 4 & 5)
  capture: {
    maxDimensionPx: 1280,
    jpegQuality: 75, // 0 - 100
    rateLimitMs: 500, // maksimal 1 capture per 500 ms
    initialProtectionDelayMs: 400, // jeda komposisi DWM setelah setContentProtection(true)
    wsRequestTimeoutMs: 5000, // timeout backend menunggu screen_frame
    blackFrameLumaThreshold: 3.5, // ambang rata-rata luma untuk deteksi layar hitam/DRM
    blackFrameSampleStep: 16, // langkah sampling piksel untuk pengecekan cepat
  },

  // Defaults used to create userData/shortcuts.json on first launch.
  shortcuts: {
    toggleMuteMic: {
      preferred: 'Control+Alt+Shift+M',
      fallbacks: ['Control+Alt+Shift+F9', 'Control+Alt+Shift+F10'],
    },
    toggleEditMode: {
      preferred: 'Control+Alt+E',
      fallbacks: ['Control+Alt+Shift+E', 'Control+Alt+Shift+F11'],
    },
    toggleAvatarVisibility: {
      preferred: 'Control+Alt+H',
      fallbacks: ['Control+Alt+Shift+H', 'Control+Alt+Shift+F12'],
    },
  },

  // Konfigurasi Popup Selfie / PAP (Fase D)
  selfiePopup: {
    enabled: true,
    autoCloseSeconds: 30, // 0 = tidak auto close
    toastWidth: 320,
    toastHeight: 120,
    cardWidth: 360,
    cardHeight: 520,
    zoomMaxWidthPercent: 0.8, // Maksimal 80% work area layar
    zoomMaxHeightPercent: 0.8,
    alwaysOnTopLevel: 'screen-saver',
    contentProtection: true,
  },

  // Nama file persistensi di app.getPath('userData')
  storage: {
    logDirName: 'logs',
    logFileName: 'companion.log',
    windowStateFileName: 'window-state.json',
    shortcutConfigFileName: 'shortcuts.json',
  },
};
