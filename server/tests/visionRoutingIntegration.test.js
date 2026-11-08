import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ConversationVisionRouter } from '../visionRouting.js';
import { inspectVision } from '../explicitVision.js';
import { StreamingVisionManager } from '../streamingVisionManager.js';
import { SpeechController } from '../speechController.js';
import { playConversationReply } from '../conversationSpeech.js';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const start = source.indexOf("    if (msg.type !== 'audio_input' && msg.type !== 'text_input') return;");
const end = source.indexOf('\n  });\n});', start);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const input = new AsyncFunction('socket', 'speechController', 'visionRouter', 'visionManager', 'history', 'msg',
  'transcribeAudio', 'extFromMime', 'detectSelfieIntent', 'markConversationActivity', 'HISTORY_MESSAGE_LIMIT',
  'memoryManager', 'getSlotStatus', 'proactiveConversation', 'visionSessions', 'playConversationReply',
  'inspectVision', 'requestScreenCapture', 'UNAVAILABLE_MESSAGES', 'disabledSelfieResult', 'playSpokenMessage',
  'speechMemoryRecorder', 'trimConversationHistory', source.slice(start, end));

function harness(t, target = 'conversation') {
  const events = [];
  const requests = [];
  const memories = [];
  const history = [];
  const socket = { captureSessions: { screen: { active: true, sessionId: 'screen-1' },
    webcam: { active: true, sessionId: 'camera-1' } }, explicitVisionControllers: new Map() };
  const registry = { getSlotStatus: role => ({ available: role !== 'surface' }), getTts: () => ({ params: {} }),
    getLlm: role => ({ complete: async request => {
      requests.push({ role, request });
      return { text: JSON.stringify({ target, question: 'fixture-private-resolved-question' }) };
    }, async *stream(request) {
      requests.push({ role, request });
      yield { type: 'text', delta: '{"segments":[{"emotion":"netral","text":"Aku mengerti maksudmu."}]}' };
    } }) };
  const controller = new SpeechController({ generateSpeech: async function* () {}, isVoiceConfigured: () => false });
  controller.register(socket, event => events.push(event));
  const router = new ConversationVisionRouter({ registry });
  const manager = new StreamingVisionManager({ registry, startTimer: false });
  t.after(() => { router.dispose(); manager.dispose(); controller.unregister(socket); });
  const run = (message, selfie = false) => input(socket, controller, router, manager, history, message,
    async () => message.transcription ?? 'Kenapa Manaka ini suka Tsumugu?', () => 'webm', () => ({ isSelfie: selfie }),
    () => {}, 8, { recordTurnAndExtract: (...args) => memories.push(args) }, registry.getSlotStatus,
    { updateSettings() {}, setUserActive() {}, consumeGuidance: () => ({}) }, new Map(),
    options => playConversationReply({ ...options, registry }), options => inspectVision({ ...options,
      describe: async (frame, source, options) => { requests.push({ role: 'vision', source, options }); return 'Verified ' + source; } }),
    async () => ({ ok: false, spoken: 'Layar tidak bisa dilihat.' }), { vision: 'Vision unavailable.' },
    () => ({ ok: false, text: 'Foto belum tersedia.', emotion: 'netral' }),
    (text, emotion, socket, turnId) => controller.play({ text, emotion, recipients: [socket], turnId }),
    { context: () => null }, history => history);
  return { run, events, requests, history, memories };
}

for (const text of ['Tapi ini kan genre love polygon', 'Kenapa Manaka ini suka Tsumugu?', 'Kamu pernah lihat anime ini?']) {
  test('actual typed handler retains anime conversation despite supplied camera frames: ' + text, async t => {
    const h = harness(t);
    h.history.push({ role: 'user', content: 'Aku baru menonton Nagi no Asukara.' });
    await h.run({ type: 'text_input', text, image: 'camera-frame', screenImage: 'screen-frame' });
    assert.equal(h.requests.some(request => request.role === 'vision'), false);
    assert.equal(h.events.some(event => event.type === 'vision' || event.type === 'routing_status'), false);
    assert.equal(h.history.at(-2).content, text);
    assert.equal(h.history.at(-1).content, 'Aku mengerti maksudmu.');
    assert.doesNotMatch(JSON.stringify([h.history, h.events, h.memories]), /fixture-private-resolved-question/);
  });
}

test('actual STT handler routes after transcription and keeps private decisions out of memory', async t => {
  const h = harness(t);
  await h.run({ type: 'audio_input', data: Buffer.alloc(600).toString('base64'), image: 'camera-frame' });
  assert.equal(h.requests.filter(request => request.role === 'router').length, 1);
  const context = JSON.parse(h.requests.find(request => request.role === 'router').request.messages[1].content);
  assert.equal(context.message, 'Kenapa Manaka ini suka Tsumugu?');
  assert.equal(h.history.at(-2).content, 'Kenapa Manaka ini suka Tsumugu?');
  assert.equal(h.memories.length, 0, 'Text-only output cannot establish completed speech evidence');
  assert.doesNotMatch(JSON.stringify(h.memories), /fixture-private-resolved-question/);
});

test('actual contextual visual request sends the private question only to vision and stores original user text', async t => {
  const h = harness(t, 'webcam');
  await h.run({ type: 'text_input', text: 'Lihat ini', image: 'camera-frame',
    captureSessions: { webcam: 'camera-1', screen: 'screen-1' } });
  assert.equal(h.requests.filter(request => request.role === 'router').length, 1);
  assert.equal(h.requests.filter(request => request.role === 'vision').length, 1);
  assert.equal(h.requests.find(request => request.role === 'vision').options.question, 'fixture-private-resolved-question');
  assert.equal(h.history.at(-2).content, 'Lihat ini');
  assert.doesNotMatch(JSON.stringify([h.history, h.events, h.memories]), /fixture-private-resolved-question/);
  const prompt = h.requests.find(request => request.role === 'llm').request.messages[0].content;
  assert.match(prompt, /requested fresh inspection/);
  assert.doesNotMatch(prompt, /User sedang menunjukkan/);
});

test('PAP admission retains priority and bypasses router and visual inspection', async t => {
  const h = harness(t);
  await h.run({ type: 'text_input', text: 'Minta foto dong', image: 'camera-frame' }, true);
  assert.equal(h.requests.length, 0);
  assert.equal(h.history.at(-1).content, 'Foto belum tersedia.');
});
