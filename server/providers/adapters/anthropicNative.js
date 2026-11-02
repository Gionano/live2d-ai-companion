import { Adapter, jsonPrompt, validateMessages } from './shared.js';
import { ProviderError } from '../errors.js';
import { parseSse } from '../sse.js';
import { deepMerge } from '../../selfie/localPaths.js';

export const capabilities = { llm: true, images: true, jsonMode: false, stt: false, tts: false };

export class AnthropicNative extends Adapter {
  constructor(options) { super(options, capabilities); }

  stream(request) {
    return this.run(async function* ({ signal, touch }) {
      this.require('llm');
      validateMessages(request.messages, this.context);
      const credentials = await this.credentials(signal);
      const params = { ...this.params, ...request };
      const input = params.json ? jsonPrompt(request.messages) : request.messages;
      const blocks = content => typeof content === 'string' ? [{ type: 'text', text: content }]
        : content.map(part => {
          if (part.type === 'text') return part;
          this.require('images');
          return { type: 'image', source: { type: 'base64', media_type: part.mime, data: part.base64 } };
        });
      const system = input.filter(message => message.role === 'system').flatMap(message => blocks(message.content));
      if (system.some(block => block.type !== 'text')) throw new ProviderError('BAD_REQUEST', this.context);
      const body = { ...deepMerge(this.profile.bodyExtras, credentials.bodyExtras, this.params.bodyExtras, credentials.slotBodyExtras),
        model: this.model, max_tokens: params.maxTokens ?? this.profile.defaultMaxTokens ?? 1024,
        stream: true, ...(system.length && { system }),
        ...(params.temperature != null && { temperature: params.temperature }),
        messages: input.filter(message => message.role !== 'system').map(message => ({
          role: message.role, content: blocks(message.content),
        })),
      };
      const key = credentials.apiKey;
      const baseUrl = (this.profile.baseUrl || '').replace(/\/$/, '');
      const response = await this.request(`${baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`}/messages`, {
        method: 'POST', headers: { ...this.profile.extraHeaders, ...credentials.headers, 'Content-Type': 'application/json',
          ...(key && { 'x-api-key': key }), 'anthropic-version': this.profile.anthropicVersion || '2023-06-01' },
        body: JSON.stringify(body),
      }, { signal });
      let stopped = false;
      let finishReason;
      for await (const event of parseSse(response.body, { signal, touch })) {
        const data = JSON.parse(event.data);
        if (!data || typeof data.type !== 'string') throw new ProviderError('BAD_RESPONSE', this.context);
        if (data.type === 'error') {
          const code = { authentication_error: 'AUTH', permission_error: 'AUTH', rate_limit_error: 'RATE_LIMIT',
            overloaded_error: 'SERVER', api_error: 'SERVER', invalid_request_error: 'BAD_REQUEST' }[data.error?.type] || 'BAD_RESPONSE';
          throw new ProviderError(code, this.context);
        }
        if (data.type === 'content_block_start' && data.content_block?.type === 'text' && data.content_block.text) {
          yield { type: 'text', delta: data.content_block.text };
        }
        if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
          if (typeof data.delta.text !== 'string') throw new ProviderError('BAD_RESPONSE', this.context);
          if (data.delta.text) yield { type: 'text', delta: data.delta.text };
        }
        const rawUsage = data.type === 'message_start' ? data.message?.usage : data.type === 'message_delta' ? data.usage : null;
        if (rawUsage) {
          const usage = { type: 'usage' };
          if (Number.isFinite(rawUsage.input_tokens)) usage.inputTokens = rawUsage.input_tokens;
          if (Number.isFinite(rawUsage.output_tokens)) usage.outputTokens = rawUsage.output_tokens;
          if (Object.keys(usage).length > 1) yield usage;
        }
        if (data.type === 'message_delta' && data.delta?.stop_reason != null) finishReason = data.delta.stop_reason;
        if (data.type === 'message_stop') { stopped = true; break; }
      }
      if (!stopped) throw new ProviderError('BAD_RESPONSE', this.context);
      yield { type: 'done', ...(finishReason != null && { finishReason }) };
    }.bind(this), request);
  }

  async transcribe() { throw new ProviderError('UNSUPPORTED', this.context); }
}
