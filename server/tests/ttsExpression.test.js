import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_TTS_PARAMS, resolveTtsParams, normalizeTtsText, sanitizeSpeechText,
  prepareTtsText, StreamingTagSanitizer, SentenceMerger,
} from '../ttsExpression.js';
import { ADAPTER_CASES, SECRET, collect, fixture, requestFor } from './providerFixtures.js';

const fish = ADAPTER_CASES.find(spec => spec.id === 'fishAudio');
const compact = text => text.replace(/\s+/g, ' ').trim();
const tags = text => text.match(/\[[^\]]*\]/g) || [];

test('TTS defaults cover all twelve reply emotions and experimental neutral warmth', () => {
  const params = resolveTtsParams();
  assert.equal(params.temperature, 0.8);
  assert.equal(params.latency, 'balanced');
  assert.equal(params.expression.tagPlacement, 'every-sentence');
  assert.equal(params.expression.maxTagsPerSentence, 2);
  assert.equal(params.expression.mergeShortSentences.minChars, 25);
  assert.equal(params.inlineTags.enabled, false);
  assert.equal(params.speechStyle.enabled, true);
  for (const emotion of ['terkejut', 'marah', 'bingung', 'jengkel', 'malu', 'kesal',
    'sedih', 'kagum', 'sayang', 'jahil', 'penasaran', 'netral']) {
    const result = prepareTtsText('Aku di sini.', emotion);
    assert.ok(/^\[[^\]]+\]/.test(result), emotion);
    assert.ok(tags(result).length <= 2, emotion);
    assert.ok(result.endsWith('Aku di sini.'), emotion);
  }
  assert.match(prepareTtsText('Aku di sini.', 'netral'), /^\[calm\] \[warm\]/);
});

test('TTS resolved nested overrides do not mutate shared defaults or slot settings', () => {
  const original = structuredClone(DEFAULT_TTS_PARAMS);
  const slot = { prosody: { speed: 1.1 }, expression: { maxTagsPerSentence: 1 } };
  const params = resolveTtsParams(slot, { prosody: { volume: -3 }, expression: { tagPlacement: 'first-only' } });
  assert.deepEqual(params.prosody, { speed: 1.1, volume: -3 });
  assert.equal(params.expression.maxTagsPerSentence, 1);
  assert.equal(params.expression.tagPlacement, 'first-only');
  assert.deepEqual(DEFAULT_TTS_PARAMS, original);
  assert.deepEqual(slot, { prosody: { speed: 1.1 }, expression: { maxTagsPerSentence: 1 } });
});

for (const [input, expected] of [
  ['Wah!!! Senang???? Tunggu......', 'Wah!!! Senang??? Tunggu...'],
  ['Aku suka nasi, kopi — dan kamu! Benar?', 'Aku suka nasi, kopi — dan kamu! Benar?'],
  ['## Halo **sayang**! `Aku` _senang_ 😊🔥', 'Halo sayang! Aku senang'],
  ['Aku [suka](https://example.invalid/info) kopi. Baca https://example.invalid/a ya!', 'Aku suka kopi. Baca ya!'],
  ['Halo\u0000 sayang\u0007!\tAku\nbaik.', 'Halo sayang! Aku baik.'],
  ['Harga 3.14 itu benar, kok... ya?!', 'Harga 3.14 itu benar, kok... ya?!'],
  ['Ayah dan ibu, aku kangen! Kamu bagaimana?', 'Ayah dan ibu, aku kangen! Kamu bagaimana?'],
  ['Aku senang 👩🏽‍💻🇮🇩❤️ 123.', 'Aku senang 123.'],
]) {
  test(`TTS normalizer preserves spoken words: ${JSON.stringify(input)}`, () => {
    assert.equal(compact(normalizeTtsText(input)), expected);
  });
}

test('TTS bracket prefixes replace legacy emotion tags without removing ordinary prose', () => {
  const result = prepareTtsText('(excited) Halo (happy) sayang! Aku (benar-benar) senang.', 'kagum');
  assert.ok(!result.includes('(excited)'));
  assert.ok(!result.includes('(happy)'));
  assert.ok(result.includes('Aku (benar-benar) senang.'));
  assert.match(result, /^\[excited\] Halo sayang!/);
});

test('TTS caps configurable emotion tag strings and arrays at the sentence start', () => {
  for (const value of ['[excited] [happy] [confident]', ['[excited]', '[happy]', '[confident]']]) {
    const result = prepareTtsText('Aku senang!', 'kagum', {
      expression: { emotionTagMap: { kagum: value }, maxTagsPerSentence: 2 },
    });
    assert.equal(result, '[excited] [happy] Aku senang!');
  }
});

test('TTS manual plain override suppresses automatic emotion prefixes', () => {
  assert.equal(prepareTtsText('Aku senang!', 'kagum', {}, 0, ''), 'Aku senang!');
  assert.equal(prepareTtsText('Aku senang!', 'kagum', {}, 0, '[surprised]'), '[surprised] Aku senang!');
});

test('inline tags default off and unknown brackets never reach display or speech', () => {
  const result = sanitizeSpeechText('[laughs] Halo [invented] sayang (break)!');
  assert.equal(compact(result.displayText), 'Halo sayang !');
  assert.equal(compact(result.ttsText), 'Halo sayang !');
});

test('enabled inline allow-list retains only known performance tags for speech', () => {
  const params = { inlineTags: { enabled: true, allowList: ['laughs', 'sigh', 'break'], maxPerSentence: 2 } };
  const result = sanitizeSpeechText('[laughs] Halo [invented] sayang (break) [sigh]!', params);
  assert.ok(!/[\[\]]|\(break\)/.test(result.displayText));
  assert.ok(!result.ttsText.includes('invented'));
  assert.ok(result.ttsText.includes('[laughs]'));
  assert.ok(result.ttsText.includes('[break]'));
  assert.equal(tags(result.ttsText).length, 2);
});

test('combined emotion and inline tags stay at the start under one sentence cap', () => {
  const result = prepareTtsText('Halo [laughs] sayang [sigh]!', 'kagum', {
    inlineTags: { enabled: true, allowList: ['laughs', 'sigh'], maxPerSentence: 2 },
    expression: { maxTagsPerSentence: 2 },
  });
  assert.equal(tags(result).length, 2);
  assert.match(result, /^(?:\[[^\]]+\] ){2}Halo sayang !$/);
});

test('streaming sanitizer buffers split brackets and parenthesis tags before display', () => {
  const sanitizer = new StreamingTagSanitizer({ inlineTags: { enabled: true, allowList: ['laughs', 'break'] } });
  const results = ['Halo [lau', 'ghs] sayang (br', 'eak)! [unk', 'nown]'].map(chunk => sanitizer.push(chunk));
  results.push(sanitizer.finish());
  const display = results.map(result => result.displayText).join('');
  const speech = results.map(result => result.ttsText).join('');
  assert.equal(compact(display), 'Halo sayang !');
  assert.ok(speech.includes('[laughs]'));
  assert.ok(speech.includes('[break]'));
  assert.ok(!display.includes('laughs') && !display.includes('break') && !display.includes('unknown'));
  assert.ok(!speech.includes('unknown'));
});

test('streaming sanitizer drops incomplete final bracket content', () => {
  const sanitizer = new StreamingTagSanitizer();
  const pieces = [sanitizer.push('Halo [unfinished'), sanitizer.finish()];
  assert.equal(compact(pieces.map(piece => piece.displayText).join('')), 'Halo');
  assert.equal(compact(pieces.map(piece => piece.ttsText).join('')), 'Halo');
});

test('sanitizer removes nested unknown brackets without leaking delimiters or enclosed words', () => {
  for (const text of ['Halo [[laughs]] sayang!', 'Halo [unknown [laughs] content] sayang!']) {
    const result = sanitizeSpeechText(text);
    assert.equal(compact(result.displayText), 'Halo sayang!');
    assert.equal(compact(result.ttsText), 'Halo sayang!');
  }
});

test('sanitizer strips bracket tags inside ordinary parentheses while retaining prose words', () => {
  const result = sanitizeSpeechText('Halo (aku [laughs] senang) sayang!');
  assert.equal(compact(result.displayText), 'Halo (aku senang) sayang!');
  assert.equal(compact(result.ttsText), 'Halo (aku senang) sayang!');
});

test('sanitizer handles nested bracket content split across LLM chunks', () => {
  const sanitizer = new StreamingTagSanitizer();
  const results = ['Halo [unknown [lau', 'ghs] cont', 'ent] sayang!'].map(chunk => sanitizer.push(chunk));
  results.push(sanitizer.finish());
  assert.equal(compact(results.map(piece => piece.displayText).join('')), 'Halo sayang!');
  assert.equal(compact(results.map(piece => piece.ttsText).join('')), 'Halo sayang!');
});

test('sanitizer retains deeply nested balanced Indonesian prose without recursion', () => {
  const depth = 8192;
  const input = '('.repeat(depth) + 'Aku [unknown] (happy) sayang!' + ')'.repeat(depth);
  const expected = '('.repeat(depth) + 'Aku   sayang!' + ')'.repeat(depth);
  assert.deepEqual(sanitizeSpeechText(input), { displayText: expected, ttsText: expected });
});

test('sanitizer retains deeply nested unclosed prose and drops incomplete legacy tags', () => {
  const opening = '('.repeat(8192);
  const expected = opening + 'Aku  sayang!';
  assert.deepEqual(sanitizeSpeechText(opening + 'Aku [unknown] sayang!'),
    { displayText: expected, ttsText: expected });
  assert.deepEqual(sanitizeSpeechText('(happy'), { displayText: '', ttsText: '' });
  assert.deepEqual(sanitizeSpeechText('(Aku [unknown'), { displayText: '(Aku ', ttsText: '(Aku ' });
});

test('sanitizer handles deep unclosed parentheses with shared trailing whitespace promptly', { timeout: 10000 }, () => {
  const input = '('.repeat(65536) + 'Aku [unknown] sayang!' + ' '.repeat(65536);
  const expected = '('.repeat(65536) + 'Aku  sayang!' + ' '.repeat(65536);
  const start = performance.now();
  assert.deepEqual(sanitizeSpeechText(input), { displayText: expected, ttsText: expected });
  assert.ok(performance.now() - start < 5000, 'Trailing whitespace must not be rescanned at every nesting level');
});

test('sanitizer preserves deeply nested Markdown label words and mixed parentheses', () => {
  const depth = 8192;
  const suffix = '](https://example.invalid/)';
  const input = '['.repeat(depth) + 'Aku [unknown] (happy) sayang!' + suffix.repeat(depth);
  assert.deepEqual(sanitizeSpeechText(input), { displayText: 'Aku   sayang!', ttsText: 'Aku   sayang!' });
  const mixedDepth = 4096;
  const mixed = '[('.repeat(mixedDepth) + 'Aku [unknown] sayang!' + (')' + suffix).repeat(mixedDepth);
  const expected = '('.repeat(mixedDepth) + 'Aku  sayang!' + ')'.repeat(mixedDepth);
  assert.deepEqual(sanitizeSpeechText(mixed), { displayText: expected, ttsText: expected });
});

test('streaming sanitizer buffers deep nesting across chunks without exposing tags', () => {
  const sanitizer = new StreamingTagSanitizer();
  const results = [sanitizer.push('Halo ' + '('.repeat(8192) + 'aku [unk'),
    sanitizer.push('nown] sayang' + ')'.repeat(4096)),
    sanitizer.push(')'.repeat(4096) + '!'), sanitizer.finish()];
  assert.deepEqual(results[1], { displayText: '', ttsText: '' });
  const expected = 'Halo ' + '('.repeat(8192) + 'aku  sayang' + ')'.repeat(8192) + '!';
  assert.equal(results.map(result => result.displayText).join(''), expected);
  assert.equal(results.map(result => result.ttsText).join(''), expected);
});

test('deep sanitizer frames preserve nested inline allowances and label default stripping', () => {
  const params = { inlineTags: { enabled: true, allowList: ['laughs', 'sigh', 'break'], maxPerSentence: 2 } };
  const input = '('.repeat(8192) + 'Aku [laughs] (benar [sigh]) [break]' + ')'.repeat(8192) + ' [sigh]';
  const result = sanitizeSpeechText(input, params);
  assert.deepEqual(tags(result.ttsText), ['[laughs]', '[sigh]']);
  assert.doesNotMatch(result.displayText, /\[|\]|laughs|sigh|break/);
  const label = sanitizeSpeechText('[Aku [laughs] (happy) senang](https://example.invalid/) [sigh]', params);
  assert.equal(label.displayText, 'Aku   senang ');
  assert.equal(label.ttsText, 'Aku   senang [sigh]');
});

test('sanitizer preserves mixed delimiter and link target compatibility', () => {
  for (const [input, expected] of [
    ['([unknown) Halo]', '() Halo'],
    ['[Aku](https://example.invalid/(a))', 'Aku)'],
    ['( Aku [unknown] sayang )', '( Aku  sayang )'],
    ['('.repeat(8192) + '[unknown' + ')'.repeat(8192), '('.repeat(8192) + ')'.repeat(8192)],
  ]) assert.deepEqual(sanitizeSpeechText(input), { displayText: expected, ttsText: expected });
});

test('sanitizer strips configured Unicode legacy tags whose lowercase name expands', () => {
  const name = '\u0130'.repeat(32);
  const params = { expression: { emotionTagMap: { kagum: `[${name}]` } } };
  const result = sanitizeSpeechText(`Halo (${name.toLowerCase()}) sayang!`, params);
  assert.deepEqual(result, { displayText: 'Halo  sayang!', ttsText: 'Halo  sayang!' });
});

test('actual spontaneous comment listener rejects oversized text under strict rejections', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const marker = "  socket.on('message', async (raw) => {";
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf("    if (msg.type !== 'audio_input' && msg.type !== 'text_input') return;", start);
  assert.ok(start >= marker.length && end > start, 'Actual listener extraction must succeed');
  const body = JSON.stringify(source.slice(start, end));
  const sanitizerUrl = JSON.stringify(new URL('../ttsExpression.js', import.meta.url).href);
  const managerUrl = JSON.stringify(new URL('../streamingVisionManager.js', import.meta.url).href);
  const code = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { stripSpeechTags } from ${sanitizerUrl};
    import { StreamingVisionManager } from ${managerUrl};
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const listener = new AsyncFunction('raw', 'socket', 'speechController', 'handleSelfieFeature',
      'stripSpeechTags', 'markConversationActivity', 'history', 'HISTORY_MESSAGE_LIMIT',
      'send', 'console', 'visionManager', ${body});
    const history = [], displayed = [], spoken = [];
    const emitter = new EventEmitter();
    const socket = {};
    const visionManager = new StreamingVisionManager({ startTimer: false,
      registry: { getSlotStatus: () => ({ available: false }) } });
    visionManager.setHistoryRef(history);
    visionManager.setBroadcaster(event => displayed.push(event));
    visionManager.setSpeechHandler(async request => spoken.push(request));
    emitter.on('message', raw => listener(raw, socket,
      { isBusy: () => false, async play(request) { spoken.push(request); } }, () => false,
      stripSpeechTags, () => {}, history, 8, event => displayed.push(event), { log() {} }, visionManager));
    const text = '('.repeat(8192) + 'Aku [unknown] (happy) sayang!' + ')'.repeat(8192);
    emitter.emit('message', Buffer.from(JSON.stringify({ type: 'spontaneous_vision_comment', text })));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(spoken, []);
    assert.deepEqual(history, []);
    assert.deepEqual(displayed, []);
    visionManager.dispose();
    console.log('listener survived');
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', code],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'listener survived');
});

test('TTS preserves Markdown link words before removing unknown bracket tags', () => {
  assert.equal(prepareTtsText('Aku [suka](https://example.invalid/) kopi!', 'netral'),
    '[calm] [warm] Aku suka kopi!');
});

test('short sentences merge until the minimum while retaining punctuation and words', () => {
  const merger = new SentenceMerger({ enabled: true, minChars: 25, maxChars: 60 });
  assert.deepEqual(merger.push('Ya.'), []);
  assert.deepEqual(merger.push('Aku senang sekali bertemu kamu!'), ['Ya. Aku senang sekali bertemu kamu!']);
  assert.deepEqual(merger.finish(), []);
});

test('short sentence merger flushes before its maximum and flushes a short final tail', () => {
  const merger = new SentenceMerger({ enabled: true, minChars: 25, maxChars: 30 });
  assert.deepEqual(merger.push('Halo sayang.'), []);
  assert.deepEqual(merger.push('Aku senang bertemu kamu.'), ['Halo sayang.']);
  assert.deepEqual(merger.finish(), ['Aku senang bertemu kamu.']);
});

test('disabled short sentence merging keeps short sentences and indivisible long words', () => {
  const disabled = new SentenceMerger({ enabled: false, minChars: 25, maxChars: 30 });
  assert.deepEqual(disabled.push('Ya.'), ['Ya.']);
  assert.deepEqual(disabled.finish(), []);
  const enabled = new SentenceMerger({ enabled: true, minChars: 25, maxChars: 30 });
  assert.deepEqual(enabled.push('Kalimat ini memang sudah lebih panjang daripada batas.'),
    ['Kalimat ini memang sudah lebih panjang daripada batas.']);
});

test('Fish sends configurable start params and bracket tags for every sentence', async t => {
  const { adapter, state } = await fixture(t, fish);
  await collect(adapter.stream(requestFor(fish, { text: 'Halo sayang! Aku senang.', emotion: 'kagum' })));
  assert.equal(state.frames.find(frame => frame.event === 'text').text, '[excited] Halo sayang! [excited] Aku senang.');
  const start = state.frames.find(frame => frame.event === 'start').request;
  assert.equal(start.temperature, 0.8);
  assert.equal(start.top_p, 0.7);
  assert.equal(start.latency, 'balanced');
  assert.deepEqual(start.prosody, { speed: 1, volume: 0 });
  assert.equal(start.format, 'mp3');
  assert.equal(state.requests[0].headers.model, 'fixture-model');
});

test('Fish first-only placement spans consecutive requests using sentence indexes', async t => {
  const { adapter, state } = await fixture(t, fish, {
    adapterOptions: { params: { expression: { tagPlacement: 'first-only' } } },
  });
  await collect(adapter.stream(requestFor(fish, { text: 'Halo!', emotion: 'kagum', sentenceIndex: 0 })));
  await collect(adapter.stream(requestFor(fish, { text: 'Aku senang.', emotion: 'kagum', sentenceIndex: 1 })));
  assert.deepEqual(state.frames.filter(frame => frame.event === 'text').map(frame => frame.text),
    ['[excited] Halo!', 'Aku senang.']);
});

test('Fish first-only placement in one request prefixes only its first sentence', async t => {
  const { adapter, state } = await fixture(t, fish);
  await collect(adapter.stream(requestFor(fish, {
    text: 'Halo! Aku senang.', emotion: 'kagum', expression: { tagPlacement: 'first-only' },
  })));
  assert.equal(state.frames.find(frame => frame.event === 'text').text, '[excited] Halo! Aku senang.');
});

test('Fish overrides temperature topP latency prosody voice and output format', async t => {
  const { adapter, state } = await fixture(t, fish, {
    adapterOptions: { params: { temperature: 0.5, topP: 0.4, latency: 'low', prosody: { speed: 0.9, volume: -2 } } },
  });
  await collect(adapter.stream(requestFor(fish, {
    text: 'Aku di sini.', temperature: 0.8, topP: 0.9, latency: 'normal',
    prosody: { speed: 1.2, volume: 3 }, voice: 'other-fixture-voice', format: 'wav',
  })));
  const start = state.frames.find(frame => frame.event === 'start').request;
  assert.equal(start.temperature, 0.8);
  assert.equal(start.top_p, 0.9);
  assert.equal(start.latency, 'normal');
  assert.deepEqual(start.prosody, { speed: 1.2, volume: 3 });
  assert.equal(start.reference_id, 'other-fixture-voice');
  assert.equal(start.format, 'wav');
});

test('Fish strips legacy unknown and disallowed tags before sending normalized text', async t => {
  const { adapter, state } = await fixture(t, fish);
  await collect(adapter.stream(requestFor(fish, {
    text: '(sad) **Halo** [invented] sayang! 😊 https://example.invalid/', emotion: 'malu',
  })));
  assert.equal(compact(state.frames.find(frame => frame.event === 'text').text), '[embarrassed] Halo sayang!');
});

test('Fish debug logs final text params and index while redacting every credential source', async t => {
  const headerSecret = 'fixture-private-header-never-log';
  const bodySecret = 'fixture-private-body-key-never-log';
  const records = [];
  t.mock.method(console, 'log', (...args) => records.push(args));
  const { adapter } = await fixture(t, fish, {
    profile: { extraHeaders: { 'X-Trace-Token': headerSecret } },
    adapterOptions: {
      params: { debug: true, bodyExtras: { api_key: bodySecret } },
      secretResolver: { profileSecrets: () => ({ apiKey: SECRET, headers: { 'X-Private-Key': headerSecret }, bodyExtras: { api_key: bodySecret } }) },
    },
  });
  await collect(adapter.stream(requestFor(fish, {
    text: `Ayo! ${SECRET} ${headerSecret} ${bodySecret}`, emotion: 'kagum', sentenceIndex: 3,
  })));
  const debug = records.filter(record => record[0] === '[tts:debug]');
  assert.ok(debug.length >= 1);
  const logged = JSON.stringify(debug);
  assert.ok(logged.includes('[excited]'));
  assert.ok(logged.includes('kagum'));
  assert.ok(logged.includes('sentenceIndex'));
  assert.ok(logged.includes('temperature'));
  for (const secret of [SECRET, headerSecret, bodySecret]) assert.ok(!logged.includes(secret));
  assert.ok(!logged.includes('SGFsbyA=') && !logged.includes('c2F5YW5nLg=='));
  assert.ok(!logged.includes('"audio"') && !logged.includes('"data"'));
});

test('Fish debug is silent by default', async t => {
  const records = [];
  t.mock.method(console, 'log', (...args) => records.push(args));
  const { adapter } = await fixture(t, fish);
  await collect(adapter.stream(requestFor(fish)));
  assert.equal(records.some(record => record[0] === '[tts:debug]'), false);
});

test('Fish debug can be enabled through the environment without persisting settings', async t => {
  const previous = process.env.TTS_DEBUG;
  process.env.TTS_DEBUG = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.TTS_DEBUG;
    else process.env.TTS_DEBUG = previous;
  });
  const records = [];
  t.mock.method(console, 'log', (...args) => records.push(args));
  const { adapter } = await fixture(t, fish);
  await collect(adapter.stream(requestFor(fish, { sentenceIndex: 4 })));
  assert.ok(records.some(record => record[0] === '[tts:debug]'));
  assert.deepEqual(adapter.params, {});
});

test('conversation style preserves the adult character identity and protected moderation', () => {
  const source = fs.readFileSync(new URL('../personality.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const active = source.slice(0, source.indexOf('\n`.trim();'));
  assert.match(active, /Amika, istri dewasa berusia 24 tahun/);
  assert.match(active, /Pengguna adalah suamimu/);
  assert.match(active, /have your own preferences, moods, and opinions/);
  assert.match(active, /Reply length follows the conversation/);
  assert.match(active, /Kalau suami bilang berhenti/);
  assert.match(active, /Kalau ada indikasi yang menyangkut anak/);
  assert.doesNotMatch(active, /1-3 kalimat pendek|sekali tiap 3-4 balasan/);
  for (const [relative, expected] of [
    ['../../config/selfieModeration.json', 'a0e67cbbfe0259f9a966a3725e352223419f2638715ee8ea9094fbd1fb5aa8fd'],
  ]) {
    const actual = createHash('sha256').update(fs.readFileSync(new URL(relative, import.meta.url))).digest('hex');
    assert.equal(actual, expected.toLowerCase(), relative);
  }
});
