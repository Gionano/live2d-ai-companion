import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SpeechController } from '../../speechController.js';
import { SpeechPlayback, TurnState } from '../../../src/speechPlayback.js';
import { planSelfie } from '../planner.js';
import { prepareSelfieJob } from '../backendLifecycle.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function tick() {
  await new Promise(resolve => setImmediate(resolve));
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
  const source = fs.readFileSync(new URL('../../index.js', import.meta.url), 'utf8');
  const start = source.indexOf("    if (msg.type !== 'audio_input' && msg.type !== 'text_input') return;");
  const end = source.indexOf('\n  });\n});', start);
  assert.ok(start >= 0 && end > start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('socket', 'speechController', 'transcribeAudio', 'generateReplyStream',
    'history', 'msg', 'extFromMime', 'detectSelfieIntent', 'detectVisionIntent',
    'markConversationActivity', 'HISTORY_MESSAGE_LIMIT', 'memoryManager', source.slice(start, end));
  const history = [];
  return msg => run(socket, controller, transcribeAudio, generateReplyStream, history, msg,
    () => 'webm', () => ({ isSelfie: false }), () => false, () => {}, 20,
    { recordTurnAndExtract() {} });
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
  const llmClient = { chat: { completions: { create: async (body, { signal }) => {
    plannerSignal = signal;
    signal.addEventListener('abort', () => paused.reject(signal.reason), { once: true });
    entered.resolve();
    return paused.promise;
  } } } };
  const request = prepareSelfieJob({ manager, planner: args => planSelfie({ ...args, llmClient }),
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
