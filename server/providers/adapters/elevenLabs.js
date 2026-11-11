import { Adapter } from './shared.js';
import { ProviderError, throwIfAborted } from '../errors.js';
import { validateBaseUrl, validateProviderHeaders } from '../baseUrl.js';
import { ELEVENLABS_MODELS, isElevenLabsVoice, prepareElevenLabsText, resolveElevenLabsParams } from '../../elevenLabsTts.js';

export const capabilities = { llm: false, images: false, jsonMode: false, stt: false, tts: true };

export class ElevenLabs extends Adapter {
  constructor(options = {}) {
    // A failed synthesis may already have consumed credits; never replay it.
    super({ ...options, resilience: { ...options.resilience, maxRetries: 0 } }, capabilities);
  }

  stream(request) {
    return this.run(async function* ({ signal, touch }) {
      this.require('tts');
      const voice = request.voice ?? this.params.voice;
      let base;
      let params;
      try {
        if (typeof request.text !== 'string' || !ELEVENLABS_MODELS.includes(this.model)
          || !isElevenLabsVoice(voice) || (request.format ?? this.params.format ?? 'mp3') !== 'mp3') {
          throw new TypeError();
        }
        base = validateBaseUrl(this.profile.baseUrl);
        validateProviderHeaders(this.profile.extraHeaders);
        params = resolveElevenLabsParams(this.params.elevenLabs, request.elevenLabs, this.model);
      } catch { throw new ProviderError('BAD_REQUEST', this.context); }
      const text = prepareElevenLabsText(request.text, request.emotion, request.speechEmotion, params, this.model);
      if (!text) return;
      const credentials = await this.credentials(signal);
      if (!credentials.apiKey) throw new ProviderError('AUTH', this.context);
      let headers;
      try {
        headers = new Headers({ ...this.profile.extraHeaders, ...credentials.headers });
        headers.set('xi-api-key', credentials.apiKey);
        headers.set('Content-Type', 'application/json');
        headers.set('Accept', 'audio/mpeg');
        validateProviderHeaders(headers);
      } catch { throw new ProviderError('BAD_REQUEST', this.context); }
      const voiceSettings = this.model === 'eleven_v3' ? { stability: params.stability }
        : { stability: params.stability, similarity_boost: params.similarityBoost, speed: params.speed,
          style: 0, use_speaker_boost: false };
      const url = `${base.url.replace(/\/$/, '')}/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_128`;
      const response = await this.request(url, { method: 'POST', headers,
        body: JSON.stringify({ text, model_id: this.model, voice_settings: voiceSettings }) }, { signal });
      const contentType = response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!response.body?.getReader || !['audio/mpeg', 'audio/mp3', 'application/octet-stream'].includes(contentType)) {
        await response.body?.cancel().catch(() => {});
        throw new ProviderError('BAD_RESPONSE', this.context);
      }
      const reader = response.body.getReader();
      const onAbort = () => { reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', onAbort, { once: true });
      let hasAudio = false;
      try {
        for (;;) {
          throwIfAborted(signal, this.context);
          const { value, done } = await reader.read();
          throwIfAborted(signal, this.context);
          if (done) break;
          if (!(value instanceof Uint8Array)) throw new ProviderError('BAD_RESPONSE', this.context);
          if (!value.length) continue;
          touch();
          hasAudio = true;
          yield { type: 'audio', data: Buffer.from(value), format: 'mp3' };
        }
        if (!hasAudio) throw new ProviderError('BAD_RESPONSE', this.context);
      } finally {
        signal.removeEventListener('abort', onAbort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }.bind(this), request);
  }

  async complete() { throw new ProviderError('UNSUPPORTED', this.context); }
  async transcribe() { throw new ProviderError('UNSUPPORTED', this.context); }
}
