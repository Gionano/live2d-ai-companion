import { Adapter } from './shared.js';
import { ProviderError, throwIfAborted, normalizeProviderError } from '../errors.js';
import { validateBaseUrl } from '../baseUrl.js';

export const LOCAL_EMBEDDING_MODEL = 'bge-m3-d768';
export const LOCAL_EMBEDDING_DIMENSIONS = 768;
export const capabilities = { llm: false, images: false, jsonMode: false, stt: false, tts: false, embeddings: true };
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TEXTS = 8;
const MAX_TEXT_CHARS = 20000;

/** Local memory text must never be redirected to a remote embedding endpoint. */
export function validateLocalEmbeddingUrl(value) {
  const base = validateBaseUrl(value);
  const url = new URL(base.url);
  const host = url.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host) || url.pathname !== '/') {
    throw new TypeError('Local embedding baseUrl must be a loopback service origin without a path.');
  }
  return base;
}

async function boundedJson(response, { signal, touch }) {
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new ProviderError('BAD_RESPONSE');
  }
  if (!response.body?.getReader) throw new ProviderError('BAD_RESPONSE');
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_RESPONSE_BYTES) throw new ProviderError('BAD_RESPONSE');
      chunks.push(Buffer.from(value));
      touch();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function validateEmbeddingResult(body, count, model = LOCAL_EMBEDDING_MODEL) {
  if (model !== LOCAL_EMBEDDING_MODEL || body?.model !== model || body?.dims !== LOCAL_EMBEDDING_DIMENSIONS
    || !Array.isArray(body.embeddings) || body.embeddings.length !== count) throw new ProviderError('BAD_RESPONSE');
  const vectors = body.embeddings.map(vector => {
    if (!Array.isArray(vector) || vector.length !== LOCAL_EMBEDDING_DIMENSIONS
      || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new ProviderError('BAD_RESPONSE');
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (!Number.isFinite(norm) || norm <= 0) throw new ProviderError('BAD_RESPONSE');
    // Normalize again at the provider boundary, without mutating vendor data.
    return vector.map(value => value / norm);
  });
  if (body.revision != null && !/^[a-f0-9]{40}$/.test(body.revision)) throw new ProviderError('BAD_RESPONSE');
  return { model, dimensions: LOCAL_EMBEDDING_DIMENSIONS, vectors,
    ...(body.revision && { revision: body.revision }) };
}

export class LocalEmbedding extends Adapter {
  constructor(options = {}) {
    super(options, capabilities);
    this.resilience = { ...this.resilience, maxRetries: 0 };
  }

  async operation(pathname, body, request = {}) {
    this.require('embeddings');
    try { validateLocalEmbeddingUrl(this.profile.baseUrl); }
    catch { throw new ProviderError('BAD_REQUEST', this.context); }
    if (this.model !== LOCAL_EMBEDDING_MODEL) throw new ProviderError('BAD_REQUEST', this.context);
    const limits = { firstByteMs: 1000, idleMs: 1000, totalMs: 1000, ...request.timeouts };
    const controller = new AbortController();
    const signal = controller.signal;
    let firstTimer;
    let idleTimer;
    let totalTimer;
    const abort = code => { if (!signal.aborted) controller.abort(new ProviderError(code, this.context)); };
    const outerAbort = () => abort('ABORTED');
    let rejectAbort;
    const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
    interrupted.catch(() => {});
    signal.addEventListener('abort', () => rejectAbort(signal.reason), { once: true });
    request.signal?.addEventListener('abort', outerAbort, { once: true });
    const schedule = ms => setTimeout(() => abort('TIMEOUT'), Math.max(1, ms));
    const touch = () => { clearTimeout(firstTimer); clearTimeout(idleTimer); idleTimer = schedule(limits.idleMs); };
    if (request.signal?.aborted) outerAbort();
    firstTimer = schedule(limits.firstByteMs);
    totalTimer = schedule(limits.totalMs);
    const operation = (async () => {
      throwIfAborted(signal, this.context);
      const response = await this.request(this.profile.baseUrl.replace(/\/$/, '') + pathname, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }, { signal });
      const data = await boundedJson(response, { signal, touch });
      throwIfAborted(signal);
      return data;
    })();
    // An injected transport may ignore AbortSignal; never wait for its late result.
    operation.catch(() => {});
    try { return await Promise.race([operation, interrupted]); }
    catch (error) { throw normalizeProviderError(error, this.context, signal); }
    finally {
      clearTimeout(firstTimer); clearTimeout(idleTimer); clearTimeout(totalTimer);
      request.signal?.removeEventListener('abort', outerAbort);
      abort('ABORTED');
    }
  }

  async health(request = {}) {
    const body = await this.operation('/health', undefined, request);
    if (body?.ok !== true || body.tag !== this.model || body.dims !== LOCAL_EMBEDDING_DIMENSIONS
      || body.model !== 'BAAI/bge-m3' || !['cpu', 'cuda'].includes(body.device)) throw new ProviderError('BAD_RESPONSE', this.context);
    if (body.revision != null && !/^[a-f0-9]{40}$/.test(body.revision)) throw new ProviderError('BAD_RESPONSE', this.context);
    this.revision = body.revision ?? null;
    return { ok: true, model: body.tag, dimensions: body.dims, device: body.device, revision: this.revision };
  }

  async embed({ texts, taskType = 'document', signal, timeouts } = {}) {
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > MAX_TEXTS
      || texts.some(text => typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_CHARS)
      || !['query', 'document'].includes(taskType)) throw new ProviderError('BAD_REQUEST', this.context);
    const ceiling = taskType === 'query' ? 300 : 60000;
    const limits = Object.fromEntries(['firstByteMs', 'idleMs', 'totalMs'].map(key => [key,
      Math.min(ceiling, Number.isFinite(timeouts?.[key]) ? Math.max(1, timeouts[key]) : ceiling)]));
    const body = await this.operation('/embed', { texts, task_type: taskType }, { signal,
      timeouts: limits });
    const result = validateEmbeddingResult(body, texts.length, this.model);
    this.revision = result.revision ?? null;
    return result;
  }
}
