import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TTS_PARAMS, FISH_EMOTION_TAGS, emotionMapSelections, updateEmotionSelection, makeTtsParams } from '../../src/settings/viewModel.js';

test('Fish selector values preserve custom tag strings and array entries', () => {
  assert.deepEqual(emotionMapSelections({}, 'kagum'), ['[excited]', '']);
  assert.deepEqual(emotionMapSelections({ netral: [] }, 'netral'), ['', '']);
  assert.deepEqual(emotionMapSelections({ netral: ['[soft, warm and gentle]', '[calm]'] }, 'netral'), ['[soft, warm and gentle]', '[calm]']);
});

test('Fish selector updates copy the map and preserve unrelated tags', () => {
  const map = { kagum: '[excited]', sayang: '[empathetic]', nostalgic: '[moved]' };
  assert.deepEqual(updateEmotionSelection(map, 'kagum', '[delighted]', '[nostalgic]'),
    { kagum: '[delighted] [nostalgic]', sayang: '[empathetic]', nostalgic: '[moved]' });
  assert.equal(map.kagum, '[excited]');
  assert.deepEqual(updateEmotionSelection(map, 'kagum', '', '').kagum, []);
  for (const value of ['(excited)', '[bad][nested]', 'not-a-tag']) {
    assert.throws(() => updateEmotionSelection(map, 'kagum', value, ''), error => error.code === 'INVALID_SETTINGS');
  }
  assert.throws(() => updateEmotionSelection(map, '__proto__', '[happy]', ''), error => error.code === 'INVALID_SETTINGS');
});

test('TTS form accepts every Fish emotion key without expanding the avatar emotion defaults', () => {
  const emotionTagMap = Object.fromEntries(FISH_EMOTION_TAGS.map(tag => [tag.name, tag.tag]));
  const params = makeTtsParams({ topP: '0.7', latency: 'balanced', speed: '1', volume: '0',
    emotionTagMap: JSON.stringify(emotionTagMap), tagPlacement: 'every-sentence', maxTagsPerSentence: '2',
    mergeEnabled: true, minChars: '25', maxChars: '180', inlineEnabled: false,
    inlineAllowList: '', inlineMaxPerSentence: '2', speechStyleEnabled: true, debug: false });
  assert.deepEqual(params.expression.emotionTagMap, emotionTagMap);
  assert.equal(Object.keys(DEFAULT_TTS_PARAMS.expression.emotionTagMap).length, 13);
});
