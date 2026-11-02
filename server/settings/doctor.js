import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { SecretStore } from './secretStore.js';
import { inspectLock, lockThreshold, readBounded } from './files.js';
import { SETTINGS_LIMIT } from './schema.js';

export function settingsDoctor({ localDir, version, platform = process.platform, runner, allowPlaintext = false, includePaths = false } = {}) {
  const locations = Object.fromEntries(['settings.json', 'secrets.dat'].map(name => [name, includePaths ? path.join(localDir, name) : '<local>/' + name]));
  const result = { backendName: allowPlaintext ? 'plaintext-file' : platform === 'win32' ? 'windows-dpapi' : 'env',
    locations, version: version ?? 0, writable: false, permissionNote: platform === 'win32' ? 'WINDOWS_ACL_UNVERIFIED' : 'OWNER_ONLY_RECOMMENDED',
    locks: {}, staleAfterMs: lockThreshold(), corruptBackups: 0, selfTest: { ok: false, code: 'STORAGE' } };
  // Inspect metadata without initializing SettingsService or opening the real secret store.
  try {
    fs.accessSync(localDir, fs.constants.R_OK | fs.constants.W_OK);
    result.writable = true;
  } catch { /* A missing/read-only local directory must not prevent the isolated self-test. */ }
  try {
    if (version === undefined) {
      try {
        const saved = JSON.parse(readBounded(path.join(localDir, 'settings.json'), SETTINGS_LIMIT));
        result.version = Number.isSafeInteger(saved?.version) && saved.version >= 0 ? saved.version : 0;
      } catch { result.version = null; }
    }
    for (const name of Object.keys(locations)) {
      try { result.locks[name] = inspectLock(path.join(localDir, name + '.lock')); }
      catch { result.locks[name] = { state: 'unknown' }; }
      result.locks[name + '.lock.recovery'] = { state: fs.existsSync(path.join(localDir, name + '.lock.recovery')) ? 'unknown' : 'absent' };
    }
    result.corruptBackups = fs.readdirSync(localDir).filter(name => /^settings\.json\.corrupt-.+\.bak$/.test(name)).length;
  } catch { /* Metadata may be unavailable; never create or repair local files here. */ }
  if (result.backendName === 'env') { result.selfTest.code = 'READ_ONLY'; return result; }
  const temporaryRoot = path.resolve(os.tmpdir());
  let scratch;
  try {
    // Both CLI and GUI exercise only an OS-temp store, including on failure.
    scratch = fs.mkdtempSync(path.join(temporaryRoot, 'waifu-settings-doctor-'));
    const options = { localDir: scratch, platform, runner, allowPlaintext };
    const dummy = randomBytes(32).toString('base64');
    const store = new SecretStore(options);
    store.set('doctor', 'https://example.invalid', { apiKey: dummy });
    const restored = new SecretStore(options);
    const matches = restored.get('doctor', 'https://example.invalid')?.apiKey === dummy;
    restored.delete('doctor');
    const ok = matches && !new SecretStore(options).has('doctor');
    result.selfTest = { ok, code: ok ? null : 'SECRET_STORAGE' };
  } catch { result.selfTest = { ok: false, code: 'SECRET_STORAGE' }; }
  finally {
    if (scratch && path.dirname(path.resolve(scratch)) === temporaryRoot && path.basename(scratch).startsWith('waifu-settings-doctor-')) {
      try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { result.selfTest = { ok: false, code: 'CLEANUP_REQUIRED' }; }
    }
  }
  return result;
}
