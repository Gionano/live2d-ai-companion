import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { translator, detectLanguage } from '../../src/settings/i18n.js';
import { createSettingsClient } from '../../src/settings/apiClient.js';
import { mountImageSettings } from '../../src/settings/imageSettings.js';
import { mountMemorySettings } from '../../src/settings/memorySettings.js';
import { node } from '../../src/settings/dom.js';
import * as view from '../../src/settings/viewModel.js';
import * as wizard from '../../src/settings/wizard.js';

const source = name => fs.readFileSync(new URL('../../' + name, import.meta.url), 'utf8');
const id = JSON.parse(source('src/i18n/id.json'));
const en = JSON.parse(source('src/i18n/en.json'));
const presets = JSON.parse(source('src/settings/presets.json'));
const bindings = { id, en, presets, setupGuide: '/docs/setup.md', translator, detectLanguage,
  createSettingsClient, mountImageSettings, mountMemorySettings, node, ...view, ...wizard };
// Load the actual page with the bundler-only JSON/CSS imports supplied as fixtures.
const pageSource = source('src/settings/page.js').replace(/^import .+;\r?\n/gm, '')
  .replace('export async function', 'async function');
const mount = vm.compileFunction(pageSource + '\nreturn mountSettings;', Object.keys(bindings))(...Object.values(bindings));
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

async function pageFixture(t, { ttsParams = {}, language = 'en' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:5173/settings' });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const names = Object.keys(view.SLOT_LABELS);
  const state = { version: 3, settings: {
    profiles: { sample: { adapter: 'openaiCompatible', baseUrl: 'https://example.invalid/v1' } },
    slots: Object.fromEntries(names.map(name => [name,
      name === 'llm' ? { profile: 'sample', model: 'main-model', params: { temperature: 0.4, maxTokens: 800 },
        timeouts: { firstByteMs: 18000, idleMs: 19000, totalMs: 65000 } }
        : ['surface', 'reflection'].includes(name) ? { followLlm: true }
          : name === 'tts' ? { profile: 'sample', model: 'fish-voice', params: ttsParams,
            timeouts: { firstByteMs: 21000, idleMs: 22000, totalMs: 72000 } } : null])),
    ui: { language },
  }, sources: { 'ui.language': 'settings' }, secrets: { sample: { apiKey: { has: false } } } };
  const calls = [];
  const api = {
    get: async path => structuredClone(path === '/' ? state : {
      firstRun: false, backendName: 'encrypted-file',
      slots: Object.fromEntries(names.map(name => [name, { available: name === 'llm' || name === 'tts' }])),
    }),
    write: async (path, body, method) => {
      calls.push({ path, body: structuredClone(body), method });
      if (path.startsWith('/slots/')) state.settings.slots[path.slice('/slots/'.length)] = structuredClone(body.slot);
      return { version: ++state.version };
    },
  };
  await mount({ document, api, storage: dom.window.localStorage, navigatorLanguage: language,
    confirm: () => true });
  // Navigate through the same tab control used outside the first-run wizard.
  const connectionTab = [...document.querySelectorAll('[role="tab"]')]
    .find(element => element.textContent === (language === 'id' ? id : en)['tab.connections']);
  connectionTab.click();
  await settle();
  const translations = language === 'id' ? id : en;
  const form = role => [...document.querySelectorAll('form')]
    .find(element => element.querySelector('h3')?.textContent === translations[view.SLOT_LABELS[role]]);
  const field = (parent, key) => [...parent.querySelectorAll('label')]
    .find(element => element.firstChild?.textContent === translations[key])?.querySelector('input, select, textarea');
  const change = async (input, value) => {
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
  };
  const submit = async parent => {
    parent.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(document.querySelector('.settings-toast').textContent, translations['toast.saved']);
  };
  return { document, calls, state, form, field, change, submit };
}

test('router editor belongs to advanced connections and never follows the main chat model', async t => {
  const page = await pageFixture(t);
  const form = page.form('router');
  assert.ok(form.closest('details'));
  assert.equal(page.field(form, 'slot.follow'), undefined);
  page.field(form, 'slot.profile').value = 'sample';
  page.field(form, 'slot.model').value = 'openai/gpt-oss-20b';
  await page.submit(form);
  assert.equal(page.calls.at(-1).path, '/slots/router');
  assert.equal(page.calls.at(-1).body.slot.model, 'openai/gpt-oss-20b');
  assert.equal(page.calls.at(-1).body.slot.followLlm, undefined);
});

test('actual settings page follows the main model and saves independent surface/reflection models', async t => {
  const page = await pageFixture(t);
  for (const role of ['surface', 'reflection']) {
    let form = page.form(role);
    assert.ok(form.closest('details'), role + ' belongs to advanced connection settings');
    assert.equal(page.field(form, 'slot.follow').checked, true);
    assert.equal(page.field(form, 'slot.model').value, 'main-model');
    await page.change(page.field(form, 'slot.follow'), false);
    assert.deepEqual(page.calls.at(-1).body.slot, page.state.settings.slots.llm);
    form = page.form(role);
    assert.equal(page.field(form, 'slot.follow').checked, false);
    page.field(form, 'slot.model').value = role + '-model';
    page.field(form, 'slot.temperature').value = '0.2';
    await page.submit(form);
    const saved = page.calls.at(-1);
    assert.equal(saved.path, '/slots/' + role);
    assert.equal(saved.body.slot.model, role + '-model');
    assert.equal(saved.body.slot.params.temperature, 0.2);
    assert.equal(saved.body.slot.followLlm, undefined);
    assert.deepEqual(saved.body.slot.timeouts, { firstByteMs: 18000, idleMs: 19000, totalMs: 65000 });
    await page.change(page.field(page.form(role), 'slot.follow'), true);
    assert.deepEqual(page.calls.at(-1).body.slot, { followLlm: true });
  }
  assert.equal(page.state.settings.slots.llm.model, 'main-model');
  assert.ok(page.calls.every((call, index) => call.body.version === 3 + index));
});

test('actual Indonesian TTS settings expose the 200 ms sentence-pause default', async t => {
  const page = await pageFixture(t, { language: 'id' });
  const form = page.form('tts');
  const pause = page.field(form, 'tts.sentencePauseMs');
  assert.equal(pause.value, '200');
  assert.equal(pause.min, '0');
  assert.equal(pause.max, '400');
  assert.ok(form.textContent.includes(id['tts.sentencePauseHelp']));
  assert.equal(page.field(form, 'tts.segmentPauseMs').value, '150');
  await page.submit(form);
  assert.equal(page.calls.at(-1).body.slot.params.expression.sentencePauseMs, 200);
});

test('saving sentence pause preserves configured Fish parameters and timeouts', async t => {
  const params = {
    temperature: 0.61, topP: 0.87, latency: 'low', voice: 'fixture-voice', format: 'opus', maxTokens: 1200,
    prosody: { speed: 1.17, volume: -3 },
    expression: { selection: 'mapped', tagPlacement: 'first-only', maxTagsPerSentence: 1,
      earlyFirstSentence: false, sentencePauseMs: 260, segmentPauseMs: 340,
      emotionTagMap: { ...view.DEFAULT_TTS_PARAMS.expression.emotionTagMap, jahil: '[sarcastic] [confident]' },
      mergeShortSentences: { enabled: false, minChars: 42, maxChars: 210 } },
    inlineTags: { enabled: true, allowList: ['whisper', 'sigh'], maxPerSentence: 1 },
    speechStyle: { enabled: false }, debug: true,
    bodyExtras: { fixtureOption: 7 }, omitParams: ['presence_penalty'],
  };
  const page = await pageFixture(t, { ttsParams: params });
  const form = page.form('tts');
  assert.equal(page.field(form, 'tts.sentencePauseMs').value, '260');
  page.field(form, 'tts.sentencePauseMs').value = '125';
  await page.submit(form);
  const saved = page.calls.at(-1);
  assert.equal(saved.path, '/slots/tts');
  assert.equal(saved.body.version, 3);
  assert.deepEqual(saved.body.slot.params, { ...params, expression: { ...params.expression, sentencePauseMs: 125 } });
  assert.deepEqual(saved.body.slot.timeouts, { firstByteMs: 21000, idleMs: 22000, totalMs: 72000 });
});

test('actual TTS settings reject pauses outside the allowed range without saving', async t => {
  const page = await pageFixture(t);
  const form = page.form('tts');
  page.field(form, 'tts.sentencePauseMs').value = '401';
  form.dispatchEvent(new page.document.defaultView.Event('submit', { cancelable: true }));
  await settle();
  assert.equal(page.calls.length, 0);
  assert.ok(page.document.querySelector('.settings-toast').textContent.includes('INVALID_SETTINGS'));
});
