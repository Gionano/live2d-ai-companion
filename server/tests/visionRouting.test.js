import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationVisionRouter, inspectVisualRequest, routingSources } from '../visionRouting.js';
import { detectVisionIntent, resolveVisionSource } from '../visionCapture.js';

function harness(t, { decision = { target: 'conversation' }, complete, ready = true, deadlineMs } = {}) {
  const requests = [];
  const statuses = [];
  const registry = { getSlotStatus: () => ({ available: ready }), getLlm: role => ({ complete: request => {
    assert.equal(role, 'router');
    requests.push(request);
    return complete ? complete(request) : Promise.resolve({ text: JSON.stringify(decision) });
  } }) };
  const router = new ConversationVisionRouter({ registry, onStatus: status => statuses.push(status), deadlineMs });
  t.after(() => router.dispose());
  return { router, requests, statuses };
}

for (const text of ['Tapi ini kan genre love polygon', 'aku lagi nonton anime ini', 'ini',
  'kamera bagus untuk merekam', 'Kamu pernah lihat anime ini?', 'Aku sudah lihat layar itu.',
  'Jangan lihat kamera', 'Tidak perlu cek layar', 'Do not inspect the webcam',
  'Jangan bandingkan kamera dengan layar', 'Do not compare webcam and screen', 'Aku nggak lihat layar',
  'Dia bilang "lihat layar aku"', 'Dia bilang “lihat kamera”']) {
  test('ordinary, historical, quoted or negated request bypasses model: ' + text, async t => {
    const h = harness(t);
    assert.equal((await h.router.route(text)).target, 'conversation');
    assert.equal(h.requests.length, 0);
    assert.equal(detectVisionIntent(text), false);
  });
}

for (const [text, target] of [['Lihat error ini di layar', 'screen'], ['Coba lihat kameraku di webcam', 'webcam'], ['Lihat kameraku', 'webcam'],
  ['Yang aku pegang ini apa?', 'webcam'], ['Bandingkan yang di kamera dengan layar', 'both'],
  ['Jangan lihat kamera, tapi lihat layar', 'screen']]) {
  test('positive source-specific inspection uses rules: ' + text, async t => {
    const h = harness(t);
    const decision = await h.router.route(text, { availability: { screen: false, webcam: false } });
    assert.equal(decision.target, target);
    assert.deepEqual(decision.sources, routingSources(target));
    assert.equal(h.requests.length, 0);
  });
}

test('character question consults recent conversation without asking for vision', async t => {
  const h = harness(t);
  const decision = await h.router.route('Kenapa Manaka ini suka Tsumugu?', { history: [
    { role: 'user', content: 'Aku lagi nonton Nagi no Asukara.' },
    { role: 'assistant', content: 'Kamu suka Hikari?' },
  ], availability: { webcam: true }, observations: [{ source: 'webcam', description: 'User in bedroom.' }] });
  assert.equal(decision.target, 'conversation');
  assert.equal(h.requests.length, 1);
  const context = JSON.parse(h.requests[0].messages[1].content);
  assert.match(context.history[0].content, /Nagi no Asukara/);
  assert.deepEqual(context.observations, [{ source: 'webcam', description: 'User in bedroom.' }]);
  assert.doesNotMatch(JSON.stringify(h.statuses), /Manaka|Nagi|bedroom/);
});

test('contextual look request selects screen using one private model completion', async t => {
  const h = harness(t, { decision: { target: 'screen', question: 'What does the screen error mean?' } });
  const decision = await h.router.route('Lihat ini', { history: [{ role: 'user', content: 'Ada error di layar.' }],
    availability: { screen: true, webcam: true } });
  assert.equal(decision.target, 'screen');
  assert.equal(decision.question, 'What does the screen error mean?');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].json, true);
  assert.equal(h.requests[0].timeouts.totalMs, 5000);
  assert.ok(Object.isFrozen(decision));
});

for (const [availability, target] of [[{ screen: true, webcam: true }, 'both'], [{ screen: true }, 'screen'],
  [{ webcam: true }, 'webcam'], [{}, 'both']]) {
  test('unavailable router resolves genuine inspection automatically: ' + target + JSON.stringify(availability), async t => {
    const h = harness(t, { ready: false });
    assert.equal((await h.router.route('Coba lihat ini', { availability })).target, target);
    assert.equal(h.requests.length, 0);
  });
}

for (const text of ['ini apa?', 'gimana ini?']) {
  test('ambiguous wording does not become camera intent when model is unavailable: ' + text, async t => {
    const h = harness(t, { ready: false });
    assert.equal((await h.router.route(text, { availability: { webcam: true } })).target, 'conversation');
  });
}

for (const raw of ['not json', '{"target":"clarify"}', '{"target":"screen","reasoning":"private"}',
  '{"target":"screen","question":123}']) {
  test('invalid private output uses automatic fallback: ' + raw, async t => {
    const h = harness(t, { complete: async () => ({ text: raw }) });
    assert.equal((await h.router.route('Lihat ini', { availability: { screen: true } })).target, 'screen');
    assert.equal(h.statuses.at(-1).reason, 'invalid_decision');
    assert.equal(h.requests.length, 1);
  });
}

for (const code of ['AUTH', 'RATE_LIMIT', 'SERVER']) {
  test('provider failure is bounded and diagnostics omit exception content: ' + code, async t => {
    const h = harness(t, { complete: async () => { throw Object.assign(new Error('fixture-private-secret'), { code }); } });
    assert.equal((await h.router.route('Lihat ini', { availability: { webcam: true } })).target, 'webcam');
    assert.doesNotMatch(JSON.stringify(h.statuses), /fixture-private-secret/);
    assert.equal(h.requests.length, 1);
  });
}

test('deadline rejects an uncooperative provider and accepts no late output', async t => {
  let resolve;
  const h = harness(t, { deadlineMs: 5, complete: () => new Promise(done => { resolve = done; }) });
  const result = await h.router.route('Lihat ini', { availability: { screen: true } });
  assert.equal(result.target, 'screen');
  assert.equal(h.requests[0].signal.aborted, true);
  resolve({ text: '{"target":"webcam"}' });
  await Promise.resolve();
  assert.equal(h.statuses.at(-1).reason, 'timeout');
});

test('user cancellation and disconnect reject late model decisions', async t => {
  for (const disconnect of [false, true]) {
    const h = harness(t, { complete: () => new Promise(() => {}) });
    const controller = new AbortController();
    const task = h.router.route('Lihat ini', { signal: controller.signal });
    if (disconnect) h.router.dispose(); else controller.abort();
    await assert.rejects(task, { name: 'AbortError' });
    assert.equal(h.requests[0].signal.aborted, true);
    assert.equal(h.statuses.some(status => status.status === 'done'), false);
  }
});

test('visual focus is isolated, source-bound, and cleared by a new topic', async t => {
  const h = harness(t, { ready: false });
  const other = harness(t, { ready: false });
  const captureSessions = { screen: { active: true, sessionId: 'screen-1' }, webcam: { active: true, sessionId: 'camera-1' } };
  const availability = { screen: true, webcam: true };
  h.router.remember(['screen'], captureSessions);
  assert.equal((await h.router.route('Lihat ini', { captureSessions, availability })).target, 'screen');
  assert.equal((await other.router.route('Lihat ini', { captureSessions, availability })).target, 'both');
  await h.router.route('Aku lagi nonton anime.', { captureSessions });
  assert.equal((await h.router.route('Lihat ini', { captureSessions, availability })).target, 'both');
  h.router.remember(['webcam'], captureSessions);
  h.router.retireSource('webcam');
  assert.equal((await h.router.route('Lihat ini', { captureSessions, availability })).target, 'both');
});

test('source change during routing fences the old decision', async t => {
  let resolve;
  const h = harness(t, { complete: () => new Promise(done => { resolve = done; }) });
  const work = h.router.route('Lihat ini', { availability: { screen: true } });
  h.router.retireSource('webcam');
  resolve({ text: '{"target":"webcam"}' });
  assert.equal((await work).target, 'screen');
  assert.equal(h.statuses.at(-1).reason, 'source_changed');
});

test('legacy helpers never default ordinary ini to webcam', () => {
  assert.equal(detectVisionIntent('Manaka ini suka Tsumugu'), false);
  assert.equal(resolveVisionSource('Manaka ini suka Tsumugu', { hasCamera: true }).source, null);
  assert.equal(resolveVisionSource('lihat ini', { hasCamera: true, hasScreen: true }).source, 'both');
  assert.equal(inspectVisualRequest('layar').genuine, false);
});
