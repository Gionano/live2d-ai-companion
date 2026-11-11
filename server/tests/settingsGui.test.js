import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { translator, detectLanguage } from '../../src/settings/i18n.js';
import { createSettingsClient } from '../../src/settings/apiClient.js';
import { mountImageSettings } from '../../src/settings/imageSettings.js';
import { mountMemorySettings } from '../../src/settings/memorySettings.js';
import { node } from '../../src/settings/dom.js';
import * as view from '../../src/settings/viewModel.js';
import * as wizard from '../../src/settings/wizard.js';
import { SettingsWindowManager, settingsMenuItem } from '../../desktop-companion/src/main/settingsWindowManager.js';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';

const source = name => fs.readFileSync(new URL('../../' + name, import.meta.url), 'utf8');
const id = JSON.parse(source('src/i18n/id.json'));
const en = JSON.parse(source('src/i18n/en.json'));
const presets = JSON.parse(source('src/settings/presets.json'));
const SECRET = 'gui-fixture-private-value';
const XSS = '<img src=x onerror=alert(1)>';
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('settings eligibility excludes LAN hosts and mobile devices', () => {
  for (const hostname of ['localhost', '127.0.0.1', '[::1]']) assert.equal(view.canOpenSettings({ hostname }), true);
  for (const hostname of ['192.168.1.2', 'example.invalid', 'localhost.evil']) assert.equal(view.canOpenSettings({ hostname }), false);
  assert.equal(view.canOpenSettings({ hostname: 'localhost', mobile: true }), false);
});
test('settings entry loads no inline scripts and separates settings from capture startup', () => {
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(source('index.html')), false);
  const boot = source('src/bootstrap.js');
  assert.ok(boot.indexOf('if (settingsPage)') < boot.indexOf("import('./companion.js')"));
  assert.match(boot, /canOpenSettings/);
  assert.match(boot, /desktopBridge\.openSettings\(true\)/);
  assert.equal(/localStorage|sessionStorage/.test(source('src/settings/apiClient.js')), false);
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(source('src/settings/page.js')), false);
});
test('wizard persists only a validated step and completion flag', () => {
  const writes = [];
  const storage = { setItem: (...args) => writes.push(args) };
  const state = wizard.moveWizard(wizard.readWizard('broken'), 'next');
  assert.equal(state.step, 'llm');
  wizard.saveWizard(storage, { ...state, token: SECRET, apiKey: SECRET });
  assert.equal(JSON.stringify(writes).includes(SECRET), false);
  assert.deepEqual(wizard.readWizard(writes[0][1]), state);
  assert.equal(wizard.moveWizard({ step: 'finish' }, 'finish').completed, true);
  assert.equal(wizard.needsWizard({ firstRun: false }, { slots: { llm: null } }), true);
});
test('view models validate numbers, endpoints, JSON and origin-bound credentials', () => {
  assert.throws(() => view.validateBaseUrl(['https://user:password', 'example.invalid'].join('@')));
  assert.equal(view.validateBaseUrl('http://127.0.0.1:1234').insecureTransport, true);
  assert.throws(() => view.parseAdvanced('{oops'));
  assert.throws(() => view.parseAdvanced('{"moderation":false}'));
  assert.equal(view.parseAdvanced('{"bodyExtras":{"token":"fixture"}}').credentials, true);
  assert.equal(view.originNeedsConfirmation({ adapter: 'openaiCompatible', baseUrl: 'https://a.invalid' },
    { adapter: 'openaiCompatible', baseUrl: 'https://b.invalid' }, { apiKey: { has: true } }), true);
  const fields = { profile: 'sample', model: 'one', temperature: '0.2', maxTokens: '100', firstByteMs: '0', idleMs: '1000', totalMs: '20000', advanced: '{}' };
  assert.equal(view.makeSlot(fields).params.temperature, 0.2);
  assert.throws(() => view.makeSlot({ ...fields, temperature: '3' }));
  assert.equal(view.privacyFlows({ profiles: { sample: { adapter: 'openaiCompatible', baseUrl: 'https://example.invalid/private/path' } }, slots: { llm: { profile: 'sample' } } })[1].origin, 'https://example.invalid');
});
test('secret field is cleared before transport and remains empty on failure', async () => {
  const field = { value: SECRET };
  await assert.rejects(view.withSecret(field, async value => {
    assert.equal(value, SECRET); assert.equal(field.value, ''); throw new Error('fixture');
  }));
  assert.equal(field.value, '');
});
test('API client keeps tokens in memory and supplies same-origin safe request headers', async () => {
  const calls = [];
  const token = 'f'.repeat(64);
  const client = createSettingsClient(async (url, options) => {
    calls.push({ url, options }); return json(url.endsWith('/bootstrap') ? { token } : { version: 1 });
  });
  await client.write('/secrets/sample', { version: 0, values: { apiKey: SECRET } });
  await client.write('/ui', { version: 1, ui: { language: 'id' } });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].options.headers['X-Settings-Token'], token);
  assert.equal(calls[1].options.credentials, 'same-origin');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[1].options.cache, 'no-store');
  assert.equal(calls.some(call => call.url.includes(SECRET) || call.url.includes(token)), false);
  assert.equal(JSON.stringify(client).includes(token), false);
});
test('API client maps server errors without retaining provider messages and parses split progress', async () => {
  const client = createSettingsClient(async url => url.endsWith('/bootstrap') ? json({ token: 'a'.repeat(64) })
    : new Response(JSON.stringify({ error: { code: 'CONFLICT', message: SECRET } }), { status: 409 }));
  await assert.rejects(client.write('/ui', {}), error => error.code === 'CONFLICT' && !error.message.includes(SECRET));
  const events = [];
  const streamClient = createSettingsClient(async url => {
    if (url.endsWith('/bootstrap')) return json({ token: 'a'.repeat(64) });
    return new Response(new ReadableStream({ start(controller) {
      for (const value of ['{"phase":"connecting"}\n{"pha', 'se":"first_byte"}\n{"phase":"done"}\n', '{"result":{"ok":true}}\n']) controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    } }), { headers: { 'content-type': 'application/x-ndjson' } });
  });
  assert.equal((await streamClient.test({ slot: 'llm' }, phase => events.push(phase))).ok, true);
  assert.deepEqual(events, ['connecting', 'first_byte', 'done']);
});

class Element {
  constructor(tag, document) { this.tagName = tag; this.document = document; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this.ownText = ''; }
  set innerHTML(_value) { throw new Error('Markup assignment is forbidden.'); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(value => value.textContent).join(''); }
  get id() { return this.attributes.id; }
  set id(value) { this.attributes.id = value; }
  get parentElement() { return this.parent; }
  get lastElementChild() { return this.children.at(-1); }
  get ownerDocument() { return this.document; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.ownText = ''; this.append(...children); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; } }
  replaceWith(next) { const parent = this.parent; const index = parent.children.indexOf(this); next.remove(); parent.children[index] = next; next.parent = parent; this.parent = null; }
  contains(element) { return walk(this).includes(element); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  fire(name, event = {}) { for (const callback of this.listeners[name] || []) callback({ preventDefault() {}, ...event }); }
  focus() { this.document.activeElement = this; }
}
const walk = item => [item, ...item.children.flatMap(walk)];
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function pageFixture(ttsParams = null, language = 'en', options = {}) {
  const document = { createElement: tag => new Element(tag, document), createElementNS: (_namespace, tag) => new Element(tag, document),
    getElementById: id => walk(document.body).find(value => value.id === id), defaultView: { addEventListener() {}, removeEventListener() {} } };
  document.body = new Element('body', document); document.documentElement = {};
  const names = Object.keys(view.SLOT_LABELS);
  const state = { version: 0, settings: { profiles: { sample: { adapter: 'openaiCompatible', baseUrl: 'https://example.invalid/v1' }, ...options.profiles },
    slots: Object.fromEntries(names.map(name => [name, name === 'llm' ? { profile: 'sample', model: 'fixture' }
      : name === 'tts' && options.ttsSlot ? options.ttsSlot
        : name === 'tts' && ttsParams ? { profile: 'sample', model: 'fixture-tts', params: ttsParams } : null])), ui: { language } },
    sources: { 'ui.language': 'settings' }, secrets: { sample: { apiKey: { has: false } } } };
  Object.assign(state.settings.slots, options.slots || {});
  const calls = [];
  const api = { get: async path => structuredClone(path === '/' ? state : path === '/images' ? { ready: false } : {
    firstRun: false, backendName: 'plaintext-file', slots: Object.fromEntries(names.map(name => [name, { available: name === 'llm' }])) }),
    write: async (path, body, method) => {
      calls.push({ path, body: structuredClone(body), method });
      if (path === '/models') return { models: [XSS], reason: null };
      if (path === '/diagnostics') return { backendName: 'plaintext-file', version: 0, permissionNote: 'OWNER_ONLY_RECOMMENDED',
        writable: true, locations: { 'settings.json': '<local>/settings.json' }, locks: {}, corruptBackups: 0, selfTest: { ok: true, code: null } };
      if (path.startsWith('/profiles/')) {
        const name = path.slice('/profiles/'.length);
        state.settings.profiles[name] = body.profile;
        state.secrets[name] = { apiKey: { has: Boolean(body.secrets?.apiKey) } };
      }
      if (path.startsWith('/slots/')) state.settings.slots[path.slice('/slots/'.length)] = body.slot;
      if (path === '/ui') state.settings.ui = body.ui;
      return { version: ++state.version };
    } };
  const bindings = { id, en, presets, setupGuide: '/docs/setup.md', translator, detectLanguage, createSettingsClient, mountImageSettings, mountMemorySettings, node, ...view, ...wizard };
  const code = source('src/settings/page.js').replace(/^import .+;\r?\n/gm, '').replace('export async function', 'async function');
  const mount = vm.compileFunction(code + '\nreturn mountSettings;', Object.keys(bindings))(...Object.values(bindings));
  const storageWrites = [];
  await mount({ document, api, storage: options.storage || { getItem: () => '{"step":"finish","completed":true}',
    setItem: (...args) => storageWrites.push(args) }, navigatorLanguage: language, confirm: options.confirm || (() => true) });
  const navigate = async name => {
    walk(document.body).find(item => item.attributes['data-settings-tab'] === name).fire('click'); await settle();
  };
  const initialTab = options.tab || (ttsParams !== null || options.ttsSlot ? 'voice' : null);
  if (initialTab) await navigate(initialTab);
  return { document, calls, api, state, navigate, storageWrites, nodes: () => walk(document.body) };
}
test('settings page renders malicious model names using textContent and labelled fields', async () => {
  const page = await pageFixture();
  const models = page.nodes().find(item => item.tagName === 'button' && item.textContent === en['action.models']);
  models.fire('click'); await settle();
  assert.ok(page.nodes().some(item => item.tagName === 'option' && item.textContent === XSS));
  for (const input of page.nodes().filter(item => ['input', 'select', 'textarea'].includes(item.tagName))) {
    assert.ok(page.nodes().some(label => label.tagName === 'label' && label.attributes.for === input.id));
  }
  assert.ok(page.nodes().some(item => item.attributes['aria-live'] === 'polite'));
});

test('Fish preset selectors show every Basic and Advanced tag in both languages', async () => {
  for (const language of ['id', 'en']) {
    const page = await pageFixture({}, language);
    const rows = page.nodes().filter(item => item.attributes['data-avatar-emotion']);
    assert.equal(rows.length, 13);
    const inputs = walk(rows[0]).filter(item => item.tagName === 'select');
    assert.equal(inputs.length, 2);
    for (const input of inputs) {
      const groups = input.children.filter(item => item.tagName === 'optgroup');
      assert.deepEqual(groups.map(group => group.children.length), [24, 25]);
      assert.deepEqual(groups.map(group => group.attributes.label), view.FISH_EMOTION_GROUPS.map(group => (language === 'id' ? id : en)[group.labelKey]));
      assert.deepEqual(groups.flatMap(group => group.children.map(option => option.attributes.value)), view.FISH_EMOTION_TAGS.map(tag => tag.tag));
      assert.ok(groups.every(group => group.children.every(option => !option.textContent.startsWith('tts.'))));
    }
  }
});

test('speech emotion selection shows translated choices and defaults to native for existing slots', async () => {
  for (const language of ['id', 'en']) {
    const labels = language === 'id' ? id : en;
    const page = await pageFixture({}, language);
    const input = page.nodes().find(item => item.tagName === 'select' && item.parent.ownText === labels['tts.selection']);
    assert.equal(input.value, 'native');
    assert.deepEqual(input.children.map(option => [option.attributes.value, option.textContent]), [
      ['native', labels['tts.selectionNative']], ['mapped', labels['tts.selectionMapped']],
    ]);
    assert.ok(page.nodes().some(item => item.tagName === 'p' && item.textContent === labels['tts.selectionHelp']));
    assert.ok(page.nodes().some(item => item.tagName === 'p' && item.textContent === labels['tts.emotionPresetsHelp']));
  }
});

test('speech emotion selection saves mapped and native without enabling spoken style or losing mappings', async () => {
  for (const selection of ['mapped', 'native']) {
    const originalSelection = selection === 'native' ? 'mapped' : 'native';
    const page = await pageFixture({ expression: { selection: originalSelection, emotionTagMap: { sayang: '[compassionate]' } },
      speechStyle: { enabled: false } });
    const input = page.nodes().find(item => item.tagName === 'select' && item.parent.ownText === en['tts.selection']);
    assert.equal(input.value, originalSelection);
    input.value = selection;
    let form = input.parent;
    while (form.tagName !== 'form') form = form.parent;
    form.fire('submit'); await settle();
    const saved = page.calls.find(call => call.path === '/slots/tts').body.slot.params;
    assert.equal(saved.expression.selection, selection);
    assert.equal(saved.expression.emotionTagMap.sayang, '[compassionate]');
    assert.equal(saved.speechStyle.enabled, false);
  }
});

const voiceForm = page => page.nodes().find(item => item.tagName === 'form'
  && item.children.some(child => child.tagName === 'h3' && child.textContent === en['slot.tts']));
const formField = (form, key, visible = true) => walk(form).find(item => ['input', 'select', 'textarea'].includes(item.tagName)
  && item.parent.ownText === en[key] && (!visible || !item.disabled));
const elevenProfiles = { eleven: { adapter: 'elevenLabs', baseUrl: 'https://api.elevenlabs.io/v1', apiKeyEnv: 'ELEVENLABS_API_KEY' },
  sample: { adapter: 'fishAudio', baseUrl: 'wss://fish.example.invalid' } };

test('saving Drama 3 with a blank Fish voice preserves the model and selects the configured default', async () => {
  const page = await pageFixture({ voice: 'previous-fish-voice' }, 'en', { profiles: elevenProfiles });
  const form = voiceForm(page);
  const voice = formField(form, 'slot.voice');
  const help = page.document.getElementById(voice.attributes['aria-describedby']);
  assert.equal(help.textContent, en['tts.fishVoiceHelp']);
  assert.equal(help.attributes.hidden, undefined);
  formField(form, 'slot.model').value = 'drama-3';
  voice.value = '   ';
  form.fire('submit'); await settle();
  const saved = page.calls.find(call => call.path === '/slots/tts').body.slot;
  assert.equal(saved.model, 'drama-3');
  assert.equal(Object.hasOwn(saved.params, 'voice'), false);
  assert.equal(page.state.settings.slots.tts.model, 'drama-3');
  assert.equal(Object.hasOwn(page.state.settings.slots.tts.params, 'voice'), false);
});

test('ElevenLabs preset supplies its adapter, endpoint and backend key name without changing the voice slot', async () => {
  const page = await pageFixture(null, 'en', { tab: 'connections' });
  const preset = page.nodes().find(item => item.tagName === 'select' && item.parent.ownText === en['provider.preset']);
  preset.value = 'elevenlabs'; preset.fire('change');
  const form = preset.parent.parent;
  assert.equal(formField(form, 'provider.adapter').value, 'elevenLabs');
  assert.equal(formField(form, 'provider.url').value, 'https://api.elevenlabs.io/v1');
  assert.equal(formField(form, 'provider.environment').value, 'ELEVENLABS_API_KEY');
  for (const name of ['fish', 'custom']) {
    preset.value = name; preset.fire('change');
    assert.equal(formField(form, 'provider.environment').value, '');
    preset.value = 'elevenlabs'; preset.fire('change');
    assert.equal(formField(form, 'provider.environment').value, 'ELEVENLABS_API_KEY');
  }
  assert.equal(page.calls.length, 0);
  assert.equal(page.state.settings.slots.tts, null);
});

test('switching voice providers preserves unsaved Fish values and keeps ElevenLabs voice separate', async () => {
  const page = await pageFixture({ voice: 'fish-voice', format: 'wav', topP: 0.63 }, 'en', { profiles: elevenProfiles });
  const form = voiceForm(page);
  const profile = formField(form, 'slot.profile');
  formField(form, 'slot.voice').value = 'edited-fish-voice';
  formField(form, 'tts.topP').value = '0.42';
  profile.value = 'eleven'; profile.fire('change');
  assert.equal(formField(form, 'slot.model').value, 'eleven_flash_v2_5');
  assert.equal(formField(form, 'slot.voice').value, '');
  assert.deepEqual(formField(form, 'slot.format').children.map(option => option.attributes.value), ['mp3']);
  assert.equal(formField(form, 'tts.topP'), undefined);
  assert.equal(formField(form, 'tts.elevenStability').value, 0.5);
  assert.ok(formField(form, 'tts.mergeEnabled'));
  assert.ok(formField(form, 'tts.sentencePauseMs'));
  formField(form, 'slot.voice').value = 'eleven-voice';
  formField(form, 'tts.elevenSimilarity').value = '0.88';
  profile.value = 'sample'; profile.fire('change');
  assert.equal(formField(form, 'slot.voice').value, 'edited-fish-voice');
  assert.equal(formField(form, 'slot.format').value, 'wav');
  assert.equal(formField(form, 'tts.topP').value, '0.42');
  assert.equal(formField(form, 'tts.elevenStability'), undefined);
  profile.value = 'eleven'; profile.fire('change');
  assert.equal(formField(form, 'slot.voice').value, 'eleven-voice');
  assert.equal(formField(form, 'tts.elevenSimilarity').value, '0.88');
  assert.equal(page.calls.length, 0);
  assert.equal(page.state.settings.slots.tts.profile, 'sample');
});

test('ElevenLabs model controls preserve hidden tuning and v3 saves discrete stability plus shared timing', async () => {
  const page = await pageFixture(null, 'en', { profiles: elevenProfiles, ttsSlot: {
    profile: 'eleven', model: 'eleven_flash_v2_5', params: { voice: 'eleven-voice', format: 'mp3',
      prosody: { speed: 1.3, volume: 0.5 }, expression: { tagPlacement: 'first-only' },
      elevenLabs: { stability: 0.4, similarityBoost: 0.8, speed: 1.1, emotionTags: true } },
  } });
  const form = voiceForm(page);
  const model = formField(form, 'slot.model');
  formField(form, 'tts.elevenSimilarity').value = '0.91';
  formField(form, 'tts.speed').value = '1.15';
  model.value = 'eleven_v3'; model.fire('input');
  const stability = formField(form, 'tts.elevenStability');
  assert.equal(stability.tagName, 'select');
  assert.deepEqual(stability.children.map(option => option.attributes.value), ['0', '0.5', '1']);
  assert.equal(formField(form, 'tts.elevenSimilarity'), undefined);
  assert.equal(formField(form, 'tts.speed'), undefined);
  assert.ok(formField(form, 'tts.elevenEmotionTags'));
  model.value = 'eleven_flash_v2_5'; model.fire('change');
  assert.equal(formField(form, 'tts.elevenStability').value, 0.4);
  assert.equal(formField(form, 'tts.elevenSimilarity').value, '0.91');
  assert.equal(formField(form, 'tts.speed').value, '1.15');
  formField(form, 'tts.elevenSimilarity').value = 'bad';
  formField(form, 'tts.speed').value = '3';
  model.value = 'eleven_v3'; model.fire('input');
  formField(form, 'tts.elevenStability').value = '1';
  formField(form, 'tts.elevenEmotionTags').checked = false;
  formField(form, 'tts.sentencePauseMs').value = '240';
  form.fire('submit'); await settle();
  const saved = page.calls.find(call => call.path === '/slots/tts').body.slot;
  assert.equal(saved.model, 'eleven_v3');
  assert.deepEqual(saved.params.elevenLabs, { stability: 1, similarityBoost: 0.8, speed: 1.1, emotionTags: false });
  assert.equal(saved.params.expression.sentencePauseMs, 240);
  assert.equal(saved.params.expression.tagPlacement, 'first-only');
  assert.deepEqual(saved.params.prosody, { speed: 1.3, volume: 0.5 });
});

test('ElevenLabs GUI validates required voice, supported models and typed settings before transport', () => {
  const fields = { profile: 'eleven', model: 'eleven_flash_v2_5', voice: 'eleven-voice', format: 'mp3',
    firstByteMs: '20000', idleMs: '20000', totalMs: '60000', advanced: '{}',
    elevenLabs: { stability: '0.5', similarityBoost: '0.75', speed: '1', emotionTags: true } };
  assert.deepEqual(view.makeSlot(fields).params.elevenLabs, view.DEFAULT_ELEVENLABS_PARAMS);
  for (const change of [{ voice: '' }, { voice: 'REPLACE_WITH_VOICE' }, { model: 'eleven_v4' }, { format: 'wav' },
    { elevenLabs: { ...fields.elevenLabs, speed: '1.3' } }, { elevenLabs: { ...fields.elevenLabs, stability: 'bad' } },
    { model: 'eleven_v3', elevenLabs: { ...fields.elevenLabs, stability: '0.4' } },
    { elevenLabs: { ...fields.elevenLabs, emotionTags: 'true' } }]) {
    assert.throws(() => view.makeSlot({ ...fields, ...change }), error => error.code === 'INVALID_SETTINGS');
  }
});

test('native forms hide and disable inactive provider controls without blocking ElevenLabs saves', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const document = dom.window.document;
  const style = document.createElement('style');
  style.textContent = source('src/ui/theme.css') + '\n' + source('src/settings/settings.css').replace(/^@import[^\n]+\n/, '');
  document.head.append(style);
  const names = Object.keys(view.SLOT_LABELS);
  const state = { version: 0, settings: { profiles: elevenProfiles, ui: { language: 'en' },
    slots: Object.fromEntries(names.map(name => [name, name === 'llm' ? { profile: 'sample', model: 'fixture' }
      : name === 'tts' ? { profile: 'sample', model: 'fixture-tts', params: { voice: 'fish-voice' } } : null])) },
    sources: { 'ui.language': 'settings' }, secrets: {} };
  const writes = [];
  const api = { get: async path => structuredClone(path === '/' ? state : { firstRun: false, slots: { llm: { available: true } } }),
    write: async (path, body) => { writes.push({ path, body }); return { version: 1 }; } };
  const bindings = { id, en, presets, setupGuide: '/docs/setup.md', translator, detectLanguage, createSettingsClient,
    mountImageSettings, mountMemorySettings, node, ...view, ...wizard };
  const code = source('src/settings/page.js').replace(/^import .+;\r?\n/gm, '').replace('export async function', 'async function');
  const mount = vm.compileFunction(code + '\nreturn mountSettings;', Object.keys(bindings))(...Object.values(bindings));
  await mount({ document, api, storage: { getItem: () => '{"step":"finish","completed":true}' }, navigatorLanguage: 'en' });
  document.querySelector('[data-settings-tab="voice"]').click(); await settle();
  const form = [...document.querySelectorAll('form')].find(item => item.querySelector('h3')?.textContent === en['slot.tts']);
  const input = label => [...form.querySelectorAll('label')].find(item => item.firstChild.textContent === en[label])?.querySelector('input,select,textarea');
  const fishSpeed = [...form.querySelectorAll('label')].find(item => item.firstChild.textContent === en['tts.speed']
    && item.closest('[data-tts-provider]')?.getAttribute('data-tts-provider') === 'fishAudio').querySelector('input');
  fishSpeed.value = '3';
  assert.equal(form.checkValidity(), false);
  input('slot.profile').value = 'eleven'; input('slot.profile').dispatchEvent(new dom.window.Event('change'));
  assert.equal(fishSpeed.disabled, true);
  assert.equal(dom.window.getComputedStyle(form.querySelector('[data-tts-provider="fishAudio"]')).display, 'none');
  assert.equal(form.checkValidity(), false);
  input('slot.voice').value = 'eleven-voice';
  assert.equal(form.checkValidity(), true);
  const flashSpeed = [...form.querySelectorAll('label')].find(item => item.firstChild.textContent === en['tts.speed']
    && item.closest('[data-tts-provider]')?.getAttribute('data-tts-provider') === 'elevenLabs').querySelector('input');
  flashSpeed.value = '3';
  assert.equal(form.checkValidity(), false);
  input('slot.model').value = 'eleven_v3'; input('slot.model').dispatchEvent(new dom.window.Event('input'));
  const similarity = input('tts.elevenSimilarity');
  assert.equal(similarity.disabled, true);
  assert.equal(similarity.parentElement.hasAttribute('hidden'), true);
  assert.equal(form.checkValidity(), true);
  form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(writes.find(call => call.path === '/slots/tts').body.slot.params.elevenLabs.speed, 1);
  dom.window.close();
});

test('Fish preset choices save a two-tag avatar mapping while preserving unrelated entries', async () => {
  const page = await pageFixture({ expression: { emotionTagMap: { netral: '[calm] [warm]', nostalgic: '[moved]' } } });
  const row = page.nodes().find(item => item.attributes['data-avatar-emotion'] === 'kagum');
  const inputs = walk(row).filter(item => item.tagName === 'select');
  inputs[0].value = '[delighted]'; inputs[0].fire('change');
  inputs[1].value = '[nostalgic]'; inputs[1].fire('change');
  let form = row.parent;
  while (form.tagName !== 'form') form = form.parent;
  form.fire('submit'); await settle();
  const saved = page.calls.find(call => call.path === '/slots/tts').body.slot.params.expression.emotionTagMap;
  assert.equal(saved.kagum, '[delighted] [nostalgic]');
  assert.equal(saved.netral, '[calm] [warm]');
  assert.equal(saved.nostalgic, '[moved]');
});

test('Fish custom JSON edits update selectors and custom selections survive unrelated changes', async () => {
  const page = await pageFixture({ expression: { emotionTagMap: { netral: '[calm] [warm]' } } });
  const editor = page.nodes().find(item => item.tagName === 'textarea' && item.parent.ownText === en['tts.emotionMap']);
  const row = page.nodes().find(item => item.attributes['data-avatar-emotion'] === 'netral');
  const inputs = walk(row).filter(item => item.tagName === 'select');
  assert.equal(inputs[1].value, '[warm]');
  assert.ok(inputs[1].children.some(option => option.tagName === 'option' && option.textContent.includes('[warm]')));
  editor.value = JSON.stringify({ netral: ['[soft, warm and gentle]', '[compassionate]'], sayang: '[grateful]' }); editor.fire('input');
  assert.deepEqual(inputs.map(input => input.value), ['[soft, warm and gentle]', '[compassionate]']);
  inputs[1].value = '[moved]'; inputs[1].fire('change');
  assert.deepEqual(JSON.parse(editor.value), { netral: '[soft, warm and gentle] [moved]', sayang: '[grateful]' });
  const savedSelectors = inputs.map(input => input.value);
  editor.value = '{broken'; editor.fire('input');
  assert.deepEqual(inputs.map(input => input.value), savedSelectors);
  inputs[0].value = '[calm]'; inputs[0].fire('change');
  assert.equal(editor.value, '{broken');
  assert.equal(page.calls.some(call => call.path === '/slots/tts'), false);
});

test('Fish preset None selections disable an emotion without deleting the mapping', async () => {
  const page = await pageFixture({ expression: { emotionTagMap: { kagum: '[excited] [happy]' } } });
  const row = page.nodes().find(item => item.attributes['data-avatar-emotion'] === 'kagum');
  const inputs = walk(row).filter(item => item.tagName === 'select');
  for (const input of inputs) { input.value = ''; input.fire('change'); }
  const editor = page.nodes().find(item => item.tagName === 'textarea' && item.parent.ownText === en['tts.emotionMap']);
  assert.deepEqual(JSON.parse(editor.value).kagum, []);
});
test('settings page saves profile secrets once and never repopulates the password field', async () => {
  const page = await pageFixture(null, 'en', { tab: 'connections' });
  page.nodes().find(item => item.tagName === 'button' && item.textContent === 'sample').fire('click'); await settle();
  const key = page.nodes().find(item => item.tagName === 'input' && item.type === 'password');
  key.value = SECRET; key.parent.parent.fire('submit'); await settle();
  assert.equal(page.calls.find(call => call.path === '/profiles/sample').body.secrets.apiKey, SECRET);
  assert.equal(page.nodes().some(item => item.value === SECRET || item.textContent.includes(SECRET)), false);
  assert.equal(page.nodes().find(item => item.type === 'password').value, '');
});
test('settings tabs support keyboard navigation and role selection', async () => {
  const page = await pageFixture();
  const tabs = page.nodes().filter(item => item.attributes.role === 'tab');
  tabs[0].fire('keydown', { key: 'ArrowRight' }); assert.equal(page.document.activeElement, tabs[1]);
  tabs.find(item => item.textContent === en['tab.status']).fire('click'); await settle();
  assert.ok(page.nodes().some(item => item.tagName === 'h2' && item.textContent === en['tab.status']));
  assert.ok(page.document.activeElement.id === 'settings-content');
});

test('settings default to chat and keep role editors on their feature pages', async () => {
  const page = await pageFixture();
  const roles = () => page.nodes().filter(item => item.tagName === 'form' && item.attributes['data-slot'])
    .map(item => item.attributes['data-slot']);
  assert.equal(page.nodes().find(item => item.attributes['data-settings-tab'] === 'chat').attributes['aria-selected'], 'true');
  assert.deepEqual(roles(), ['llm', 'surface', 'reflection', 'router', 'planner']);
  await page.navigate('voice');
  assert.deepEqual(roles(), ['tts', 'stt']);
  await page.navigate('vision');
  assert.deepEqual(roles(), ['vision', 'visionFilter']);
  await page.navigate('connections');
  assert.deepEqual(roles(), []);
  assert.ok(page.nodes().some(item => item.attributes['data-setting-field'] === 'provider.preset'));
  assert.equal(page.calls.length, 0);
});

test('dirty navigation can be cancelled and discard restores the saved form', async () => {
  const confirmations = [];
  const page = await pageFixture(null, 'en', { confirm: text => { confirmations.push(text); return false; } });
  const chat = page.nodes().find(item => item.attributes['data-slot'] === 'llm');
  const model = formField(chat, 'slot.model');
  model.value = 'unsaved-model'; model.fire('input'); await settle();
  await page.navigate('voice');
  assert.deepEqual(confirmations, [en['confirm.unsaved']]);
  assert.ok(page.nodes().includes(chat));
  assert.equal(model.value, 'unsaved-model');
  walk(chat).find(item => item.tagName === 'button' && item.textContent === en['action.cancelChanges']).fire('click');
  await settle();
  const restored = page.nodes().find(item => item.attributes['data-slot'] === 'llm');
  assert.equal(formField(restored, 'slot.model').value, 'fixture');
  await page.navigate('voice');
  assert.ok(page.nodes().some(item => item.attributes['data-slot'] === 'tts'));
  assert.equal(page.calls.length, 0);
});

test('saving one voice form keeps the sibling hearing draft and DOM intact', async () => {
  const page = await pageFixture({});
  const hearing = page.nodes().find(item => item.attributes['data-slot'] === 'stt');
  const draft = formField(hearing, 'slot.model');
  draft.value = 'unsaved-hearing-model'; draft.fire('input'); await settle();
  const voice = voiceForm(page);
  formField(voice, 'tts.sentencePauseMs').value = '250';
  voice.fire('submit'); await settle();
  assert.equal(page.calls.filter(call => call.path === '/slots/tts').length, 1);
  assert.equal(page.calls.some(call => call.path === '/slots/stt'), false);
  assert.ok(page.nodes().includes(hearing));
  assert.equal(draft.value, 'unsaved-hearing-model');
});

test('follow changes wait for Save and cancellation restores the saved assignment', async () => {
  const page = await pageFixture(null, 'en', { slots: { surface: { followLlm: true } } });
  let form = page.nodes().find(item => item.attributes['data-slot'] === 'surface');
  const follow = formField(form, 'slot.follow', false);
  assert.equal(follow.checked, true);
  assert.equal(formField(form, 'slot.model', false).disabled, true);
  follow.checked = false; follow.fire('change'); await settle();
  assert.equal(page.calls.length, 0);
  formField(form, 'slot.model').value = 'independent-model';
  form.fire('submit'); await settle();
  assert.equal(page.calls.at(-1).body.slot.model, 'independent-model');
  form = page.nodes().find(item => item.attributes['data-slot'] === 'surface');
  formField(form, 'slot.follow', false).checked = true; formField(form, 'slot.follow', false).fire('change'); await settle();
  walk(form).find(item => item.tagName === 'button' && item.textContent === en['action.cancelChanges']).fire('click'); await settle();
  form = page.nodes().find(item => item.attributes['data-slot'] === 'surface');
  assert.equal(formField(form, 'slot.follow', false).checked, false);
  assert.equal(page.calls.length, 1);
  formField(form, 'slot.follow', false).checked = true; formField(form, 'slot.follow', false).fire('change');
  form.fire('submit'); await settle();
  assert.deepEqual(page.calls.at(-1).body.slot, { followLlm: true });
});

test('first-run chat requires a saved assignment and resumes the next setup step', async () => {
  let saved = '{"step":"llm","completed":false}';
  const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
  const page = await pageFixture(null, 'en', { storage, slots: { llm: null } });
  const next = () => page.nodes().find(item => item.tagName === 'button' && item.textContent === en['action.next']);
  assert.equal(next().disabled, true);
  const chat = page.nodes().find(item => item.attributes['data-slot'] === 'llm');
  formField(chat, 'slot.profile').value = 'sample';
  formField(chat, 'slot.model').value = 'saved-chat-model';
  assert.equal(next().disabled, true, 'Editing alone cannot complete the required step');
  chat.fire('submit'); await settle();
  assert.equal(next().disabled, false);
  next().fire('click'); await settle();
  assert.deepEqual(JSON.parse(saved), { step: 'tts', completed: false });
  const resumed = await pageFixture(null, 'en', { storage, slots: { llm: page.state.settings.slots.llm } });
  assert.ok(resumed.nodes().some(item => item.attributes['data-slot'] === 'tts'));
  assert.ok(resumed.nodes().some(item => item.attributes['aria-current'] === 'step'));
  assert.equal(saved.includes('saved-chat-model'), false, 'Wizard storage contains progress only');
});

test('unassigning main chat opens the actual first-run setup content', async () => {
  const page = await pageFixture();
  const chat = page.nodes().find(item => item.attributes['data-slot'] === 'llm');
  walk(chat).find(item => item.tagName === 'button' && item.textContent === en['action.unassign']).fire('click'); await settle();
  assert.equal(page.state.settings.slots.llm, null);
  assert.ok(page.nodes().some(item => item.attributes.class === 'settings-wizard-progress'));
  assert.ok(page.nodes().some(item => item.attributes['data-setting-field'] === 'language.choose'));
  assert.equal(page.nodes().some(item => item.attributes['data-slot'] === 'llm'), false);
  assert.equal(page.nodes().some(item => item.attributes.role === 'tab' && item.attributes['aria-selected'] === 'true'), false);
});

test('a pending save locks its fields and rejection restores them without losing sibling drafts', async () => {
  const page = await pageFixture({});
  const originalWrite = page.api.write;
  let rejectSave;
  page.api.write = async (path, body, method) => {
    if (path === '/slots/tts') await new Promise((_resolve, reject) => { rejectSave = reject; });
    return originalWrite(path, body, method);
  };
  const voice = voiceForm(page);
  const voiceId = formField(voice, 'slot.voice');
  const hearing = page.nodes().find(item => item.attributes['data-slot'] === 'stt');
  const hearingModel = formField(hearing, 'slot.model');
  formField(voice, 'tts.sentencePauseMs').value = '250';
  voice.fire('submit'); await settle();
  assert.ok(rejectSave);
  assert.equal(voiceId.disabled, true);
  assert.notEqual(hearingModel.disabled, true);
  hearingModel.value = 'hearing-draft'; hearingModel.fire('input'); await settle();
  await page.navigate('vision');
  assert.ok(page.nodes().includes(voice));
  rejectSave({ code: 'CONFLICT' }); await settle();
  assert.notEqual(voiceId.disabled, true);
  assert.ok(page.nodes().includes(hearing));
  assert.equal(hearingModel.value, 'hearing-draft');
  assert.equal(formField(voice, 'tts.sentencePauseMs').value, '250');
  assert.ok(page.nodes().some(item => item.attributes.class === 'settings-form-status' && item.textContent.includes('CONFLICT')));
  assert.equal(page.calls.length, 0);
});

test('full refresh locks controls and blocks navigation until success or failure', async t => {
  for (const fails of [false, true]) await t.test(fails ? 'failure preserves the draft' : 'success renders the saved settings', async () => {
    const confirmations = [];
    const page = await pageFixture({}, 'en', { confirm: text => { confirmations.push(text); return true; } });
    const voice = voiceForm(page);
    const model = formField(voice, 'slot.model');
    const hearing = page.nodes().find(item => item.attributes['data-slot'] === 'stt');
    const hearingModel = formField(hearing, 'slot.model');
    hearingModel.disabled = true;
    if (fails) { model.value = 'refresh-draft'; model.fire('input'); await settle(); }
    const originalGet = page.api.get;
    let completeRefresh;
    page.api.get = async path => {
      if (path === '/') await new Promise((resolve, reject) => { completeRefresh = fails ? () => reject({ code: 'BAD_RESPONSE' }) : resolve; });
      return originalGet(path);
    };
    const refresh = page.nodes().find(item => item.tagName === 'button' && item.textContent === en['action.refresh']);
    refresh.fire('click'); await settle();
    assert.ok(completeRefresh);
    assert.equal(model.disabled, true);
    assert.equal(hearingModel.disabled, true);
    assert.equal(page.document.getElementById('settings-page').getAttribute('aria-busy'), 'true');
    await page.navigate('vision');
    page.nodes().find(item => item.tagName === 'button' && item.textContent === en['wizard.restart']).fire('click'); await settle();
    assert.ok(page.nodes().includes(voice));
    assert.equal(page.storageWrites.length, 0);
    completeRefresh(); await settle();
    assert.notEqual(model.disabled, true);
    assert.equal(hearingModel.disabled, true, 'A previously disabled field retains its state');
    assert.equal(page.document.getElementById('settings-page').getAttribute('aria-busy'), null);
    if (fails) {
      assert.ok(page.nodes().includes(voice));
      assert.equal(model.value, 'refresh-draft');
      assert.deepEqual(confirmations, [en['confirm.unsaved']]);
      assert.ok(page.nodes().some(item => item.attributes.class === 'settings-toast' && item.textContent.includes('BAD_RESPONSE')));
    } else {
      assert.notEqual(voiceForm(page), voice);
      assert.equal(formField(voiceForm(page), 'slot.model').value, 'fixture-tts');
      assert.deepEqual(confirmations, []);
    }
    await page.navigate('vision');
    assert.ok(page.nodes().some(item => item.attributes['data-slot'] === 'vision'));
    assert.equal(page.calls.length, 0);
  });
});

test('pending unassignment locks its form and preserves editable sibling drafts', async t => {
  for (const fails of [false, true]) await t.test(fails ? 'failure restores the original form' : 'success replaces only its form', async () => {
    const page = await pageFixture({});
    const voice = voiceForm(page);
    const model = formField(voice, 'slot.model');
    const inactive = walk(voice).find(item => item.attributes['data-tts-provider'] === 'elevenLabs');
    const inactiveControl = walk(inactive).find(item => ['input', 'select'].includes(item.tagName));
    assert.equal(inactiveControl.disabled, true);
    const hearing = page.nodes().find(item => item.attributes['data-slot'] === 'stt');
    const hearingModel = formField(hearing, 'slot.model');
    const originalWrite = page.api.write;
    let completeUnassign;
    page.api.write = async (path, body, method) => {
      if (path === '/slots/tts') await new Promise((resolve, reject) => { completeUnassign = fails ? () => reject({ code: 'CONFLICT' }) : resolve; });
      return originalWrite(path, body, method);
    };
    walk(voice).find(item => item.tagName === 'button' && item.textContent === en['action.unassign']).fire('click'); await settle();
    assert.ok(completeUnassign);
    assert.equal(model.disabled, true);
    assert.notEqual(hearingModel.disabled, true);
    hearingModel.value = 'separate-hearing-draft'; hearingModel.fire('input'); await settle();
    await page.navigate('vision');
    assert.ok(page.nodes().includes(voice));
    completeUnassign(); await settle();
    assert.notEqual(model.disabled, true);
    assert.equal(inactiveControl.disabled, true);
    assert.ok(page.nodes().includes(hearing));
    assert.equal(hearingModel.value, 'separate-hearing-draft');
    if (fails) {
      assert.ok(page.nodes().includes(voice));
      assert.equal(model.value, 'fixture-tts');
      assert.equal(page.calls.length, 0);
    } else {
      assert.notEqual(voiceForm(page), voice);
      assert.equal(page.state.settings.slots.tts, null);
      assert.deepEqual(page.calls.map(call => call.path), ['/slots/tts']);
    }
  });
});

test('an active photo connection check blocks navigation and keeps its updated settings version', async () => {
  const page = await pageFixture();
  const originalGet = page.api.get;
  const originalWrite = page.api.write;
  let imageVersion = 5;
  page.api.get = async path => path === '/images'
    ? { version: imageVersion, ready: true, images: { provider: 'comfyui', comfyuiUrl: 'http://127.0.0.1:8188', preset: 'cepat' } }
    : originalGet(path);
  let completeCheck;
  page.api.write = async (path, body, method) => {
    if (path === '/images/test') return new Promise(resolve => { completeCheck = resolve; });
    return originalWrite(path, body, method);
  };
  await page.navigate('images');
  const photo = page.nodes().find(item => Object.hasOwn(item.attributes, 'data-pap-settings'));
  walk(photo).find(item => item.tagName === 'button' && item.textContent === en['images.test']).fire('click'); await settle();
  assert.ok(completeCheck);
  await page.navigate('chat');
  assert.ok(page.nodes().includes(photo));
  imageVersion = 6; page.state.version = 6;
  completeCheck({ ready: true }); await settle();
  assert.ok(page.nodes().includes(photo));
  await page.navigate('chat');
  const chat = page.nodes().find(item => item.attributes['data-slot'] === 'llm');
  formField(chat, 'slot.model').value = 'after-photo-check';
  chat.fire('submit'); await settle();
  assert.equal(page.calls.find(call => call.path === '/slots/llm').body.version, 6);
});

test('editing a provider during setup refreshes clean voice controls for its new adapter', async () => {
  const page = await pageFixture(null, 'en', {
    profiles: elevenProfiles,
    slots: { tts: { profile: 'sample', model: 'fish-model', params: { voice: 'fish-voice', topP: 0.7 } } },
    storage: { getItem: () => '{"step":"tts","completed":false}', setItem() {} },
  });
  const originalVoice = voiceForm(page);
  page.nodes().find(item => item.tagName === 'button' && item.textContent === 'sample').fire('click'); await settle();
  const provider = page.nodes().find(item => item.attributes['data-provider-form'] === 'true');
  formField(provider, 'provider.adapter').value = 'elevenLabs';
  formField(provider, 'provider.url').value = 'https://api.elevenlabs.io/v1';
  provider.fire('submit'); await settle();
  const refreshed = voiceForm(page);
  assert.notEqual(refreshed, originalVoice);
  assert.equal(formField(refreshed, 'tts.topP'), undefined);
  assert.ok(formField(refreshed, 'tts.elevenStability'));
  assert.equal(formField(refreshed, 'slot.format').value, 'mp3');
  formField(refreshed, 'slot.model').value = 'eleven_flash_v2_5';
  formField(refreshed, 'slot.voice').value = 'eleven-voice';
  refreshed.fire('submit'); await settle();
  const saved = page.calls.find(call => call.path === '/slots/tts').body.slot;
  assert.equal(saved.model, 'eleven_flash_v2_5');
  assert.equal(saved.params.voice, 'eleven-voice');
  assert.deepEqual(saved.params.elevenLabs, view.DEFAULT_ELEVENLABS_PARAMS);
});

test('failed advanced edits retain public JSON and clear credential-like text before validation or transport', async () => {
  const edits = [
    { text: '{invalid', credentials: false, valid: false },
    { text: JSON.stringify({ bodyExtras: { fixtureOption: 7 }, omitParams: ['presence_penalty'] }), credentials: false, valid: true },
    { text: '{"bodyExtras":{"token":"' + SECRET, credentials: true, valid: false },
    { text: JSON.stringify({ bodyExtras: { token: SECRET } }), credentials: true, valid: true },
  ];
  for (const edit of edits) {
    const page = await pageFixture();
    const chat = page.nodes().find(item => item.attributes['data-slot'] === 'llm');
    const extras = formField(chat, 'slot.extras');
    extras.value = edit.text; extras.fire('input'); await settle();
    if (!edit.valid) assert.equal(extras.attributes['aria-invalid'], 'true');
    let requests = 0;
    page.api.write = async path => {
      requests++;
      assert.equal(path, '/slots/llm');
      assert.equal(extras.value, edit.credentials ? '' : edit.text, 'Credential-like text clears before transport');
      throw { code: 'CONFLICT' };
    };
    chat.fire('submit'); await settle();
    assert.equal(requests, edit.valid ? 1 : 0);
    assert.ok(page.nodes().includes(extras));
    assert.equal(extras.value, edit.credentials ? '' : edit.text);
    assert.ok(page.nodes().some(item => item.attributes.class === 'settings-form-status'
      && item.textContent.includes(edit.valid ? 'CONFLICT' : 'INVALID_SETTINGS')));
    assert.equal(page.nodes().some(item => item.textContent.includes(SECRET)), false);
  }
});

test('GUI diagnostics requests only the server-side dummy self-test and displays a safe report', async () => {
  const page = await pageFixture();
  page.nodes().find(item => item.attributes.role === 'tab' && item.textContent === en['tab.diagnostics']).fire('click'); await settle();
  page.nodes().find(item => item.tagName === 'button' && item.textContent === en['diagnostics.run']).fire('click'); await settle();
  assert.deepEqual(page.calls, [{ path: '/diagnostics', body: {}, method: 'POST' }]);
  assert.ok(page.nodes().some(item => item.textContent === en['test.success']));
  assert.equal(page.nodes().some(item => item.type === 'password' || item.textContent.includes(SECRET)), false);
});
test('pastel theme text, actions and state colors meet contrast thresholds', () => {
  const tokens = Object.fromEntries([...source('src/ui/theme.css').matchAll(/--amika-([a-z-]+):\s*#([0-9a-f]{6})/gi)]
    .map(([, name, value]) => [name, value]));
  const luminance = hex => hex.match(/\w\w/g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  for (const [front, back, minimum] of [['text', 'bg', 4.5], ['muted', 'bg', 4.5], ['surface', 'primary', 4.5],
    ['primary', 'surface', 3], ['success', 'success-bg', 4.5], ['warning', 'warning-bg', 4.5], ['error', 'error-bg', 4.5]]) {
    assert.ok(tokens[front] && tokens[back], 'Missing color token');
    const values = [luminance(tokens[front]), luminance(tokens[back])].sort((a, b) => a - b);
    assert.ok((values[1] + .05) / (values[0] + .05) >= minimum, front + ' on ' + back);
  }
  assert.match(source('src/settings/settings.css'), /@import '\.\.\/ui\/theme\.css'/);
  assert.match(source('src/settings/settings.css'), /outline: 3px solid var\(--amika-primary\)/);
});
test('Electron settings window uses the same origin with isolation, no preload and guarded navigation', async () => {
  const windows = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = callback => { this.openHandler = callback; };
      this.webContents.session = { setPermissionCheckHandler: callback => { this.permission = callback; },
        setPermissionRequestHandler() {}, webRequest: { onHeadersReceived() {} } }; windows.push(this);
    }
    setContentProtection(value) { this.protected = value; }
    async loadURL(value) { this.url = value; }
    isDestroyed() { return false; }
    show() {} focus() {} close() { this.emit('closed'); }
  }
  const manager = new SettingsWindowManager({ BrowserWindow: Window });
  await manager.open('http://localhost:5173/?mode=overlay');
  const win = windows[0];
  assert.equal(win.url, 'http://localhost:5173/#settings');
  assert.deepEqual(win.options.webPreferences, { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, partition: 'settings-ui' });
  assert.equal(win.permission(), false); assert.equal(win.protected, true); assert.equal(win.openHandler().action, 'deny');
  let prevented = false;
  win.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://example.invalid');
  assert.equal(prevented, true);
  await manager.open('http://localhost:5173/'); assert.equal(windows.length, 1);
  let opened = false; settingsMenuItem(() => { opened = true; }).click(); assert.equal(opened, true);
  await assert.rejects(manager.open('https://example.invalid'));
  assert.match(source('desktop-companion/src/main/trayManager.js'), /settingsMenuItem\(\(\) => this.handlers.onOpenSettings/);
  assert.match(source('desktop-companion/src/main/index.js'), /assertTrustedSender\(event, 'desktop:open-settings'\)/);
});
