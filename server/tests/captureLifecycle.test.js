import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../src/companion.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function stream() {
  const events = new Map();
  const value = { active: true };
  const track = { stop() { value.active = false; },
    addEventListener: (name, callback) => events.set(name, callback) };
  return Object.assign(value, { events, getTracks: () => [track], getVideoTracks: () => [track] });
}
function classList() {
  const values = new Set();
  return { add: value => values.add(value), remove: value => values.delete(value),
    contains: value => values.has(value) };
}

test('a stale webcam play completion cannot enable monitoring or clear a newer loading indicator', async () => {
  const first = stream(), second = stream(), firstPlay = deferred(), secondPlay = deferred();
  const monitoring = [], statuses = [];
  let calls = 0;
  const video = { srcObject: null, classList: classList(),
    play: () => video.srcObject === first ? firstPlay.promise : secondPlay.promise };
  const context = vm.createContext({ video, currentFacingMode: 'user', cameraGeneration: 0,
    navigator: { mediaDevices: { getUserMedia: async () => ++calls === 1 ? first : second } },
    continuousVision: { setActive: (...args) => monitoring.push(args) },
    syncCaptureStatus: (...args) => statuses.push(args), tuning: { get: () => 'on' }, log() {} });
  vm.runInContext(source.slice(source.indexOf('async function initWebcam('),
    source.indexOf('async function toggleCamera(')), context);
  const old = context.initWebcam('user');
  await tick();
  const fresh = context.initWebcam('environment');
  await tick();
  firstPlay.resolve();
  await old;
  assert.equal(first.active, false);
  assert.equal(video.srcObject, second);
  assert.equal(video.classList.contains('camera-loading'), true);
  assert.equal(monitoring.some(([, active]) => active), false);
  secondPlay.resolve();
  await fresh;
  assert.deepEqual(monitoring.at(-1), ['webcam', true]);
  assert.deepEqual(statuses.at(-1), ['webcam', true]);
  assert.equal(context.currentFacingMode, 'environment');
  assert.equal(video.classList.contains('camera-loading'), false);
});

test('an ended older webcam cannot retire the new physical capture source', async () => {
  const first = stream(), second = stream(), statuses = [];
  let calls = 0;
  const video = { srcObject: null, classList: classList(), play: async () => {} };
  const context = vm.createContext({ video, currentFacingMode: 'user', cameraGeneration: 0,
    navigator: { mediaDevices: { getUserMedia: async () => ++calls === 1 ? first : second } },
    continuousVision: { setActive() {} }, syncCaptureStatus: (...args) => statuses.push(args),
    tuning: { get: () => 'off' }, log() {} });
  vm.runInContext(source.slice(source.indexOf('async function initWebcam('),
    source.indexOf('async function toggleCamera(')), context);
  await context.initWebcam();
  await context.initWebcam('environment');
  const count = statuses.length;
  first.events.get('ended')();
  assert.equal(statuses.length, count);
  second.events.get('ended')();
  assert.deepEqual(statuses.at(-1), ['webcam', false]);
});

test('stopping screen share while video play is pending cannot resurrect capture', async () => {
  const screen = stream(), play = deferred(), statuses = [];
  let starts = 0;
  const button = { classList: classList(), textContent: '' };
  const context = vm.createContext({ screenGeneration: 0, screenStream: null,
    screenVideo: { srcObject: null, play: () => play.promise }, screenShareBtn: button,
    navigator: { mediaDevices: { getDisplayMedia: async options => {
      assert.equal(options.video.cursor, 'never');
      return screen;
    } } }, syncCaptureStatus: (...args) => statuses.push(args),
    startContinuousCapture: () => starts++, stopContinuousCapture() {}, log() {}, console });
  const start = source.indexOf('async function startScreenShare(');
  const end = source.indexOf('if (screenShareBtn)', source.indexOf('function stopScreenShare('));
  const stopEnd = source.indexOf('\n}', end) + 2;
  vm.runInContext(source.slice(start, stopEnd), context);
  const pending = context.startScreenShare();
  await tick();
  context.stopScreenShare();
  play.resolve();
  await pending;
  assert.equal(starts, 0);
  assert.equal(screen.active, false);
  assert.equal(context.screenStream, null);
  assert.equal(button.classList.contains('active'), false);
  assert.deepEqual(statuses.at(-1), ['screen', false]);
});
