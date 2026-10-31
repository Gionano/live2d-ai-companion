import WebSocket from 'ws';
import { encode, decode } from '@msgpack/msgpack';
import { getVoiceId } from '../../voiceConfig.js';
import { Adapter } from './shared.js';
import { ProviderError, httpProviderError } from '../errors.js';
import { validateBaseUrl, validateProviderHeaders } from '../baseUrl.js';

export const capabilities = { llm: false, images: false, jsonMode: false, stt: false, tts: true };
const FISH_EMOTION_TAG = {
  happy: '[happy]', sad: '[sad]', excited: '[excited]', surprised: '[surprised]', shy: '[shy]', neutral: '',
};

export function withFishEmotion(text, emotion = 'neutral') {
  const tag = FISH_EMOTION_TAG[emotion] ?? '';
  return tag ? `${tag} ${text}` : text;
}

export class FishAudio extends Adapter {
  constructor(options) { super(options, capabilities); }

  stream(request) {
    return this.run(async function* ({ signal, touch }) {
      this.require('tts');
      if (typeof request.text !== 'string') throw new ProviderError('BAD_REQUEST', this.context);
      let endpoint;
      try {
        endpoint = validateBaseUrl(this.profile.baseUrl, { websocket: true });
        validateProviderHeaders(this.profile.extraHeaders);
      } catch { throw new ProviderError('BAD_REQUEST', this.context); }
      const key = await this.key(signal);
      const format = request.format ?? this.params.format ?? 'mp3';
      const ws = new WebSocket(endpoint.url, { followRedirects: false, headers: { ...this.profile.extraHeaders,
        ...(key && { Authorization: `Bearer ${key}` }), model: this.model } });
      const queue = [];
      let finished = false;
      let failure;
      let wake;
      const notify = () => { wake?.(); wake = null; };
      const fail = error => { failure = error; finished = true; notify(); };
      const onAbort = () => {
        queue.length = 0;
        fail(new ProviderError('ABORTED', this.context));
        ws.terminate();
      };
      ws.on('error', () => fail(failure ?? new ProviderError('NETWORK', this.context)));
      ws.on('unexpected-response', (_req, response) => {
        fail(httpProviderError({ status: response.statusCode, headers: new Headers(response.headers) }, this.context));
        response.destroy();
        ws.terminate();
      });
      ws.on('close', () => {
        if (!finished) fail(new ProviderError('NETWORK', this.context));
        finished = true;
        notify();
      });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      ws.on('open', () => {
        if (signal.aborted) return;
        ws.send(encode({ event: 'start', request: { text: '', reference_id: request.voice ?? this.params.voice ?? getVoiceId(),
          format, latency: 'low' } }));
        ws.send(encode({ event: 'text', text: withFishEmotion(request.text, request.emotion) }));
        ws.send(encode({ event: 'flush' }));
        ws.send(encode({ event: 'stop' }));
      });
      ws.on('message', data => {
        if (signal.aborted || finished) return;
        touch();
        let message;
        try { message = decode(data); } catch { fail(new ProviderError('BAD_RESPONSE', this.context)); return; }
        if (message?.event === 'audio' && message.audio instanceof Uint8Array) {
          queue.push({ type: 'audio', data: Buffer.from(message.audio), format });
          notify();
        } else if (message?.event === 'finish') {
          if (message.reason === 'error') failure = new ProviderError('SERVER', this.context);
          finished = true;
          notify();
        }
      });
      try {
        for (;;) {
          if (queue.length) { yield queue.shift(); continue; }
          if (failure) throw failure;
          if (finished) return;
          await new Promise(resolve => { wake = resolve; });
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      }
    }.bind(this), request);
  }

  async complete() { throw new ProviderError('UNSUPPORTED', this.context); }
  async transcribe() { throw new ProviderError('UNSUPPORTED', this.context); }
}
