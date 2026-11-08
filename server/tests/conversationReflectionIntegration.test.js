import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ProactiveConversation, proactiveSpeechInstruction } from '../proactiveConversation.js';
import { SpeechController } from '../speechController.js';
import { playConversationReply } from '../conversationSpeech.js';
import { generateConversationReply } from '../conversationCoordinator.js';
import { ConversationReadiness } from '../../src/conversationReadiness.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.ok(predicate(), 'Expected the asynchronous speech pipeline to reach its milestone');
}

function coordinator({ text = 'Aku lanjutkan cerita kita.', reflectionRequest = null, hold = null } = {}) {
  return async function* (history, userMessage, vision, options) {
    const partId = `${options.partIdPrefix}deep`;
    yield { type: 'reply_part', stage: 'deep', partId, status: 'start', text: '' };
    if (hold) await hold;
    yield { type: 'reply_part', stage: 'deep', partId, status: 'delta', text };
    yield { type: 'delta', text };
    yield { type: 'sentence', stage: 'deep', partId, segmentId: `${partId}:1`, text,
      emotion: 'sayang', speechEmotion: 'empathetic', register: 'intimate', pauseBeforeMs: 0, pauseAfterMs: 200 };
    yield { type: 'reply_part', stage: 'deep', partId, status: 'done', text };
    yield { type: 'conversation_done', text, emotion: 'sayang', reflectionRequest };
  };
}

function harness(t, options = {}) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const events = [];
  const releases = [];
  const requests = [];
  const modelRequests = [];
  const generated = [];
  const histories = new Map();
  const responses = [...(options.responses ?? [{ action: 'SPEAK', topic: 'A relevant continuation', cue: 'Continue our shared topic.' }])];
  let scheduler;
  const controller = new SpeechController({ safetyTimeoutMs: 10000, isVoiceConfigured: () => true,
    generateSpeech: async function* (text, emotion, callbacks) {
      callbacks.onAudioFormat('mp3');
      if (!options.noAudio) yield Buffer.from('mock audio');
      callbacks.onAudioEnd();
    },
    onPlaybackReleased: value => {
      releases.push(value);
      for (const socket of value.recipients) scheduler.playbackCompleted(socket, value);
    },
  });
  const registry = { getSlotStatus: () => ({ available: true }), getTts: () => ({ params: {} }), getLlm: role => ({
    complete: async request => {
      requests.push({ role, ...request });
      const response = responses.shift() ?? { action: 'SKIP' };
      return response?.promise ? response.promise : { text: JSON.stringify(response) };
    },
    async *stream(request) {
      modelRequests.push({ role, ...request });
      yield { type: 'text', delta: JSON.stringify(options.realConversationPayloads[role]) };
    },
  }) };
  scheduler = new ProactiveConversation({ enabled: true, delaySeconds: 30, clock: () => now,
    setTimer: (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, ms, at: now + ms }); return id; },
    clearTimer: id => timers.delete(id),
    registry,
  });
  function register(socket) {
    const history = [{ role: 'user', content: 'Aku selesai bekerja.' }];
    histories.set(socket, history);
    controller.register(socket, event => {
      events.push({ socket, ...event });
      if (options.autoAcknowledge && event.type === 'speech_end') {
        queueMicrotask(() => controller.acknowledge(socket, event.speechId));
      }
    });
    scheduler.register(socket, {
      history: () => history, getVisionContext: () => 'Layar: editor kode terbuka.',
      isBusy: () => socket.userInputActive || controller.isBusy(socket)
        || Boolean(controller.activeSpeech) || controller.queue.length > 0,
      onCancel: ({ reason }) => controller.cancelProactive(socket, { drain: reason !== 'user_activity' }),
      onSpeak: async ({ topic, cue, reason, signal, visionContext }) => {
        const turn = controller.beginTurn(socket, { origin: 'proactive' });
        if (!turn || signal.aborted) return { ok: false };
        const abort = () => controller.cancelProactive(socket, { drain: false });
        signal.addEventListener('abort', abort, { once: true });
        try {
          const generate = options.generate ?? (options.realConversationPayloads ? generateConversationReply
            : coordinator({ reflectionRequest: options.reflectionRequest }));
          const result = await playConversationReply({ controller, socket, turnId: turn.turnId,
            history, userMessage: null, vision: visionContext, origin: 'proactive',
            guidance: () => scheduler.consumeGuidance(socket), internalInstruction: proactiveSpeechInstruction({ reason, topic, cue }),
            registry,
            generate: async function* (...args) {
              generated.push({ socket, history: args[0], userMessage: args[1], vision: args[2], options: args[3] });
              yield* generate(...args);
            },
          });
          if (options.afterGeneration) await options.afterGeneration.promise;
          if (signal.aborted || !controller.isCurrentTurn(socket, turn.turnId) || !result.text.trim()) return { ok: false };
          history.push({ role: 'assistant', content: result.text });
          if (result.reflectionRequest) scheduler.requestReflection(socket,
            { request: result.reflectionRequest, turnId: turn.turnId, speechId: result.speechId });
          return { ...result, ok: result.ok !== false };
        } finally {
          signal.removeEventListener('abort', abort);
          controller.completeTurn(socket, turn.turnId);
        }
      },
    });
    scheduler.setReady(socket, true);
  }
  const socket = {};
  register(socket);
  t.after(() => {
    scheduler.dispose();
    for (const target of histories.keys()) controller.unregister(target);
  });
  async function ordinary(text = 'Aku sedang istirahat.', reflectionRequest = 'Continue with less pressure.') {
    scheduler.userActivity(socket);
    const history = histories.get(socket);
    const turn = controller.beginTurn(socket);
    assert.ok(turn);
    try {
      const result = await playConversationReply({ controller, socket, turnId: turn.turnId, history,
        userMessage: text, vision: null, registry, generate: options.realConversationPayloads ? generateConversationReply
          : coordinator({ text: 'Istirahat sebentar dulu.', reflectionRequest }) });
      history.push({ role: 'user', content: text }, { role: 'assistant', content: result.text });
      if (result.reflectionRequest) scheduler.requestReflection(socket,
        { request: result.reflectionRequest, turnId: turn.turnId, speechId: result.speechId });
      return { ...result, turnId: turn.turnId };
    } finally { controller.completeTurn(socket, turn.turnId); }
  }
  return { scheduler, controller, socket, histories, events, releases, requests, modelRequests, generated, timers, register, ordinary,
    advance: ms => { now += ms; } };
}

test('ordinary deep reflection waits for final playback acknowledgment, then speaks under one new proactive turn', async t => {
  const h = harness(t);
  const ordinary = await h.ordinary();
  assert.equal(h.controller.activeSpeech.speechId, ordinary.speechId);
  assert.equal(h.scheduler.getStatus(h.socket).reflectionPending, true);
  h.advance(90000);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  assert.equal(h.requests.length, 0);
  assert.equal(h.controller.acknowledge(h.socket, ordinary.speechId), true);
  assert.equal(h.releases[0].reason, 'acknowledged');
  assert.equal((await h.scheduler.check()).action, 'SPEAK');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].role, 'reflection');
  assert.equal(JSON.parse(h.requests[0].messages[1].content).trigger, 'reflection');
  const starts = h.events.filter(event => event.type === 'speech_start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].origin, 'proactive');
  assert.notEqual(starts[0].turnId, starts[1].turnId);
  assert.notEqual(starts[0].speechId, starts[1].speechId);
  const activeEvents = h.events.filter(event => event.speechId === starts[1].speechId);
  assert.equal(new Set(activeEvents.map(event => event.turnId)).size, 1);
  assert.equal(activeEvents.find(event => event.type === 'audio_end').pauseAfterMs, 200);
  assert.deepEqual(h.histories.get(h.socket).map(message => message.role), ['user', 'user', 'assistant', 'assistant']);
  assert.equal(h.generated[0].userMessage, null);
  assert.equal(h.generated[0].options.skipSurface, true);
  assert.equal(h.histories.get(h.socket).some(message => message.content.includes('Continue our shared topic')), false);
});

test('ACK arriving before the ordinary generation promise resumes still enables its requested reflection', async t => {
  const h = harness(t, { autoAcknowledge: true, responses: [{ action: 'GUIDE', hint: 'Let the pause breathe.' }] });
  const ordinary = await h.ordinary();
  assert.equal(h.controller.activeSpeech, null);
  assert.equal(h.releases[0].speechId, ordinary.speechId);
  assert.equal(h.scheduler.getStatus(h.socket).reflectionPending, true);
  assert.equal((await h.scheduler.check()).action, 'GUIDE');
  assert.equal(h.scheduler.getGuidance(h.socket).hint, 'Let the pause breathe.');
  assert.equal(h.events.filter(event => event.type === 'speech_start').length, 1);
});

test('early proactive ACK before onSpeak returns does not wedge the active attempt or lose the next reflection', async t => {
  const held = deferred();
  const h = harness(t, { afterGeneration: held, reflectionRequest: 'Help finish the thought.', responses: [
    { action: 'SPEAK', topic: 'Our shared topic', cue: 'Continue naturally.' },
    { action: 'GUIDE', plan: ['Allow the listener to answer.'] },
  ] });
  h.advance(30000);
  const checking = h.scheduler.check();
  await until(() => h.controller.activeSpeech?.ended);
  const speechId = h.controller.activeSpeech.speechId;
  assert.equal(h.scheduler.activeAttempt.finished, false);
  assert.equal(h.controller.acknowledge(h.socket, speechId), true);
  assert.equal(h.scheduler.activeAttempt.playbackDone, true);
  assert.equal(h.scheduler.getStatus(h.socket).unanswered, 1);
  assert.equal(h.histories.get(h.socket).length, 1, 'The pending internal cue is never inserted as a user turn');
  held.resolve();
  assert.equal((await checking).action, 'SPEAK');
  assert.equal(h.scheduler.activeAttempt, null);
  assert.equal(h.scheduler.getStatus(h.socket).reflectionPending, true);
  assert.equal((await h.scheduler.check()).action, 'GUIDE');
  assert.deepEqual(h.scheduler.getGuidance(h.socket).plan, ['Allow the listener to answer.']);
});

test('delayed proactive ACK keeps both idle and requested reflection pending until all playback is released', async t => {
  const h = harness(t, { reflectionRequest: 'Help finish the thought.', responses: [
    { action: 'SPEAK', topic: 'Our shared topic', cue: 'Continue naturally.' },
    { action: 'SPEAK', topic: 'A final gentle observation', cue: 'Add one relevant observation.' },
  ] });
  h.advance(30000);
  const first = await h.scheduler.check();
  assert.equal(first.action, 'SPEAK');
  assert.equal(h.scheduler.activeAttempt.waitingPlayback, true);
  h.advance(120000);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  assert.equal(h.requests.length, 1);
  assert.equal(h.controller.acknowledge(h.socket, first.speechId), true);
  const second = await h.scheduler.check();
  assert.equal(second.action, 'SPEAK');
  assert.equal(h.controller.acknowledge(h.socket, second.speechId), true);
  assert.equal(h.scheduler.getStatus(h.socket).unanswered, 2);
  assert.equal(h.scheduler.getStatus(h.socket).reflectionPending, false);
  h.advance(120000);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  assert.equal(h.requests.length, 2);
  assert.equal(h.histories.get(h.socket).filter(message => message.role === 'user').length, 1);
});

test('no-audio release does not trigger a pending follow-up or restart automatic attempts', async t => {
  const h = harness(t, { noAudio: true, reflectionRequest: 'Do not speak after failed audio.' });
  h.advance(30000);
  const result = await h.scheduler.check();
  assert.equal(result.action, 'SPEAK');
  assert.equal(h.controller.activeSpeech, null);
  assert.equal(h.releases[0].reason, 'no_audio');
  assert.equal(h.scheduler.getStatus(h.socket).reason, 'no_audio');
  assert.equal(h.scheduler.getStatus(h.socket).reflectionPending, false);
  h.advance(300000);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  assert.equal(h.requests.length, 1);
});

test('typing cancels a pending normal deep reflection without replacing it with an invented user turn', async t => {
  const h = harness(t);
  const result = await h.ordinary();
  h.socket.userInputActive = true;
  h.scheduler.setUserActive(h.socket, true);
  assert.equal(h.scheduler.getStatus(h.socket).reflectionPending, false);
  assert.equal(h.controller.acknowledge(h.socket, result.speechId), true);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.histories.get(h.socket).map(message => message.role), ['user', 'user', 'assistant']);
});

test('user activity aborts in-flight proactive generation and ignores coordinator output after cancellation', async t => {
  const hold = deferred();
  const h = harness(t, { generate: coordinator({ text: 'An obsolete reply.', hold: hold.promise }) });
  h.advance(30000);
  const checking = h.scheduler.check();
  await until(() => h.events.some(event => event.type === 'reply_part' && event.status === 'start'));
  const speechId = h.controller.activeSpeech.speechId;
  h.socket.userInputActive = true;
  h.scheduler.setUserActive(h.socket, true);
  assert.equal((await checking).action, 'CANCELLED');
  assert.equal(h.controller.activeSpeech, null);
  assert.ok(h.events.some(event => event.type === 'stop_speech' && event.speechId === speechId));
  hold.resolve();
  await until(() => h.controller.sessions.get(h.socket).turn === null);
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.equal(h.events.some(event => event.type === 'amika_replied'), false);
  assert.equal(h.events.some(event => event.type === 'audio_output'), false);
  assert.equal(h.histories.get(h.socket).length, 1);
  assert.equal(h.controller.acknowledge(h.socket, speechId), false);
});

test('a newly ready client takes ownership and cancels the older client awaiting playback', async t => {
  const h = harness(t, { responses: [
    { action: 'SPEAK', topic: 'First client conversation', cue: 'A first comment.' },
    { action: 'SPEAK', topic: 'Second client conversation', cue: 'A second comment.' },
  ] });
  h.advance(30000);
  const first = await h.scheduler.check();
  const other = {};
  h.register(other);
  assert.equal(h.scheduler.latestSession, other);
  assert.equal(h.controller.activeSpeech, null);
  assert.equal(h.controller.acknowledge(h.socket, first.speechId), false);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  h.advance(30000);
  assert.equal((await h.scheduler.check()).action, 'SPEAK');
  assert.equal(h.generated.at(-1).socket, other);
  assert.equal(h.histories.get(other).filter(message => message.role === 'assistant').length, 1);
  assert.equal(h.histories.get(h.socket).filter(message => message.role === 'assistant').length, 1);
});

for (const phase of ['decision', 'playback']) {
  test(`actual muted client connection cannot take ownership during another client's ${phase}`, async t => {
    const response = deferred();
    const h = harness(t, { responses: phase === 'decision' ? [response]
      : [{ action: 'SPEAK', topic: 'Current conversation', cue: 'Continue our conversation.' }] });
    h.socket.proactiveEnabled = true;
    h.socket.proactiveDelaySeconds = 30;
    h.advance(30000);
    const checking = h.scheduler.check();
    await until(() => phase === 'decision' ? h.requests.length === 1 : h.scheduler.activeAttempt?.waitingPlayback);
    const originalAttempt = h.scheduler.activeAttempt;
    const originalSpeech = h.controller.activeSpeech;
    const joining = { proactiveEnabled: true, proactiveDelaySeconds: 30, userInputActive: false };
    h.scheduler.register(joining, { onSpeak: () => ({ ok: false }) });

    // Exercise the real socket handlers so initial status remains distinct from user activity.
    const backend = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const readinessStart = backend.indexOf("    if (msg.type === 'conversation_ready') {");
    const readinessHandler = backend.slice(readinessStart, backend.indexOf("    if (msg.type === 'user_activity') {", readinessStart));
    const muteStart = backend.indexOf("    if (msg.type === 'mic_mute') {");
    const muteHandler = backend.slice(muteStart, backend.indexOf('    // 0.', muteStart));
    const receiver = vm.createContext({ socket: joining, proactiveConversation: h.scheduler,
      speechController: h.controller, visionSessions: new Map([[h.socket, {}], [joining, {}]]), console: { log() {} } });
    vm.runInContext(`function receive(msg) { ${readinessHandler}\n${muteHandler}\n }`, receiver);
    const sent = [];
    class WebSocket {
      static OPEN = 1;
      constructor() { this.readyState = 1; this.handlers = new Map(); }
      addEventListener(type, callback) { this.handlers.set(type, callback); }
      send(data) { const message = JSON.parse(data); sent.push(message); receiver.receive(message); }
    }
    const browser = vm.createContext({ ws: null, WebSocket, location: { protocol: 'http:', host: 'localhost' },
      window: { desktopBridge: {} }, isMicMutedByDesktop: true,
      continuousVision: { setActive() {}, connect() {} }, isScreenActive: () => false,
      syncCaptureStatus() {}, captureAvailability: { screen: false, webcam: false },
      tuning: { get: key => key.endsWith('Enabled') ? 'on' : 30 } });
    browser.conversationReadiness = new ConversationReadiness(message => browser.ws.send(JSON.stringify(message)));
    const frontend = fs.readFileSync(new URL('../../src/companion.js', import.meta.url), 'utf8');
    const connectStart = frontend.indexOf('function connectWS() {');
    vm.runInContext(frontend.slice(connectStart, frontend.indexOf('\nconnectWS();', connectStart)), browser);
    browser.connectWS();
    browser.ws.handlers.get('open')();

    assert.deepEqual(sent.slice(0, 2), [
      { type: 'conversation_ready', audioReady: false }, { type: 'mic_mute', muted: true },
    ]);
    assert.equal(h.scheduler.latestSession, h.socket);
    assert.equal(h.scheduler.activeAttempt, originalAttempt);
    assert.equal(originalAttempt.controller.signal.aborted, false);
    assert.equal(h.controller.activeSpeech, originalSpeech);
    assert.equal(h.scheduler.getStatus(joining).audioReady, false);
    assert.equal(h.scheduler.sessions.get(joining).hasUserActivity, false);

    browser.conversationReadiness.setAudioReady(true);
    assert.equal(h.scheduler.latestSession, joining);
    assert.equal(originalAttempt.controller.signal.aborted, true);
    assert.equal(h.controller.activeSpeech, null);
    assert.equal((await checking).action, phase === 'decision' ? 'CANCELLED' : 'SPEAK');
    response.resolve({ text: JSON.stringify({ action: 'SKIP' }) });
  });
}

test('real coordinator, reflection and speech pipeline preserve staged tones and one assistant history entry', async t => {
  const h = harness(t, {
    realConversationPayloads: {
      surface: { status: 'ok', mode: 'say+think', segments: [
        { register: 'casual', emotion: 'netral', speechEmotion: 'calm', text: 'Aku dengar.' },
      ] },
      llm: { segments: [
        { register: 'intimate', emotion: 'sayang', speechEmotion: 'compassionate', text: 'Pekerjaan itu bisa menunggu.' },
      ], reflectionRequest: 'Find a gentle continuation.' },
    },
    responses: [{ action: 'SPEAK', topic: 'Give the listener more space', cue: 'Add a relevant observation.',
      hint: 'PRIVATE: do not demand another answer.', plan: ['Allow the listener to rest.'] }],
  });
  const result = await h.ordinary('Aku capek sekali.');
  assert.deepEqual(h.modelRequests.map(request => request.role), ['surface', 'llm']);
  assert.equal(h.requests.length, 0);
  assert.equal(result.text, 'Aku dengar. Pekerjaan itu bisa menunggu.');
  assert.equal(h.histories.get(h.socket).filter(message => message.role === 'assistant').length, 1);
  const parts = h.events.filter(event => event.type === 'reply_part');
  assert.deepEqual(parts.filter(event => event.status === 'done').map(event => event.stage), ['surface', 'deep']);
  assert.equal(new Set(parts.map(event => event.speechId)).size, 1);
  assert.equal(new Set(parts.map(event => event.turnId)).size, 1);
  const audioEnds = h.events.filter(event => event.type === 'audio_end');
  assert.deepEqual(audioEnds.map(event => event.register), ['casual', 'intimate']);
  assert.ok(audioEnds.every(event => event.pauseAfterMs === 200));
  assert.equal(h.controller.acknowledge(h.socket, result.speechId), true);
  assert.equal((await h.scheduler.check()).action, 'SPEAK');
  assert.deepEqual(h.modelRequests.map(request => request.role), ['surface', 'llm', 'llm']);
  assert.equal(h.generated[0].userMessage, null);
  assert.match(h.modelRequests.at(-1).messages[0].content, /PRIVATE: do not demand another answer/);
  assert.doesNotMatch(JSON.stringify(h.histories.get(h.socket)), /PRIVATE|Add a relevant observation|Find a gentle continuation/);
  assert.equal(h.histories.get(h.socket).filter(message => message.role === 'user').length, 2);
  assert.equal(h.scheduler.getGuidance(h.socket).hint, '');
  assert.deepEqual(h.scheduler.getGuidance(h.socket).plan, ['Allow the listener to rest.']);
});

test('quiet delay routes a fresh single-question invitation through both model roles without recapping history', async t => {
  const question = 'Kamu lebih suka ekspresi Amika yang kalem atau jahil?';
  const h = harness(t, { realConversationPayloads: { llm: { segments: [
    { register: 'casual', emotion: 'penasaran', speechEmotion: 'curious', text: question },
  ] } }, responses: [{ action: 'SPEAK', topic: 'Selera ekspresi avatar', cue: 'Ask about his preferred avatar mood.' }] });
  const history = h.histories.get(h.socket);
  history.splice(0, history.length,
    { role: 'user', content: 'Bank ekspresinya sudah bekerja.' },
    { role: 'assistant', content: 'Ekspresi dan simbolnya sudah selesai disiapkan.' });
  const before = structuredClone(history);
  h.advance(29999);
  assert.equal((await h.scheduler.check()).action, 'WAIT');
  h.advance(1);
  assert.equal((await h.scheduler.check()).action, 'SPEAK');
  assert.equal(JSON.parse(h.requests[0].messages[1].content).trigger, 'idle');
  assert.match(h.requests[0].messages[0].content, /exactly one short, natural question/);
  assert.match(h.requests[0].messages[0].content, /answered questions and resolved points as settled/i);
  assert.deepEqual(h.modelRequests.map(request => request.role), ['llm']);
  assert.match(h.modelRequests[0].messages[0].content, /exactly one short, natural question/);
  assert.match(h.modelRequests[0].messages[0].content, /related new angle or a fresh appropriate topic/);
  assert.equal(h.generated[0].userMessage, null);
  assert.deepEqual(history.slice(0, -1), before);
  assert.deepEqual(history.at(-1), { role: 'assistant', content: question });
  const spoken = h.events.filter(event => event.type === 'amika_replied').at(-1).text;
  assert.equal(spoken, question);
  assert.equal((spoken.match(/\?/g) ?? []).length, 1);
  assert.doesNotMatch(JSON.stringify(history), /Ask about his preferred|Private topic and cue/);
});

test('post-reply reflection uses a useful unfinished contribution without imposing a question', async t => {
  const payloads = { surface: { status: 'ok', mode: 'think', segments: [] }, llm: {
    segments: [{ register: 'casual', emotion: 'netral', speechEmotion: 'calm', text: 'Pengaturan dapat kamu simpan.' }],
    reflectionRequest: 'Explain where to save the setting if helpful.',
  } };
  const h = harness(t, { realConversationPayloads: payloads, responses: [{ action: 'SPEAK',
    topic: 'Lokasi simpan pengaturan', cue: 'Add the missing save-button location.' }] });
  const ordinary = await h.ordinary('Cara menyimpan pengaturannya?');
  payloads.llm = { segments: [{ register: 'casual', emotion: 'netral', speechEmotion: 'calm',
    text: 'Tombol Simpan ada di bagian atas panel pengaturan.' }] };
  h.controller.acknowledge(h.socket, ordinary.speechId);
  assert.equal((await h.scheduler.check()).action, 'SPEAK');
  assert.equal(JSON.parse(h.requests[0].messages[1].content).trigger, 'reflection');
  for (const request of [h.requests[0], h.modelRequests.at(-1)]) {
    assert.match(request.messages[0].content, /new, useful contribution to an unfinished point/);
    assert.match(request.messages[0].content, /A question is optional; do not force one/);
    assert.doesNotMatch(request.messages[0].content, /exactly one short, natural question/);
  }
  assert.equal(h.histories.get(h.socket).at(-1).content, 'Tombol Simpan ada di bagian atas panel pengaturan.');
});

test('a completed post-reply topic can skip without starting another reply or speaking private guidance', async t => {
  const h = harness(t, { responses: [{ action: 'SKIP' }] });
  const ordinary = await h.ordinary('Sudah selesai, terima kasih.', 'Check whether anything useful remains.');
  h.controller.acknowledge(h.socket, ordinary.speechId);
  assert.equal((await h.scheduler.check()).action, 'SKIP');
  assert.match(h.requests[0].messages[0].content, /When nothing useful remains, return SKIP or GUIDE/);
  assert.equal(h.generated.length, 0);
  assert.equal(h.events.filter(event => event.type === 'speech_start').length, 1);
  assert.doesNotMatch(JSON.stringify(h.histories.get(h.socket)), /Check whether anything useful/);
});
