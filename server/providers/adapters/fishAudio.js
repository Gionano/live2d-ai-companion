import WebSocket from 'ws';
import { encode, decode } from '@msgpack/msgpack';
import { resolveFishVoiceId } from '../../voiceConfig.js';
import { Adapter } from './shared.js';
import { ProviderError, httpProviderError } from '../errors.js';
import { validateBaseUrl, validateProviderHeaders } from '../baseUrl.js';
import { prepareTtsText, resolveTtsParams } from '../../ttsExpression.js';
import { FISH_EMOTION_NAMES } from '../../fishEmotionTags.js';

export const capabilities = { llm: false, images: false, jsonMode: false, stt: false, tts: true };
export function withFishEmotion(text, emotion = 'neutral') {
  return prepareTtsText(text, emotion);
}

function debugRequest(details, credentials, headers) {
  const secrets = [];
  const collect = value => {
    if (typeof value === 'string' && value) secrets.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(credentials); collect(headers);
  let safe = JSON.stringify(details);
  for (const value of secrets.sort((a, b) => b.length - a.length)) safe = safe.split(JSON.stringify(value).slice(1, -1)).join('[REDACTED]');
  safe = safe.replace(/\bBearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|gsk_|gh[pousr]_|github_pat_|hf_|AIza)[a-z0-9_-]{12,}/gi, '[REDACTED]');
  console.log('[tts:debug]', safe);
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
      const credentials = await this.credentials(signal);
      try { validateProviderHeaders(credentials.headers); }
      catch { throw new ProviderError('BAD_REQUEST', this.context); }
      const key = credentials.apiKey;
      const params = resolveTtsParams(this.params, request);
      const format = params.format ?? 'mp3';
      const voice = resolveFishVoiceId(params.voice);
      if (!Number.isFinite(params.temperature) || params.temperature < 0 || params.temperature > 2
        || !Number.isFinite(params.topP) || params.topP <= 0 || params.topP > 1
        || !['normal', 'balanced', 'low'].includes(params.latency)
        || !Number.isFinite(params.prosody.speed) || params.prosody.speed < 0.5 || params.prosody.speed > 2
        || !Number.isFinite(params.prosody.volume) || params.prosody.volume < -20 || params.prosody.volume > 20
        || !['mp3', 'wav', 'pcm', 'opus'].includes(format) || typeof voice !== 'string'
        || !Number.isSafeInteger(request.sentenceIndex ?? 0) || (request.sentenceIndex ?? 0) < 0) {
        throw new ProviderError('BAD_REQUEST', this.context);
      }
      const speechEmotion = FISH_EMOTION_NAMES.includes(request.speechEmotion) ? request.speechEmotion : undefined;
      const finalText = prepareTtsText(request.text, request.emotion ?? 'netral', params,
        request.sentenceIndex ?? 0, request.tag, speechEmotion);
      if (!finalText) return;
      const startRequest = { text: '', reference_id: voice, format, latency: params.latency,
        temperature: params.temperature, top_p: params.topP, prosody: params.prosody };
      const ws = new WebSocket(endpoint.url, { followRedirects: false, headers: { ...this.profile.extraHeaders, ...credentials.headers,
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
        if (params.debug || /^(?:1|true|on)$/i.test(process.env.TTS_DEBUG ?? '')) {
          debugRequest({ text: finalText, emotion: request.emotion ?? 'netral', speechEmotion,
            sentenceIndex: request.sentenceIndex ?? 0,
            model: this.model, params: startRequest }, credentials, this.profile.extraHeaders);
        }
        ws.send(encode({ event: 'start', request: startRequest }));
        ws.send(encode({ event: 'text', text: finalText }));
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
