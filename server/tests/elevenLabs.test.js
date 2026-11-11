import test from 'node:test';
import assert from 'node:assert/strict';
import { ElevenLabs } from '../providers/adapters/elevenLabs.js';
import { ProviderRegistry } from '../providers/registry.js';
import { generateSpeech } from '../ttsGenerate.js';
import { validateBaseUrl, validateRequestUrl } from '../providers/baseUrl.js';
import { DEFAULT_ELEVENLABS_PARAMS, ELEVENLABS_MODELS, isElevenLabsVoice,
  prepareElevenLabsText, resolveElevenLabsParams } from '../elevenLabsTts.js';
import { stripSpeechTags } from '../ttsExpression.js';

const SECRET = 'eleven-fixture-private-value';
const AUDIO = Buffer.from('ID3-synthetic-audio');
const collect = async stream => { const events = []; for await (const event of stream) events.push(event); return events; };
const response = bytes => new Response(bytes ?? AUDIO, { headers: { 'content-type': 'audio/mpeg' } });
function adapter(options = {}) {
  return new ElevenLabs({ profile: { adapter: 'elevenLabs', baseUrl: 'https://api.elevenlabs.io/v1', apiKeyEnv: 'ELEVEN_FIXTURE_KEY' },
    model: 'eleven_flash_v2_5', params: { voice: 'fixture-voice' },
    secretResolver: { resolve: () => SECRET }, timeouts: { firstByteMs: 1000, idleMs: 1000, totalMs: 2000 },
    fetchImpl: async () => response(), ...options });
}

test('ElevenLabs streams canonical MP3 events and uses encoded voice and native parameters', async () => {
  const requests = [];
  const progress = [];
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array()); controller.enqueue(AUDIO.subarray(0, 3));
    controller.enqueue(AUDIO.subarray(3)); controller.close();
  } });
  const provider = adapter({ profile: { adapter: 'elevenLabs', baseUrl: 'https://api.elevenlabs.io/v1/', apiKeyEnv: 'ELEVEN_FIXTURE_KEY',
    extraHeaders: { 'X-Custom-Key': 'profile-custom', 'XI-API-KEY': 'wrong-key' } },
  params: { voice: 'voice /?name', elevenLabs: { stability: 0.4, speed: 0.9 } },
  fetchImpl: async (url, options) => { requests.push({ url, options }); return response(stream); } });
  const events = await collect(provider.stream({ text: '(happy) Halo **sayang**! [sigh] Aku di sini.', emotion: 'senang',
    elevenLabs: { similarityBoost: 0.6 }, onProgress: phase => progress.push(phase) }));
  assert.equal(events.length, 2);
  assert.ok(events.every(event => event.type === 'audio' && event.format === 'mp3' && Buffer.isBuffer(event.data)));
  assert.deepEqual(Buffer.concat(events.map(event => event.data)), AUDIO);
  assert.deepEqual(progress, ['first_byte']);
  const { url, options } = requests[0];
  assert.equal(url, 'https://api.elevenlabs.io/v1/text-to-speech/voice%20%2F%3Fname/stream?output_format=mp3_44100_128');
  assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
  assert.equal(options.headers.get('xi-api-key'), SECRET);
  assert.equal(options.headers.get('x-custom-key'), 'profile-custom');
  assert.equal(options.headers.get('authorization'), null);
  assert.deepEqual(JSON.parse(options.body), { text: 'Halo sayang! Aku di sini.', model_id: 'eleven_flash_v2_5',
    voice_settings: { stability: 0.4, similarity_boost: 0.6, speed: 0.9, style: 0, use_speaker_boost: false } });
  assert.equal(stream.locked, false);
});

test('ElevenLabs v3 sends only stability and one mapped tag per spoken sentence', async () => {
  let sent;
  const provider = adapter({ model: 'eleven_v3', params: { voice: 'fixture-voice', elevenLabs: { stability: 1, speed: 1.2 } },
    fetchImpl: async (_url, options) => { sent = JSON.parse(options.body); return response(); } });
  await collect(provider.stream({ text: '[calm] Aku senang! [laughs] Kamu bagaimana?', emotion: 'sedih', speechEmotion: 'happy' }));
  assert.deepEqual(sent, { text: '[excited] Aku senang! [excited] Kamu bagaimana?', model_id: 'eleven_v3',
    voice_settings: { stability: 1 } });
  await collect(provider.stream({ text: 'Halo!', emotion: 'senang', elevenLabs: { emotionTags: false } }));
  assert.equal(sent.text, 'Halo!');
});

test('ElevenLabs text maps all avatar emotions and native equivalents without changing captions', () => {
  const mappings = { senang: '[excited]', kagum: '[excited]', terkejut: '[surprised]', marah: '[angry]',
    bingung: '[curious]', penasaran: '[curious]', jengkel: '[frustrated]', kesal: '[frustrated]',
    sedih: '[sad]', sayang: '[warmly]', malu: '[whispers]', jahil: '[mischievously]', netral: '' };
  for (const [emotion, tag] of Object.entries(mappings)) {
    const input = '[calm] Halo sayang.';
    assert.equal(prepareElevenLabsText(input, emotion, undefined, DEFAULT_ELEVENLABS_PARAMS, 'eleven_v3'),
      (tag ? tag + ' ' : '') + 'Halo sayang.');
    assert.equal(stripSpeechTags(input), ' Halo sayang.');
  }
  for (const [native, tag] of [['happy', '[excited]'], ['angry', '[angry]'], ['empathetic', '[warmly]'],
    ['curious', '[curious]'], ['sarcastic', '[mischievously]'], ['neutral', '']]) {
    assert.equal(prepareElevenLabsText('Halo.', 'sedih', native, DEFAULT_ELEVENLABS_PARAMS, 'eleven_v3'),
      (tag ? tag + ' ' : '') + 'Halo.');
  }
  assert.equal(prepareElevenLabsText('Halo.', 'sedih', 'hopeful', DEFAULT_ELEVENLABS_PARAMS, 'eleven_v3'), '[sad] Halo.');
  assert.equal(prepareElevenLabsText('Halo.', 'toString', 'constructor', DEFAULT_ELEVENLABS_PARAMS, 'eleven_v3'), 'Halo.');
  for (const model of ELEVENLABS_MODELS.filter(model => model !== 'eleven_v3')) {
    assert.equal(prepareElevenLabsText('[laughs] Halo (happy) [sighs] sayang.', 'senang', 'happy', DEFAULT_ELEVENLABS_PARAMS, model), 'Halo sayang.');
  }
  assert.equal(prepareElevenLabsText('Aku [suka](https://example.invalid) kopi (tanpa gula).', 'netral', undefined,
    DEFAULT_ELEVENLABS_PARAMS, 'eleven_flash_v2_5'), 'Aku suka kopi (tanpa gula).');
});

test('ElevenLabs validates namespaces and explicit voice IDs without mutating defaults', () => {
  const original = { speed: 0.9 };
  assert.deepEqual(resolveElevenLabsParams(original, { stability: 0.6 }), { ...DEFAULT_ELEVENLABS_PARAMS, speed: 0.9, stability: 0.6 });
  assert.deepEqual(original, { speed: 0.9 });
  for (const params of [null, [], { extra: true }, { speed: 0.69 }, { speed: 1.21 }, { stability: NaN },
    { similarityBoost: 2 }, { speed: '1' }, { emotionTags: 1 }]) assert.throws(() => resolveElevenLabsParams(params), TypeError);
  assert.throws(() => resolveElevenLabsParams({ stability: 0.25 }, {}, 'eleven_v3'), TypeError);
  for (const value of ['', ' ', '.', '..', null, '<voice>', 'REPLACE_WITH_VOICE_ID', 'ISI_DENGAN_ID', 'bad\nvoice']) {
    assert.equal(isElevenLabsVoice(value), false);
  }
  assert.equal(isElevenLabsVoice('voice/id?encoded'), true);
});

test('ElevenLabs rejects missing voice, model, format, invalid tuning and headers before network', async () => {
  let attempts = 0;
  const fetchImpl = async () => { attempts++; return response(); };
  for (const options of [{ params: {} }, { params: { voice: '' } }, { params: { voice: 'REPLACE_WITH_VOICE_ID' } },
    { params: { voice: '.' } }, { params: { voice: '..' } },
    { model: 'eleven_v4' }, { model: '' }, { params: { voice: 'fixture-voice', format: 'wav' } },
    { params: { voice: 'fixture-voice', elevenLabs: { speed: 5 } } },
    { profile: { baseUrl: 'http://public.example.test/v1' } },
    { profile: { baseUrl: 'https://api.elevenlabs.io/v1', extraHeaders: { Host: 'other.test' } } }]) {
    await assert.rejects(collect(adapter({ fetchImpl, ...options }).stream({ text: 'Halo.' })), error => error.code === 'BAD_REQUEST');
  }
  await assert.rejects(collect(adapter({ fetchImpl }).stream({ text: 7 })), error => error.code === 'BAD_REQUEST');
  assert.equal(attempts, 0);
  await assert.rejects(collect(adapter({ fetchImpl, secretResolver: { resolve: () => undefined } }).stream({ text: 'Halo.' })),
    error => error.code === 'AUTH');
  assert.equal(attempts, 0);
});

test('ElevenLabs resolves stored credentials with no environment-only assumption', async () => {
  let seen;
  const provider = adapter({ secretResolver: { profileSecrets: () => ({ apiKey: SECRET, headers: { 'X-Account-Key': 'account' } }) },
    fetchImpl: async (_url, options) => { seen = options.headers; return response(); } });
  await collect(provider.stream({ text: 'Halo.' }));
  assert.equal(seen.get('xi-api-key'), SECRET); assert.equal(seen.get('x-account-key'), 'account');
});

test('ElevenLabs safely rejects authentication, rate limits, server and network errors without retry', async () => {
  for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [500, 'SERVER'], [422, 'BAD_REQUEST'], [408, 'TIMEOUT']]) {
    let attempts = 0;
    const provider = adapter({ resilience: { maxRetries: 2, baseDelayMs: 1 }, fetchImpl: async () => {
      attempts++; return new Response(SECRET, { status, headers: { 'retry-after': '2' } });
    } });
    await assert.rejects(collect(provider.stream({ text: 'Halo.' })), error => error.code === code && error.status === status
      && error.retryAfterMs === 2000 && !error.message.includes(SECRET));
    assert.equal(attempts, 1);
  }
  let attempts = 0;
  await assert.rejects(collect(adapter({ fetchImpl: async () => { attempts++; throw new Error(SECRET); } }).stream({ text: 'Halo.' })),
    error => error.code === 'NETWORK' && !error.message.includes(SECRET));
  assert.equal(attempts, 1);
});

test('ElevenLabs rejects empty and non-audio responses and releases the reader', async () => {
  const empty = response(new Uint8Array());
  await assert.rejects(collect(adapter({ fetchImpl: async () => empty }).stream({ text: 'Halo.' })), error => error.code === 'BAD_RESPONSE');
  assert.equal(empty.body.locked, false);
  let cancelled = 0;
  const malformed = new Response(new ReadableStream({ start(controller) { controller.enqueue(AUDIO); }, cancel() { cancelled++; } }),
    { headers: { 'content-type': 'application/json' } });
  await assert.rejects(collect(adapter({ fetchImpl: async () => malformed }).stream({ text: 'Halo.' })), error => error.code === 'BAD_RESPONSE');
  assert.equal(cancelled, 1); assert.equal(malformed.body.locked, false);
  assert.deepEqual(await collect(adapter({ fetchImpl: async () => { throw new Error('must not request'); } }).stream({ text: '[laughs] !!!' })), []);
});

test('ElevenLabs cancellation and idle/first-byte deadlines cancel stalled response bodies', async () => {
  for (const mode of ['abort', 'idle', 'firstByte', 'total']) {
    const controller = new AbortController();
    let cancellations = 0;
    let attempts = 0;
    let stalled = false;
    const body = new ReadableStream({ start(stream) {
      if (['idle', 'total'].includes(mode)) stream.enqueue(AUDIO);
    }, pull() { if (!stalled) { stalled = true; if (mode === 'abort') setImmediate(() => controller.abort()); } },
    cancel() { cancellations++; } });
    const timeouts = mode === 'total' ? { firstByteMs: 0, idleMs: 0, totalMs: 80 }
      : { firstByteMs: 80, idleMs: 80, totalMs: 1000 };
    const provider = adapter({ timeouts, fetchImpl: async () => { attempts++; return response(body); } });
    await assert.rejects(collect(provider.stream({ text: 'Halo.', signal: controller.signal })),
      error => error.code === (mode === 'abort' ? 'ABORTED' : 'TIMEOUT'));
    assert.equal(cancellations, 1, mode); assert.equal(body.locked, false, mode); assert.equal(attempts, 1);
  }
});

test('ElevenLabs aborts before headers and never starts a pre-cancelled request', async () => {
  let attempts = 0;
  let cancelled = false;
  const provider = adapter({ timeouts: { firstByteMs: 80, totalMs: 1000 }, fetchImpl: async (_url, { signal }) => {
    attempts++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      cancelled = true; reject(signal.reason);
    }, { once: true }));
  } });
  await assert.rejects(collect(provider.stream({ text: 'Halo.' })), error => error.code === 'TIMEOUT');
  assert.equal(attempts, 1); assert.equal(cancelled, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collect(provider.stream({ text: 'Halo.', signal: controller.signal })), error => error.code === 'ABORTED');
  assert.equal(attempts, 1);
});

test('ElevenLabs early iterator exit and partial failure clean up without replay', async () => {
  let cancelled = 0;
  const body = new ReadableStream({ start(stream) { stream.enqueue(AUDIO); }, cancel() { cancelled++; } });
  for await (const event of adapter({ fetchImpl: async () => response(body) }).stream({ text: 'Halo.' })) {
    assert.deepEqual(event.data, AUDIO); break;
  }
  assert.equal(cancelled, 1); assert.equal(body.locked, false);
  let attempts = 0;
  let pulls = 0;
  const broken = new ReadableStream({ pull(stream) { if (pulls++ === 0) stream.enqueue(AUDIO); else stream.error(new Error(SECRET)); } });
  const provider = adapter({ fetchImpl: async () => { attempts++; return response(broken); } });
  const events = provider.stream({ text: 'Halo.' })[Symbol.asyncIterator]();
  assert.deepEqual((await events.next()).value.data, AUDIO);
  await assert.rejects(events.next(), error => error.code === 'NETWORK' && !error.message.includes(SECRET));
  assert.equal(attempts, 1); assert.equal(broken.locked, false);
});

test('ElevenLabs request queries preserve base URL, origin and redirect restrictions', async () => {
  assert.throws(() => validateBaseUrl('https://api.elevenlabs.io/v1?output_format=mp3'));
  assert.equal(validateRequestUrl('https://api.elevenlabs.io/v1', 'https://api.elevenlabs.io/v1/test?output_format=mp3').url,
    'https://api.elevenlabs.io/v1/test?output_format=mp3');
  for (const url of ['https://other.test/test?output_format=mp3', 'https://api.elevenlabs.io/test#fragment',
    'https://169.254.169.254/test?output_format=mp3', 'https://api.elevenlabs.io/test?bad= value']) {
    assert.throws(() => validateRequestUrl('https://api.elevenlabs.io/v1', url));
  }
  for (const location of ['https://api.elevenlabs.io/target', 'https://other.test/target']) {
    let attempts = 0;
    await assert.rejects(collect(adapter({ fetchImpl: async (_url, options) => {
      attempts++; assert.equal(options.redirect, 'error'); return new Response(null, { status: 307, headers: { location } });
    } }).stream({ text: 'Halo.' })), error => error.code === 'BAD_REQUEST');
    assert.equal(attempts, 1);
  }
});

test('ElevenLabs uses the existing speech buffer and sentence audio boundaries', async () => {
  const sent = [];
  const config = { profiles: { eleven: { adapter: 'elevenLabs', baseUrl: 'https://api.elevenlabs.io/v1', apiKeyEnv: 'ELEVEN_FIXTURE_KEY' } },
    slots: { tts: { profile: 'eleven', model: 'eleven_v3', params: { voice: 'fixture-voice',
      expression: { mergeShortSentences: { enabled: false } } } } } };
  const registry = new ProviderRegistry({ config, secretResolver: { resolve: () => SECRET }, adapterOptions: {
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return response(); },
  } });
  const formats = []; let ends = 0;
  const chunks = await collect(generateSpeech('Halo sayang. Aku senang!', 'senang', { registry,
    onAudioFormat: format => formats.push(format), onAudioEnd: () => { ends++; } }));
  assert.deepEqual(chunks, [AUDIO, AUDIO]); assert.deepEqual(formats, ['mp3', 'mp3']); assert.equal(ends, 2);
  assert.deepEqual(sent.map(request => request.text), ['[excited] Halo sayang.', '[excited] Aku senang!']);
  await assert.rejects(registry.getTts().complete({}), error => error.code === 'UNSUPPORTED');
  await assert.rejects(registry.getTts().transcribe({}), error => error.code === 'UNSUPPORTED');
});
