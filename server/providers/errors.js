const MESSAGES = {
  AUTH: 'Provider authentication failed. Check the configured API key environment variable.',
  RATE_LIMIT: 'Provider rate limit reached. Try again later.',
  TIMEOUT: 'Provider request timed out.',
  BAD_REQUEST: 'Provider rejected the request. Check the model and profile parameters.',
  SERVER: 'Provider service is temporarily unavailable.',
  NETWORK: 'Provider connection failed.',
  UNSUPPORTED: 'The configured provider does not support this operation.',
  ABORTED: 'Provider request was cancelled.',
  BAD_RESPONSE: 'Provider returned an invalid or incomplete response.',
};

export class ProviderError extends Error {
  constructor(code, { providerId, slot, status, retryAfterMs } = {}) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'BAD_RESPONSE';
    super(MESSAGES[safeCode]);
    this.name = 'ProviderError';
    this.code = safeCode;
    this.providerId = providerId;
    this.slot = slot;
    if (Number.isFinite(status)) this.status = status;
    if (Number.isFinite(retryAfterMs)) this.retryAfterMs = Math.max(0, retryAfterMs);
  }
}

export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || String(value).trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

export function httpProviderError(response, context = {}) {
  const status = response.status;
  const code = status === 401 || status === 403 ? 'AUTH'
    : status === 429 ? 'RATE_LIMIT'
      : status === 408 ? 'TIMEOUT'
        : status >= 500 ? 'SERVER' : 'BAD_REQUEST';
  return new ProviderError(code, {
    ...context, status, retryAfterMs: parseRetryAfter(response.headers?.get('retry-after')),
  });
}

export function normalizeProviderError(error, context = {}, signal) {
  if (signal?.aborted) {
    const code = signal.reason instanceof ProviderError ? signal.reason.code : 'ABORTED';
    return new ProviderError(code, context);
  }
  if (error instanceof ProviderError) return error;
  if (error?.name === 'AbortError') return new ProviderError('ABORTED', context);
  if (error instanceof SyntaxError) return new ProviderError('BAD_RESPONSE', context);
  return new ProviderError('NETWORK', context);
}

export function throwIfAborted(signal, context = {}) {
  if (signal?.aborted) throw normalizeProviderError(signal.reason, context, signal);
}
