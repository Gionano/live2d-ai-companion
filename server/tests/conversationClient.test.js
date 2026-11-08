import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationReadiness } from '../../src/conversationReadiness.js';
import { ReplyParts } from '../../src/replyParts.js';
import { scheduleAudioBuffer } from '../../src/audioClock.js';
import { migrateConversationDefaults } from '../../src/conversationDefaults.js';
import { resolveSlot } from '../providers/config.js';
import { emptySettings, validateDocument } from '../settings/schema.js';

test('readiness reports audio unlock without a first message and resends after reconnect', () => {
  const sent = [];
  const readiness = new ConversationReadiness(message => sent.push(message));
  readiness.connected();
  assert.deepEqual(sent, [{ type: 'conversation_ready', audioReady: false }]);
  readiness.setAudioReady(true);
  readiness.setAudioReady(true);
  assert.equal(sent.length, 2);
  readiness.disconnected();
  readiness.setAudioReady(false);
  assert.equal(sent.length, 2);
  readiness.connected();
  assert.equal(sent.at(-1).audioReady, false);
  readiness.setAudioReady(true);
  assert.equal(sent.at(-1).audioReady, true);
});

test('stages stream into separate bubbles and do not duplicate on final completion', () => {
  const bubbles = [];
  const parts = new ReplyParts({ create: stage => {
    const node = { stage }; bubbles.push(node); return node;
  }, update: (node, text) => { node.text = text; } });
  const event = (stage, status, text) => ({ type: 'reply_part', turnId: 'turn', partId: stage, stage, status, text });
  parts.handle(event('surface', 'start', ''));
  assert.equal(bubbles.length, 0);
  parts.handle(event('surface', 'delta', 'Aku dengar.'));
  parts.handle(event('surface', 'done', 'Aku dengar.'));
  parts.handle(event('deep', 'delta', 'Kamu terlihat'));
  parts.handle(event('deep', 'delta', ' lelah.'));
  parts.handle(event('deep', 'done', 'Kamu terlihat lelah.'));
  parts.handle(event('deep', 'done', 'DUPLICATE'));
  assert.deepEqual(bubbles.map(node => node.text), ['Aku dengar.', 'Kamu terlihat lelah.']);
  assert.equal(parts.hasDisplayed('turn'), true);
  assert.equal(parts.hasDisplayed('legacy-turn'), false);
  assert.equal(parts.handle({ type: 'amika_replied', text: 'Legacy.' }), false);
  parts.cancel('turn');
  parts.handle({ ...event('deep', 'delta', 'STALE'), partId: 'new' });
  assert.equal(bubbles.length, 2);
});

function audioContext() {
  const sources = [];
  return { currentTime: 10, sampleRate: 1000, sources,
    createBuffer: (channels, frames, rate) => ({ duration: frames / rate }),
    createBufferSource: () => {
      const source = { stopped: false, disconnected: false,
        connect() {}, start(at) { this.startAt = at; },
        stop() { this.stopped = true; }, disconnect() { this.disconnected = true; } };
      sources.push(source); return source;
    },
  };
}

test('the final sentence pause completes on the audio clock, not voice end', async () => {
  const context = audioContext();
  const scheduled = scheduleAudioBuffer(context, { duration: 2 }, { destination: {}, pauseAfterMs: 200 });
  assert.equal(scheduled.startAt, 10);
  assert.equal(scheduled.endAt, 12);
  assert.equal(scheduled.finishedAt, 12.2);
  assert.equal(context.sources[1].startAt, 12);
  let finished = false;
  scheduled.done.then(() => { finished = true; });
  context.sources[0].onended?.();
  await Promise.resolve();
  assert.equal(finished, false);
  context.sources[1].onended();
  await scheduled.done;
  assert.equal(finished, true);
  assert.ok(context.sources.every(source => source.disconnected));
});

test('segment excess and prior sentence pause produce the greater gap and cancel both sources', async () => {
  const context = audioContext();
  const controller = new AbortController();
  const scheduled = scheduleAudioBuffer(context, { duration: 2 }, {
    destination: {}, earliestStart: 12.2, pauseBeforeMs: 100, pauseAfterMs: 200, signal: controller.signal,
  });
  assert.equal(scheduled.startAt, 12.299999999999999);
  assert.ok(Math.abs(scheduled.startAt - 12 - 0.3) < 1e-9);
  controller.abort();
  await scheduled.done;
  assert.ok(context.sources.every(source => source.stopped && source.disconnected));
});

test('legacy quiet defaults migrate once and preserve custom delays', () => {
  const config = { conversation: { proactiveDelaySeconds: { value: 60, default: 60 } } };
  assert.deepEqual(migrateConversationDefaults(config).conversation.proactiveDelaySeconds, { value: 30, default: 30 });
  assert.equal(config.conversation.proactiveDelaySeconds.value, 60);
  config.conversation.proactiveDelaySeconds.value = 75;
  assert.equal(migrateConversationDefaults(config).conversation.proactiveDelaySeconds.value, 75);
  config.conversation.proactiveDelaySeconds.default = 30;
  config.conversation.proactiveDelaySeconds.value = 60;
  assert.equal(migrateConversationDefaults(config).conversation.proactiveDelaySeconds.value, 60);
});

test('new conversation roles follow chat for legacy configs and can be explicitly unassigned', () => {
  const llm = { profile: 'local', model: 'chat' };
  const config = { slots: { llm, surface: { followLlm: true } } };
  assert.equal(resolveSlot(config, 'surface'), llm);
  assert.equal(resolveSlot(config, 'reflection'), llm);
  config.slots.reflection = null;
  assert.equal(resolveSlot(config, 'reflection'), null);
  const document = emptySettings();
  delete document.version;
  document.slots = { surface: { followLlm: true }, reflection: { followLlm: true },
    tts: { profile: 'voice', model: 'fish', params: { expression: { sentencePauseMs: 200 } } } };
  assert.equal(validateDocument(document).slots.tts.params.expression.sentencePauseMs, 200);
  document.slots.tts.params.expression.sentencePauseMs = 401;
  assert.throws(() => validateDocument(document));
});
