import { app, Menu, Notification, Tray, nativeImage, screen } from 'electron';
import { CONFIG } from './config.js';
import { logger } from './logger.js';

/**
 * Membuat ikon system tray 16x16 (BGRA) bertema kristal es biru Amika secara terprogram
 * sehingga tray selalu tampil rapi di Windows tanpa bergantung pada file eksternal.
 */
function createCrystalTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const cx = 7.5;
  const cy = 7.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      const diamond = dx + dy;
      const dist = Math.hypot(x - cx, y - cy);

      if (diamond <= 6.2 || (dist <= 6.2 && (dx < 2.2 || dy < 2.2))) {
        const core = diamond <= 2.8;
        // Format BGRA pada Windows
        buf[idx + 0] = 255; // B
        buf[idx + 1] = core ? 245 : 205; // G
        buf[idx + 2] = core ? 210 : 95; // R
        buf[idx + 3] = 255; // A
      } else if (dist <= 7.2) {
        buf[idx + 0] = 180;
        buf[idx + 1] = 110;
        buf[idx + 2] = 40;
        buf[idx + 3] = 210;
      } else {
        buf[idx + 0] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0;
      }
    }
  }

  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export class TrayManager {
  constructor(handlers) {
    this.handlers = handlers;
    this.tray = null;
  }

  init() {
    if (this.tray) return this.tray;
    try {
      const icon = createCrystalTrayIcon();
      this.tray = new Tray(icon);
      this.tray.setToolTip('Amika Desktop Companion');
      this.tray.on('double-click', () => {
        this.handlers.onToggleVisible?.();
      });
      this.rebuildMenu();
      logger.info('Tray', 'System tray berhasil diinisialisasi.');
    } catch (err) {
      logger.error('Tray', 'Gagal membuat system tray', { error: err.message });
    }
    return this.tray;
  }

  rebuildMenu() {
    if (!this.tray) return;

    const state = this.handlers.getState();
    const shortcutLabel = (label, id) =>
      `${label} (${state.shortcuts?.[id]?.activeLabel || 'shortcut tidak tersedia'})`;

    // --- Preset submenu items ---
    const presetItems = Object.values(CONFIG.overlay.presets).map((preset) => ({
      label: `${preset.label} (${preset.defaultWidth}×${preset.defaultHeight})`,
      type: 'radio',
      checked: state.activePreset === preset.id,
      click: () => {
        this.handlers.onSelectPreset?.(preset.id);
      },
    }));

    // --- Monitor submenu items ---
    const allDisplays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();
    const monitorItems = allDisplays.map((disp) => {
      const isPrimary = disp.id === primaryDisplay.id;
      const isActive = String(disp.id) === String(state.activeDisplayId);
      const label = `${isPrimary ? '★ ' : ''}Monitor ${disp.id} (${disp.bounds.width}×${disp.bounds.height})${isPrimary ? ' — Utama' : ''}`;
      return {
        label,
        type: 'radio',
        checked: isActive,
        click: () => {
          this.handlers.onSelectMonitor?.(disp.id);
        },
      };
    });

    // --- Login item (Mulai bersama Windows) ---
    let launchAtLogin = false;
    const loginArgs = app.isPackaged ? [] : [app.getAppPath()];
    try {
      const settings = app.getLoginItemSettings({
        path: process.execPath,
        args: loginArgs,
      });
      launchAtLogin = Boolean(settings.openAtLogin);
    } catch {
      // Abaikan error saat membaca login settings
    }

    const contextMenu = Menu.buildFromTemplate([
      {
        label: shortcutLabel(state.isVisible ? 'Sembunyikan Avatar' : 'Tampilkan Avatar', 'toggleAvatarVisibility'),
        click: () => this.handlers.onToggleVisible?.(),
      },
      { type: 'separator' },

      // --- Preset Tampilan ---
      {
        label: 'Preset Tampilan',
        type: 'submenu',
        submenu: presetItems,
      },

      // --- Pilih Monitor ---
      {
        label: 'Pilih Monitor',
        type: 'submenu',
        submenu: monitorItems,
      },
      { type: 'separator' },

      // --- Mode Edit ---
      {
        label: shortcutLabel('Mode Edit Posisi & Ukuran', 'toggleEditMode'),
        type: 'checkbox',
        checked: Boolean(state.editMode),
        click: (menuItem) => this.handlers.onToggleEditMode?.(menuItem.checked),
      },

      // --- Click-Through ---
      {
        label: 'Click-Through (Tembus Klik)',
        type: 'checkbox',
        enabled: !state.editMode,
        checked: Boolean(state.clickThrough && !state.editMode),
        click: (menuItem) => this.handlers.onToggleClickThrough?.(menuItem.checked),
      },

      // --- Reset Bounds ---
      {
        label: 'Reset Ukuran & Posisi Preset Ini',
        click: () => this.handlers.onResetPresetBounds?.(),
      },
      { type: 'separator' },

      // --- Mute Mic ---
      {
        label: shortcutLabel('Mute Mikrofon', 'toggleMuteMic'),
        type: 'checkbox',
        checked: Boolean(state.muteMic),
        click: (menuItem) => this.handlers.onToggleMuteMic?.(menuItem.checked),
      },

      // --- Screen Vision ---
      {
        label: 'Screen Vision (Lihat Layar)',
        type: 'checkbox',
        checked: Boolean(state.screenVision),
        click: (menuItem) => this.handlers.onToggleScreenVision?.(menuItem.checked),
      },
      { type: 'separator' },

      // --- Mulai bersama Windows ---
      {
        label: 'Pap feature (Fitur Pap)',
        type: 'checkbox',
        checked: Boolean(state.selfieEnabled),
        click: (menuItem) => this.handlers.onToggleSelfie?.(menuItem.checked),
      },
      {
        label: 'Pap gallery (Galeri Pap)',
        click: () => this.handlers.onOpenSelfieGallery?.(),
      },
      { type: 'separator' },

      {
        label: 'Mulai Bersama Windows',
        type: 'checkbox',
        checked: launchAtLogin,
        click: (menuItem) => {
          try {
            app.setLoginItemSettings({
              openAtLogin: Boolean(menuItem.checked),
              path: process.execPath,
              args: loginArgs,
            });
            logger.info('Tray', 'Pengaturan Mulai Bersama Windows diubah', {
              openAtLogin: Boolean(menuItem.checked),
            });
            this.rebuildMenu();
          } catch (err) {
            logger.error('Tray', 'Gagal mengubah pengaturan login item', {
              error: err.message,
            });
          }
        },
      },
      { type: 'separator' },

      // --- Keluar ---
      {
        label: 'Keluar',
        click: () => this.handlers.onQuit?.(),
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  /**
   * Menampilkan notifikasi sistem / tray balloon pada Windows (mis. saat shortcut global bentrok).
   */
  notify(title, body) {
    try {
      if (Notification.isSupported()) {
        const notif = new Notification({ title, body });
        notif.show();
        return;
      }
    } catch {
      // Fallback ke displayBalloon
    }
    try {
      this.tray?.displayBalloon?.({
        title,
        content: body,
        iconType: 'warning',
      });
    } catch {
      // Abaikan jika gagal
    }
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
