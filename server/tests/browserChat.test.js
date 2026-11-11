import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { mountBrowserChat, getBrowserChat, browserChatEnabled } from '../../src/browserChat.js';
import { ReplyParts } from '../../src/replyParts.js';

const source = fs.readFileSync(new URL('../../src/companion.js', import.meta.url), 'utf8');
function fixture(t, { desktop = false, overlay = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="companion-panel"><div class="panel-head"><h3>Amika</h3><div><button id="screen-share-btn">Share Screen</button><span id="mic-status"><span id="mic-dot"></span><span id="mic-label">Diam</span></span></div></div><div id="chat-log"></div><form id="chat-form"><input id="chat-input" maxlength="1000"><button id="chat-send" type="submit">Kirim</button></form></div></body></html>',
    { url: 'http://localhost:5173/' + (overlay ? '?mode=overlay' : '') });
  t.after(() => dom.window.close());
  if (desktop) dom.window.desktopBridge = {};
  const document = dom.window.document;
  const controller = mountBrowserChat({ document, canOpenSettings: true });
  return { dom, document, controller, log: document.getElementById('chat-log'),
    input: document.getElementById('chat-input'), send: document.getElementById('chat-send'),
    form: document.getElementById('chat-form'), unread: document.querySelector('.browser-chat-unread') };
}

test('browser chat never mounts in Electron normal or transparent overlay views', t => {
  for (const options of [{ desktop: true }, { overlay: true }]) {
    const f = fixture(t, options);
    assert.equal(f.controller, null);
    assert.equal(f.input.tagName, 'INPUT');
    assert.equal(f.document.documentElement.classList.contains('browser-workspace'), false);
    assert.equal(getBrowserChat(f.document), null);
  }
  assert.equal(browserChatEnabled({}), true);
});

test('messages render literal text and routine activity stays outside conversation', t => {
  const f = fixture(t);
  const malicious = '<img src=x onerror=alert(1)>';
  f.controller.log(malicious, 'user');
  f.controller.log('Aku mendengarkan.', 'assistant');
  f.controller.log('Penglihatan: meja kerja', 'vision');
  f.controller.log('Layar dibagikan.', 'muted');
  f.controller.log('Tidak terhubung.', 'error');
  assert.equal(f.log.querySelector('img'), null);
  assert.equal(f.log.querySelector('.user .browser-message-text').textContent, malicious);
  assert.equal(f.log.querySelectorAll('.log-line').length, 3);
  assert.equal(f.log.textContent.includes('meja kerja'), false);
  assert.equal(f.document.querySelector('.browser-chat-activity summary').textContent, 'Aktivitas (2)');
  assert.equal(f.log.querySelector('.error').getAttribute('role'), 'alert');
  assert.equal(f.document.querySelector('.browser-chat-empty'), null);
  assert.equal(f.document.querySelector('[aria-label="Pengaturan"]').tagName, 'BUTTON');
});

test('actual streamed reply adapter preserves stages and announces completion once', t => {
  const f = fixture(t);
  const log = (text, type, options) => f.controller.log(text, type, options);
  const start = source.indexOf('const replyParts = new ReplyParts(');
  const end = source.indexOf('\nfunction setMicStatus(', start);
  const replyParts = vm.compileFunction(source.slice(start, end) + '\nreturn replyParts;',
    ['ReplyParts', 'log', 'browserChat', 'logEl', 'showOverlaySubtitle'])(ReplyParts, log, f.controller, f.log, () => {});
  const partStart = source.indexOf("      case 'reply_part':");
  const partEnd = source.indexOf("      case 'emotion':", partStart);
  const handler = vm.compileFunction(source.slice(partStart, partEnd)
    .replace("      case 'reply_part':", '').replace(/\bbreak;/g, ''), ['msg', 'replyParts', 'chatView']);
  const handle = event => handler(event, replyParts, f.controller);
  const part = (stage, status, text) => ({ type: 'reply_part', turnId: 'one', partId: stage, stage, status, text });
  handle(part('surface', 'start', ''));
  assert.equal(f.log.querySelectorAll('.assistant').length, 0);
  handle(part('surface', 'delta', 'Aku dengar.'));
  assert.equal(f.document.querySelector('.browser-chat-announcer').textContent, '');
  handle(part('surface', 'done', 'Aku dengar.'));
  assert.equal(f.document.querySelector('.browser-chat-announcer').textContent, 'Amika: Aku dengar.');
  handle(part('deep', 'delta', 'Apa yang'));
  handle(part('deep', 'delta', ' terjadi?'));
  handle(part('deep', 'done', 'Apa yang terjadi?'));
  handle(part('deep', 'done', 'DUPLICATE'));
  assert.deepEqual([...f.log.querySelectorAll('.browser-message-text')].map(item => item.textContent),
    ['Aku dengar.', 'Apa yang terjadi?']);
  assert.equal(f.document.querySelector('.browser-chat-announcer').textContent, 'Amika: Apa yang terjadi?');
  assert.equal(replyParts.hasDisplayed('one'), true);
  replyParts.cancel('one');
  handle({ ...part('deep', 'delta', 'STALE'), partId: 'later' });
  assert.equal(f.log.querySelectorAll('.assistant').length, 2);
  handle({ ...part('deep', 'delta', 'Unfinished response'), turnId: 'two' });
  replyParts.cancel('two');
  handle({ ...part('deep', 'done', 'Cancelled response'), turnId: 'two' });
  assert.equal(f.document.querySelector('.browser-chat-announcer').textContent, 'Amika: Apa yang terjadi?');
});

test('new messages and streamed updates do not pull a reader away from older messages', t => {
  const f = fixture(t);
  Object.defineProperty(f.log, 'scrollHeight', { configurable: true, get: () => 1200 });
  Object.defineProperty(f.log, 'clientHeight', { configurable: true, get: () => 250 });
  f.log.scrollTop = 100;
  const message = f.controller.log('Halo', 'assistant', { streaming: true });
  f.controller.update(message, 'Halo, apa kabar?');
  assert.equal(f.log.scrollTop, 100);
  assert.equal(f.unread.hidden, false);
  f.unread.click();
  assert.equal(f.log.scrollTop, 1200);
  assert.equal(f.unread.hidden, true);
  f.log.scrollTop = 950;
  f.log.dispatchEvent(new f.dom.window.Event('scroll'));
  f.controller.log('Baik.', 'user');
  assert.equal(f.unread.hidden, true);
});

test('multiline composer sends Enter, keeps Shift+Enter and IME input, and limits length', t => {
  const f = fixture(t);
  let submissions = 0;
  f.form.addEventListener('submit', event => { event.preventDefault(); submissions++; });
  assert.equal(f.input.tagName, 'TEXTAREA');
  assert.equal(f.input.maxLength, 1000);
  f.controller.setConnection(true);
  f.input.value = 'Halo\nAmika';
  f.input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  assert.equal(f.send.disabled, false);
  const key = options => new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options });
  const newline = key({ shiftKey: true });
  f.input.dispatchEvent(newline);
  assert.equal(newline.defaultPrevented, false);
  f.input.dispatchEvent(key({ isComposing: true }));
  assert.equal(submissions, 0);
  f.input.dispatchEvent(key());
  assert.equal(submissions, 1);
  f.controller.resetComposer();
  assert.equal(f.input.value, '');
  assert.equal(f.send.disabled, true);
});

test('disconnects and response states keep the draft while preventing unavailable sends', t => {
  const f = fixture(t);
  f.input.value = 'Draf yang belum dikirim';
  f.input.dispatchEvent(new f.dom.window.Event('input'));
  assert.equal(f.send.disabled, true);
  assert.equal(f.input.disabled, false);
  f.controller.setConnection(true);
  assert.equal(f.send.disabled, false);
  f.controller.setBusy(true);
  assert.equal(f.input.disabled, true);
  f.controller.setConnection(false);
  f.controller.setBusy(false);
  assert.equal(f.input.value, 'Draf yang belum dikirim');
  assert.equal(f.input.disabled, false);
  assert.equal(f.send.disabled, true);
  assert.equal(f.document.querySelector('.browser-connection-status').hidden, false);
});
