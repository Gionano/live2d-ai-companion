import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SettingsError } from './schema.js';

export function readBounded(filename, maximum) {
  let descriptor;
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new SettingsError('STORAGE', 503);
    if (stat.size > maximum) throw new SettingsError('TOO_LARGE', 413);
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) throw new SettingsError('STORAGE', 503);
    if (opened.size > maximum) throw new SettingsError('TOO_LARGE', 413);
    // Bound the allocation and read even if another process grows the file.
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length <= maximum) {
      const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maximum) throw new SettingsError('TOO_LARGE', 413);
    return bytes.subarray(0, length);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SettingsError) throw error;
    throw new SettingsError('STORAGE', 503);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Read error remains authoritative. */ }
    }
  }
}

export function atomicWrite(filename, bytes) {
  const temporary = filename + '.' + randomUUID() + '.tmp';
  let descriptor;
  try {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filename);
  } catch {
    throw new SettingsError('STORAGE', 503);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Write error remains authoritative. */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* Renamed or never created. */ }
  }
}

export function lockThreshold(value = process.env.WAIFU_SETTINGS_LOCK_STALE_MS) {
  const parsed = Number(value ?? 30000);
  return Number.isFinite(parsed) && parsed >= 1000 && parsed <= 86400000 ? parsed : 30000;
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export function inspectLock(lock, { now = Date.now, alive = pidAlive, staleMs = lockThreshold() } = {}) {
  const bytes = readBounded(lock, 1024);
  if (bytes === null) return { state: 'absent' };
  try {
    const owner = JSON.parse(bytes);
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !Number.isFinite(owner.createdAt)
      || typeof owner.nonce !== 'string') throw new Error();
    const ageMs = Math.max(0, now() - owner.createdAt);
    return { state: !alive(owner.pid) && ageMs > staleMs ? 'stale' : 'busy', ageMs };
  } catch { return { state: 'unknown' }; }
}

export function withLock(filename, operation, options = {}) {
  const lock = filename + '.lock';
  let descriptor;
  try {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    try { descriptor = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let recovery;
      try { recovery = fs.openSync(lock + '.recovery', 'wx', 0o600); }
      catch { throw new SettingsError('LOCK_RECOVERY', 409); }
      try {
        const state = inspectLock(lock, options).state;
        if (state === 'unknown') throw new SettingsError('LOCK_UNKNOWN', 409);
        if (state === 'busy') throw new SettingsError('LOCK_BUSY', 409);
        if (state === 'stale') fs.unlinkSync(lock);
        descriptor = fs.openSync(lock, 'wx', 0o600);
      } finally { fs.closeSync(recovery); fs.unlinkSync(lock + '.recovery'); }
    }
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: (options.now || Date.now)(), nonce: randomUUID() }));
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); fs.unlinkSync(lock); } catch {} }
    if (error instanceof SettingsError) throw error;
    throw new SettingsError(error.code === 'EEXIST' ? 'LOCK_BUSY' : 'STORAGE', error.code === 'EEXIST' ? 409 : 503);
  }
  let value;
  let failure;
  try { value = operation(); } catch (error) { failure = error; }
  try { fs.closeSync(descriptor); } catch { failure ||= new SettingsError('STORAGE', 503); }
  try { fs.unlinkSync(lock); } catch { failure ||= new SettingsError('STORAGE', 503); }
  if (failure) throw failure;
  return value;
}
