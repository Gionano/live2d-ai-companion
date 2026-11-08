import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export class MemoryError extends Error {
  constructor(code, status = 503) {
    super('Memory operation failed: ' + code);
    this.code = code;
    this.status = status;
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
  } catch { throw new MemoryError('MEMORY_STORAGE'); }
  finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* Original error wins. */ }
    try { fs.unlinkSync(temporary); } catch { /* Renamed or never created. */ }
  }
}

export function readFile(filename, maximum = 64 * 1024 * 1024) {
  let descriptor;
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new MemoryError('MEMORY_CORRUPT');
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (fs.fstatSync(descriptor).size > maximum) throw new MemoryError('MEMORY_CORRUPT');
    const bytes = Buffer.alloc(stat.size + 1);
    const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length !== stat.size) throw new MemoryError('MEMORY_CORRUPT');
    return bytes.subarray(0, length);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof MemoryError) throw error;
    throw new MemoryError('MEMORY_STORAGE');
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function readJson(filename, maximum) {
  const bytes = readFile(filename, maximum);
  if (bytes === null) return null;
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new MemoryError('MEMORY_CORRUPT'); }
}

export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export function lease(filename) {
  const id = randomUUID();
  let descriptor;
  try { descriptor = fs.openSync(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw new MemoryError('MEMORY_STORAGE');
    const guard = filename + '.recovery';
    let recovery;
    try { recovery = fs.openSync(guard, 'wx', 0o600); }
    catch { throw new MemoryError('LOCK_BUSY', 409); }
    try {
      const previous = readJson(filename, 2048);
      if (!previous || typeof previous.id !== 'string' || !Number.isSafeInteger(previous.pid)) {
        throw new MemoryError('LOCK_UNKNOWN', 409);
      }
      if (alive(previous.pid)) throw new MemoryError('LOCK_BUSY', 409);
      fs.unlinkSync(filename);
      descriptor = fs.openSync(filename, 'wx', 0o600);
    } finally { fs.closeSync(recovery); fs.unlinkSync(guard); }
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, id }));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
  } catch {
    try { fs.closeSync(descriptor); } catch { /* Best effort. */ }
    try { fs.unlinkSync(filename); } catch { /* Best effort. */ }
    throw new MemoryError('MEMORY_STORAGE');
  }
  return () => {
    const current = readJson(filename, 2048);
    if (current?.id === id && current.pid === process.pid) fs.unlinkSync(filename);
  };
}

export const newState = now => ({ version: 2, revision: 0, generation: randomUUID(), createdAt: now,
  lastSeen: null, migrationComplete: false, legacyHash: null, profile: { userName: '', nickname: 'sayang', legacy: false },
  eventIds: [], facts: [], episodes: [], jobs: [], tombstones: [], vectors: null, sequence: 0, purgeLegacy: false });

export function validateEvent(event) {
  if (!event || !safeId(event.id) || !Number.isFinite(event.timestamp)
    || typeof event.userText !== 'string' || typeof event.assistantText !== 'string'
    || !event.assistantText.trim() || event.userText.length > 65536 || event.assistantText.length > 65536
    || typeof event.origin !== 'string') throw new MemoryError('INVALID_MEMORY', 400);
  return event;
}

function validateState(state) {
  if (!state || state.version !== 2 || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !safeId(state.generation) || !Array.isArray(state.eventIds) || state.eventIds.some(id => !safeId(id))
    || !Array.isArray(state.tombstones) || state.tombstones.some(id => !safeId(id))
    || !Array.isArray(state.facts) || !Array.isArray(state.episodes) || !Array.isArray(state.jobs)
    || !state.profile || typeof state.profile !== 'object') throw new MemoryError('MEMORY_CORRUPT');
  return state;
}

export class MemoryStore {
  constructor(dataDir, { now = Date.now } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.root = path.join(this.dataDir, 'memory-v2');
    this.eventsDir = path.join(this.root, 'events');
    this.statePath = path.join(this.root, 'state.json');
    this.backupPath = path.join(this.root, 'legacy-backup.json');
    this.legacyPath = path.join(this.dataDir, 'memory.json');
    this.now = now;
    this.events = new Map();
  }

  ensureDirectories() {
    for (const directory of [this.root, this.eventsDir]) {
      fs.mkdirSync(directory, { recursive: true });
      if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
        throw new MemoryError('MEMORY_STORAGE');
      }
    }
  }

  open() {
    this.ensureDirectories();
    this.transact(state => {
      if (!state.migrationComplete) this.migrate(state);
      const known = new Set(state.eventIds);
      for (const name of fs.readdirSync(this.eventsDir)) {
        if (!name.endsWith('.json') || !safeId(name.slice(0, -5))) continue;
        const id = name.slice(0, -5);
        if (state.tombstones.includes(id)) continue;
        const event = this.event(id);
        if (!event || event.id !== id) throw new MemoryError('MEMORY_CORRUPT');
        if (!known.has(id)) {
          state.eventIds.push(id);
          known.add(id);
          state.jobs.push(this.eventJob(id, 'extract', this.now() + 120000, state.generation),
            this.eventJob(id, 'embed', this.now(), state.generation));
        }
      }
      state.eventIds = state.eventIds.filter(id => !state.tombstones.includes(id) && this.event(id));
    });
    for (const id of this.state.tombstones) this.removeEvent(id);
    if (this.state.purgeLegacy) this.purgeLegacy();
    this.purgeVectors(this.state.vectors?.file);
    return this.state;
  }

  eventJob(id, type, dueAt, generation) {
    return { id: 'job_' + digest(type + ':' + id).slice(0, 32), type, sourceIds: [id],
      state: 'queued', attempt: 0, dueAt, createdAt: this.now(), generation };
  }

  migrate(state) {
    const bytes = readFile(this.legacyPath, 8 * 1024 * 1024);
    if (bytes) {
      let legacy;
      try { legacy = JSON.parse(bytes.toString('utf8')); }
      catch { throw new MemoryError('LEGACY_MEMORY_CORRUPT'); }
      if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new MemoryError('LEGACY_MEMORY_CORRUPT');
      atomicWrite(this.backupPath, bytes);
      state.legacyHash = digest(bytes);
      state.lastSeen = Number.isFinite(legacy.lastSeen) ? legacy.lastSeen : null;
      state.profile = { userName: typeof legacy.profile?.userName === 'string' ? legacy.profile.userName : '',
        nickname: typeof legacy.profile?.nickname === 'string' ? legacy.profile.nickname : 'sayang', legacy: true };
      for (const [index, row] of (Array.isArray(legacy.profile?.facts) ? legacy.profile.facts : []).entries()) {
        const text = typeof row === 'string' ? row : row?.text;
        if (typeof text !== 'string' || !text.trim()) continue;
        const id = 'legacy_' + digest(index + ':' + text).slice(0, 32);
        state.facts.push({ id, text: text.trim(), subject: 'user', predicate: row?.category || 'legacy', value: text.trim(),
          category: row?.category || 'legacy', origin: 'legacy', status: 'legacy', quotes: [], sourceIds: [],
          timestamp: Date.parse(row?.createdAt) || state.lastSeen || 0, createdAt: row?.createdAt || null });
      }
      for (const [field, predicate] of [['userName', 'name'], ['nickname', 'nickname']]) {
        const value = state.profile[field];
        if (!value || field === 'nickname' && value === 'sayang') continue;
        state.facts.push({ id: 'legacy_profile_' + field, text: `${predicate}: ${value}`, subject: 'user', predicate, value,
          category: 'profile', origin: 'legacy', status: 'legacy', quotes: [], sourceIds: [],
          timestamp: state.lastSeen || 0, createdAt: null });
      }
      for (const [index, row] of (Array.isArray(legacy.episodes) ? legacy.episodes : []).entries()) {
        if (typeof row?.summary !== 'string' || !row.summary.trim()) continue;
        state.episodes.push({ id: 'episode_' + digest(index + ':' + row.summary).slice(0, 32),
          summary: row.summary, topic: typeof row.topic === 'string' ? row.topic : '', date: row.date || '',
          timestamp: Number(row.timestamp) || state.lastSeen || 0, origin: 'legacy', status: 'legacy', sourceIds: [], quotes: [] });
      }
    }
    state.migrationComplete = true;
  }

  refresh() {
    const state = readJson(this.statePath);
    if (!state) throw new MemoryError('MEMORY_STORAGE');
    this.state = validateState(state);
    return this.state;
  }

  transact(operation, { expectedRevision, generation } = {}) {
    this.ensureDirectories();
    const release = lease(this.statePath + '.lock');
    try {
      const disk = readJson(this.statePath);
      const state = disk ? validateState(disk) : newState(this.now());
      if (expectedRevision !== undefined && expectedRevision !== state.revision) throw new MemoryError('CONFLICT', 409);
      if (generation !== undefined && generation !== state.generation) throw new MemoryError('MEMORY_STALE', 409);
      const result = operation(state);
      state.revision++;
      atomicWrite(this.statePath, JSON.stringify(state));
      this.state = state;
      return result;
    } finally { release(); }
  }

  event(id) {
    if (!safeId(id)) throw new MemoryError('INVALID_MEMORY', 400);
    if (this.events.has(id)) return this.events.get(id);
    const row = readJson(path.join(this.eventsDir, id + '.json'), 512 * 1024);
    if (!row) return null;
    const event = validateEvent(row);
    this.events.set(id, event);
    return event;
  }

  writeEvent(event) {
    const filename = path.join(this.eventsDir, event.id + '.json');
    if (readFile(filename, 512 * 1024)) return this.event(event.id);
    atomicWrite(filename, JSON.stringify(event));
    this.events.set(event.id, event);
    return event;
  }

  removeEvent(id) {
    if (!safeId(id)) throw new MemoryError('INVALID_MEMORY', 400);
    this.events.delete(id);
    try { fs.unlinkSync(path.join(this.eventsDir, id + '.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw new MemoryError('MEMORY_STORAGE'); }
  }

  purgeLegacy() {
    for (const filename of [this.backupPath, this.legacyPath]) {
      const bytes = readFile(filename, 8 * 1024 * 1024);
      if (!bytes) continue;
      if (this.state.legacyHash && digest(bytes) !== this.state.legacyHash) throw new MemoryError('LEGACY_MEMORY_CHANGED', 409);
      fs.unlinkSync(filename);
    }
  }

  purgeVectors(activeFile = null) {
    for (const name of fs.readdirSync(this.root)) {
      if (/^vectors-[a-f0-9-]+\.f32$/.test(name) && name !== activeFile) {
        fs.unlinkSync(path.join(this.root, name));
      }
    }
  }
}
