import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, makeVariants, runCli } from '../ttsTry.js';
import { fixture, ADAPTER_CASES, SECRET } from './providerFixtures.js';

async function temporaryOutput(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-try-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const registryFor = adapter => ({ getSlotStatus: () => ({ available: true }), getTts: () => adapter });

test('TTS CLI validates supported split and equals options without printing inputs', () => {
  assert.deepEqual(parseArgs(['--text=Halo!', '--emotion', 'kagum', '--tag', '[excited] [happy]', '--temperature', '0.8',
    '--latency=normal', '--top-p', '0.9', '--speed', '1.2', '--voice', 'fixture-voice', '--variants', '--out', 'output']), {
    text: 'Halo!', emotion: 'kagum', tag: '[excited] [happy]', temperature: 0.8, latency: 'normal', topP: 0.9,
    speed: 1.2, voice: 'fixture-voice', variants: true, out: 'output',
  });
  for (const args of [[], ['--text'], ['--text', ' '], ['--text', 'Halo', '--secret', SECRET],
    ['--text', 'Halo', '--temperature', 'NaN'], ['--text', 'Halo', '--temperature', '2.1'],
    ['--text', 'Halo', '--temperature', ''], ['--text', 'Halo', '--top-p', '-0.1'], ['--text', 'Halo', '--top-p', '0'],
    ['--text', 'Halo', '--speed', '0'], ['--text', 'Halo', '--latency', 'instant'],
    ['--text', 'Halo', '--tag', '(excited)'], ['--text', 'Halo', '--tag', '[a] [b] [c]'],
    ['--text', 'Halo', '--tag', '[warm [nested]]'], ['--text', 'Halo', '--tag', '[warm\nsoft]'], ['--text', 'Halo', '--tag', '[warm]\t[soft]'],
    ['--text', 'Halo', '--tag', `[${'a'.repeat(81)}]`],
    ['--text', 'Halo', '--variants=true'], ['--text', 'Halo', '--text', 'Again']]) {
    assert.throws(() => parseArgs(args), error => !error.message.includes(SECRET));
  }
  assert.equal(parseArgs(['--text', 'Halo', '--tag', '[soft, warm; affectionate]']).tag, '[soft, warm; affectionate]');
});

test('TTS CLI A/B variants retain words and change only the intended request field', () => {
  const variants = makeVariants(parseArgs(['--text', 'Wah, kamu datang.', '--emotion', 'kagum', '--temperature', '0.6', '--variants']));
  assert.equal(variants.length, 6);
  assert.equal(variants[0].request.tag, '');
  assert.equal(variants[1].request.tag, undefined);
  assert.equal(variants[2].request.text, 'Wah, kamu datang!');
  assert.equal(variants[3].request.temperature, 0.8);
  assert.equal(variants[4].request.latency, 'normal');
  assert.equal(variants[5].request.latency, 'balanced');
  for (const variant of variants) assert.equal(variant.request.emotion, 'kagum');
});

test('TTS CLI synthesizes through fake Fish, saves complete audio and reports timing without secrets', async t => {
  const output = await temporaryOutput(t);
  const { adapter, state } = await fixture(t, ADAPTER_CASES.find(spec => spec.audio));
  const printed = [];
  const times = [100, 117, 151];
  const results = await runCli(['--text', 'Halo, sayang!', '--emotion', 'excited', '--temperature', '0.85',
    '--latency', 'normal', '--top-p', '0.9', '--speed', '1.1', '--voice', 'fixture-voice', '--out', output], {
    registry: registryFor(adapter), print: value => printed.push(value), now: () => times.shift(),
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].firstChunkMs, 17);
  assert.equal(results[0].totalMs, 51);
  assert.equal(results[0].format, 'mp3');
  assert.equal(await fs.readFile(results[0].path, 'utf8'), 'Halo sayang.');
  const start = state.frames.find(frame => frame.event === 'start').request;
  assert.equal(start.temperature, 0.85);
  assert.equal(start.top_p, 0.9);
  assert.equal(start.latency, 'normal');
  assert.equal(start.prosody.speed, 1.1);
  assert.equal(start.reference_id, 'fixture-voice');
  assert.equal(state.frames.find(frame => frame.event === 'text').text, '[excited] Halo, sayang!');
  assert.ok(printed[0].includes(results[0].path));
  assert.ok(printed[0].includes('first chunk 17 ms'));
  assert.ok(printed.every(value => !value.includes(SECRET) && !value.includes('Halo sayang.')));
});

test('TTS CLI A/B makes six sequential fake Fish requests and saves separate files', async t => {
  const output = await temporaryOutput(t);
  const { adapter, state } = await fixture(t, ADAPTER_CASES.find(spec => spec.audio));
  const results = await runCli(['--text', 'Halo.', '--emotion', 'excited', '--variants', '--out', output], {
    registry: registryFor(adapter), print: () => {},
  });
  assert.equal(results.length, 6);
  assert.equal(new Set(results.map(result => result.path)).size, 6);
  assert.equal(state.attempts, 6);
  assert.equal(state.frames.filter(frame => frame.event === 'text')[0].text, 'Halo.');
  assert.equal(state.frames.filter(frame => frame.event === 'text')[1].text, '[excited] Halo.');
  assert.equal(state.frames.filter(frame => frame.event === 'start')[3].request.temperature, 0.8);
  assert.equal(state.frames.filter(frame => frame.event === 'start')[4].request.latency, 'normal');
  assert.equal(state.frames.filter(frame => frame.event === 'start')[5].request.latency, 'balanced');
  for (const result of results) assert.equal(await fs.readFile(result.path, 'utf8'), 'Halo sayang.');
});

test('TTS CLI defaults to a unique temporary directory and help makes no provider request', async t => {
  const temporaryRoot = await temporaryOutput(t);
  let requests = 0;
  const adapter = { async *stream() { requests++; yield { type: 'audio', data: Buffer.from('audio'), format: 'wav' }; } };
  const printed = [];
  const results = await runCli(['--text', 'Halo!'], { registry: registryFor(adapter), tempDir: temporaryRoot, print: value => printed.push(value) });
  assert.equal(requests, 1);
  assert.equal(path.dirname(path.dirname(results[0].path)), temporaryRoot);
  assert.equal(path.extname(results[0].path), '.wav');
  assert.equal(await fs.readFile(results[0].path, 'utf8'), 'audio');
  assert.ok(printed[0].includes(results[0].path));
  assert.deepEqual(await runCli(['--help'], {
    registry: { getSlotStatus: () => { throw new Error('Help cannot inspect the provider.'); } }, print: () => {},
  }), []);
});

test('TTS CLI removes partial audio on provider failure and never exposes the underlying error', async t => {
  const output = await temporaryOutput(t);
  const adapter = { async *stream() {
    yield { type: 'audio', data: Buffer.from('private audio'), format: 'mp3' };
    throw new Error(SECRET);
  } };
  const printed = [];
  await assert.rejects(runCli(['--text', 'Halo!', '--out', output], {
    registry: registryFor(adapter), print: value => printed.push(value),
  }), error => error.message === 'TTS synthesis failed. Check the configured slot and options.' && !error.message.includes(SECRET));
  assert.deepEqual(await fs.readdir(output), []);
  assert.deepEqual(printed, []);
});

test('TTS CLI cancellation removes partial output and an unavailable slot makes no request', async t => {
  const output = await temporaryOutput(t);
  const controller = new AbortController();
  const adapter = { async *stream() {
    yield { type: 'audio', data: Buffer.from('audio'), format: 'mp3' };
    controller.abort();
    yield { type: 'audio', data: Buffer.from('audio'), format: 'mp3' };
  } };
  await assert.rejects(runCli(['--text', 'Halo!', '--out', output], {
    registry: registryFor(adapter), signal: controller.signal, print: () => {},
  }), /cancelled/);
  assert.deepEqual(await fs.readdir(output), []);
  await assert.rejects(runCli(['--text', 'Halo!'], {
    registry: { getSlotStatus: () => ({ available: false }), getTts: () => { throw new Error(SECRET); } }, print: () => {},
  }), /Configure an available TTS slot/);
});

test('TTS CLI refuses untrusted audio formats before opening an output file', async t => {
  const output = await temporaryOutput(t);
  const adapter = { async *stream() { yield { type: 'audio', data: Buffer.from('audio'), format: '../secret' }; } };
  await assert.rejects(runCli(['--text', 'Halo!', '--out', output], { registry: registryFor(adapter), print: () => {} }), /TTS synthesis failed/);
  assert.deepEqual(await fs.readdir(output), []);
});
