// ---------------------------------------------------------------------------
// modelWarmup.js
// Best-effort, fire-and-forget maintenance requests for 9inference models.
// ---------------------------------------------------------------------------
import { getProviderRegistry } from './providers/registry.js';
import { totalTokens } from './providers/adapters/shared.js';

export const KEEP_ALIVE_IDLE_MS = 4.5 * 60 * 1000;

let activeSessions = 0;
let lastConversationActivity = Date.now();
let keepAliveTimer = null;
let deepSeekMaintenanceInFlight = null;

function errorMessage(error) {
  return error?.message ?? String(error);
}

function responseSummary(response) {
  return {
    characters: response?.text?.length ?? 0,
    finishReason: response?.finishReason ?? 'n/a',
    completionTokens: response?.outputTokens ?? 'n/a',
    totalTokens: totalTokens(response ?? {}, 'n/a'),
  };
}

async function pingModel(kind, { signal, registry = getProviderRegistry() } = {}) {
  const status = registry.getSlotStatus('visionFilter');
  if (!status.available) return null;
  const provider = registry.getLlm('visionFilter');
  if (!provider.warmup) return null;
  const model = status.model;
  const startedAt = performance.now();
  console.log(`[${kind}] ${model} request sent`);

  try {
    const response = await provider.warmup({ signal });
    const durationMs = Math.round(performance.now() - startedAt);
    const summary = responseSummary(response);
    console.log(
      `[${kind}] ${model} response received successfully in ${durationMs}ms` +
        ` (${summary.characters} chars, completion_tokens=${summary.completionTokens},` +
        ` total_tokens=${summary.totalTokens}, finish_reason=${summary.finishReason},` +
        ` id=${response.id ?? 'n/a'})`,
    );
    return response;
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    console.warn(
      `[${kind}] ${model} failed after ${durationMs}ms: ${errorMessage(error)}`,
    );
    throw error;
  }
}

function pingDeepSeek(kind, options) {
  // Avoid stacking maintenance calls if 9inference is responding slowly.
  if (deepSeekMaintenanceInFlight) return deepSeekMaintenanceInFlight;

  deepSeekMaintenanceInFlight = pingModel(kind, options).finally(() => {
    deepSeekMaintenanceInFlight = null;
  });
  return deepSeekMaintenanceInFlight;
}

export function warmUpModels(options) {
  // Only warm up 9inference DeepSeek. Vision (Qwen 3.8 27B) runs on Groq
  // which doesn't need maintenance pings (always-on infrastructure).
  return Promise.allSettled([
    pingDeepSeek('warmup', options),
  ]);
}

function clearKeepAliveTimer() {
  if (!keepAliveTimer) return;
  clearTimeout(keepAliveTimer);
  keepAliveTimer = null;
}

function scheduleKeepAlive() {
  clearKeepAliveTimer();
  if (activeSessions === 0) return;

  const idleFor = Date.now() - lastConversationActivity;
  const delay = Math.max(0, KEEP_ALIVE_IDLE_MS - idleFor);
  keepAliveTimer = setTimeout(() => {
    keepAliveTimer = null;
    if (activeSessions === 0) return;

    const currentIdleFor = Date.now() - lastConversationActivity;
    if (currentIdleFor < KEEP_ALIVE_IDLE_MS) {
      scheduleKeepAlive();
      return;
    }

    void pingDeepSeek('keepalive').catch(() => {});
    // A maintenance ping starts a fresh idle window. Real activity can reset
    // this timestamp again independently while the request is in flight.
    lastConversationActivity = Date.now();
    scheduleKeepAlive();
  }, delay);
  keepAliveTimer.unref?.();
}

export function companionSessionOpened() {
  activeSessions += 1;
  if (activeSessions === 1) {
    lastConversationActivity = Date.now();
    scheduleKeepAlive();
  }
}

export function companionSessionClosed() {
  activeSessions = Math.max(0, activeSessions - 1);
  if (activeSessions === 0) clearKeepAliveTimer();
}

export function markConversationActivity() {
  lastConversationActivity = Date.now();
  scheduleKeepAlive();
}
