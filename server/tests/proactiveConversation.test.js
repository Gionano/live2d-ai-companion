import test from 'node:test';
import assert from 'node:assert/strict';
import { ProactiveConversation } from '../proactiveConversation.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(t, options = {}) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const requests = [];
  const spoken = [];
  const cancelled = [];
  const statuses = [];
  const socket = {};
  const history = [{ role: 'user', content: 'Aku sedang belajar memasak.' }];
  const responses = options.responses ?? [{ action: 'SPEAK', topic: 'Resep makan malam baru' }];
  const available = { visionFilter: true, llm: true, tts: true };
  let busy = false;
  const scheduler = new ProactiveConversation({ enabled: options.enabled ?? true,
    clock: () => now,
    setTimer: (callback, ms) => {
      const id = ++nextTimer;
      timers.set(id, { callback, ms, at: now + ms });
      return id;
    },
    clearTimer: id => timers.delete(id),
    registry: {
      getSlotStatus: slot => ({ available: available[slot] }),
      getLlm: () => ({ complete: request => {
        requests.push(request);
        return options.complete ? options.complete(request)
          : Promise.resolve({ text: JSON.stringify(responses.shift() ?? { action: 'SKIP' }) });
      } }),
    },
  });
  const register = target => scheduler.register(target, { history: () => history,
    getVisionContext: () => 'Layar menampilkan buku resep.', isBusy: () => busy,
    onSpeak: async value => {
      spoken.push({ socket: target, ...value });
      return { speechId: `speech-${spoken.length}`, ok: true };
    },
    onCancel: value => cancelled.push({ socket: target, ...value }),
    onStatus: value => statuses.push(value),
  });
  register(socket);
  t.after(() => scheduler.dispose());
  return { scheduler, socket, history, requests, spoken, cancelled, statuses, available, timers, register,
    advance: ms => { now += ms; }, setBusy: value => { busy = value; } };
}

test('default and a newly connected client cannot initiate unsolicited speech', async t => {
  const h = harness(t, { enabled: false });
  h.scheduler.userActivity(h.socket);
  h.advance(120000);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  assert.equal(h.requests.length, 0);
  h.scheduler.updateSettings({ enabled: true });
  const other = {};
  h.register(other);
  h.scheduler.unregister(h.socket);
  h.advance(120000);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  assert.equal(h.requests.length, 0);
});

test('quiet interval starts after actual playback release rather than generation completion', async t => {
  const h = harness(t);
  h.scheduler.userActivity(h.socket);
  h.advance(60000);
  assert.equal((await h.scheduler.check()).action, 'SPEAK');
  assert.equal(h.spoken.length, 1);
  h.advance(90000);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  h.scheduler.playbackCompleted(h.socket, { origin: 'proactive', reason: 'acknowledged',
    hasAudio: true, speechId: 'speech-1' });
  h.advance(59999);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  assert.equal(h.requests.length, 1);
  h.advance(1);
  await h.scheduler.check();
  assert.equal(h.requests.length, 2);
});

test('one SKIP per quiet interval and no fabricated user message', async t => {
  const h = harness(t, { responses: [{ action: 'SKIP' }, { action: 'SPEAK', topic: 'Ide sarapan besok' }] });
  h.scheduler.userActivity(h.socket);
  h.advance(60000);
  assert.equal((await h.scheduler.check()).action, 'SKIP');
  h.advance(300000);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  assert.equal(h.requests.length, 1);
  h.scheduler.userActivity(h.socket);
  h.advance(60000);
  assert.equal((await h.scheduler.check()).action, 'SPEAK');
  assert.deepEqual(h.spoken[0].history, h.history);
  assert.equal(h.history.length, 1);
});

test('latest user session wins and all busy sessions block automatic generation', async t => {
  const h = harness(t);
  const other = {};
  h.register(other);
  h.scheduler.userActivity(h.socket);
  h.scheduler.userActivity(other);
  h.advance(60000);
  h.setBusy(true);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  assert.equal(h.requests.length, 0);
  h.setBusy(false);
  await h.scheduler.check();
  assert.equal(h.spoken[0].socket, other);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
});

test('active typing or utterance suppresses timer and restarts delay after end', async t => {
  const h = harness(t);
  h.scheduler.setUserActive(h.socket, true);
  h.advance(180000);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  assert.equal(h.timers.size, 0);
  h.scheduler.setUserActive(h.socket, false);
  h.advance(59999);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  h.advance(1);
  assert.equal((await h.scheduler.check()).action, 'SPEAK');
});

test('two unanswered audible prompts stop until user activity; repeated topics skip', async t => {
  const h = harness(t, { responses: [
    { action: 'SPEAK', topic: 'Resep makan malam baru' },
    { action: 'SPEAK', topic: 'Musik untuk menemani belajar' },
    { action: 'SPEAK', topic: 'Resep makan malam baru!' },
  ] });
  h.scheduler.userActivity(h.socket);
  for (let index = 1; index <= 2; index++) {
    h.advance(60000);
    assert.equal((await h.scheduler.check()).action, 'SPEAK');
    h.scheduler.playbackCompleted(h.socket, { origin: 'proactive', speechId: `speech-${index}` });
  }
  h.advance(120000);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  assert.equal(h.requests.length, 2);
  h.scheduler.userActivity(h.socket);
  h.advance(60000);
  assert.equal((await h.scheduler.check()).action, 'SKIP');
  assert.equal(h.spoken.length, 2);
});

test('user takeover rejects late decision even if provider ignores abort', async t => {
  const decision = deferred();
  const h = harness(t, { complete: () => decision.promise });
  h.scheduler.userActivity(h.socket);
  h.advance(60000);
  const attempt = h.scheduler.check();
  assert.equal(h.requests.length, 1);
  h.scheduler.userActivity(h.socket);
  decision.resolve({ text: JSON.stringify({ action: 'SPEAK', topic: 'Obrolan yang sudah usang' }) });
  assert.equal((await attempt).action, 'CANCELLED');
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.spoken.length, 0);
});

test('disable and disconnect cancel speech that is awaiting playback completion', async t => {
  const h = harness(t, { responses: [
    { action: 'SPEAK', topic: 'Resep malam ini' }, { action: 'SPEAK', topic: 'Jalan pagi besok' },
  ] });
  h.scheduler.userActivity(h.socket);
  h.advance(60000);
  await h.scheduler.check();
  h.scheduler.updateSettings({ enabled: false });
  assert.equal(h.spoken[0].signal.aborted, true);
  assert.equal(h.cancelled[0].reason, 'disabled');
  h.scheduler.updateSettings({ enabled: true });
  h.scheduler.userActivity(h.socket);
  h.advance(60000);
  await h.scheduler.check();
  h.scheduler.unregister(h.socket);
  assert.equal(h.spoken[1].signal.aborted, true);
  assert.equal(h.cancelled[1].reason, 'disconnected');
});

test('unavailable voice or model avoids calls; no-audio failure does not loop', async t => {
  const h = harness(t);
  h.scheduler.userActivity(h.socket);
  h.advance(60000);
  for (const slot of ['visionFilter', 'llm', 'tts']) {
    h.available[slot] = false;
    assert.equal((await h.scheduler.check()).action, 'WAIT');
    h.available[slot] = true;
  }
  assert.equal(h.requests.length, 0);
  await h.scheduler.check();
  h.scheduler.playbackCompleted(h.socket, { origin: 'proactive', reason: 'no_audio',
    hasAudio: false, speechId: 'speech-1' });
  h.advance(180000);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  assert.equal(h.requests.length, 1);
});

test('hung decision is bounded and cannot deliver a late reply', async t => {
  const decision = deferred();
  const h = harness(t, { complete: () => decision.promise });
  h.scheduler.userActivity(h.socket);
  h.advance(60000);
  const attempt = h.scheduler.check();
  const timeout = [...h.timers.values()].find(timer => timer.ms === 30000);
  timeout.callback();
  assert.equal((await attempt).action, 'CANCELLED');
  assert.equal(h.scheduler.activeAttempt, null);
  assert.equal(h.scheduler.getStatus(h.socket).reason, 'decision_timeout');
  decision.resolve({ text: JSON.stringify({ action: 'SPEAK', topic: 'Balasan terlambat' }) });
  assert.equal(h.spoken.length, 0);
});

test('diagnostics distinguish arming, countdown, busy providers, SKIP and model errors without history', async t => {
  const h = harness(t, { responses: [{ action: 'SKIP' }] });
  assert.equal(h.statuses.at(-1).status, 'unarmed');
  h.scheduler.userActivity(h.socket);
  assert.equal(h.statuses.at(-1).remainingMs, 60000);
  h.advance(60000);
  h.setBusy(true);
  await h.scheduler.check();
  assert.equal(h.statuses.at(-1).reason, 'conversation_busy');
  h.setBusy(false);
  h.available.visionFilter = false;
  await h.scheduler.check();
  assert.equal(h.statuses.at(-1).reason, 'unavailable_visionFilter');
  h.available.visionFilter = true;
  await h.scheduler.check();
  assert.equal(h.statuses.at(-1).status, 'skipped');
  assert.equal(h.statuses.at(-1).reason, 'no_topic');
  assert.doesNotMatch(JSON.stringify(h.statuses), /memasak|resep|"conversation"\s*:|visionContext|previousTopics/i);
});

test('a temporary commentary conflict discards the proposed topic and retries after it clears', async t => {
  const first = deferred();
  let requests = 0;
  const h = harness(t, { complete: () => ++requests === 1 ? first.promise
    : { text: JSON.stringify({ action: 'SPEAK', topic: 'Fresh follow-up topic' }) } });
  h.scheduler.userActivity(h.socket);
  h.advance(60000);
  const deciding = h.scheduler.check();
  h.setBusy(true);
  first.resolve({ text: JSON.stringify({ action: 'SPEAK', topic: 'Obsolete visual topic' }) });
  assert.equal((await deciding).action, 'WAIT');
  assert.equal(h.spoken.length, 0);
  assert.equal(h.scheduler.getStatus(h.socket).reason, 'conversation_busy');
  h.setBusy(false);
  assert.equal((await h.scheduler.check()).action, 'SPEAK');
  assert.equal(h.requests.length, 2);
  assert.equal(h.spoken[0].topic, 'Fresh follow-up topic');
});

test('commentary playback during a decision restarts the quiet delay before another topic request', async t => {
  const decision = deferred();
  const h = harness(t, { complete: () => decision.promise });
  h.scheduler.userActivity(h.socket);
  h.advance(60000);
  const deciding = h.scheduler.check();
  h.advance(8000);
  h.scheduler.playbackCompleted(h.socket, { origin: 'vision', speechId: 'comment-1' });
  decision.resolve({ text: JSON.stringify({ action: 'SPEAK', topic: 'Old camera topic' }) });
  assert.equal((await deciding).action, 'WAIT');
  assert.equal(h.spoken.length, 0);
  assert.equal(h.scheduler.getStatus(h.socket).remainingMs, 60000);
  h.advance(59999);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  assert.equal(h.requests.length, 1);
});

test('a decision slower than fifteen seconds can finish inside the new thirty-second deadline', async t => {
  const decision = deferred();
  const h = harness(t, { complete: () => decision.promise });
  h.scheduler.userActivity(h.socket);
  h.advance(60000);
  const deciding = h.scheduler.check();
  h.advance(20886);
  assert.equal(h.scheduler.getStatus(h.socket).status, 'deciding');
  assert.equal(h.scheduler.getStatus(h.socket).decisionTimeoutMs, 30000);
  decision.resolve({ text: JSON.stringify({ action: 'SPEAK', topic: 'New activity for tomorrow' }) });
  assert.equal((await deciding).action, 'SPEAK');
  assert.equal(h.spoken.length, 1);
});
