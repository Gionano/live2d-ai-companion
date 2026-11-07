import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSettingsClient } from '../../src/settings/apiClient.js';
import { translator } from '../../src/settings/i18n.js';
import { CLOUD_IMAGE_MODEL, imageSettingsInput, imageBytes, mountImageSettings } from '../../src/settings/imageSettings.js';

const labels = JSON.parse(fs.readFileSync(new URL('../../src/i18n/id.json', import.meta.url), 'utf8'));
const t = translator('id', { id: labels });
const SECRET = 'private-cloud-token';
const ACCOUNT = 'a'.repeat(32);
const XSS = '<img src=x onerror=alert(1)>';
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this.ownText = ''; }
  set innerHTML(_value) { throw new Error('Markup assignment is forbidden.'); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(value => value.textContent).join(''); }
  get id() { return this.attributes.id; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.ownText = ''; this.append(...children); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  fire(name) { for (const callback of this.listeners[name] || []) callback({ preventDefault() {} }); }
}
const walk = item => [item, ...item.children.flatMap(walk)];
async function fixture({ provider = 'auto', installation = null, failWrite = false } = {}) {
  const parent = new Element('main');
  const document = { visibilityState: 'visible', createElement: tag => new Element(tag) };
  const calls = []; const errors = []; const timers = new Map(); let timerId = 0;
  const snapshot = { version: 4, ready: false, provider: null, pending: false, hasKey: false, installation,
    images: { provider, preset: 'cepat', comfyuiUrl: 'http://127.0.0.1:8188', variant: 'auto', cloud: { accountId: ACCOUNT, model: CLOUD_IMAGE_MODEL } },
    readiness: { active: null, reasons: {} } };
  const plan = { planId: 'fixture-plan', downloadBytes: 1024, requiredDiskBytes: 2048, freeBytes: 4096,
    components: [{ name: XSS, sizeBytes: 1024, status: 'missing' }], blockers: [],
    licenses: [{ key: 'license-1', name: XSS, url: 'https://example.invalid/license', accepted: false }] };
  const api = {
    get: async path => {
      calls.push({ method: 'GET', path });
      return structuredClone(path === '/images' ? snapshot : snapshot.installation);
    },
    write: async (path, body, method) => {
      calls.push({ path, body: structuredClone(body), method });
      if (failWrite) throw Object.assign(new Error(), { code: 'CONFLICT' });
      if (path === '/images') { snapshot.images = structuredClone(body.images); snapshot.version++; }
      if (path === '/images/secret') { snapshot.hasKey = method !== 'DELETE'; snapshot.version++; }
      if (path === '/images/test') return { ready: false, code: 'AUTH', generationTested: false };
      if (path === '/images/install/plan') return structuredClone(plan);
      if (path === '/images/install') { snapshot.installation = { id: 'fixture-job', state: 'running', phase: 'downloading', downloadedBytes: 12, totalBytes: 1024 }; return structuredClone(snapshot.installation); }
      if (path.endsWith('/cancel')) { snapshot.installation.state = 'cancelled'; return structuredClone(snapshot.installation); }
      return { version: snapshot.version };
    },
  };
  const controller = mountImageSettings(parent, { document, api, t, fail: error => errors.push(error.code),
    setTimer: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimer: id => timers.delete(id) });
  await controller.ready;
  const nodes = () => walk(parent);
  const input = key => nodes().find(node => ['input', 'select'].includes(node.tagName) && node.parent.ownText === labels[key]);
  const button = key => nodes().find(node => node.tagName === 'button' && node.textContent === labels[key]);
  return { parent, document, calls, errors, snapshot, plan, nodes, input, button, controller, timers };
}

test('PAP settings validates provider-specific fields and excludes unsupported sampling controls', () => {
  const fields = { provider: 'cloud', preset: 'cepat', comfyuiUrl: 'http://127.0.0.1:8188', variant: 'auto',
    cloud: { accountId: ACCOUNT, model: 'arbitrary-model', token: SECRET }, steps: 20, key: SECRET };
  const value = imageSettingsInput(fields);
  assert.equal(value.cloud.model, CLOUD_IMAGE_MODEL);
  assert.equal(JSON.stringify(value).includes(SECRET), false);
  assert.equal(value.steps, undefined);
  for (const change of [{ provider: 'auto' }, { cloud: { accountId: '' } }, { variant: 'cpu' }, { comfyuiUrl: 'javascript:alert(1)' }]) {
    assert.throws(() => imageSettingsInput({ ...fields, ...change }), error => error.code === 'INVALID_SETTINGS' || /URL|protocol/i.test(error.message));
  }
  assert.equal(imageBytes(1024 ** 3), '1.00 GiB'); assert.equal(imageBytes(null), null);
});

test('legacy automatic provider is preserved and selecting cloud performs no writes or downloads', async () => {
  const page = await fixture();
  assert.equal(page.input('images.provider').value, 'auto');
  assert.equal(page.button('images.save').disabled, true);
  const provider = page.input('images.provider'); provider.value = 'cloud'; provider.fire('change');
  assert.equal(page.input('images.provider').value, 'cloud');
  assert.ok(page.nodes().some(node => node.textContent === labels['images.cloudFixed']));
  assert.deepEqual(page.calls, [{ method: 'GET', path: '/images' }]);
  assert.equal(page.button('images.preview'), undefined);
  page.controller.dispose();
});

test('cloud save clears the password before transport and writes a separate versioned secret', async () => {
  const page = await fixture({ provider: 'cloud' });
  const key = page.input('images.token'); key.value = SECRET;
  let clearedAtTransport = false;
  const original = page.calls.length;
  key.parent.parent.fire('submit'); await settle();
  clearedAtTransport = key.value === '';
  const writes = page.calls.slice(original).filter(call => call.method !== 'GET');
  assert.equal(clearedAtTransport, true);
  assert.deepEqual(writes.map(call => [call.path, call.body.version]), [['/images', 4], ['/images/secret', 5]]);
  assert.equal(writes[1].body.key, SECRET);
  assert.equal(JSON.stringify(writes[0].body).includes(SECRET), false);
  assert.equal(page.nodes().some(node => node.value === SECRET || node.textContent.includes(SECRET)), false);
  page.controller.dispose();
});

test('cloud save conflicts do not transport the token or repopulate its field', async () => {
  const page = await fixture({ provider: 'cloud', failWrite: true });
  const key = page.input('images.token'); key.value = SECRET; key.parent.parent.fire('submit'); await settle();
  assert.deepEqual(page.errors, ['CONFLICT']); assert.equal(key.value, '');
  assert.equal(page.calls.some(call => call.path === '/images/secret'), false);
  page.controller.dispose();
});

test('setup review is read-only and requires explicit license consent before downloading', async () => {
  const page = await fixture({ provider: 'sdcpp' });
  page.button('images.preview').fire('click'); await settle();
  assert.deepEqual(page.calls.find(call => call.path === '/images/install/plan').body, { provider: 'sdcpp' });
  assert.equal(page.calls.some(call => call.path === '/images/install'), false);
  assert.ok(page.nodes().some(node => node.tagName === 'td' && node.textContent === XSS));
  const download = page.button('images.download'); assert.equal(download.disabled, true);
  download.fire('click'); await settle(); assert.equal(page.calls.some(call => call.path === '/images/install'), false);
  const checkbox = page.input('images.acceptLicense'); checkbox.checked = true; checkbox.fire('change');
  assert.equal(download.disabled, false);
  download.fire('click'); await settle();
  const call = page.calls.find(call => call.path === '/images/install');
  assert.deepEqual(call.body, { planId: 'fixture-plan', acceptedLicenses: ['license-1'] });
  assert.equal(page.timers.size, 1); assert.ok(page.button('images.cancel'));
  page.button('images.cancel').fire('click'); await settle();
  assert.ok(page.nodes().some(node => node.textContent === labels['images.cancelled']));
  page.controller.dispose(); assert.equal(page.timers.size, 0);
});

test('setup preview sends explicit sd.cpp variants and never sends a managed variant', async () => {
  const page = await fixture({ provider: 'sdcpp' });
  const variant = page.input('images.variant'); variant.value = 'vulkan'; variant.fire('change');
  page.button('images.preview').fire('click'); await settle();
  assert.deepEqual(page.calls.find(call => call.path === '/images/install/plan').body, { provider: 'sdcpp', variant: 'vulkan' });
  const provider = page.input('images.provider'); provider.value = 'comfyui-managed'; provider.fire('change');
  page.button('images.preview').fire('click'); await settle();
  assert.deepEqual(page.calls.filter(call => call.path === '/images/install/plan').at(-1).body, { provider: 'comfyui-managed' });
  page.controller.dispose();
});

test('refresh recovers active setup progress and disposal stops polling without cancelling installation', async () => {
  const page = await fixture({ provider: 'sdcpp', installation: { id: 'active-job', state: 'running', phase: 'extracting' } });
  assert.ok(page.nodes().some(node => node.textContent === labels['images.extracting']));
  assert.equal(page.timers.size, 1);
  page.document.visibilityState = 'hidden';
  const [id, callback] = [...page.timers.entries()][0]; page.timers.delete(id); await callback();
  assert.equal(page.calls.length, 1);
  page.controller.dispose(); assert.equal(page.timers.size, 0);
  assert.equal(page.calls.some(call => call.path.endsWith('/cancel')), false);
});

test('PAP connection check reports that generation was not tested and sends no generation request', async () => {
  const page = await fixture({ provider: 'cloud' });
  page.button('images.test').fire('click'); await settle();
  assert.ok(page.nodes().some(node => node.textContent === labels['images.notGenerated']));
  assert.deepEqual(page.calls.filter(call => call.method === 'POST').map(call => call.path), ['/images/test']);
  page.controller.dispose();
});

test('image API paths remain narrow and setup writes use the existing protected token', async () => {
  const calls = [];
  const client = createSettingsClient(async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.endsWith('/bootstrap') ? { token: 't'.repeat(64) } : { ok: true }), { headers: { 'content-type': 'application/json' } });
  });
  await client.write('/images/install/plan', { provider: 'sdcpp' }, 'POST');
  await client.write('/images/secret', { version: 1, key: SECRET });
  await client.get('/images/install/job-1');
  await client.write('/images/install/job-1/cancel', {}, 'POST');
  assert.equal(calls.filter(call => call.url.endsWith('/bootstrap')).length, 1);
  assert.equal(calls.find(call => call.url.endsWith('/images/secret')).options.headers['X-Settings-Token'], 't'.repeat(64));
  for (const path of ['/images/install/../../secrets', '/images/install/arbitrary/id', '/images/download', '/images/secret?token=secret']) {
    await assert.rejects(client.get(path), error => error.code === 'INVALID_SETTINGS');
  }
});
