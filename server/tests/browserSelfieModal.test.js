import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../src/browserSelfieModal.js', import.meta.url), 'utf8')
  .replace('export function handleBrowserSelfieModal', 'function handleBrowserSelfieModal');
const origin = 'http://localhost:5173';
const imagePath = `/api/selfies/${'a'.repeat(32)}`;
const started = (jobId, extra = {}) => ({ type: 'selfie_started', jobId, etaSeconds: null, ...extra });
const ready = (jobId, extra = {}) => ({ type: 'selfie_ready', jobId, imageUrl: imagePath, caption: 'Ini fotonya.', ...extra });
const snapshot = (activeJobId, events = []) => ({ type: 'selfie_snapshot', activeJobId, events });

function createBrowser() {
  const elements = new Map();
  const timers = new Map();
  const opens = [];
  const copies = [];
  let document;
  let nextTimer = 0;

  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName;
      this.style = {};
      this.attributes = {};
      this.listeners = new Map();
      this.generatedChildren = [];
      this.textContent = '';
      this.disabled = false;
      this.inert = false;
      const classes = new Set();
      this.classList = { add: (value) => classes.add(value), contains: (value) => classes.has(value) };
    }

    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
    get tabIndex() {
      if (this.attributes.tabindex !== undefined) return Number(this.attributes.tabindex);
      return this.tagName === 'button' || this.tagName === 'a' && this.href ? 0 : -1;
    }

    contains(element) { return this === element || this.generatedChildren.some((child) => child.contains(element)); }
    querySelectorAll() {
      return this.generatedChildren.flatMap((child) => [child, ...child.querySelectorAll()])
        .filter((child) => child.tagName === 'button' || child.tagName === 'a' && child.href || child.attributes.tabindex !== undefined);
    }
    focus() {
      document.activeElement = this;
      document.listeners.get('focusin')?.({ target: this });
    }
    appendChild(element) { element.parentNode = this; this.generatedChildren.push(element); }

    removeChildren() {
      for (const child of this.generatedChildren) {
        child.removeChildren();
        if (elements.get(child.id) === child) elements.delete(child.id);
        child.parentNode = null;
      }
      this.generatedChildren = [];
    }

    set innerHTML(value) {
      this.removeChildren();
      this._html = value;
      for (const match of value.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
        const attributes = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((attribute) => [attribute[1], attribute[2]]));
        if (!attributes.id) continue;
        const child = new Element(match[1]);
        child.attributes = attributes;
        child.textContent = value.slice(match.index + match[0].length).match(/^[^<]*/)[0];
        child.id = attributes.id;
        this.appendChild(child);
      }
    }

    get innerHTML() { return this._html; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    set src(value) {
      this.handlersInstalledBeforeSrc = typeof this.onload === 'function' && typeof this.onerror === 'function';
      this._src = value;
    }
    get src() { return this._src; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    async dispatch(type, fields = {}) {
      const event = {
        target: this, currentTarget: this, defaultPrevented: false, propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        ...fields,
      };
      const result = this.listeners.get(type)?.(event);
      if (!event.propagationStopped) document.listeners.get(type)?.(event);
      event.currentTarget = null;
      await result;
      return event;
    }
  }

  const appended = [];
  const body = new Element('body');
  document = {
    createElement: (tag) => new Element(tag),
    getElementById: (id) => elements.get(id),
    listeners: new Map(),
    addEventListener(type, callback) { this.listeners.set(type, callback); },
    body,
    activeElement: body,
  };
  Object.defineProperty(body, 'children', { get: () => body.generatedChildren });
  body.appendChild = (element) => {
    element.parentNode = body;
    body.generatedChildren.push(element);
    appended.push(element);
  };
  const context = vm.createContext({
    document,
    window: { location: { origin }, open: (...args) => opens.push(args) },
    navigator: { clipboard: { writeText: async (value) => copies.push(value) } },
    URL,
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(source, context, { filename: 'browserSelfieModal.js' });
  return {
    handle: context.handleBrowserSelfieModal,
    element: (id) => elements.get(id),
    appended,
    timers,
    opens,
    copies,
    document,
    addBackground() {
      const element = new Element('button');
      body.appendChild(element);
      return element;
    },
    fireTimer(id) { const timer = timers.get(id); timers.delete(id); timer.callback(); },
  };
}

test('browser selfie progress keeps unknown ETA and clamps provider progress', () => {
  const browser = createBrowser();
  browser.handle(null);
  browser.handle({ type: 'chat', jobId: 'job-a' });
  browser.handle(started('queued', { status: 'queued' }));
  browser.handle({ type: 'selfie_progress', jobId: 'job-a', value: 1, max: 2 });
  assert.equal(browser.appended.length, 0);
  browser.handle(started('job-a'));
  assert.equal(browser.element('b-eta').textContent, 'Estimasi belum tersedia');
  browser.handle({ type: 'selfie_progress', jobId: 'job-a', value: 2, max: 5 });
  assert.equal(browser.element('b-fill').style.width, '40%');
  assert.equal(browser.element('b-progress').getAttribute('aria-valuenow'), '40');
  browser.handle(started('job-a', { etaSeconds: 0 }));
  assert.equal(browser.element('b-eta').textContent, 'Estimasi ~0s');
  assert.equal(browser.element('b-fill').style.width, '40%');
  for (const [percentage, expected] of [[300, '100%'], [-10, '0%'], [NaN, '0%'], [Infinity, '0%']]) {
    browser.handle({ type: 'selfie_progress', jobId: 'job-a', percentage });
    assert.equal(browser.element('b-fill').style.width, expected);
  }
  browser.handle({ type: 'selfie_progress', jobId: 'job-a', value: 1, max: 0 });
  assert.equal(browser.element('b-fill').style.width, '0%');
});

test('browser ready caption stays text and actions use the validated token URL', async () => {
  const browser = createBrowser();
  const caption = '<img src="https://evil.example" onerror="alert(1)">';
  browser.handle(ready('job-a', { caption, autoCloseSeconds: 0 }));
  assert.equal(browser.element('b-caption').textContent, `"${caption}"`);
  assert.equal(browser.element('b-card').innerHTML.includes(caption), false);
  const image = browser.element('b-preview-img');
  assert.equal(image.src, origin + imagePath);
  assert.equal(image.handlersInstalledBeforeSrc, true);
  image.onload();
  assert.equal(image.classList.contains('loaded'), true);
  assert.equal(browser.element('b-img-wrap').tagName, 'button');
  assert.equal(browser.element('b-btn-save').href, origin + imagePath);
  assert.equal(browser.element('b-btn-save').getAttribute('rel'), 'noopener noreferrer');
  await browser.element('b-img-wrap').dispatch('click');
  assert.deepEqual(browser.opens, [[origin + imagePath, '_blank', 'noopener,noreferrer']]);
  await browser.element('b-btn-copy-url').dispatch('click');
  assert.deepEqual(browser.copies, [origin + imagePath]);
  assert.equal(browser.element('b-btn-copy-url').textContent, 'Disalin');
});

test('browser rejects remote and malformed image URLs before creating content', () => {
  const invalidUrls = [
    'https://evil.example' + imagePath,
    'http://localhost:8787' + imagePath,
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    origin + '/api/selfies/invalid',
    origin + imagePath + '?token=extra',
    origin + imagePath + '#fragment',
    `http://user:password@localhost:5173${imagePath}`,
    imagePath + '" onerror="alert(1)',
    {},
  ];
  for (const imageUrl of invalidUrls) {
    const browser = createBrowser();
    browser.handle(ready('job-a', { imageUrl }));
    assert.equal(browser.appended.length, 0, String(imageUrl));
    browser.handle(started('job-a'));
    browser.handle(ready('job-a', { imageUrl }));
    assert.ok(browser.element('b-fill'));
    assert.equal(browser.element('b-preview-img'), undefined);
  }
  const browser = createBrowser();
  browser.handle(ready('job-a', { imageUrl: origin + imagePath }));
  assert.equal(browser.element('b-preview-img').src, origin + imagePath);
});

test('browser consecutive jobs reuse one root and ignore stale events and queued starts', () => {
  const browser = createBrowser();
  browser.handle(started('job-a'));
  browser.handle(started('queued-b', { status: 'queued' }));
  browser.handle(ready('unknown-job'));
  assert.ok(browser.element('b-fill'));
  browser.handle(ready('job-a'));
  browser.handle(started('job-b'));
  browser.handle({ type: 'selfie_progress', jobId: 'job-b', value: 1, max: 2 });
  for (const message of [ready('job-a'), { type: 'selfie_cancelled', jobId: 'job-a' }, { type: 'selfie_failed', jobId: 'job-a' }]) browser.handle(message);
  assert.equal(browser.element('b-fill').style.width, '50%');
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'block');
  browser.handle(ready('job-b'));
  const timer = [...browser.timers.keys()][0];
  for (const type of ['selfie_progress', 'selfie_failed', 'selfie_cancelled']) browser.handle({ type, jobId: 'job-b', percentage: 99 });
  browser.handle(ready('job-b'));
  assert.equal(browser.appended.length, 1);
  assert.equal(browser.timers.size, 1);
  assert.ok(browser.timers.has(timer));
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'block');
});

test('browser cancel dispatches the active job and keeps retry visible when unavailable', async () => {
  for (const onCancel of [null, () => false, () => { throw new Error('Socket closed'); }]) {
    const browser = createBrowser();
    browser.handle(started('job-a'), onCancel);
    await browser.element('b-btn-cancel-job').dispatch('click');
    assert.equal(browser.element('browser-selfie-modal-root').style.display, 'block');
    assert.equal(browser.element('b-btn-cancel-job').disabled, false);
    assert.equal(browser.element('b-step').textContent, 'Belum terhubung. Coba batal lagi.');
  }
  const browser = createBrowser();
  const cancellations = [];
  browser.handle(started('job-a'), (jobId) => { cancellations.push(jobId); return true; });
  await browser.element('b-btn-cancel-job').dispatch('click');
  assert.deepEqual(cancellations, ['job-a']);
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'block');
  assert.equal(browser.element('b-btn-cancel-job').disabled, true);
  assert.equal(browser.element('b-step').textContent, 'Membatalkan...');
  browser.handle(started('job-a'));
  browser.handle({ type: 'selfie_progress', jobId: 'job-a', percentage: 85 });
  assert.equal(browser.element('b-step').textContent, 'Membatalkan...');
  browser.handle(ready('job-a'));
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'block');
  assert.ok(browser.element('b-preview-img'));
});

test('browser cancel waits for server cancellation and does not revive a cancelled job', async () => {
  const browser = createBrowser();
  browser.handle(started('job-a'), () => true);
  await browser.element('b-btn-cancel-job').dispatch('click');
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'block');
  browser.handle({ type: 'selfie_cancelled', jobId: 'job-a' });
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'none');
  browser.handle(ready('job-a'));
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'none');
});

test('browser ready survives either cancellation callback outcome after Cancel', async () => {
  for (const result of [true, false]) {
    const browser = createBrowser();
    let completeCancellation;
    browser.handle(started('job-a'), () => new Promise((resolve) => { completeCancellation = resolve; }));
    const cancellation = browser.element('b-btn-cancel-job').dispatch('click');
    browser.handle(ready('job-a', { autoCloseSeconds: 0 }));
    completeCancellation(result);
    await cancellation;
    assert.equal(browser.element('browser-selfie-modal-root').style.display, 'block');
    assert.ok(browser.element('b-preview-img'));
    assert.equal(browser.element('b-caption').textContent, '"Ini fotonya."');
  }
});

test('browser pending cancellation cannot dismiss a newer job', async () => {
  const browser = createBrowser();
  let completeCancellation;
  browser.handle(started('job-a'), () => new Promise((resolve) => { completeCancellation = resolve; }));
  const cancellation = browser.element('b-btn-cancel-job').dispatch('click');
  browser.handle(started('job-b'));
  completeCancellation(true);
  await cancellation;
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'block');
  assert.equal(browser.element('b-btn-cancel-job').disabled, false);
  browser.handle({ type: 'selfie_cancelled', jobId: 'job-b' });
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'none');
});

test('browser ready snapshots honor optional auto-close and keyboard dismissal', async () => {
  const browser = createBrowser();
  browser.handle(ready('job-a'));
  const [timerId, timer] = [...browser.timers.entries()][0];
  assert.equal(timer.delay, 30000);
  browser.fireTimer(timerId);
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'none');
  browser.handle(ready('job-a'));
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'none');
  browser.handle(ready('job-b', { autoCloseSeconds: 0 }));
  assert.equal(browser.timers.size, 0);
  browser.element('b-preview-img').onerror();
  assert.equal(browser.element('b-caption').textContent, 'Foto gagal dimuat. Coba buka lagi nanti.');
  await browser.element('browser-selfie-modal-root').dispatch('keydown', { key: 'Escape' });
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'none');
  browser.handle(started('job-c'));
  await browser.element('browser-selfie-modal-root').dispatch('keydown', { key: 'Escape' });
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'none');
  browser.handle(ready('job-d', { autoCloseSeconds: 5 }));
  assert.equal([...browser.timers.values()][0].delay, 5000);
  assert.equal(browser.appended.length, 1);
});

test('browser authoritative empty snapshot hides without creating a root and clears old timers', async () => {
  const browser = createBrowser();
  browser.handle(snapshot(null));
  assert.equal(browser.appended.length, 0);
  browser.handle(ready('job-a'));
  await browser.element('b-btn-copy-url').dispatch('click');
  const staleTimers = [...browser.timers.values()];
  assert.equal(staleTimers.length, 2);
  browser.handle(snapshot(null));
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'none');
  assert.equal(browser.timers.size, 0);
  browser.handle(snapshot(null, [ready('job-a', { autoCloseSeconds: 0 })]));
  for (const timer of staleTimers) timer.callback();
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'block');
  assert.ok(browser.element('b-preview-img'));
  assert.equal(browser.timers.size, 0);
  assert.equal(browser.appended.length, 1);
});

test('browser snapshot resets a retired job and replays authoritative progress or ready', () => {
  const browser = createBrowser();
  browser.handle(started('job-a'));
  browser.handle(started('job-b'));
  browser.handle(snapshot('job-a', [
    started('job-a', { etaSeconds: 9 }),
    { type: 'selfie_progress', jobId: 'job-a', value: 3, max: 4 },
  ]));
  assert.equal(browser.element('b-fill').style.width, '75%');
  assert.equal(browser.element('b-eta').textContent, 'Estimasi ~9s');
  browser.handle(snapshot(null, [ready('job-a', { autoCloseSeconds: 0 })]));
  assert.ok(browser.element('b-preview-img'));
  assert.equal(browser.timers.size, 0);
  browser.handle(snapshot('job-c', [started('job-c')]));
  assert.ok(browser.element('b-fill'));
  assert.equal(browser.element('b-preview-img'), undefined);
  assert.equal(browser.appended.length, 1);
});

test('browser stale cancellation callback cannot change the same job after a snapshot reset', async () => {
  const browser = createBrowser();
  let completeCancellation;
  browser.handle(started('job-a'), () => new Promise((resolve) => { completeCancellation = resolve; }));
  const cancellation = browser.element('b-btn-cancel-job').dispatch('click');
  browser.handle(snapshot('job-a', [started('job-a')]), () => true);
  completeCancellation(false);
  await cancellation;
  assert.equal(browser.element('b-btn-cancel-job').disabled, false);
  assert.equal(browser.element('b-step').textContent, 'Menyiapkan pose...');
});

test('browser snapshot isolates old image and copy feedback callbacks for the same job', async () => {
  const browser = createBrowser();
  browser.handle(ready('job-a', { autoCloseSeconds: 0 }));
  const oldImage = browser.element('b-preview-img');
  await browser.element('b-btn-copy-url').dispatch('click');
  const oldFeedback = [...browser.timers.values()][0];
  browser.handle(snapshot(null, [ready('job-a', { autoCloseSeconds: 0, caption: 'Foto terbaru.' })]));
  await browser.element('b-btn-copy-url').dispatch('click');
  assert.equal(browser.timers.size, 1);
  oldImage.onerror();
  oldFeedback.callback();
  assert.equal(browser.element('b-caption').textContent, '"Foto terbaru."');
  assert.equal(browser.element('b-btn-copy-url').textContent, 'Disalin');
  browser.handle(snapshot(null));
  assert.equal(browser.timers.size, 0);
});

test('browser completed ready snapshots with no active job replace a different or same job', () => {
  for (const previousJobId of ['job-old', 'job-ready']) {
    const browser = createBrowser();
    browser.handle(ready(previousJobId, { autoCloseSeconds: 2, caption: 'Foto sebelumnya.' }));
    const oldTimer = [...browser.timers.values()][0];
    browser.handle(snapshot(null, [ready('job-ready', { autoCloseSeconds: 0, caption: 'Foto terbaru.' })]));
    oldTimer.callback();
    assert.equal(browser.element('browser-selfie-modal-root').style.display, 'block');
    assert.equal(browser.element('b-caption').textContent, '"Foto terbaru."');
    assert.equal(browser.timers.size, 0);
    assert.equal(browser.appended.length, 1);
  }
});

test('browser ignores incoherent snapshot event types and job IDs before resetting', () => {
  const browser = createBrowser();
  browser.handle(ready('job-visible'));
  const image = browser.element('b-preview-img');
  const timerId = [...browser.timers.keys()][0];
  for (const message of [
    snapshot(null, [started('job-a')]),
    snapshot(null, [ready('job-a'), ready('job-a')]),
    snapshot('job-a', [started('job-a'), { type: 'selfie_progress', jobId: 'job-b' }]),
    snapshot('job-a', [ready('job-b')]),
    snapshot('job-a', [{ type: 'selfie_progress', jobId: 'job-a' }]),
    snapshot('job-a', [started('job-a'), { type: 'selfie_failed', jobId: 'job-a' }]),
    snapshot(null, [ready('job-a', { imageUrl: 'https://evil.example/image.png' })]),
  ]) browser.handle(message);
  assert.equal(browser.element('b-preview-img'), image);
  assert.equal(browser.timers.has(timerId), true);
  assert.equal(browser.element('browser-selfie-modal-root').style.display, 'block');
});

test('browser dialog captures focus, traps Tab and restores prior focus on close', async () => {
  const browser = createBrowser();
  const trigger = browser.addBackground();
  const alreadyInert = browser.addBackground();
  alreadyInert.inert = true;
  trigger.focus();
  browser.handle(started('job-a'));
  const card = browser.element('b-card');
  const cancel = browser.element('b-btn-cancel-job');
  assert.equal(card.getAttribute('role'), 'dialog');
  assert.equal(card.getAttribute('aria-modal'), 'true');
  assert.equal(card.getAttribute('aria-label'), 'Foto Amika');
  assert.equal(browser.document.activeElement, cancel);
  assert.equal(trigger.inert, true);
  assert.equal((await cancel.dispatch('keydown', { key: 'Tab' })).defaultPrevented, true);
  assert.equal(browser.document.activeElement, cancel);
  browser.handle(ready('job-a', { autoCloseSeconds: 0 }));
  const first = browser.element('b-btn-close-card');
  const last = browser.element('b-btn-dismiss');
  assert.equal(browser.document.activeElement, first);
  await first.dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(browser.document.activeElement, last);
  await last.dispatch('keydown', { key: 'Tab' });
  assert.equal(browser.document.activeElement, first);
  trigger.focus();
  assert.equal(browser.document.activeElement, first);
  await last.dispatch('click');
  assert.equal(browser.document.activeElement, trigger);
  assert.equal(trigger.inert, false);
  assert.equal(alreadyInert.inert, true);
});

test('browser Escape dismisses progress and cancelling states and restores focus', async () => {
  for (const cancelling of [false, true]) {
    const browser = createBrowser();
    const trigger = browser.addBackground();
    trigger.focus();
    browser.handle(started('job-a'), () => true);
    if (cancelling) {
      await browser.element('b-btn-cancel-job').dispatch('click');
      assert.equal(browser.document.activeElement, browser.element('b-card'));
    }
    await browser.element('b-card').dispatch('keydown', { key: 'Escape' });
    assert.equal(browser.element('browser-selfie-modal-root').style.display, 'none');
    assert.equal(browser.document.activeElement, trigger);
    assert.equal(trigger.inert, false);
  }
});
