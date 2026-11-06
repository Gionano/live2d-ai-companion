import test from 'node:test';
import assert from 'node:assert/strict';
import { StructuredReplyParser, generateReply, generateReplyStream, REPLY_EMOTIONS } from '../llmChat.js';
import { speechEmotionPrompt, normalizeSpeechEmotion } from '../speechEmotionPrompt.js';
import { WAIFU_SYSTEM_PROMPT } from '../personality.js';
import { FISH_EMOTION_NAMES } from '../fishEmotionTags.js';
import { generateSpeech } from '../ttsGenerate.js';
import { fixture, ADAPTER_CASES, collect } from './providerFixtures.js';

function parse(parts) {
  const parser = new StructuredReplyParser();
  return [...parts.flatMap(part => parser.push(part)), ...parser.finish()];
}

function registryFor(parts, { params = {}, available = true, tts } = {}) {
  const requests = [];
  return {
    requests,
    getSlotStatus: slot => ({ available: slot !== 'tts' || available }),
    getTts: () => available ? tts ?? { params } : null,
    getLlm: () => ({ async *stream(request) {
      requests.push(request);
      for (const delta of parts) yield { type: 'text', delta };
    } }),
  };
}

test('native speech prompt accepts exactly the 49 canonical names and preserves avatar labels', () => {
  assert.equal(FISH_EMOTION_NAMES.length, 49);
  assert.equal(REPLY_EMOTIONS.size, 12);
  for (const name of FISH_EMOTION_NAMES) {
    assert.equal(normalizeSpeechEmotion(name), name);
    assert.ok(speechEmotionPrompt().includes(name));
  }
  for (const invalid of [undefined, null, '[sad]', 'Sad', ' sad', 'unknown', ['sad'], { name: 'sad' }]) {
    assert.equal(normalizeSpeechEmotion(invalid), undefined);
  }
  assert.equal(speechEmotionPrompt({ expression: { selection: 'mapped' } }), '');
  assert.match(speechEmotionPrompt({}, 'vision'), /vision comment.*existing field/);
  assert.match(speechEmotionPrompt({}, 'selfie'), /selfie plan.*existing field/);
});

test('every split in the native header freezes one canonical choice before text', () => {
  const json = JSON.stringify({ emotion: 'sayang', speechEmotion: 'compassionate', text: 'Aku di sini. Tenang, ya!' });
  for (let offset = 0; offset <= json.length; offset++) {
    const events = parse([json.slice(0, offset), json.slice(offset)]);
    assert.deepEqual(events.filter(event => event.type === 'emotion'), [{ type: 'emotion', emotion: 'sayang' }]);
    assert.deepEqual(events.filter(event => event.type === 'speechEmotion'), [{ type: 'speechEmotion', speechEmotion: 'compassionate' }]);
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Aku di sini. Tenang, ya!');
    assert.ok(events.findIndex(event => event.type === 'speechEmotion') < events.findIndex(event => event.type === 'delta'));
  }
});

test('split Unicode escapes in header fields decode only canonical catalogue values', () => {
  const events = parse(['{"emotion":"sayang","speechEmotion":"compassio\\u00', '6eate","text":"Aku \\u00', 'e9 di sini."}']);
  assert.equal(events.find(event => event.type === 'speechEmotion').speechEmotion, 'compassionate');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Aku é di sini.');
});

for (const [name, json] of [
  ['legacy two-field JSON', '{"emotion":"sayang","text":"Halo!"}'],
  ['unknown name', '{"emotion":"sayang","speechEmotion":"invented","text":"Halo!"}'],
  ['bracketed name', '{"emotion":"sayang","speechEmotion":"[compassionate]","text":"Halo!"}'],
  ['non-string metadata', '{"emotion":"sayang","speechEmotion":{"name":"sad"},"text":"Halo!"}'],
  ['array metadata', '{"emotion":"sayang","speechEmotion":["sad"],"text":"Halo!"}'],
  ['null metadata', '{"emotion":"sayang","speechEmotion":null,"text":"Halo!"}'],
  ['late metadata', '{"emotion":"sayang","text":"Halo!","speechEmotion":"sad"}'],
]) {
  test(`${name} uses the existing avatar mapping without losing text`, async () => {
    const registry = registryFor([json], { params: { expression: { mergeShortSentences: { enabled: false } } } });
    const events = await collect(generateReplyStream([], 'Halo', null, { registry }));
    assert.deepEqual(events.filter(event => event.type === 'emotion'), [{ type: 'emotion', emotion: 'sayang' }]);
    assert.deepEqual(events.filter(event => event.type === 'sentence'), [{ type: 'sentence', text: 'Halo!' }]);
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Halo!');
  });
}

test('late and metadata-looking quoted reply text cannot change either emotion', () => {
  const text = 'Contoh: "speechEmotion":"angry", "emotion":"marah". Tetap tenang!';
  const events = parse([JSON.stringify({ text, emotion: 'marah', speechEmotion: 'angry' })]);
  assert.deepEqual(events.filter(event => event.type === 'emotion'), [{ type: 'emotion', emotion: 'netral' }]);
  assert.equal(events.some(event => event.type === 'speechEmotion'), false);
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), text);
});

test('nested header members and escaped string contents are not reply metadata', () => {
  const events = parse(['{"other":{"speechEmotion":"angry","emotion":"marah","text":"wrong"},',
    '"note":"\\\"speechEmotion\\\":\\\"sad\\\"","emotion":"sayang","text":"Halo!"}']);
  assert.deepEqual(events.filter(event => event.type === 'emotion'), [{ type: 'emotion', emotion: 'sayang' }]);
  assert.equal(events.some(event => event.type === 'speechEmotion'), false);
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Halo!');
});

test('the first native member wins over duplicate or late metadata', () => {
  const events = parse(['{"emotion":"sayang","speechEmotion":"calm",',
    '"speechEmotion":"angry","text":"Halo!","speechEmotion":"sad"}']);
  assert.deepEqual(events.filter(event => event.type === 'speechEmotion'), [{ type: 'speechEmotion', speechEmotion: 'calm' }]);
});

test('plain replies containing metadata words keep streaming without a native choice', async () => {
  const registry = registryFor(['Contoh speechEmotion: sad. ', 'Tetap tenang!']);
  const events = await collect(generateReplyStream([], 'Halo', null, { registry }));
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Contoh speechEmotion: sad. Tetap tenang!');
  assert.ok(events.filter(event => event.type === 'sentence').every(event => !Object.hasOwn(event, 'speechEmotion')));
});

test('native selection is independent of speech style and gated by TTS and selection mode', async () => {
  for (const [available, selection, enabled] of [[true, 'native', true], [true, 'native', false], [false, 'native', true], [true, 'mapped', true]]) {
    const registry = registryFor(['{"emotion":"sayang","speechEmotion":"compassionate","text":"Halo!"}'],
      { available, params: { expression: { selection }, speechStyle: { enabled } } });
    const events = await collect(generateReplyStream([], 'Halo', null, { registry }));
    const expected = available && selection === 'native';
    assert.equal(registry.requests.length, 1);
    const system = registry.requests[0].messages[0].content;
    assert.ok(system.startsWith(WAIFU_SYSTEM_PROMPT));
    assert.equal(system.includes('Speech emotion metadata:'), expected);
    assert.equal(events.find(event => event.type === 'sentence').speechEmotion, expected ? 'compassionate' : undefined);
    assert.equal(system.includes('tulis balasan untuk diucapkan dengan alami'), available && enabled);
  }
});

test('public chat output does not expose private native speech metadata', async () => {
  const registry = registryFor(['{"emotion":"sayang","speechEmotion":"compassionate","text":"Halo!"}']);
  const events = await collect(generateReply([], 'Halo', null, { registry }));
  assert.ok(events.every(event => event.type !== 'speechEmotion' && !Object.hasOwn(event, 'speechEmotion')));
  assert.deepEqual(events.filter(event => event.type === 'emotion'), [{ type: 'emotion', emotion: 'sayang' }]);
});

test('sentence streaming starts before the provider finishes and never waits for late metadata', async () => {
  let release;
  const finish = new Promise(resolve => { release = resolve; });
  const registry = registryFor([], { params: { expression: { mergeShortSentences: { enabled: false } } } });
  registry.getLlm = () => ({ async *stream() {
    yield { type: 'text', delta: '{"emotion":"sayang","text":"Aku di sini. ' };
    await finish;
    yield { type: 'text', delta: 'Tenang!","speechEmotion":"angry"}' };
  } });
  const stream = generateReplyStream([], 'Halo', null, { registry });
  assert.equal((await stream.next()).value.type, 'emotion');
  assert.equal((await stream.next()).value.type, 'delta');
  assert.deepEqual((await stream.next()).value, { type: 'sentence', text: 'Aku di sini.' });
  release();
  const remaining = await collect(stream);
  assert.deepEqual(remaining.find(event => event.type === 'sentence'), { type: 'sentence', text: 'Tenang!' });
});

test('all 49 native chat choices reach fake Fish audio while avatar cues stay sayang', async t => {
  const { adapter, state } = await fixture(t, ADAPTER_CASES[2], { adapterOptions: {
    params: { expression: { mergeShortSentences: { enabled: false } } },
  } });
  for (const speechEmotion of FISH_EMOTION_NAMES) {
    const registry = registryFor([JSON.stringify({ emotion: 'sayang', speechEmotion, text: 'Aku di sini. Tenang, ya!' })], { tts: adapter });
    const events = await collect(generateReplyStream([], 'Halo', null, { registry }));
    assert.deepEqual(events.filter(event => event.type === 'emotion'), [{ type: 'emotion', emotion: 'sayang' }]);
    assert.ok(events.every(event => event.type !== 'speechEmotion'));
    const framesBefore = state.frames.length;
    for (const event of events.filter(event => event.type === 'sentence')) {
      assert.equal(event.speechEmotion, speechEmotion);
      await collect(generateSpeech(event.text, 'sayang', { registry, speechEmotion: event.speechEmotion }));
    }
    assert.deepEqual(state.frames.slice(framesBefore).filter(frame => frame.event === 'text').map(frame => frame.text),
      [`[${speechEmotion}] Aku di sini.`, `[${speechEmotion}] Tenang, ya!`]);
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Aku di sini. Tenang, ya!');
  }
});

test('concurrent chat streams keep their reply choices isolated', async () => {
  const streams = ['nostalgic', 'confident', 'calm'].map(speechEmotion => {
    const registry = registryFor(['{"emotion":"sayang","speechEmo', `tion":"${speechEmotion}","text":"Aku di sini. `, 'Sampai nanti!"}']);
    return collect(generateReplyStream([], 'Halo', null, { registry }));
  });
  const results = await Promise.all(streams);
  for (const [index, speechEmotion] of ['nostalgic', 'confident', 'calm'].entries()) {
    assert.ok(results[index].filter(event => event.type === 'sentence').every(event => event.speechEmotion === speechEmotion));
  }
});

test('cancelled reply metadata does not enter a newer stream', async () => {
  const controller = new AbortController();
  const registry = registryFor(['{"emotion":"sayang","speechEmotion":"angry","text":"Halo!"}']);
  const stream = generateReply([], 'Halo', null, { registry, signal: controller.signal, includeSpeechText: true });
  assert.equal((await stream.next()).value.type, 'emotion');
  assert.deepEqual((await stream.next()).value, { type: 'speechEmotion', speechEmotion: 'angry' });
  controller.abort();
  await assert.rejects(stream.next(), { name: 'AbortError' });
  const nextRegistry = registryFor(['{"emotion":"sayang","text":"Halo!"}']);
  const next = await collect(generateReplyStream([], 'Halo', null, { registry: nextRegistry }));
  assert.deepEqual(next.find(event => event.type === 'sentence'), { type: 'sentence', text: 'Halo!' });
});
