import fs from 'node:fs';
import path from 'node:path';
import { app, screen } from 'electron';
import { CONFIG } from './config.js';
import { logger } from './logger.js';

function getStateFilePath() {
  return path.join(app.getPath('userData'), CONFIG.storage.windowStateFileName);
}

/**
 * Mengecek apakah sebuah titik/persegi panjang memiliki irisan minimal (80 px)
 * dengan layar fisik (display.bounds) dari salah satu monitor yang sedang terpasang.
 * Menggunakan display.bounds (bukan workArea) agar overlay bebas menembus taskbar & tepi layar.
 */
function isBoundsVisibleOnDisplay(bounds, display) {
  const dispRect = display?.bounds || display?.workArea;
  if (!bounds || !dispRect) return false;
  const minVisibleX = Math.min(80, Math.max(40, Math.round(bounds.width * 0.15)));
  const minVisibleY = Math.min(80, Math.max(40, Math.round(bounds.height * 0.15)));
  const overlapX = Math.max(
    0,
    Math.min(bounds.x + bounds.width, dispRect.x + dispRect.width) - Math.max(bounds.x, dispRect.x),
  );
  const overlapY = Math.max(
    0,
    Math.min(bounds.y + bounds.height, dispRect.y + dispRect.height) - Math.max(bounds.y, dispRect.y),
  );
  return overlapX >= minVisibleX && overlapY >= minVisibleY;
}

/**
 * Mencari display target berdasarkan displayId yang disimpan atau posisi jendela.
 * Jika monitor sudah dicabut atau posisi berada di luar seluruh monitor yang ada,
 * fallback secara aman ke monitor utama (primaryDisplay).
 */
export function resolveTargetDisplay(savedBounds, preferredDisplayId = null) {
  const allDisplays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  // 1. Jika ada bounds yang sedang di-drag/dipindah, cek monitor yang beririsan
  if (
    savedBounds &&
    typeof savedBounds.x === 'number' &&
    typeof savedBounds.y === 'number' &&
    typeof savedBounds.width === 'number' &&
    typeof savedBounds.height === 'number'
  ) {
    const matching = screen.getDisplayMatching({
      x: Math.round(savedBounds.x),
      y: Math.round(savedBounds.y),
      width: Math.max(100, Math.round(savedBounds.width)),
      height: Math.max(100, Math.round(savedBounds.height)),
    });
    if (matching && isBoundsVisibleOnDisplay(savedBounds, matching)) {
      return matching;
    }
    const anyVisible = allDisplays.find((d) => isBoundsVisibleOnDisplay(savedBounds, d));
    if (anyVisible) {
      return anyVisible;
    }
  }

  // 2. Cek berdasarkan displayId yang disimpan
  const targetId = preferredDisplayId ?? savedBounds?.displayId;
  if (targetId !== undefined && targetId !== null) {
    const byId = allDisplays.find((d) => String(d.id) === String(targetId));
    if (byId) return byId;

    logger.warn('WindowState', 'Monitor tersimpan tidak ditemukan (mungkin sudah dicabut); fallback ke monitor utama.', {
      missingDisplayId: targetId,
      fallbackDisplayId: primary.id,
    });
  }

  return primary;
}

/**
 * Menghitung posisi default pojok kanan bawah workArea monitor untuk preset tertentu.
 */
export function getDefaultBoundsForPreset(presetId, targetDisplay = null) {
  const preset =
    CONFIG.overlay.presets[presetId] || CONFIG.overlay.presets[CONFIG.overlay.defaultPreset];
  const display = targetDisplay || screen.getPrimaryDisplay();
  const { x: waX, y: waY, width: waW, height: waH } = display.workArea;

  const aspect = preset.aspectRatio || preset.defaultWidth / preset.defaultHeight;
  let width = preset.defaultWidth;
  let height = preset.defaultHeight;

  const maxW = Math.max(preset.minWidth || 260, waW - 24);
  const maxH = Math.max(preset.minHeight || 340, waH - 24);
  if (width > maxW) {
    width = maxW;
    height = Math.round(width / aspect);
  }
  if (height > maxH) {
    height = maxH;
    width = Math.round(height * aspect);
  }

  const x = Math.round(waX + waW - width - CONFIG.overlay.marginRight);
  const y = Math.round(waY + waH - height - CONFIG.overlay.marginBottom);

  return {
    x: Math.max(waX, x),
    y: Math.max(waY, y),
    width: Math.round(width),
    height: Math.round(height),
    displayId: display.id,
  };
}

/**
 * Memvalidasi ukuran & posisi jendela:
 * - Garis tepi / jendela overlay BISA menembus border layar Windows (kiri, kanan, atas, bawah)
 *   maupun melewati Taskbar Windows.
 * - Hanya mencegah jendela hilang 100% di luar layar (menyisakan minimal ~80 px di dalam layar
 *   agar selalu bisa digeser kembali, atau mereset jika monitor tempatnya berada sudah dicabut).
 */
export function clampBoundsToWorkArea(rawBounds, presetId, lockAspect = true, explicitDisplay = null) {
  const preset =
    CONFIG.overlay.presets[presetId] || CONFIG.overlay.presets[CONFIG.overlay.defaultPreset];
  const display = explicitDisplay || resolveTargetDisplay(rawBounds);
  const { x: waX, y: waY, width: waW, height: waH } = display.workArea;
  const dispRect = display.bounds || display.workArea;
  const aspect = preset.aspectRatio || preset.defaultWidth / preset.defaultHeight;

  const minW = preset.minWidth || CONFIG.overlay.minWidth;
  const minH = preset.minHeight || CONFIG.overlay.minHeight;
  // Izinkan ukuran diperbesar hingga 2x ukuran layar agar bebas di-zoom & tembus border
  const maxW = Math.max(minW, Math.round(dispRect.width * 2));
  const maxH = Math.max(minH, Math.round(dispRect.height * 2));

  let width = Math.round(Number(rawBounds?.width) || preset.defaultWidth);
  let height = Math.round(Number(rawBounds?.height) || preset.defaultHeight);

  width = Math.max(minW, Math.min(maxW, width));
  height = Math.max(minH, Math.min(maxH, height));

  if (lockAspect) {
    width = Math.round(height * aspect);
    if (width > maxW) {
      width = maxW;
      height = Math.round(width / aspect);
    }
    if (width < minW) {
      width = minW;
      height = Math.round(width / aspect);
    }
    if (height > maxH) {
      height = maxH;
      width = Math.round(height * aspect);
    }
  }

  // Jika rawBounds berasal dari monitor lain yang sudah dicabut dan tidak terlihat di monitor ini,
  // tempatkan di pojok kanan bawah monitor aktif
  const sameDisplay =
    rawBounds?.displayId === undefined ||
    String(rawBounds.displayId) === String(display.id) ||
    isBoundsVisibleOnDisplay({ ...rawBounds, width, height }, display);

  let x =
    sameDisplay && typeof rawBounds?.x === 'number' && Number.isFinite(rawBounds.x)
      ? Math.round(rawBounds.x)
      : Math.round(waX + waW - width - CONFIG.overlay.marginRight);
  let y =
    sameDisplay && typeof rawBounds?.y === 'number' && Number.isFinite(rawBounds.y)
      ? Math.round(rawBounds.y)
      : Math.round(waY + waH - height - CONFIG.overlay.marginBottom);

  // Izinkan jendela & garis tepi menembus ke luar border kiri/kanan/atas/bawah Windows,
  // cukup sisakan minimal 80 px (atau 15% ukuran jendela) tetap berada di dalam monitor.
  const minVisibleX = Math.min(80, Math.max(40, Math.round(width * 0.15)));
  const minVisibleY = Math.min(80, Math.max(40, Math.round(height * 0.15)));
  const minX = dispRect.x - width + minVisibleX;
  const maxX = dispRect.x + dispRect.width - minVisibleX;
  const minY = dispRect.y - height + minVisibleY;
  const maxY = dispRect.y + dispRect.height - minVisibleY;

  x = Math.max(minX, Math.min(maxX, x));
  y = Math.max(minY, Math.min(maxY, y));

  return {
    x,
    y,
    width,
    height,
    displayId: display.id,
  };
}

/**
 * State Store untuk menyimpan:
 * - Preset aktif ('with-wings' | 'without-wings')
 * - Monitor aktif (activeDisplayId)
 * - Ukuran & posisi per monitor DAN per preset (byDisplay[displayId].presets[presetId])
 * - Status clickThrough & editMode
 */
class WindowStateStore {
  constructor() {
    this.state = {
      activePreset: CONFIG.overlay.defaultPreset,
      activeDisplayId: null,
      clickThrough: true,
      editMode: false,
      muteMic: false,
      screenVision: true,
      selfieEnabled: CONFIG.selfiePopup?.enabled ?? true,
      presets: {},
      byDisplay: {},
    };
    this.loaded = false;
  }

  load() {
    const filePath = getStateFilePath();
    const primaryDisplay = screen.getPrimaryDisplay();

    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (raw && typeof raw === 'object') {
          if (raw.activePreset && CONFIG.overlay.presets[raw.activePreset]) {
            this.state.activePreset = raw.activePreset;
          }
          if (raw.activeDisplayId !== undefined) {
            this.state.activeDisplayId = raw.activeDisplayId;
          }
          if (typeof raw.muteMic === 'boolean') {
            this.state.muteMic = raw.muteMic;
          }
          if (typeof raw.screenVision === 'boolean') {
            this.state.screenVision = raw.screenVision;
          }
          if (typeof raw.selfieEnabled === 'boolean') {
            this.state.selfieEnabled = raw.selfieEnabled;
          }
          if (raw.presets && typeof raw.presets === 'object') {
            this.state.presets = { ...raw.presets };
          }
          if (raw.byDisplay && typeof raw.byDisplay === 'object') {
            this.state.byDisplay = { ...raw.byDisplay };
          }
        }
      }
    } catch (err) {
      logger.warn('WindowState', 'Gagal membaca window-state.json, menggunakan default', {
        error: err.message,
      });
    }

    // Override dari env OVERLAY_PRESET jika diberikan saat pengujian/CLI
    if (process.env.OVERLAY_PRESET && CONFIG.overlay.presets[process.env.OVERLAY_PRESET]) {
      this.state.activePreset = process.env.OVERLAY_PRESET;
    }

    // Fase 2 (Poin 8): Default saat start selalu click-through aktif dan mode edit nonaktif
    this.state.clickThrough = true;
    this.state.editMode = false;

    // Tentukan monitor aktif (validasi apakah masih terpasang)
    const activeDisplay = resolveTargetDisplay(
      this.state.presets[this.state.activePreset],
      this.state.activeDisplayId,
    );
    this.state.activeDisplayId = activeDisplay.id;
    const dispKey = String(activeDisplay.id);

    if (!this.state.byDisplay[dispKey] || typeof this.state.byDisplay[dispKey] !== 'object') {
      this.state.byDisplay[dispKey] = {
        displayId: activeDisplay.id,
        workArea: activeDisplay.workArea,
        scaleFactor: activeDisplay.scaleFactor,
        presets: {},
      };
    }

    // Validasi setiap preset untuk monitor aktif agar tidak berada di luar layar
    for (const presetId of Object.keys(CONFIG.overlay.presets)) {
      const perDisplaySaved = this.state.byDisplay[dispKey]?.presets?.[presetId];
      const fallbackSaved = this.state.presets[presetId];
      const candidate = perDisplaySaved || fallbackSaved;

      const validBounds = candidate
        ? clampBoundsToWorkArea(candidate, presetId, true, activeDisplay)
        : getDefaultBoundsForPreset(presetId, activeDisplay);

      this.state.presets[presetId] = validBounds;
      this.state.byDisplay[dispKey].presets[presetId] = validBounds;
    }

    this.state.byDisplay[dispKey].workArea = activeDisplay.workArea;
    this.state.byDisplay[dispKey].scaleFactor = activeDisplay.scaleFactor;

    this.loaded = true;
    this.save();
    return this.state;
  }

  save() {
    try {
      const filePath = getStateFilePath();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const payload = {
        activePreset: this.state.activePreset,
        activeDisplayId: this.state.activeDisplayId,
        clickThrough: this.state.clickThrough,
        muteMic: this.state.muteMic,
        screenVision: this.state.screenVision,
        selfieEnabled: this.state.selfieEnabled,
        presets: this.state.presets,
        byDisplay: this.state.byDisplay,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      logger.error('WindowState', 'Gagal menyimpan window-state.json', { error: err.message });
    }
  }

  getActivePresetId() {
    if (!this.loaded) this.load();
    return this.state.activePreset;
  }

  getActivePresetConfig() {
    const id = this.getActivePresetId();
    return CONFIG.overlay.presets[id] || CONFIG.overlay.presets['with-wings'];
  }

  getPresetBounds(presetId = this.getActivePresetId(), targetDisplayId = null) {
    if (!this.loaded) this.load();
    const displayIdToUse = targetDisplayId ?? this.state.activeDisplayId;
    const display = resolveTargetDisplay(this.state.presets[presetId], displayIdToUse);
    const dispKey = String(display.id);

    const savedOnDisplay = this.state.byDisplay[dispKey]?.presets?.[presetId];
    const savedGlobal = this.state.presets[presetId];
    const candidate = savedOnDisplay || savedGlobal;

    const clamped = candidate
      ? clampBoundsToWorkArea(candidate, presetId, true, display)
      : getDefaultBoundsForPreset(presetId, display);

    this._recordBoundsForDisplay(display, presetId, clamped);
    return clamped;
  }

  _recordBoundsForDisplay(display, presetId, clampedBounds) {
    const dispKey = String(display.id);
    if (!this.state.byDisplay[dispKey] || typeof this.state.byDisplay[dispKey] !== 'object') {
      this.state.byDisplay[dispKey] = {
        displayId: display.id,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
        presets: {},
      };
    }
    this.state.byDisplay[dispKey].displayId = display.id;
    this.state.byDisplay[dispKey].workArea = display.workArea;
    this.state.byDisplay[dispKey].scaleFactor = display.scaleFactor;
    if (!this.state.byDisplay[dispKey].presets) {
      this.state.byDisplay[dispKey].presets = {};
    }
    this.state.byDisplay[dispKey].presets[presetId] = clampedBounds;
    this.state.presets[presetId] = clampedBounds;
    this.state.activeDisplayId = display.id;
  }

  updatePresetBounds(presetId, bounds, lockAspect = true) {
    if (!this.loaded) this.load();
    const display = resolveTargetDisplay(bounds, this.state.activeDisplayId);
    const clamped = clampBoundsToWorkArea(bounds, presetId, lockAspect, display);
    this._recordBoundsForDisplay(display, presetId, clamped);
    this.save();
    return clamped;
  }

  resetPresetBounds(presetId = this.getActivePresetId(), display = null) {
    if (!this.loaded) this.load();
    const targetDisplay =
      display || resolveTargetDisplay(this.state.presets[presetId], this.state.activeDisplayId);
    const fresh = getDefaultBoundsForPreset(presetId, targetDisplay);
    this._recordBoundsForDisplay(targetDisplay, presetId, fresh);
    this.save();
    return fresh;
  }

  setActivePreset(presetId) {
    if (!CONFIG.overlay.presets[presetId]) {
      throw new Error(`Preset overlay tidak dikenal: ${presetId}`);
    }
    if (!this.loaded) this.load();
    this.state.activePreset = presetId;
    const bounds = this.getPresetBounds(presetId, this.state.activeDisplayId);
    this.save();
    return {
      presetId,
      presetConfig: CONFIG.overlay.presets[presetId],
      bounds,
    };
  }

  setClickThrough(enabled) {
    if (!this.loaded) this.load();
    this.state.clickThrough = Boolean(enabled);
    this.save();
    return this.state.clickThrough;
  }

  setEditMode(enabled) {
    if (!this.loaded) this.load();
    const nextEditMode = Boolean(enabled);
    this.state.editMode = nextEditMode;
    // Fase 2 (Poin 9): Keluar dari mode edit mengaktifkan click-through lagi secara otomatis
    if (!nextEditMode) {
      this.state.clickThrough = true;
      this.save();
    }
    return this.state.editMode;
  }

  setMuteMic(enabled) {
    if (!this.loaded) this.load();
    this.state.muteMic = Boolean(enabled);
    this.save();
    return this.state.muteMic;
  }

  setScreenVision(enabled) {
    if (!this.loaded) this.load();
    this.state.screenVision = Boolean(enabled);
    this.save();
    return this.state.screenVision;
  }

  setSelfieEnabled(enabled) {
    if (!this.loaded) this.load();
    this.state.selfieEnabled = Boolean(enabled);
    this.save();
    return this.state.selfieEnabled;
  }

  getSnapshot() {
    if (!this.loaded) this.load();
    const activePreset = this.state.activePreset;
    return {
      activePreset,
      activeDisplayId: this.state.activeDisplayId,
      presetConfig: CONFIG.overlay.presets[activePreset],
      presets: CONFIG.overlay.presets,
      savedBoundsByPreset: this.state.presets,
      savedBoundsByDisplay: this.state.byDisplay,
      clickThrough: this.state.clickThrough,
      editMode: this.state.editMode,
      muteMic: this.state.muteMic,
      screenVision: this.state.screenVision,
      selfieEnabled: this.state.selfieEnabled,
      fitPadding: CONFIG.overlay.fitPadding,
      wingExpressionName: CONFIG.overlay.wingExpressionName,
      wingParameterId: CONFIG.overlay.wingParameterId,
      hiddenHalfBodyPartIds: CONFIG.overlay.hiddenHalfBodyPartIds,
      editShortcut: CONFIG.shortcuts.toggleEditMode.preferred,
    };
  }
}

export const windowStateStore = new WindowStateStore();
