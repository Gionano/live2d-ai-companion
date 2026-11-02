import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { atomicWrite, readBounded, withLock } from '../settings/files.js';
import { SettingsStore } from '../settings/store.js';
import { EnvSecretStore, SecretStore, runDpapi, validateSecretValues } from '../settings/secretStore.js';
import { emptySettings, SETTINGS_LIMIT, SettingsError } from '../settings/schema.js';

const SECRET = 'storage-fixture-private-value';
const ORIGIN = 'https://example.invalid';
const VALUES = { apiKey: SECRET, headers: { 'x-api-key': SECRET },
  bodyExtras: { auth: { access_token: SECRET } }, slotBodyExtras: { llm: { password: SECRET } } };

function localFixture(t) {
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-storage-'));
  t.after(() => fs.rmSync(localDir, { recursive: true, force: true }));
  return localDir;
}

function safeFailure(action, code, privateValues = []) {
  assert.throws(action, error => {
    assert.equal(error instanceof SettingsError, true);
    assert.equal(error.code, code);
    assert.equal([SECRET, ...privateValues].some(value => error.message.includes(value)), false);
    return true;
  });
}

// Authenticated fixture encryption tests the process boundary without invoking PowerShell.
function fakeDpapi() {
  const key = randomBytes(32);
  const calls = [];
  const runner = ({ operation, data }) => {
    calls.push(operation);
    const bytes = Buffer.from(data, 'base64');
    if (operation === 'protect') {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
    }
    assert.equal(operation, 'unprotect');
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('base64');
  };
  return { runner, calls };
}

test('missing settings return isolated defaults without exposing a storage path', t => {
  const localDir = localFixture(t);
  const store = new SettingsStore({ localDir });
  const first = store.read();
  assert.deepEqual(first, emptySettings());
  first.ui.language = 'en';
  assert.equal(store.read().ui.language, 'id');
  assert.equal(fs.existsSync(path.join(localDir, 'settings.json')), false);
  assert.equal(JSON.stringify(store).includes(localDir), false);
});

test('settings updates are versioned, persistent, copied, and leave no temporary files', t => {
  const localDir = localFixture(t);
  const store = new SettingsStore({ localDir });
  const result = store.update(0, current => {
    current.ui.language = 'en';
    return current;
  });
  assert.equal(result.version, 1);
  result.ui.language = 'id';
  assert.equal(new SettingsStore({ localDir }).read().ui.language, 'en');
  assert.deepEqual(fs.readdirSync(localDir), ['settings.json']);
});

test('two settings writers using the same version yield one conflict without lost updates', t => {
  const localDir = localFixture(t);
  const one = new SettingsStore({ localDir });
  const two = new SettingsStore({ localDir });
  const version = two.read().version;
  one.update(version, current => ({ ...current, ui: { language: 'en' } }));
  let called = false;
  safeFailure(() => two.update(version, current => { called = true; return current; }), 'CONFLICT');
  assert.equal(called, false);
  assert.equal(two.read().version, 1);
  assert.equal(two.read().ui.language, 'en');
});

for (const version of [undefined, null, -1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
  test('settings reject invalid version ' + String(version), t => {
    const store = new SettingsStore({ localDir: localFixture(t) });
    safeFailure(() => store.update(version, current => current), 'INVALID_SETTINGS');
    assert.equal(store.read().version, 0);
  });
}

test('exclusive lock rejects overlapping writers and releases after an operation failure', t => {
  const localDir = localFixture(t);
  const filename = path.join(localDir, 'document');
  safeFailure(() => withLock(filename, () => {
    safeFailure(() => withLock(filename, () => {}), 'LOCK_BUSY');
    assert.equal(fs.existsSync(filename + '.lock'), true);
    throw new SettingsError('INVALID_SETTINGS');
  }), 'INVALID_SETTINGS');
  assert.equal(fs.existsSync(filename + '.lock'), false);
  assert.equal(withLock(filename, () => 7), 7);
});

test('an existing crash lock fails closed and is never removed by a competing writer', t => {
  const localDir = localFixture(t);
  const lock = path.join(localDir, 'settings.json.lock');
  fs.writeFileSync(lock, 'fixture-lock');
  safeFailure(() => new SettingsStore({ localDir }).update(0, current => current), 'LOCK_UNKNOWN');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'fixture-lock');
});

for (const type of ['json', 'schema', 'oversized']) {
  test('corrupt settings preserve exact backup bytes and recover: ' + type, t => {
    const localDir = localFixture(t);
    const filename = path.join(localDir, 'settings.json');
    const bytes = type === 'json' ? Buffer.from('{private:' + SECRET + localDir)
      : type === 'schema' ? Buffer.from(JSON.stringify({ ...emptySettings(), safety: SECRET }))
        : Buffer.alloc(SETTINGS_LIMIT + 1, 120);
    fs.writeFileSync(filename, bytes);
    const store = new SettingsStore({ localDir });
    assert.deepEqual(store.read(), emptySettings());
    assert.equal(store.recovered, true);
    const backup = fs.readdirSync(localDir);
    assert.equal(backup.length, 1);
    assert.match(backup[0], /^settings\.json\.corrupt-[a-f0-9-]+\.bak$/);
    assert.equal(fs.readFileSync(path.join(localDir, backup[0])).equals(bytes), true);
    store.update(0, current => current);
    assert.equal(store.read().version, 1);
    assert.equal(fs.existsSync(path.join(localDir, backup[0])), true);
  });
}

test('non-regular settings paths fail safely without renaming them', t => {
  const localDir = localFixture(t);
  const filename = path.join(localDir, 'settings.json');
  fs.mkdirSync(filename);
  safeFailure(() => new SettingsStore({ localDir }).read(), 'STORAGE', [localDir]);
  assert.deepEqual(fs.readdirSync(localDir), ['settings.json']);
});

test('settings enforce the size of the actual formatted file before replacing it', t => {
  const localDir = localFixture(t);
  const store = new SettingsStore({ localDir });
  store.update(0, current => current);
  const extras = Object.fromEntries(Array.from({ length: 64 }, (_, index) => ['branch' + index,
    Object.fromEntries(Array.from({ length: 50 }, (_, child) => ['field' + child, true]))]));
  const next = { ...emptySettings(), version: 1, profiles: { fixture: {
    adapter: 'openaiCompatible', baseUrl: ORIGIN, bodyExtras: extras,
  } } };
  assert.equal(Buffer.byteLength(JSON.stringify(next)) < SETTINGS_LIMIT, true);
  assert.equal(Buffer.byteLength(JSON.stringify(next, null, 2)) > SETTINGS_LIMIT, true);
  safeFailure(() => store.update(1, () => next), 'TOO_LARGE');
  assert.deepEqual(store.read(), { ...emptySettings(), version: 1 });
  assert.deepEqual(fs.readdirSync(localDir), ['settings.json']);
});

test('a failed rename preserves the previous atomic file and removes its temporary file', t => {
  const localDir = localFixture(t);
  const filename = path.join(localDir, 'settings.json');
  atomicWrite(filename, 'old');
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => {
      if (to === filename) throw new Error(SECRET + localDir);
      return rename(from, to);
    };
    safeFailure(() => atomicWrite(filename, 'new'), 'STORAGE', [localDir]);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(filename, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(localDir), ['settings.json']);
});

test('bounded file reads handle missing, exact-limit and oversized files', t => {
  const filename = path.join(localFixture(t), 'bounded');
  assert.equal(readBounded(filename, 4), null);
  fs.writeFileSync(filename, 'four');
  assert.equal(readBounded(filename, 4).toString(), 'four');
  safeFailure(() => readBounded(filename, 3), 'TOO_LARGE');
});

test('bounded reads reject files that grow after the initial size check', t => {
  const filename = path.join(localFixture(t), 'growing');
  fs.writeFileSync(filename, 'four');
  const read = fs.readSync;
  let grew = false;
  try {
    fs.readSync = (...args) => {
      if (!grew) { grew = true; fs.appendFileSync(filename, 'more'); }
      return read(...args);
    };
    safeFailure(() => readBounded(filename, 4), 'TOO_LARGE');
  } finally { fs.readSync = read; }
});

test('environment backend is read-only, ignores inherited properties, and serializes no values', () => {
  const environment = Object.assign(Object.create({ INHERITED: SECRET }), { FIXTURE_API_KEY: SECRET, EMPTY: '' });
  const store = new EnvSecretStore(environment);
  assert.equal(store.backendName, 'env');
  assert.equal(store.has('FIXTURE_API_KEY'), true);
  assert.equal(store.get('FIXTURE_API_KEY'), SECRET);
  assert.equal(store.has('EMPTY'), false);
  assert.equal(store.has('INHERITED'), false);
  assert.equal(JSON.stringify(store).includes(SECRET), false);
  safeFailure(() => store.set('FIXTURE_API_KEY', 'replacement'), 'READ_ONLY');
  safeFailure(() => store.delete('FIXTURE_API_KEY'), 'READ_ONLY');
});

test('non-Windows secrets are read-only unless plaintext is explicitly enabled', t => {
  for (const allowPlaintext of [undefined, false, 'true', 1]) {
    const store = new SecretStore({ localDir: localFixture(t), platform: 'linux', allowPlaintext });
    assert.equal(store.backendName, 'env');
    assert.equal(store.warning, null);
    safeFailure(() => store.set('fixture', ORIGIN, VALUES), 'READ_ONLY');
    safeFailure(() => store.delete('fixture'), 'READ_ONLY');
  }
});

test('plaintext opt-in persists credentials with a durable warning and normalized header names', t => {
  const localDir = localFixture(t);
  const store = new SecretStore({ localDir, platform: 'linux', allowPlaintext: true });
  store.set('fixture', ORIGIN, { ...VALUES, headers: { 'X-Api-Key': SECRET } });
  const restored = new SecretStore({ localDir, platform: 'linux', allowPlaintext: true });
  assert.equal(restored.backendName, 'plaintext-file');
  assert.equal(typeof restored.warning, 'string');
  assert.deepEqual(restored.get('fixture', ORIGIN), VALUES);
  assert.equal(fs.readFileSync(path.join(localDir, 'secrets.dat'), 'utf8').includes(SECRET), true);
  assert.equal(JSON.stringify(restored).includes(SECRET), false);
  assert.equal(inspect(restored).includes(SECRET), false);
  assert.equal(JSON.stringify(restored).includes(localDir), false);
});

test('DPAPI missing files do not invoke the runner or create credential files', t => {
  const localDir = localFixture(t);
  const fake = fakeDpapi();
  const store = new SecretStore({ localDir, platform: 'win32', runner: fake.runner });
  assert.equal(store.backendName, 'windows-dpapi');
  assert.equal(store.error, null);
  assert.equal(store.has('fixture'), false);
  assert.equal(store.has('constructor'), false);
  assert.equal(store.get('fixture', ORIGIN), undefined);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(fs.readdirSync(localDir), []);
});

test('DPAPI fake round-trip keeps ciphertext on disk and values private in public snapshots', t => {
  const localDir = localFixture(t);
  const fake = fakeDpapi();
  const store = new SecretStore({ localDir, platform: 'win32', runner: fake.runner });
  store.set('fixture', ORIGIN, VALUES);
  const serialized = fs.readFileSync(path.join(localDir, 'secrets.dat'), 'utf8');
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(ORIGIN), false);
  const envelope = JSON.parse(serialized);
  assert.deepEqual(Object.keys(envelope).sort(), ['backend', 'ciphertext', 'format']);
  assert.equal(envelope.backend, 'windows-dpapi');
  const restored = new SecretStore({ localDir, platform: 'win32', runner: fake.runner });
  assert.deepEqual(restored.get('fixture', ORIGIN), VALUES);
  assert.equal(restored.get('fixture', 'https://other.invalid'), undefined);
  assert.equal(restored.has('fixture', 'https://other.invalid'), false);
  assert.equal(JSON.stringify(restored).includes(SECRET), false);
  assert.equal(inspect(restored.snapshot()).includes(SECRET), false);
  assert.equal(JSON.stringify({ snapshot: restored.snapshot() }), '{}');
  assert.deepEqual(fake.calls, ['protect', 'unprotect']);
});

test('DPAPI tampering fails closed and never downgrades or overwrites the ciphertext', t => {
  const localDir = localFixture(t);
  const fake = fakeDpapi();
  new SecretStore({ localDir, platform: 'win32', runner: fake.runner }).set('fixture', ORIGIN, VALUES);
  const filename = path.join(localDir, 'secrets.dat');
  const envelope = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const damaged = Buffer.from(envelope.ciphertext, 'base64');
  damaged[damaged.length - 1] ^= 1;
  envelope.ciphertext = damaged.toString('base64');
  const bytes = JSON.stringify(envelope);
  fs.writeFileSync(filename, bytes);
  const store = new SecretStore({ localDir, platform: 'win32', runner: fake.runner });
  assert.equal(store.error, 'SECRET_STORAGE');
  assert.equal(store.backendName, 'windows-dpapi');
  assert.equal(store.has('fixture'), false);
  safeFailure(() => store.get('fixture', ORIGIN), 'SECRET_STORAGE', [localDir]);
  safeFailure(() => store.snapshot()('fixture', ORIGIN), 'SECRET_STORAGE');
  safeFailure(() => store.set('fixture', ORIGIN, VALUES), 'SECRET_STORAGE');
  assert.equal(fs.readFileSync(filename, 'utf8'), bytes);
});

test('secret backend changes and malformed envelopes require explicit local recovery', t => {
  const localDir = localFixture(t);
  const plaintext = new SecretStore({ localDir, allowPlaintext: true });
  plaintext.set('fixture', ORIGIN, VALUES);
  const fake = fakeDpapi();
  const protectedStore = new SecretStore({ localDir, platform: 'win32', runner: fake.runner });
  assert.equal(protectedStore.error, 'SECRET_STORAGE');
  assert.deepEqual(fake.calls, []);
  const filename = path.join(localDir, 'secrets.dat');
  const file = JSON.parse(fs.readFileSync(filename, 'utf8'));
  file.unrecognized = SECRET;
  fs.writeFileSync(filename, JSON.stringify(file));
  const invalidStore = new SecretStore({ localDir, allowPlaintext: true });
  assert.equal(invalidStore.error, 'SECRET_STORAGE');
  safeFailure(() => invalidStore.get('fixture', ORIGIN), 'SECRET_STORAGE');
});

test('oversized secret files fail closed and remain intact for local recovery', t => {
  const localDir = localFixture(t);
  const filename = path.join(localDir, 'secrets.dat');
  const bytes = Buffer.alloc(512 * 1024 + 1, 120);
  fs.writeFileSync(filename, bytes);
  const store = new SecretStore({ localDir, allowPlaintext: true });
  assert.equal(store.error, 'SECRET_STORAGE');
  safeFailure(() => store.get('fixture', ORIGIN), 'SECRET_STORAGE');
  safeFailure(() => store.set('fixture', ORIGIN, VALUES), 'SECRET_STORAGE');
  assert.equal(fs.readFileSync(filename).equals(bytes), true);
});

test('DPAPI runner failures and invalid outputs become fixed value-free errors', t => {
  for (const runner of [() => { throw new Error(SECRET); }, () => '', () => 'not base64', () => Promise.resolve('eA==')]) {
    const localDir = localFixture(t);
    const store = new SecretStore({ localDir, platform: 'win32', runner });
    safeFailure(() => store.set('fixture', ORIGIN, VALUES), 'SECRET_STORAGE', [localDir]);
    assert.deepEqual(fs.readdirSync(localDir), []);
  }
});

test('PowerShell process uses a constant CurrentUser script, stdin, bounded execution and no inherited keys', () => {
  const requests = [];
  const spawn = (command, args, options) => { requests.push({ command, args, options }); return { status: 0, stdout: 'eA==' }; };
  const environment = { PATH: 'fixture-bin', FIXTURE_API_KEY: SECRET, UNRELATED_SECRET: SECRET };
  const request = { operation: 'protect', data: Buffer.from(SECRET).toString('base64') };
  assert.equal(runDpapi(request, { spawn, environment }), 'eA==');
  runDpapi({ ...request, data: Buffer.from('changed').toString('base64') }, { spawn, environment });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].args, requests[1].args);
  assert.equal(requests[0].command, 'powershell.exe');
  assert.equal(requests[0].args.includes('-NoProfile'), true);
  assert.equal(requests[0].args.includes('-NonInteractive'), true);
  const script = requests[0].args.at(-1);
  assert.match(script, /ProtectedData.*Protect/);
  assert.match(script, /DataProtectionScope\]::CurrentUser/);
  assert.equal(script.includes(SECRET), false);
  assert.equal(script.includes(request.data), false);
  assert.equal(requests[0].options.input, JSON.stringify(request));
  assert.deepEqual(requests[0].options.env, { PATH: 'fixture-bin' });
  assert.equal(requests[0].options.windowsHide, true);
  assert.equal(requests[0].options.shell, false);
  assert.equal(requests[0].options.timeout, 5000);
  assert.equal(requests[0].options.maxBuffer <= 1024 * 1024, true);
});

test('PowerShell startup, exit and output failures cannot expose child diagnostics', () => {
  const request = { operation: 'protect', data: 'eA==' };
  for (const spawn of [() => { throw new Error(SECRET); },
    () => ({ status: 1, stdout: SECRET, stderr: SECRET }),
    () => ({ status: 0, error: new Error(SECRET) }), () => ({ status: 0, stdout: null })]) {
    safeFailure(() => runDpapi(request, { spawn, environment: {} }), 'SECRET_STORAGE');
  }
});

test('secret reads and resolver closures are copied and survive later writes and deletion', t => {
  const localDir = localFixture(t);
  const store = new SecretStore({ localDir, allowPlaintext: true });
  store.set('fixture', ORIGIN, VALUES);
  const read = store.snapshot();
  const value = store.get('fixture', ORIGIN);
  value.headers['x-api-key'] = 'mutated';
  assert.equal(store.get('fixture', ORIGIN).headers['x-api-key'], SECRET);
  store.set('fixture', ORIGIN, { apiKey: 'new-fixture' });
  assert.deepEqual(read('fixture', ORIGIN), VALUES);
  store.delete('fixture');
  assert.equal(store.has('fixture'), false);
  assert.equal(new SecretStore({ localDir, allowPlaintext: true }).has('fixture'), false);
  assert.deepEqual(read('fixture', ORIGIN), VALUES);
});

test('secret membership covers dormant profiles and origins without exposing stored values', t => {
  const localDir = localFixture(t);
  const store = new SecretStore({ localDir, allowPlaintext: true });
  const dormantHeader = 'dormant-header-fixture';
  const dormantBody = 'dormant-body-fixture';
  const dormantSlot = 'dormant-slot-fixture';
  store.set('active', ORIGIN, { apiKey: SECRET });
  store.set('dormant', 'https://dormant.invalid', { headers: { 'x-fixture': dormantHeader },
    bodyExtras: { vendor: { access_token: dormantBody } }, slotBodyExtras: { llm: { password: dormantSlot } } });
  const restored = new SecretStore({ localDir, allowPlaintext: true });
  assert.equal(restored.get('dormant', ORIGIN), undefined);
  for (const value of [SECRET, dormantHeader, dormantBody, dormantSlot]) {
    assert.equal(restored.containsSecret(value), true);
    assert.equal(restored.containsSecret('prefix ' + value + ' suffix'), true);
    assert.equal(JSON.stringify(restored).includes(value), false);
    assert.equal(inspect(restored).includes(value), false);
  }
  for (const value of [undefined, null, {}, '', 'ordinary public setting', ORIGIN, 'https://dormant.invalid']) {
    assert.equal(restored.containsSecret(value), false);
  }
});

test('secret writes reload existing records so separate stores do not lose other profiles', t => {
  const localDir = localFixture(t);
  const one = new SecretStore({ localDir, allowPlaintext: true });
  const two = new SecretStore({ localDir, allowPlaintext: true });
  one.set('one', ORIGIN, VALUES);
  two.set('two', ORIGIN, VALUES);
  const result = new SecretStore({ localDir, allowPlaintext: true });
  assert.equal(result.has('one'), true);
  assert.equal(result.has('two'), true);
});

test('secret checkpoints restore replaced files or remove newly created files', t => {
  const localDir = localFixture(t);
  const store = new SecretStore({ localDir, allowPlaintext: true });
  const initial = store.checkpoint();
  store.set('fixture', ORIGIN, VALUES);
  initial();
  initial();
  assert.equal(store.has('fixture'), false);
  assert.deepEqual(fs.readdirSync(localDir), []);
  store.set('fixture', ORIGIN, VALUES);
  const previous = fs.readFileSync(path.join(localDir, 'secrets.dat'));
  const rollback = store.checkpoint();
  store.set('fixture', ORIGIN, { apiKey: 'replacement' });
  rollback();
  assert.deepEqual(store.get('fixture', ORIGIN), VALUES);
  assert.equal(fs.readFileSync(path.join(localDir, 'secrets.dat')).equals(previous), true);
});

test('secret rollback refuses to overwrite credentials committed by a different writer', t => {
  const localDir = localFixture(t);
  const one = new SecretStore({ localDir, allowPlaintext: true });
  const two = new SecretStore({ localDir, allowPlaintext: true });
  const rollback = one.checkpoint();
  one.set('fixture', ORIGIN, VALUES);
  two.set('other', ORIGIN, VALUES);
  safeFailure(rollback, 'CONFLICT');
  assert.equal(new SecretStore({ localDir, allowPlaintext: true }).has('other'), true);
});

test('secret count and value bounds fail before changing the persisted file', t => {
  const localDir = localFixture(t);
  const store = new SecretStore({ localDir, allowPlaintext: true });
  for (let index = 0; index < 32; index++) store.set('profile' + index, ORIGIN, { apiKey: SECRET });
  const filename = path.join(localDir, 'secrets.dat');
  const before = fs.readFileSync(filename);
  safeFailure(() => store.set('extra', ORIGIN, VALUES), 'INVALID_SETTINGS');
  safeFailure(() => store.set('profile0', ORIGIN, { apiKey: 'x'.repeat(8193) }), 'INVALID_SETTINGS');
  assert.equal(fs.readFileSync(filename).equals(before), true);
});

test('invalid or noncanonical origins are rejected without reflecting their input', t => {
  const store = new SecretStore({ localDir: localFixture(t), allowPlaintext: true });
  for (const origin of [undefined, null, SECRET, ORIGIN + '/', 'ftp://example.invalid',
    'https://' + SECRET + '@example.invalid', 'https://example.invalid/private', 'http://example.invalid']) {
    safeFailure(() => store.set('fixture', origin, VALUES), 'INVALID_SETTINGS');
  }
  store.set('websocket', 'wss://example.invalid', VALUES);
  assert.equal(store.has('websocket', 'wss://example.invalid'), true);
});

test('secret schemas reject unknown, routing, prototype and safety fields', () => {
  for (const values of [{ unknown: SECRET }, { apiKey: '' }, { headers: { Host: 'example.invalid' } },
    { headers: { authorization: 'first\nsecond' } }, { bodyExtras: { safety: false } },
    { bodyExtras: JSON.parse('{"__proto__":{"polluted":true}}') }, { slotBodyExtras: { unknown: {} } }]) {
    safeFailure(() => validateSecretValues(values), 'INVALID_SETTINGS');
  }
  assert.equal({}.polluted, undefined);
});
