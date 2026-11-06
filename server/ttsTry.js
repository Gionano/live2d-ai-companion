import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getProviderRegistry } from './providers/registry.js';

const VALUE_FLAGS = ['--text', '--emotion', '--tag', '--temperature', '--latency', '--top-p', '--speed', '--voice', '--out'];
const FORMATS = new Set(['mp3', 'wav', 'pcm', 'ogg', 'opus', 'flac']);
export const TTS_TRY_USAGE = 'npm run tts:try -- --text "Halo, sayang!" [--emotion E] [--tag "[excited]"] [--temperature X] [--latency normal|balanced|low] [--top-p X] [--speed X] [--voice ID] [--variants] [--out DIR]';

function invalidOptions() {
  throw new Error('Invalid TTS options. See --help.');
}

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    const key = ({ '--top-p': 'topP' })[flag] ?? flag.slice(2);
    if (Object.hasOwn(options, key)) invalidOptions();
    if (['--variants', '--help'].includes(flag)) {
      if (inline !== undefined) invalidOptions();
      options[key] = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(flag)) invalidOptions();
    const value = inline ?? args[++i];
    if (value === undefined || value.startsWith('--')) invalidOptions();
    options[key] = value;
  }
  if (options.help) return options;
  if (!options.text?.trim() || options.text.length > 10000) invalidOptions();
  for (const [key, min, max] of [['temperature', 0, 2], ['topP', 0, 1], ['speed', 0.5, 2]]) {
    if (options[key] === undefined) continue;
    const number = Number(options[key]);
    if (!String(options[key]).trim() || !Number.isFinite(number) || number < min || number > max || key === 'topP' && number === 0) invalidOptions();
    options[key] = number;
  }
  if (options.latency !== undefined && !['normal', 'balanced', 'low'].includes(options.latency)) invalidOptions();
  if (options.tag !== undefined && !/^(?:\[[^\[\]\x00-\x1f\x7f]{1,80}\] *){1,2}$/.test(options.tag)) invalidOptions();
  for (const key of ['emotion', 'voice']) {
    if (options[key] !== undefined && (!options[key].trim() || options[key].length > 256 || /[\x00-\x1f\x7f]/.test(options[key]))) invalidOptions();
  }
  if (options.out !== undefined && !options.out.trim()) invalidOptions();
  return options;
}

function expressivePunctuation(text) {
  const trimmed = text.trimEnd();
  if (/[!?]$/.test(trimmed)) return trimmed + trimmed.at(-1).repeat(2);
  return trimmed.replace(/[.\u2026]+$/, '') + '!';
}

export function makeVariants(options) {
  const request = { text: options.text, emotion: options.emotion ?? 'netral' };
  for (const key of ['tag', 'temperature', 'topP', 'latency', 'voice']) {
    if (options[key] !== undefined) request[key] = options[key];
  }
  if (options.speed !== undefined) request.prosody = { speed: options.speed };
  if (!options.variants) return [{ name: 'tts', request }];
  return [
    { name: 'plain', request: { ...request, tag: '', inlineTags: { enabled: false } } },
    { name: 'emotion', request: { ...request } },
    { name: 'punctuation', request: { ...request, text: expressivePunctuation(request.text) } },
    { name: 'temperature-0.8', request: { ...request, temperature: 0.8 } },
    { name: 'latency-normal', request: { ...request, latency: 'normal' } },
    { name: 'latency-balanced', request: { ...request, latency: 'balanced' } },
  ];
}

// Synthesis is manual only. Importing this module does not load secrets or open a connection.
export async function runCli(args, { registry, print = console.log, signal, now = () => performance.now(), tempDir = os.tmpdir() } = {}) {
  const options = parseArgs(args);
  if (options.help) { print(TTS_TRY_USAGE); return []; }
  const active = registry ?? getProviderRegistry();
  if (!active.getSlotStatus('tts').available) throw new Error('Configure an available TTS slot before running tts:try.');
  const adapter = active.getTts();
  if (!adapter) throw new Error('Configure an available TTS slot before running tts:try.');
  const outputDir = options.out ? path.resolve(options.out) : await fs.mkdtemp(path.join(tempDir, 'waifu-tts-'));
  await fs.mkdir(outputDir, { recursive: true });
  const results = [];
  for (const variant of makeVariants(options)) {
    signal?.throwIfAborted();
    const startedAt = now();
    let firstChunkMs;
    let filename;
    let file;
    let format;
    try {
      for await (const event of adapter.stream({ ...variant.request, signal, sentenceIndex: 0 })) {
        signal?.throwIfAborted();
        if (event.type !== 'audio' || !Buffer.isBuffer(event.data)) throw new Error('Invalid TTS audio response.');
        if (!event.data.length) continue;
        if (!FORMATS.has(event.format) || format !== undefined && event.format !== format) throw new Error('Invalid TTS audio response.');
        if (firstChunkMs === undefined) {
          firstChunkMs = Math.round(now() - startedAt);
          format = event.format;
          filename = path.join(outputDir, `${variant.name}-${randomUUID()}.${format}`);
          file = await fs.open(filename, 'wx');
        }
        await file.writeFile(event.data);
      }
      if (!file) throw new Error('TTS returned no audio.');
      await file.close();
      file = null;
      const result = { name: variant.name, path: filename, firstChunkMs, totalMs: Math.round(now() - startedAt), format };
      results.push(result);
      print(`${result.name}: first chunk ${result.firstChunkMs} ms, total ${result.totalMs} ms\n${result.path}`);
    } catch {
      await file?.close().catch(() => {});
      if (filename) await fs.rm(filename, { force: true }).catch(() => {});
      throw new Error(signal?.aborted ? 'TTS synthesis was cancelled.' : 'TTS synthesis failed. Check the configured slot and options.');
    }
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const args = process.argv.slice(2);
  try {
    parseArgs(args);
    if (!args.includes('--help')) await import('dotenv/config');
    await runCli(args, { signal: controller.signal });
  } catch {
    console.error('TTS trial could not finish. Check --help and your configured TTS slot.');
    process.exitCode = 1;
  }
}
