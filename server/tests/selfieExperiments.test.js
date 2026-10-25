import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendSelfieRun, compareImages, readImageMetadata } from '../selfie/selfieExperiments.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'selfie-experiments-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function png(width, height, size = 40) {
  const bytes = Buffer.alloc(size);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function row(label = 'trial') {
  return {
    label, provider: 'sdcpp', width: 640, height: 768, steps: 16, cfg: 3.5, strength: 0.6,
    args: ['--diffusion-fa'], droppedArgs: ['--vae-tiling'], modelArgs: ['cache=false'], seed: 42,
    timings: { readinessMs: 8, queueMs: 0, generateMs: 123.45, downloadMs: 0, totalMs: 123.45 },
    peaks: { vramUsedGB: 6, peakWorkingSetGB: 10, privateBytesGB: 11, commitUsedGB: 20, sharedGpuUsedGB: 2 },
    imagePath: 'output.png', status: 'success', initImage: 'reference', reference: 'reference.png',
  };
}

test('selfie run log creates a Markdown table with tuning, durations, and all required peaks', async (t) => {
  const filePath = path.join(await fixture(t), 'docs', 'selfie-runs.md');
  await appendSelfieRun(row(), { filePath });
  const text = await fs.readFile(filePath, 'utf8');
  assert.match(text, /^# Selfie runs\n\n\| Label \| Provider \| Profile \| Size \| Steps \| CFG \| Strength/);
  assert.match(text, /Peak VRAM \(GB\).*Peak working set \(GB\).*Peak commit \(GB\).*Peak shared GPU \(GB\)/);
  assert.match(text, /\| trial \| sdcpp \| - \| 640x768 \| 16 \| 3.5 \| 0.6 \|/);
  assert.match(text, /extra:.*--diffusion-fa.*dropped:.*--vae-tiling.*model:.*cache=false/);
  assert.match(text, /readinessMs=8; queueMs=0; generateMs=123.45; downloadMs=0; totalMs=123.45 \| 6 \| 10 \| 11 \| 20 \| 2 \| output.png \| success \| reference \| reference.png \|/);
});

test('selfie run log appends rows without changing existing bytes, including a missing final newline', async (t) => {
  const filePath = path.join(await fixture(t), 'selfie-runs.md');
  const existing = '# Previous experiments\r\n\r\n| Label | Provider |\r\n| --- | --- |\r\n| original | sdcpp |';
  await fs.writeFile(filePath, existing);
  await appendSelfieRun(row('second'), { filePath });
  const afterSecond = await fs.readFile(filePath);
  assert.equal(afterSecond.subarray(0, Buffer.byteLength(existing)).toString(), existing);
  assert.match(afterSecond.toString(), /\| original \| sdcpp \|\n\n## Managed provider telemetry\n\n\| Label \| Provider \| Profile/);
  assert.match(afterSecond.toString(), /\| second \| sdcpp \| - \|/);
  await appendSelfieRun(row('third'), { filePath });
  const afterThird = await fs.readFile(filePath);
  assert.ok(afterThird.subarray(0, afterSecond.length).equals(afterSecond));
  assert.equal(afterThird.toString().split('| original |').length, 2);
  assert.equal(afterThird.toString().split('| second |').length, 2);
  assert.equal(afterThird.toString().split('| third |').length, 2);
  assert.equal(afterThird.toString().split('## Managed provider telemetry').length, 2);
});

test('selfie run log serializes concurrent appends and emits one header', async (t) => {
  const filePath = path.join(await fixture(t), 'selfie-runs.md');
  await Promise.all(['a', 'b', 'c'].map(label => appendSelfieRun(row(label), { filePath })));
  const text = await fs.readFile(filePath, 'utf8');
  assert.equal(text.split('# Selfie runs').length, 2);
  assert.equal(text.split('\n').filter(line => /^\| [abc] \|/.test(line)).length, 3);
  assert.ok(text.indexOf('| a |') < text.indexOf('| b |'));
  assert.ok(text.indexOf('| b |') < text.indexOf('| c |'));
});

test('selfie run log escapes table content and keeps absent measurements unavailable', async (t) => {
  const filePath = path.join(await fixture(t), 'selfie-runs.md');
  await appendSelfieRun({
    ...row('trial | <script>\n[next]*'),
    strength: null, seed: 0, args: ['--backend=diffusion=cuda0|cpu'],
    imagePath: path.win32.join('X:', '/', 'Path With Spaces', 'a|b.png'), peaks: { vramUsedGB: NaN, peakWorkingSetGB: -1 },
  }, { filePath });
  const text = await fs.readFile(filePath, 'utf8');
  const line = text.split('\n').find(value => value.startsWith('| trial'));
  assert.match(line, /trial &#124; &lt;script&gt;<br>\\\[next\\\]\\\*/);
  assert.match(line, /diffusion=cuda0&#124;cpu/);
  assert.match(line, /\| 0 \| readinessMs/);
  assert.match(line, /totalMs=123.45 \| - \| - \| - \| - \| - \|/);
  assert.equal(line.split(' | ').length, 19);
  assert.ok(!text.includes('<script>'));
});

test('selfie run log remains usable after a failed append', async (t) => {
  const root = await fixture(t);
  const filePath = path.join(root, 'missing', 'selfie-runs.md');
  await fs.writeFile(path.dirname(filePath), 'blocks the directory');
  await assert.rejects(appendSelfieRun(row('failed'), { filePath }));
  await fs.unlink(path.dirname(filePath));
  await appendSelfieRun(row('retried'), { filePath });
  assert.match(await fs.readFile(filePath, 'utf8'), /\| retried \|/);
});

test('managed run rows retain profile, cold start and private bytes without repeating the current header', async (t) => {
  const filePath = path.join(await fixture(t), 'selfie-runs.md');
  await appendSelfieRun({
    ...row('managed cold'), provider: 'comfyui-managed', profile: 'lowvram',
    timings: { coldStartMs: 750, generateMs: 250, totalMs: 250 },
  }, { filePath });
  const first = await fs.readFile(filePath);
  await appendSelfieRun({
    ...row('managed warm'), provider: 'comfyui-managed', profile: 'reserve-vram',
    timings: { coldStartMs: 0, generateMs: 200, totalMs: 200 },
  }, { filePath });
  const second = await fs.readFile(filePath);
  assert.ok(second.subarray(0, first.length).equals(first));
  assert.match(second.toString(), /\| managed cold \| comfyui-managed \| lowvram \|/);
  assert.match(second.toString(), /\| managed warm \| comfyui-managed \| reserve-vram \|/);
  assert.match(second.toString(), /coldStartMs=750; generateMs=250; totalMs=250 \| 6 \| 10 \| 11 \| 20 \| 2 \|/);
  assert.match(second.toString(), /coldStartMs=0; generateMs=200; totalMs=200/);
  assert.equal(second.toString().split('| Label | Provider |').length, 2);
});

test('selfie compare prints each PNG dimensions and exact file size using metadata only', async (t) => {
  const root = await fixture(t);
  const first = path.join(root, 'first image.png');
  const second = path.join(root, 'second.png');
  await fs.writeFile(first, png(640, 768, 50));
  await fs.writeFile(second, png(1024, 512, 120));
  const lines = [];
  const errors = [];
  assert.equal(await compareImages([first, second], {
    log: value => lines.push(value), error: value => errors.push(value),
  }), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(lines, [first + ': 640x768, 50 bytes', second + ': 1024x512, 120 bytes']);
  assert.deepEqual(await readImageMetadata(first), { filePath: first, width: 640, height: 768, bytes: 50 });
});

test('selfie compare rejects missing or invalid images and still reports the other image', async (t) => {
  const root = await fixture(t);
  const missing = path.join(root, 'missing.png');
  const invalid = path.join(root, 'invalid.png');
  const valid = path.join(root, 'valid.png');
  await fs.writeFile(invalid, 'not an image');
  await fs.writeFile(valid, png(32, 64));
  for (const filePath of [missing, invalid]) {
    const lines = [];
    assert.equal(await compareImages([filePath, valid], {
      log: value => lines.push(value), error: value => lines.push(value),
    }), 1);
    assert.match(lines[0], /FAILED \[COMPARE\]/);
    assert.equal(lines[1], valid + ': 32x64, 40 bytes');
  }
  await fs.writeFile(invalid, png(0, 64));
  await assert.rejects(readImageMetadata(invalid), /invalid dimensions/);
});

test('selfie compare reads JPEG dimensions past metadata segments and WebP container dimensions', async (t) => {
  const root = await fixture(t);
  const jpegPath = path.join(root, 'image.jpg');
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe1, 0, 6, 1, 2, 3, 4,
    0xff, 0xc2, 0, 8, 8, 1, 0, 2, 0, 0,
    0xff, 0xd9,
  ]);
  await fs.writeFile(jpegPath, jpeg);
  assert.deepEqual(await readImageMetadata(jpegPath), {
    filePath: jpegPath, width: 512, height: 256, bytes: jpeg.length,
  });
  for (const kind of ['VP8X', 'VP8 ', 'VP8L']) {
    const filePath = path.join(root, kind.trim() + '.webp');
    const bytes = Buffer.alloc(32);
    bytes.write('RIFF', 0, 'ascii');
    bytes.write('WEBP', 8, 'ascii');
    bytes.write(kind, 12, 'ascii');
    if (kind === 'VP8X') {
      bytes.writeUIntLE(639, 24, 3);
      bytes.writeUIntLE(767, 27, 3);
    } else if (kind === 'VP8 ') {
      bytes.set([0x9d, 0x01, 0x2a], 23);
      bytes.writeUInt16LE(640, 26);
      bytes.writeUInt16LE(768, 28);
    } else {
      bytes[20] = 0x2f;
      bytes.writeUInt32LE(639 | (767 << 14), 21);
    }
    await fs.writeFile(filePath, bytes);
    assert.deepEqual(await readImageMetadata(filePath), { filePath, width: 640, height: 768, bytes: 32 });
  }
});
