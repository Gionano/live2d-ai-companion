// ---------------------------------------------------------------------------
// modelWarmup.js
// Best-effort, fire-and-forget maintenance requests for 9inference models.
// ---------------------------------------------------------------------------
import { client } from './nineInferenceClient.js';
import { CHAT_MODEL } from './modelConfig.js';

export const KEEP_ALIVE_IDLE_MS = 4.5 * 60 * 1000;

let activeSessions = 0;
let lastConversationActivity = Date.now();
let keepAliveTimer = null;
let deepSeekMaintenanceInFlight = null;

function errorMessage(error) {
  return error?.message ?? String(error);
}

function responseSummary(response) {
  const choice = response?.choices?.[0];
  return {
    characters: choice?.message?.content?.length ?? 0,
    finishReason: choice?.finish_reason ?? 'n/a',
    completionTokens: response?.usage?.completion_tokens ?? 'n/a',
    totalTokens: response?.usage?.total_tokens ?? 'n/a',
  };
}

async function pingModel(model, kind) {
  const startedAt = performance.now();
  console.log(`[${kind}] ${model} request sent`);

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    });
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

function pingDeepSeek(kind) {
  // Avoid stacking maintenance calls if 9inference is responding slowly.
  if (deepSeekMaintenanceInFlight) return deepSeekMaintenanceInFlight;

  deepSeekMaintenanceInFlight = pingModel(CHAT_MODEL, kind).finally(() => {
    deepSeekMaintenanceInFlight = null;
  });
  return deepSeekMaintenanceInFlight;
}

export function warmUpModels() {
  // Only warm up 9inference DeepSeek. Vision (Qwen 3.8 27B) runs on Groq
  // which doesn't need maintenance pings (always-on infrastructure).
  return Promise.allSettled([
    pingDeepSeek('warmup'),
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
