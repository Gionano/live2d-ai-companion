import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const popupHtml = fs.readFileSync(new URL('../../../desktop-companion/src/popup/selfiePopup.html', import.meta.url), 'utf8');
const scripts = [...popupHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

function createPopup(overrides = {}, imageOrigin = 'http://127.0.0.1:8787') {
  const elements = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  const calls = { close: 0, cancel: [], resize: [], resizeModes: [], save: [], copy: [], folder: 0, handshake: 0 };
  const policies = [];
  let onEvent;
  let nextTimer = 1;

  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set();
    const listeners = new Map();
    const node = {
      id,
      style: {},
      textContent: '',
      innerHTML: id,
      disabled: false,
      hidden: false,
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
      addEventListener: (type, handler) => listeners.set(type, handler),
      removeAttribute: (name) => { delete node[name]; },
      focus: () => {},
      click: async () => listeners.get('click')?.({}),
      key: (key) => listeners.get('keydown')?.({ key, preventDefault() {} }),
    };
    elements.set(id, node);
    return node;
  }

  const context = vm.createContext({
    URL,
    URLSearchParams,
    location: { search: `?imageOrigin=${encodeURIComponent(imageOrigin)}` },
    document: {
      head: { appendChild: (node) => policies.push(node) },
      createElement: (tag) => ({ tag }),
      getElementById: element,
      addEventListener: (type, handler) => element('document').addEventListener(type, handler),
    },
    window: {
      selfieApi: {
        onSelfieEvent: (handler) => { onEvent = handler; },
        ready: () => { assert.equal(typeof onEvent, 'function'); calls.handshake += 1; },
        closePopup: () => { calls.close += 1; },
        resizeWindow: (width, height, zoomed) => {
          calls.resize.push({ width, height });
          calls.resizeModes.push(zoomed);
        },
        cancelJob: (jobId) => { calls.cancel.push(jobId); return { ok: true, cancelled: true }; },
        saveImage: async (url) => { calls.save.push(url); return { saved: true }; },
        copyImage: async (url) => { calls.copy.push(url); return true; },
        openFolder: async () => { calls.folder += 1; return true; },
        ...overrides,
      },
    },
    setInterval: (callback) => { const id = nextTimer++; intervals.set(id, callback); return id; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (callback) => { const id = nextTimer++; timeouts.set(id, callback); return id; },
    clearTimeout: (id) => timeouts.delete(id),
  });
  for (const source of scripts) vm.runInContext(source, context);
  return {
    elements,
    intervals,
    timeouts,
    calls,
    policies,
    element,
    emit: (payload) => onEvent(payload),
    loadImage: () => element('selfie-img').onload?.(),
  };
}

function start(popup, jobId = 'first', fields = {}) {
  popup.emit({ type: 'selfie_started', jobId, etaSeconds: null, ...fields });
}

function ready(popup, jobId = 'first', fields = {}) {
  popup.emit({ type: 'selfie_ready', jobId, imageUrl: `http://127.0.0.1:8787/api/selfie/${jobId}.png`, ...fields });
  popup.loadImage();
}

test('popup subscribes before handshake and restricts images to the configured loopback origin', () => {
  const popup = createPopup({}, 'http://localhost:9191');
  assert.equal(popup.calls.handshake, 1);
  assert.match(popup.policies[0].content, /img-src http:\/\/localhost:9191;/);
  assert.doesNotMatch(popup.policies[0].content, /localhost:\*|127\.0\.0\.1:\*|data:/);
  const remote = createPopup({}, 'https://example.com');
  assert.match(remote.policies[0].content, /img-src http:\/\/127\.0\.0\.1:8787;/);
});

test('accepted ready snapshots replace an old hidden popup job after feature reenable', () => {
  const popup = createPopup();
  start(popup, 'old');
  ready(popup, 'new', { replaceJob: true, autoCloseSeconds: 0 });
  assert.equal(popup.element('state-ready').style.display, 'flex');
  assert.match(popup.element('selfie-img').src, /new/);
  popup.emit({ type: 'selfie_cancelled', jobId: 'old' });
  assert.equal(popup.element('state-ready').style.display, 'flex');
});

test('popup reset clears stale auto-close, feedback and image state before reconnect replay or none', async () => {
  const popup = createPopup();
  start(popup, 'old');
  ready(popup, 'old', { autoCloseSeconds: 30 });
  await popup.element('btn-copy').click();
  assert.equal(popup.timeouts.size, 1);
  popup.emit({ type: 'selfie_reset' });
  assert.equal(popup.intervals.size, 0);
  assert.equal(popup.timeouts.size, 0);
  assert.equal(popup.element('selfie-img').src, undefined);
  assert.equal(popup.element('state-ready').style.display, 'none');
  assert.equal(popup.element('state-generating').style.display, 'none');
  ready(popup, 'new', { replaceJob: true, autoCloseSeconds: 0, cardSize: { width: 320, height: 120 } });
  assert.equal(popup.element('state-ready').style.overflowY, 'auto');
  assert.equal(popup.element('image-wrapper').style.minHeight, '64px');
  assert.equal(popup.element('btn-save').disabled, false);
  popup.emit({ type: 'selfie_layout', jobId: 'new', cardSize: { width: 360, height: 520 } });
  assert.equal(popup.element('state-ready').style.overflowY, 'auto');
  assert.equal(popup.element('image-wrapper').style.minHeight, '0');
});

test('ready content can scroll at every size and preserves caption and action rows', async () => {
  const readyStyles = popupHtml.match(/#state-ready\s*\{([^}]+)\}/)[1];
  assert.match(readyStyles, /min-height:\s*0;/);
  assert.match(readyStyles, /overflow-y:\s*auto;/);
  assert.match(popupHtml, /#state-ready > :not\(\.image-preview-wrapper\)\s*\{\s*flex-shrink:\s*0;/);
  assert.match(popupHtml, /\.caption-box\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  assert.match(popupHtml, /\.action-buttons\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(80px, 1fr\)\);/);

  for (const cardSize of [{ width: 320, height: 120 }, { width: 200, height: 520 }, { width: 360, height: 520 }]) {
    const popup = createPopup();
    const caption = 'Ini fotonya buat kamu. '.repeat(80);
    ready(popup, 'first', { cardSize, caption, autoCloseSeconds: 0 });
    assert.equal(popup.element('state-ready').style.overflowY, 'auto');
    assert.equal(popup.element('caption-box').textContent, `"${caption}"`);
    for (const id of ['btn-close', 'btn-save', 'btn-copy', 'btn-folder']) {
      assert.equal(popup.element(id).hidden, false, `${id} must remain available at ${cardSize.width}x${cardSize.height}`);
      assert.equal(popup.element(id).disabled, false);
    }
    await popup.element('btn-save').click();
    await popup.element('btn-copy').click();
    await popup.element('btn-folder').click();
    assert.equal(popup.calls.save.length, 1);
    assert.equal(popup.calls.copy.length, 1);
    assert.equal(popup.calls.folder, 1);
    await popup.element('btn-close').click();
    assert.equal(popup.calls.close, 1);
  }
});

test('zoom, display change and shrink consume the actual placement and clear compact sizing', async () => {
  const popup = createPopup();
  ready(popup, 'first', { cardSize: { width: 320, height: 120 }, autoCloseSeconds: 0 });
  assert.equal(popup.element('image-wrapper').style.minHeight, '64px');
  await popup.element('image-wrapper').click();
  assert.equal(popup.calls.resizeModes.at(-1), true);

  popup.emit({ type: 'selfie_layout', jobId: 'first', cardSize: { width: 576, height: 448 }, zoomed: true });
  assert.equal(popup.element('image-wrapper').style.minHeight, '64px');
  popup.emit({ type: 'selfie_layout', jobId: 'first', cardSize: { width: 720, height: 720 }, zoomed: true });
  assert.equal(popup.element('image-wrapper').style.minHeight, '0');
  assert.equal(popup.element('zoom-overlay').style.display, 'flex');

  popup.element('document').key('Escape');
  assert.equal(popup.calls.resizeModes.at(-1), false);
  assert.deepEqual(popup.calls.resize.at(-1), { width: 320, height: 120 }, 'Zoom layout must not replace the last card dimensions');
  popup.emit({ type: 'selfie_layout', jobId: 'first', cardSize: { width: 360, height: 520 }, zoomed: false });
  assert.equal(popup.element('zoom-overlay').style.display, 'none');
  assert.equal(popup.element('image-wrapper').style.minHeight, '0');
  assert.equal(popup.element('state-ready').style.overflowY, 'auto');

  popup.emit({ type: 'selfie_layout', jobId: 'first', cardSize: { width: 300, height: 150 }, zoomed: false });
  assert.equal(popup.element('image-wrapper').style.minHeight, '64px');
  popup.emit({ type: 'selfie_layout', jobId: 'first', cardSize: { width: 360, height: 520 }, zoomed: false });
  popup.emit({ type: 'selfie_layout', jobId: 'old', cardSize: { width: 320, height: 120 }, zoomed: false });
  assert.equal(popup.element('image-wrapper').style.minHeight, '0', 'A stale layout cannot restore compact styling');
  await popup.element('image-wrapper').click();
  popup.element('document').key('Escape');
  assert.deepEqual(popup.calls.resize.at(-1), { width: 360, height: 520 });
  assert.equal(popup.intervals.size, 0);
});

test('same-job reconnect reset isolates a pending popup cancellation callback', async () => {
  let finish;
  const popup = createPopup({ cancelJob: () => new Promise(resolve => { finish = resolve; }) });
  start(popup, 'same');
  const pending = popup.element('btn-cancel').click();
  popup.emit({ type: 'selfie_reset' });
  start(popup, 'same');
  popup.emit({ type: 'selfie_progress', jobId: 'same', value: 2, max: 4 });
  finish({ ok: false });
  await pending;
  assert.equal(popup.element('progress-text').textContent, 'Memproses foto... (50%)');
  assert.equal(popup.element('btn-cancel').textContent, 'Batal');
  assert.equal(popup.element('btn-cancel').disabled, false);
});

test('same-job reconnect ready isolates a pending popup image action callback', async () => {
  let finish;
  const popup = createPopup({ copyImage: () => new Promise(resolve => { finish = resolve; }) });
  ready(popup, 'same', { autoCloseSeconds: 0 });
  const pending = popup.element('btn-copy').click();
  popup.emit({ type: 'selfie_reset' });
  ready(popup, 'same', { replaceJob: true, autoCloseSeconds: 0 });
  finish({ copied: true });
  await pending;
  assert.equal(popup.element('btn-copy').innerHTML, 'btn-copy');
  assert.notEqual(popup.element('btn-copy').textContent, 'Tersalin');
  assert.equal(popup.timeouts.size, 0);
});

test('popup preserves unknown and zero ETA, and configured zero disables auto-close', () => {
  const popup = createPopup();
  start(popup);
  assert.equal(popup.element('eta-text').textContent, 'Estimasi belum tersedia');
  start(popup, 'second', { etaSeconds: 0 });
  assert.equal(popup.element('eta-text').textContent, 'Estimasi: ~0s');
  ready(popup, 'second', { autoCloseSeconds: 0 });
  assert.equal(popup.intervals.size, 0);
  popup.element('image-wrapper').key('Enter');
  popup.element('document').key('Escape');
  assert.equal(popup.intervals.size, 0, 'Closing zoom must honor disabled auto-close');
});

test('consecutive popup jobs clear zoom, image, action feedback, and timers, and ignore stale events', async () => {
  const popup = createPopup();
  start(popup);
  ready(popup, 'first', { autoCloseSeconds: 30, cardSize: { width: 400, height: 550 } });
  assert.equal(popup.intervals.size, 1);
  await popup.element('btn-copy').click();
  assert.equal(popup.element('btn-copy').textContent, 'Tersalin');
  assert.equal(popup.timeouts.size, 1);
  await popup.element('image-wrapper').click();
  assert.equal(popup.element('zoom-overlay').style.display, 'flex');
  popup.element('document').key('Escape');
  assert.deepEqual(popup.calls.resize.at(-1), { width: 400, height: 550 });
  await popup.element('image-wrapper').click();
  start(popup, 'second');
  assert.equal(popup.element('zoom-overlay').style.display, 'none');
  assert.equal(popup.element('selfie-img').src, undefined);
  assert.equal(popup.element('btn-copy').classList.contains('success'), false);
  assert.equal(popup.element('btn-copy').disabled, true);
  assert.equal(popup.timeouts.size, 0);
  assert.equal(popup.intervals.size, 0);
  popup.emit({ type: 'selfie_progress', jobId: 'first', percentage: 90 });
  popup.emit({ type: 'selfie_failed', jobId: 'first' });
  ready(popup, 'first');
  assert.equal(popup.element('state-generating').style.display, 'flex');
  assert.equal(popup.element('progress-fill').style.width, '0%');
  assert.equal(popup.element('selfie-img').src, undefined);
  assert.equal(popup.calls.close, 0);
});

test('queued or replayed starts do not replace a running popup or re-enable a pending cancellation', async () => {
  let resolveCancel;
  const popup = createPopup({ cancelJob: () => new Promise((resolve) => { resolveCancel = resolve; }) });
  start(popup, 'running');
  const cancellation = popup.element('btn-cancel').click();
  assert.equal(popup.element('btn-cancel').disabled, true);
  start(popup, 'queued', { status: 'queued', etaSeconds: 99 });
  start(popup, 'running');
  assert.equal(popup.element('btn-cancel').disabled, true);
  assert.equal(popup.element('eta-text').textContent, 'Estimasi belum tersedia');
  resolveCancel({ ok: true, cancelled: true });
  await cancellation;
  assert.equal(popup.calls.close, 0, 'Wait for the server terminal event');
  popup.emit({ type: 'selfie_cancelled', jobId: 'running' });
  assert.equal(popup.element('progress-text').textContent, 'Foto dibatalkan.');
  assert.equal(popup.element('btn-cancel').hidden, true);
});

test('failed cancellation remains visible and allows retry for the same job', async () => {
  const popup = createPopup({ cancelJob: async () => ({ ok: false, cancelled: false }) });
  start(popup);
  await popup.element('btn-cancel').click();
  assert.equal(popup.calls.close, 0);
  assert.equal(popup.element('btn-cancel').disabled, false);
  assert.equal(popup.element('btn-cancel').textContent, 'Coba batal');
  assert.equal(popup.element('progress-text').textContent, 'Gagal membatalkan. Coba lagi.');
});

test('copy false does not report success and broken images expose a folder fallback', async () => {
  const popup = createPopup({ copyImage: async () => false });
  start(popup);
  ready(popup);
  await popup.element('btn-copy').click();
  assert.equal(popup.element('btn-copy').classList.contains('success'), false);
  assert.equal(popup.element('auto-close-hint').textContent, 'Foto gagal disalin. Coba lagi.');
  start(popup, 'second');
  popup.emit({ type: 'selfie_ready', jobId: 'second', imageUrl: 'http://127.0.0.1:8787/api/selfie/missing.png' });
  popup.element('selfie-img').onerror();
  assert.equal(popup.element('image-status').textContent, 'Foto gagal dimuat. Buka Folder untuk melihat hasilnya.');
  assert.equal(popup.element('btn-save').disabled, true);
  assert.equal(popup.element('btn-copy').disabled, true);
  assert.equal(popup.element('btn-folder').disabled, false);
});

test('reopening the same ready result resets its old countdown and zoom state', async () => {
  const popup = createPopup();
  start(popup);
  ready(popup, 'first', { autoCloseSeconds: 2 });
  const previousTimer = [...popup.intervals.keys()][0];
  await popup.element('image-wrapper').click();
  ready(popup, 'first', { autoCloseSeconds: 30 });
  assert.equal(popup.element('zoom-overlay').style.display, 'none');
  assert.equal(popup.intervals.has(previousTimer), false);
  assert.equal(popup.intervals.size, 1);
  assert.equal(popup.element('auto-close-hint').textContent, 'Menutup otomatis dalam 30s');
});

test('async results from an earlier job cannot modify buttons or cancellation status on the next job', async () => {
  let resolveCopy;
  let resolveCancel;
  const popup = createPopup({
    copyImage: () => new Promise((resolve) => { resolveCopy = resolve; }),
    cancelJob: () => new Promise((resolve) => { resolveCancel = resolve; }),
  });
  start(popup);
  const cancellation = popup.element('btn-cancel').click();
  ready(popup);
  const copy = popup.element('btn-copy').click();
  start(popup, 'second');
  resolveCopy(true);
  resolveCancel({ ok: false });
  await Promise.all([copy, cancellation]);
  assert.equal(popup.element('btn-copy').classList.contains('success'), false);
  assert.equal(popup.element('btn-copy').disabled, true);
  assert.equal(popup.element('btn-cancel').disabled, false);
  assert.equal(popup.element('btn-cancel').textContent, 'Batal');
  assert.equal(popup.element('progress-text').textContent, 'Menyiapkan kamera...');
});
