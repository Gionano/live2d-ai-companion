import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SpeechController } from '../speechController.js';
import { playConversationReply } from '../conversationSpeech.js';
import { SpeechPlayback, TurnState } from '../../src/speechPlayback.js';
import { planSelfie } from '../selfie/planner.js';
import { prepareSelfieJob } from '../selfie/backendLifecycle.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function tick() {
  await new Promise(resolve => setImmediate(resolve));
}

function fakeTimers(t) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, at: now + delay });
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  return {
    advance(duration) {
      const target = now + duration;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = target;
    },
    remaining(id) { return timers.get(id)?.at - now; },
  };
}

function harness(generateSpeech, options = {}) {
  const events = [];
  const acknowledgments = [];
  const playbackGate = deferred();
  const socket = {};
  const controller = new SpeechController({
    generateSpeech,
    isVoiceConfigured: () => true,
    ...options,
  });
  const playback = new SpeechPlayback({
    playAudio: () => playbackGate.promise,
    onFinished: speechId => {
      acknowledgments.push(speechId);
      // WebSocket messages reach the server on a later turn.
      queueMicrotask(() => controller.acknowledge(socket, speechId));
    },
  });
  controller.register(socket, event => {
    events.push(event);
    playback.handle(event);
  });
  return { controller, playback, socket, events, acknowledgments, playbackGate };
}

test('delayed TTS cannot finish before speech_end and actual playback; caption drains after idle', async () => {
  const audioGate = deferred();
  const h = harness(async function* (text) {
    if (text === 'initial') await audioGate.promise;
    yield Buffer.from(text);
  });
  const first = h.controller.play({ text: 'initial' });
  const caption = h.controller.play({ text: 'caption', deferred: true });
  assert.equal(h.events[0].type, 'speech_start');
  const firstId = h.events[0].speechId;
  assert.equal(h.socket.conversationState, 'speaking');
  assert.ok(h.events.some(event => event.type === 'amika_replied'));
  await tick();
  assert.deepEqual(h.acknowledgments, []);
  assert.equal(h.events.some(event => event.type === 'speech_end'), false);
  assert.equal(h.controller.acknowledge(h.socket, firstId), false);

  audioGate.resolve();
  assert.equal((await first).ok, true);
  assert.equal(h.socket.conversationState, 'idle');
  assert.equal(h.playback.busy, true);
  assert.deepEqual(h.acknowledgments, []);
  assert.equal(h.events.filter(event => event.type === 'speech_start').length, 1);
  assert.equal(h.controller.acknowledge(h.socket, 'unknown'), false);
  const firstEvents = h.events.filter(event => event.speechId === firstId);
  assert.ok(firstEvents.findIndex(event => event.type === 'audio_output') < firstEvents.findIndex(event => event.type === 'speech_end'));

  h.playbackGate.resolve();
  await caption;
  await h.playback.chain;
  await tick();
  assert.equal(h.acknowledgments.length, 2);
  assert.equal(h.controller.activeSpeech, null);
  assert.equal(h.socket.conversationState, 'idle');
  assert.equal(h.controller.acknowledge(h.socket, firstId), false);
  const firstIdle = h.events.findIndex(event => event.type === 'conversation_state' && event.state === 'idle');
  const captionLog = h.events.findIndex(event => event.type === 'amika_replied' && event.text === 'caption');
  assert.ok(firstIdle < captionLog);
  h.controller.unregister(h.socket);
});

for (const mode of ['fails', 'empty']) {
  test(`${mode} TTS always ends speech, restores idle, and speaks a queued caption`, async () => {
    const gate = deferred();
    const calls = [];
    const h = harness(async function* (text) {
      calls.push(text);
      if (text === 'initial') {
        await gate.promise;
        if (mode === 'fails') throw new Error('Fake TTS failure');
      }
    });
    const first = h.controller.play({ text: 'initial' });
    const caption = h.controller.play({ text: 'caption', deferred: true });
    assert.equal(h.socket.conversationState, 'speaking');
    assert.deepEqual(h.acknowledgments, []);
    gate.resolve();
    const result = await first;
    await caption;
    await tick();
    assert.equal(result.ok, mode !== 'fails');
    const end = h.events.find(event => event.type === 'speech_end' && event.speechId === result.speechId);
    assert.equal(end.ok, mode !== 'fails');
    assert.deepEqual(calls, ['initial', 'caption']);
    assert.equal(h.socket.conversationState, 'idle');
    assert.equal(h.controller.activeSpeech, null);
    assert.equal(h.playback.busy, false);
    h.controller.unregister(h.socket);
  });
}

test('speech timeout aborts delayed TTS, restores idle, and drains caption without late audio', async () => {
  const h = harness(async function* (text, emotion, { signal }) {
    if (text === 'initial') {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      yield Buffer.from('late audio');
    }
  }, { safetyTimeoutMs: 20 });
  const first = h.controller.play({ text: 'initial' });
  const caption = h.controller.play({ text: 'caption', deferred: true });
  const result = await first;
  await caption;
  await tick();
  assert.equal(result.ok, false);
  assert.equal(h.socket.conversationState, 'idle');
  assert.equal(h.controller.activeSpeech, null);
  assert.equal(h.events.some(event => event.type === 'audio_output'), false);
  assert.equal(h.events.filter(event => event.type === 'speech_end' && event.speechId === result.speechId).length, 1);
  h.controller.unregister(h.socket);
});

test('stage progress and TTS activity keep a healthy multi-stage reply alive beyond the inactivity timeout', async t => {
  const clock = fakeTimers(t);
  const stageGates = [deferred(), deferred(), deferred()];
  const audioGates = [deferred(), deferred(), deferred()];
  const h = harness(async function* (text, emotion, options) {
    options.onAudioFormat('mp3');
    for (const gate of audioGates) {
      await gate.promise;
      yield Buffer.from('audio');
    }
    options.onAudioEnd();
  }, { safetyTimeoutMs: 45 });
  t.after(() => h.controller.unregister(h.socket));
  const turn = h.controller.beginTurn(h.socket);
  const resultPromise = playConversationReply({ controller: h.controller, socket: h.socket,
    turnId: turn.turnId, history: [], userMessage: 'Explain',
    generate: async function* () {
      yield { type: 'reply_part', stage: 'surface', partId: 'surface', status: 'start', text: '' };
      for (const gate of stageGates) {
        await gate.promise;
        yield { type: 'reply_part', stage: 'deep', partId: 'deep', status: 'delta', text: 'Continuing. ' };
      }
      yield { type: 'delta', text: 'A complete reply.' };
      yield { type: 'sentence', stage: 'deep', text: 'A complete reply.', pauseAfterMs: 200 };
      yield { type: 'conversation_done', text: 'A complete reply.', emotion: 'netral' };
    } });
  await tick();
  for (const gate of [...stageGates, ...audioGates]) {
    clock.advance(35);
    assert.equal(h.controller.isCurrentTurn(h.socket, turn.turnId), true);
    gate.resolve();
    await tick();
  }
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(h.events.filter(event => event.type === 'audio_output').length, 3);
  assert.equal(h.events.some(event => event.type === 'turn_cancelled'), false);
  assert.equal(h.controller.acknowledge(h.socket, result.speechId), true);
});

test('fuller queued speech gets a bounded playback budget after generation finishes', async t => {
  const clock = fakeTimers(t);
  const h = harness(async function* () { yield Buffer.from('audio'); }, { safetyTimeoutMs: 45 });
  t.after(() => h.controller.unregister(h.socket));
  const text = 'A thoughtful reply can continue naturally through several sentences. '.repeat(12);
  const result = await h.controller.play({ recipients: [h.socket], produce: ({ say }) =>
    say(text, 'netral', () => {}, { pauseBeforeMs: 150, pauseAfterMs: 200 }) });
  const remaining = clock.remaining(h.controller.activeSpeech.timer);
  assert.ok(remaining > 45);
  assert.ok(remaining <= 10 * 60 * 1000);
  clock.advance(46);
  assert.equal(h.controller.activeSpeech.speechId, result.speechId);
  assert.equal(h.events.some(event => event.type === 'stop_speech'), false);
  assert.equal(h.controller.acknowledge(h.socket, result.speechId), true);

  await h.controller.play({ text: 'Lengthy speech. '.repeat(10000), recipients: [h.socket] });
  assert.equal(clock.remaining(h.controller.activeSpeech.timer), 10 * 60 * 1000);
  clock.advance(10 * 60 * 1000);
  assert.equal(h.controller.activeSpeech, null);
});

test('a buffered repeated opening reports private progress without restarting speech or timing out', async t => {
  const clock = fakeTimers(t);
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const h = harness(async function* () { yield Buffer.from('audio'); }, { safetyTimeoutMs: 45 });
  t.after(() => h.controller.unregister(h.socket));
  const registry = {
    getSlotStatus: () => ({ available: true }), getTts: () => ({ params: {} }),
    getLlm: role => ({ async *stream() {
      if (role === 'surface') {
        yield { type: 'text', delta: JSON.stringify({ status: 'ok', mode: 'say+think',
          segments: [{ emotion: 'netral', text: 'Aku dengar.' }] }) };
        return;
      }
      yield { type: 'text', delta: '{"segments":[{"emotion":"sayang","text":"Aku' };
      const chunks = [' dengar.', ' Kamu', ' bisa cerita dulu.', '"}]}'];
      for (let index = 0; index < gates.length; index++) {
        await gates[index].promise;
        yield { type: 'text', delta: chunks[index] };
      }
    } }),
  };
  const turn = h.controller.beginTurn(h.socket);
  const resultPromise = playConversationReply({ controller: h.controller, socket: h.socket,
    turnId: turn.turnId, history: [], userMessage: 'cerita', registry });
  await tick();
  for (const gate of gates) {
    clock.advance(35);
    assert.equal(h.controller.isCurrentTurn(h.socket, turn.turnId), true);
    gate.resolve();
    await tick();
  }
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Aku dengar. Kamu bisa cerita dulu.');
  assert.equal(h.events.filter(event => event.type === 'speech_start').length, 1);
  assert.equal(h.events.filter(event => event.type === 'audio_output').length, 2);
  assert.equal(h.events.some(event => ['generation_progress', 'opening_suppressed', 'turn_cancelled'].includes(event.type)), false);
  assert.deepEqual(h.events.filter(event => event.type === 'reply_part' && event.status === 'done').map(event => event.text),
    ['Aku dengar.', 'Kamu bisa cerita dulu.']);
  assert.equal(h.controller.acknowledge(h.socket, result.speechId), true);
});

test('idle to idle transitions drain deferred captions', async () => {
  const h = harness(async function* () {});
  h.controller.setState(h.socket, 'processing');
  const caption = h.controller.play({ text: 'caption', deferred: true });
  assert.equal(h.events.some(event => event.type === 'speech_start'), false);
  // Simulate another completion already restoring the state.
  h.socket.conversationState = 'idle';
  h.controller.setState(h.socket, 'idle');
  await caption;
  assert.ok(h.events.some(event => event.type === 'amika_replied' && event.text === 'caption'));
  assert.equal(h.socket.conversationState, 'idle');
  h.controller.unregister(h.socket);
});

test('streamed chat sentences share one ID and failed partial audio waits for playback', async () => {
  const h = harness(async function* (text) {
    yield Buffer.from(text);
    if (text === 'second') throw new Error('Partial TTS failure');
  });
  const first = h.controller.play({
    recipients: [h.socket],
    produce: async ({ say }) => {
      await say('first');
      await say('second');
    },
  });
  const caption = h.controller.play({ text: 'caption', deferred: true });
  const result = await first;
  assert.equal(result.ok, false);
  assert.equal(h.socket.conversationState, 'idle');
  assert.equal(h.events.filter(event => event.type === 'speech_start').length, 1);
  assert.equal(h.events.filter(event => event.type === 'audio_end').length, 2);
  assert.ok(h.events.filter(event => event.type === 'audio_output').every(event => event.speechId === result.speechId));
  assert.deepEqual(h.acknowledgments, []);
  assert.equal(h.controller.activeSpeech.speechId, result.speechId);
  assert.equal(h.events.some(event => event.type === 'amika_replied' && event.text === 'caption'), false);
  h.playbackGate.resolve();
  await caption;
  await h.playback.chain;
  await tick();
  assert.equal(h.acknowledgments[0], result.speechId);
  assert.equal(h.acknowledgments.length, 2);
  assert.equal(h.controller.activeSpeech, null);
  h.controller.unregister(h.socket);
});

// Execute the real input branch with fake providers, without starting the backend
// or loading credentials. This catches stale results in the handler's catch/finally.
function inputHandler(socket, controller, transcribeAudio, generateReplyStream = async function* () {}) {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf("    if (msg.type !== 'audio_input' && msg.type !== 'text_input') return;");
  const end = source.indexOf('\n  });\n});', start);
  assert.ok(start >= 0 && end > start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('socket', 'speechController', 'transcribeAudio', 'playConversationReply',
    'history', 'msg', 'extFromMime', 'detectSelfieIntent', 'visionRouter',
    'markConversationActivity', 'HISTORY_MESSAGE_LIMIT', 'memoryManager', 'getSlotStatus',
    'proactiveConversation', 'visionManager', 'visionSessions',
    'speechMemoryRecorder', 'trimConversationHistory', source.slice(start, end));
  const history = [];
  return msg => run(socket, controller, transcribeAudio, options =>
    playConversationReply({ ...options, generate: generateReplyStream }), history, msg,
    () => 'webm', () => ({ isSelfie: false }), { route: async () => ({ sources: [] }) }, () => {}, 20,
    { recordTurnAndExtract() {} }, () => ({ available: true }),
    { updateSettings() {}, setUserActive() {}, consumeGuidance: () => ({}) },
    { getConversationContext: () => null, getRoutingObservations: () => [], getSourceSnapshot: () => ({}),
      setAssistantContext() {}, conversationActivity() {} }, new Map(),
      { context: () => null }, history => history);
}

test('processing expiry aborts STT and a late old error cannot reset a newer turn', async () => {
  const events = [];
  const socket = {};
  const controller = new SpeechController({
    generateSpeech: async function* () {}, isVoiceConfigured: () => false, safetyTimeoutMs: 40,
  });
  controller.register(socket, event => events.push(event));
  const old = deferred();
  const next = deferred();
  const expired = deferred();
  const signals = [];
  const handler = inputHandler(socket, controller, (buffer, filename, { signal }) => {
    signals.push(signal);
    if (signals.length === 1) {
      signal.addEventListener('abort', expired.resolve, { once: true });
      return old.promise; // Deliberately ignore cancellation to simulate a late provider error.
    }
    return next.promise;
  });
  const message = { type: 'audio_input', data: Buffer.alloc(600).toString('base64') };
  const oldTask = handler(message);
  const oldId = socket.turnId;
  await expired.promise;
  assert.equal(signals[0].aborted, true);
  assert.equal(socket.conversationState, 'idle');
  const nextTask = handler(message);
  const nextId = socket.turnId;
  assert.notEqual(nextId, oldId);
  old.reject(new Error('Late old STT error'));
  await oldTask;
  assert.equal(socket.turnId, nextId);
  assert.equal(socket.conversationState, 'processing');
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.equal(controller.sendTurn(socket, oldId, { type: 'user_said', text: 'late' }), false);
  next.resolve('hello there');
  await nextTask;
  assert.equal(socket.conversationState, 'idle');
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.equal(events.find(event => event.type === 'user_said').turnId, nextId);
  controller.unregister(socket);
});

test('private speech leaves another socket free to process its own input', async () => {
  const h = harness(async function* () { yield Buffer.from('audio'); });
  const other = {};
  const otherEvents = [];
  h.controller.register(other, event => otherEvents.push(event));
  const privateSpeech = await h.controller.play({ text: 'private', recipients: [h.socket] });
  assert.equal(h.controller.isBusy(h.socket), true);
  assert.equal(h.controller.isBusy(other), false);
  const transcribed = deferred();
  const handler = inputHandler(other, h.controller, () => transcribed.promise);
  const task = handler({ type: 'audio_input', data: Buffer.alloc(600).toString('base64') });
  assert.equal(other.conversationState, 'processing');
  assert.equal(otherEvents.some(event => event.type === 'speech_start'), false);
  transcribed.resolve('other socket talking');
  await tick();
  assert.ok(otherEvents.some(event => event.type === 'user_said'));
  assert.equal(other.conversationState, 'processing');
  h.playbackGate.resolve();
  await task;
  assert.equal(other.conversationState, 'idle');
  assert.equal(otherEvents.some(event => event.type === 'error'), false);
  assert.equal(h.controller.acknowledge(h.socket, privateSpeech.speechId), false);
  h.controller.unregister(other);
  h.controller.unregister(h.socket);
});

test('broadcast speech waits without overwriting another socket processing', async () => {
  const h = harness(async function* () {});
  const other = {};
  const events = [];
  h.controller.register(other, event => events.push(event));
  const turn = h.controller.beginTurn(other);
  const broadcast = h.controller.play({ text: 'broadcast' });
  await tick();
  assert.equal(other.turnId, turn.turnId);
  assert.equal(other.conversationState, 'processing');
  assert.equal(events.some(event => event.type === 'speech_start'), false);
  h.controller.completeTurn(other, turn.turnId);
  await broadcast;
  assert.equal(other.conversationState, 'idle');
  h.controller.unregister(other);
  h.controller.unregister(h.socket);
});

test('busy input gets an explicit rejection and restores optimistic client state', async () => {
  const events = [];
  const socket = {};
  const ui = new TurnState();
  const controller = new SpeechController({
    generateSpeech: async function* () { yield Buffer.from('audio'); }, isVoiceConfigured: () => true,
  });
  controller.register(socket, event => { events.push(event); ui.handle(event); });
  const first = await controller.play({ text: 'private', recipients: [socket] });
  assert.equal(ui.state, 'idle'); // Generation ended; playback is still pending.
  ui.state = 'processing'; // The form optimistically disables itself on submission.
  let calls = 0;
  const handler = inputHandler(socket, controller, () => { calls++; });
  await handler({ type: 'text_input', text: 'rejected input' });
  const rejection = events.find(event => event.type === 'input_rejected');
  assert.equal(rejection.reason, 'BUSY');
  assert.equal(rejection.state, 'speaking');
  assert.equal(ui.state, 'speaking');
  assert.equal(ui.playbackState({ busy: false }), 'speaking');
  assert.equal(calls, 0);
  controller.acknowledge(socket, first.speechId);
  assert.equal(ui.state, 'idle');
  assert.equal(ui.playbackState({ busy: false }), 'idle');
  assert.equal(controller.isBusy(socket), false);
  controller.rejectInput(socket, 'BUSY');
  assert.equal(ui.state, 'idle');
  controller.unregister(socket);
});

test('speech expiry aborts LLM and TTS and stops client audio before the next speech', async () => {
  const events = [];
  const socket = {};
  const signals = [];
  const stopped = deferred();
  const controller = new SpeechController({
    generateSpeech: async function* (text, emotion, { signal }) {
      signals.push(signal);
      if (text === 'initial') {
        yield Buffer.from('partial');
        return;
      }
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      yield Buffer.from('late');
    },
    isVoiceConfigured: () => true, safetyTimeoutMs: 20,
  });
  const playback = new SpeechPlayback({
    playAudio: async (chunks, emotion, { signal }) => {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      stopped.resolve();
    },
    onFinished: id => queueMicrotask(() => controller.acknowledge(socket, id)),
  });
  controller.register(socket, event => { events.push(event); playback.handle(event); });
  const turn = controller.beginTurn(socket);
  let llmSignal;
  const first = controller.play({ recipients: [socket], turnId: turn.turnId,
    produce: async ({ say, signal }) => {
      llmSignal = signal;
      await say('initial');
      await say('pending TTS');
    } });
  const caption = controller.play({ text: 'caption', produce: async () => {} });
  await first;
  await caption;
  await stopped.promise;
  await playback.chain;
  assert.equal(turn.signal.aborted, true);
  assert.equal(llmSignal.aborted, true);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, true);
  assert.equal(events.filter(event => event.type === 'audio_output').length, 1);
  const stop = events.findIndex(event => event.type === 'stop_speech');
  const starts = events.map((event, index) => event.type === 'speech_start' ? index : -1).filter(index => index >= 0);
  assert.ok(stop > starts[0] && stop < starts[1]);
  controller.unregister(socket);
});

test('expired selfie turn aborts its planner request and refunds unsubmitted admission', async () => {
  const abort = new AbortController();
  const entered = deferred();
  const paused = deferred();
  let admitted = true;
  let cancelled = 0;
  let submitted = 0;
  let plannerSignal;
  const manager = {
    tryAdmit: () => ({ allowed: true, jobId: 'admission' }),
    getProvider: async () => ({ isAvailable: async () => true }),
    isAdmitted: () => admitted,
    cancelJob: async () => { cancelled++; admitted = false; },
    submitJob: async () => { submitted++; return { ok: true }; },
    pickPhrase: () => '',
  };
  const llmProvider = { complete: async ({ signal }) => {
    plannerSignal = signal;
    signal.addEventListener('abort', () => paused.reject(signal.reason), { once: true });
    entered.resolve();
    return paused.promise;
  } };
  const request = prepareSelfieJob({ manager, planner: args => planSelfie({ ...args, llmProvider }),
    userText: 'pap dong', history: [], signal: abort.signal });
  await entered.promise;
  abort.abort(new Error('Turn expired'));
  await assert.rejects(request, /Turn expired/);
  assert.equal(plannerSignal.aborted, true);
  assert.ok(cancelled >= 1);
  assert.equal(submitted, 0);
});

test('client ignores old turn results and errors after a new processing turn', () => {
  const ui = new TurnState();
  ui.handle({ type: 'conversation_state', state: 'processing', turnId: 'old' });
  ui.handle({ type: 'turn_cancelled', turnId: 'old' });
  ui.handle({ type: 'conversation_state', state: 'processing', turnId: 'new' });
  assert.equal(ui.handle({ type: 'error', message: 'late', turnId: 'old' }), false);
  assert.equal(ui.handle({ type: 'amika_replied', text: 'late', turnId: 'old' }), false);
  assert.equal(ui.handle({ type: 'turn_cancelled', turnId: 'old' }), false);
  assert.equal(ui.state, 'processing');
  assert.equal(ui.turnId, 'new');
  assert.equal(ui.handle({ type: 'user_said', text: 'current', turnId: 'new' }), true);
});

test('stale acknowledgments cannot end a newer speech', async () => {
  const gate = deferred();
  const h = harness(async function* (text) {
    if (text === 'second') await gate.promise;
  });
  const first = await h.controller.play({ text: 'first' });
  const second = h.controller.play({ text: 'second' });
  assert.equal(h.controller.acknowledge(h.socket, first.speechId), false);
  assert.equal(h.socket.conversationState, 'speaking');
  gate.resolve();
  await second;
  h.controller.unregister(h.socket);
});

test('missing playback acknowledgment times out and releases a queued caption', async () => {
  const h = harness(async function* (text) {
    if (text === 'initial') yield Buffer.from(text);
  }, { safetyTimeoutMs: 20 });
  await h.controller.play({ text: 'initial' });
  const caption = h.controller.play({ text: 'caption', deferred: true });
  await caption;
  assert.ok(h.events.some(event => event.type === 'amika_replied' && event.text === 'caption'));
  assert.equal(h.socket.conversationState, 'idle');
  h.controller.unregister(h.socket);
  h.playback.reset();
  h.playbackGate.resolve();
  await h.playback.chain;
});

test('audio that finishes before speech_end cannot acknowledge early', async () => {
  const finished = [];
  const playback = new SpeechPlayback({ playAudio: async () => {}, onFinished: id => finished.push(id) });
  playback.handle({ type: 'speech_start', speechId: 'current' });
  playback.handle({ type: 'audio_output', speechId: 'current', data: 'audio' });
  playback.handle({ type: 'audio_end', speechId: 'current' });
  await playback.chain;
  playback.handle({ type: 'amika_replied', speechId: 'current', text: 'Log only' });
  assert.deepEqual(finished, []);
  playback.handle({ type: 'speech_end', speechId: 'old', ok: true });
  assert.deepEqual(finished, []);
  playback.handle({ type: 'speech_end', speechId: 'current', ok: true });
  playback.handle({ type: 'speech_end', speechId: 'current', ok: true });
  assert.deepEqual(finished, ['current']);
});

test('disconnection releases an ended speech and its queued caption immediately', async () => {
  const h = harness(async function* () { yield Buffer.from('audio'); });
  await h.controller.play({ text: 'initial' });
  const caption = h.controller.play({ text: 'caption', deferred: true });
  h.controller.unregister(h.socket);
  assert.equal((await caption).speechId, null);
  assert.equal(h.controller.activeSpeech, null);
  h.playback.reset();
  h.playbackGate.resolve();
  await h.playback.chain;
});

test('broadcast speech waits for every recipient and ignores duplicate acknowledgments', async () => {
  const controller = new SpeechController({
    generateSpeech: async function* () { yield Buffer.from('audio'); },
    isVoiceConfigured: () => true,
  });
  const first = {};
  const second = {};
  controller.register(first, () => {});
  controller.register(second, () => {});
  const speech = await controller.play({ text: 'broadcast' });
  assert.equal(controller.acknowledge(first, speech.speechId), true);
  assert.equal(controller.acknowledge(first, speech.speechId), false);
  assert.ok(controller.activeSpeech);
  assert.equal(controller.acknowledge(second, speech.speechId), true);
  assert.equal(controller.activeSpeech, null);
  controller.unregister(first);
  controller.unregister(second);
});
