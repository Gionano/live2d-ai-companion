import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { CONFIG } from './config.js';

let logFilePath = null;

function ensureLogFile() {
  if (logFilePath) return logFilePath;
  try {
    const userDataDir = app.getPath('userData');
    const logDir = path.join(userDataDir, CONFIG.storage.logDirName);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    logFilePath = path.join(logDir, CONFIG.storage.logFileName);
    return logFilePath;
  } catch {
    return null;
  }
}

function formatMessage(level, scope, message, meta) {
  const ts = new Date().toISOString();
  const metaStr =
    meta !== undefined
      ? ` ${typeof meta === 'object' ? JSON.stringify(meta) : String(meta)}`
      : '';
  return `[${ts}] [${level}] [${scope}] ${message}${metaStr}`;
}

function writeLog(level, scope, message, meta) {
  const line = formatMessage(level, scope, message, meta);
  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }

  const file = ensureLogFile();
  if (file) {
    try {
      fs.appendFileSync(file, `${line}\n`, 'utf8');
    } catch (err) {
      console.error('[Logger] Gagal menulis ke file log:', err.message);
    }
  }
}

export const logger = {
  info(scope, message, meta) {
    writeLog('INFO', scope, message, meta);
  },
  warn(scope, message, meta) {
    writeLog('WARN', scope, message, meta);
  },
  error(scope, message, meta) {
    writeLog('ERROR', scope, message, meta);
  },
  getLogFilePath() {
    return ensureLogFile();
  },
};
