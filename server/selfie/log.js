// ---------------------------------------------------------------------------
// log.js  (server-side, modul selfie / pap)
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';

export function selfieLog(msg, ...rest) {
  console.log(`[selfie] ${msg}`, ...rest);
}
export function selfieWarn(msg, ...rest) {
  console.warn(`[selfie] ${msg}`, ...rest);
}
export function logSelfie(msg, level = 'info', ...rest) {
  if (level === 'warn') {
    selfieWarn(msg, ...rest);
  } else {
    selfieLog(msg, ...rest);
  }
}

export function createSelfieLogger(filePath, { log = selfieLog, warn = selfieWarn } = {}) {
  const write = (message, level) => {
    try {
      (level === 'warn' ? warn : log)(message);
    } catch {
      // Logging must never fail a generation job.
    }
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${new Date().toISOString()} [${level}] ${message}\n`, 'utf-8');
    } catch {
      // An unavailable log folder does not disable image generation.
    }
  };
  return { log: message => write(message, 'info'), warn: message => write(message, 'warn') };
}
