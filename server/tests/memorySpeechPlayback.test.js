import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechController } from '../speechController.js';
import { SpeechMemoryRecorder } from '../speechMemory.js';
import { playConversationReply } from '../conversationSpeech.js';

function harness(t, { voice = true, failure = false } = {}) {
  const events = [];
  const archived = [];
  const errors = [];
  const manager = { generation: 1, archiveCompleted(event, options) {
    if (options.generation !== this.generation) throw Object.assign(new Error(), { code: 'MEMORY_STALE' });
    if (!archived.some(item => item.eventId === event.eventId)) archived.push(event);
  } };
  const recorder = new SpeechMemoryRecorder({ manager, onError: code => errors.push(code) });
  const controller = new SpeechController({ isVoiceConfigured: () => voice,
    generateSpeech: async function* (text, emotion, callbacks) {
      callbacks.onAudioFormat('mp3');
      yield Buffer.from('fixture audio');
      if (failure) throw new Error('Fixture synthesis failure');
      callbacks.onAudioEnd();
    }, onPlaybackReleased: info => recorder.released(info) });
  const socket = {};
  controller.register(socket, event => events.push(event));
  t.after(() => controller.unregister(socket));
  return { events, archived, errors, manager, recorder, controller, socket };
}

test('one combined spoken event is archived only after playback and pauses are acknowledged', async t => {
  const h = harness(t);
  const turn = h.controller.beginTurn(h.socket);
  const context = h.recorder.context({ sessionId: 'conversation-1', turnId: turn.turnId, userText: 'Aku suka Hikari.' });
  const generate = async function* () {
    yield { type: 'delta', text: 'Hikari? Aku mengerti.' };
    yield { type: 'sentence', text: '[curious] Hikari?', stage: 'surface', pauseAfterMs: 200 };
    yield { type: 'sentence', text: '[calm] Aku mengerti.', stage: 'deep', pauseAfterMs: 200 };
    yield { type: 'conversation_done', text: 'Hikari? Aku mengerti.' };
  };
  const result = await playConversationReply({ controller: h.controller, socket: h.socket, turnId: turn.turnId,
    userMessage: context.userText, history: [], memoryContext: context, generate });
  assert.equal(result.ok, true);
  assert.equal(h.archived.length, 0, 'Generation completion is not playback proof');
  h.controller.completeTurn(h.socket, turn.turnId);
  assert.equal(h.controller.acknowledge(h.socket, result.speechId), true);
  assert.equal(h.archived.length, 1);
  assert.equal(h.archived[0].assistantText, 'Hikari? Aku mengerti.');
  assert.equal(h.archived[0].userText, 'Aku suka Hikari.');
  assert.equal(h.archived[0].speechId, result.speechId);
  assert.equal(h.controller.acknowledge(h.socket, result.speechId), false);
  assert.equal(h.archived.length, 1);
  assert.equal(h.events.some(event => 'memoryContext' in event || 'spokenText' in event), false);
});

test('a completed surface surviving deep failure archives spoken text rather than unfinished display text', async t => {
  const h = harness(t);
  const turn = h.controller.beginTurn(h.socket);
  const context = h.recorder.context({ sessionId: 'one', turnId: turn.turnId, userText: 'Halo.' });
  const result = await playConversationReply({ controller: h.controller, socket: h.socket, turnId: turn.turnId,
    memoryContext: context, generate: async function* () {
      yield { type: 'delta', text: 'Halo! An unfinished claim' };
      yield { type: 'sentence', text: 'Halo!', stage: 'surface' };
      yield { type: 'stage_error', stage: 'deep' };
      yield { type: 'conversation_done', text: 'Halo! An unfinished claim' };
    } });
  h.controller.acknowledge(h.socket, result.speechId);
  assert.equal(h.archived[0].assistantText, 'Halo!');
});

for (const origin of ['proactive', 'vision']) {
  test(`${origin} archives assistant speech without private cues or fabricated user dialogue`, async t => {
    const h = harness(t);
    const context = h.recorder.context({ sessionId: 'one', origin, userText: 'private cue must never be stored' });
    const result = await h.controller.play({ text: 'Aku mau melanjutkan cerita.', recipients: [h.socket], origin,
      memoryContext: context });
    h.controller.acknowledge(h.socket, result.speechId);
    assert.equal(h.archived[0].userText, '');
    assert.equal(h.archived[0].origin, origin);
    assert.doesNotMatch(JSON.stringify(h.archived), /private cue/);
  });
}

for (const reason of ['cancelled', 'timeout', 'disconnected', 'no_audio']) {
  test(`release reason ${reason} cannot establish long-term memory`, async t => {
    const h = harness(t);
    const context = h.recorder.context({ sessionId: 'one' });
    const result = await h.controller.play({ text: 'Incomplete.', recipients: [h.socket], memoryContext: context });
    h.controller.releaseSpeech(h.controller.activeSpeech, reason);
    assert.equal(h.archived.length, 0);
    assert.equal(h.controller.acknowledge(h.socket, result.speechId), false);
  });
}

test('failed partial synthesis and text-only output cannot establish playback memory', async t => {
  for (const options of [{ failure: true }, { voice: false }]) {
    const h = harness(t, options);
    const result = await h.controller.play({ text: 'Unconfirmed.', recipients: [h.socket],
      memoryContext: h.recorder.context({ sessionId: 'one' }) });
    h.controller.acknowledge(h.socket, result.speechId);
    assert.equal(h.archived.length, 0);
  }
});

test('forgetting during pending playback rejects its old generation without delaying audio release', async t => {
  const h = harness(t);
  const result = await h.controller.play({ text: 'An old topic.', recipients: [h.socket],
    memoryContext: h.recorder.context({ sessionId: 'one' }) });
  h.manager.generation++;
  h.controller.acknowledge(h.socket, result.speechId);
  assert.equal(h.archived.length, 0);
  assert.deepEqual(h.errors, []);
  assert.equal(h.controller.activeSpeech, null);
});

test('storage errors cannot break playback acknowledgment', async t => {
  const h = harness(t);
  h.manager.archiveCompleted = () => { throw Object.assign(new Error('private content'), { code: 'MEMORY_STORAGE' }); };
  const result = await h.controller.play({ text: 'A completed reply.', recipients: [h.socket],
    memoryContext: h.recorder.context({ sessionId: 'one' }) });
  assert.equal(h.controller.acknowledge(h.socket, result.speechId), true);
  assert.deepEqual(h.errors, ['MEMORY_STORAGE']);
  assert.equal(h.controller.activeSpeech, null);
});
