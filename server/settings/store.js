import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, readBounded, withLock } from './files.js';
import { emptySettings, isObject, SETTINGS_LIMIT, SettingsError, validateDocument } from './schema.js';

export class SettingsStore {
  #filename;
  constructor({ localDir }) {
    this.#filename = path.join(localDir, 'settings.json');
    this.recovered = false;
  }

  read() {
    let bytes;
    try {
      bytes = readBounded(this.#filename, SETTINGS_LIMIT);
      return bytes === null ? emptySettings() : validateDocument(JSON.parse(bytes.toString('utf8')), { persisted: true });
    } catch (error) {
      if (error.code === 'STORAGE') throw error;
      // Do not echo parser diagnostics or corrupt contents. Keep the original bytes.
      try { fs.renameSync(this.#filename, this.#filename + '.corrupt-' + randomUUID() + '.bak'); }
      catch { throw new SettingsError('STORAGE', 503); }
      this.recovered = true;
      return emptySettings();
    }
  }

  update(version, change) {
    if (!Number.isSafeInteger(version) || version < 0) throw new SettingsError('INVALID_SETTINGS');
    return withLock(this.#filename, () => {
      const current = this.read();
      if (current.version !== version) throw new SettingsError('CONFLICT', 409);
      const next = change(structuredClone(current));
      if (!isObject(next)) throw new SettingsError('INVALID_SETTINGS');
      next.version = current.version + 1;
      validateDocument(next, { persisted: true });
      const bytes = JSON.stringify(next, null, 2) + '\n';
      if (Buffer.byteLength(bytes) > SETTINGS_LIMIT) throw new SettingsError('TOO_LARGE', 413);
      atomicWrite(this.#filename, bytes);
      return structuredClone(next);
    });
  }
}
