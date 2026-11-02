import { deflateSync } from 'node:zlib';
import { getProviderRegistry } from './registry.js';
import { ProviderError, normalizeProviderError } from './errors.js';

function pngChunk(type, data) {
  const content = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  content.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

// A built-in 8x8 RGB PNG, containing no user image data.
export function tinyPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.alloc(8 * 25))), pngChunk('IEND', Buffer.alloc(0))]);
}

export function shortWav() {
  const sampleRate = 16000;
  const samples = sampleRate / 4;
  const audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(sampleRate, 24); audio.writeUInt32LE(sampleRate * 2, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36);
  audio.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) audio.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 1200), 44 + i * 2);
  return audio;
}

// This helper performs real calls only when explicitly invoked, never at import.
export async function testSlot(slot, { profile, model, signal, onProgress = () => {}, registry = getProviderRegistry() } = {}) {
  const startedAt = performance.now();
  const active = profile || model ? registry.withSlotOverride(slot, { profile, model }) : registry;
  const status = active.getSlotStatus(slot);
  const result = { ok: false, latencyMs: 0, details: { slot, profile: status.profile, model: status.model, adapter: status.adapter } };
  try {
    onProgress('connecting');
    if (!status.available) {
      result.error = { code: status.reason?.startsWith('Missing key') ? 'AUTH' : 'UNSUPPORTED', message: status.reason };
      return result;
    }
    if (slot === 'stt') {
      const response = await active.getStt().transcribe({ audio: shortWav(), filename: 'probe.wav', mime: 'audio/wav', signal, onProgress });
      if (typeof response.text !== 'string') throw new ProviderError('BAD_RESPONSE');
      result.details.characters = response.text.length;
    } else if (slot === 'tts') {
      for await (const event of active.getTts().stream({ text: 'Halo sayang.', signal, onProgress })) {
        if (!event.data.length) continue;
        result.ttftMs = Math.round(performance.now() - startedAt);
        result.details.format = event.format;
        break; // Audio is discarded; iterator cleanup closes the socket.
      }
      if (result.ttftMs === undefined) throw new ProviderError('BAD_RESPONSE');
    } else {
      const content = slot === 'vision' ? [{ type: 'image', mime: 'image/png', base64: tinyPng().toString('base64') },
        { type: 'text', text: 'Name the main color in one word.' }] : 'Reply with OK.';
      for await (const event of active.getLlm(slot).stream({ messages: [{ role: 'user', content }], maxTokens: 16, signal, onProgress })) {
        if (event.type === 'text' && event.delta && result.ttftMs === undefined) result.ttftMs = Math.round(performance.now() - startedAt);
        if (event.type === 'usage') {
          result.tokens ??= {};
          if (event.inputTokens !== undefined) result.tokens.inputTokens = event.inputTokens;
          if (event.outputTokens !== undefined) result.tokens.outputTokens = event.outputTokens;
        }
      }
      if (result.ttftMs === undefined) throw new ProviderError('BAD_RESPONSE');
    }
    result.ok = true;
  } catch (error) {
    const safe = normalizeProviderError(error, { slot, providerId: status.profile }, signal);
    result.error = { code: safe.code, message: safe.message };
  } finally {
    result.latencyMs = Math.round(performance.now() - startedAt);
    onProgress('done');
  }
  return result;
}
