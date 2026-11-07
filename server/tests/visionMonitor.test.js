import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const monitorRoot = new URL('../../vision-monitor/', import.meta.url);

class Element {
  constructor() {
    this.style = {};
    this.children = [];
    this.nodes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.checked = true;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }

  get parentElement() { return this.parent ||= new Element(); }
  get firstElementChild() { return this.children[0] || this.querySelector(':first-child'); }
  closest(selector) { return this.querySelector(`closest:${selector}`); }
  querySelector(selector) {
    if (!this.nodes.has(selector)) this.nodes.set(selector, new Element());
    return this.nodes.get(selector);
  }
  querySelectorAll() { return this.children.filter(child => child.className.split(' ').includes('feed-item')); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  appendChild(child) { this.append(child); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  before() {}
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
}

function loadMonitorUi(location = { hostname: 'localhost', host: 'localhost:5174', protocol: 'http:' }) {
  const elements = new Map();
  const getElement = key => {
    if (!elements.has(key)) elements.set(key, new Element());
    return elements.get(key);
  };
  getElement('description-log-list').append(getElement('empty-log-message'));
  const intervals = new Map();
  const timeouts = new Map();
  let timerId = 0;
  let now = 1000;
  let socket;
  class Socket {
    static OPEN = 1;
    constructor(url) { socket = this; this.url = url; this.readyState = 1; this.sent = []; }
    send(message) { this.sent.push(JSON.parse(message)); }
  }
  const context = vm.createContext({
    console: { log() {} },
    document: { getElementById: getElement, querySelector: getElement, createElement: () => new Element() },
    window: { location },
    WebSocket: Socket,
    Date: class extends Date { static now() { return now; } },
    setInterval: callback => { intervals.set(++timerId, callback); return timerId; },
    clearInterval: id => intervals.delete(id),
    setTimeout: callback => { timeouts.set(++timerId, callback); return timerId; },
    clearTimeout: id => timeouts.delete(id),
    confirm: () => true,
  });
  vm.runInContext(fs.readFileSync(new URL('src/main.js', monitorRoot), 'utf8'), context);
  return { elements, intervals, timeouts, context, socket,
    setNow: value => { now = value; },
    receive: message => socket.onmessage({ data: JSON.stringify(message) }) };
}

test('monitor initializes both source cards and changes AI spacing without changing capture', () => {
  const ui = loadMonitorUi();
  const slider = ui.elements.get('interval-slider');
  assert.equal(slider.min, '2');
  assert.equal(vm.runInContext('Object.keys(sourceElements).join(",")', ui.context), 'screen,webcam');
  slider.listeners.get('input')({ target: { value: '4' } });
  for (const callback of [...ui.timeouts.values()]) callback();
  assert.deepEqual(ui.socket.sent[0], { type: 'update_vision_config', settings: { minInferenceIntervalMs: 4000 } });
});

test('monitor socket uses the page origin and matches HTTPS without a fixed bridge port', () => {
  assert.equal(loadMonitorUi().socket.url, 'ws://localhost:5174/ws-monitor');
  assert.equal(loadMonitorUi({ hostname: 'monitor.local', host: 'monitor.local:5443', protocol: 'https:' }).socket.url,
    'wss://monitor.local:5443/ws-monitor');
});

test('monitor keeps source previews separate, ages freshness, and keeps countdown timers stable', () => {
  const ui = loadMonitorUi();
  const sources = {
    screen: { active: true, sessionId: 's1', freshness: 'current', lastCaptureAgeMs: 100, score: 3.5 },
    webcam: { active: true, sessionId: 'c1', freshness: 'waiting', lastCaptureAgeMs: 0 },
  };
  ui.receive({ type: 'screen_share_status', active: true, sources });
  const timerIds = [...ui.intervals.keys()];
  ui.receive({ type: 'monitor_frame', source: 'screen', sessionId: 's1', image: 'screen-image', sources });
  ui.receive({ type: 'monitor_frame', source: 'webcam', sessionId: 'c1', image: 'webcam-image', sources });
  assert.deepEqual([...ui.intervals.keys()], timerIds);
  assert.equal(ui.elements.get('live-preview-img').src, 'screen-image');
  vm.runInContext('sourceElements.webcam.button.listeners.get("click")()', ui.context);
  assert.equal(ui.elements.get('live-preview-img').src, 'webcam-image');
  assert.equal(vm.runInContext('sourceElements.screen.score.textContent', ui.context), 'Skor perubahan: 3.50');
  ui.setNow(8000);
  vm.runInContext('renderSources()', ui.context);
  assert.equal(vm.runInContext('sourceElements.webcam.freshness.textContent', ui.context), 'Kedaluwarsa');
  assert.match(ui.elements.get('stream-source-badge').textContent, /kedaluwarsa/);
  ui.socket.onclose();
  assert.equal(vm.runInContext('sourceElements.webcam.freshness.textContent', ui.context), 'Nonaktif');
});

test('monitor restores bounded source-labelled feed, escapes errors, and displays zero cost honestly', () => {
  const ui = loadMonitorUi();
  ui.receive({ type: 'init_state', companionStatus: 'connected', state: { logs: [
    { type: 'vision_entry', source: 'webcam', entry: { description: '<camera>', timestamp: '<time>', costUsd: 0 } },
    { type: 'vision_error', source: 'screen', message: '<failure>' },
  ] } });
  const list = ui.elements.get('description-log-list');
  let items = list.querySelectorAll();
  assert.match(items[0].innerHTML, /Kamera.*Deskripsi AI/);
  assert.match(items[0].innerHTML, /\$0\.00000/);
  assert.match(items[0].innerHTML, /&lt;time&gt;/);
  assert.match(items[1].innerHTML, /&lt;failure&gt;/);
  for (let index = 0; index < 105; index++) ui.receive({ type: 'vision_error', source: 'webcam', message: String(index) });
  items = list.querySelectorAll();
  assert.equal(items.length, 100);
  assert.equal(ui.elements.get('log-count-tag').textContent, '(100 log)');
  ui.elements.get('clear-logs-btn').listeners.get('click')();
  assert.equal(list.querySelectorAll().length, 0);
  assert.equal(ui.elements.get('empty-log-message').style.display, 'block');
});

function loadMonitorBridge() {
  const routes = new Map();
  const connections = new Map();
  let now = 1000;
  let companion;
  const app = { use() {}, get: (path, callback) => routes.set(path, callback) };
  const express = () => app;
  express.json = () => {};
  class Companion {
    constructor() { companion = this; this.status = 'connected'; this.sent = []; }
    connect() {}
    send(message) { this.sent.push(JSON.parse(JSON.stringify(message))); }
  }
  class Server {
    constructor() { this.clients = new Set(); }
    on(name, callback) { connections.set(name, callback); }
  }
  const context = vm.createContext({
    console: { log() {} }, process: { env: {} }, express,
    http: { createServer: () => ({ listen() {} }) },
    WebSocketServer: Server, WebSocket: { OPEN: 1 }, CompanionWsClient: Companion,
    Date: class extends Date { static now() { return now; } },
  });
  const source = fs.readFileSync(new URL('server/server.js', monitorRoot), 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  const state = () => {
    let result;
    routes.get('/api/status')({}, { json: value => { result = JSON.parse(JSON.stringify(value)); } });
    return result.state;
  };
  return { companion, state, setNow: value => { now = value; }, connectUi: () => {
    const handlers = new Map();
    connections.get('connection')({ send() {}, on: (name, callback) => handlers.set(name, callback) });
    const receive = message => handlers.get('message')(Buffer.from(JSON.stringify(message)));
    receive.close = () => handlers.get('close')();
    return receive;
  } };
}

test('bridge ages cached telemetry, clears changed sessions, and retains historical counters on disconnect', () => {
  const bridge = loadMonitorBridge();
  bridge.companion.onMessage({ type: 'screen_share_status', sources: {
    screen: { active: true, sessionId: 's1', freshness: 'current', lastCaptureAgeMs: 100, captured: 12 },
  } });
  bridge.companion.onMessage({ type: 'monitor_frame', source: 'screen', sessionId: 's1', image: 'old-frame' });
  bridge.companion.onMessage({ type: 'vision_entry', source: 'screen', entry: { description: 'old-description' } });
  bridge.setNow(7000);
  assert.equal(bridge.state().sources.screen.lastCaptureAgeMs, 6100);
  assert.equal(bridge.state().sources.screen.freshness, 'expired');
  bridge.companion.onMessage({ type: 'screen_share_status', sources: { screen: { active: true, sessionId: 's2' } } });
  assert.equal(bridge.state().frames.screen, undefined);
  assert.equal(bridge.state().descriptions.screen, undefined);
  bridge.companion.onStatusChange('reconnecting');
  assert.equal(bridge.state().sources.screen.active, false);
  assert.equal(bridge.state().sources.screen.captured, 12);
});

test('bridge bounds replay logs and normalizes old monitor controls to AI spacing', () => {
  const bridge = loadMonitorBridge();
  for (let index = 0; index < 105; index++) bridge.companion.onMessage({ type: 'vision_error', source: 'webcam', message: String(index) });
  assert.equal(bridge.state().logs.length, 100);
  assert.equal(bridge.state().logs[0].message, '5');
  const receive = bridge.connectUi();
  receive({ type: 'update_vision_config', settings: { intervalSeconds: 1, maxTokens: 100 } });
  const updates = () => bridge.companion.sent.filter(message => message.type === 'update_vision_config');
  assert.deepEqual(updates()[0].settings, { minInferenceIntervalMs: 2000, maxTokens: 100 });
  receive({ type: 'update_vision_config', settings: { minInferenceIntervalMs: 50000 } });
  assert.equal(updates()[1].settings.minInferenceIntervalMs, 30000);
});

test('bridge reports dashboard presence across closing the last tab and backend reconnects', () => {
  const bridge = loadMonitorBridge();
  const reports = () => bridge.companion.sent.filter(message => message.type === 'monitor_presence').map(message => message.active);
  bridge.companion.onStatusChange('connected');
  assert.deepEqual(reports(), [false]);
  const first = bridge.connectUi();
  const second = bridge.connectUi();
  first.close();
  assert.deepEqual(reports(), [false, true, true, true]);
  bridge.companion.onStatusChange('connected');
  assert.equal(reports().at(-1), true);
  second.close();
  assert.equal(reports().at(-1), false);
  bridge.companion.onStatusChange('connected');
  assert.equal(reports().at(-1), false);
});
