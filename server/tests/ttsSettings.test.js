import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSlot, validateDocument } from '../settings/schema.js';
import { SettingsService } from '../settings/service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { DEFAULT_TTS_PARAMS, makeSlot, makeTtsParams } from '../../src/settings/viewModel.js';

const slot = params => ({ profile: 'fish', model: 'fixture-model', params });
const form = () => ({
  topP: '0.7', latency: 'balanced', speed: '1', volume: '0',
  emotionTagMap: JSON.stringify(DEFAULT_TTS_PARAMS.expression.emotionTagMap),
  selection: 'native', tagPlacement: 'every-sentence', maxTagsPerSentence: '2',
  mergeEnabled: true, minChars: '25', maxChars: '180',
  inlineEnabled: false, inlineAllowList: 'laughs, sigh, pause, whisper, chuckle, emphasis, break',
  inlineMaxPerSentence: '2', speechStyleEnabled: true, debug: false,
});
const invalid = params => assert.throws(() => validateSlot(slot(params)), error => error.code === 'INVALID_SETTINGS');

test('TTS settings preserve all nested expression and speech controls', () => {
  const params = { ...makeTtsParams(form()), temperature: 0.8, voice: 'fixture-voice', format: 'mp3' };
  assert.deepEqual(validateSlot(slot(params)).slot.params, params);
  assert.equal(Object.keys(params.expression.emotionTagMap).filter(key => ['terkejut', 'marah', 'bingung',
    'jengkel', 'malu', 'kesal', 'sedih', 'kagum', 'sayang', 'jahil', 'penasaran', 'netral'].includes(key)).length, 12);
  const settings = { schemaVersion: 1, profiles: { fish: { adapter: 'fishAudio', baseUrl: 'ws://127.0.0.1:8788' } },
    slots: { tts: slot(params) }, ui: { language: 'id' } };
  assert.deepEqual(validateDocument(settings), settings);
});

test('TTS selection accepts native and mapped and leaves legacy settings unchanged', () => {
  for (const selection of ['native', 'mapped']) {
    const params = { expression: { selection } };
    assert.deepEqual(validateSlot(slot(params)).slot.params, params);
  }
  const legacy = { expression: { tagPlacement: 'first-only', emotionTagMap: { sayang: '[empathetic]' } } };
  assert.deepEqual(validateSlot(slot(legacy)).slot.params, legacy);
  assert.equal(DEFAULT_TTS_PARAMS.expression.selection, 'native');
  for (const selection of [null, '', 'random', 'NATIVE', 1, {}]) invalid({ expression: { selection } });
});

test('TTS settings survive effective serialization, persistence and registry reload', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const params = { ...makeTtsParams(form()), temperature: 0.8, format: 'mp3' };
  const layers = { defaults: { profiles: { fish: { adapter: 'fishAudio', baseUrl: 'ws://127.0.0.1:8788' } },
    slots: { tts: slot(params) } }, dev: {} };
  const options = { repoRoot: directory, localDir: directory, env: {}, platform: 'linux', allowPlaintext: true, layers };
  const service = new SettingsService(options);
  const registry = new ProviderRegistry({ config: service.config(), secretResolver: service.resolver() });
  service.attach(registry);
  assert.deepEqual(service.effective().settings.slots.tts.params, params);
  const replacement = { ...params, topP: 0.41, prosody: { speed: 1.01, volume: 0.5 },
    expression: { ...params.expression, selection: 'mapped' }, speechStyle: { enabled: false } };
  service.putSlot('tts', { version: 0, slot: slot(replacement) });
  assert.deepEqual(service.effective().settings.slots.tts.params, replacement);
  assert.deepEqual(service.export().slots.tts.params, replacement);
  assert.deepEqual(registry.getTts().params, replacement);
  assert.deepEqual(new SettingsService(options).config().slots.tts.params, replacement);
});

test('TTS settings accept bracket strings, arrays and explicit empty emotion maps', () => {
  for (const tags of ['[excited] [happy]', '[soft, warm and gentle]', ['[excited]', '[happy]'], []]) {
    const params = { expression: { emotionTagMap: { kagum: tags }, tagPlacement: 'first-only', maxTagsPerSentence: 1 } };
    assert.deepEqual(validateSlot(slot(params)).slot.params, params);
  }
  assert.deepEqual(validateSlot(slot({ expression: { emotionTagMap: {} } })).slot.params.expression.emotionTagMap, {});
  const fields = { ...form(), topP: '0.00000001', emotionTagMap: JSON.stringify({ netral: '[soft, warm and gentle]' }) };
  assert.equal(makeTtsParams(fields).expression.emotionTagMap.netral, '[soft, warm and gentle]');
  assert.equal(makeTtsParams(fields).topP, 0.00000001);
});

test('TTS settings reject malformed tags, unknown emotions and secret-like tags', () => {
  for (const tags of ['(excited)', 'excited', '[excited] trailing', '[bad\nvalue]', '[sk-' + 'x'.repeat(24) + ']']) {
    invalid({ expression: { emotionTagMap: { kagum: tags } } });
  }
  invalid({ expression: { emotionTagMap: { unrelated: '[happy]' } } });
  invalid({ expression: { emotionTagMap: { kagum: Array(9).fill('[happy]') } } });
  invalid({ expression: { emotionTagMap: JSON.parse('{"__proto__":"[happy]"}') } });
});

test('TTS settings reject invalid numeric ranges and nested fields', () => {
  for (const params of [
    { topP: 0 }, { topP: null }, { topP: 1.1 }, { topP: '0.7' }, { latency: 'fast' }, { debug: 'true' },
    { prosody: { speed: 0.49 } }, { prosody: { volume: 21 } }, { prosody: { pitch: 1 } },
    { expression: { tagPlacement: 'last' } }, { expression: { maxTagsPerSentence: 3 } },
    { expression: { maxTagsPerSentence: 1.5 } }, { expression: { unsupported: true } },
    { expression: { mergeShortSentences: { enabled: 1 } } },
    { expression: { mergeShortSentences: { minChars: 0, maxChars: 100 } } },
    { expression: { mergeShortSentences: { minChars: 100, maxChars: 99 } } },
    { expression: { mergeShortSentences: { minChars: 25.5 } } },
    { speechStyle: { enabled: 'true' } }, { speechStyle: { prompt: 'override' } },
  ]) invalid(params);
});

test('TTS settings reject partial merge limits inconsistent with effective defaults', () => {
  for (const mergeShortSentences of [{ maxChars: 10 }, { minChars: 181 }]) {
    invalid({ expression: { mergeShortSentences } });
  }
  for (const mergeShortSentences of [{ maxChars: 25 }, { minChars: 180 }]) {
    assert.deepEqual(validateSlot(slot({ expression: { mergeShortSentences } })).slot.params.expression.mergeShortSentences,
      mergeShortSentences);
  }
});

test('TTS format settings accept implemented formats and reject unsupported formats', () => {
  for (const format of ['mp3', 'wav', 'pcm', 'opus']) assert.equal(validateSlot(slot({ format })).slot.params.format, format);
  for (const format of ['ogg', '', 'MP3', null]) invalid({ format });
});

test('TTS inline cue schema is bounded and accepts allow-list break', () => {
  assert.deepEqual(validateSlot(slot({ inlineTags: { enabled: true, allowList: ['laughs', 'break'], maxPerSentence: 2 } })).slot.params.inlineTags,
    { enabled: true, allowList: ['laughs', 'break'], maxPerSentence: 2 });
  for (const inlineTags of [{ enabled: 1 }, { allowList: ['[laughs]'] }, { allowList: ['(break)'] },
    { allowList: ['Bearer private-credential'] }, { allowList: Array(33).fill('laughs') },
    { maxPerSentence: 3 }, { maxPerSentence: 1.5 }, { other: true }]) invalid({ inlineTags });
});

test('TTS GUI form saves typed controls and preserves existing slot options', () => {
  const previous = slot({ voice: 'original-voice', bodyExtras: { vendorOption: true },
    expression: { tagPlacement: 'first-only' } });
  const original = structuredClone(previous);
  const result = makeSlot({ profile: 'fish', model: 'fixture-model', temperature: '0.8', maxTokens: '',
    firstByteMs: '20000', idleMs: '20000', totalMs: '60000', advanced: '{}', tts: form() }, previous);
  assert.equal(result.params.temperature, 0.8);
  assert.equal(result.params.topP, 0.7);
  assert.equal(result.params.voice, 'original-voice');
  assert.equal(result.params.expression.tagPlacement, 'every-sentence');
  assert.equal(result.params.expression.selection, 'native');
  assert.equal(result.params.inlineTags.enabled, false);
  assert.deepEqual(previous, original);
  assert.deepEqual(validateSlot(result).slot, result);
});

test('TTS GUI selection remains independent of spoken style and preserves omitted legacy controls', () => {
  for (const selection of ['native', 'mapped']) {
    const params = makeTtsParams({ ...form(), selection, speechStyleEnabled: false });
    assert.equal(params.expression.selection, selection);
    assert.equal(params.speechStyle.enabled, false);
    assert.deepEqual(validateSlot(slot(params)).slot.params, params);
  }
  const legacyForm = form();
  delete legacyForm.selection;
  assert.equal(makeTtsParams(legacyForm).expression.selection, 'native');
  assert.equal(makeTtsParams(legacyForm, { expression: { selection: 'mapped' } }).expression.selection, 'mapped');
});

test('TTS GUI form rejects malformed and out-of-range controls before transport', () => {
  for (const changes of [{ topP: '' }, { topP: '0' }, { latency: 'fast' }, { speed: '3' }, { volume: '-21' },
    { emotionTagMap: '{broken' }, { emotionTagMap: '{"netral":"(calm)"}' },
    { emotionTagMap: '{"unknown":"[happy]"}' }, { maxTagsPerSentence: '3' },
    { minChars: '30', maxChars: '20' }, { inlineAllowList: 'laughs, [pause]' },
    { inlineMaxPerSentence: '2.1' }, { debug: 'true' }, { selection: null }, { selection: '' },
    { selection: 'random' }, { selection: 'NATIVE' }]) {
    assert.throws(() => makeTtsParams({ ...form(), ...changes }), error => error.code === 'INVALID_SETTINGS');
  }
});

test('TTS GUI form preserves valid fractional sampling and prosody values', () => {
  const params = makeTtsParams({ ...form(), topP: '0.005', speed: '1.01', volume: '0.5' });
  assert.equal(params.topP, 0.005);
  assert.deepEqual(params.prosody, { speed: 1.01, volume: 0.5 });
  assert.deepEqual(validateSlot(slot(params)).slot.params, params);
});

test('TTS GUI form rejects an unsupported format before transport', () => {
  assert.throws(() => makeSlot({ profile: 'fish', model: 'fixture-model', temperature: '0.8', maxTokens: '',
    firstByteMs: '20000', idleMs: '20000', totalMs: '60000', advanced: '{}', format: 'ogg', tts: form() }),
  error => error.code === 'INVALID_SETTINGS');
});

test('ordinary LLM slot form does not gain TTS defaults', () => {
  const result = makeSlot({ profile: 'sample', model: 'fixture-model', temperature: '0.2', maxTokens: '100',
    firstByteMs: '0', idleMs: '1000', totalMs: '20000', advanced: '{}' });
  assert.deepEqual(result.params, { temperature: 0.2, maxTokens: 100 });
});
