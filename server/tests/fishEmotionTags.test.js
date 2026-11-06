import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FISH_EMOTION_GROUPS, FISH_EMOTION_NAMES, FISH_EMOTION_TAGS } from '../fishEmotionTags.js';
import { DEFAULT_EMOTION_TAG_MAP, prepareTtsText } from '../ttsExpression.js';
import { REPLY_EMOTIONS } from '../llmChat.js';
import { validateSlot } from '../settings/schema.js';
import { SettingsService } from '../settings/service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { fixture, ADAPTER_CASES, collect } from './providerFixtures.js';

const BASIC_EMOTIONS = [
  'happy', 'sad', 'angry', 'excited', 'calm', 'nervous', 'confident', 'surprised',
  'satisfied', 'delighted', 'scared', 'worried', 'upset', 'frustrated', 'depressed',
  'empathetic', 'embarrassed', 'disgusted', 'moved', 'proud', 'relaxed', 'grateful',
  'curious', 'sarcastic',
];
const ADVANCED_EMOTIONS = [
  'disdainful', 'unhappy', 'anxious', 'hysterical', 'indifferent', 'uncertain',
  'doubtful', 'confused', 'disappointed', 'regretful', 'guilty', 'ashamed', 'jealous',
  'envious', 'hopeful', 'optimistic', 'pessimistic', 'nostalgic', 'lonely', 'bored',
  'contemptuous', 'sympathetic', 'compassionate', 'determined', 'resigned',
];
const AVATAR_EMOTIONS = [
  'terkejut', 'marah', 'bingung', 'jengkel', 'malu', 'kesal',
  'sedih', 'kagum', 'sayang', 'jahil', 'penasaran', 'netral',
];
const ALL_EMOTIONS = [...BASIC_EMOTIONS, ...ADVANCED_EMOTIONS];
const slot = emotionTagMap => ({ profile: 'fish', model: 'fixture-model',
  params: { expression: { emotionTagMap } } });

test('Fish catalogue contains the complete supplied Basic and Advanced groups without duplicates', () => {
  assert.deepEqual(FISH_EMOTION_GROUPS.map(group => group.id), ['basic', 'advanced']);
  assert.deepEqual(FISH_EMOTION_GROUPS[0].tags.map(item => item.name), BASIC_EMOTIONS);
  assert.deepEqual(FISH_EMOTION_GROUPS[1].tags.map(item => item.name), ADVANCED_EMOTIONS);
  assert.equal(FISH_EMOTION_GROUPS[0].tags.length, 24);
  assert.equal(FISH_EMOTION_GROUPS[1].tags.length, 25);
  assert.equal(FISH_EMOTION_TAGS.length, 49);
  assert.equal(new Set(FISH_EMOTION_NAMES).size, 49);
  assert.deepEqual(FISH_EMOTION_NAMES, ALL_EMOTIONS);
  for (const item of FISH_EMOTION_TAGS) {
    assert.equal(item.tag, `[${item.name}]`);
    assert.match(item.labelKey, /^tts\.emotion[A-Z]/);
  }
  assert.throws(() => { FISH_EMOTION_GROUPS[0].tags[0].tag = '[unknown]'; }, TypeError);
  assert.throws(() => FISH_EMOTION_GROUPS[0].tags.push({ name: 'unknown' }), TypeError);
  assert.equal(prepareTtsText('Halo!', 'happy'), '[happy] Halo!');
});

test('all 49 catalogue emotion names reach Fish as one bracket prefix per sentence', async t => {
  const { adapter, state } = await fixture(t, ADAPTER_CASES.find(item => item.id === 'fishAudio'));
  for (const emotion of ALL_EMOTIONS) {
    const events = await collect(adapter.stream({ text: 'Halo! Sampai nanti.', emotion }));
    assert.equal(events.filter(event => event.type === 'audio').length, 2, emotion);
  }
  assert.equal(state.requests.length, 49);
  assert.deepEqual(state.frames.filter(frame => frame.event === 'text').map(frame => frame.text),
    ALL_EMOTIONS.map(emotion => `[${emotion}] Halo! [${emotion}] Sampai nanti.`));
});

test('all catalogue names survive settings persistence, export and TTS registry reload', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-catalogue-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const emotionTagMap = Object.fromEntries(ALL_EMOTIONS.map(emotion => [emotion, `[${emotion}]`]));
  const savedSlot = slot(emotionTagMap);
  assert.deepEqual(validateSlot(savedSlot).slot, savedSlot);
  const options = { repoRoot: directory, localDir: directory, env: {}, platform: 'linux', allowPlaintext: true,
    layers: { defaults: { profiles: { fish: { adapter: 'fishAudio', baseUrl: 'ws://127.0.0.1:8788' } },
      slots: { tts: { profile: 'fish', model: 'fixture-model' } } }, dev: {} } };
  const service = new SettingsService(options);
  const registry = new ProviderRegistry({ config: service.config(), secretResolver: service.resolver() });
  service.attach(registry);
  service.putSlot('tts', { version: 0, slot: savedSlot });
  assert.deepEqual(service.export().slots.tts.params.expression.emotionTagMap, emotionTagMap);
  assert.deepEqual(registry.getTts().params.expression.emotionTagMap, emotionTagMap);
  assert.deepEqual(new SettingsService(options).config().slots.tts.params.expression.emotionTagMap, emotionTagMap);
});

test('catalogue support rejects unknown map keys and does not invent a TTS tag for unknown emotions', () => {
  assert.throws(() => validateSlot(slot({ unknown: '[happy]' })), error => error.code === 'INVALID_SETTINGS');
  assert.throws(() => validateSlot(slot(JSON.parse('{"__proto__":"[happy]"}'))), error => error.code === 'INVALID_SETTINGS');
  assert.equal(prepareTtsText('Halo!', 'unknown'), 'Halo!');
});

test('full Fish catalogue preserves the twelve avatar emotions and experimental neutral default', () => {
  assert.deepEqual([...REPLY_EMOTIONS], AVATAR_EMOTIONS);
  assert.deepEqual(Object.keys(DEFAULT_EMOTION_TAG_MAP), AVATAR_EMOTIONS);
  for (const emotion of AVATAR_EMOTIONS) {
    assert.equal(prepareTtsText('Halo!', emotion), `${DEFAULT_EMOTION_TAG_MAP[emotion]} Halo!`);
  }
  assert.equal(prepareTtsText('Halo!', 'shy'), '[embarrassed] Halo!');
  assert.equal(prepareTtsText('Halo!', 'neutral'), '[calm] [warm] Halo!');
});

test('configured catalogue emotion tags retain override precedence and sentence tag caps', async t => {
  const { adapter, state } = await fixture(t, ADAPTER_CASES.find(item => item.id === 'fishAudio'), {
    adapterOptions: { params: { expression: { emotionTagMap: { nostalgic: '[moved] [sad] [calm]' }, maxTagsPerSentence: 2 } } },
  });
  await collect(adapter.stream({ text: 'Aku kangen!', emotion: 'nostalgic' }));
  assert.equal(state.frames.find(frame => frame.event === 'text').text, '[moved] [sad] Aku kangen!');
});
