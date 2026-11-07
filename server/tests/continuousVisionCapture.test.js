import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ContinuousVisionCapture, captureSignature } from '../../src/continuousVision.js';
import { VISION_SIGNATURE_SIZES } from '../../src/visionSignature.js';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('default browser timers retain their window receiver and continue after the first camera frame', async () => {
  const timers = new Map();
  const messages = [];
  let timerId = 0;
  let sessionId = 0;
  const context = vm.createContext({ crypto: { randomUUID: () => 'native-' + ++sessionId },
    performance: { now: () => 1000 }, console });
  vm.runInContext('globalThis.window = globalThis;', context);
  const browserWindow = vm.runInContext('globalThis', context);
  context.setInterval = function (callback, interval) {
    if (this !== browserWindow) throw new TypeError('Illegal invocation');
    assert.equal(interval, 1000);
    timers.set(++timerId, callback);
    return timerId;
  };
  context.clearInterval = function (id) {
    if (this !== browserWindow) throw new TypeError('Illegal invocation');
    timers.delete(id);
  };
  const source = fs.readFileSync(new URL('../../src/continuousVision.js', import.meta.url), 'utf8');
  const classSource = source.slice(source.indexOf('export class ContinuousVisionCapture'))
    .replace('export class ContinuousVisionCapture', 'globalThis.ContinuousVisionCapture = class ContinuousVisionCapture');
  vm.runInContext(classSource, context);
  const capture = new context.ContinuousVisionCapture({ capture: () => frame('webcam'),
    send: message => messages.push(message) });
  try {
    capture.setActive('webcam', true);
    capture.connect();
    capture.setMonitorActive(true);
    await flush();
    assert.equal(timers.size, 1);
    for (let tick = 0; tick < 15; tick++) {
      [...timers.values()][0]();
      await flush();
    }
    assert.equal(messages.filter(message => message.type === 'continuous_frame').length, 16);
    capture.restart('webcam');
    await flush();
    assert.equal(timers.size, 1);
    capture.setActive('webcam', false);
    assert.equal(timers.size, 0);
  } finally { capture.disconnect(); }
});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function frame(source) {
  const { width, height } = VISION_SIGNATURE_SIZES[source];
  return { image: 'data:image/png;base64,aGVsbG8=',
    signature: { version: 1, width, height, luma: new Array(width * height).fill(50) } };
}
function harness(t, captureFn) {
  const timers = new Map();
  const captures = [];
  const messages = [];
  const clock = { value: 1000 };
  const network = { ready: true };
  let timerId = 0;
  let sessionId = 0;
  const capture = new ContinuousVisionCapture({ capture: source => {
    captures.push(source);
    return captureFn ? captureFn(source) : frame(source);
  }, send: message => messages.push(message), now: () => clock.value,
  canSend: () => network.ready, makeId: () => 'capture-' + ++sessionId,
  setIntervalFn: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
  clearIntervalFn: id => timers.delete(id) });
  t.after(() => capture.disconnect());
  return { capture, captures, messages, timers, clock, network };
}

test('source loops capture independently at one-second cadence while the monitor is open', async t => {
  const h = harness(t);
  h.capture.setActive('screen', true);
  h.capture.setActive('webcam', true);
  h.capture.connect();
  h.capture.setMonitorActive(true);
  await flush();
  assert.deepEqual(h.captures, ['screen', 'webcam']);
  assert.equal(h.timers.size, 2);
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [1000, 1000]);
  const frames = h.messages.filter(message => message.type === 'continuous_frame');
  assert.deepEqual(frames.map(message => [message.source, message.sequence, message.signature.width, message.signature.height]),
    [['screen', 1, 128, 72], ['webcam', 1, 64, 48]]);
  assert.notEqual(frames[0].sessionId, frames[1].sessionId);
  h.capture.setActive('screen', false);
  assert.equal(h.timers.size, 1);
  await h.capture.tick('webcam');
  assert.equal(h.messages.filter(message => message.type === 'continuous_frame' && message.source === 'webcam').length, 2);
});

test('source OFF announces the retiring ON session so backend can abort immediately', async t => {
  const h = harness(t);
  h.capture.connect();
  h.capture.setMonitorActive(true);
  h.capture.setActive('screen', true);
  await flush();
  const on = h.messages.findLast(message => message.type === 'vision_source_status' && message.source === 'screen');
  h.capture.setActive('screen', false);
  const off = h.messages.findLast(message => message.type === 'vision_source_status' && message.source === 'screen');
  assert.equal(off.active, false);
  assert.equal(off.sessionId, on.sessionId);
  assert.equal(h.timers.size, 0);
});

test('source stop discards pending capture while other source continues', async t => {
  const pending = deferred();
  const h = harness(t, source => source === 'screen' ? pending.promise : frame(source));
  h.capture.setActive('screen', true);
  h.capture.setActive('webcam', true);
  h.capture.connect();
  h.capture.setMonitorActive(true);
  await flush();
  h.capture.setActive('screen', false);
  pending.resolve(frame('screen'));
  await flush();
  assert.equal(h.messages.filter(message => message.type === 'continuous_frame' && message.source === 'screen').length, 0);
  assert.equal(h.messages.filter(message => message.type === 'continuous_frame' && message.source === 'webcam').length, 1);
});

test('reconnect fences old pending capture and old finally cannot clear new source busy state', async t => {
  const previous = deferred();
  const current = deferred();
  let count = 0;
  const h = harness(t, () => ++count === 1 ? previous.promise : current.promise);
  h.capture.setActive('screen', true);
  h.capture.connect();
  h.capture.setMonitorActive(true);
  const firstSession = h.capture.sources.get('screen').sessionId;
  h.capture.disconnect();
  assert.equal(h.timers.size, 0);
  h.capture.connect();
  h.capture.setMonitorActive(true);
  const secondSession = h.capture.sources.get('screen').sessionId;
  assert.notEqual(firstSession, secondSession);
  previous.resolve(frame('screen'));
  await flush();
  assert.equal(h.capture.sources.get('screen').busy, true);
  assert.equal(h.messages.filter(message => message.type === 'continuous_frame').length, 0);
  current.resolve(frame('screen'));
  await flush();
  const sent = h.messages.filter(message => message.type === 'continuous_frame');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, secondSession);
  assert.equal(sent[0].sequence, 1);
});

test('backpressure skips capture and rechecks network after asynchronous capture completion', async t => {
  const pending = deferred();
  const h = harness(t, () => pending.promise);
  h.network.ready = false;
  h.capture.setActive('screen', true);
  h.capture.connect();
  h.capture.setMonitorActive(true);
  assert.equal(h.captures.length, 0);
  h.network.ready = true;
  const work = h.capture.tick('screen');
  assert.equal(h.captures.length, 1);
  await h.capture.tick('screen');
  assert.equal(h.captures.length, 1);
  h.network.ready = false;
  pending.resolve(frame('screen'));
  await work;
  assert.equal(h.messages.filter(message => message.type === 'continuous_frame').length, 0);
  assert.equal(h.capture.sources.get('screen').sequence, 0);
});

test('capture age includes slow capture latency instead of falsely marking an old screenshot fresh', async t => {
  const pending = deferred();
  const h = harness(t, () => pending.promise);
  h.capture.setActive('screen', true);
  h.capture.connect();
  h.capture.setMonitorActive(true);
  h.clock.value += 6000;
  pending.resolve(frame('screen'));
  await flush();
  const message = h.messages.find(message => message.type === 'continuous_frame');
  assert.equal(message.captureAgeMs, 6000);
});

test('restart mints a new source session and resets sequences without restarting another source', async t => {
  const h = harness(t);
  h.capture.setActive('screen', true);
  h.capture.setActive('webcam', true);
  h.capture.connect();
  h.capture.setMonitorActive(true);
  await flush();
  const screenSession = h.capture.sources.get('screen').sessionId;
  const cameraSession = h.capture.sources.get('webcam').sessionId;
  const cameraTimer = h.capture.sources.get('webcam').timer;
  h.capture.restart('screen');
  await flush();
  assert.notEqual(h.capture.sources.get('screen').sessionId, screenSession);
  assert.equal(h.capture.sources.get('webcam').sessionId, cameraSession);
  assert.equal(h.capture.sources.get('webcam').timer, cameraTimer);
  const newest = h.messages.findLast(message => message.type === 'continuous_frame' && message.source === 'screen');
  assert.equal(newest.sequence, 1);
});

test('signature sampling uses source-sized canvas pixels', () => {
  for (const source of ['screen', 'webcam']) {
    const calls = [];
    const canvas = { width: 0, height: 0, getContext: () => ({
      drawImage: (...args) => calls.push(args),
      getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(80) }),
    }) };
    const result = captureSignature({}, source, canvas);
    const { width, height } = VISION_SIGNATURE_SIZES[source];
    assert.equal(result.width, width);
    assert.equal(result.height, height);
    assert.equal(result.luma.length, width * height);
    assert.deepEqual(calls[0].slice(1), [0, 0, width, height]);
  }
});

test('active sources do not capture until a dashboard opens and stop when it closes', async t => {
  const h = harness(t);
  h.capture.setActive('screen', true);
  h.capture.setActive('webcam', true);
  h.capture.connect();
  await h.capture.tick('webcam');
  assert.equal(h.captures.length, 0);
  assert.equal(h.timers.size, 0);
  assert.ok(h.messages.every(message => message.active === false));
  h.capture.setMonitorActive(true);
  await flush();
  assert.deepEqual(h.captures, ['screen', 'webcam']);
  const firstSession = h.capture.sources.get('webcam').sessionId;
  h.capture.setMonitorActive(false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.capture.sources.get('webcam').active, true);
  assert.equal(h.messages.at(-1).active, false);
  await h.capture.tick('webcam');
  assert.equal(h.captures.length, 2);
  h.capture.setMonitorActive(true);
  await flush();
  assert.equal(h.timers.size, 2);
  assert.notEqual(h.capture.sources.get('webcam').sessionId, firstSession);
  assert.equal(h.messages.at(-1).sequence, 1);
});

test('closing and reopening a monitor fences pending frames and old busy cleanup', async t => {
  const old = deferred();
  const fresh = deferred();
  let captures = 0;
  const h = harness(t, () => ++captures === 1 ? old.promise : fresh.promise);
  h.capture.setActive('webcam', true);
  h.capture.connect();
  h.capture.setMonitorActive(true);
  h.capture.setMonitorActive(false);
  old.resolve(frame('webcam'));
  h.capture.setMonitorActive(true);
  await flush();
  assert.equal(h.capture.sources.get('webcam').busy, true);
  assert.equal(h.messages.filter(message => message.type === 'continuous_frame').length, 0);
  fresh.resolve(frame('webcam'));
  await flush();
  assert.equal(h.messages.filter(message => message.type === 'continuous_frame').length, 1);
  h.capture.disconnect();
  h.capture.connect();
  await flush();
  assert.equal(h.timers.size, 0);
  assert.equal(captures, 2);
});
