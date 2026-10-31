import { completeStream, providerCapabilities } from '../contracts.js';
import { ProviderError, httpProviderError, throwIfAborted } from '../errors.js';
import { resilientStream } from '../resilience.js';

export class Adapter {
  constructor({ profile = {}, model, params = {}, timeouts = {}, providerId, slot,
    secretResolver = { resolve: name => process.env[name] }, fetchImpl = fetch, resilience = {} }, capabilities) {
    Object.assign(this, { profile, model, params, timeouts, providerId, slot, secretResolver, fetchImpl, resilience });
    this.capabilities = providerCapabilities(capabilities, profile, model);
    this.context = { providerId, slot };
  }

  run(factory, request = {}) {
    return resilientStream(factory, { ...this.resilience, ...this.context, signal: request.signal,
      timeouts: { ...this.timeouts, ...request.timeouts } });
  }

  require(capability) {
    if (!this.capabilities[capability]) throw new ProviderError('UNSUPPORTED', this.context);
  }

  async key(signal) {
    throwIfAborted(signal, this.context);
    const key = this.profile.apiKeyEnv ? await this.secretResolver.resolve(this.profile.apiKeyEnv) : undefined;
    throwIfAborted(signal, this.context);
    if (this.profile.apiKeyEnv && !key) throw new ProviderError('AUTH', this.context);
    return key;
  }

  async request(url, options, { signal }) {
    const response = await this.fetchImpl(url, { ...options, signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw httpProviderError(response, this.context);
    }
    return response;
  }

  complete(request) { return completeStream(this.stream(request)); }

  warmup({ signal } = {}) {
    return this.complete({ messages: [{ role: 'user', content: 'hi' }], temperature: null, maxTokens: 5, signal });
  }
}

export function jsonPrompt(messages) {
  return [...messages, { role: 'system', content: 'Return exactly one valid JSON object without markdown.' }];
}

export function validateMessages(messages, context) {
  if (!Array.isArray(messages) || !messages.length || messages.some(message => !message
    || !['system', 'user', 'assistant'].includes(message.role)
    || !(typeof message.content === 'string' || Array.isArray(message.content) && message.content.every(part => part
      && (part.type === 'text' && typeof part.text === 'string' || part.type === 'image'
        && /^image\/[a-z0-9.+-]+$/i.test(part.mime) && typeof part.base64 === 'string'))))) {
    throw new ProviderError('BAD_REQUEST', context);
  }
}

export function imagePartFromDataUrl(value) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(value ?? '');
  if (!match) throw new ProviderError('BAD_REQUEST');
  return { type: 'image', mime: match[1], base64: match[2] };
}

export function totalTokens(result, fallback) {
  return Number.isFinite(result.inputTokens) || Number.isFinite(result.outputTokens)
    ? (result.inputTokens ?? 0) + (result.outputTokens ?? 0) : fallback;
}

export async function readJson(response, { signal, touch }) {
  const reader = response.body.getReader();
  const chunks = [];
  try {
    for (;;) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      if (done) break;
      touch();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
