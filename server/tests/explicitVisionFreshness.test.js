import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const file = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const start = file.indexOf('      // 2) Vision');
const end = file.indexOf('      // 3) Chat streaming', start);
assert.ok(start >= 0 && end > start, 'actual handler vision section is available');
const section = file.slice(start, end);
const statusStart = file.indexOf("    if (msg.type === 'vision_capture_status')");
const statusEnd = file.indexOf("    if (msg.type === 'vision_source_status')", statusStart);
assert.ok(statusStart >= 0 && statusEnd > statusStart, 'actual capture status handler is available');
const statusSection = file.slice(statusStart, statusEnd);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function harness({ source = 'screen', active = true, explicit = true, describe, capture,
  token, actualToken = 'physical-1', actualActive = true, signalFallback = false } = {}) {
  const state = { active, sessionId: active ? 'capture-1' : null };
  const captureState = { sessionId: actualToken, active: actualActive };
  const socket = { captureSessions: { screen: { sessionId: 'screen-0', active: false },
    webcam: { sessionId: 'webcam-0', active: false }, [source]: captureState }, explicitVisionControllers: new Map() };
  const events = [];
  const descriptions = [];
  const turnState = { current: true };
  const context = {
    text: 'lihat ' + source,
    image: source === 'webcam' ? 'webcam-frame' : null,
    screenImage: source === 'screen' && !capture ? 'screen-frame' : null,
    msg: { desktop: Boolean(capture), screenVisionOn: Boolean(capture),
      ...(token !== undefined && { captureSessions: { [source]: token } }) },
    visionManager: { getConversationContext: () => '[Layar saat ini] Old screen\n[Kamera saat ini] Old webcam',
      getSourceSnapshot: () => ({ [source]: state }) },
    detectVisionIntent: () => explicit,
    getSlotStatus: () => ({ available: true }),
    resolveVisionSource: () => ({ source, requested: source, available: true }),
    requestScreenCapture: () => capture(),
    describeFrame: async (...args) => { descriptions.push(args); return describe ? describe(...args) : 'Fresh scene.'; },
    isCurrent: () => turnState.current,
    turn: { turnId: 'turn-1', signal: new AbortController().signal },
    socket, send: event => events.push(event),
    playSpokenMessage: () => { throw new Error('Unavailable path must not run.'); },
    UNAVAILABLE_MESSAGES: { vision: 'Unavailable' },
    AbortController, AbortSignal: signalFallback ? {} : AbortSignal,
    performance, ms: () => 0, tPipe: 0,
    console: { log() {}, warn() {}, error() {} },
  };
  const run = () => vm.runInNewContext('(async () => { ' + section + '\nreturn vision; })()', context);
  const status = (changes) => vm.runInNewContext('(() => { ' + statusSection + ' })()',
    { socket, msg: { type: 'vision_capture_status', source, ...changes } });
  return { run, status, state, socket, events, descriptions, turnState, context };
}

test('actual explicit handler never falls back to automatic cache when fresh inference fails', async () => {
  const h = harness({ describe: () => { throw new Error('private-provider-error'); } });
  const vision = await h.run();
  assert.match(vision, /VISION_FRESH_FAILED/);
  assert.doesNotMatch(vision, /Old screen|Old webcam|private-provider-error/);
  assert.equal(h.descriptions.length, 1);
  assert.doesNotMatch(JSON.stringify(h.events), /private-provider-error/);
});

test('actual explicit handler discards a model reply after monitored source stop', async () => {
  const pending = deferred();
  const h = harness({ source: 'webcam', describe: () => pending.promise });
  const work = h.run();
  h.state.active = false;
  h.state.sessionId = null;
  pending.resolve('Retired webcam scene.');
  const vision = await work;
  assert.match(vision, /VISION_SOURCE_RETIRED/);
  assert.doesNotMatch(vision, /Retired webcam scene|Old/);
  assert.doesNotMatch(JSON.stringify(h.events), /Retired webcam scene/);
});

test('actual explicit handler discards a model reply after monitored capture session switch', async () => {
  const pending = deferred();
  const h = harness({ describe: () => pending.promise });
  const work = h.run();
  h.state.sessionId = 'capture-2';
  pending.resolve('Retired display scene.');
  assert.match(await work, /VISION_SOURCE_RETIRED/);
  assert.doesNotMatch(JSON.stringify(h.events), /Retired display scene/);
});

test('actual explicit handler rejects a delayed desktop frame before inference if source switched', async () => {
  const pending = deferred();
  const h = harness({ capture: () => pending.promise });
  const work = h.run();
  h.state.sessionId = 'capture-2';
  pending.resolve({ ok: true, dataUrl: 'retired-screen-frame' });
  assert.match(await work, /VISION_SOURCE_RETIRED/);
  assert.equal(h.descriptions.length, 0);
});

test('actual explicit handler preserves one-shot webcam behavior with continuous monitoring off', async () => {
  const h = harness({ source: 'webcam', active: false });
  assert.match(await h.run(), /Kamera aktif & berhasil dilihat.*Fresh scene/);
  assert.equal(h.descriptions.length, 1);
});

test('ordinary actual handler retains both automatic source contexts without a new provider call', async () => {
  const h = harness({ explicit: false });
  assert.match(await h.run(), /Layar saat ini[\s\S]*Kamera saat ini/);
  assert.equal(h.descriptions.length, 0);
});

test('actual explicit handler ignores inference completion after the conversation turn is retired', async () => {
  const pending = deferred();
  const h = harness({ describe: () => pending.promise });
  const work = h.run();
  h.turnState.current = false;
  pending.resolve('Retired turn scene.');
  assert.equal(await work, undefined);
  assert.equal(h.events.length, 0);
});

test('monitoring-off explicit request aborts immediately when actual camera stops', async () => {
  const pending = deferred();
  const h = harness({ source: 'webcam', active: false, token: 'physical-1', describe: () => pending.promise });
  const work = h.run();
  const signal = h.descriptions[0][2].signal;
  h.status({ sessionId: 'physical-2', active: false });
  assert.equal(signal.aborted, true);
  pending.resolve('Retired one-shot webcam image.');
  assert.match(await work, /VISION_SOURCE_RETIRED/);
  assert.doesNotMatch(JSON.stringify(h.events), /Retired one-shot/);
  assert.equal(h.socket.explicitVisionControllers.size, 0);
});

test('stale supplied frame token after source switch during STT cannot start inference', async () => {
  const h = harness({ source: 'webcam', active: false, token: 'physical-1', actualToken: 'physical-2' });
  assert.match(await h.run(), /VISION_SOURCE_RETIRED/);
  assert.equal(h.descriptions.length, 0);
  assert.equal(h.socket.explicitVisionControllers.size, 0);
});

test('inactive or malformed actual capture token cannot claim current one-shot perception', async () => {
  for (const options of [{ actualActive: false }, { token: 12 }]) {
    const h = harness({ active: false, token: 'physical-1', ...options });
    assert.match(await h.run(), /VISION_SOURCE_RETIRED/);
    assert.equal(h.descriptions.length, 0);
  }
});

test('capture status bounds and source identity keep other-source inference isolated', async () => {
  const pending = deferred();
  const h = harness({ active: false, token: 'physical-1', describe: () => pending.promise });
  const work = h.run();
  const signal = h.descriptions[0][2].signal;
  for (const changes of [{ sessionId: '', active: false }, { sessionId: 'x'.repeat(129), active: false },
    { sessionId: 'physical-2', active: 'false' }, { source: '__proto__', sessionId: 'physical-2', active: false }]) {
    h.status(changes);
    assert.equal(signal.aborted, false);
  }
  h.status({ source: 'webcam', sessionId: 'camera-1', active: true });
  h.status({ sessionId: 'physical-1', active: true });
  assert.equal(signal.aborted, false);
  pending.resolve('Still current screen.');
  assert.match(await work, /Still current screen/);
  assert.equal(h.socket.explicitVisionControllers.size, 0);
});

test('Node18 fallback combines turn and capture cancellation and removes listeners after completion', async () => {
  const pending = deferred();
  const h = harness({ active: false, token: 'physical-1', signalFallback: true, describe: () => pending.promise });
  const turnController = new AbortController();
  const signal = turnController.signal;
  let added = 0;
  let removed = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { added++; add(...args); };
  signal.removeEventListener = (...args) => { removed++; remove(...args); };
  h.context.turn.signal = signal;
  const work = h.run();
  const observationSignal = h.descriptions[0][2].signal;
  turnController.abort();
  h.turnState.current = false;
  assert.equal(observationSignal.aborted, true);
  pending.resolve('Retired turn scene.');
  assert.equal(await work, undefined);
  assert.equal(added, removed);
  assert.equal(h.socket.explicitVisionControllers.size, 0);
});

test('Node18 fallback aborts provider when independent actual capture status changes', async () => {
  const pending = deferred();
  const h = harness({ source: 'webcam', active: false, token: 'physical-1', signalFallback: true,
    describe: () => pending.promise });
  const work = h.run();
  const observationSignal = h.descriptions[0][2].signal;
  h.status({ sessionId: 'physical-2', active: true });
  assert.equal(observationSignal.aborted, true);
  pending.resolve('Old scene.');
  assert.match(await work, /VISION_SOURCE_RETIRED/);
});
