import test from 'node:test';
import assert from 'node:assert/strict';
import { StructuredReplyParser, generateReply, generateReplyStream } from '../llmChat.js';
import { resolveTtsParams } from '../ttsExpression.js';
import { validateSlot } from '../settings/schema.js';
import { makeTtsParams, DEFAULT_TTS_PARAMS } from '../../src/settings/viewModel.js';
import { collect } from './providerFixtures.js';

function registryFor(parts, params = {}, available = true) {
  const requests = [];
  return {
    requests,
    getSlotStatus: slot => ({ available: slot !== 'tts' || available }),
    getTts: () => available ? { params } : null,
    getLlm: () => ({ async *stream(request) {
      requests.push(request);
      for (const delta of parts) yield { type: 'text', delta };
    } }),
  };
}
const segments = [
  { emotion: 'kagum', speechEmotion: 'excited', text: 'Wah! Aku bilang "hebat". ' },
  { emotion: 'sayang', speechEmotion: 'compassionate', text: 'Aku di sini, é. {Tetap tenang!}' },
];

test('every split in ordered segments preserves escaped text and independent metadata', () => {
  const raw = JSON.stringify({ segments });
  for (let split = 0; split <= raw.length; split++) {
    const parser = new StructuredReplyParser();
    const events = [...parser.push(raw.slice(0, split)), ...parser.push(raw.slice(split)), ...parser.finish()];
    assert.deepEqual(events.filter(event => event.type === 'segment_start').map(event =>
      [event.segmentId, event.emotion, event.speechEmotion]), [[0, 'kagum', 'excited'], [1, 'sayang', 'compassionate']]);
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''),
      segments.map(segment => segment.text).join(''));
    assert.equal(events.filter(event => event.type === 'segment_end').length, 2);
  }
});

test('plain text containing a JSON segments example remains a legacy reply', () => {
  const raw = 'Contoh {"segments":[{"emotion":"marah","text":"Jangan ambil ini."}]} tetap teks biasa.';
  const parser = new StructuredReplyParser();
  const events = [...parser.push(raw), ...parser.finish()];
  assert.equal(events.some(event => event.type === 'segment_start'), false);
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), raw);
});

test('nested, duplicate and late segment metadata cannot change the frozen choices', () => {
  const parser = new StructuredReplyParser();
  const raw = '{"segments":[null,{"other":{"emotion":"marah","speechEmotion":"angry","text":"wrong"},'
    + '"emotion":"sayang","speechEmotion":"calm","speechEmotion":"angry","text":"Halo!",'
    + '"emotion":"marah","speechEmotion":"sad"},{"text":"Tenang!","emotion":"marah"}]}';
  const events = [...parser.push(raw), ...parser.finish()];
  assert.deepEqual(events.filter(event => event.type === 'segment_start').map(event =>
    [event.emotion, event.speechEmotion]), [['sayang', 'calm'], ['netral', undefined]]);
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Halo!Tenang!');
});

test('segmented speech streams its first complete sentence before the provider finishes', async () => {
  let release;
  const finished = new Promise(resolve => { release = resolve; });
  const registry = registryFor([]);
  registry.getLlm = () => ({ async *stream() {
    yield { type: 'text', delta: '{"segments":[{"emotion":"kagum","speechEmotion":"excited","text":"Wah! ' };
    await finished;
    yield { type: 'text', delta: 'Kamu berhasil."},{"emotion":"sayang","speechEmotion":"compassionate","text":"Aku ikut senang."}]}' };
  } });
  const stream = generateReplyStream([], 'Halo', null, { registry });
  assert.equal((await stream.next()).value.type, 'emotion');
  assert.equal((await stream.next()).value.type, 'delta');
  assert.deepEqual((await stream.next()).value, { type: 'sentence', text: 'Wah!', emotion: 'kagum',
    segmentId: 0, pauseBeforeMs: 0, pauseAfterMs: 200, speechEmotion: 'excited' });
  release();
  const rest = await collect(stream);
  assert.equal(rest.find(event => event.type === 'sentence' && event.segmentId === 1).pauseBeforeMs, 0);
  assert.equal(rest.find(event => event.type === 'sentence' && event.segmentId === 1).pauseAfterMs, 200);
});

test('segment boundaries flush short sentences and snapshot both emotion choices', async () => {
  const registry = registryFor([JSON.stringify({ segments: [
    { emotion: 'sedih', speechEmotion: 'sad', text: 'Aku sedih. Masih kepikiran.' },
    { emotion: 'sayang', speechEmotion: 'compassionate', text: 'Tapi kamu di sini. Aku lebih tenang.' },
  ] })], { expression: { sentencePauseMs: 0, earlyFirstSentence: false, mergeShortSentences: { minChars: 100, maxChars: 180 } } });
  const events = await collect(generateReplyStream([], 'Halo', null, { registry }));
  assert.deepEqual(events.filter(event => event.type === 'sentence'), [
    { type: 'sentence', text: 'Aku sedih. Masih kepikiran.', emotion: 'sedih', speechEmotion: 'sad', segmentId: 0, pauseBeforeMs: 0, pauseAfterMs: 0 },
    { type: 'sentence', text: 'Tapi kamu di sini. Aku lebih tenang.', emotion: 'sayang', speechEmotion: 'compassionate', segmentId: 1, pauseBeforeMs: 150, pauseAfterMs: 0 },
  ]);
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''),
    'Aku sedih. Masih kepikiran. Tapi kamu di sini. Aku lebih tenang.');
});

test('each segment sanitizes separately and public SSE never exposes native choices', async () => {
  const parts = ['{"segments":[{"emotion":"kagum","speechEmotion":"excited","text":"Halo! [un',
    'known"},{"emotion":"sayang","speechEmotion":"compassionate","text":"[lau',
    'ghs] Aku di sini."}]}'];
  const params = { inlineTags: { enabled: true } };
  const events = await collect(generateReply([], 'Halo', null, { registry: registryFor(parts, params) }));
  assert.ok(events.every(event => ['emotion', 'delta'].includes(event.type) && !('speechEmotion' in event)));
  const display = events.filter(event => event.type === 'delta').map(event => event.text).join('');
  assert.doesNotMatch(display, /unknown|laughs|\[|\]/);
  assert.match(display, /Halo!\s+Aku di sini\./);
  const spoken = await collect(generateReplyStream([], 'Halo', null, { registry: registryFor(parts, params) }));
  assert.ok(spoken.filter(event => event.type === 'sentence').some(event => event.segmentId === 1 && event.text.includes('[laughs]')));
});

test('empty segments do not add pauses and sentence groups inside one segment have no transition pause', async () => {
  const registry = registryFor([JSON.stringify({ segments: [
    { text: '[unknown]' }, { emotion: 'kagum', text: 'Wah! Kamu berhasil.' }, { emotion: 'sayang', text: 'Aku senang. Terima kasih.' },
  ] })], { expression: { mergeShortSentences: { enabled: false }, segmentPauseMs: 240 } });
  const events = (await collect(generateReplyStream([], 'Halo', null, { registry }))).filter(event => event.type === 'sentence');
  assert.deepEqual(events.map(event => event.pauseBeforeMs), [0, 0, 40, 0]);
  assert.ok(events.every(event => event.pauseAfterMs === 200));
});

test('only the first naturally complete sentence bypasses short-sentence merging', async () => {
  for (const earlyFirstSentence of [true, false]) {
    const registry = registryFor(['{"emotion":"sayang","text":"Ya! Baiklah. Besok kita pergi bersama."}'],
      { expression: { sentencePauseMs: 0, earlyFirstSentence, mergeShortSentences: { minChars: 40, maxChars: 180 } } });
    const events = await collect(generateReplyStream([], 'Halo', null, { registry }));
    assert.deepEqual(events.filter(event => event.type === 'sentence').map(event => event.text), earlyFirstSentence
      ? ['Ya!', 'Baiklah. Besok kita pergi bersama.'] : ['Ya! Baiklah. Besok kita pergi bersama.']);
  }
  assert.equal(resolveTtsParams().expression.earlyFirstSentence, true);
});

test('invalid or disabled native segment metadata falls back without changing avatar labels', async () => {
  for (const selection of ['native', 'mapped']) {
    const registry = registryFor(['{"segments":[{"emotion":"sayang","speechEmotion":"unknown","text":"Halo!"},',
      '{"emotion":"invented","speechEmotion":"sad","text":"Aku di sini."}]}'], { expression: { selection } });
    const events = (await collect(generateReplyStream([], 'Halo', null, { registry }))).filter(event => event.type === 'sentence');
    assert.equal(events[0].emotion, 'sayang');
    assert.equal(events[0].speechEmotion, undefined);
    assert.equal(events[1].emotion, 'netral');
    assert.equal(events[1].speechEmotion, selection === 'native' ? 'sad' : undefined);
  }
});

test('internal spontaneous instructions preserve real history and add no fabricated user message', async () => {
  const registry = registryFor(['{"segments":[{"emotion":"sayang","text":"Kamu sudah makan?"}]}']);
  const history = [{ role: 'user', content: 'Aku sedang bekerja.' }, { role: 'assistant', content: 'Semangat, ya.' }];
  await collect(generateReplyStream(history, null, 'User is at their desk.',
    { registry, internalInstruction: 'Offer one natural spontaneous comment if relevant.' }));
  assert.deepEqual(registry.requests[0].messages.slice(1), history);
  assert.match(registry.requests[0].messages[0].content, /Offer one natural spontaneous comment if relevant/);
  assert.match(registry.requests[0].messages[0].content, /User is at their desk/);
});

test('aborted segmented replies cannot flush queued tone metadata into a new reply', async () => {
  const controller = new AbortController();
  const registry = registryFor(['{"segments":[{"emotion":"marah","speechEmotion":"angry","text":"Halo!"}]}']);
  const stream = generateReplyStream([], 'Halo', null, { registry, signal: controller.signal });
  assert.equal((await stream.next()).value.type, 'emotion');
  controller.abort();
  await assert.rejects(stream.next(), { name: 'AbortError' });
  const next = await collect(generateReplyStream([], 'Halo', null, { registry: registryFor([
    '{"segments":[{"emotion":"sayang","speechEmotion":"calm","text":"Aku di sini."}]}',
  ]) }));
  assert.deepEqual(next.filter(event => event.type === 'sentence'), [
    { type: 'sentence', text: 'Aku di sini.', emotion: 'sayang', speechEmotion: 'calm', segmentId: 0, pauseBeforeMs: 0, pauseAfterMs: 200 },
  ]);
});

test('segment pause is clamped for runtime overrides and validated in settings and GUI forms', () => {
  for (const [input, expected] of [[-50, 0], [800, 400], [NaN, 150], [220, 220]]) {
    assert.equal(resolveTtsParams({ expression: { segmentPauseMs: input } }).expression.segmentPauseMs, expected);
  }
  const form = { topP: '0.7', latency: 'balanced', speed: '1', volume: '0', selection: 'native',
    emotionTagMap: JSON.stringify(DEFAULT_TTS_PARAMS.expression.emotionTagMap), tagPlacement: 'every-sentence',
    maxTagsPerSentence: '2', mergeEnabled: true, minChars: '25', maxChars: '180', inlineEnabled: false,
    inlineAllowList: '', inlineMaxPerSentence: '2', speechStyleEnabled: true, debug: false,
    earlyFirstSentence: false, segmentPauseMs: '200' };
  const params = makeTtsParams(form);
  assert.equal(params.expression.earlyFirstSentence, false);
  assert.equal(params.expression.segmentPauseMs, 200);
  assert.deepEqual(validateSlot({ profile: 'fish', model: 'fixture', params }).slot.params, params);
  for (const expression of [{ earlyFirstSentence: 1 }, { segmentPauseMs: 401 }, { segmentPauseMs: 1.5 }]) {
    assert.throws(() => validateSlot({ profile: 'fish', model: 'fixture', params: { expression } }), { code: 'INVALID_SETTINGS' });
  }
  for (const changes of [{ earlyFirstSentence: null }, { segmentPauseMs: '' }, { segmentPauseMs: '401' }]) {
    assert.throws(() => makeTtsParams({ ...form, ...changes }), { code: 'INVALID_SETTINGS' });
  }
});
