import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Rasio aspek model IceGirl dengan sayap (half-body: mahkota s/d ujung rok):
 * Lebar rentang sayap (dengan margin gerak idle): ~1.034 unit
 * Tinggi mahkota s/d ujung rok (dengan margin gerak idle): ~0.8515 unit
 * Rasio landscape = 1.034 / 0.8515 ≈ 1.2143
 */
const WITH_WINGS_DEFAULT_HEIGHT = 560;
const WITH_WINGS_ASPECT_RATIO = +(1.034 / 0.8515).toFixed(4); // 1.2143
const WITH_WINGS_DEFAULT_WIDTH = Math.round(WITH_WINGS_DEFAULT_HEIGHT * WITH_WINGS_ASPECT_RATIO); // 680

const WITHOUT_WINGS_DEFAULT_WIDTH = 420;
const WITHOUT_WINGS_DEFAULT_HEIGHT = 640;
const WITHOUT_WINGS_ASPECT_RATIO = +(WITHOUT_WINGS_DEFAULT_WIDTH / WITHOUT_WINGS_DEFAULT_HEIGHT).toFixed(4); // 0.6563

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
    defaultPreset: process.env.OVERLAY_PRESET || 'with-wings',
    defaultWidth: WITH_WINGS_DEFAULT_WIDTH,
    defaultHeight: WITH_WINGS_DEFAULT_HEIGHT,
    minWidth: 260,
    minHeight: 340,
    marginRight: 16,
    marginBottom: 16,
    fpsLimit: 30,
    subtitleHideDelayMs: 6500,
    alwaysOnTopLevel: 'screen-saver',
    contentProtection: true,

    // Parameter Fit-to-Bounds & Kontrol Sayap Model IceGirl
    fitPadding: 0.04, // 4% padding di setiap sisi canvas
    wingExpressionName: '翅膀', // File: 翅膀.exp3.json (Param41 = 1.0 -> MENYEMBUNYIKAN sayap)
    wingParameterId: 'Param41', // 0.0 = sayap tampil, 1.0 = sayap disembunyikan
    hiddenHalfBodyPartIds: [],

    presets: {
      'with-wings': {
        id: 'with-wings',
        label: 'Dengan sayap',
        showWings: true,
        wingParamValue: 0.0,
        defaultWidth: WITH_WINGS_DEFAULT_WIDTH, // 680 px (dihitung dari defaultHeight * aspectRatio)
        defaultHeight: WITH_WINGS_DEFAULT_HEIGHT, // 560 px (konstanta tinggi default)
        aspectRatio: WITH_WINGS_ASPECT_RATIO, // ~1.2143 (landscape)
        minWidth: Math.round(340 * WITH_WINGS_ASPECT_RATIO),
        minHeight: 340,
        framing: {
          padding: 0.04,
          scaleMultiplier: 1.0,
          offsetX: 0.0,
          offsetY: 0.0,
          motionMargin: {
            left: 0.016,
            right: 0.016,
            top: 0.022,
            bottom: 0.010,
          },
        },
      },
      'without-wings': {
        id: 'without-wings',
        label: 'Tanpa sayap',
        showWings: false,
        wingParamValue: 1.0, // Mengaktifkan arah ekspresi 翅膀.exp3.json untuk menyembunyikan sayap
        defaultWidth: WITHOUT_WINGS_DEFAULT_WIDTH, // 420 px
        defaultHeight: WITHOUT_WINGS_DEFAULT_HEIGHT, // 640 px (portrait)
        aspectRatio: WITHOUT_WINGS_ASPECT_RATIO, // 0.6563 (portrait)
        minWidth: 260,
        minHeight: Math.round(260 / WITHOUT_WINGS_ASPECT_RATIO),
        framing: {
          padding: 0.04,
          scaleMultiplier: 1.0,
          offsetX: 0.0,
          offsetY: 0.0,
          motionMargin: {
            left: 0.014,
            right: 0.014,
            top: 0.022,
            bottom: 0.010,
          },
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

  // Global Shortcuts Default (Fase 3)
  shortcuts: {
    toggleMuteMic: process.env.SHORTCUT_MUTE_MIC || 'CommandOrControl+Alt+M',
    toggleEditMode: process.env.SHORTCUT_EDIT_MODE || 'CommandOrControl+Alt+E',
    toggleAvatarVisibility: process.env.SHORTCUT_HIDE_AVATAR || 'CommandOrControl+Alt+H',
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
  },
};
