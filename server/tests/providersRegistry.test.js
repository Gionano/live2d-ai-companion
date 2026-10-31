import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProvidersConfig, DEFAULT_CONFIG, validateConfig } from '../providers/config.js';
import { ProviderRegistry, UNAVAILABLE_MESSAGES } from '../providers/registry.js';
import { generateReplyStream } from '../llmChat.js';
import { transcribeAudio } from '../sttTranscribe.js';
import { generateSpeech, withFishEmotion } from '../ttsGenerate.js';
import { getVoiceId } from '../voiceConfig.js';
import { describeFrame } from '../visionCapture.js';
import { StreamingVisionManager } from '../streamingVisionManager.js';
import { warmUpModels } from '../modelWarmup.js';
import { testSlot, tinyPng, shortWav } from '../providers/testSlot.js';
import { runCli, parseArgs } from '../providers/cli.js';
import { fixture, ADAPTER_CASES, collect, SECRET } from './providerFixtures.js';

const localConfig = () => ({ profiles: { local: { adapter: 'openaiCompatible', baseUrl: 'http://127.0.0.1:1',
  flags: { supportsImages: true, supportsStt: true } } }, slots: { llm: { profile: 'local', model: 'fixture' } } });
const fakeRegistry = provider => ({ getSlotStatus: () => ({ available: true, model: 'fixture' }),
  getLlm: () => provider, getStt: () => provider, getTts: () => provider });

test('provider configuration deep-merges machine overrides, replaces arrays/null and expands LOCAL', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-config-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'providers.config.json'), JSON.stringify({ profiles: {
    sample: { adapter: 'openaiCompatible', baseUrl: 'http://127.0.0.1:1', bodyExtras: { one: 1, two: 2 }, omitParams: ['a', 'b'] },
  } }));
  fs.writeFileSync(path.join(repoRoot, 'providers.config.local.json'), JSON.stringify({ profiles: {
    sample: { bodyExtras: { two: 3 }, omitParams: ['x'], diagnosticFile: '${LOCAL}/probe.log' },
  }, slots: { vision: null } }));
  const config = loadProvidersConfig({ repoRoot, env: {} });
  assert.deepEqual(config.profiles.sample.bodyExtras, { one: 1, two: 3 });
  assert.deepEqual(config.profiles.sample.omitParams, ['x']);
  assert.equal(config.profiles.sample.diagnosticFile, path.join(repoRoot, 'local', 'probe.log'));
  assert.equal(config.slots.vision, null);
  assert.equal(DEFAULT_CONFIG.slots.vision, null);
});

test('environment seeding requires an explicit shared mapping and local values take precedence', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-env-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const env = { EXPLABS_BASE_URL: 'http://127.0.0.1:2', EXPLABS_MODEL: 'env-model' };
  fs.writeFileSync(path.join(repoRoot, 'providers.config.json'), JSON.stringify({
    profiles: { sample: { adapter: 'openaiCompatible', baseUrl: 'http://127.0.0.1:1', baseUrlEnv: 'EXPLABS_BASE_URL' } },
    slots: { llm: { profile: 'sample', model: 'fixture', modelEnv: 'EXPLABS_MODEL' },
      planner: { profile: 'sample', model: 'fixture', modelEnv: 'EXPLABS_MODEL' } },
  }));
  const config = loadProvidersConfig({ repoRoot, env });
  assert.equal(config.profiles.sample.baseUrl, env.EXPLABS_BASE_URL);
  assert.equal(config.slots.llm.model, 'env-model');
  assert.equal(config.slots.planner.model, 'env-model');
  fs.writeFileSync(path.join(repoRoot, 'providers.config.local.json'), JSON.stringify({ profiles: {
    sample: { baseUrl: 'http://127.0.0.1:3' },
  }, slots: { llm: { model: 'local-model' } } }));
  const local = loadProvidersConfig({ repoRoot, env });
  assert.equal(local.profiles.sample.baseUrl, 'http://127.0.0.1:3');
  assert.equal(local.slots.llm.model, 'local-model');
  assert.equal(local.slots.planner.model, 'env-model');
});

test('public templates never assign slots, including when legacy provider env values exist', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-neutral-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const config = loadProvidersConfig({ repoRoot, env: {
    EXPLABS_BASE_URL: 'https://example.invalid/v1', EXPLABS_MODEL: 'fixture-model',
    GROQ_BASE_URL: 'https://example.invalid', EXPLABS_API_KEY: SECRET,
    GROQ_API_KEY: SECRET, NINEINFERENCE_API_KEY: SECRET, FISH_API_KEY: SECRET,
  } });
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.deepEqual(Object.keys(config.profiles).sort(), ['anthropic-native', 'fish-audio', 'openai-compatible']);
  for (const profile of Object.values(config.profiles)) {
    assert.match(profile.baseUrl, /^REPLACE_WITH_/);
    assert.equal(profile.model, 'REPLACE_WITH_MODEL');
  }
  const registry = new ProviderRegistry({ config });
  assert.deepEqual(Object.keys(config.slots).sort(), ['llm', 'planner', 'stt', 'tts', 'vision', 'visionFilter']);
  for (const slot of Object.keys(config.slots)) {
    assert.equal(config.slots[slot], null);
    assert.equal(registry.get(slot), null);
    assert.match(registry.getSlotStatus(slot).reason, /Set its profile and model in providers\.config\.local\.json/);
  }
});

test('moving a resolved selection to a local file preserves its effective profiles and every slot', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-migrate-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const sharedPath = path.join(repoRoot, 'providers.config.json');
  const localPath = path.join(repoRoot, 'providers.config.local.json');
  fs.writeFileSync(sharedPath, JSON.stringify({
    profiles: { sample: { adapter: 'openaiCompatible', baseUrl: 'http://127.0.0.1:1',
      baseUrlEnv: 'FIXTURE_BASE_URL', apiKeyEnv: 'FIXTURE_API_KEY', flags: { supportsStt: true } } },
    slots: { llm: { profile: 'sample', model: 'old', modelEnv: 'FIXTURE_MODEL' },
      stt: { profile: 'sample', model: 'fixture-stt', params: { language: 'id' } } },
  }));
  fs.writeFileSync(localPath, JSON.stringify({ profiles: { sample: { flags: { supportsImages: true } } },
    slots: { llm: { params: { temperature: 0.2, bodyExtras: { fixture: true } } } } }));
  const env = { FIXTURE_BASE_URL: 'http://127.0.0.1:2', FIXTURE_MODEL: 'resolved-model' };
  const before = loadProvidersConfig({ repoRoot, env });
  fs.writeFileSync(localPath, JSON.stringify(before));
  fs.writeFileSync(sharedPath, JSON.stringify(DEFAULT_CONFIG));
  const after = loadProvidersConfig({ repoRoot, env: {} });
  assert.deepEqual(after, before);
  assert.equal(after.slots.llm.model, 'resolved-model');
  assert.equal(after.profiles.sample.baseUrl, env.FIXTURE_BASE_URL);
});

test('role slots default to llm only when omitted; null disables a role', () => {
  const config = localConfig();
  const registry = new ProviderRegistry({ config });
  assert.equal(registry.getSlotStatus('planner').profile, 'local');
  assert.equal(registry.getSlotStatus('visionFilter').model, 'fixture');
  assert.equal(registry.getSlotStatus('vision').available, false);
  config.slots.planner = null;
  registry.reload(config);
  assert.equal(registry.getSlotStatus('planner').available, false);
  assert.equal(registry.getSlotStatus('llm').available, true);
});

test('registry creates lazy, cached adapters and reload replaces instances', () => {
  const registry = new ProviderRegistry({ config: localConfig() });
  assert.equal(registry.instances.size, 0);
  assert.equal(registry.getSlotStatus('llm').available, true);
  assert.equal(registry.instances.size, 0);
  const first = registry.getLlm();
  assert.equal(registry.getLlm(), first);
  registry.reload(localConfig());
  assert.notEqual(registry.getLlm(), first);
  assert.equal(registry.getStt(), null);
  assert.equal(registry.getTts(), null);
  assert.equal(registry.getSlotStatus('image').available, false);
});

for (const [change, expected] of [
  [config => { config.slots.llm.profile = 'missing'; }, /Unknown profile/],
  [config => { config.profiles.local.adapter = 'missing'; }, /Unknown adapter/],
  [config => { config.slots.llm.model = ''; }, /Missing model/],
  [config => { config.slots.llm.model = 'REPLACE_WITH_MODEL'; }, /Missing model/],
  [config => { config.profiles.local.apiKeyEnv = 'MISSING_FIXTURE_KEY'; }, /Missing key environment variable MISSING_FIXTURE_KEY/],
  [config => { config.profiles.local.adapter = 'fishAudio'; }, /capability/],
  [config => { config.profiles.local.baseUrl = `http://user:${SECRET}@127.0.0.1:1`; }, /without credentials/],
  [config => { config.slots.llm.timeouts = { idleMs: -1 }; }, /timeouts/],
]) {
  test(`provider configuration validates ${expected.source} safely`, () => {
    const config = localConfig(); change(config);
    const registry = new ProviderRegistry({ config, secretResolver: { resolve: () => undefined } });
    const status = registry.getSlotStatus('llm');
    assert.equal(status.available, false);
    assert.match(status.reason, expected);
    assert.equal(status.reason.includes(SECRET), false);
    assert.equal(registry.getLlm(), null);
    assert.ok(validateConfig(config, { resolve: () => undefined }).some(problem => problem.slot === 'llm'));
  });
}

test('model capability overrides gate vision without disabling text chat', () => {
  const config = localConfig();
  config.slots.vision = { profile: 'local', model: 'text-only' };
  config.profiles.local.models = { 'text-only': { capabilities: { images: false } } };
  const registry = new ProviderRegistry({ config });
  assert.equal(registry.getSlotStatus('vision').available, false);
  assert.equal(registry.getLlm('vision'), null);
  assert.equal(registry.getSlotStatus('llm').available, true);
  config.slots.vision.model = 'image-model';
  registry.reload(config);
  assert.equal(registry.getSlotStatus('vision').available, true);
});

test('configuration parse errors never echo malformed private contents', t => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-broken-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'providers.config.local.json'), `{${SECRET}`);
  const registry = new ProviderRegistry({ loadConfig: () => loadProvidersConfig({ repoRoot }) });
  assert.equal(registry.getSlotStatus('llm').available, false);
  assert.equal(registry.getSlotStatus('llm').reason.includes(SECRET), false);
});

test('llmChat preserves structured emotions, escaped chunks and sentence splitting with a fake provider', async () => {
  let received;
  const provider = { async *stream(request) {
    received = request;
    for (const delta of ['{"emotion":"sayang","te', 'xt":"Halo sayang. Aku ', 'suka angka 3.14!\\n', 'Sampai nanti."}']) {
      yield { type: 'text', delta };
    }
    yield { type: 'usage', inputTokens: 2, outputTokens: 4 };
    yield { type: 'done', finishReason: 'stop' };
  } };
  const controller = new AbortController();
  const events = await collect(generateReplyStream([], 'Halo', null, { signal: controller.signal, registry: fakeRegistry(provider) }));
  assert.deepEqual(events.filter(event => event.type === 'emotion'), [{ type: 'emotion', emotion: 'sayang' }]);
  assert.deepEqual(events.filter(event => event.type === 'sentence').map(event => event.text), ['Halo sayang.', 'Aku suka angka 3.14!', 'Sampai nanti.']);
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Halo sayang. Aku suka angka 3.14!\nSampai nanti.');
  assert.equal(received.json, true);
  assert.equal(received.signal, controller.signal);
});

test('STT keeps hallucination filtering identical and skips checks when any metadata is absent', async () => {
  let result;
  let received;
  const registry = fakeRegistry({ transcribe: async request => { received = request; return result; } });
  const transcribe = () => transcribeAudio(Buffer.from('fixture'), 'voice.ogg', { registry });
  result = { text: 'Aku sedang membaca.', segments: [{ text: 'a', noSpeechProb: 0.9 }] };
  assert.equal(await transcribe(), '');
  result = { text: 'Aku sedang membaca.', segments: [{ text: 'a', noSpeechProb: 0.1 }] };
  assert.equal(await transcribe(), result.text);
  result = { text: 'Aku sedang membaca.', segments: [{ text: 'a', noSpeechProb: 0.9 }, { text: 'b' }] };
  assert.equal(await transcribe(), result.text);
  result = { text: 'Aku sedang membaca.' };
  assert.equal(await transcribe(), result.text);
  result = { text: 'Terima kasih.' };
  assert.equal(await transcribe(), '');
  assert.equal(received.filename, 'voice.ogg');
  assert.equal(received.mime, 'audio/ogg');
  assert.ok(Buffer.isBuffer(received.audio));
});

test('TTS delegates canonical events while retaining existing Buffer output and emotion markers', async () => {
  let received;
  const registry = fakeRegistry({ async *stream(request) {
    received = request;
    yield { type: 'audio', data: Buffer.from('one'), format: 'mp3' };
    yield { type: 'audio', data: Buffer.from('two'), format: 'mp3' };
  } });
  const signal = new AbortController().signal;
  assert.deepEqual(await collect(generateSpeech('Halo', 'happy', { registry, signal })), [Buffer.from('one'), Buffer.from('two')]);
  assert.deepEqual(received, { text: 'Halo', emotion: 'happy', signal });
  for (const emotion of ['happy', 'sad', 'excited', 'surprised', 'shy']) assert.equal(withFishEmotion('Halo', emotion), `[${emotion}] Halo`);
  assert.equal(withFishEmotion('Halo', 'neutral'), 'Halo');
  assert.equal(withFishEmotion('Halo', 'unknown'), 'Halo');
});

test('Fish adapter uses the dynamic voice configuration when no override is requested', async t => {
  const { adapter, state } = await fixture(t, ADAPTER_CASES[2]);
  await collect(adapter.stream({ text: 'Halo' }));
  assert.equal(state.frames[0].request.reference_id, getVoiceId());
  assert.equal(state.frames[1].text, 'Halo');
});

test('unconfigured slots degrade gracefully without calling an adapter', async () => {
  const registry = new ProviderRegistry({ config: { profiles: {}, slots: {} } });
  const replies = await collect(generateReplyStream([], 'Halo', null, { registry }));
  assert.equal(replies.filter(event => event.type === 'sentence').map(event => event.text).join(' '), UNAVAILABLE_MESSAGES.llm);
  assert.equal(await transcribeAudio(Buffer.alloc(1), 'a.wav', { registry }), '');
  assert.deepEqual(await collect(generateSpeech('Halo', 'neutral', { registry })), []);
  assert.equal(await describeFrame('unused', 'screen', { registry }), UNAVAILABLE_MESSAGES.vision);
  const manager = new StreamingVisionManager({ registry, startTimer: false });
  await manager.handleContinuousFrame('unused');
  assert.equal(manager.stats.totalVisionCalls, 0);
  assert.equal((await manager.evaluateFilter([])).action, 'SKIP');
});

test('vision describe and monitor filter use their roles, image parts and canonical token totals', async () => {
  const roles = [];
  const requests = [];
  const registry = { getSlotStatus: () => ({ available: true }), getLlm(role) {
    roles.push(role);
    return { async complete(request) {
      requests.push(request);
      return { text: role === 'vision' ? 'Layar terbuka.' : '{"action":"COMMENT","text":"Wah, keren!","emotion":"kagum"}',
        inputTokens: 10, outputTokens: 4 };
    } };
  } };
  const image = `data:image/png;base64,${tinyPng().toString('base64')}`;
  assert.equal(await describeFrame(image, 'screen', { registry }), 'Layar terbuka.');
  const manager = new StreamingVisionManager({ registry, startTimer: false });
  manager.monitorConnected = true;
  await manager.handleContinuousFrame(image);
  const result = await manager.evaluateFilter(manager.buffer);
  assert.deepEqual(roles, ['vision', 'vision', 'visionFilter']);
  assert.equal(requests[0].messages[0].content[0].type, 'image');
  assert.equal(result.text, 'Wah, keren!');
  assert.equal(result.tokens, 14);
  assert.equal(manager.buffer[0].tokens, 14);
});

test('warm-up uses the optional visionFilter provider method and preserves cancellation', async () => {
  const signal = new AbortController().signal;
  const received = [];
  const registry = fakeRegistry({ async warmup(request) { received.push(request); return { text: 'hi', inputTokens: 1, outputTokens: 1 }; } });
  assert.equal((await warmUpModels({ signal, registry }))[0].status, 'fulfilled');
  assert.deepEqual(received, [{ signal }]);
  assert.equal((await warmUpModels({ registry: fakeRegistry({}) }))[0].value, null);
});

test('testSlot runs all slot probes against local fixtures and keeps overrides ephemeral', async t => {
  const httpFixture = await fixture(t, ADAPTER_CASES[0]);
  const fishFixture = await fixture(t, ADAPTER_CASES[2]);
  const config = localConfig();
  config.profiles.local = { ...httpFixture.profile, adapter: 'openaiCompatible' };
  config.profiles.fish = { ...fishFixture.profile, adapter: 'fishAudio' };
  config.slots.vision = { profile: 'local', model: 'vision-fixture' };
  config.slots.stt = { profile: 'local', model: 'stt-fixture' };
  config.slots.tts = { profile: 'fish', model: 'tts-fixture' };
  const registry = new ProviderRegistry({ config, secretResolver: { resolve: () => SECRET } });
  for (const slot of ['llm', 'vision', 'stt', 'tts', 'planner', 'visionFilter']) {
    const result = await testSlot(slot, { registry });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.latencyMs >= 0);
    if (slot !== 'stt') assert.ok(result.ttftMs >= 0);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
  const override = await testSlot('llm', { registry, profile: 'local', model: 'override' });
  assert.equal(override.details.model, 'override');
  assert.equal(registry.getSlotStatus('llm').model, 'fixture');
  assert.equal(tinyPng().readUInt32BE(16), 8);
  assert.equal(tinyPng().readUInt32BE(20), 8);
  assert.equal(shortWav().subarray(0, 4).toString(), 'RIFF');
});

test('provider CLI validates options, prints safe rows and returns a nonzero exit for failure', async () => {
  assert.deepEqual(parseArgs(['--slot=llm', '--model', 'model with spaces']), { slot: 'llm', model: 'model with spaces' });
  assert.throws(() => parseArgs(['--slot', 'unknown']), /Unknown slot/);
  let rows;
  const code = await runCli(['--slot', 'llm'], { print: value => { rows = value; }, probe: async slot => ({
    ok: false, latencyMs: 2, details: { slot, profile: 'local', model: 'fixture' }, error: { code: 'AUTH', message: 'Check key.' },
  }) });
  assert.equal(code, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].error, 'AUTH: Check key.');
});
