import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalPaths } from '../selfie/localPaths.js';
import { memoryPaths, planMemorySetup, installMemorySetup, inspectMemoryInstallation,
  verifyMemoryInstallation, detectMemoryPython, MEMORY_SETUP_LICENSES } from '../../setup/memorySetup.js';
import { parseMemoryArgs, main } from '../../setup/memoryCli.js';
import { acquireSetupLock } from '../../setup/setupLock.js';

function fixture(t) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-setup-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const paths = createLocalPaths({ repoRoot, env: {} });
  return { paths, files: memoryPaths(paths) };
}
const digest = value => createHash('sha256').update(value).digest('hex');
const acceptedLicenses = MEMORY_SETUP_LICENSES.map(license => license.id);
const pythonVersion = { stdout: '{"major":3,"minor":11}' };
const base = fixture => ({ paths: fixture.paths, commandRunner: async () => pythonVersion,
  gpuDetector: async () => ({ gpuVendor: 'nvidia' }), spaceProbe: () => ({ freeBytes: 100 * 1024 ** 3 }), acceptedLicenses });

function modelReceipt(files) {
  fs.mkdirSync(files.modelDir, { recursive: true });
  return { modelRevision: 'a'.repeat(40), packages: { torch: '2.10.0' },
    files: ['config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json'].map(name => {
      const body = Buffer.from('fixture-' + name);
      fs.writeFileSync(path.join(files.modelDir, name), body);
      return { path: name, sizeBytes: body.length, sha256: digest(body), sourceHash: 'fixture' };
    }) };
}

function installingRunner(files, calls = []) {
  return async (command, args) => {
    calls.push({ command, args });
    if (args.includes('-c')) return pythonVersion;
    if (args.includes('venv')) {
      fs.mkdirSync(path.dirname(files.pythonPath), { recursive: true });
      fs.writeFileSync(files.pythonPath, 'fixture-python');
    }
    if (args[0]?.endsWith('install_model.py')) return { stdout: JSON.stringify(modelReceipt(files)) };
    return { stdout: '' };
  };
}

test('memory setup plan does not install or download and selects CUDA for NVIDIA', async t => {
  const context = fixture(t);
  const plan = await planMemorySetup(base(context));
  assert.equal(plan.wheel, 'cu128');
  assert.equal(plan.requiredBytes, 12 * 1024 ** 3);
  assert.equal(plan.modelBytes, 2300000000);
  assert.equal(plan.licenses.length, 4);
  assert.equal(fs.existsSync(context.files.runtimeDir), false);
});

test('non-NVIDIA memory setup recommends CPU wheels without a GPU requirement', async t => {
  const context = fixture(t);
  const plan = await planMemorySetup({ ...base(context), gpuDetector: async () => ({ gpuVendor: 'any' }) });
  assert.equal(plan.wheel, 'cpu');
  assert.equal(plan.requiredBytes, 6 * 1024 ** 3);
});

test('missing Python and insufficient disk are actionable setup blockers', async t => {
  const context = fixture(t);
  const plan = await planMemorySetup({ ...base(context), commandRunner: async () => { throw new Error(); },
    spaceProbe: () => ({ freeBytes: 1024 }) });
  assert.deepEqual(plan.blockers, ['PYTHON_311_REQUIRED', 'INSUFFICIENT_DISK']);
  await assert.rejects(installMemorySetup({ ...base(context), spaceProbe: () => ({ freeBytes: 1024 }) }), { code: 'INSUFFICIENT_DISK' });
  assert.equal(fs.existsSync(context.files.runtimeDir), false);
});

test('Python detection rejects unsupported versions and retains an explicit executable', async () => {
  assert.equal(await detectMemoryPython({ commandRunner: async () => ({ stdout: '{"major":3,"minor":10}' }) }), null);
  assert.equal((await detectMemoryPython({ python: 'custom-python', commandRunner: async () => pythonVersion })).command, 'custom-python');
});

test('all displayed licenses require explicit acceptance before mutation', async t => {
  const context = fixture(t);
  await assert.rejects(installMemorySetup({ ...base(context), acceptedLicenses: ['bge-m3'] }), { code: 'LICENSE_ACCEPTANCE_REQUIRED' });
  assert.equal(fs.existsSync(context.files.runtimeDir), false);
});

test('explicit memory install publishes verified provenance and reuses a valid installation', async t => {
  const context = fixture(t);
  const calls = [];
  const options = { ...base(context), commandRunner: installingRunner(context.files, calls) };
  const result = await installMemorySetup(options);
  assert.equal(result.ready, true);
  assert.equal(inspectMemoryInstallation(context.paths).valid, true);
  assert.equal((await verifyMemoryInstallation(context.paths)).valid, true);
  assert.equal(fs.existsSync(context.files.progressPath), false);
  assert.equal(calls.some(call => call.args.includes('torch==2.10.0')), true);
  const before = calls.filter(call => call.args.includes('pip')).length;
  assert.equal((await installMemorySetup(options)).reused, true);
  assert.equal(calls.filter(call => call.args.includes('pip')).length, before);
});

test('changed cached files fail streaming checksum verification', async t => {
  const context = fixture(t);
  await installMemorySetup({ ...base(context), commandRunner: installingRunner(context.files) });
  const file = path.join(context.files.modelDir, 'model.safetensors');
  const body = fs.readFileSync(file); body[0] ^= 1; fs.writeFileSync(file, body);
  assert.equal(inspectMemoryInstallation(context.paths).valid, true);
  assert.equal((await verifyMemoryInstallation(context.paths)).code, 'MEMORY_INSTALL_INVALID');
});

test('missing-only setup reuses verified model files when the service script is missing', async t => {
  const context = fixture(t);
  await installMemorySetup({ ...base(context), commandRunner: installingRunner(context.files) });
  fs.unlinkSync(context.files.servicePath);
  const plan = await planMemorySetup(base(context));
  assert.deepEqual(plan.components.map(component => component.id), ['memory-service']);
  let calls = 0;
  const result = await installMemorySetup({ ...base(context), commandRunner: async (command, args) => {
    if (args.includes('-c')) return pythonVersion;
    calls++;
    return { stdout: '' };
  } });
  assert.equal(result.ready, true);
  assert.equal(calls, 0);
});

test('official PyTorch bin layouts are valid cached installations', async t => {
  const context = fixture(t);
  const runner = installingRunner(context.files);
  await installMemorySetup({ ...base(context), commandRunner: async (command, args) => {
    const response = await runner(command, args);
    if (!args[0]?.endsWith('install_model.py')) return response;
    const receipt = JSON.parse(response.stdout);
    const weights = receipt.files.find(file => file.path === 'model.safetensors');
    fs.renameSync(path.join(context.files.modelDir, weights.path), path.join(context.files.modelDir, 'pytorch_model.bin'));
    weights.path = 'pytorch_model.bin';
    return { stdout: JSON.stringify(receipt) };
  } });
  assert.equal((await verifyMemoryInstallation(context.paths)).valid, true);
});

test('cancellation leaves an interrupted resumable setup and permits explicit retry', async t => {
  const context = fixture(t);
  const controller = new AbortController();
  const runner = installingRunner(context.files);
  await assert.rejects(installMemorySetup({ ...base(context), signal: controller.signal,
    commandRunner: async (command, args) => {
      const result = await runner(command, args);
      if (args.includes('pip')) controller.abort();
      return result;
    } }), error => error.name === 'AbortError');
  assert.equal(fs.existsSync(context.files.progressPath), true);
  assert.equal(fs.existsSync(context.files.pythonPath), true);
  assert.equal(fs.existsSync(path.join(context.paths.localDir, 'setup.lock')), false);
  assert.equal((await installMemorySetup({ ...base(context), commandRunner: runner })).ready, true);
});

test('shared UI/CLI setup lock serializes memory installation', async t => {
  const context = fixture(t);
  const release = await acquireSetupLock(context.paths.localDir);
  try { await assert.rejects(installMemorySetup(base(context)), { code: 'LOCK_BUSY' }); }
  finally { await release(); }
});

test('existing unknown runtime files are never force-overwritten', async t => {
  const context = fixture(t);
  fs.mkdirSync(context.files.runtimeDir, { recursive: true });
  const original = path.join(context.files.runtimeDir, 'personal.txt');
  fs.writeFileSync(original, 'leave untouched');
  await assert.rejects(installMemorySetup(base(context)), { code: 'MEMORY_INSTALL_UNOWNED' });
  assert.equal(fs.readFileSync(original, 'utf8'), 'leave untouched');
});

test('an active embedding process prevents modifying its runtime', async t => {
  const context = fixture(t);
  fs.mkdirSync(context.files.runtimeDir, { recursive: true });
  fs.writeFileSync(context.files.progressPath, '{}');
  fs.writeFileSync(context.files.processPath, JSON.stringify({ pid: process.pid }));
  await assert.rejects(installMemorySetup(base(context)), { code: 'MEMORY_SERVICE_RUNNING' });
});

test('memory CLI rejects commands and reports safe installation failures', async t => {
  const context = fixture(t);
  assert.throws(() => parseMemoryArgs(['install', '--download-url=https://bad.example']));
  assert.deepEqual(parseMemoryArgs(['install', '--device=cpu', '--accept-license', 'bge-m3']).options,
    { device: 'cpu', acceptedLicenses: ['bge-m3'] });
  const output = [];
  const code = await main(['install'], { ...base(context), acceptedLicenses: [], output: value => output.push(value) });
  assert.equal(code, 1);
  assert.match(output.join(''), /LICENSE_ACCEPTANCE_REQUIRED/);
});
