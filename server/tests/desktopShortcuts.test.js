import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { CONFIG } from '../../desktop-companion/src/main/config.js';
import { loadShortcutConfig, registerShortcuts } from '../../desktop-companion/src/main/shortcutManager.js';
import { SpeechController } from '../speechController.js';

const desktopSource = fs.readFileSync(new URL('../../desktop-companion/src/main/index.js', import.meta.url), 'utf8');
const clientSource = fs.readFileSync(new URL('../../src/companion.js', import.meta.url), 'utf8');
const serverSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const traySource = fs.readFileSync(new URL('../../desktop-companion/src/main/trayManager.js', import.meta.url), 'utf8');

function section(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing source section: ${start}`);
  return source.slice(first, last);
}

function fakeShortcuts(outcomes = {}) {
  const calls = [];
  const callbacks = new Map();
  const logs = [];
  const notices = [];
  const globalShortcut = {
    register(key, callback) {
      calls.push(key);
      const result = outcomes[key] ?? true;
      if (result instanceof Error) throw result;
      if (result) callbacks.set(key, callback);
      return result;
    },
    isRegistered: key => callbacks.has(key),
    unregister: key => callbacks.delete(key),
  };
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level,
    (scope, message, meta) => logs.push({ level, scope, message, meta })]));
  return { globalShortcut, calls, callbacks, logs, notices, logger, notify: (...args) => notices.push(args) };
}

test('shortcuts select a verified fallback and log both registration results and every firing', () => {
  const preferred = CONFIG.shortcuts.toggleMuteMic.preferred;
  const [fallback] = CONFIG.shortcuts.toggleMuteMic.fallbacks;
  const h = fakeShortcuts({ [preferred]: false });
  const fired = [];
  const states = registerShortcuts({ ...h, shortcuts: { toggleMuteMic: CONFIG.shortcuts.toggleMuteMic },
    handlers: { toggleMuteMic: { label: 'Mute Mikrofon', handler: key => fired.push(key) } } });
  assert.equal(preferred, 'Control+Alt+Shift+M');
  assert.deepEqual(h.calls, [preferred, fallback]);
  assert.equal(states.toggleMuteMic.active, fallback);
  assert.equal(states.toggleMuteMic.activeLabel, 'Ctrl+Alt+Shift+F9');
  assert.equal(states.toggleMuteMic.available, true);
  assert.match(h.notices[0][1], /Ctrl\+Alt\+Shift\+F9/);
  const attempts = h.logs.filter(log => log.message === 'Global shortcut registration attempt');
  assert.deepEqual(attempts.map(log => [log.meta.registerResult, log.meta.isRegistered]), [[false, false], [true, true]]);
  h.callbacks.get(fallback)();
  h.callbacks.get(fallback)();
  assert.deepEqual(fired, [fallback, fallback]);
  assert.equal(h.logs.filter(log => log.message === 'Global shortcut fired').length, 2);
});

test('shortcut verification failure releases its binding and exceptions still try fallbacks', () => {
  const h = fakeShortcuts({ 'Control+Alt+Shift+M': new Error('Invalid accelerator') });
  const fallback = 'Control+Alt+Shift+F9';
  h.globalShortcut.isRegistered = key => key !== fallback && h.callbacks.has(key);
  const states = registerShortcuts({ ...h, shortcuts: { toggleMuteMic: CONFIG.shortcuts.toggleMuteMic },
    handlers: { toggleMuteMic: { label: 'Mute Mikrofon', handler() {} } } });
  assert.equal(states.toggleMuteMic.active, 'Control+Alt+Shift+F10');
  assert.equal(h.callbacks.has(fallback), false);
  assert.equal(h.logs.find(log => log.meta?.accelerator === 'Control+Alt+Shift+M').meta.error, 'Invalid accelerator');
});

test('shortcut JSON and environment overrides are honored and invalid config preserves defaults', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-shortcuts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'shortcuts.json');
  const h = fakeShortcuts();
  const load = env => loadShortcutConfig({ filePath, defaults: CONFIG.shortcuts, logger: h.logger, env });
  assert.deepEqual(load({}), CONFIG.shortcuts);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), CONFIG.shortcuts);
  fs.writeFileSync(filePath, JSON.stringify({ toggleMuteMic: { preferred: 'Alt+F8', fallbacks: ['Alt+F9'] } }));
  assert.deepEqual(load({}).toggleMuteMic, { preferred: 'Alt+F8', fallbacks: ['Alt+F9'] });
  const shortcuts = load({ SHORTCUT_MUTE_MIC: 'Control+Alt+F8' });
  assert.deepEqual(shortcuts.toggleMuteMic, { preferred: 'Control+Alt+F8', fallbacks: ['Alt+F9'] });
  const states = registerShortcuts({ ...h, shortcuts,
    handlers: Object.fromEntries(Object.keys(shortcuts).map(id => [id, { label: id, handler() {} }])) });
  assert.equal(states.toggleMuteMic.active, 'Control+Alt+F8');
  fs.writeFileSync(filePath, JSON.stringify({ toggleMuteMic: { preferred: 5, fallbacks: [null] } }));
  assert.deepEqual(load({}).toggleMuteMic, CONFIG.shortcuts.toggleMuteMic);
  fs.writeFileSync(filePath, '[]');
  assert.deepEqual(load({}), CONFIG.shortcuts);
  assert.ok(h.logs.some(log => log.level === 'warn'));
});

test('reserved Ctrl+Shift+M is never registered even through override aliases', () => {
  for (const preferred of ['Control+Shift+M', 'Shift+Ctrl+M', 'CommandOrControl+Shift+M', 'Ctrl + Shift + M']) {
    const h = fakeShortcuts();
    const states = registerShortcuts({ ...h,
      shortcuts: { toggleMuteMic: { preferred, fallbacks: ['Control+Shift+M', 'Alt+F9'] } },
      handlers: { toggleMuteMic: { label: 'Mute Mikrofon', handler() {} } } });
    assert.deepEqual(h.calls, ['Alt+F9']);
    assert.equal(states.toggleMuteMic.active, 'Alt+F9');
  }
});

function desktopHarness(t, outcomes = {}) {
  const h = fakeShortcuts(outcomes);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-tray-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sent = [];
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (channel, callback) => handlers.set(channel, callback);
  const display = { id: 1, bounds: { width: 1920, height: 1080 } };
  const state = { muteMic: false, activeDisplayId: 1 };
  const overlay = {
    isDestroyed: () => false, isVisible: () => true, getBounds: () => display.bounds,
    webContents: { send: (...args) => sent.push(args) },
  };
  class FakeTray extends EventEmitter {
    setToolTip() {}
    setContextMenu(menu) { this.menu = menu; }
    displayBalloon(options) { h.notices.push(options); }
  }
  class FakeNotification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    show() { h.notices.push(this.options); }
  }
  const context = vm.createContext({ ...h, path, Buffer, CONFIG, overlayWindow: overlay, ipcMain,
    process: { env: { DESKTOP_SHORTCUTS_PATH: path.join(directory, 'shortcuts.json') }, execPath: process.execPath },
    app: { isPackaged: false, getAppPath: () => directory, getLoginItemSettings: () => ({}) },
    screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display },
    Menu: { buildFromTemplate: items => items }, Tray: FakeTray, Notification: FakeNotification,
    nativeImage: { createFromBitmap: () => ({}) }, loadShortcutConfig, registerShortcuts,
    windowStateStore: { state, getActivePresetId: () => 'with-wings', getSnapshot: () => ({ ...state }),
      setMuteMic(enabled) { state.muteMic = Boolean(enabled); return state.muteMic; } },
    assertTrustedSender(event) { if (!event.trusted) throw new Error('Untrusted sender'); },
  });
  vm.runInContext(traySource.replace(/^import .*;\r?\n/gm, '').replace('export class', 'class'), context);
  vm.runInContext('let trayManager = null; let shortcutStates = {}; let muteRevision = 0;', context);
  for (const [start, end] of [
    ['function broadcastOverlayState(', '\n/**'],
    ['function setupGlobalShortcuts(', '\n/**'],
    ['function toggleMuteMic(', '\n/**'],
    ['function setupSystemTray(', '\nfunction focusOverlayWindow('],
  ]) vm.runInContext(section(desktopSource, start, end), context);
  vm.runInContext(section(desktopSource, "  ipcMain.on('desktop:mic-state-applied'", "\n  ipcMain.handle('desktop:set-overlay-preset'"), context);
  vm.runInContext('setupSystemTray(); setupGlobalShortcuts(); globalThis.tray = trayManager;', context);
  return { ...h, context, overlay, state, sent, ipcMain,
    muteItem: () => context.tray.tray.menu.find(item => item.label?.startsWith('Mute Mikrofon')) };
}

test('failed shortcut registration shows a notification and the tray mute remains usable', (t) => {
  const failures = Object.fromEntries(Object.values(CONFIG.shortcuts).flatMap(value => [value.preferred, ...value.fallbacks]).map(key => [key, false]));
  const h = desktopHarness(t, failures);
  assert.equal(h.notices.length, 3);
  assert.equal(h.notices[0].title, 'Shortcut Tidak Tersedia');
  assert.match(h.notices[0].body, /Gunakan menu tray/);
  assert.match(h.muteItem().label, /shortcut tidak tersedia/);
  assert.notEqual(h.muteItem().enabled, false);
  h.muteItem().click({ checked: true });
  assert.equal(h.state.muteMic, true);
  assert.equal(h.muteItem().checked, true);
  assert.equal(h.sent.find(event => event[0] === 'desktop:mute-mic-changed')[1], true);
});

test('shortcut and tray share mute state, revisioned IPC and renderer acknowledgments', (t) => {
  const h = desktopHarness(t, { 'Control+Alt+Shift+M': false });
  assert.match(h.muteItem().label, /Ctrl\+Alt\+Shift\+F9/);
  h.callbacks.get('Control+Alt+Shift+F9')();
  assert.equal(h.state.muteMic, true);
  assert.equal(h.muteItem().checked, true);
  const mute = h.sent.find(event => event[0] === 'desktop:mute-mic-changed');
  assert.equal(mute[2].revision, 1);
  assert.equal(mute[2].shortcut, 'Ctrl+Alt+Shift+F9');
  const ack = { revision: 1, muted: true, captureActive: false, recording: false, indicatorMuted: true };
  h.ipcMain.emit('desktop:mic-state-applied', { trusted: true }, ack);
  assert.equal(h.logs.at(-1).message, 'Renderer applied microphone state');
  assert.equal(h.logs.at(-1).level, 'info');
  const count = h.logs.length;
  h.ipcMain.emit('desktop:mic-state-applied', {}, ack);
  h.ipcMain.emit('desktop:mic-state-applied', { trusted: true }, { ...ack, revision: 0 });
  assert.equal(h.logs.length, count);
  h.ipcMain.emit('desktop:mic-state-applied', { trusted: true }, { ...ack, captureActive: true });
  assert.equal(h.logs.at(-1).level, 'warn');
  h.muteItem().click({ checked: false });
  assert.equal(h.state.muteMic, false);
  assert.equal(h.muteItem().checked, false);
  h.callbacks.get('Control+Alt+Shift+F9')();
  assert.equal(h.state.muteMic, true);
  assert.equal(h.muteItem().checked, true);
  const snapshots = h.sent.filter(event => event[0] === 'desktop:overlay-state-changed');
  assert.equal(snapshots.at(-1)[1].muteRevision, 3);
  assert.equal(snapshots.at(-1)[1].muteMic, true);
});

function clientHarness() {
  const readers = [];
  const recorders = [];
  const streams = [];
  const sent = [];
  const reports = [];
  const subtitles = [];
  const callbacks = {};
  let resolveSnapshot;
  const classes = new Set();
  const context = vm.createContext({
    Blob, Uint8Array, Number, console, window: { desktopBridge: {
      reportMicState: report => reports.push(report),
      getOverlayState: () => new Promise(resolve => { resolveSnapshot = resolve; }),
      onMuteMicChanged: callback => { callbacks.mute = callback; },
      onOverlayStateChanged: callback => { callbacks.snapshot = callback; },
    } },
    micStatusEl: { classList: { remove: (...keys) => keys.forEach(key => classes.delete(key)),
      add: key => classes.add(key), contains: key => classes.has(key) } }, micLabelEl: { textContent: '' },
    document: { getElementById: () => null }, isMobile: () => false,
    speechPlayback: { busy: false }, playbackState: () => 'idle',
    showOverlaySubtitle: text => subtitles.push(text), log() {},
    performance: { now: () => 1000 }, tuning: { get: () => undefined },
    captureWebcamFrame: () => null, captureScreenFrame: () => null, desktopInputMeta: () => ({}),
    WebSocket: { OPEN: 1 }, ws: { readyState: 1, send: text => sent.push(JSON.parse(text)) },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    navigator: { mediaDevices: { async getUserMedia() {
      const track = { enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; } };
      const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
      streams.push(stream);
      return stream;
    } } },
    audioCtx: { state: 'running', createAnalyser: () => ({}), createMediaStreamSource: () => ({ connect() {} }) },
    ensureAudio() {},
    FileReader: class {
      readAsDataURL() { readers.push(this); }
      finish() { this.result = 'data:audio/webm;base64,YXVkaW8='; this.onloadend(); }
    },
    MediaRecorder: class {
      static isTypeSupported() { return true; }
      constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; recorders.push(this); }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.onstop?.(); }
    },
  });
  vm.runInContext("let isMicMutedByDesktop = true; let micMuteRevision = -1; let activeMuteShortcut = null;", context);
  vm.runInContext(section(clientSource, 'function setMicStatus(', '\nlet currentFacingMode'), context);
  vm.runInContext(section(clientSource, 'function updateUiForState(', '\nfunction '), context);
  vm.runInContext(section(clientSource, 'let pttRecorder = null;', '\nconst companionPanel'), context);
  vm.runInContext(section(clientSource, 'let micStream = null;', '// Input teks'), context);
  return { context, readers, recorders, streams, sent, reports, subtitles, callbacks,
    resolveSnapshot: state => resolveSnapshot(state),
    apply: (muted, revision) => callbacks.mute(muted, { revision, shortcut: 'Ctrl+Alt+Shift+F9' }) };
}

test('mute stops capture and recordings, preserves the indicator and rejects stale snapshots', async () => {
  const h = clientHarness();
  await h.context.startListening();
  assert.equal(h.streams.length, 0);
  h.apply(false, 0);
  await h.context.startListening();
  h.context.beginSegment();
  const recorder = h.recorders[0];
  const track = h.streams[0].getTracks()[0];
  h.apply(true, 2);
  assert.equal(track.readyState, 'ended');
  assert.equal(recorder.state, 'inactive');
  assert.equal(recorder.onstop, null);
  assert.equal(h.context.micLabelEl.textContent, '🔇 Mikrofon di-mute');
  assert.equal(h.reports.at(-1).captureActive, false);
  assert.equal(h.reports.at(-1).recording, false);
  assert.equal(h.reports.at(-1).indicatorMuted, true);
  assert.match(h.subtitles.at(-1), /Ctrl\+Alt\+Shift\+F9/);
  h.context.updateUiForState('speaking');
  h.resolveSnapshot({ muteMic: false, muteRevision: 0 });
  await Promise.resolve();
  assert.equal(h.context.micLabelEl.textContent, '🔇 Mikrofon di-mute');
  assert.equal(h.reports.at(-1).revision, 2);
  h.apply(false, 3);
  await h.context.startListening();
  assert.equal(h.streams.length, 2);
  assert.equal(h.reports.at(-1).captureActive, true);
  assert.equal(h.sent.at(-1).muted, false);
  h.context.ws.send = () => { throw new Error('Disconnected'); };
  h.apply(true, 4);
  assert.equal(h.streams[1].getTracks()[0].readyState, 'ended');
  assert.equal(h.reports.at(-1).captureActive, false);
});

test('mute during delayed microphone permission stops the returned stream', async () => {
  const h = clientHarness();
  const track = { enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; } };
  let grant;
  h.context.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  h.apply(false, 0);
  const pending = h.context.startListening();
  h.apply(true, 1);
  grant({ getAudioTracks: () => [track], getTracks: () => [track] });
  await pending;
  assert.equal(track.readyState, 'ended');
  assert.equal(h.reports.at(-1).captureActive, false);
  assert.equal(h.context.micLabelEl.textContent, '🔇 Mikrofon di-mute');
});

test('mute then unmute while VAD audio encoding is pending discards that upload', async () => {
  const h = clientHarness();
  h.apply(false, 0);
  await h.context.startListening();
  vm.runInContext("segChunks = [new Blob(['x'.repeat(2048)])]; segStartAt = 0;", h.context);
  const pending = h.context.flushSegment();
  assert.equal(h.readers.length, 1);
  h.apply(true, 1);
  h.apply(false, 2);
  h.readers[0].finish();
  await pending;
  assert.equal(h.sent.some(event => event.type === 'audio_input'), false);
});

test('push-to-talk obeys mute and discards an upload already waiting for FileReader', async () => {
  const h = clientHarness();
  await h.context.startPttRecording();
  assert.equal(h.recorders.length, 0);
  h.apply(false, 0);
  await h.context.startListening();
  await h.context.startPttRecording();
  h.apply(true, 1);
  assert.equal(h.recorders[0].state, 'inactive');
  assert.equal(h.recorders[0].onstop, null);
  h.apply(false, 2);
  await h.context.startListening();
  await h.context.startPttRecording();
  vm.runInContext("pttChunks = [new Blob(['x'.repeat(2048)])]; pttStartAt = 0;", h.context);
  const pending = h.recorders.at(-1).onstop();
  assert.equal(h.readers.length, 1);
  h.apply(true, 3);
  h.apply(false, 4);
  h.readers[0].finish();
  await pending;
  assert.equal(h.sent.some(event => event.type === 'audio_input'), false);
});

test('second launches focus the first instance and registration waits for readiness', async () => {
  const h = fakeShortcuts();
  const app = new EventEmitter();
  let ready;
  app.whenReady = () => new Promise(resolve => { ready = resolve; });
  app.getVersion = () => 'test';
  app.getPath = () => 'test';
  h.logger.getLogFilePath = () => 'test.log';
  let focused = 0;
  let registered = 0;
  const window = { isDestroyed: () => false, isMinimized: () => true,
    restore() {}, show() {}, focus() { focused++; } };
  const context = vm.createContext({ app, logger: h.logger, CONFIG, session: { defaultSession: {} },
    maybeSpawnBackend() {}, configureSessionSecurity() {}, registerIpcHandlers() {}, setupDisplayChangeListeners() {},
    setupSystemTray() {}, captureService: { init() {} }, enforceOverlayWindowFlags() {},
    setupGlobalShortcuts() { registered++; },
  });
  vm.runInContext('let overlayWindow = null; let focusRequested = false; let trayManager = null;', context);
  context.createOverlayWindow = async () => { vm.runInContext('overlayWindow = window;', context); };
  context.window = window;
  vm.runInContext(section(desktopSource, 'function focusOverlayWindow(', "\napp.on('window-all-closed'"), context);
  app.emit('second-instance');
  assert.equal(registered, 0);
  ready();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registered, 1);
  assert.equal(focused, 1);
  app.emit('second-instance');
  assert.equal(focused, 2);
  assert.equal(registered, 1);
  const exit = new Error('Exited');
  let quit = 0;
  const second = vm.createContext({ app: { requestSingleInstanceLock: () => false, quit: () => quit++ },
    logger: h.logger, process: { exit(code) { assert.equal(code, 0); throw exit; } } });
  assert.throws(() => vm.runInContext(section(desktopSource, 'const gotTheLock =', '\nlet overlayWindow'), second), error => error === exit);
  assert.equal(quit, 1);
  assert.match(h.logs.at(-1).message, /Another instance is already running/);
});

test('microphone mute aborts current STT and rejects new audio without affecting typed input', async (t) => {
  const events = [];
  const socket = {};
  const controller = new SpeechController({ generateSpeech: async function* () {}, isVoiceConfigured: () => false });
  controller.register(socket, event => events.push(event));
  t.after(() => controller.unregister(socket));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runInput = new AsyncFunction('socket', 'speechController', 'transcribeAudio', 'msg', 'extFromMime',
    section(serverSource, "    if (msg.type !== 'audio_input' && msg.type !== 'text_input') return;", '\n      // Filter noise:')
      + '\n    } finally { if (turn) speechController.completeTurn(socket, turn.turnId); }');
  const mute = new Function('socket', 'speechController', 'msg', section(serverSource, "    if (msg.type === 'mic_mute')", '\n    // 0.'));
  let signal;
  let complete;
  let calls = 0;
  const transcribe = (buffer, name, options) => {
    calls++;
    signal = options.signal;
    return new Promise(resolve => { complete = resolve; });
  };
  const audio = { type: 'audio_input', data: Buffer.alloc(600).toString('base64') };
  const pending = runInput(socket, controller, transcribe, audio, () => 'webm');
  assert.ok(socket.sttTurnId);
  mute(socket, controller, { type: 'mic_mute', muted: true });
  assert.equal(signal.aborted, true);
  assert.ok(events.some(event => event.type === 'turn_cancelled' && event.reason === 'MIC_MUTED'));
  await runInput(socket, controller, transcribe, audio, () => 'webm');
  assert.equal(calls, 1);
  assert.ok(events.some(event => event.type === 'input_rejected' && event.reason === 'MIC_MUTED'));
  complete('late transcription');
  await pending;
  assert.equal(socket.sttTurnId, null);
  mute(socket, controller, { type: 'mic_mute', muted: 'false' });
  assert.equal(socket.micMuted, true);
  const rejected = events.filter(event => event.type === 'input_rejected').length;
  await runInput(socket, controller, transcribe, { type: 'text_input', text: 'Hello' }, () => 'webm');
  assert.equal(events.filter(event => event.type === 'input_rejected').length, rejected);
  mute(socket, controller, { type: 'mic_mute', muted: false });
  await runInput(socket, controller, async () => '', audio, () => 'webm');
  assert.equal(socket.micMuted, false);
});
