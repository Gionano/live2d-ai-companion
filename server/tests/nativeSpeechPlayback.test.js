import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SpeechController } from '../speechController.js';
import { generateSpeech } from '../ttsGenerate.js';
import { generateReplyStream } from '../llmChat.js';
import { playConversationReply } from '../conversationSpeech.js';
import { prepareTtsText } from '../ttsExpression.js';
import { fixture, ADAPTER_CASES, collect, SECRET } from './providerFixtures.js';

const fish = ADAPTER_CASES.find(item => item.id === 'fishAudio');
const textFrames = state => state.frames.filter(frame => frame.event === 'text').map(frame => frame.text);

function speechHarness(t, generate, options = {}) {
  const events = [];
  const controller = new SpeechController({ generateSpeech: generate, isVoiceConfigured: () => true,
    safetyTimeoutMs: 2000, ...options });
  const socket = {};
  controller.register(socket, event => events.push(event));
  t.after(() => controller.unregister(socket));
  return { controller, socket, events };
}

test('native play sends Fish prefixes and keeps caption and avatar events unchanged', async t => {
  const { adapter, state } = await fixture(t, fish, { adapterOptions: {
    params: { expression: { mergeShortSentences: { enabled: false } } },
  } });
  const registry = { getSlotStatus: () => ({ available: true }), getTts: () => adapter };
  const h = speechHarness(t, (text, emotion, options) => generateSpeech(text, emotion, { ...options, registry }));
  await h.controller.play({ text: '[sad] Aku di sini. (angry) Tenang, ya!', emotion: 'sayang', speechEmotion: 'compassionate' });
  assert.deepEqual(textFrames(state), ['[compassionate] Aku di sini.', '[compassionate] Tenang, ya!']);
  const caption = h.events.find(event => event.type === 'amika_replied');
  assert.equal(caption.emotion, 'sayang');
  assert.doesNotMatch(caption.text, /\[|\]|\(angry\)/);
  assert.ok(h.events.filter(event => event.type === 'emotion').every(event => event.emotion === 'sayang'));
  assert.ok(h.events.every(event => !Object.hasOwn(event, 'speechEmotion')));
});

test('say keeps its third callback and snapshots fourth-argument speech options', async t => {
  const { adapter, state } = await fixture(t, fish);
  const registry = { getSlotStatus: () => ({ available: true }), getTts: () => adapter };
  const h = speechHarness(t, (text, emotion, options) => generateSpeech(text, emotion, { ...options, registry }));
  let chunks = 0;
  const options = { speechEmotion: 'compassionate' };
  await h.controller.play({ emotion: 'sayang', speechEmotion: 'nostalgic', produce: async ({ say }) => {
    const first = say('Aku di sini.', 'sayang', () => { chunks++; }, options);
    options.speechEmotion = 'angry';
    await first;
    await say('Tenang, ya!', 'sayang', () => { chunks++; }, { speechEmotion: 'compassionate' });
    await say('Pilihan lama.', 'sayang', () => {}, { speechEmotion: 'unknown' });
    await say('Aku teringat.', 'sayang');
  } });
  assert.equal(chunks, 4);
  assert.deepEqual(textFrames(state), ['[compassionate] Aku di sini.', '[compassionate] Tenang, ya!',
    '[empathetic] Pilihan lama.', '[nostalgic] Aku teringat.']);
});

test('manual overrides precede native choices and mapped mode uses the existing map', async t => {
  const { adapter, state } = await fixture(t, fish, { adapterOptions: {
    params: { expression: { emotionTagMap: { sayang: '[grateful]' } } },
  } });
  const base = { text: 'Aku di sini!', emotion: 'sayang', speechEmotion: 'compassionate' };
  await collect(adapter.stream(base));
  await collect(adapter.stream({ ...base, tag: '[delighted]' }));
  await collect(adapter.stream({ ...base, tag: '' }));
  await collect(adapter.stream({ ...base, expression: { selection: 'mapped' } }));
  await collect(adapter.stream({ ...base, expression: { selection: 'mapped' }, tag: '[calm]' }));
  assert.deepEqual(textFrames(state), ['[compassionate] Aku di sini!', '[delighted] Aku di sini!',
    'Aku di sini!', '[grateful] Aku di sini!', '[calm] Aku di sini!']);
});

test('native placement honors merged lexical sentences and cumulative first-only indexes', async t => {
  const { adapter, state } = await fixture(t, fish, { adapterOptions: {
    params: { expression: { tagPlacement: 'first-only', mergeShortSentences: { minChars: 10, maxChars: 40 } } },
  } });
  const registry = { getSlotStatus: () => ({ available: true }), getTts: () => adapter };
  const h = speechHarness(t, (text, emotion, options) => generateSpeech(text, emotion, { ...options, registry }));
  await h.controller.play({ speechEmotion: 'confident', produce: async ({ say }) => {
    await say('Ya! Baiklah.');
    await say('Aku akan segera kembali ke sini.');
  } });
  assert.deepEqual(textFrames(state), ['[confident] Ya! Baiklah.', 'Aku akan segera kembali ke sini.']);
  h.controller.acknowledge(h.socket, h.events.find(event => event.type === 'speech_start').speechId);
  await h.controller.play({ text: 'Balasan baru.', speechEmotion: 'hopeful' });
  assert.equal(textFrames(state).at(-1), '[hopeful] Balasan baru.');
});

test('native tags share the existing cap with allow-listed inline cues', () => {
  const params = { inlineTags: { enabled: true, allowList: ['laughs', 'sigh'], maxPerSentence: 2 } };
  for (const cap of [0, 1, 2]) {
    const value = prepareTtsText('(sad) [unknown] Halo [laughs] [sigh] sayang! Aku baik.', 'sayang',
      { ...params, expression: { maxTagsPerSentence: cap } }, 0, undefined, 'delighted');
    assert.equal(value, [
      'Halo sayang! Aku baik.',
      '[delighted] Halo sayang! [delighted] Aku baik.',
      '[delighted] [laughs] Halo sayang! [delighted] Aku baik.',
    ][cap]);
    assert.doesNotMatch(value, /unknown|\(sad\)/);
  }
});

test('invalid native metadata falls back without interpreting arbitrary tags', async t => {
  const { adapter, state } = await fixture(t, fish);
  for (const speechEmotion of [undefined, null, 'Compassionate', '[compassionate]', 'unknown', ['sad'], { name: 'sad' }]) {
    await collect(adapter.stream({ text: 'Halo!', emotion: 'sayang', speechEmotion }));
  }
  assert.ok(textFrames(state).every(text => text === '[empathetic] Halo!'));
});

test('cancellation drops stale queued choices and another client retains its own choice', async t => {
  const calls = [];
  const h = speechHarness(t, async function* (text, emotion, options) {
    calls.push({ text, emotion, speechEmotion: options.speechEmotion });
    if (text === 'Old reply.') {
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      yield Buffer.from('late cancelled audio');
    }
  });
  const other = {};
  h.controller.register(other, event => h.events.push(event));
  t.after(() => h.controller.unregister(other));
  const oldTurn = h.controller.beginTurn(h.socket);
  const old = h.controller.play({ text: 'Old reply.', emotion: 'sayang', speechEmotion: 'angry',
    recipients: [h.socket], turnId: oldTurn.turnId });
  const stale = h.controller.play({ text: 'Stale sentence.', speechEmotion: 'sad',
    recipients: [h.socket], turnId: oldTurn.turnId });
  const otherTurn = h.controller.beginTurn(other);
  const next = h.controller.play({ text: 'Other reply.', emotion: 'kagum', speechEmotion: 'hopeful',
    recipients: [other], turnId: otherTurn.turnId });
  assert.equal(h.controller.cancelTurn(h.socket, oldTurn.turnId), true);
  assert.equal((await old).ok, false);
  assert.equal((await stale).ok, false);
  assert.equal((await next).ok, true);
  h.controller.completeTurn(other, otherTurn.turnId);
  const newTurn = h.controller.beginTurn(h.socket);
  await h.controller.play({ text: 'Fixed message.', recipients: [h.socket], turnId: newTurn.turnId });
  h.controller.completeTurn(h.socket, newTurn.turnId);
  assert.deepEqual(calls, [
    { text: 'Old reply.', emotion: 'sayang', speechEmotion: 'angry' },
    { text: 'Other reply.', emotion: 'kagum', speechEmotion: 'hopeful' },
    { text: 'Fixed message.', emotion: 'sayang', speechEmotion: undefined },
  ]);
  assert.equal(h.events.some(event => event.type === 'audio_output'), false);
});

test('queued play snapshots metadata before a previous speech finishes', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const h = speechHarness(t, async function* (text, _emotion, options) {
    calls.push([text, options.speechEmotion]);
    if (text === 'First.') await gate;
  });
  const first = h.controller.play({ text: 'First.', speechEmotion: 'calm' });
  const item = { text: 'Queued.', speechEmotion: 'confident' };
  const queued = h.controller.play(item);
  item.speechEmotion = 'angry';
  release();
  await Promise.all([first, queued]);
  assert.deepEqual(calls, [['First.', 'calm'], ['Queued.', 'confident']]);
});

test('native debug logs only safe canonical metadata and never credentials or audio', async t => {
  const records = [];
  t.mock.method(console, 'log', (...args) => records.push(args));
  const { adapter } = await fixture(t, fish, { adapterOptions: { params: { debug: true } } });
  await collect(adapter.stream({ text: `Aku di sini! ${SECRET}`, emotion: 'sayang', speechEmotion: 'compassionate' }));
  await collect(adapter.stream({ text: 'Halo!', emotion: 'sayang', speechEmotion: `invalid-${SECRET}` }));
  const debug = records.filter(record => record[0] === '[tts:debug]').map(record => JSON.parse(record[1]));
  assert.equal(debug.length, 2);
  assert.equal(debug[0].speechEmotion, 'compassionate');
  assert.ok(debug[0].text.startsWith('[compassionate]'));
  assert.equal(debug[1].speechEmotion, undefined);
  const logged = JSON.stringify(debug);
  assert.doesNotMatch(logged, new RegExp(SECRET));
  assert.doesNotMatch(logged, /"audio"|"data"|SGFsbyA=|c2F5YW5nLg==/);
});

test('actual chat handler forwards each queued sentence choice into say options', async t => {
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
  const calls = [];
  const h = speechHarness(t, async function* (text, emotion, options) {
    calls.push([text, emotion, options.speechEmotion]);
  });
  const history = [];
  for (const speechEmotion of ['compassionate', 'nostalgic']) {
    const registry = { getSlotStatus: role => ({ available: role !== 'surface' }), getTts: () => ({ params: {
      expression: { mergeShortSentences: { enabled: false } },
    } }), getLlm: () => ({ async *stream() {
      yield { type: 'text', delta: JSON.stringify({ emotion: 'sayang', speechEmotion, text: 'Aku di sini. Tenang, ya!' }) };
    } }) };
    await run(h.socket, h.controller, () => {}, options =>
      playConversationReply({ ...options, registry }), history,
    { type: 'text_input', text: 'Halo' }, () => 'webm', () => ({ isSelfie: false }), { route: async () => ({ sources: [] }) },
    () => {}, 8, { recordTurnAndExtract() {} }, () => ({ available: true }),
    { updateSettings() {}, setUserActive() {}, consumeGuidance: () => ({}) },
    { getConversationContext: () => null, getRoutingObservations: () => [], getSourceSnapshot: () => ({}),
      setAssistantContext() {}, conversationActivity() {} }, new Map(),
      { context: () => null }, history => history);
  }
  assert.deepEqual(calls, [['Aku di sini.', 'sayang', 'compassionate'], ['Tenang, ya!', 'sayang', 'compassionate'],
    ['Aku di sini.', 'sayang', 'nostalgic'], ['Tenang, ya!', 'sayang', 'nostalgic']]);
  assert.ok(h.events.filter(event => event.type === 'emotion').every(event => event.emotion === 'sayang'));
  assert.equal(h.events.some(event => event.type === 'error'), false);
  assert.equal(history.filter(turn => turn.role === 'assistant').length, 2);
  assert.ok(history.filter(turn => turn.role === 'assistant').every(turn => turn.content === 'Aku di sini. Tenang, ya!'));
});
