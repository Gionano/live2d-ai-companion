import { Adapter, jsonPrompt, readJson, validateMessages } from './shared.js';
import { ProviderError } from '../errors.js';
import { parseSse } from '../sse.js';

export const capabilities = { llm: true, images: false, jsonMode: false, stt: false, tts: false };

export class OpenAiCompatible extends Adapter {
  constructor(options) { super(options, capabilities); }

  async headers(signal) {
    const key = await this.key(signal);
    return { ...this.profile.extraHeaders, ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  }

  stream(request) {
    return this.run(async function* ({ signal, touch }) {
      this.require('llm');
      validateMessages(request.messages, this.context);
      const flags = this.profile.flags ?? {};
      const params = { ...this.params, ...request };
      let messages = request.messages;
      if (params.json && !this.capabilities.jsonMode) messages = jsonPrompt(messages);
      messages = messages.map(message => ({ ...message, content: typeof message.content === 'string'
        ? message.content : message.content.map(part => {
          if (part.type === 'text') return part;
          this.require('images');
          return { type: 'image_url', image_url: { url: `data:${part.mime};base64,${part.base64}` } };
        }) }));
      const body = { ...this.profile.bodyExtras, ...this.params.bodyExtras,
        model: this.model, messages, stream: true,
        ...(params.temperature != null && { temperature: params.temperature }),
        ...(params.maxTokens != null && { max_tokens: params.maxTokens }),
        ...(params.json && this.capabilities.jsonMode && { response_format: { type: 'json_object' } }),
        ...(flags.supportsStreamUsage && { stream_options: { include_usage: true } }),
      };
      for (const key of [...(this.profile.omitParams ?? []), ...(this.params.omitParams ?? [])]) delete body[key];
      const response = await this.request(`${this.profile.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { ...await this.headers(signal), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, { signal });
      let finished = false;
      let finishReason;
      for await (const event of parseSse(response.body, { signal, touch })) {
        if (event.data.trim() === '[DONE]') { finished = true; break; }
        const chunk = JSON.parse(event.data);
        if (!chunk || !Array.isArray(chunk.choices)) throw new ProviderError('BAD_RESPONSE', this.context);
        const choice = chunk.choices[0];
        if (choice?.delta?.content != null && typeof choice.delta.content !== 'string') {
          throw new ProviderError('BAD_RESPONSE', this.context);
        }
        // Reasoning is deliberately never exposed as speech or chat text.
        if (choice?.delta?.content) yield { type: 'text', delta: choice.delta.content };
        if (choice?.finish_reason != null) { finishReason = choice.finish_reason; finished = true; }
        if (chunk.usage) {
          const usage = { type: 'usage' };
          if (Number.isFinite(chunk.usage.prompt_tokens)) usage.inputTokens = chunk.usage.prompt_tokens;
          if (Number.isFinite(chunk.usage.completion_tokens)) usage.outputTokens = chunk.usage.completion_tokens;
          if (Object.keys(usage).length > 1) yield usage;
        }
      }
      if (!finished) throw new ProviderError('BAD_RESPONSE', this.context);
      yield { type: 'done', ...(finishReason != null && { finishReason }) };
    }.bind(this), request);
  }

  async transcribe(request) {
    const stream = this.run(async function* ({ signal, touch }) {
      this.require('stt');
      if (!Buffer.isBuffer(request.audio) || typeof request.mime !== 'string' || typeof request.filename !== 'string') {
        throw new ProviderError('BAD_REQUEST', this.context);
      }
      const body = new FormData();
      body.append('file', new Blob([request.audio], { type: request.mime }), request.filename);
      body.append('model', this.model);
      body.append('response_format', this.profile.flags?.supportsVerboseStt ? 'verbose_json' : 'json');
      if (request.language ?? this.params.language) body.append('language', request.language ?? this.params.language);
      if (this.params.prompt) body.append('prompt', this.params.prompt);
      const response = await this.request(`${this.profile.baseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST', headers: await this.headers(signal), body,
      }, { signal });
      const data = await readJson(response, { signal, touch });
      if (typeof data?.text !== 'string') throw new ProviderError('BAD_RESPONSE', this.context);
      const result = { text: data.text };
      if (Array.isArray(data.segments)) result.segments = data.segments.map(segment => {
        const normalized = { text: typeof segment.text === 'string' ? segment.text : '' };
        for (const [from, to] of [['no_speech_prob', 'noSpeechProb'], ['avg_logprob', 'avgLogprob'], ['compression_ratio', 'compressionRatio']]) {
          if (Number.isFinite(segment[from])) normalized[to] = segment[from];
        }
        return normalized;
      });
      if (Number.isFinite(data.duration)) result.durationMs = data.duration * 1000;
      yield result;
    }.bind(this), request);
    for await (const result of stream) return result;
  }
}
