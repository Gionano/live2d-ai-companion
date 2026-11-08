import test from 'node:test';
import assert from 'node:assert/strict';
import { StructuredReplyParser, generateReply, generateReplyStream } from '../llmChat.js';
import { SPEECH_REGISTERS, normalizeSpeechRegister, speechEmotionPrompt } from '../speechEmotionPrompt.js';
import { resolveTtsParams } from '../ttsExpression.js';

const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events; };
const parse = chunks => {
  const parser = new StructuredReplyParser();
  return [...chunks.flatMap(chunk => parser.push(chunk)), ...parser.finish()];
};
function registry(chunks, params = {}) {
  return { getSlotStatus: () => ({ available: true }), getTts: () => ({ params }),
    getLlm: () => ({ async *stream() { for (const delta of chunks) yield { type: 'text', delta }; } }) };
}

test('register catalogue preserves five attitudes without inventing Fish vocabulary', () => {
  assert.deepEqual(SPEECH_REGISTERS, ['polite', 'casual', 'serious', 'intimate', 'whisper']);
  for (const value of SPEECH_REGISTERS) assert.equal(normalizeSpeechRegister(value), value);
  for (const value of [null, undefined, 'Casual', '[whisper]', 'unknown', ['casual'], { name: 'casual' }]) {
    assert.equal(normalizeSpeechRegister(value), 'casual');
  }
  assert.match(speechEmotionPrompt(), /one Fish emotion per natural spoken sentence/);
  assert.match(speechEmotionPrompt(), /Adjacent sentences may keep the same emotion/);
});

test('every stream split freezes register and both emotions before sentence text', () => {
  const json = JSON.stringify({ segments: [{ register: 'whisper', emotion: 'sayang', speechEmotion: 'compassionate', text: 'Aku di sini.' }] });
  for (let index = 0; index <= json.length; index++) {
    const events = parse([json.slice(0, index), json.slice(index)]);
    const start = events.find(event => event.type === 'segment_start');
    assert.equal(start.register, 'whisper');
    assert.equal(start.emotion, 'sayang');
    assert.equal(start.speechEmotion, 'compassionate');
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Aku di sini.');
    assert.ok(events.indexOf(start) < events.findIndex(event => event.type === 'delta'));
  }
});

test('split escapes, invalid values, and late register members use stable fallbacks', () => {
  const escaped = parse(['{"segments":[{"register":"casu\\u00', '61l","emotion":"netral","text":"Aku \\u00', 'e9 di sini."}]}']);
  assert.equal(escaped.find(event => event.type === 'segment_start').register, 'casual');
  assert.equal(escaped.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Aku é di sini.');
  for (const register of ['made-up', null, ['serious'], { name: 'serious' }]) {
    const events = parse([JSON.stringify({ segments: [{ register, emotion: 'netral', text: 'Halo.' }] })]);
    assert.equal(events.find(event => event.type === 'segment_start').register, 'casual');
  }
  const late = parse(['{"segments":[{"emotion":"sayang","text":"Halo.","register":"serious"}]}']);
  assert.equal(late.find(event => event.type === 'segment_start').register, undefined);
});

test('sentence audio boundaries retain the original tone across multiple segments', async () => {
  const data = { segments: [
    { register: 'intimate', emotion: 'sayang', speechEmotion: 'compassionate', text: 'Aku tahu. Tenang dulu.' },
    { register: 'serious', emotion: 'jengkel', speechEmotion: 'confident', text: 'Sekarang dengar baik-baik.' },
  ] };
  const events = await collect(generateReplyStream([], 'halo', null, {
    registry: registry([JSON.stringify(data)], { expression: { sentencePauseMs: 200, segmentPauseMs: 350 } }),
  }));
  const spoken = events.filter(event => event.type === 'sentence');
  assert.deepEqual(spoken.map(event => [event.text, event.register, event.emotion, event.speechEmotion]), [
    ['Aku tahu.', 'intimate', 'sayang', 'compassionate'],
    ['Tenang dulu.', 'intimate', 'sayang', 'compassionate'],
    ['Sekarang dengar baik-baik.', 'serious', 'jengkel', 'confident'],
  ]);
  assert.deepEqual(spoken.map(event => [event.pauseBeforeMs, event.pauseAfterMs]), [[0, 200], [0, 200], [150, 200]]);
  assert.equal(spoken[1].pauseAfterMs + spoken[2].pauseBeforeMs, 350);
});

test('a zero sentence pause retains configurable legacy merging within a segment', async () => {
  const chunks = [JSON.stringify({ segments: [{ emotion: 'netral', text: 'Iya. Oke. Aku dengar semuanya.' }] })];
  const events = await collect(generateReplyStream([], 'halo', null, { registry: registry(chunks, { expression: {
    sentencePauseMs: 0, earlyFirstSentence: false, mergeShortSentences: { enabled: true, minChars: 15, maxChars: 100 },
  } }) }));
  assert.deepEqual(events.filter(event => event.type === 'sentence').map(event => event.text), ['Iya. Oke. Aku dengar semuanya.']);
  assert.equal(events.find(event => event.type === 'sentence').pauseAfterMs, 0);
});

test('legacy single-object and plain text keep spoken text with sentence pauses', async () => {
  for (const chunks of [['{"emotion":"sayang","text":"Aku di sini. Tenang, ya!"}'], ['Aku di sini. ', 'Tenang, ya!']]) {
    const events = await collect(generateReplyStream([], 'halo', null, { registry: registry(chunks) }));
    assert.deepEqual(events.filter(event => event.type === 'sentence').map(event => event.text), ['Aku di sini.', 'Tenang, ya!']);
    assert.ok(events.filter(event => event.type === 'sentence').every(event => event.pauseAfterMs === 200));
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Aku di sini. Tenang, ya!');
  }
});

test('sentence pause settings default to 200 and clamp to the approved bounds', () => {
  assert.equal(resolveTtsParams().expression.sentencePauseMs, 200);
  for (const [input, expected] of [[0, 0], [-5, 0], [999, 400], [250, 250], [Infinity, 200], ['300', 200]]) {
    assert.equal(resolveTtsParams({ expression: { sentencePauseMs: input } }).expression.sentencePauseMs, expected);
  }
});

test('only valid top-level control metadata is accepted; nested prose never requests reflection', async () => {
  const raw = JSON.stringify({ mode: 'say+think', segments: [{ register: 'casual', emotion: 'netral',
    text: 'Contoh reflectionRequest dalam teks. Aku tetap di sini.' }],
  nested: { reflectionRequest: 'PRIVATE nested request' }, thought: 'PRIVATE analysis',
  reflectionRequest: 'Continue gently.\nKeep the mood.' });
  const events = parse([raw]);
  assert.deepEqual(events.filter(event => event.type === 'reply_metadata'), [
    { type: 'reply_metadata', mode: 'say+think' },
    { type: 'reply_metadata', reflectionRequest: 'Continue gently. Keep the mood.' },
  ]);
  const privateStream = await collect(generateReplyStream([], 'halo', null, { registry: registry([raw]) }));
  assert.equal(privateStream.find(event => event.reflectionRequest).reflectionRequest, 'Continue gently. Keep the mood.');
  const publicStream = await collect(generateReply([], 'halo', null, { registry: registry([raw]) }));
  assert.ok(publicStream.every(event => event.type !== 'reply_metadata' && !Object.hasOwn(event, 'register')));
  assert.doesNotMatch(publicStream.map(event => event.text ?? '').join(''), /PRIVATE analysis|Continue gently/);
});

test('truncated JSON cannot start an after-turn reflection', () => {
  const events = parse(['{"segments":[{"emotion":"netral","text":"Halo."}],"reflectionRequest":"Never accept this"']);
  assert.equal(events.some(event => event.reflectionRequest), false);
});

test('a metadata-looking fragment in a plain reply does not become surface protocol', () => {
  const events = parse(['Contoh {"mode":"say","reflectionRequest":"wrong"} dalam teks.']);
  assert.equal(events.some(event => event.type === 'reply_metadata'), false);
});
