import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { completeStream } from '../providers/contracts.js';
import { parseSse } from '../providers/sse.js';
import { parseRetryAfter } from '../providers/errors.js';
import { ADAPTER_CASES, SECRET, PAYLOAD, pause, collect, requestFor, fixture } from './providerFixtures.js';

// Every registered adapter runs the same transport, cancellation and replay contract.
for (const spec of ADAPTER_CASES) {
  test(`${spec.id}: shared contract handles split transport chunks`, async t => {
    const { adapter } = await fixture(t, spec, { mode: 'chunked', reply: 'Hé🙂 ' });
    const events = await collect(adapter.stream(requestFor(spec)));
    const value = events.filter(event => event.type === (spec.audio ? 'audio' : 'text'))
      .map(event => spec.audio ? event.data.toString() : event.delta).join('');
    assert.equal(value, spec.audio ? 'Halo sayang.' : 'Hé🙂 sayang.');
  });

  test(`${spec.id}: shared contract normalizes output without exposing reasoning`, async t => {
    const { adapter, state } = await fixture(t, spec);
    const events = await collect(adapter.stream(requestFor(spec)));
    assert.equal(events.filter(event => event.type === (spec.audio ? 'audio' : 'text'))
      .map(event => spec.audio ? event.data.toString() : event.delta).join(''), 'Halo sayang.');
    assert.equal(JSON.stringify(events).includes('secret thought'), false);
    assert.equal(state.attempts, 1);
    if (spec.audio) {
      assert.ok(events.every(event => Buffer.isBuffer(event.data) && event.format === 'mp3'));
      assert.deepEqual(state.frames, [
        { event: 'start', request: { text: '', reference_id: 'fixture-voice', format: 'mp3', latency: 'low' } },
        { event: 'text', text: '[happy] Halo sayang.' }, { event: 'flush' }, { event: 'stop' },
      ]);
      assert.equal(state.requests[0].headers.model, 'fixture-model');
    } else {
      const result = await completeStream((async function* () { yield* events; })());
      assert.equal(result.text, 'Halo sayang.');
      assert.equal(result.inputTokens, 4);
      assert.equal(result.outputTokens, 3);
      assert.equal(events.at(-1).type, 'done');
      assert.equal(result.finishReason, spec.id === 'openaiCompatible' ? 'stop' : 'end_turn');
    }
  });

  for (const [status, code, attempts] of [[401, 'AUTH', 1], [403, 'AUTH', 1], [429, 'RATE_LIMIT', 3], [500, 'SERVER', 3], [400, 'BAD_REQUEST', 1]]) {
    test(`${spec.id}: shared contract maps ${status}, limits retry and redacts errors`, async t => {
      const { adapter, state } = await fixture(t, spec, { status });
      await assert.rejects(collect(adapter.stream(requestFor(spec))), error => {
        assert.equal(error.code, code);
        assert.equal(error.status, status);
        assert.equal(error.providerId, spec.id);
        assert.equal(error.slot, spec.audio ? 'tts' : 'llm');
        assert.ok(!String(error.stack).includes(SECRET));
        assert.ok(!JSON.stringify(error).includes(PAYLOAD));
        return true;
      });
      assert.equal(state.attempts, attempts);
    });
  }

  test(`${spec.id}: shared contract honors Retry-After`, async t => {
    const { adapter, state } = await fixture(t, spec, { status: 429, retryAfter: '0.04' });
    const startedAt = performance.now();
    await assert.rejects(collect(adapter.stream(requestFor(spec))), error => error.retryAfterMs === 40);
    assert.ok(performance.now() - startedAt >= 75);
    assert.equal(state.attempts, 3);
  });

  for (const mode of ['retry', 'retryNetwork']) {
    test(`${spec.id}: shared contract recovers ${mode} before output`, async t => {
      const { adapter, state } = await fixture(t, spec, { mode });
      assert.ok((await collect(adapter.stream(requestFor(spec)))).length);
      assert.equal(state.attempts, 2);
    });
  }

  test(`${spec.id}: shared contract caps network retries at two`, async t => {
    const { adapter, state } = await fixture(t, spec, { mode: 'network' });
    await assert.rejects(collect(adapter.stream(requestFor(spec))), error => error.code === 'NETWORK');
    assert.equal(state.attempts, 3);
  });

  test(`${spec.id}: shared contract never retries partial output`, async t => {
    const { adapter, state } = await fixture(t, spec, { mode: 'partial' });
    const items = [];
    await assert.rejects(async () => { for await (const event of adapter.stream(requestFor(spec))) items.push(event); },
      error => error.code === 'NETWORK');
    assert.equal(items.length, 1);
    assert.equal(state.attempts, 1);
  });

  test(`${spec.id}: shared contract rejects malformed bodies without replay or body leakage`, async t => {
    const { adapter, state } = await fixture(t, spec, { mode: 'malformed' });
    await assert.rejects(collect(adapter.stream(requestFor(spec))), error => error.code === 'BAD_RESPONSE' && !error.message.includes(PAYLOAD));
    assert.equal(state.attempts, 1);
  });

  for (const [mode, timeouts] of [
    ['stall', { firstByteMs: 80, idleMs: 3000, totalMs: 3000 }],
    ['idle', { firstByteMs: 3000, idleMs: 80, totalMs: 3000 }],
    ['heartbeat', { firstByteMs: 3000, idleMs: 3000, totalMs: 150 }],
  ]) {
    test(`${spec.id}: shared contract enforces ${mode} deadline`, async t => {
      const { adapter, state } = await fixture(t, spec, { mode });
      await assert.rejects(collect(adapter.stream(requestFor(spec, { timeouts }))), error => error.code === 'TIMEOUT');
      assert.equal(state.attempts, 1);
    });
  }

  test(`${spec.id}: shared contract abort closes an active stream promptly`, async t => {
    const { adapter, state } = await fixture(t, spec, { mode: 'open' });
    const controller = new AbortController();
    const stream = adapter.stream(requestFor(spec, { signal: controller.signal }));
    await stream.next();
    controller.abort(new Error(SECRET));
    await assert.rejects(stream.next(), error => error.code === 'ABORTED' && !error.message.includes(SECRET));
    for (let i = 0; i < 40 && !state.closed; i++) await pause(5);
    assert.ok(state.closed > 0);
    assert.equal(state.attempts, 1);
  });

  test(`${spec.id}: shared contract cancels before connection and during first-byte wait`, async t => {
    const { adapter, state } = await fixture(t, spec, { mode: 'stall' });
    const before = new AbortController();
    before.abort();
    await assert.rejects(collect(adapter.stream(requestFor(spec, { signal: before.signal }))), error => error.code === 'ABORTED');
    assert.equal(state.attempts, 0);
    const waiting = new AbortController();
    const pending = collect(adapter.stream(requestFor(spec, { signal: waiting.signal })));
    for (let i = 0; i < 80 && !state.attempts; i++) await pause(5);
    waiting.abort();
    await assert.rejects(pending, error => error.code === 'ABORTED');
    assert.equal(state.attempts, 1);
  });

  test(`${spec.id}: shared contract closes when the consumer stops early`, async t => {
    const { adapter, state } = await fixture(t, spec, { mode: 'open' });
    for await (const _event of adapter.stream(requestFor(spec))) break;
    for (let i = 0; i < 40 && !state.closed; i++) await pause(5);
    assert.ok(state.closed > 0);
    assert.equal(state.attempts, 1);
  });

  if (spec.audio) continue;

  test(`${spec.id}: shared LLM contract converts images, system messages and JSON`, async t => {
    const { adapter, state } = await fixture(t, spec);
    const result = await adapter.complete({ json: true, maxTokens: 17, temperature: 0.2, messages: [
      { role: 'system', content: 'First system.' }, { role: 'system', content: [{ type: 'text', text: 'Second system.' }] },
      { role: 'user', content: [{ type: 'image', mime: 'image/png', base64: 'AQID' }, { type: 'text', text: 'What is here?' }] },
    ] });
    assert.equal(result.text, 'Halo sayang.');
    const body = JSON.parse(state.requests[0].body);
    assert.equal(body.max_tokens, 17);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.model, 'fixture-model');
    assert.equal(body.stream, true);
    if (spec.id === 'openaiCompatible') {
      assert.equal(body.messages[0].role, 'system');
      assert.equal(body.messages[1].role, 'system');
      assert.deepEqual(body.messages[2].content[0], { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } });
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.deepEqual(body.stream_options, { include_usage: true });
    } else {
      assert.equal(body.messages.length, 1);
      assert.ok(body.system.some(block => block.text === 'First system.'));
      assert.ok(body.system.some(block => block.text === 'Second system.'));
      assert.ok(body.system.some(block => block.text.includes('JSON')));
      assert.deepEqual(body.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } });
      assert.equal(body.response_format, undefined);
      assert.equal(state.requests[0].headers['x-api-key'], SECRET);
      assert.equal(state.requests[0].headers['anthropic-version'], '2023-06-01');
    }
  });

  test(`${spec.id}: shared LLM contract rejects unsupported images before sending`, async t => {
    const { adapter, state } = await fixture(t, spec, { profile: { flags: { supportsImages: false } } });
    await assert.rejects(adapter.complete({ messages: [{ role: 'user', content: [{ type: 'image', mime: 'image/png', base64: 'AQID' }] }] }),
      error => error.code === 'UNSUPPORTED');
    assert.equal(state.attempts, 0);
  });
}

test('SSE preserves split UTF-8, CRLF, comments, multi-line data and DONE', async () => {
  const data = Buffer.from(': comment\r\nevent: message\r\ndata: {"text":\r\ndata: "é🙂"}\r\n\r\ndata: [DONE]\n\n');
  const body = new ReadableStream({ start(controller) { for (const byte of data) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  assert.deepEqual(await collect(parseSse(body)), [
    { event: 'message', data: '{"text":\n"é🙂"}' }, { event: 'message', data: '[DONE]' },
  ]);
});

test('Retry-After supports HTTP dates, fractions and invalid values', () => {
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:58 GMT')), 2000);
  assert.equal(parseRetryAfter('0.125'), 125);
  assert.equal(parseRetryAfter('nonsense'), undefined);
  assert.equal(parseRetryAfter(''), undefined);
});

test('OpenAI-compatible flags support prompt-only JSON, bodyExtras and omitted parameters', async t => {
  const { adapter, state } = await fixture(t, ADAPTER_CASES[0], { profile: {
    flags: { supportsJsonMode: false, supportsStreamUsage: false }, bodyExtras: { reasoning_effort: 'none' },
    omitParams: ['temperature', 'max_tokens'], extraHeaders: { 'X-Fixture': 'value' },
  } });
  await adapter.complete(requestFor(ADAPTER_CASES[0], { json: true, temperature: 0.5, maxTokens: 10 }));
  const body = JSON.parse(state.requests[0].body);
  assert.equal(body.response_format, undefined);
  assert.equal(body.stream_options, undefined);
  assert.equal(body.temperature, undefined);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.reasoning_effort, 'none');
  assert.match(body.messages.at(-1).content, /JSON/);
  assert.equal(state.requests[0].headers['x-fixture'], 'value');
});

test('Anthropic native profile supplies required max_tokens, version and safe stream error mapping', async t => {
  const { adapter, state } = await fixture(t, ADAPTER_CASES[1], { profile: { defaultMaxTokens: 123, anthropicVersion: 'fixture-version' } });
  await adapter.complete(requestFor(ADAPTER_CASES[1]));
  assert.equal(JSON.parse(state.requests[0].body).max_tokens, 123);
  assert.equal(state.requests[0].headers['anthropic-version'], 'fixture-version');
  state.mode = 'vendorError';
  await assert.rejects(adapter.complete(requestFor(ADAPTER_CASES[1])), error => error.code === 'SERVER' && !error.message.includes(SECRET));
  assert.equal(state.attempts, 4);
});

test('OpenAI-compatible STT uses multipart and retains only present verbose metadata', async t => {
  const { adapter, state } = await fixture(t, ADAPTER_CASES[0]);
  const result = await adapter.transcribe({ audio: Buffer.from('synthetic-audio'), mime: 'audio/wav', filename: 'voice.wav', language: 'id' });
  assert.deepEqual(result, { text: 'Aku sedang membaca.', durationMs: 1250, segments: [
    { text: 'Aku sedang membaca.', noSpeechProb: 0.1, avgLogprob: -0.2, compressionRatio: 1.1 }, { text: 'Tanpa metadata.' },
  ] });
  const request = state.requests[0];
  assert.match(request.headers['content-type'], /multipart\/form-data; boundary=/);
  assert.match(request.body, /filename="voice.wav"/);
  assert.match(request.body, /Content-Type: audio\/wav/);
  assert.match(request.body, /verbose_json/);
  assert.match(request.body, /synthetic-audio/);
  state.transcription = { text: 'No metadata' };
  assert.deepEqual(await adapter.transcribe({ audio: Buffer.alloc(1), mime: 'audio/wav', filename: 'a.wav' }), { text: 'No metadata' });
});

test('STT malformed responses, first-byte timeout, auth errors and pre-output retries use the shared policy', async t => {
  const { adapter, state } = await fixture(t, ADAPTER_CASES[0]);
  const request = { audio: Buffer.alloc(1), mime: 'audio/wav', filename: 'a.wav' };
  state.mode = 'malformed';
  await assert.rejects(adapter.transcribe(request), error => error.code === 'BAD_RESPONSE');
  state.mode = 'stall';
  await assert.rejects(adapter.transcribe({ ...request, timeouts: { firstByteMs: 80 } }), error => error.code === 'TIMEOUT');
  state.mode = 'ok'; state.status = 403;
  await assert.rejects(adapter.transcribe(request), error => error.code === 'AUTH');
  state.status = 200; state.mode = 'retry'; state.attempts = 0;
  assert.equal((await adapter.transcribe(request)).text, 'Aku sedang membaca.');
  assert.equal(state.attempts, 2);
});

test('every adapter keeps keys and audio/image bodies out of captured logs and errors', async t => {
  const logs = [];
  const originals = Object.fromEntries(['log', 'warn', 'error'].map(name => [name, console[name]]));
  try {
    for (const name of Object.keys(originals)) console[name] = (...args) => logs.push(args.map(String).join(' '));
    for (const spec of ADAPTER_CASES) {
      const { adapter } = await fixture(t, spec, { status: 403 });
      try { await collect(adapter.stream(requestFor(spec))); }
      catch (error) { logs.push(String(error.stack), JSON.stringify(error)); }
    }
  } finally { Object.assign(console, originals); }
  assert.equal(logs.join('\n').includes(SECRET), false);
  assert.equal(logs.join('\n').includes(PAYLOAD), false);
});

test('STT text-only JSON profiles omit verbose mode and cancellation reaches the HTTP stream', async t => {
  const { adapter, state } = await fixture(t, ADAPTER_CASES[0], { profile: { flags: { supportsStt: true, supportsVerboseStt: false } } });
  const request = { audio: Buffer.alloc(1), mime: 'audio/wav', filename: 'a.wav' };
  await adapter.transcribe(request);
  assert.doesNotMatch(state.requests[0].body, /verbose_json/);
  assert.match(state.requests[0].body, /\r\njson\r\n/);
  state.mode = 'stall';
  const controller = new AbortController();
  const pending = adapter.transcribe({ ...request, signal: controller.signal });
  for (let i = 0; i < 40 && state.attempts < 2; i++) await pause(5);
  controller.abort();
  await assert.rejects(pending, error => error.code === 'ABORTED');
  assert.equal(state.attempts, 2);
});
