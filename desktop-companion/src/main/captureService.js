import os from 'node:os';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { desktopCapturer, nativeImage, screen } from 'electron';
import { CONFIG } from './config.js';
import { logger } from './logger.js';
import { windowStateStore } from './windowStateStore.js';

/**
 * Worker PowerShell GDI persisten untuk laptop Hybrid GPU (Optimus / AMD Switchable Graphics)
 * di mana DXGI Desktop Duplication pada desktopCapturer.getSources mengembalikan thumbnail 0x0.
 *
 * Menggunakan PixelFormat.Format24bppRgb agar kanal Alpha tidak 0, dan tetap menghormati penuh
 * setContentProtection(true) (WDA_EXCLUDEFROMCAPTURE) di Windows 10 2004+ / Windows 11.
 */
class Win32GdiCaptureWorker {
  constructor() {
    this.proc = null;
    this.rl = null;
    this.ready = false;
    this.pendingQueue = [];
    this.initPromise = null;
  }

  ensureStarted() {
    if (process.platform !== 'win32') return Promise.resolve(false);
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve) => {
      try {
        const bootstrapScript = `
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public class GdiScreenCapturer {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetThreadDesktop(IntPtr hDesktop);

  public static string CaptureBase64Png(int x, int y, int srcW, int srcH, int dstW, int dstH) {
    string output = null;
    Exception caught = null;
    Thread t = new Thread(() => {
      try {
        IntPtr hDesk = OpenDesktop("Default", 0, false, 0x01FF);
        if (hDesk != IntPtr.Zero) {
          SetThreadDesktop(hDesk);
        }
        using (Bitmap srcBmp = new Bitmap(srcW, srcH, PixelFormat.Format24bppRgb)) {
          using (Graphics srcG = Graphics.FromImage(srcBmp)) {
            srcG.CopyFromScreen(x, y, 0, 0, new Size(srcW, srcH), CopyPixelOperation.SourceCopy);
          }
          using (Bitmap dstBmp = new Bitmap(dstW, dstH, PixelFormat.Format24bppRgb)) {
            using (Graphics dstG = Graphics.FromImage(dstBmp)) {
              dstG.InterpolationMode = InterpolationMode.Bilinear;
              dstG.DrawImage(srcBmp, 0, 0, dstW, dstH);
            }
            using (MemoryStream ms = new MemoryStream()) {
              dstBmp.Save(ms, ImageFormat.Png);
              output = Convert.ToBase64String(ms.ToArray());
            }
          }
        }
      } catch (Exception ex) {
        caught = ex;
      }
    });
    t.Start();
    t.Join();
    if (caught != null) throw caught;
    return output;
  }
}
"@
[void][GdiScreenCapturer]::SetProcessDPIAware()
[Console]::WriteLine("READY")
while (($cmd = [Console]::In.ReadLine()) -ne $null) {
  if ($cmd -eq "EXIT") { break }
  try {
    $parts = $cmd.Split(' ')
    $b64 = [GdiScreenCapturer]::CaptureBase64Png([int]$parts[0], [int]$parts[1], [int]$parts[2], [int]$parts[3], [int]$parts[4], [int]$parts[5])
    [Console]::WriteLine("OK " + $b64)
  } catch {
    [Console]::WriteLine("ERR " + $_.Exception.Message)
  }
}
`.trim();

        this.proc = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', bootstrapScript],
          {
            stdio: ['pipe', 'pipe', 'ignore'],
            windowsHide: true,
          },
        );

        this.rl = readline.createInterface({ input: this.proc.stdout });
        this.rl.on('line', (line) => {
          const trimmed = (line || '').trim();
          if (trimmed === 'READY') {
            this.ready = true;
            resolve(true);
            return;
          }
          const current = this.pendingQueue.shift();
          if (!current) return;

          if (trimmed.startsWith('OK ')) {
            const b64 = trimmed.slice(3).trim();
            current.resolve(b64);
          } else {
            current.reject(new Error(trimmed || 'GDI worker failed'));
          }
        });

        this.proc.on('exit', () => {
          this.ready = false;
          this.proc = null;
          this.initPromise = null;
          while (this.pendingQueue.length > 0) {
            const req = this.pendingQueue.shift();
            req.reject(new Error('GDI worker exited'));
          }
        });
      } catch {
        resolve(false);
      }
    });

    return this.initPromise;
  }

  async capture(targetDisplay, thumbWidth, thumbHeight) {
    const ok = await this.ensureStarted();
    if (!ok || !this.proc || !this.proc.stdin.writable) return null;

    const scaleFactor = targetDisplay.scaleFactor || 1;
    const physX = Math.round(targetDisplay.bounds.x * scaleFactor);
    const physY = Math.round(targetDisplay.bounds.y * scaleFactor);
    const physW = Math.max(1, Math.round(targetDisplay.bounds.width * scaleFactor));
    const physH = Math.max(1, Math.round(targetDisplay.bounds.height * scaleFactor));

    const b64 = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pendingQueue.findIndex((item) => item.resolve === resolve);
        if (idx >= 0) this.pendingQueue.splice(idx, 1);
        reject(new Error('GDI capture timeout'));
      }, 5000);

      this.pendingQueue.push({
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.proc.stdin.write(`${physX} ${physY} ${physW} ${physH} ${thumbWidth} ${thumbHeight}\n`);
    });

    if (!b64) return null;
    return nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
  }

  destroy() {
    if (this.proc) {
      try {
        this.proc.stdin.write('EXIT\n');
        this.proc.kill();
      } catch {
        // Abaikan error saat menghentikan worker
      }
      this.proc = null;
    }
  }
}

const gdiWorker = new Win32GdiCaptureWorker();

/**
 * Mengecek apakah versi Windows mendukung WDA_EXCLUDEFROMCAPTURE (Windows 10 v2004 / Build 19041+).
 * Pada versi Windows di bawah Build 19041, setContentProtection(true) menggunakan WDA_MONITOR
 * yang membuat jendela overlay tampak sebagai kotak hitam di hasil capture layar.
 */
export function checkWindowsContentProtectionSupport() {
  const platform = os.platform();
  const release = os.release(); // contoh: "10.0.22631" atau "10.0.19045"

  if (platform !== 'win32') {
    return {
      supported: true,
      platform,
      release,
      build: null,
      warning: null,
    };
  }

  const parts = release.split('.').map((n) => parseInt(n, 10));
  const major = parts[0] || 0;
  const build = parts[2] || 0;

  if (major < 10 || (major === 10 && build < 19041)) {
    const warning =
      `Windows versi ${release} (Build ${build}) berada di bawah Windows 10 v2004 (Build 19041). ` +
      `Fitur setContentProtection(true) akan membuat jendela avatar tampak hitam di hasil capture layar.`;
    logger.warn('Capture', warning, { platform, release, build });
    return {
      supported: false,
      platform,
      release,
      build,
      warning,
    };
  }

  logger.info(
    'Capture',
    'Versi Windows mendukung WDA_EXCLUDEFROMCAPTURE penuh (avatar tidak ikut tertangkap di capture layar)',
    { platform, release, build },
  );
  return {
    supported: true,
    platform,
    release,
    build,
    warning: null,
  };
}

/**
 * Menganalisis piksel bitmap (BGRA) hasil capture untuk mendeteksi apakah frame
 * kosong atau hitam total (misal karena game Exclusive Fullscreen atau proteksi DRM).
 */
function analyzeFrameLuminance(bitmapBuffer, width, height) {
  if (!bitmapBuffer || bitmapBuffer.length < 4 || width <= 0 || height <= 0) {
    return { isEmpty: true, isAllBlack: true, avgLuma: 0, nonBlackRatio: 0 };
  }

  const totalPixels = Math.floor(bitmapBuffer.length / 4);
  const step = Math.max(1, CONFIG.capture.blackFrameSampleStep || 16);

  let sampleCount = 0;
  let lumaSum = 0;
  let nonBlackCount = 0;

  for (let p = 0; p < totalPixels; p += step) {
    const idx = p * 4;
    const b = bitmapBuffer[idx];
    const g = bitmapBuffer[idx + 1];
    const r = bitmapBuffer[idx + 2];

    sampleCount++;

    // Rumus luminansi standar Rec.709
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaSum += luma;

    if (luma > 6.0) {
      nonBlackCount++;
    }
  }

  if (sampleCount === 0) {
    return { isEmpty: true, isAllBlack: true, avgLuma: 0, nonBlackRatio: 0 };
  }

  const avgLuma = lumaSum / sampleCount;
  const nonBlackRatio = nonBlackCount / sampleCount;
  const threshold = CONFIG.capture.blackFrameLumaThreshold ?? 3.5;

  // Frame dianggap hitam total jika rata-rata luma sangat rendah DAN hampir tidak ada piksel terang
  const isAllBlack = avgLuma < threshold && nonBlackRatio < 0.005;

  return {
    isEmpty: false,
    isAllBlack,
    avgLuma: +avgLuma.toFixed(2),
    nonBlackRatio: +nonBlackRatio.toFixed(4),
  };
}

/**
 * Membuat objek Error terstruktur dengan kode dan pesan ucapan untuk avatar.
 */
function createCaptureError(code, message, spokenMessage = null, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.spokenMessage = spokenMessage || message;
  Object.assign(err, extra);
  return err;
}

class CaptureService {
  constructor() {
    this.lastCaptureTime = 0;
    this.lastProtectionAppliedAt = Date.now();
    this.osSupport = null;
  }

  /**
   * Dipanggil saat aplikasi start untuk mengecek dukungan OS Windows terhadap contentProtection
   * dan menyiapkan worker fallback GDI di latar belakang.
   */
  init(onWarning) {
    this.osSupport = checkWindowsContentProtectionSupport();
    if (this.osSupport.warning && typeof onWarning === 'function') {
      onWarning('Peringatan Versi Windows (Capture Layar)', this.osSupport.warning);
    }
    gdiWorker.ensureStarted().catch(() => {});
    return this.osSupport;
  }

  destroy() {
    gdiWorker.destroy();
  }

  /**
   * Mencatat waktu terakhir saat jendela overlay baru dibuat atau baru ditampilkan (show)
   * dengan setContentProtection(true), agar capture pertama menunggu komposisi DWM (~400 ms).
   */
  markContentProtectionUpdated() {
    this.lastProtectionAppliedAt = Date.now();
  }

  /**
   * Mengembalikan daftar semua monitor yang terpasang untuk dipakai oleh renderer atau tray.
   */
  getDisplays() {
    const allDisplays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const activeId = windowStateStore.state.activeDisplayId ?? primary?.id;

    return allDisplays.map((d, index) => ({
      id: d.id,
      index: index + 1,
      label: `Monitor ${index + 1} (${d.bounds.width}×${d.bounds.height})${d.id === primary?.id ? ' — Utama' : ''}`,
      bounds: d.bounds,
      workArea: d.workArea,
      scaleFactor: d.scaleFactor,
      isPrimary: d.id === primary?.id,
      isActive: String(d.id) === String(activeId),
    }));
  }

  /**
   * Mengambil tangkapan layar langsung tanpa popup izin browser menggunakan desktopCapturer.
   *
   * @param {object} options
   * @param {number|string} [options.displayId] - ID monitor target (default: monitor aktif di tray / monitor utama)
   * @param {number} [options.maxWidth] - Batas ukuran sisi panjang maksimum dalam piksel (default: 1280)
   * @returns {Promise<{ base64: string, dataUrl: string, width: number, height: number, displayId: number, durationMs: number, avgLuma: number, timestamp: number }>}
   */
  async captureScreen(options = {}) {
    // 1. Tolak jika Screen Vision sedang dimatikan di System Tray (Fase 4 Poin 16)
    if (!windowStateStore.state.screenVision) {
      logger.warn('Capture', 'Permintaan captureScreen ditolak karena Screen Vision sedang OFF di tray.');
      throw createCaptureError(
        'SCREEN_VISION_DISABLED',
        'Screen Vision sedang dimatikan di System Tray.',
        'Fitur lihat layar sedang dimatikan di pengaturan tray.',
      );
    }

    // 2. Rate limit di main process: maksimal 1 capture per CONFIG.capture.rateLimitMs (500 ms)
    const now = Date.now();
    const rateLimitMs = CONFIG.capture.rateLimitMs || 500;
    const elapsedSinceLast = now - this.lastCaptureTime;
    if (elapsedSinceLast < rateLimitMs) {
      const retryAfterMs = rateLimitMs - elapsedSinceLast;
      logger.warn('Capture', 'Permintaan captureScreen ditolak oleh rate limiter', {
        elapsedSinceLast,
        rateLimitMs,
        retryAfterMs,
      });
      throw createCaptureError(
        'RATE_LIMITED',
        `Capture layar terlalu cepat. Tunggu ${retryAfterMs} ms lagi.`,
        null,
        { retryAfterMs },
      );
    }

    // 3. Beri jeda komposisi desktop (300-500 ms) setelah jendela overlay muncul / setContentProtection(true)
    const protectionDelayMs = CONFIG.capture.initialProtectionDelayMs || 400;
    const elapsedSinceProtection = Date.now() - this.lastProtectionAppliedAt;
    if (elapsedSinceProtection < protectionDelayMs) {
      const waitMs = protectionDelayMs - elapsedSinceProtection;
      logger.info('Capture', `Menunggu ${waitMs} ms agar komposisi DWM setContentProtection(true) aktif...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    // 4. Tentukan monitor yang dipilih
    const allDisplays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();
    const requestedDisplayId =
      options?.displayId !== undefined && options?.displayId !== null && options?.displayId !== ''
        ? options.displayId
        : windowStateStore.state.activeDisplayId ?? primaryDisplay?.id;

    let targetDisplay = allDisplays.find((d) => String(d.id) === String(requestedDisplayId));

    // Jika options.displayId diberikan secara eksplisit tetapi tidak cocok dengan monitor mana pun, lempar error jelas
    if (!targetDisplay) {
      if (options?.displayId !== undefined && options?.displayId !== null) {
        logger.error('Capture', 'Monitor yang diminta tidak ditemukan', {
          requestedDisplayId: options.displayId,
          availableDisplayIds: allDisplays.map((d) => d.id),
        });
        throw createCaptureError(
          'DISPLAY_NOT_FOUND',
          `Monitor dengan ID ${options.displayId} tidak ditemukan.`,
          'Monitor yang dipilih tidak ditemukan.',
        );
      }
      targetDisplay = primaryDisplay || allDisplays[0];
    }

    if (!targetDisplay) {
      throw createCaptureError(
        'DISPLAY_NOT_FOUND',
        'Tidak ada monitor aktif yang terdeteksi.',
        'Layarnya tidak ditemukan.',
      );
    }

    // 5. Hitung ukuran thumbnail proporsional dengan sisi panjang maksimal ~1280 px
    const maxLongSide = Math.min(
      1920,
      Math.max(320, Math.round(Number(options?.maxWidth) || CONFIG.capture.maxDimensionPx || 1280)),
    );
    const srcW = Math.max(1, targetDisplay.bounds.width);
    const srcH = Math.max(1, targetDisplay.bounds.height);
    const longSide = Math.max(srcW, srcH);
    const scale = longSide > maxLongSide ? maxLongSide / longSide : 1;

    const thumbWidth = Math.max(1, Math.round(srcW * scale));
    const thumbHeight = Math.max(1, Math.round(srcH * scale));

    const captureStartTime = Date.now();
    this.lastCaptureTime = captureStartTime;

    let sources;
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: thumbWidth, height: thumbHeight },
        fetchWindowIcons: false,
      });
    } catch (err) {
      logger.error('Capture', 'desktopCapturer.getSources gagal dieksekusi', {
        error: err.message,
      });
      throw createCaptureError(
        'CAPTURER_FAILED',
        `Gagal menangkap layar: ${err.message}`,
        'layarnya tidak bisa kulihat, coba mode borderless',
      );
    }

    if (!Array.isArray(sources) || sources.length === 0) {
      logger.error('Capture', 'desktopCapturer tidak mengembalikan source layar apa pun');
      throw createCaptureError(
        'NO_SCREEN_SOURCE',
        'Tidak ada sumber tangkapan layar yang tersedia.',
        'layarnya tidak bisa kulihat, coba mode borderless',
      );
    }

    // Cari source yang sesuai dengan targetDisplay.id
    let matchedSource = sources.find(
      (s) => s.display_id && String(s.display_id) === String(targetDisplay.id),
    );
    if (!matchedSource) {
      const displayIdx = allDisplays.findIndex((d) => String(d.id) === String(targetDisplay.id));
      if (displayIdx >= 0 && sources[displayIdx]) {
        matchedSource = sources[displayIdx];
      } else if (sources.length === 1) {
        matchedSource = sources[0];
      }
    }

    if (!matchedSource) {
      logger.error('Capture', 'Source untuk monitor target tidak ditemukan', {
        targetDisplayId: targetDisplay.id,
        availableSources: sources.map((s) => ({ id: s.id, display_id: s.display_id, name: s.name })),
      });
      throw createCaptureError(
        'DISPLAY_NOT_FOUND',
        `Sumber layar untuk monitor ${targetDisplay.id} tidak ditemukan.`,
        'Monitor yang dipilih tidak bisa ditangkap.',
      );
    }

    let thumbnail = matchedSource.thumbnail;
    let actualSize = thumbnail ? thumbnail.getSize() : { width: 0, height: 0 };
    let captureBackend = 'desktopCapturer';

    // Jika pada laptop Hybrid GPU / Windows 11 24H2+ thumbnail dari desktopCapturer berukuran 0x0,
    // gunakan fallback Win32 GDI pada monitor target (yang tetap menghormati WDA_EXCLUDEFROMCAPTURE).
    if ((!thumbnail || thumbnail.isEmpty() || !actualSize.width || !actualSize.height) && process.platform === 'win32') {
      try {
        const gdiImage = await gdiWorker.capture(targetDisplay, thumbWidth, thumbHeight);
        if (gdiImage && !gdiImage.isEmpty()) {
          thumbnail = gdiImage;
          actualSize = thumbnail.getSize();
          captureBackend = 'desktopCapturer+Win32GdiFallback';
        }
      } catch (fallbackErr) {
        logger.warn('Capture', 'Fallback Win32 GDI gagal dijalankan', { error: fallbackErr.message });
      }
    }

    // Perbarui timestamp selesai capture agar rate limit dihitung setelah operasi selesai
    this.lastCaptureTime = Date.now();
    const durationMs = this.lastCaptureTime - captureStartTime;

    if (!thumbnail || thumbnail.isEmpty() || !actualSize.width || !actualSize.height) {
      logger.warn('Capture', 'Thumbnail layar kosong (0x0 atau isEmpty)', {
        displayId: targetDisplay.id,
        actualSize,
        durationMs,
      });
      throw createCaptureError(
        'EMPTY_FRAME',
        'Hasil tangkapan layar kosong. Kemungkinan game berjalan dalam mode Exclusive Fullscreen atau konten dilindungi DRM.',
        'layarnya tidak bisa kulihat, coba mode borderless',
      );
    }

    // 6. Deteksi frame hitam total (game Exclusive Fullscreen / konten DRM)
    const bitmap = thumbnail.toBitmap();
    const lumaStats = analyzeFrameLuminance(bitmap, actualSize.width, actualSize.height);
    if (lumaStats.isEmpty || lumaStats.isAllBlack) {
      logger.warn(
        'Capture',
        'Frame hitam total terdeteksi (kemungkinan game Exclusive Fullscreen atau DRM)',
        {
          displayId: targetDisplay.id,
          width: actualSize.width,
          height: actualSize.height,
          durationMs,
          lumaStats,
        },
      );
      throw createCaptureError(
        'BLACK_FRAME_OR_DRM',
        'Layar terlihat hitam sepenuhnya (kemungkinan game berjalan di mode Exclusive Fullscreen atau konten DRM). Gunakan mode Borderless Windowed.',
        'layarnya tidak bisa kulihat, coba mode borderless',
      );
    }

    // 7. Encode ke JPEG kualitas ~75 dalam base64
    const jpegQuality = CONFIG.capture.jpegQuality || 75;
    const jpegBuffer = thumbnail.toJPEG(jpegQuality);
    const base64 = jpegBuffer.toString('base64');

    logger.info('Capture', 'Capture layar berhasil', {
      displayId: targetDisplay.id,
      sourceId: matchedSource.id,
      backend: captureBackend,
      width: actualSize.width,
      height: actualSize.height,
      durationMs,
      jpegBytes: jpegBuffer.length,
      avgLuma: lumaStats.avgLuma,
    });

    return {
      base64,
      dataUrl: `data:image/jpeg;base64,${base64}`,
      mimeType: 'image/jpeg',
      width: actualSize.width,
      height: actualSize.height,
      displayId: targetDisplay.id,
      durationMs,
      avgLuma: lumaStats.avgLuma,
      timestamp: this.lastCaptureTime,
    };
  }
}

export const captureService = new CaptureService();
