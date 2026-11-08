import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingVisionManager } from '../streamingVisionManager.js';
import { createVisionSignature, compareVisionSignatures, normalizeVisionSignature,
  VISION_SIGNATURE_SIZES } from '../../src/visionSignature.js';

const IMAGE = 'data:image/png;base64,aGVsbG8=';
function signature(source = 'screen', pixel = 50) {
  const { width, height } = VISION_SIGNATURE_SIZES[source];
  return { version: 1, width, height, luma: new Array(width * height).fill(pixel) };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function harness(t, { describe, filter = { action: 'SKIP', reason: 'Rutinitas' } } = {}) {
  const clock = { value: 1000 };
  const requests = [];
  const events = [];
  const speeches = [];
  const registry = { getSlotStatus: () => ({ available: true }), getTts: () => ({ params: {} }),
    getLlm: role => ({ complete: async request => {
      requests.push({ role, request });
      return role === 'visionFilter' ? { text: JSON.stringify(filter), inputTokens: 2, outputTokens: 3 }
        : describe ? describe(request) : { text: 'Sebuah jendela terbuka.', inputTokens: 10, outputTokens: 5 };
    } }) };
  const manager = new StreamingVisionManager({ registry, startTimer: false, now: () => clock.value });
  manager.setMonitorConnected(true);
  manager.setBroadcaster(event => events.push(event));
  manager.setHistoryRef([{ role: 'user', content: 'Comment on my screen.' }]);
  manager.setSpeechHandler((text, emotion, options) => { options.onAdmitted(); speeches.push({ text, emotion, options }); });
  t.after(() => manager.dispose());
  let sequence = 0;
  const send = (source = 'screen', sig = signature(source), extra = {}) => manager.handleContinuousFrame(IMAGE,
    { source, sessionId: source + '-1', sequence: ++sequence, signature: sig, ...extra });
  return { manager, clock, requests, events, speeches, send };
}

test('closed monitor rejects source activation and frames without running inference', async t => {
  const h = harness(t);
  h.manager.setMonitorConnected(false);
  assert.equal(h.manager.setSourceStatus('webcam', true, 'webcam-1'), false);
  assert.deepEqual(await h.send('webcam'), { accepted: false });
  assert.equal(h.requests.length, 0);
  h.manager.setMonitorConnected(true);
  h.manager.setSourceStatus('webcam', true, 'webcam-1');
  await h.send('webcam');
  assert.equal(h.requests.length, 1);
  assert.match(h.manager.getConversationContext(), /Kamera saat ini/);
  h.manager.setMonitorConnected(false);
  assert.equal(h.manager.getConversationContext(), null);
  assert.equal(h.manager.sources.webcam.active, false);
  assert.equal(h.manager.buffer.length, 0);
  await h.send('webcam');
  assert.equal(h.requests.length, 1);
});

test('monitor closure aborts pending inference and rejects results from before reopening', async t => {
  const old = deferred();
  let calls = 0;
  const h = harness(t, { describe: () => ++calls === 1 ? old.promise : { text: 'New camera scene.' } });
  h.manager.setSourceStatus('webcam', true, 'webcam-1');
  const pending = h.send('webcam');
  const signal = h.requests[0].request.signal;
  h.manager.setMonitorConnected(false);
  assert.equal(signal.aborted, true);
  h.manager.setMonitorConnected(true);
  h.manager.setSourceStatus('webcam', true, 'webcam-2');
  old.resolve({ text: 'Obsolete camera scene.' });
  await pending;
  assert.equal(h.manager.getConversationContext(), null);
  await h.send('webcam', signature('webcam'), { sessionId: 'webcam-2' });
  assert.match(h.manager.getConversationContext(), /New camera scene/);
  assert.doesNotMatch(JSON.stringify(h.events), /Obsolete camera scene/);
});

test('request timing separates first response, total inference and capture freshness', async t => {
  const pending = deferred();
  const h = harness(t, { describe: request => {
    request.onProgress('first_byte');
    return pending.promise;
  } });
  h.manager.setSourceStatus('webcam', true, 'webcam-1');
  const work = h.send('webcam');
  h.clock.value += 20886;
  assert.equal(h.manager.getSourceSnapshot().webcam.inFlightAgeMs, 20886);
  assert.equal(h.manager.getConversationContext(), null);
  pending.resolve({ text: 'Camera image.' });
  await work;
  const source = h.manager.getSourceSnapshot().webcam;
  assert.equal(source.inFlightAgeMs, null);
  assert.equal(typeof source.lastFirstResponseMs, 'number');
  assert.ok(source.lastFirstResponseMs <= source.lastLatencyMs);
});

test('signatures preserve source dimensions and reject malformed luma', () => {
  for (const source of ['screen', 'webcam']) {
    const { width, height } = VISION_SIGNATURE_SIZES[source];
    const rgba = new Uint8ClampedArray(width * height * 4).fill(100);
    const result = createVisionSignature(rgba, width, height);
    assert.deepEqual(result, signature(source, 100));
    assert.ok(normalizeVisionSignature(result));
  }
  assert.equal(normalizeVisionSignature({ ...signature(), luma: [50] }), null);
  assert.equal(normalizeVisionSignature({ ...signature(), luma: new Array(128 * 72).fill(NaN) }), null);
  assert.throws(() => createVisionSignature(new Uint8Array(16), 2, 2), TypeError);
});

test('screen tiles detect small UI changes while webcam tolerates uniform exposure and sensor noise', () => {
  const before = signature();
  const after = signature();
  for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) after.luma[y * 128 + x] = 80;
  const change = compareVisionSignatures(before, after, 'screen');
  assert.ok(change.globalScore < 3);
  assert.equal(change.changed, true);
  assert.equal(compareVisionSignatures(signature('webcam', 50), signature('webcam', 70), 'webcam').changed, false);
  assert.equal(compareVisionSignatures(signature('webcam', 50), signature('webcam', 0), 'webcam').changed, true);
  const moving = signature('webcam');
  for (let index = 0; index < moving.luma.length / 2; index++) moving.luma[index] = 90;
  assert.equal(compareVisionSignatures(signature('webcam'), moving, 'webcam').changed, true);
});

test('first monitored capture infers; actual unchanged captures validate cached perception', async t => {
  const h = harness(t);
  h.manager.setSourceStatus('screen', true, 'screen-1');
  await h.send();
  assert.equal(h.requests.length, 1);
  assert.equal(h.manager.monitorConnected, true);
  assert.match(h.manager.getConversationContext(), /Layar saat ini/);
  h.clock.value += 6000;
  assert.equal(h.manager.getConversationContext(), null);
  await h.send();
  assert.equal(h.requests.length, 1);
  assert.match(h.manager.getConversationContext(), /Layar saat ini/);
  assert.equal(h.manager.getSourceSnapshot().screen.unchanged, 1);
  h.clock.value += 5001;
  assert.equal(h.manager.getConversationContext(), null);
  assert.equal(h.manager.getSourceSnapshot().screen.freshness, 'expired');
});

test('gradual drift compares against accepted inference frame and source throttle retains latest capture', async t => {
  const h = harness(t);
  h.manager.setSourceStatus('screen', true, 'screen-1');
  await h.send();
  h.clock.value += 500;
  await h.send('screen', signature('screen', 51));
  await h.send('screen', signature('screen', 52));
  assert.equal(h.requests.length, 1);
  await h.send('screen', signature('screen', 53));
  assert.equal(h.manager.getSourceSnapshot().screen.pending, true);
  assert.match(h.manager.getConversationContext(), /baru saja, bukan kondisi saat ini/);
  h.clock.value += 1500;
  await h.manager.sources.screen.pump();
  assert.equal(h.requests.length, 2);
  assert.equal(h.manager.sources.screen.accepted.signature.luma[0], 53);
  assert.match(h.manager.getConversationContext(), /saat ini/);
});

test('one in-flight inference keeps only latest pending frame and never presents its old result as current', async t => {
  const first = deferred();
  let calls = 0;
  const h = harness(t, { describe: () => ++calls === 1 ? first.promise : { text: 'Layar terbaru.' } });
  h.manager.setSourceStatus('screen', true, 'screen-1');
  const work = h.send();
  h.clock.value += 500;
  await h.send('screen', signature('screen', 80));
  await h.send('screen', signature('screen', 100));
  assert.equal(calls, 1);
  assert.equal(h.manager.sources.screen.pending.signature.luma[0], 100);
  assert.equal(h.manager.getSourceSnapshot().screen.superseded, 1);
  first.resolve({ text: 'Layar lama.' });
  await work;
  assert.match(h.manager.getConversationContext(), /baru saja, bukan kondisi saat ini/);
  h.clock.value += 1500;
  await h.manager.sources.screen.pump();
  assert.equal(calls, 2);
  assert.match(h.manager.getConversationContext(), /Layar saat ini.*Layar terbaru/);
});

test('stop aborts pending provider work and late results cannot cross capture sessions', async t => {
  const wait = deferred();
  const h = harness(t, { describe: () => wait.promise });
  h.manager.setSourceStatus('screen', true, 'screen-1');
  const work = h.send();
  const signal = h.requests[0].request.signal;
  h.manager.setSourceStatus('screen', false, 'screen-1');
  assert.equal(signal.aborted, true);
  h.manager.setSourceStatus('screen', true, 'screen-2');
  wait.resolve({ text: 'Do not publish this retired scene.' });
  await work;
  assert.equal(h.manager.getConversationContext(), null);
  assert.equal(h.manager.buffer.length, 0);
  assert.equal(h.events.filter(event => event.type === 'vision_entry').length, 0);
  await h.send('screen', signature(), { sessionId: 'screen-1' });
  assert.equal(h.requests.length, 1);
});

test('duplicate sequences, expired captures and invalid signatures cannot validate perception', async t => {
  const h = harness(t);
  h.manager.setSourceStatus('screen', true, 'screen-1');
  await h.send();
  await h.send('screen', signature(), { sequence: 1 });
  await h.send('screen', signature(), { captureAgeMs: 5001 });
  await h.send('screen', null);
  await h.send('screen', signature('webcam'));
  await h.send('screen', signature(), { captureAgeMs: 100 });
  assert.equal(h.requests.length, 1);
  assert.equal(h.manager.getSourceSnapshot().screen.captured, 1);
  assert.equal(h.manager.getSourceSnapshot().screen.rejected, 5);
});

test('old stop messages do not retire a replacement capture session', async t => {
  const h = harness(t);
  h.manager.setSourceStatus('screen', true, 'screen-1');
  h.manager.setSourceStatus('screen', true, 'screen-2');
  assert.equal(h.manager.setSourceStatus('screen', false, 'screen-1'), false);
  assert.equal(h.manager.sources.screen.active, true);
  assert.equal(h.manager.sources.screen.sessionId, 'screen-2');
});

test('unknown and prototype-named sources cannot escape their manager', async t => {
  const h = harness(t);
  for (const source of ['other', '__proto__', 'constructor']) {
    assert.equal(h.manager.setSourceStatus(source, true, 'unknown-1'), false);
    assert.deepEqual(await h.manager.handleContinuousFrame(IMAGE, { source, sessionId: 'unknown-1',
      sequence: 1, signature: signature() }), { accepted: false });
  }
  assert.equal(h.requests.length, 0);
});

test('cancelled queued requests and stale commentary windows do not trigger providers', async t => {
  const h = harness(t);
  h.manager.setSourceStatus('screen', true, 'screen-1');
  await h.send();
  const controller = new AbortController();
  h.clock.value += 500;
  await h.send('screen', signature('screen', 90), { signal: controller.signal });
  controller.abort();
  h.clock.value += 1500;
  await h.manager.sources.screen.pump();
  assert.equal(h.requests.length, 1);
  h.clock.value += 30000;
  await h.send();
  await h.manager.runPeriodicFilter();
  assert.equal(h.requests.filter(item => item.role === 'visionFilter').length, 0);
});

test('prompt refresh requires fresh capture and forces re-description of an unchanged frame', async t => {
  const h = harness(t);
  h.manager.setSourceStatus('screen', true, 'screen-1');
  await h.send();
  h.manager.setAssistantContext('Apa yang sedang kamu mainkan?');
  assert.equal(h.requests.length, 1);
  h.clock.value += 2000;
  await h.send();
  assert.equal(h.requests.length, 2);
  assert.match(h.requests[1].request.messages[0].content[1].text, /Apa yang sedang kamu mainkan/);
});

test('screen and webcam freshness, pending work and stop state are independent', async t => {
  const h = harness(t);
  h.manager.setSourceStatus('screen', true, 'screen-1');
  h.manager.setSourceStatus('webcam', true, 'webcam-1');
  await h.send();
  await h.send('webcam');
  assert.equal(h.requests.length, 2);
  assert.match(h.manager.getConversationContext(), /Layar saat ini[\s\S]*Kamera saat ini/);
  h.manager.setSourceStatus('screen', false, 'screen-1');
  assert.doesNotMatch(h.manager.getConversationContext(), /Layar/);
  assert.match(h.manager.getConversationContext(), /Kamera/);
});

test('commentary consumes source-bound windows without clearing conversation cache', async t => {
  const h = harness(t, { filter: { action: 'COMMENT', relevant: true, text: 'Wah, bagus!', emotion: 'kagum' } });
  h.manager.setSourceStatus('screen', true, 'screen-1');
  h.manager.setSourceStatus('webcam', true, 'webcam-1');
  await h.send();
  await h.send('webcam');
  h.clock.value += 30000;
  await h.send();
  await h.send('webcam');
  await h.manager.runPeriodicFilter();
  const filters = h.requests.filter(item => item.role === 'visionFilter');
  assert.equal(filters.length, 2);
  assert.match(filters[0].request.messages[1].content, /Layar/);
  assert.doesNotMatch(filters[0].request.messages[1].content, /Kamera/);
  assert.match(filters[1].request.messages[1].content, /Kamera/);
  assert.equal(h.manager.buffer.length, 0);
  assert.match(h.manager.getConversationContext(), /Layar saat ini/);
  assert.deepEqual(h.speeches.map(item => [item.options.source, item.options.origin]),
    [['screen', 'vision'], ['webcam', 'vision']]);
});

test('source stop fences a delayed commentary filter and dispose releases all timers', async t => {
  const h = harness(t);
  h.manager.setSourceStatus('screen', true, 'screen-1');
  await h.send();
  h.clock.value += 30000;
  await h.send();
  const wait = deferred();
  h.manager.evaluateFilter = () => wait.promise;
  const filtering = h.manager.runPeriodicFilter();
  const signal = h.manager.sources.screen.filterController.signal;
  h.manager.setSourceStatus('screen', false, 'screen-1');
  wait.resolve({ action: 'COMMENT', text: 'Old scene', emotion: 'netral' });
  await filtering;
  assert.equal(signal.aborted, true);
  assert.equal(h.speeches.length, 0);
  h.manager.initPeriodicFilter();
  h.manager.dispose();
  assert.equal(h.manager.filterTimer, null);
  assert.equal(h.manager.sources.screen.timer, null);
  assert.equal(h.manager.getConversationContext(), null);
});

test('provider failure cannot relabel an old changed scene as current or leak provider error details', async t => {
  let calls = 0;
  const h = harness(t, { describe: () => {
    if (++calls === 1) return { text: 'Jendela sebelumnya.' };
    throw new Error('private-provider-diagnostic');
  } });
  h.manager.setSourceStatus('screen', true, 'screen-1');
  await h.send();
  h.clock.value += 2000;
  await h.send('screen', signature('screen', 90));
  assert.match(h.manager.getConversationContext(), /baru saja, bukan kondisi saat ini/);
  assert.equal(h.manager.getSourceSnapshot().screen.errors, 1);
  assert.doesNotMatch(JSON.stringify(h.events), /private-provider-diagnostic/);
  h.clock.value += 5001;
  assert.equal(h.manager.getConversationContext(), null);
});

test('separate managers cannot share descriptions or source cancellation', async t => {
  const first = harness(t, { describe: () => ({ text: 'First conversation scene.' }) });
  const second = harness(t, { describe: () => ({ text: 'Second conversation scene.' }) });
  first.manager.setSourceStatus('screen', true, 'screen-1');
  second.manager.setSourceStatus('screen', true, 'screen-1');
  await first.send();
  await second.send();
  assert.doesNotMatch(first.manager.getConversationContext(), /Second/);
  assert.doesNotMatch(second.manager.getConversationContext(), /First/);
  first.manager.dispose();
  assert.match(second.manager.getConversationContext(), /Second/);
  assert.equal(second.manager.getSourceSnapshot().screen.active, true);
});

test('old interval settings cannot bypass the two-second inference floor and broadcasts include source state', async t => {
  const h = harness(t);
  h.manager.setSourceStatus('screen', true, 'screen-1');
  await h.send();
  h.manager.updateSettings({ minInferenceIntervalMs: 1000 });
  assert.equal(h.manager.settings.minInferenceIntervalMs, 2000);
  const configured = h.events.findLast(event => event.type === 'config_updated');
  assert.equal(configured.sources.screen.active, true);
  h.clock.value += 1000;
  await h.send('screen', signature('screen', 90));
  assert.equal(h.requests.length, 1);
  h.clock.value += 1000;
  await h.manager.sources.screen.pump();
  assert.equal(h.requests.length, 2);
  h.manager.resetStats();
  const reset = h.events.findLast(event => event.type === 'stats_update');
  assert.equal(reset.sources.screen.captured, 0);
  assert.equal(reset.sources.screen.active, true);
  const lowSetting = new StreamingVisionManager({ registry: h.manager.registry, startTimer: false,
    settings: { minInferenceIntervalMs: 1 } });
  t.after(() => lowSetting.dispose());
  assert.equal(lowSetting.settings.minInferenceIntervalMs, 2000);
});

test('saved freshness settings cannot keep a source current beyond five seconds', async t => {
  const h = harness(t);
  h.manager.updateSettings({ freshnessMs: 15000 });
  assert.equal(h.manager.settings.freshnessMs, 5000);
  h.manager.setSourceStatus('screen', true, 'screen-1');
  await h.send();
  h.clock.value += 5001;
  assert.equal(h.manager.getConversationContext(), null);
  const restored = new StreamingVisionManager({ registry: h.manager.registry, startTimer: false,
    settings: { freshnessMs: 15000 } });
  t.after(() => restored.dispose());
  assert.equal(restored.settings.freshnessMs, 5000);
});

test('actual unchanged captures still validate freshness when the inference provider is unavailable', async t => {
  const h = harness(t);
  h.manager.setSourceStatus('screen', true, 'screen-1');
  await h.send();
  h.manager.registry.getSlotStatus = () => ({ available: false });
  h.clock.value += 4000;
  await h.send();
  h.clock.value += 4000;
  assert.match(h.manager.getConversationContext(), /Layar saat ini/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.manager.getSourceSnapshot().screen.captured, 2);
  h.clock.value += 1001;
  assert.equal(h.manager.getConversationContext(), null);
});
