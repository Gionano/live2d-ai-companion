import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { EventEmitter, once } from 'node:events';
import { JobManager } from '../jobManager.js';

const TOKEN = 'a'.repeat(32);
const IMAGE_URL = `http://localhost:8787/api/selfies/${TOKEN}`;
const PLAN = { slots: {}, positivePrompt: 'portrait', negativePrompt: 'blur', caption: 'Ini fotonya.', emotion: 'sayang' };

function harness(t, sender = async () => true) {
  const windows = [];
  const timers = new Map();
  let nextTimer = 0;
  const effects = { protections: 0, fetched: [], copied: [], folders: [], dialogs: [] };
  class FakeWindow extends EventEmitter {
    constructor(options = {}) {
      super();
      this.options = options;
      this.bounds = { x: 750, y: 140, width: 300, height: 400, ...options };
      this.visible = false;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = {};
      this.webContents.sent = [];
      this.webContents.send = (channel, event) => this.webContents.sent.push({ channel, event });
      this.webContents.setWindowOpenHandler = (callback) => { this.windowOpen = callback; };
      this.webContents.session = {
        setPermissionCheckHandler: (callback) => { this.permissionCheck = callback; },
        setPermissionRequestHandler: (callback) => { this.permissionRequest = callback; },
      };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; }
    setContentProtection(enabled) { this.protected = enabled; }
    setAlwaysOnTop(enabled) { this.onTop = enabled; }
    setIgnoreMouseEvents(enabled) { this.ignoreMouse = enabled; }
    loadFile(file, options) { this.loaded = { file, options }; return Promise.resolve(); }
    showInactive() { this.visible = true; this.emit('show'); }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  ipcMain.removeHandler = (channel) => handlers.delete(channel);
  const screen = new EventEmitter();
  screen.workArea = { x: 0, y: 0, width: 1200, height: 800 };
  screen.getDisplayMatching = () => ({ workArea: screen.workArea });
  const config = { backendUrl: 'http://localhost:8787', selfiePopup: { autoCloseSeconds: 0 } };
  const clipboard = { writeImage: (image) => effects.copied.push(image) };
  const nativeImage = { createFromBuffer: (buffer) => ({ buffer, isEmpty: () => false }) };
  const dialog = { showSaveDialog: async (...args) => { effects.dialogs.push(args); return { canceled: true }; } };
  const shell = { openPath: async (directory) => { effects.folders.push(directory); return ''; } };
  const fetchImage = async (url, options) => {
    effects.fetched.push({ url, options });
    return { ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
  };
  const context = vm.createContext({
    path, fs, os, URL, Buffer, BrowserWindow: FakeWindow, ipcMain, screen, clipboard,
    nativeImage, dialog, shell, fetch: fetchImage, CONFIG: config,
    __dirname: path.resolve('desktop-companion/src/main'), logger: { info() {}, error() {} },
    setTimeout(callback) {
      const timer = { id: ++nextTimer, unref() {} };
      timers.set(timer, callback);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); },
  });
  const source = fs.readFileSync(new URL('../../../desktop-companion/src/main/selfieWindowManager.js', import.meta.url), 'utf8');
  const start = source.indexOf('export class SelfieWindowManager');
  const end = source.indexOf('export const selfieWindowManager', start);
  vm.runInContext(source.slice(start, end).replace('export class', 'class') + '\nglobalThis.Manager = SelfieWindowManager;', context);
  const manager = new context.Manager();
  const overlay = new FakeWindow();
  const trusted = (window = manager.popupWindow) => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  manager.init({ overlayWindow: overlay, webSocketSender: sender, onContentProtectionUpdated: () => effects.protections++ });
  t.after(() => manager.destroy());
  const invoke = (channel, payload, event = trusted()) => handlers.get(channel)(event, payload);
  const relay = (event, senderEvent = trusted(overlay)) => ipcMain.emit('desktop:selfie-event', senderEvent, event);
  return { manager, overlay, windows, screen, effects, handlers, timers, invoke, relay, trusted, dialog, context };
}

test('desktop popup buffers fast ready until renderer handshake and protects capture before showing', async (t) => {
  const h = harness(t);
  h.relay({ type: 'selfie_started', jobId: 'one', etaSeconds: null });
  h.relay({ type: 'selfie_progress', jobId: 'one', value: 1, max: 4 });
  h.relay({ type: 'selfie_progress', jobId: 'one', value: 3, max: 4 });
  h.relay({ type: 'selfie_ready', jobId: 'one', imageUrl: `/api/selfies/${TOKEN}`, caption: 'Foto.' });
  const popup = h.manager.popupWindow;
  assert.equal(h.windows.length, 2);
  assert.equal(popup.webContents.sent.length, 0);
  assert.equal(popup.protected, true);
  assert.equal(popup.onTop, true);
  assert.equal(popup.ignoreMouse, false);
  assert.equal(popup.options.frame, false);
  assert.equal(popup.options.webPreferences.sandbox, true);
  assert.equal(popup.options.webPreferences.contextIsolation, true);
  assert.equal(popup.options.webPreferences.nodeIntegration, false);
  assert.equal(popup.options.webPreferences.partition, 'selfie-popup');
  assert.ok(h.effects.protections >= 2);
  await h.invoke('selfie:popup-ready');
  const messages = popup.webContents.sent.map(({ event }) => event);
  assert.deepEqual(messages.map(event => event.type), ['selfie_started', 'selfie_progress', 'selfie_ready']);
  assert.equal(messages[1].value, 3);
  assert.equal(messages[2].imageUrl, IMAGE_URL);
  assert.equal(messages[2].autoCloseSeconds, 0);
  assert.equal(popup.loaded.options.query.imageOrigin, 'http://localhost:8787');
});

test('desktop IPC rejects foreign windows and subframes for every action and event relay', async (t) => {
  const h = harness(t);
  h.relay({ type: 'selfie_started', jobId: 'one' });
  const popup = h.manager.popupWindow;
  const payloads = {
    'selfie:popup-ready': undefined, 'selfie:cancel-job': 'one', 'selfie:save-image': IMAGE_URL,
    'selfie:copy-image': IMAGE_URL, 'selfie:open-folder': undefined, 'selfie:close-popup': undefined,
    'selfie:resize-popup': { width: 700, height: 700 },
  };
  for (const [channel, payload] of Object.entries(payloads)) {
    for (const untrusted of [h.trusted(h.overlay), { sender: popup.webContents, senderFrame: {} }, {}]) {
      assert.equal((await h.invoke(channel, payload, untrusted)).ok, false, channel);
    }
  }
  h.relay({ type: 'selfie_started', jobId: 'intruder' }, h.trusted(popup));
  h.relay({ type: 'selfie_started', jobId: 'intruder' }, { sender: h.overlay.webContents, senderFrame: {} });
  assert.equal(h.manager.currentJobId, 'one');
  assert.equal(h.effects.fetched.length, 0);
  assert.equal(h.effects.dialogs.length, 0);
  assert.equal(h.effects.folders.length, 0);
});

test('popup close or renderer reload restores running and ready snapshots at the next handshake', async (t) => {
  const h = harness(t);
  h.relay({ type: 'selfie_started', jobId: 'one', etaSeconds: null });
  await h.invoke('selfie:popup-ready');
  h.manager.popupWindow.destroy();
  h.relay({ type: 'selfie_progress', jobId: 'one', value: 2, max: 5 });
  const replacement = h.manager.popupWindow;
  await h.invoke('selfie:popup-ready');
  assert.deepEqual(replacement.webContents.sent.map(({ event }) => event.type), ['selfie_started', 'selfie_progress']);
  h.relay({ type: 'selfie_ready', jobId: 'one', imageUrl: IMAGE_URL });
  replacement.webContents.sent.length = 0;
  replacement.webContents.emit('did-start-loading');
  await h.invoke('selfie:popup-ready');
  assert.deepEqual(replacement.webContents.sent.map(({ event }) => event.type), ['selfie_ready']);
  assert.equal(replacement.webContents.sent[0].event.imageUrl, IMAGE_URL);
});

test('popup cannot invoke the overlay capture or generic desktop IPC APIs', () => {
  const contents = { mainFrame: { url: 'http://localhost:5173/?mode=overlay' } };
  const overlay = { webContents: contents, isDestroyed: () => false };
  const context = vm.createContext({
    URL, CONFIG: { frontendUrl: 'http://localhost:5173' }, logger: { info() {}, warn() {}, error() {} },
  });
  const source = fs.readFileSync(new URL('../../../desktop-companion/src/main/security.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replaceAll('export function', 'function'), context);
  context.registerTrustedDesktopWindow(overlay);
  const trusted = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal(context.assertTrustedSender(trusted, 'desktop:capture-screen'), true);
  for (const event of [
    { sender: { mainFrame: { url: 'file:///selfiePopup.html' } }, senderFrame: { url: 'file:///selfiePopup.html' } },
    { sender: contents, senderFrame: { url: 'http://localhost:5173/iframe' } },
    {},
  ]) assert.throws(() => context.assertTrustedSender(event, 'desktop:capture-screen'), /Untrusted/);
});

test('desktop placement finds a non-overlapping free side even when avatar shoulder alignment overflows', (t) => {
  const h = harness(t);
  h.screen.workArea = { x: 0, y: 0, width: 1000, height: 600 };
  h.overlay.bounds = { x: 600, y: 10, width: 400, height: 590 };
  h.relay({ type: 'selfie_ready', jobId: 'one', imageUrl: IMAGE_URL });
  const bounds = h.manager.popupWindow.getBounds();
  assert.ok(bounds.x + bounds.width <= h.overlay.bounds.x);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 600);
});

test('desktop reuses one popup across queued, ready, failed and cancelled jobs without stale hide timers', async (t) => {
  const h = harness(t);
  h.relay({ type: 'selfie_started', jobId: 'one' });
  await h.invoke('selfie:popup-ready');
  const popup = h.manager.popupWindow;
  h.relay({ type: 'selfie_started', jobId: 'queued', status: 'queued' });
  assert.equal(h.manager.currentJobId, 'one');
  h.relay({ type: 'selfie_failed', jobId: 'one', reason: 'Error' });
  const oldHide = [...h.timers.values()][0];
  h.relay({ type: 'selfie_started', jobId: 'two' });
  oldHide();
  assert.equal(popup.visible, true);
  assert.equal(h.timers.size, 0);
  h.relay({ type: 'selfie_cancelled', jobId: 'one' });
  assert.equal(h.manager.currentJobId, 'two');
  h.relay({ type: 'selfie_ready', jobId: 'two', imageUrl: IMAGE_URL });
  h.relay({ type: 'selfie_started', jobId: 'three' });
  h.relay({ type: 'selfie_cancelled', jobId: 'three' });
  [...h.timers.values()][0]();
  assert.equal(popup.visible, false);
  assert.equal(h.windows.length, 2);
});

test('desktop display unplug, movement, zoom and shutdown keep bounds valid and remove listeners', async (t) => {
  const h = harness(t);
  h.relay({ type: 'selfie_ready', jobId: 'one', imageUrl: IMAGE_URL });
  await h.invoke('selfie:popup-ready');
  await h.invoke('selfie:resize-popup', { width: 5000, height: 5000, zoomed: true });
  let bounds = h.manager.popupWindow.getBounds();
  assert.ok(bounds.width <= 1200 * 0.8 && bounds.height <= 800 * 0.8);
  h.screen.workArea = { x: -600, y: 100, width: 600, height: 380 };
  h.overlay.bounds = { x: -300, y: 150, width: 250, height: 250 };
  h.screen.emit('display-removed');
  bounds = h.manager.popupWindow.getBounds();
  assert.ok(bounds.x >= -600 && bounds.y >= 100);
  assert.ok(bounds.x + bounds.width <= 0 && bounds.y + bounds.height <= 480);
  assert.ok(bounds.width <= 480 && bounds.height <= 304);
  h.overlay.emit('move');
  assert.equal((await h.invoke('selfie:resize-popup', { width: Infinity, height: -1 })).ok, false);
  const popup = h.manager.popupWindow;
  h.manager.destroy();
  assert.equal(popup.destroyed, true);
  assert.equal(h.screen.listenerCount('display-removed'), 0);
  assert.equal(h.overlay.listenerCount('move'), 0);
  assert.equal(h.handlers.size, 0);
  assert.equal(h.manager.handleSelfieEvent({ type: 'selfie_started', jobId: 'after-quit' }), false);
});

test('desktop image actions allow only current token origin, deny redirects and navigation', async (t) => {
  const h = harness(t);
  h.relay({ type: 'selfie_ready', jobId: 'one', imageUrl: IMAGE_URL });
  await h.invoke('selfie:popup-ready');
  const popup = h.manager.popupWindow;
  for (const value of ['https://example.com/photo.png', `http://localhost:9999/api/selfies/${TOKEN}`,
    `http://user@localhost:8787/api/selfies/${TOKEN}`, `${IMAGE_URL}?x=1`, 'file:///photo.png', 'data:image/png,abc']) {
    assert.equal((await h.invoke('selfie:copy-image', value)).copied, false);
    assert.equal((await h.invoke('selfie:save-image', value)).saved, false);
  }
  assert.equal(h.effects.fetched.length, 0);
  assert.equal(h.effects.dialogs.length, 0);
  assert.equal((await h.invoke('selfie:copy-image', IMAGE_URL)).copied, true);
  assert.equal(h.effects.fetched[0].options.redirect, 'error');
  assert.equal(h.effects.copied.length, 1);
  assert.equal(popup.windowOpen().action, 'deny');
  for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
    let prevented = false;
    popup.webContents.emit(event, { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
  }
  assert.equal(popup.permissionCheck(), false);
});

test('desktop Save As writes selected file and gallery opens the configured output directory', async (t) => {
  const h = harness(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfie-desktop-tests-'));
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir(), 'selfie-desktop-tests-')));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const output = path.join(directory, 'photos');
  h.manager.outputDir = output;
  h.relay({ type: 'selfie_ready', jobId: 'one', imageUrl: IMAGE_URL });
  await h.invoke('selfie:popup-ready');
  const selected = path.join(directory, 'saved.png');
  h.dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected });
  assert.equal((await h.invoke('selfie:save-image', IMAGE_URL)).saved, true);
  assert.deepEqual(fs.readFileSync(selected), Buffer.from([1, 2, 3]));
  assert.equal((await h.invoke('selfie:open-folder')).ok, true);
  assert.equal(h.effects.folders[0], output);
  assert.equal(fs.existsSync(output), true);
});

test('popup Cancel reaches real JobManager with a fake provider and unavailable delivery is reported', async (t) => {
  const jobs = new JobManager({ cooldownMs: 0, dailyLimit: 10, maxQueue: 0, freeVramAfter: false, limitsStorePath: null, etaStorePath: null });
  let aborted = false;
  const generated = new EventEmitter();
  jobs.provider = {
    async isAvailable() { return true; },
    generate(_params, onProgress, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' })); }, { once: true });
        onProgress({ value: 1, max: 3 });
        generated.emit('started');
      });
    },
    async cancel() {}, async release() {},
  };
  t.after(() => jobs.shutdown());
  const commands = [];
  const h = harness(t, async (message) => { commands.push(message); await jobs.cancelJob(message.jobId); return true; });
  jobs.setBroadcaster(event => h.relay(event));
  const generating = once(generated, 'started');
  const submitted = await jobs.submitJob({ plan: PLAN, skipInitialSpeech: true });
  await generating;
  await h.invoke('selfie:popup-ready');
  assert.equal((await h.invoke('selfie:cancel-job', 'other-job')).ok, false);
  assert.equal((await h.invoke('selfie:cancel-job', submitted.jobId)).cancelled, true);
  assert.equal(aborted, true);
  assert.equal(commands[0].type, 'selfie_cancel');
  assert.equal(commands[0].jobId, submitted.jobId);
  h.relay({ type: 'selfie_started', jobId: 'offline' });
  h.manager.webSocketSender = async () => false;
  assert.equal((await h.invoke('selfie:cancel-job', 'offline')).ok, false);
});
