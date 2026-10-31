import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { encode, decode } from '@msgpack/msgpack';
import { OpenAiCompatible } from '../providers/adapters/openaiCompatible.js';
import { AnthropicNative } from '../providers/adapters/anthropicNative.js';
import { FishAudio } from '../providers/adapters/fishAudio.js';

export const ADAPTER_CASES = [
  { id: 'openaiCompatible', Adapter: OpenAiCompatible, audio: false },
  { id: 'anthropicNative', Adapter: AnthropicNative, audio: false },
  { id: 'fishAudio', Adapter: FishAudio, audio: true },
];
export const SECRET = 'contract-fixture-key-never-in-errors';
export const PAYLOAD = 'private-audio-image-body-never-in-errors';
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function collect(stream) { const result = []; for await (const item of stream) result.push(item); return result; }

export function requestFor(spec, extra = {}) {
  return spec.audio ? { text: 'Halo sayang.', emotion: 'happy', voice: 'fixture-voice', ...extra }
    : { messages: [{ role: 'system', content: 'System context.' }, { role: 'user', content: 'Hello' }], ...extra };
}

export async function fixture(t, spec, options = {}) {
  const state = { mode: 'ok', status: 200, attempts: 0, closed: 0, requests: [], frames: [], ...options };
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; };
  const server = http.createServer(async (req, res) => {
    if (spec.audio) return res.end();
    state.attempts++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    state.requests.push({ url: req.url, headers: req.headers, body });
    res.on('close', () => state.closed++);
    if (state.mode === 'network' || (state.mode === 'retryNetwork' && state.attempts < 2)) return res.destroy();
    const status = state.status !== 200 ? state.status : state.mode === 'retry' && state.attempts < 2 ? 503 : 200;
    if (status !== 200) {
      res.writeHead(status, { 'Retry-After': state.retryAfter ?? '0' });
      res.end(JSON.stringify({ error: `${SECRET} ${PAYLOAD}` }));
      return;
    }
    if (req.url.endsWith('/audio/transcriptions')) {
      if (state.mode === 'stall') return;
      res.setHeader('Content-Type', 'application/json');
      res.end(state.mode === 'malformed' ? PAYLOAD : JSON.stringify(state.transcription ?? {
        text: 'Aku sedang membaca.', duration: 1.25, segments: [{ text: 'Aku sedang membaca.', no_speech_prob: 0.1,
          avg_logprob: -0.2, compression_ratio: 1.1 }, { text: 'Tanpa metadata.' }],
      }));
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    if (state.mode === 'chunked') {
      const write = res.write.bind(res);
      const end = res.end.bind(res);
      let wire = '';
      res.write = value => { wire += value; return true; };
      res.end = value => {
        wire += value ?? '';
        const bytes = Buffer.from(wire);
        let position = 0;
        const pump = () => {
          if (res.destroyed) return;
          if (position === bytes.length) { end(); return; }
          write(bytes.subarray(position, ++position));
          setImmediate(pump);
        };
        pump();
      };
    }
    if (state.mode === 'stall') return;
    if (state.mode === 'malformed') { res.end(`data: ${PAYLOAD}\n\n`); return; }
    const send = (data, event) => res.write(`${event ? `event: ${event}\r\n` : ''}data: ${JSON.stringify(data)}\r\n\r\n`);
    const text = delta => spec.id === 'openaiCompatible' ? send({ choices: [{ delta: { content: delta } }] })
      : send({ type: 'content_block_delta', delta: { type: 'text_delta', text: delta } }, 'content_block_delta');
    if (state.mode === 'partial' || state.mode === 'idle' || state.mode === 'open') {
      text('Halo ');
      if (state.mode === 'partial') later(() => res.destroy(), 20);
      return;
    }
    if (state.mode === 'heartbeat') {
      const pulse = () => { if (!res.destroyed) { res.write(': ping\n\n'); later(pulse, 10); } };
      pulse();
      return;
    }
    if (state.mode === 'vendorError') {
      send({ type: 'error', error: { type: 'overloaded_error', message: `${SECRET} ${PAYLOAD}` } }, 'error');
      res.end(); return;
    }
    res.write(': keep alive\r\n\r\n');
    if (spec.id === 'openaiCompatible') {
      send({ choices: [{ delta: { reasoning: 'secret thought', reasoning_content: 'secret thought' } }] });
      text(state.reply ?? 'Halo '); text('sayang.');
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      send({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 3 } });
      res.end('data: [DONE]\r\n\r\n');
    } else {
      send({ type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 1 } } }, 'message_start');
      send({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'secret thought' } }, 'content_block_delta');
      send({ type: 'content_block_start', content_block: { type: 'text', text: '' } }, 'content_block_start');
      text(state.reply ?? 'Halo '); text('sayang.');
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, 'message_delta');
      send({ type: 'message_stop' }, 'message_stop');
      res.end();
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    state.attempts++;
    state.requests.push({ url: req.url, headers: req.headers });
    if (state.mode === 'network' || (state.mode === 'retryNetwork' && state.attempts < 2)) return socket.destroy();
    const status = state.status !== 200 ? state.status : state.mode === 'retry' && state.attempts < 2 ? 503 : 200;
    if (status !== 200) {
      const body = `${SECRET} ${PAYLOAD}`;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nRetry-After: ${state.retryAfter ?? '0'}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    ws.on('error', () => {});
    ws.on('close', () => state.closed++);
    ws.on('message', data => {
      const frame = decode(data);
      state.frames.push(frame);
      if (frame.event !== 'stop') return;
      if (state.mode === 'stall') return;
      if (state.mode === 'malformed') { ws.send(Buffer.from([0xc1])); return; }
      if (state.mode === 'heartbeat') {
        const pulse = () => { if (ws.readyState === 1) { ws.send(encode({ event: 'ping' })); later(pulse, 10); } };
        pulse(); return;
      }
      const firstAudio = encode({ event: 'audio', audio: Buffer.from('Halo ') });
      if (state.mode === 'chunked') {
        ws.send(firstAudio.subarray(0, 3), { fin: false });
        ws.send(firstAudio.subarray(3), { fin: true });
      } else ws.send(firstAudio);
      if (state.mode === 'partial') { later(() => ws.terminate(), 20); return; }
      if (state.mode === 'idle' || state.mode === 'open') return;
      ws.send(encode({ event: 'audio', audio: Buffer.from('sayang.') }));
      ws.send(encode({ event: 'finish', reason: 'stop' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const baseUrl = `${spec.audio ? 'ws' : 'http'}://127.0.0.1:${server.address().port}`;
  const profile = { baseUrl, apiKeyEnv: 'FIXTURE_KEY', flags: { supportsImages: true, supportsJsonMode: true,
    supportsStreamUsage: true, supportsStt: !spec.audio, supportsVerboseStt: true }, ...options.profile };
  const adapter = new spec.Adapter({ profile, model: 'fixture-model', providerId: spec.id,
    slot: spec.audio ? 'tts' : 'llm', secretResolver: { resolve: () => SECRET },
    resilience: { baseDelayMs: 1, random: () => 0 }, timeouts: { firstByteMs: 3000, idleMs: 3000, totalMs: 6000 }, ...options.adapterOptions });
  return { state, adapter, baseUrl, profile };
}
