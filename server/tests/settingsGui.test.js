import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { translator, detectLanguage } from '../../src/settings/i18n.js';
import { createSettingsClient } from '../../src/settings/apiClient.js';
import { node } from '../../src/settings/dom.js';
import * as view from '../../src/settings/viewModel.js';
import * as wizard from '../../src/settings/wizard.js';
import { SettingsWindowManager, settingsMenuItem } from '../../desktop-companion/src/main/settingsWindowManager.js';
import { EventEmitter } from 'node:events';

const source = name => fs.readFileSync(new URL('../../' + name, import.meta.url), 'utf8');
const id = JSON.parse(source('src/i18n/id.json'));
const en = JSON.parse(source('src/i18n/en.json'));
const presets = JSON.parse(source('src/settings/presets.json'));
const SECRET = 'gui-fixture-private-value';
const XSS = '<img src=x onerror=alert(1)>';
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('settings translations have parity and no unused or missing literal keys', () => {
  assert.deepEqual(Object.keys(id).sort(), Object.keys(en).sort());
  const code = ['src/bootstrap.js', ...fs.readdirSync(new URL('../../src/settings/', import.meta.url)).filter(name => /\.(?:js|json)$/.test(name)).map(name => 'src/settings/' + name)].map(source).join('\n');
  for (const key of Object.keys(en)) assert.ok(code.includes("'" + key + "'") || code.includes('"' + key + '"'), 'Unused translation: ' + key);
  for (const [, key] of code.matchAll(/\bt\('([^']+)'/g)) assert.ok(Object.hasOwn(en, key), 'Missing translation: ' + key);
  const namespaces = [...new Set(Object.keys(en).map(key => key.split('.')[0]))].join('|');
  for (const [, key] of code.matchAll(new RegExp('[\'\"]((?:' + namespaces + ')\\.[A-Za-z]+)[\'\"]', 'g'))) {
    assert.ok(Object.hasOwn(en, key), 'Missing dynamic translation: ' + key);
  }
  assert.equal(translator('id', { id: {}, en: { greeting: 'Hello {name}' } })('greeting', { name: 'fixture' }), 'Hello fixture');
  assert.equal(translator('id', { id, en })('missing.key'), 'missing.key');
  assert.equal(detectLanguage('en-US'), 'en'); assert.equal(detectLanguage('id-ID'), 'id'); assert.equal(detectLanguage('fr'), 'id');
});
test('presets keep custom available and flag official examples for maintainer verification', () => {
  assert.equal(presets.some(value => value.id === 'custom'), true);
  for (const preset of presets) {
    assert.ok(en[preset.labelKey]);
    if (preset.baseUrl) { view.validateBaseUrl(preset.baseUrl, { websocket: preset.adapter === 'fishAudio' }); assert.equal(preset.maintainerVerificationRequired, true); }
  }
});
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
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.ownText = ''; this.append(...children); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  fire(name, event = {}) { for (const callback of this.listeners[name] || []) callback({ preventDefault() {}, ...event }); }
  focus() { this.document.activeElement = this; }
}
const walk = item => [item, ...item.children.flatMap(walk)];
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function pageFixture() {
  const document = { createElement: tag => new Element(tag, document), getElementById: id => walk(document.body).find(value => value.id === id) };
  document.body = new Element('body', document); document.documentElement = {};
  const names = Object.keys(view.SLOT_LABELS);
  const state = { version: 0, settings: { profiles: { sample: { adapter: 'openaiCompatible', baseUrl: 'https://example.invalid/v1' } },
    slots: Object.fromEntries(names.map(name => [name, name === 'llm' ? { profile: 'sample', model: 'fixture' } : null])), ui: { language: 'en' } },
    sources: { 'ui.language': 'settings' }, secrets: { sample: { apiKey: { has: false } } } };
  const calls = [];
  const api = { get: async path => structuredClone(path === '/' ? state : path === '/images' ? { ready: false } : {
    firstRun: false, backendName: 'plaintext-file', slots: Object.fromEntries(names.map(name => [name, { available: name === 'llm' }])) }),
    write: async (path, body, method) => {
      calls.push({ path, body: structuredClone(body), method });
      if (path === '/models') return { models: [XSS], reason: null };
      if (path === '/diagnostics') return { backendName: 'plaintext-file', version: 0, permissionNote: 'OWNER_ONLY_RECOMMENDED',
        writable: true, locations: { 'settings.json': '<local>/settings.json' }, locks: {}, corruptBackups: 0, selfTest: { ok: true, code: null } };
      if (path.startsWith('/profiles/')) { state.settings.profiles.sample = body.profile; state.secrets.sample.apiKey = { has: Boolean(body.secrets?.apiKey) }; }
      return { version: ++state.version };
    } };
  const bindings = { id, en, presets, setupGuide: '/docs/setup.md', translator, detectLanguage, createSettingsClient, node, ...view, ...wizard };
  const code = source('src/settings/page.js').replace(/^import .+;\r?\n/gm, '').replace('export async function', 'async function');
  const mount = vm.compileFunction(code + '\nreturn mountSettings;', Object.keys(bindings))(...Object.values(bindings));
  await mount({ document, api, storage: { getItem: () => '{"step":"finish","completed":true}', setItem() {} }, navigatorLanguage: 'en', confirm: () => true });
  return { document, calls, api, nodes: () => walk(document.body) };
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
test('settings page saves profile secrets once and never repopulates the password field', async () => {
  const page = await pageFixture();
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
  tabs[1].fire('click'); await settle();
  assert.ok(page.nodes().some(item => item.tagName === 'h2' && item.textContent === en['tab.status']));
  assert.ok(page.document.activeElement.id === 'settings-content');
});

test('GUI diagnostics requests only the server-side dummy self-test and displays a safe report', async () => {
  const page = await pageFixture();
  page.nodes().find(item => item.attributes.role === 'tab' && item.textContent === en['tab.diagnostics']).fire('click'); await settle();
  page.nodes().find(item => item.tagName === 'button' && item.textContent === en['diagnostics.run']).fire('click'); await settle();
  assert.deepEqual(page.calls, [{ path: '/diagnostics', body: {}, method: 'POST' }]);
  assert.ok(page.nodes().some(item => item.textContent === en['test.success']));
  assert.equal(page.nodes().some(item => item.type === 'password' || item.textContent.includes(SECRET)), false);
});
test('dark theme text, links and focus colors meet contrast thresholds', () => {
  const luminance = hex => hex.match(/\w\w/g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  for (const [front, back, minimum] of [['eeeef6', '161622', 4.5], ['9dcaff', '202030', 4.5], ['ffd479', '161622', 3]]) {
    assert.ok((luminance(front) + .05) / (luminance(back) + .05) >= minimum);
  }
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
