import test from 'node:test';
import assert from 'node:assert/strict';
import { generateConversationReply } from '../conversationCoordinator.js';

const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events; };
const segment = (text, register = 'casual', emotion = 'netral', speechEmotion = 'calm') =>
  ({ register, emotion, speechEmotion, text });
const surface = (mode, text) => JSON.stringify({ status: 'ok', mode, segments: text ? [segment(text)] : [] });
const deep = (text, extra = {}) => JSON.stringify({ segments: [segment(text, 'intimate', 'sayang', 'compassionate')], ...extra });

function fakeRegistry(responses, params = {}) {
  const requests = [];
  const registry = {
    requests,
    getSlotStatus: slot => ({ available: slot !== 'surface' || responses.surface !== null }),
    getTts: () => ({ params }),
    getLlm: role => ({ async *stream(request) {
      requests.push({ role, ...request });
      const response = responses[role];
      if (response instanceof Error) throw response;
      if (typeof response === 'function') { yield* response(request); return; }
      for (const delta of Array.isArray(response) ? response : [response]) yield { type: 'text', delta };
    } }),
  };
  return registry;
}

const done = events => events.find(event => event.type === 'conversation_done');
const sentences = events => events.filter(event => event.type === 'sentence');
const parts = events => events.filter(event => event.type === 'reply_part');

test('a reflexive surface reply is one stage and does not consume private guidance', async () => {
  const registry = fakeRegistry({ surface: surface('say', 'Hei, muncul juga.'), llm: new Error('Must not call deep') });
  let consumed = 0;
  const events = await collect(generateConversationReply([], 'halo', null,
    { registry, partIdPrefix: 'turn1:', guidance: () => { consumed++; return {}; } }));
  assert.deepEqual(registry.requests.map(request => request.role), ['surface']);
  assert.equal(consumed, 0);
  assert.equal(done(events).text, 'Hei, muncul juga.');
  assert.equal(events.filter(event => event.type === 'conversation_done').length, 1);
  assert.deepEqual(parts(events).filter(event => event.status === 'done').map(event => event.partId), ['turn1:surface']);
  assert.equal(sentences(events)[0].pauseBeforeMs, 0);
  assert.equal(sentences(events)[0].pauseAfterMs, 200);
});

test('a thoughtful answer continues the actual surface text in a separate part', async () => {
  const history = [{ role: 'user', content: 'Aku kerja sejak pagi.' }];
  const registry = fakeRegistry({ surface: surface('say+think', 'Aku tahu kamu capek.'),
    llm: deep('Istirahat sebentar dulu. Pekerjaan itu bisa menunggu.') });
  const events = await collect(generateConversationReply(history, 'aku lelah', 'Layar: editor terbuka.', {
    registry, partIdPrefix: 'turn2:', guidance: () => ({ hint: 'Lower the pressure.', plan: ['Acknowledge tiredness.', 'Allow a break.'] }),
  }));
  assert.deepEqual(registry.requests.map(request => request.role), ['surface', 'llm']);
  const request = registry.requests[1];
  assert.match(request.messages[0].content, /Aku tahu kamu capek/);
  assert.match(request.messages[0].content, /Lower the pressure/);
  assert.equal(request.messages.filter(message => message.role === 'user').at(-1).content, 'aku lelah');
  assert.equal(history.length, 1, 'The coordinator never writes user or assistant history itself');
  assert.equal(done(events).text, 'Aku tahu kamu capek. Istirahat sebentar dulu. Pekerjaan itu bisa menunggu.');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), done(events).text);
  assert.deepEqual(parts(events).filter(event => event.status === 'done').map(event => event.partId), ['turn2:surface', 'turn2:deep']);
  assert.deepEqual(sentences(events).map(event => event.register), ['casual', 'intimate', 'intimate']);
  assert.equal(new Set(sentences(events).map(event => event.segmentId)).size, 2);
  assert.ok(sentences(events).every(event => Object.isFrozen(event) && event.pauseAfterMs === 200));
  assert.ok(sentences(events).every(event => event.pauseBeforeMs === 0));
});

for (const [reaction, repeated, continuation] of [
  ['Halo, sayang.', 'Halo juga, sayang.', 'Kamu sudah pulang?'],
  ['Ya gitu doang?', 'Ya gitu doang?', 'Hari ini ngapain aja?'],
  ['Ya ampun, ditanya balik lagi deh.', 'Ya ampun, ditanya balik lagi deh.', 'Kamu tuh ya, aku jadi bingung.'],
]) {
  test(`repeated opening '${reaction}' is removed from both deep speech and bubbles`, async () => {
    const registry = fakeRegistry({ surface: surface('say+think', reaction), llm: deep(`${repeated} ${continuation}`) });
    const events = await collect(generateConversationReply([], 'ngapain yaa', null, { registry }));
    assert.deepEqual(parts(events).filter(event => event.status === 'done').map(event => event.text), [reaction, continuation]);
    assert.deepEqual(sentences(events).map(event => event.text), [reaction, continuation]);
    assert.equal(done(events).text, `${reaction} ${continuation}`);
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), done(events).text);
    assert.deepEqual(registry.requests[1].messages.map(message => message.role), ['system', 'user']);
    assert.equal(registry.requests[1].messages.at(-1).content, 'ngapain yaa');
  });
}

test('every split of a repeated deep opening preserves the streamed continuation and tone', async () => {
  const reaction = 'Ya ampun, ditanya balik lagi deh.';
  const payload = JSON.stringify({ segments: [segment(`${reaction} Aku tetap dengerin kamu.`, 'serious', 'netral', 'calm')] });
  for (let offset = 0; offset <= payload.length; offset++) {
    const registry = fakeRegistry({ surface: surface('say+think', reaction), llm: [payload.slice(0, offset), payload.slice(offset)] });
    const events = await collect(generateConversationReply([], 'ngapain', null, { registry }));
    const continuation = sentences(events).filter(event => event.stage === 'deep');
    assert.equal(continuation.length, 1);
    assert.equal(continuation[0].text, 'Aku tetap dengerin kamu.');
    assert.equal(continuation[0].emotion, 'netral');
    assert.equal(continuation[0].register, 'serious');
    assert.equal(continuation[0].speechEmotion, 'calm');
    assert.ok(Object.isFrozen(continuation[0]));
    assert.equal(done(events).text, `${reaction} Aku tetap dengerin kamu.`);
  }
});

test('an entirely repeated deeper output finishes with the already-delivered surface only', async () => {
  const registry = fakeRegistry({ surface: surface('say+think', 'Aku dengar.'), llm: deep('AKU DENGAR! Aku dengar.') });
  const events = await collect(generateConversationReply([], 'oke', null, { registry }));
  assert.equal(done(events).text, 'Aku dengar.');
  assert.deepEqual(sentences(events).map(event => event.text), ['Aku dengar.']);
  assert.deepEqual(parts(events).filter(event => event.status === 'done').map(event => event.stage), ['surface']);
  assert.equal(events.some(event => event.type === 'stage_error'), false);
  assert.deepEqual(registry.requests.map(request => request.role), ['surface', 'llm']);
});

test('removed greeting tags do not replace the retained segment tone or hide later intentional repetition', async () => {
  const registry = fakeRegistry({ surface: surface('say+think', 'Halo, sayang.'), llm: JSON.stringify({ segments: [
    segment('[sigh] Halo juga, sayang.', 'whisper', 'sedih', 'sad'),
    segment('[laughs] Aku mau cerita dulu. Halo, sayang.', 'casual', 'jahil', 'happy'),
  ] }) }, { expression: { selection: 'native' }, inlineTags: { enabled: true, allowList: ['sigh', 'laughs'], maxPerSentence: 2 } });
  const events = await collect(generateConversationReply([], 'halo', null, { registry }));
  const speech = sentences(events).filter(event => event.stage === 'deep');
  assert.equal(speech.length, 2);
  assert.match(speech[0].text, /\[laughs\] Aku mau cerita dulu\./);
  assert.doesNotMatch(speech[0].text, /sigh|Halo/);
  assert.equal(speech[0].emotion, 'jahil');
  assert.equal(speech[0].speechEmotion, 'happy');
  assert.equal(speech[0].register, 'casual');
  assert.equal(speech[1].text, 'Halo, sayang.');
  assert.equal(done(events).text, 'Halo, sayang. Aku mau cerita dulu. Halo, sayang.');
});

test('opening removal precedes optional zero-pause short-sentence merging', async () => {
  const registry = fakeRegistry({ surface: surface('say+think', 'Aku dengar.'), llm: deep('Aku dengar. Coba ceritakan. Aku siap.') },
    { expression: { sentencePauseMs: 0, earlyFirstSentence: true } });
  const events = await collect(generateConversationReply([], 'cerita', null, { registry }));
  const speech = sentences(events).filter(event => event.stage === 'deep');
  assert.equal(speech[0].text, 'Coba ceritakan.');
  assert.equal(speech.map(event => event.text).join(' '), 'Coba ceritakan. Aku siap.');
  assert.equal(done(events).text, 'Aku dengar. Coba ceritakan. Aku siap.');
});

test('think mode can omit a filler and go directly to the substantive stage', async () => {
  const registry = fakeRegistry({ surface: surface('think', ''), llm: deep('Aku lebih suka yang ini.') });
  const events = await collect(generateConversationReply([], 'kamu pilih mana?', null, { registry }));
  assert.deepEqual(parts(events).filter(event => event.status === 'start').map(event => event.stage), ['deep']);
  assert.equal(done(events).text, 'Aku lebih suka yang ini.');
});

for (const status of ['unfinished', 'not-for-me']) {
  test(`an empty ${status} surface decision stays silent without calling deep`, async () => {
    const registry = fakeRegistry({ surface: JSON.stringify({ status, mode: 'say', segments: [] }),
      llm: new Error('Must not call deep') });
    let consumed = 0;
    const events = await collect(generateConversationReply([], 'hmm', null,
      { registry, guidance: () => { consumed++; return {}; } }));
    assert.deepEqual(registry.requests.map(request => request.role), ['surface']);
    assert.equal(consumed, 0);
    assert.equal(done(events).text, '');
    assert.equal(done(events).silent, true);
    assert.equal(parts(events).length, 0);
    assert.equal(sentences(events).length, 0);
  });
}

test('an empty successful surface decision falls through to one deeper reply', async () => {
  const registry = fakeRegistry({ surface: surface('say', ''), llm: deep('Aku dengar ceritamu.') });
  const events = await collect(generateConversationReply([], 'hmm', null, { registry }));
  assert.deepEqual(registry.requests.map(request => request.role), ['surface', 'llm']);
  assert.equal(done(events).text, 'Aku dengar ceritamu.');
  assert.equal(done(events).silent, undefined);
  assert.deepEqual(parts(events).filter(event => event.status === 'done').map(event => event.stage), ['deep']);
});

test('surface has at most one spoken sentence even when the model overproduces', async () => {
  const registry = fakeRegistry({ surface: surface('say+think', 'Oh, begitu. Aku sudah punya semua jawabannya.'),
    llm: deep('Ceritanya masuk akal setelah kamu jelaskan.') });
  const events = await collect(generateConversationReply([], 'ceritaku tadi', null, { registry }));
  assert.equal(sentences(events).filter(event => event.stage === 'surface').length, 1);
  assert.equal(parts(events).find(event => event.stage === 'surface' && event.status === 'done').text, 'Oh, begitu.');
  assert.doesNotMatch(done(events).text, /semua jawabannya/);
  assert.match(registry.requests[1].messages[0].content, /surfaceReply.*Oh, begitu/);
});

test('legacy zero-pause merging cannot turn a surface reaction into multiple spoken sentences', async () => {
  const registry = fakeRegistry({ surface: surface('say+think', 'Oh, begitu. Aku sudah punya semua jawabannya.'),
    llm: deep('Ceritanya masuk akal setelah kamu jelaskan.') }, { expression: {
    sentencePauseMs: 0, earlyFirstSentence: false, mergeShortSentences: { enabled: true, minChars: 100, maxChars: 180 },
  } });
  const events = await collect(generateConversationReply([], 'ceritaku tadi', null, { registry }));
  assert.deepEqual(sentences(events).filter(event => event.stage === 'surface').map(event => event.text), ['Oh, begitu.']);
  assert.equal(parts(events).find(event => event.stage === 'surface' && event.status === 'done').text, 'Oh, begitu.');
  assert.doesNotMatch(done(events).text, /semua jawabannya/);
});

test('a surface stream failure retains its spoken sentence as the deeper continuation context', async () => {
  const registry = fakeRegistry({ surface: async function* () {
    yield { type: 'text', delta: '{"status":"ok","mode":"say+think","segments":[{"emotion":"sayang","text":"Aku dengar. ' };
    throw new Error('Surface disconnected');
  }, llm: deep('Kita bahas bagian yang paling bikin kamu capek.') });
  const events = await collect(generateConversationReply([], 'aku lelah', null, { registry }));
  assert.deepEqual(registry.requests.map(request => request.role), ['surface', 'llm']);
  assert.equal(sentences(events).filter(event => event.stage === 'surface').length, 1);
  assert.equal(parts(events).find(event => event.stage === 'surface' && event.status === 'done').partial, true);
  assert.match(registry.requests[1].messages[0].content, /surfaceReply.*Aku dengar/);
  assert.equal(done(events).text, 'Aku dengar. Kita bahas bagian yang paling bikin kamu capek.');
  assert.doesNotMatch(JSON.stringify(events), /Surface disconnected/);
});

for (const response of [new Error('Unavailable'), 'ordinary text with no stage protocol',
  JSON.stringify({ mode: 'invented', segments: [segment('Should not leak.')] })]) {
  test('invalid or failing surface falls through to exactly one deep call', async () => {
    const registry = fakeRegistry({ surface: response, llm: deep('Jawaban lengkapnya ada di sini.') });
    const events = await collect(generateConversationReply([], 'jelaskan', null, { registry }));
    assert.deepEqual(registry.requests.map(request => request.role), ['surface', 'llm']);
    assert.equal(events.filter(event => event.type === 'conversation_done').length, 1);
    assert.equal(done(events).text, 'Jawaban lengkapnya ada di sini.');
    assert.ok(parts(events).every(event => event.stage === 'deep'));
  });
}

test('an unavailable optional surface slot uses the main role once', async () => {
  const registry = fakeRegistry({ surface: null, llm: deep('Aku langsung jawab.') });
  const events = await collect(generateConversationReply([], 'jelaskan', null, { registry }));
  assert.deepEqual(registry.requests.map(request => request.role), ['llm']);
  assert.equal(done(events).text, 'Aku langsung jawab.');
});

test('deep failure preserves a delivered surface response without retrying either model', async () => {
  const registry = fakeRegistry({ surface: surface('say+think', 'Aku dengar.'), llm: new Error('Deep failed') });
  const events = await collect(generateConversationReply([], 'aku butuh bantuan', null, { registry }));
  assert.equal(done(events).text, 'Aku dengar.');
  assert.equal(events.find(event => event.type === 'stage_error').stage, 'deep');
  assert.deepEqual(registry.requests.map(request => request.role), ['surface', 'llm']);
});

test('deep failure without an emitted surface rejects instead of inventing speech', async () => {
  const registry = fakeRegistry({ surface: surface('think', ''), llm: new Error('Deep failed') });
  await assert.rejects(collect(generateConversationReply([], 'jelaskan', null, { registry })), /Deep failed/);
});

test('proactive opens skip surface and keep internal instructions out of user messages', async () => {
  const registry = fakeRegistry({ surface: new Error('No surface for proactive'), llm: deep('Tadi aku kepikiran cerita kita.') });
  let consumed = 0;
  const events = await collect(generateConversationReply([{ role: 'assistant', content: 'Cerita sebelumnya.' }], null, null,
    { registry, skipSurface: true, internalInstruction: 'Continue the previous shared story.',
      guidance: () => { consumed++; return { hint: 'Keep it playful.' }; } }));
  assert.deepEqual(registry.requests.map(request => request.role), ['llm']);
  assert.equal(consumed, 1);
  assert.equal(registry.requests[0].messages.some(message => message.role === 'user'), false);
  assert.match(registry.requests[0].messages[0].content, /Continue the previous shared story/);
  assert.equal(done(events).text, 'Tadi aku kepikiran cerita kita.');
});

test('reflection controls are emitted only at completion and never become visible speech', async () => {
  const request = 'Find a gentle way to continue this topic.';
  const registry = fakeRegistry({ surface: surface('think', ''),
    llm: deep('Aku mau dengar lanjutannya.', { reflectionRequest: request, thought: 'PRIVATE analysis', internal: ['PRIVATE plan'] }) });
  const events = await collect(generateConversationReply([], 'ceritaku tadi', null, { registry }));
  assert.equal(done(events).reflectionRequest, request);
  assert.doesNotMatch(parts(events).map(event => event.text).join(''), /PRIVATE|Find a gentle|reflectionRequest/);
  assert.doesNotMatch(sentences(events).map(event => event.text).join(''), /PRIVATE|Find a gentle/);
});

test('the stage boundary uses only the excess pause over the preceding sentence pause', async () => {
  const registry = fakeRegistry({ surface: surface('say+think', 'Aku dengar.'), llm: deep('Aku lanjutkan.') },
    { expression: { sentencePauseMs: 200, segmentPauseMs: 350 } });
  const events = await collect(generateConversationReply([], 'lanjut', null, { registry }));
  assert.deepEqual(sentences(events).map(event => [event.pauseBeforeMs, event.pauseAfterMs]), [[0, 200], [150, 200]]);
  assert.equal(sentences(events)[0].pauseAfterMs + sentences(events)[1].pauseBeforeMs, 350);
});

test('the first completed surface sentence is released before the provider finishes', async () => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const registry = fakeRegistry({ surface: async function* () {
    yield { type: 'text', delta: '{"status":"ok","mode":"say+think","segments":[{"register":"casual","emotion":"sayang","text":"Aku dengar. ' };
    await hold;
    yield { type: 'text', delta: '"}]}' };
  }, llm: deep('Aku lanjutkan.') });
  const stream = generateConversationReply([], 'halo', null, { registry });
  let first;
  for (let index = 0; index < 8; index++) {
    const event = (await stream.next()).value;
    if (event.type === 'sentence') { first = event; break; }
  }
  assert.equal(first?.text, 'Aku dengar.');
  assert.deepEqual(registry.requests.map(request => request.role), ['surface']);
  release();
  const rest = await collect(stream);
  assert.equal(done(rest).text, 'Aku dengar. Aku lanjutkan.');
});

test('user cancellation rejects late deep output and emits no completion', async () => {
  const controller = new AbortController();
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const registry = fakeRegistry({ surface: surface('say+think', 'Aku dengar.'), llm: async function* () {
    await hold;
    yield { type: 'text', delta: deep('Obsolete reply.') };
  } });
  const stream = generateConversationReply([], 'halo', null, { registry, signal: controller.signal });
  let event;
  do { event = (await stream.next()).value; } while (!(event.type === 'reply_part' && event.status === 'done'));
  const next = stream.next();
  controller.abort(new Error('user_activity'));
  release();
  await assert.rejects(next, /user_activity/);
});
