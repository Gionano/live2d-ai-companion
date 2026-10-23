import fs from 'node:fs';
import path from 'node:path';

const SHORTCUT_ENV_KEYS = {
  toggleMuteMic: 'SHORTCUT_MUTE_MIC',
  toggleEditMode: 'SHORTCUT_EDIT_MODE',
  toggleAvatarVisibility: 'SHORTCUT_HIDE_AVATAR',
};

export function loadShortcutConfig({ filePath, defaults, env = process.env, logger }) {
  let configured = {};
  try {
    configured = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
      throw new Error('Shortcut configuration must be an object');
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(defaults, null, 2)}\n`, 'utf8');
        logger.info('Shortcuts', 'Created shortcut configuration', { filePath });
      } catch (writeError) {
        logger.warn('Shortcuts', 'Could not create shortcut configuration; using defaults', {
          filePath, error: writeError.message,
        });
      }
    } else {
      logger.warn('Shortcuts', 'Could not read shortcut configuration; using defaults', {
        filePath, error: err.message,
      });
    }
    configured = {};
  }

  const shortcuts = {};
  for (const [id, defaultValue] of Object.entries(defaults)) {
    const value = configured[id] ?? {};
    const preferred = env[SHORTCUT_ENV_KEYS[id]] ?? value.preferred ?? defaultValue.preferred;
    const fallbacks = value.fallbacks ?? defaultValue.fallbacks;
    const validPreferred = typeof preferred === 'string' && preferred.trim().length > 0;
    const validFallbacks = Array.isArray(fallbacks)
      && fallbacks.every(key => typeof key === 'string' && key.trim().length > 0);
    if (!validPreferred || !validFallbacks) {
      logger.warn('Shortcuts', 'Invalid shortcut setting; using the default for invalid fields', { id, filePath });
    }
    shortcuts[id] = {
      preferred: validPreferred ? preferred.trim() : defaultValue.preferred,
      fallbacks: validFallbacks ? fallbacks.map(key => key.trim()) : [...defaultValue.fallbacks],
    };
  }
  logger.info('Shortcuts', 'Loaded shortcut configuration', { filePath, shortcuts });
  return shortcuts;
}

export function formatShortcut(accelerator, platform = process.platform) {
  const aliases = {
    control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift',
    commandorcontrol: platform === 'darwin' ? 'Cmd' : 'Ctrl',
    cmdorctrl: platform === 'darwin' ? 'Cmd' : 'Ctrl', command: 'Cmd', cmd: 'Cmd',
  };
  return accelerator.split('+').map(key => aliases[key.toLowerCase()] || key).join('+');
}

function isReservedMuteShortcut(accelerator) {
  const keys = new Set(formatShortcut(accelerator.replace(/\s+/g, ''), 'win32').toLowerCase().split('+'));
  return keys.size === 3 && keys.has('ctrl') && keys.has('shift') && keys.has('m');
}

export function registerShortcuts({ globalShortcut, shortcuts, handlers, logger, notify }) {
  const states = {};
  for (const [id, { preferred, fallbacks }] of Object.entries(shortcuts)) {
    const { label, handler } = handlers[id];
    const state = { preferred, active: null, activeLabel: null, available: false };
    states[id] = state;
    const tried = new Set();
    for (const accelerator of [preferred, ...fallbacks]) {
      if (id === 'toggleMuteMic' && isReservedMuteShortcut(accelerator)) {
        logger.warn('Shortcuts', 'Skipped reserved microphone shortcut', { id, accelerator });
        continue;
      }
      const normalized = accelerator.toLowerCase();
      if (tried.has(normalized)) continue;
      tried.add(normalized);
      let registerResult = null;
      let isRegistered = false;
      let error = null;
      try {
        registerResult = globalShortcut.register(accelerator, () => {
          logger.info('Shortcuts', 'Global shortcut fired', { id, label, accelerator });
          handler(accelerator);
        });
      } catch (err) {
        error = err.message;
      }
      try {
        isRegistered = globalShortcut.isRegistered(accelerator);
      } catch (err) {
        error = error || err.message;
      }
      const succeeded = registerResult === true && isRegistered === true;
      logger[succeeded ? 'info' : 'warn']('Shortcuts', 'Global shortcut registration attempt', {
        id, label, accelerator, registerResult, isRegistered, ...(error ? { error } : {}),
      });
      if (!succeeded) {
        // A successful registration with failed verification must not retain an unused binding.
        if (registerResult === true) globalShortcut.unregister(accelerator);
        continue;
      }
      state.active = accelerator;
      state.activeLabel = formatShortcut(accelerator);
      state.available = true;
      logger.info('Shortcuts', 'Active global shortcut', { id, label, ...state });
      if (accelerator !== preferred) {
        notify('Shortcut Pengganti Aktif', `${label}: ${state.activeLabel} aktif. ${formatShortcut(preferred)} tidak tersedia, kemungkinan dipakai aplikasi lain.`);
      }
      break;
    }
    if (!state.available) {
      logger.warn('Shortcuts', 'No available global shortcut; the tray action remains enabled', {
        id, label, preferred, fallbacks,
      });
      notify('Shortcut Tidak Tersedia', `${label}: ${[preferred, ...fallbacks].map(key => formatShortcut(key)).join(', ')} gagal didaftarkan. Kemungkinan sudah dipakai aplikasi lain. Gunakan menu tray.`);
    }
  }
  return states;
}
