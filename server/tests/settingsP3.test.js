import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SecretStore } from '../settings/secretStore.js';
import { withLock, inspectLock } from '../settings/files.js';
import { settingsDoctor } from '../settings/doctor.js';
import { SettingsService } from '../settings/service.js';
import { resolveSlot } from '../providers/config.js';
import { listModels } from '../settings/models.js';

const KEY = 'p3-fixture-secret-value';
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-p3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function serviceFixture(t) {
  const root = directory(t);
  const service = new SettingsService({ localDir: root, repoRoot: root, env: {}, allowPlaintext: true,
    layers: { defaults: { profiles: { sample: { adapter: 'openaiCompatible', baseUrl: 'https://example.invalid/v1' } },
      slots: { llm: { profile: 'sample', model: 'one' } } }, dev: {} } });
  return { root, service };
}
for (const [alive, createdAt, expected] of [[false, 1000, 'stale'], [true, 1000, 'busy'], [false, 49500, 'busy'], [false, 60000, 'busy']]) {
  test('lock recovery requires dead owner and sufficient age: ' + alive + '/' + createdAt, t => {
    const filename = path.join(directory(t), 'settings.json');
    const lock = filename + '.lock';
    fs.writeFileSync(lock, JSON.stringify({ pid: 12345, createdAt, nonce: 'fixture' }));
    const options = { alive: () => alive, now: () => 50000, staleMs: 1000 };
    assert.equal(inspectLock(lock, options).state, expected);
    if (expected === 'stale') {
      assert.equal(withLock(filename, () => 42, options), 42);
      assert.equal(fs.existsSync(lock), false);
    } else assert.throws(() => withLock(filename, () => assert.fail('Unexpected writer'), options), { code: 'LOCK_BUSY' });
  });
}
test('malformed owners and concurrent recovery fail with actionable codes', t => {
  const filename = path.join(directory(t), 'settings.json');
  fs.writeFileSync(filename + '.lock', 'legacy-lock');
  assert.throws(() => withLock(filename, () => {}), { code: 'LOCK_UNKNOWN' });
  fs.writeFileSync(filename + '.lock.recovery', 'fixture');
  assert.throws(() => withLock(filename, () => {}), { code: 'LOCK_RECOVERY' });
});
test('doctor plaintext self-test leaves real keys and choices untouched', t => {
  const { root, service } = serviceFixture(t);
  service.putSecret('sample', { version: 0, values: { apiKey: KEY } });
  const filename = path.join(root, 'secrets.dat');
  const before = fs.readFileSync(filename);
  const report = settingsDoctor({ localDir: root, allowPlaintext: true, version: 1 });
  assert.equal(report.selfTest.ok, true);
  assert.equal(report.version, 1);
  assert.equal(report.locations['settings.json'], '<local>/settings.json');
  assert.equal(JSON.stringify(report).includes(KEY), false);
  assert.equal(JSON.stringify(report).includes(root), false);
  assert.deepEqual(fs.readFileSync(filename), before);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('doctor-')), false);
});
test('doctor fake DPAPI runs a fresh store/read/delete cycle and cleans failures', t => {
  const root = directory(t);
  const created = [];
  const makeTemp = fs.mkdtempSync;
  t.mock.method(fs, 'mkdtempSync', (...args) => {
    const result = makeTemp(...args); created.push(result); return result;
  });
  const records = new Map(); let next = 0;
  const runner = ({ operation, data }) => {
    if (operation === 'protect') { const cipher = Buffer.from('cipher' + ++next).toString('base64'); records.set(cipher, data); return cipher; }
    if (!records.has(data)) throw new Error(KEY);
    return records.get(data);
  };
  assert.equal(settingsDoctor({ localDir: root, platform: 'win32', runner }).selfTest.ok, true);
  const failed = settingsDoctor({ localDir: root, platform: 'win32', runner: () => { throw new Error(KEY); } });
  assert.equal(failed.selfTest.code, 'SECRET_STORAGE');
  assert.equal(JSON.stringify(failed).includes(KEY), false);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(created.length, 2);
  for (const scratch of created) assert.equal(fs.existsSync(scratch), false);
});
test('doctor reports env-only limitations, backups and stale locks', t => {
  const root = directory(t);
  fs.writeFileSync(path.join(root, 'settings.json.corrupt-fixture.bak'), 'fixture');
  fs.writeFileSync(path.join(root, 'settings.json.lock'), 'legacy');
  const report = settingsDoctor({ localDir: root, platform: 'linux' });
  assert.equal(report.selfTest.code, 'READ_ONLY');
  assert.equal(report.corruptBackups, 1);
  assert.equal(report.locks['settings.json'].state, 'unknown');
});

test('doctor uses an OS-temp store and deletes its random dummy before cleanup', t => {
  const localDir = path.join(directory(t), 'never-created');
  const created = [];
  const makeTemp = fs.mkdtempSync;
  t.mock.method(fs, 'mkdtempSync', (...args) => {
    const result = makeTemp(...args); created.push(result); return result;
  });
  const values = [];
  const deleted = [];
  const set = SecretStore.prototype.set;
  const remove = SecretStore.prototype.delete;
  t.mock.method(SecretStore.prototype, 'set', function (id, origin, value) {
    values.push(value.apiKey); return set.call(this, id, origin, value);
  });
  t.mock.method(SecretStore.prototype, 'delete', function (id) {
    const result = remove.call(this, id); deleted.push(!this.has(id)); return result;
  });
  for (let i = 0; i < 2; i++) assert.equal(settingsDoctor({ localDir, allowPlaintext: true }).selfTest.ok, true);
  assert.equal(fs.existsSync(localDir), false);
  assert.equal(values.length, 2);
  assert.notEqual(values[0], values[1]);
  assert.equal(Buffer.from(values[0], 'base64').length, 32);
  assert.deepEqual(deleted, [true, true]);
  assert.equal(created.length, 2);
  for (const scratch of created) {
    assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
    assert.equal(fs.existsSync(scratch), false);
  }
});

for (const populated of [false, true]) {
  test(`doctor CLI never initializes local settings or opens local secrets (${populated ? 'corrupt' : 'missing'})`, t => {
    const root = directory(t);
    const localDir = path.join(root, 'local');
    if (populated) {
      fs.mkdirSync(localDir);
      fs.writeFileSync(path.join(localDir, 'settings.json'), '{broken');
      fs.writeFileSync(path.join(localDir, 'secrets.dat'), KEY);
    }
    const guard = path.join(root, 'doctorGuard.cjs');
    // Fail the subprocess even if the doctor catches an attempted forbidden access.
    fs.writeFileSync(guard, `
const fs = require('node:fs');
const path = require('node:path');
const local = path.resolve(process.env.WAIFU_LOCAL_DIR);
function deny(filename, write) {
  if (typeof filename !== 'string') return;
  const relative = path.relative(local, path.resolve(filename));
  const inside = !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if ((inside && (write || relative === 'secrets.dat')) || /^(?:providers\\.config(?:\\.local)?\\.json|\\.env(?:\\..*)?)$/.test(path.basename(filename))) {
    process.exitCode = 88;
    throw new Error('Doctor accessed local settings, credentials or provider configuration.');
  }
}
for (const name of ['readFileSync', 'lstatSync', 'statSync', 'accessSync', 'mkdirSync', 'mkdtempSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'rmSync']) {
  const original = fs[name];
  fs[name] = function (filename, ...args) { deny(filename, /mkdir|mkdtemp|write|rename|unlink|rm/.test(name)); return original.call(this, filename, ...args); };
}
const open = fs.openSync;
fs.openSync = function (filename, flags, ...args) {
  deny(filename, typeof flags === 'string' ? /[wa+]/.test(flags) : Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)));
  return open.call(this, filename, flags, ...args);
};
require('node:module').syncBuiltinESMExports();
`);
    const result = spawnSync(process.execPath, ['--require', guard, fileURLToPath(new URL('../settings/doctorCli.js', import.meta.url))], {
      cwd: root, env: { ...process.env, WAIFU_LOCAL_DIR: localDir, WAIFU_ALLOW_PLAINTEXT_SECRETS: '1' },
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.selfTest.ok, true);
    assert.equal(report.version, populated ? null : 0);
    assert.equal(result.stdout.includes(KEY), false);
    if (populated) {
      assert.deepEqual(fs.readdirSync(localDir).sort(), ['secrets.dat', 'settings.json']);
      assert.equal(fs.readFileSync(path.join(localDir, 'settings.json'), 'utf8'), '{broken');
      assert.equal(fs.readFileSync(path.join(localDir, 'secrets.dat'), 'utf8'), KEY);
    } else assert.equal(fs.existsSync(localDir), false);
  });
}
test('models helper sends one-time key only to the configured origin and returns bounded names', async t => {
  const { root, service } = serviceFixture(t);
  let request;
  const result = await listModels(service, { profile: 'sample', apiKey: KEY, fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ data: [...Array.from({ length: 250 }, (_, i) => ({ id: 'model-' + i })),
      { id: KEY }, { id: '<img src=x onerror=alert(1)>' }, { id: 'x'.repeat(200) }, { id: 'a\nvalue' }] }));
  } });
  assert.equal(request.url, 'https://example.invalid/v1/models');
  assert.equal(request.options.redirect, 'error');
  assert.equal(new Headers(request.options.headers).get('authorization'), 'Bearer ' + KEY);
  assert.equal(result.models.length, 200);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.deepEqual(fs.readdirSync(root), []);
});
test('models helper uses stored keys and hides provider errors and oversized responses', async t => {
  const { service } = serviceFixture(t);
  service.putSecret('sample', { version: 0, values: { apiKey: KEY } });
  const error = await listModels(service, { profile: 'sample', fetchImpl: async (_url, options) => {
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer ' + KEY);
    return new Response(KEY, { status: 401 });
  } });
  assert.deepEqual(error, { models: [], reason: 'AUTH' });
  const oversized = await listModels(service, { profile: 'sample', fetchImpl: async () => new Response('x'.repeat(262145)) });
  assert.deepEqual(oversized, { models: [], reason: 'TOO_LARGE' });
});
test('follow-LLM settings survive export and track later chat changes', t => {
  const { service } = serviceFixture(t);
  service.putSlot('planner', { version: 0, slot: { followLlm: true } });
  service.putSlot('llm', { version: 1, slot: { profile: 'sample', model: 'two' } });
  assert.equal(resolveSlot(service.config(), 'planner').model, 'two');
  assert.deepEqual(service.export().slots.planner, { followLlm: true });
  service.import({ version: 2, settings: service.export() });
  assert.equal(resolveSlot(service.config(), 'planner').model, 'two');
  assert.throws(() => service.putSlot('llm', { version: 3, slot: { followLlm: true } }), { code: 'INVALID_SETTINGS' });
});
