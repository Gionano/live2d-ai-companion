import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { atomicWrite, readBounded, withLock } from './files.js';
import { validateBaseUrl } from '../providers/baseUrl.js';
import { bounded, headerName, identifier, invalid, isObject, object, SettingsError, SLOT_NAMES, splitExtras } from './schema.js';

const SECRET_LIMIT = 256 * 1024;
const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $bytes = [Convert]::FromBase64String($request.data)
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($request.operation -eq 'protect') {
    $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
  } elseif ($request.operation -eq 'unprotect') {
    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)
  } else { exit 1 }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch { exit 1 }
`;

// The command and arguments are constant. Secret bytes travel only through stdin/stdout.
export function runDpapi(request, { spawn = spawnSync, environment = process.env } = {}) {
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)));
  try {
    const result = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], {
      input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 5000,
      maxBuffer: SECRET_LIMIT * 4, shell: false, env,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') throw new Error();
    return result.stdout.trim();
  } catch { throw new SettingsError('SECRET_STORAGE', 503); }
}

function secretOrigin(origin) {
  try {
    const checked = validateBaseUrl(origin, { websocket: /^wss?:/.test(origin) });
    if (checked.origin !== origin) invalid();
  } catch { invalid(); }
  return origin;
}

function base64(value) {
  if (typeof value !== 'string' || !value.length || value.length > SECRET_LIMIT * 2
    || Buffer.from(value, 'base64').toString('base64') !== value) throw new SettingsError('SECRET_STORAGE', 503);
  return value;
}

function validateRecords(records) {
  if (!isObject(records) || Object.keys(records).length > 33
    || Object.keys(records).filter(id => id !== 'pap-cloudflare').length > 32) invalid();
  const result = {};
  for (const [id, entry] of Object.entries(records)) {
    identifier(id);
    object(entry, ['origin', 'values']);
    result[id] = { origin: secretOrigin(entry.origin), values: validateSecretValues(entry.values) };
  }
  return bounded(result, SECRET_LIMIT);
}

function secretText(value) {
  if (typeof value !== 'string' || !value.length || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}

export function validateSecretValues(value) {
  object(value, ['apiKey', 'headers', 'bodyExtras', 'slotBodyExtras']);
  const result = structuredClone(value);
  if (value.apiKey !== undefined) secretText(value.apiKey);
  if (value.headers !== undefined) {
    if (!isObject(value.headers) || Object.keys(value.headers).length > 32) invalid();
    result.headers = Object.fromEntries(Object.entries(value.headers).map(([name, item]) => [headerName(name), secretText(item)]));
  }
  if (value.bodyExtras !== undefined) splitExtras(value.bodyExtras, { allowSecrets: true });
  if (value.slotBodyExtras !== undefined) {
    object(value.slotBodyExtras, SLOT_NAMES);
    Object.values(value.slotBodyExtras).forEach(extras => splitExtras(extras, { allowSecrets: true }));
  }
  return bounded(result, SECRET_LIMIT / 2);
}

export class EnvSecretStore {
  #env;
  constructor(env = process.env) { this.#env = env; this.backendName = 'env'; }
  get(name) { return Object.hasOwn(this.#env, name) && typeof this.#env[name] === 'string' && this.#env[name] ? this.#env[name] : undefined; }
  has(name) { return this.get(name) !== undefined; }
  set() { throw new SettingsError('READ_ONLY', 409); }
  delete() { throw new SettingsError('READ_ONLY', 409); }
}

/** Values remain private and are never part of JSON serialization or status. */
export class SecretStore {
  #runner;
  #records = {};
  #filename;
  #revision = 0;
  #lastWrite;
  constructor({ localDir, platform = process.platform, allowPlaintext = false, runner = runDpapi } = {}) {
    this.backendName = allowPlaintext === true ? 'plaintext-file' : platform === 'win32' ? 'windows-dpapi' : 'env';
    this.warning = this.backendName === 'plaintext-file' ? 'Secrets are stored in plaintext by explicit opt-in.' : null;
    this.error = null;
    this.#filename = path.join(localDir, 'secrets.dat');
    this.#runner = runner;
    this.#load();
  }

  #transform(operation, data) {
    try {
      return base64(this.#runner({ operation, data: base64(data) }));
    } catch { throw new SettingsError('SECRET_STORAGE', 503); }
  }

  #load() {
    try {
      const bytes = readBounded(this.#filename, SECRET_LIMIT * 2);
      if (bytes === null) { this.#records = {}; this.error = null; return; }
      const file = JSON.parse(bytes.toString('utf8'));
      object(file, this.backendName === 'windows-dpapi' ? ['format', 'backend', 'ciphertext'] : ['format', 'backend', 'records']);
      if (file.format !== 1 || file.backend !== this.backendName || this.backendName === 'env') throw new Error();
      const records = this.backendName === 'windows-dpapi'
        ? JSON.parse(Buffer.from(this.#transform('unprotect', file.ciphertext), 'base64').toString('utf8')) : file.records;
      this.#records = validateRecords(records);
      this.error = null;
    } catch {
      this.#records = {};
      this.error = 'SECRET_STORAGE';
    }
  }

  #write(records) {
    if (this.backendName === 'env') throw new SettingsError('READ_ONLY', 409);
    if (this.error) throw new SettingsError('SECRET_STORAGE', 503);
    const checked = validateRecords(records);
    const payload = JSON.stringify(checked);
    const file = this.backendName === 'windows-dpapi'
      ? { format: 1, backend: this.backendName, ciphertext: this.#transform('protect', Buffer.from(payload).toString('base64')) }
      : { format: 1, backend: this.backendName, records: checked };
    const bytes = Buffer.from(JSON.stringify(file) + '\n');
    if (bytes.length > SECRET_LIMIT * 2) throw new SettingsError('TOO_LARGE', 413);
    atomicWrite(this.#filename, bytes);
    this.#lastWrite = bytes;
    this.#records = checked;
    this.#revision++;
  }

  get(id, origin) {
    if (this.error) throw new SettingsError('SECRET_STORAGE', 503);
    const record = Object.hasOwn(this.#records, id) ? this.#records[id] : undefined;
    return record?.origin === origin ? structuredClone(record.values) : undefined;
  }
  has(id, origin) { return !this.error && Object.hasOwn(this.#records, id)
    && (origin === undefined || this.#records[id].origin === origin); }
  containsSecret(text) {
    if (typeof text !== 'string') return false;
    const contains = value => typeof value === 'string' ? Boolean(value) && text.includes(value)
      : value !== null && typeof value === 'object' && Object.values(value).some(contains);
    return Object.values(this.#records).some(record => contains(record.values));
  }
  set(id, origin, values) {
    identifier(id);
    const checked = validateSecretValues(values);
    secretOrigin(origin);
    return withLock(this.#filename, () => {
      this.#load();
      this.#write({ ...this.#records, [id]: { origin, values: checked } });
    });
  }
  delete(id) {
    identifier(id);
    return withLock(this.#filename, () => {
      this.#load();
      const records = { ...this.#records };
      delete records[id];
      this.#write(records);
    });
  }
  // A closure keeps in-flight adapters on the original credentials after reload.
  snapshot() {
    const records = structuredClone(this.#records);
    const failed = Boolean(this.error);
    return (id, origin) => {
      if (failed) throw new SettingsError('SECRET_STORAGE', 503);
      return Object.hasOwn(records, id) && records[id].origin === origin ? structuredClone(records[id].values) : undefined;
    };
  }
  checkpoint() {
    this.#load();
    const bytes = readBounded(this.#filename, SECRET_LIMIT * 2);
    const revision = this.#revision;
    const records = structuredClone(this.#records);
    let restored = false;
    return () => {
      if (restored) return;
      if (revision === this.#revision) { restored = true; return; }
      withLock(this.#filename, () => {
        const current = readBounded(this.#filename, SECRET_LIMIT * 2);
        // Never roll back another writer's committed credentials.
        if (!current?.equals(this.#lastWrite)) throw new SettingsError('CONFLICT', 409);
        if (bytes === null) {
          try { fs.unlinkSync(this.#filename); } catch (error) { if (error.code !== 'ENOENT') throw new SettingsError('SECRET_STORAGE', 503); }
        } else atomicWrite(this.#filename, bytes);
        this.#records = records;
        this.#lastWrite = bytes;
        this.#revision++;
        restored = true;
      });
    };
  }
}
