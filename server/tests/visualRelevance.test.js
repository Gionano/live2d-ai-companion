import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingVisionManager } from '../streamingVisionManager.js';
import { VISION_SIGNATURE_SIZES } from '../../src/visionSignature.js';

function harness(t, { filter = { action: 'COMMENT', relevant: true, text: 'Wah, keren!', emotion: 'kagum' }, complete } = {}) {
  let now = 1000;
  let sequence = 0;
  const requests = [];
  const events = [];
  const spoken = [];
  const history = [{ role: 'user', content: 'Aku lagi nonton Nagi no Asukara.' }];
  const registry = { getSlotStatus: () => ({ available: true }), getTts: () => ({ params: {} }),
    getLlm: role => ({ complete: async request => {
      requests.push({ role, request });
      if (role === 'vision') return { text: 'User in a bedroom.' };
      return complete ? complete(request) : { text: JSON.stringify(filter) };
    } }) };
  const manager = new StreamingVisionManager({ registry, startTimer: false, now: () => now });
  manager.setMonitorConnected(true);
  manager.setHistoryRef(history);
  manager.setBroadcaster(event => events.push(event));
  manager.setSpeechHandler((text, emotion, options) => {
    if (options.onAdmitted()) spoken.push({ text, emotion, options });
  });
  t.after(() => manager.dispose());
  const capture = async (source = 'webcam', changed = false) => {
    manager.setSourceStatus(source, true, source + '-1');
    const { width, height } = VISION_SIGNATURE_SIZES[source];
    await manager.handleContinuousFrame('data:image/png;base64,aGVsbG8=', { source, sessionId: source + '-1',
      sequence: ++sequence, signature: { version: 1, width, height, luma: new Array(width * height).fill(changed ? 200 : 50) } });
  };
  const tick = async () => { now += 30000; await capture(); await manager.runPeriodicFilter(); };
  return { manager, history, requests, events, spoken, capture, tick };
}

for (const relevant of [false, undefined]) {
  test('unrelated or unvalidated visual commentary never reaches history or speech: ' + relevant, async t => {
    const h = harness(t, { filter: { action: 'COMMENT', relevant, text: 'Kamarmu berantakan.', emotion: 'netral' } });
    await h.capture();
    await h.tick();
    assert.equal(h.spoken.length, 0);
    assert.equal(h.history.length, 1);
    assert.equal(h.events.some(event => event.type === 'vision'), false);
    const request = h.requests.find(item => item.role === 'visionFilter').request;
    assert.match(request.messages[1].content, /Nagi no Asukara/);
    assert.match(request.messages[0].content, /direct relevance/);
    assert.equal(h.requests.some(item => item.role === 'router'), false);
  });
}

test('a relevant or invited visual event uses existing speech admission once', async t => {
  const h = harness(t);
  h.history[0].content = 'Komentari yang menarik di kameraku.';
  await h.capture();
  await h.tick();
  assert.equal(h.spoken.length, 1);
  assert.equal(h.history.length, 2);
  assert.equal(h.manager.stats.totalCommentsSent, 1);
  h.spoken[0].options.onAdmitted();
  assert.equal(h.history.length, 2);
});

test('no topic or invitation skips without a filter request', async t => {
  const h = harness(t);
  h.history.length = 0;
  await h.capture();
  await h.tick();
  assert.equal(h.requests.filter(item => item.role === 'visionFilter').length, 0);
  assert.equal(h.spoken.length, 0);
});

test('user activity cancels commentary and discards an uncooperative late result', async t => {
  let resolve;
  const h = harness(t, { complete: request => new Promise(done => { resolve = done; }) });
  await h.capture();
  const work = h.manager.considerExternalCommentary({ text: 'Kamu terlihat senang.' });
  const signal = h.requests.at(-1).request.signal;
  h.manager.conversationActivity();
  assert.equal(signal.aborted, true);
  resolve({ text: '{"action":"COMMENT","relevant":true,"text":"Obsolete topic"}' });
  assert.equal(await work, false);
  assert.equal(h.history.length, 1);
  assert.equal(h.spoken.length, 0);
});

test('external proposals pass relevance before preserving admitted text and Fish metadata', async t => {
  const h = harness(t);
  await h.capture();
  const text = 'Kamu terlihat senang.';
  assert.equal(await h.manager.considerExternalCommentary({ text, source: 'webcam', speechEmotion: 'happy' }), true);
  assert.match(h.requests.at(-1).request.messages[1].content, /Proposed comment/);
  assert.equal(h.spoken[0].text, text);
  assert.equal(h.spoken[0].options.speechEmotion, 'happy');
  assert.equal(h.history.at(-1).content, text);
});

test('external commentary requires valid observations and relevance', async t => {
  const h = harness(t, { filter: { action: 'SKIP', reason: 'unrelated' } });
  assert.equal(await h.manager.considerExternalCommentary({ text: 'Nice room.' }), false);
  await h.capture();
  assert.equal(await h.manager.considerExternalCommentary({ text: 'Nice room.' }), false);
  assert.equal(h.history.length, 1);
  assert.equal(h.spoken.length, 0);
});

test('source retirement aborts an external relevance decision', async t => {
  let resolve;
  const h = harness(t, { complete: () => new Promise(done => { resolve = done; }) });
  await h.capture();
  const work = h.manager.considerExternalCommentary({ text: 'Interesting camera view.' });
  const signal = h.requests.at(-1).request.signal;
  h.manager.setSourceStatus('webcam', false);
  assert.equal(signal.aborted, true);
  resolve({ text: '{"action":"COMMENT","relevant":true,"text":"Old scene"}' });
  assert.equal(await work, false);
  assert.equal(h.spoken.length, 0);
});

test('declined speech admission leaves chat and history untouched', async t => {
  const h = harness(t);
  await h.capture();
  h.manager.setSpeechHandler(() => {});
  assert.equal(await h.manager.considerExternalCommentary({ text: 'Relevant observation.' }), false);
  assert.equal(h.history.length, 1);
  assert.equal(h.events.some(event => event.type === 'vision'), false);
});

test('routing observations exclude changed, stale and retired scenes', async t => {
  const h = harness(t);
  await h.capture();
  assert.equal(h.manager.getRoutingObservations().length, 1);
  h.manager.setSourceStatus('webcam', false);
  assert.deepEqual(h.manager.getRoutingObservations(), []);
});
