import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { detectGpuVendor } from '../../setup/hardware.js';
import { hashFile, formatHash } from '../../setup/hash.js';

test('GPU detection recognizes NVIDIA across integrated and discrete adapter names offline', async () => {
  const calls = [];
  const result = await detectGpuVendor({ platform: 'win32', commandRunner: async (...args) => {
    calls.push(args);
    return { stdout: '["Intel Integrated", "NVIDIA Fake GPU"]', code: 0 };
  } });
  assert.equal(result.gpuVendor, 'nvidia');
  assert.deepEqual(result.devices, ['Intel Integrated', 'NVIDIA Fake GPU']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.equal(calls[0][2].timeoutMs, 5000);
});

test('GPU detection maps non-NVIDIA and single Windows adapter responses to the Vulkan default', async () => {
  const result = await detectGpuVendor({ platform: 'win32', commandRunner: async () => ({ stdout: '"AMD Fake GPU"' }) });
  assert.equal(result.gpuVendor, 'any');
  assert.deepEqual(result.devices, ['AMD Fake GPU']);
  assert.equal(result.warning, undefined);
});

test('GPU detection reports failures and unknown platforms without hidden native probes', async () => {
  let calls = 0;
  const commandRunner = async () => { calls += 1; throw new Error('mock unavailable'); };
  const result = await detectGpuVendor({ platform: 'win32', commandRunner });
  assert.equal(result.gpuVendor, 'any');
  assert.match(result.warning, /mock unavailable.*defaulting to Vulkan.*--variant/);
  const unknown = await detectGpuVendor({ platform: 'unsupported', commandRunner });
  assert.match(unknown.warning, /unavailable on unsupported/);
  assert.equal(calls, 1);
});

test('GPU detection filters Linux adapter lines from injected command output', async () => {
  const result = await detectGpuVendor({ platform: 'linux', commandRunner: async () => ({ stdout:
    '00:00 RAM memory: unrelated\n01:00 VGA compatible controller: NVIDIA Fake\n02:00 Audio device: unrelated\n' }) });
  assert.equal(result.gpuVendor, 'nvidia');
  assert.equal(result.devices.length, 1);
});

test('offline hash prints exact bytes, SHA-256 and a metadata snippet without writing files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'waifu setup hash '));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'tiny model.gguf');
  const bytes = Buffer.from('offline tiny fixture');
  await fs.writeFile(file, bytes);
  const before = await fs.readdir(directory);
  const result = await hashFile(file);
  assert.equal(result.sizeBytes, bytes.length);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(result.snippet, { name: 'tiny model.gguf', sizeBytes: bytes.length, sha256: result.sha256 });
  assert.match(formatHash(result), /Size: 20 bytes.*\nSHA-256: [a-f0-9]{64}/);
  assert.deepEqual(await fs.readdir(directory), before);
  assert.deepEqual(await fs.readFile(file), bytes);
});

test('offline hash rejects directories and missing files without making a destination', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'waifu setup hash invalid '));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(hashFile(directory), /requires a regular file/);
  await assert.rejects(hashFile(path.join(directory, 'missing')), { code: 'ENOENT' });
  await assert.rejects(hashFile(''), /requires an existing file path/);
  assert.deepEqual(await fs.readdir(directory), []);
});
