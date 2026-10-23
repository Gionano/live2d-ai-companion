import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const companionSource = fs.readFileSync(new URL('../../src/companion.js', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('../../desktop-companion/src/main/index.js', import.meta.url), 'utf8');
const preloadSource = fs.readFileSync(new URL('../../desktop-companion/src/preload/preload.cjs', import.meta.url), 'utf8');
const securitySource = fs.readFileSync(new URL('../../desktop-companion/src/main/security.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const clone = value => JSON.parse(JSON.stringify(value));
const selfieTypes = ['selfie_started', 'selfie_progress', 'selfie_ready', 'selfie_failed', 'selfie_cancelled'];

test('tray exposes the persisted Pap toggle and gallery actions', () => {
  const source = fs.readFileSync(new URL('../../desktop-companion/src/main/trayManager.js', import.meta.url), 'utf8');
  let menu;
  const toggles = [];
  let galleries = 0;
  const context = vm.createContext({
    Buffer,
    process: { execPath: 'electron.exe' },
    app: { isPackaged: true, getLoginItemSettings: () => ({ openAtLogin: false }) },
    Menu: { buildFromTemplate: template => { menu = template; return template; } },
    screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1 }) },
    CONFIG: { overlay: { presets: {} }, shortcuts: {} },
    logger: { error() {} },
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace('export class TrayManager', 'globalThis.TrayManager = class TrayManager'), context);
  const manager = new context.TrayManager({
    getState: () => ({ selfieEnabled: false }),
    onToggleSelfie: enabled => toggles.push(enabled),
    onOpenSelfieGallery: () => { galleries++; },
  });
  manager.tray = { setContextMenu() {} };
  manager.rebuildMenu();
  const feature = menu.find(item => item.label?.startsWith('Pap feature'));
  const gallery = menu.find(item => item.label?.startsWith('Pap gallery'));
  assert.equal(feature.type, 'checkbox');
  assert.equal(feature.checked, false);
  feature.click({ checked: true });
  gallery.click();
  assert.deepEqual(toggles, [true]);
  assert.equal(galleries, 1);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Run the actual socket setup and message prefix before its conversation gate.
// Stub only unrelated speech/capture rendering; the selfie routing stays intact.
function companionHarness({ desktop = true, initialState = Promise.resolve({ selfieEnabled: true }) } = {}) {
  const sockets = [];
  const forwarded = [];
  const settings = [];
  const browserEvents = [];
  const conversationEvents = [];
  let command;
  let stateChanged;
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      this.sent = [];
      sockets.push(this);
    }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    send(raw) {
      if (this.failSend) throw new Error('Disconnected');
      this.sent.push(JSON.parse(raw));
    }
    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.listeners.get('open')();
    }
    receive(message) { this.listeners.get('message')({ data: JSON.stringify(message) }); }
  }
  const bridge = {
    notifySelfieEvent: event => forwarded.push(clone(event)),
    notifySelfieSettings: event => settings.push(clone(event)),
    onSelfieCommand: callback => { command = callback; },
    onOverlayStateChanged: callback => { stateChanged = callback; },
    getOverlayState: () => initialState,
  };
  const context = vm.createContext({
    window: { desktopBridge: desktop ? bridge : undefined },
    location: { protocol: 'http:', host: 'localhost:5173' },
    WebSocket: FakeWebSocket,
    isMicMutedByDesktop: true,
    isScreenActive: () => false,
    turnState: { handle: event => conversationEvents.push(clone(event)) },
    handleBrowserSelfieModal: (event, cancel) => browserEvents.push({ event: clone(event), cancel }),
  });
  const start = companionSource.indexOf('let ws = null;');
  const end = companionSource.indexOf('    const speechEvent = ', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(`${companionSource.slice(start, end)}
    turnState.handle(msg);
  });
}
connectWS();
globalThis.reconnectSelfie = connectWS;`, context, { filename: 'companion-selfie-routing.js' });
  return {
    sockets, forwarded, settings, browserEvents, conversationEvents,
    get command() { return command; },
    stateChanged: state => stateChanged(state),
    reconnect: () => context.reconnectSelfie(),
  };
}

test('all five desktop selfie events reach main before conversation turn filtering', () => {
  const h = companionHarness();
  for (const type of selfieTypes) h.sockets[0].receive({ type, jobId: 'job-1', turnId: 'stale-turn' });
  assert.deepEqual(h.forwarded, selfieTypes.map(type => ({ type, jobId: 'job-1', turnId: 'stale-turn' })));
  assert.deepEqual(h.browserEvents, []);
  assert.deepEqual(h.conversationEvents, []);
  h.sockets[0].receive({ type: 'conversation_state', state: 'processing' });
  assert.deepEqual(h.conversationEvents, [{ type: 'conversation_state', state: 'processing' }]);
});

test('all five browser selfie events use the modal and Cancel reaches the connected socket', () => {
  const h = companionHarness({ desktop: false });
  h.sockets[0].open();
  for (const type of selfieTypes) h.sockets[0].receive({ type, jobId: 'browser-job' });
  assert.deepEqual(h.browserEvents.map(entry => entry.event), selfieTypes.map(type => ({ type, jobId: 'browser-job' })));
  assert.deepEqual(h.forwarded, []);
  assert.deepEqual(h.conversationEvents, []);
  assert.equal(h.browserEvents[0].cancel('browser-job'), true);
  assert.deepEqual(h.sockets[0].sent, [{ type: 'selfie_cancel', jobId: 'browser-job' }]);
  h.sockets[0].readyState = 3;
  assert.equal(h.browserEvents[0].cancel('browser-job'), false);
});

test('authoritative reconnect snapshots reach desktop and browser before conversation filtering', () => {
  const snapshot = {
    type: 'selfie_snapshot', activeJobId: null,
    events: [{ type: 'selfie_ready', jobId: 'last-ready', imageUrl: '/api/selfies/token', autoCloseSeconds: 0 }],
  };
  for (const desktop of [true, false]) {
    const h = companionHarness({ desktop });
    h.sockets[0].receive(snapshot);
    h.sockets[0].receive({ type: 'selfie_snapshot', activeJobId: null, events: [] });
    const forwarded = desktop ? h.forwarded : h.browserEvents.map(entry => entry.event);
    assert.deepEqual(forwarded, [snapshot, { type: 'selfie_snapshot', activeJobId: null, events: [] }]);
    assert.deepEqual(h.conversationEvents, []);
  }
});

test('desktop Cancel reports disconnected and failed WS sends without a false acknowledgement', () => {
  const h = companionHarness();
  const cancel = { type: 'selfie_cancel', jobId: 'desktop-job' };
  assert.equal(h.command(cancel), false);
  h.sockets[0].open();
  assert.equal(h.command(cancel), true);
  assert.deepEqual(h.sockets[0].sent.at(-1), cancel);
  h.sockets[0].failSend = true;
  assert.equal(h.command(cancel), false);
  h.sockets[0].readyState = 3;
  assert.equal(h.command(cancel), false);
});

test('tray setting is applied initially, changes once, and survives socket reconnect', async () => {
  const state = deferred();
  const h = companionHarness({ initialState: state.promise });
  state.resolve({ selfieEnabled: false });
  await state.promise;
  h.sockets[0].open();
  assert.deepEqual(h.sockets[0].sent, [{ type: 'mic_mute', muted: true }, { type: 'selfie_feature', enabled: false }]);
  h.stateChanged({ selfieEnabled: false, windowBounds: { x: 10 } });
  h.stateChanged({ screenVision: true });
  assert.equal(h.sockets[0].sent.length, 2);
  h.stateChanged({ selfieEnabled: true });
  assert.deepEqual(h.sockets[0].sent.at(-1), { type: 'selfie_feature', enabled: true });
  h.reconnect();
  h.sockets[1].open();
  assert.deepEqual(h.sockets[1].sent, [{ type: 'mic_mute', muted: true }, { type: 'selfie_feature', enabled: true }]);
});

test('a late startup snapshot cannot overwrite a newer tray toggle', async () => {
  const state = deferred();
  const h = companionHarness({ initialState: state.promise });
  h.stateChanged({ selfieEnabled: false });
  state.resolve({ selfieEnabled: true });
  await state.promise;
  h.sockets[0].open();
  assert.deepEqual(h.sockets[0].sent, [{ type: 'mic_mute', muted: true }, { type: 'selfie_feature', enabled: false }]);
});

test('renderer never forwards a gallery path and malformed messages are ignored', () => {
  const h = companionHarness();
  const event = { type: 'selfie_feature', enabled: true, outputDir: 'C:\\Pictures\\Selfies' };
  h.sockets[0].receive(event);
  h.sockets[0].receive(null);
  h.sockets[0].receive(1);
  h.sockets[0].listeners.get('message')({ data: 'not json' });
  assert.deepEqual(h.settings, []);
  assert.deepEqual(h.forwarded, []);
  assert.deepEqual(h.conversationEvents, []);
});

function preloadHarness() {
  const handlers = new Map();
  const sent = [];
  let bridge;
  const ipcRenderer = {
    on: (channel, callback) => handlers.set(channel, callback),
    removeListener: (channel, callback) => {
      if (handlers.get(channel) === callback) handlers.delete(channel);
    },
    send: (channel, payload) => sent.push({ channel, payload: clone(payload) }),
  };
  const context = vm.createContext({
    require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer };
    },
  });
  vm.runInContext(preloadSource, context, { filename: 'preload.cjs' });
  return { bridge, handlers, sent };
}

test('overlay preload only forwards cancellation commands and acknowledges the actual send result', async () => {
  const h = preloadHarness();
  const received = [];
  let connected = false;
  const unsubscribe = h.bridge.onSelfieCommand(message => {
    received.push(clone(message));
    return connected;
  });
  const deliver = payload => h.handlers.get('desktop:selfie-command')({}, payload);
  const cancel = { type: 'selfie_cancel', jobId: 'job-1' };
  await deliver({ requestId: 'a', message: cancel });
  connected = true;
  await deliver({ requestId: 'b', message: cancel });
  await deliver({ requestId: 'c', message: { type: 'text_input', text: 'unchecked command' } });
  await deliver(null);
  assert.deepEqual(received, [cancel, cancel]);
  assert.deepEqual(h.sent, [
    { channel: 'desktop:selfie-command-result', payload: { requestId: 'a', sent: false } },
    { channel: 'desktop:selfie-command-result', payload: { requestId: 'b', sent: true } },
    { channel: 'desktop:selfie-command-result', payload: { requestId: 'c', sent: false } },
    { channel: 'desktop:selfie-command-result', payload: { sent: false } },
  ]);
  unsubscribe();
  assert.equal(h.handlers.has('desktop:selfie-command'), false);
  assert.equal(h.bridge.notifySelfieSettings, undefined);
});

function mainHarness({ backendUrl = 'http://localhost:8787', resolveLocalOutputDir = () => path.resolve('configured-selfies'),
  isPackaged = false, configPath } = {}) {
  const handlers = new Map();
  const timers = new Map();
  const sent = [];
  const frame = { url: 'http://localhost:5173/?mode=overlay' };
  const overlayWindow = {
    isDestroyed: () => false,
    webContents: { mainFrame: frame, send: (channel, payload) => sent.push({ channel, payload: clone(payload) }) },
  };
  let nextId = 0;
  const context = vm.createContext({
    overlayWindow,
    selfieWindowManager: { outputDir: 'initial-directory' },
    URL,
    CONFIG: { frontendUrl: 'http://localhost:5173', backendUrl, backendWorkingDir: path.resolve('.') },
    logger: { info() {}, warn() {}, error() {} },
    app: { isPackaged },
    process: { resourcesPath: path.resolve('packaged-resources'), env: { SELFIE_CONFIG_PATH: configPath } },
    resolveLocalSelfieOutputDir: resolveLocalOutputDir,
    fetch: () => { throw new Error('Gallery configuration must stay local'); },
    ipcMain: { on: (channel, handler) => handlers.set(channel, handler) },
    randomUUID: () => `request-${++nextId}`,
    path,
    setTimeout: callback => {
      const timer = Symbol('timer');
      timers.set(timer, callback);
      return timer;
    },
    clearTimeout: timer => timers.delete(timer),
  });
  vm.runInContext(securitySource, context, { filename: 'desktop-security.js' });
  context.registerTrustedDesktopWindow(overlayWindow);
  const start = mainSource.indexOf('const selfieCommands = new Map();');
  const end = mainSource.indexOf('\n/**', start);
  const handlersStart = mainSource.indexOf('function registerIpcHandlers() {');
  const handlersEnd = mainSource.indexOf("  ipcMain.handle('desktop:get-app-info'", handlersStart);
  assert.ok(start >= 0 && end > start && handlersStart >= 0 && handlersEnd > handlersStart);
  vm.runInContext(`${mainSource.slice(start, end)}
${mainSource.slice(handlersStart, handlersEnd)}
}
registerIpcHandlers();
globalThis.pendingSelfieCommands = selfieCommands;`, context, { filename: 'main-selfie-ipc.js' });
  return {
    context, handlers, timers, sent, overlayWindow,
    sender: { sender: overlayWindow.webContents, senderFrame: frame },
    send: message => context.sendSelfieCommand(message),
    resolveOutputDir: () => context.resolveSelfieOutputDir(),
  };
}

test('main cancellation acknowledgements require the overlay main frame and its trusted origin', async () => {
  const h = mainHarness();
  const task = h.send({ type: 'selfie_cancel', jobId: 'job-1' });
  const payload = { requestId: h.sent[0].payload.requestId, sent: true };
  const acknowledge = h.handlers.get('desktop:selfie-command-result');
  acknowledge({ sender: { mainFrame: h.sender.senderFrame }, senderFrame: h.sender.senderFrame }, payload);
  acknowledge({ sender: h.sender.sender, senderFrame: { url: h.sender.senderFrame.url } }, payload);
  acknowledge(h.sender, { ...payload, requestId: 'unknown-request' });
  h.sender.senderFrame.url = 'https://foreign.example/?mode=overlay';
  acknowledge(h.sender, payload);
  h.sender.senderFrame.url = '';
  acknowledge(h.sender, payload);
  h.sender.senderFrame.url = 'http://localhost:5173/?mode=overlay';
  assert.equal(h.context.pendingSelfieCommands.size, 1);
  assert.equal(h.timers.size, 1);
  acknowledge(h.sender, payload);
  assert.equal(await task, true);
  assert.equal(h.context.pendingSelfieCommands.size, 0);
  assert.equal(h.timers.size, 0);
  const next = h.send({ type: 'selfie_cancel', jobId: 'job-2' });
  acknowledge(h.sender, { requestId: h.sent[1].payload.requestId, sent: 'true' });
  assert.equal(await next, false);
});

test('main cancellation fails cleanly for timeout, destroyed overlay, and a send race', async () => {
  const h = mainHarness();
  const timedOut = h.send({ type: 'selfie_cancel', jobId: 'job-1' });
  [...h.timers.values()][0]();
  assert.equal(await timedOut, false);
  assert.equal(h.context.pendingSelfieCommands.size, 0);
  h.overlayWindow.isDestroyed = () => true;
  assert.equal(await h.send({ type: 'selfie_cancel', jobId: 'job-2' }), false);
  h.overlayWindow.isDestroyed = () => false;
  h.overlayWindow.webContents.send = () => { throw new Error('Renderer exited'); };
  assert.equal(await h.send({ type: 'selfie_cancel', jobId: 'job-3' }), false);
  assert.equal(h.context.pendingSelfieCommands.size, 0);
});

test('gallery output directory has no renderer IPC or HTTP dependency and uses main-only local configuration', async () => {
  const requests = [];
  const outputDir = path.resolve('configured-selfies');
  const h = mainHarness({ resolveLocalOutputDir: options => { requests.push(options); return outputDir; } });
  assert.equal(h.handlers.has('desktop:selfie-settings'), false);
  assert.equal(await h.resolveOutputDir(), outputDir);
  assert.equal(requests.length, 1);
  assert.deepEqual(clone(requests[0]), {
    isPackaged: false, resourcesPath: path.resolve('packaged-resources'), serverRoot: path.resolve('.'),
  });
});

test('installed gallery configuration passes its local override and reports local resolution failures', async () => {
  const configPath = path.resolve('external-server', 'selfie.config.json');
  const requests = [];
  const h = mainHarness({ isPackaged: true, configPath, resolveLocalOutputDir: options => { requests.push(options); return 'configured'; } });
  assert.equal(await h.resolveOutputDir(), 'configured');
  assert.equal(requests[0].isPackaged, true);
  assert.equal(requests[0].configPath, configPath);
  const failed = mainHarness({ resolveLocalOutputDir: () => { throw new Error('Invalid local selfie output directory'); } });
  await assert.rejects(failed.resolveOutputDir(), /Invalid local selfie output directory/);
});

test('navigation and redirects both reject foreign origins and allow the registered frontend', () => {
  const context = vm.createContext({ URL, CONFIG: { frontendUrl: 'http://localhost:5173' }, logger: { info() {}, warn() {}, error() {} } });
  vm.runInContext(securitySource, context);
  const handlers = new Map();
  let openHandler;
  context.hardenWindowNavigation({ webContents: {
    on: (name, handler) => handlers.set(name, handler),
    setWindowOpenHandler: handler => { openHandler = handler; },
  } });
  for (const name of ['will-navigate', 'will-redirect']) {
    let prevented = 0;
    const event = { preventDefault: () => { prevented++; } };
    handlers.get(name)(event, 'https://foreign.example');
    handlers.get(name)(event, 'http://localhost:5173/?mode=overlay');
    handlers.get(name)(event, 'file:///unregistered.html');
    assert.equal(prevented, 2);
  }
  assert.equal(openHandler({ url: 'http://localhost:5173' }).action, 'deny');
});

test('overlay CSP has no remote fonts and file trust is limited to the registered page', () => {
  const context = vm.createContext({ URL, CONFIG: { frontendUrl: 'http://localhost:5173', backendUrl: 'http://localhost:8787' }, logger: { info() {}, warn() {}, error() {} } });
  vm.runInContext(securitySource, context);
  context.registerTrustedOrigin('file:///frontend/index.html');
  assert.equal(context.isTrustedUrl('file:///frontend/index.html?mode=overlay'), true);
  assert.equal(context.isTrustedUrl('file:///other/index.html'), false);
  assert.equal(context.isTrustedUrl('http://user:secret@localhost:5173'), false);
  let headersHandler;
  context.configureSessionSecurity({
    setPermissionCheckHandler() {}, setPermissionRequestHandler() {},
    webRequest: { onHeadersReceived: handler => { headersHandler = handler; } },
  });
  let csp;
  headersHandler({ url: 'http://localhost:5173/', responseHeaders: {} }, response => {
    csp = response.responseHeaders['Content-Security-Policy'][0];
  });
  assert.match(csp, /font-src 'self' data:/);
  assert.doesNotMatch(csp, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
});

test('generic desktop IPC denies the popup and subframes even when their local URL is trusted', () => {
  const context = vm.createContext({
    URL,
    CONFIG: { frontendUrl: 'http://localhost:5173' },
    logger: { info() {}, warn() {}, error() {} },
  });
  vm.runInContext(securitySource, context, { filename: 'desktop-security.js' });
  const mainFrame = { url: 'http://localhost:5173/?mode=overlay' };
  const window = { isDestroyed: () => false, webContents: { mainFrame } };
  const sender = { sender: window.webContents, senderFrame: mainFrame };
  assert.throws(() => context.assertTrustedSender(sender, 'desktop:capture-screen'), /Untrusted/);
  context.registerTrustedDesktopWindow(window);
  assert.equal(context.assertTrustedSender(sender, 'desktop:capture-screen'), true);
  assert.throws(() => context.assertTrustedSender({ sender: window.webContents, senderFrame: { url: mainFrame.url } }), /Untrusted/);
  const popupFrame = { url: 'file:///selfiePopup.html' };
  assert.throws(() => context.assertTrustedSender({ sender: { mainFrame: popupFrame }, senderFrame: popupFrame }), /Untrusted/);
  mainFrame.url = 'https://untrusted.example';
  assert.throws(() => context.assertTrustedSender(sender), /Untrusted/);
  context.registerTrustedOrigin('http://127.0.0.1:49421');
  context.registerTrustedDesktopWindow(window, 'http://127.0.0.1:49421/?mode=overlay');
  mainFrame.url = 'http://localhost:5173';
  assert.throws(() => context.assertTrustedSender(sender), /Untrusted/);
  mainFrame.url = 'http://127.0.0.1:49421/?mode=overlay';
  assert.equal(context.assertTrustedSender(sender), true);
  mainFrame.url = 'http://localhost:5173';
  window.isDestroyed = () => true;
  assert.throws(() => context.assertTrustedSender(sender), /Untrusted/);
});
