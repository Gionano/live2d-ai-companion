import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { SpeechController } from '../speechController.js';

function harness(t, generateSpeech = async function* () { yield Buffer.from('audio'); }, options = {}) {
  const events = [];
  const released = [];
  const socket = {};
  const controller = new SpeechController({ generateSpeech, isVoiceConfigured: () => true,
    onPlaybackReleased: value => released.push(value), ...options });
  controller.register(socket, event => events.push(event));
  t.after(() => controller.unregister(socket));
  return { controller, socket, events, released };
}

test('release observer waits for actual acknowledgment and reports origin only once', async t => {
  const h = harness(t);
  const result = await h.controller.play({ text: 'Halo.', origin: 'proactive', recipients: [h.socket] });
  assert.equal(h.events.find(event => event.type === 'speech_start').origin, 'proactive');
  assert.deepEqual(h.released, []);
  assert.equal(h.controller.acknowledge(h.socket, result.speechId), true);
  assert.equal(h.released.length, 1);
  assert.equal(h.released[0].reason, 'acknowledged');
  assert.equal(h.released[0].origin, 'proactive');
  assert.equal(h.released[0].hasAudio, true);
  assert.deepEqual(h.released[0].recipients, [h.socket]);
  assert.equal(h.controller.acknowledge(h.socket, result.speechId), false);
  assert.equal(h.released.length, 1);
});

test('user turn preempts proactive playback after generation ended, but normal speech stays busy', async t => {
  const h = harness(t);
  const result = await h.controller.play({ text: 'Sapaan otomatis.', origin: 'proactive', recipients: [h.socket] });
  assert.ok(h.controller.activeSpeech.ended);
  const turn = h.controller.beginTurn(h.socket);
  assert.ok(turn);
  assert.equal(h.controller.activeSpeech, null);
  assert.equal(h.released[0].reason, 'cancelled');
  assert.ok(h.events.some(event => event.type === 'stop_speech' && event.speechId === result.speechId));
  assert.equal(h.controller.acknowledge(h.socket, result.speechId), false);
  h.controller.completeTurn(h.socket, turn.turnId);
  const normal = await h.controller.play({ text: 'Balasan biasa.', recipients: [h.socket] });
  assert.equal(h.controller.beginTurn(h.socket), null);
  assert.equal(h.controller.activeSpeech.speechId, normal.speechId);
  assert.equal(h.events.at(-1).type, 'input_rejected');
  h.controller.acknowledge(h.socket, normal.speechId);
});

test('takeover cancels proactive generation and does not let a queued caption overtake user input', async t => {
  let aborted = false;
  const h = harness(t, async function* (text, emotion, { signal }) {
    if (text === 'automatic') {
      await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    }
  });
  const automatic = h.controller.play({ text: 'automatic', origin: 'proactive', recipients: [h.socket] });
  const caption = h.controller.play({ text: 'caption', deferred: true, recipients: [h.socket] });
  const turn = h.controller.beginTurn(h.socket);
  assert.ok(turn);
  assert.equal(aborted, true);
  assert.equal((await automatic).ok, false);
  assert.equal(h.events.filter(event => event.type === 'speech_start').length, 1);
  h.controller.completeTurn(h.socket, turn.turnId);
  await caption;
});

test('segment metadata is snapshotted per sentence and native voice emotion reaches synthesis', async t => {
  const synthesis = [];
  const h = harness(t, async function* (text, emotion, options) {
    synthesis.push(options.speechEmotion);
    options.onAudioFormat('mp3');
    yield Buffer.from(text);
    options.onAudioEnd();
  });
  const result = await h.controller.play({ recipients: [h.socket], produce: async ({ say }) => {
    const options = { segmentId: 'one', pauseBeforeMs: 400, speechEmotion: 'excited' };
    await say('Kalimat satu.', 'kagum', () => {}, options);
    options.segmentId = 'changed';
    options.pauseBeforeMs = 900;
    options.speechEmotion = 'sad';
    await say('Kalimat dua.', 'sedih', () => {}, { segmentId: 'two', pauseBeforeMs: 250, speechEmotion: 'sad' });
  } });
  const ends = h.events.filter(event => event.type === 'audio_end');
  assert.deepEqual(ends.map(({ segmentId, pauseBeforeMs, emotion }) => ({
    segmentId, pauseBeforeMs, emotion,
  })), [
    { segmentId: 'one', pauseBeforeMs: 400, emotion: 'kagum' },
    { segmentId: 'two', pauseBeforeMs: 250, emotion: 'sedih' },
  ]);
  assert.deepEqual(synthesis, ['excited', 'sad']);
  assert.ok(h.events.every(event => !Object.hasOwn(event, 'speechEmotion')));
  h.controller.acknowledge(h.socket, result.speechId);
});

test('no audio and playback timeout release with explicit reasons', async t => {
  const empty = harness(t, async function* () {});
  await empty.controller.play({ text: 'No voice.', origin: 'proactive', recipients: [empty.socket] });
  assert.equal(empty.released[0].reason, 'no_audio');
  assert.equal(empty.released[0].hasAudio, false);
  const delayed = harness(t, undefined, { safetyTimeoutMs: 20 });
  await delayed.controller.play({ text: 'Never acknowledged.', origin: 'proactive', recipients: [delayed.socket] });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(delayed.released.length, 1);
  assert.equal(delayed.released[0].reason, 'timeout');
  assert.equal(delayed.controller.activeSpeech, null);
});

test('external source cancellation removes queued speech without stopping unrelated audio', async t => {
  const h = harness(t);
  const first = await h.controller.play({ text: 'Ordinary reply.', recipients: [h.socket] });
  const source = new AbortController();
  const caption = h.controller.play({ text: 'Stale vision comment.', origin: 'vision',
    recipients: [h.socket], deferred: true, signal: source.signal });
  assert.equal(h.controller.queue.length, 1);
  source.abort();
  assert.equal((await caption).ok, false);
  assert.equal(h.controller.queue.length, 0);
  assert.equal(h.controller.activeSpeech.speechId, first.speechId);
  assert.equal(h.events.some(event => event.type === 'stop_speech'), false);
  assert.equal(getEventListeners(source.signal, 'abort').length, 0);
  h.controller.acknowledge(h.socket, first.speechId);
});

test('external signal remains cancellable after generation completes and frees playback immediately', async t => {
  const h = harness(t);
  const source = new AbortController();
  const result = await h.controller.play({ text: 'Vision commentary.', origin: 'vision',
    recipients: [h.socket], signal: source.signal });
  assert.equal(h.controller.isBusy(h.socket), true);
  assert.equal(getEventListeners(source.signal, 'abort').length, 1);
  source.abort();
  assert.equal(h.controller.activeSpeech, null);
  assert.equal(h.controller.isBusy(h.socket), false);
  assert.equal(h.released[0].reason, 'cancelled');
  assert.equal(h.events.filter(event => event.type === 'stop_speech').length, 1);
  assert.equal(h.controller.acknowledge(h.socket, result.speechId), false);
  assert.equal(getEventListeners(source.signal, 'abort').length, 0);
});

test('queued commentary waits while user is composing before an input turn exists', async t => {
  const h = harness(t, async function* () {});
  h.socket.userInputActive = true;
  const caption = h.controller.play({ text: 'Visual caption.', origin: 'vision',
    recipients: [h.socket], deferred: true });
  assert.equal(h.controller.activeSpeech, null);
  assert.equal(h.events.some(event => event.type === 'speech_start'), false);
  h.socket.userInputActive = false;
  h.controller.drain();
  await caption;
  assert.equal(h.events.filter(event => event.type === 'speech_start').length, 1);
});
