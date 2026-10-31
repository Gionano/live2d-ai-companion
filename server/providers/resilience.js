import { ProviderError, normalizeProviderError } from './errors.js';

export const DEFAULT_TIMEOUTS = { firstByteMs: 120000, idleMs: 120000, totalMs: 120000 };
const RETRYABLE = new Set(['RATE_LIMIT', 'SERVER', 'NETWORK']);

/**
 * Owns cancellation and all attempts. Any event yielded to the caller prohibits
 * replay, including usage events. touch() marks incoming bytes, not outgoing work.
 */
export async function* resilientStream(factory, {
  signal: outerSignal, timeouts = {}, providerId, slot, maxRetries = 2,
  baseDelayMs = 250, random = Math.random,
} = {}) {
  const context = { providerId, slot };
  const controller = new AbortController();
  const signal = controller.signal;
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  let firstTimer;
  let idleTimer;
  let totalTimer;
  let emitted = false;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  // Keep the rejection observed even when cancellation happens between pulls.
  aborted.catch(() => {});
  const cancel = (code) => {
    if (!signal.aborted) controller.abort(new ProviderError(code, context));
  };
  const onOuterAbort = () => cancel('ABORTED');
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
  if (outerSignal?.aborted) onOuterAbort();
  const timer = (ms) => ms > 0 ? setTimeout(() => cancel('TIMEOUT'), ms) : undefined;
  const clearAttemptTimers = () => { clearTimeout(firstTimer); clearTimeout(idleTimer); };
  totalTimer = timer(limits.totalMs);
  try {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw signal.reason;
      firstTimer = timer(limits.firstByteMs);
      const touch = () => {
        clearTimeout(firstTimer);
        clearTimeout(idleTimer);
        idleTimer = timer(limits.idleMs);
      };
      let iterator;
      try {
        iterator = factory({ signal, touch })[Symbol.asyncIterator]();
        for (;;) {
          const next = await Promise.race([iterator.next(), aborted]);
          if (signal.aborted) throw signal.reason;
          if (next.done) return;
          emitted = true;
          yield next.value;
        }
      } catch (error) {
        const normalized = normalizeProviderError(error, context, signal);
        clearAttemptTimers();
        if (emitted || attempt >= Math.min(2, Math.max(0, maxRetries)) || !RETRYABLE.has(normalized.code)) {
          throw normalized;
        }
        // Retry-After is a lower bound. The total deadline still limits the wait.
        const backoff = baseDelayMs * 2 ** attempt * (1 + Math.max(0, random()) * 0.25);
        const delay = Math.max(normalized.retryAfterMs ?? 0, backoff);
        let retryTimer;
        try {
          await Promise.race([new Promise((resolve) => { retryTimer = setTimeout(resolve, delay); }), aborted]);
        } finally {
          clearTimeout(retryTimer);
        }
      } finally {
        clearAttemptTimers();
        // Fetch and socket adapters observe the shared signal. Their return()
        // closes the body/socket when a consumer stops before completion.
        if (iterator?.return) await iterator.return();
      }
    }
  } finally {
    clearAttemptTimers();
    clearTimeout(totalTimer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
    signal.removeEventListener('abort', onAbort);
    if (!signal.aborted) controller.abort(new ProviderError('ABORTED', context));
  }
}
