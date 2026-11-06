import test from 'node:test';
import assert from 'node:assert/strict';
import { generateReply, generateReplyStream } from '../llmChat.js';
import { speechStylePrompt } from '../speechStylePrompt.js';
import { generateSpeech } from '../ttsGenerate.js';
import { SpeechController } from '../speechController.js';
import { fixture, ADAPTER_CASES, collect } from './providerFixtures.js';

function replyRegistry(params = {}, available = true, parts = ['Halo, sayang!']) {
  let request;
  return {
    getSlotStatus: slot => ({ available: slot !== 'tts' || available }),
    getTts: () => available ? { params } : null,
    getLlm: () => ({ async *stream(value) {
      request = value;
      for (const delta of parts) yield { type: 'text', delta };
    } }),
    get request() { return request; },
  };
}

test('speech style appends spoken Indonesian instructions only for configured enabled TTS', async () => {
  for (const [available, enabled] of [[true, true], [false, true], [true, false]]) {
    const registry = replyRegistry({ speechStyle: { enabled } }, available);
    await collect(generateReply([], 'Halo', null, { registry }));
    assert.equal(registry.request.messages[0].content.includes('tulis balasan untuk diucapkan dengan alami'), available && enabled);
  }
  assert.match(speechStylePrompt({ inlineTags: { enabled: true, allowList: ['laughs', 'break'] } }), /\[laughs\].*\[break\]/);
});

test('split LLM inline cues stay private while merged speech retains allowed cues', async () => {
  const registry = replyRegistry({ inlineTags: { enabled: true }, expression: { emotionTagMap: { kagum: '' } } }, true,
    ['{"emotion":"kagum","text":"Wa', 'h! [lau', 'ghs] Aku senang! [unknown] Benar-benar senang. (bre', 'ak) Sampai nanti."}']);
  const events = await collect(generateReplyStream([], 'Halo', null, { registry }));
  const display = events.filter(event => event.type === 'delta').map(event => event.text).join('');
  const speech = events.filter(event => event.type === 'sentence').map(event => event.text).join(' ');
  assert.doesNotMatch(display, /\[|\]|\(break\)/);
  assert.match(speech, /\[laughs\]/);
  assert.match(speech, /\[break\]/);
  assert.doesNotMatch(speech, /unknown|\(break\)/);
  assert.ok(events.filter(event => event.type === 'sentence').length < 4);
});

test('public chat events never expose inline cues or private speech fields', async () => {
  const registry = replyRegistry({ inlineTags: { enabled: true } }, true, ['[whis', 'per] Halo! (break) [unknown]']);
  const events = await collect(generateReply([], 'Halo', null, { registry }));
  assert.doesNotMatch(events.filter(event => event.type === 'delta').map(event => event.text).join(''), /\[|\]|break|unknown/);
  assert.ok(events.every(event => !Object.hasOwn(event, 'speechText')));
});

test('streamed Markdown links retain label words even with split delimiters and URLs', async () => {
  const registry = replyRegistry({}, true, ['Baca [pan', 'duan]', '(https://exa', 'mple.com) ini.']);
  const events = await collect(generateReplyStream([], 'Halo', null, { registry }));
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Baca panduan ini.');
  assert.equal(events.find(event => event.type === 'sentence').text, 'Baca panduan ini.');
});

test('whole caption TTS merges short sentences and advances first-only indexes between requests', async t => {
  const { adapter, state } = await fixture(t, ADAPTER_CASES[2], { adapterOptions: {
    params: { expression: { tagPlacement: 'first-only', mergeShortSentences: { minChars: 10, maxChars: 40 } } },
  } });
  const registry = { getSlotStatus: () => ({ available: true }), getTts: () => adapter };
  await collect(generateSpeech('Ya! Baiklah. Aku akan segera kembali ke sini.', 'kagum', { registry }));
  assert.deepEqual(state.frames.filter(frame => frame.event === 'text').map(frame => frame.text),
    ['[excited] Ya! Baiklah.', 'Aku akan segera kembali ke sini.']);
});

test('each synthesized file has its own audio boundary within a multi-sentence caption', async t => {
  const { adapter } = await fixture(t, ADAPTER_CASES[2], { adapterOptions: {
    params: { format: 'wav', expression: { mergeShortSentences: { enabled: false } } },
  } });
  const registry = { getSlotStatus: () => ({ available: true }), getTts: () => adapter };
  const events = [];
  const socket = {};
  const controller = new SpeechController({ isVoiceConfigured: () => true,
    generateSpeech: (text, emotion, options) => generateSpeech(text, emotion, { ...options, registry }) });
  controller.register(socket, event => events.push(event));
  t.after(() => controller.unregister(socket));
  await controller.play({ text: 'Halo! Sampai nanti.', recipients: [socket] });
  assert.equal(events.filter(event => event.type === 'audio_end').length, 2);
  const audio = events.filter(event => ['audio_output', 'audio_end'].includes(event.type));
  assert.deepEqual(audio.map(event => event.type), ['audio_output', 'audio_output', 'audio_end', 'audio_output', 'audio_output', 'audio_end']);
  assert.ok(audio.filter(event => event.type === 'audio_output').every(event => event.format === 'wav'));
});

test('discarded tag and URL fragments do not consume first-only emotion placement', async t => {
  const { adapter, state } = await fixture(t, ADAPTER_CASES[2], { adapterOptions: {
    params: { expression: { tagPlacement: 'first-only', mergeShortSentences: { enabled: false } } },
  } });
  const registry = { getSlotStatus: () => ({ available: true }), getTts: () => adapter };
  await collect(generateSpeech('[unknown] https://example.com\nHalo!', 'kagum', { registry }));
  assert.deepEqual(state.frames.filter(frame => frame.event === 'text').map(frame => frame.text), ['[excited] Halo!']);
});

test('custom legacy parentheses are stripped by the configured tag map', async t => {
  const { adapter, state } = await fixture(t, ADAPTER_CASES[2], { adapterOptions: {
    params: { expression: { emotionTagMap: { netral: '[soft and warm]' } } },
  } });
  await collect(adapter.stream({ text: '(soft and warm) Halo (aku di sini).', emotion: 'netral' }));
  assert.equal(state.frames.find(frame => frame.event === 'text').text, '[soft and warm] Halo (aku di sini).');
});

test('shared speech passes cumulative indexes and actual format and strips caption tags', async t => {
  const events = [];
  const indexes = [];
  const socket = {};
  const controller = new SpeechController({ isVoiceConfigured: () => true,
    generateSpeech: async function* (_text, _emotion, { sentenceIndex, onAudioFormat }) {
      indexes.push(sentenceIndex); onAudioFormat('wav'); yield Buffer.from('fixture audio');
    } });
  controller.register(socket, event => events.push(event));
  t.after(() => controller.unregister(socket));
  await controller.play({ recipients: [socket], produce: async ({ say }) => {
    await say('Ya! Baiklah.'); await say('Sampai nanti.');
  } });
  controller.acknowledge(socket, events.find(event => event.type === 'speech_start').speechId);
  assert.deepEqual(indexes, [0, 2]);
  assert.ok(events.filter(event => event.type === 'audio_output').every(event => event.format === 'wav'));
  await controller.play({ text: '[laughs] Halo! (break)', recipients: [socket] });
  assert.equal(events.find(event => event.type === 'amika_replied').text, ' Halo! ');
});
