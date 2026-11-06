import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FISH_EMOTION_NAMES } from '../fishEmotionTags.js';
import { StreamingVisionManager } from '../streamingVisionManager.js';
import { planSelfie } from '../selfie/planner.js';
import { JobManager } from '../selfie/jobManager.js';
import { loadSelfieConfig } from '../selfie/config.js';

function fakeRegistry(params = {}, ttsAvailable = true) {
  return {
    getSlotStatus: slot => ({ available: slot === 'tts' ? ttsAvailable : true }),
    getTts: () => ({ params }),
  };
}

function visionHarness(reply, params = {}, ttsAvailable = true) {
  const requests = [];
  const registry = { ...fakeRegistry(params, ttsAvailable), getLlm: role => {
    assert.equal(role, 'visionFilter');
    return { complete: async request => {
      requests.push(request);
      return { text: JSON.stringify(reply) };
    } };
  } };
  const manager = new StreamingVisionManager({ registry, startTimer: false });
  const events = [];
  const speeches = [];
  const history = [];
  manager.setBroadcaster(event => events.push(event));
  manager.setHistoryRef(history);
  manager.setSpeechHandler((text, emotion, options) => speeches.push({ text, emotion, ...options }));
  return { manager, requests, events, speeches, history };
}

const COMMENT = { action: 'COMMENT', emotion: 'sayang', text: 'Aku bangga sama kamu!' };
const BUFFER = [{ timestamp: '12:00:00', description: 'Pemain menang.' }];
const CAPTION = { caption: 'Ini fotonya, sayang.', emotion: 'sayang', pose: 'holding_camera' };

async function selfie(reply, { params = {}, ttsAvailable = true, userText = 'pap dong sayang' } = {}) {
  const requests = [];
  const result = await planSelfie({ userText, registry: fakeRegistry(params, ttsAvailable),
    llmProvider: { complete: async request => {
      requests.push(request);
      return { text: JSON.stringify(reply) };
    } },
  });
  return { result, requests };
}

test('all 49 native visual choices keep the avatar emotion and use one existing filter call', async () => {
  for (const speechEmotion of FISH_EMOTION_NAMES) {
    const h = visionHarness({ ...COMMENT, speechEmotion }, { speechStyle: { enabled: false } });
    const result = await h.manager.evaluateFilter(BUFFER);
    assert.equal(result.speechEmotion, speechEmotion);
    assert.equal(result.emotion, 'sayang');
    await h.manager.executeSpontaneousCommentary(result.text, result.emotion, result);
    assert.deepEqual(h.speeches, [{ text: COMMENT.text, emotion: 'sayang', speechEmotion }]);
    assert.equal(h.requests.length, 1);
    assert.match(h.requests[0].messages[0].content, /speechEmotion/);
    assert.deepEqual(h.history, [{ role: 'assistant', content: COMMENT.text }]);
    assert.equal(h.events.some(event => 'speechEmotion' in event), false);
  }
});

test('visual mapped mode or missing TTS omits native instructions and choices', async () => {
  for (const [params, available] of [[{ expression: { selection: 'mapped' } }, true], [{}, false]]) {
    const h = visionHarness({ ...COMMENT, speechEmotion: 'proud' }, params, available);
    const result = await h.manager.evaluateFilter(BUFFER);
    assert.equal(result.speechEmotion, undefined);
    assert.doesNotMatch(h.requests[0].messages[0].content, /speechEmotion/);
    assert.equal(result.emotion, 'sayang');
  }
});

test('visual unknown, bracketed or missing speech metadata falls back without changing display', async () => {
  for (const speechEmotion of [undefined, 'made-up', '[proud]', 'Proud', { name: 'proud' }]) {
    const h = visionHarness({ ...COMMENT, speechEmotion });
    const result = await h.manager.evaluateFilter(BUFFER);
    assert.equal(result.speechEmotion, undefined);
    assert.equal(result.text, COMMENT.text);
    assert.equal(result.emotion, 'sayang');
  }
});

test('visual performance tags stay out of monitor events and history while allowed cues reach speech', async () => {
  const h = visionHarness({ ...COMMENT, text: '[proud][laughs] Wah! [invented] Aku senang.', speechEmotion: 'proud' },
    { inlineTags: { enabled: true, allowList: ['laughs'] } });
  const result = await h.manager.evaluateFilter(BUFFER);
  assert.doesNotMatch(result.text, /\[|\]/);
  assert.match(result.speechText, /\[laughs\]/);
  await h.manager.executeSpontaneousCommentary(result.speechText, result.emotion, result);
  assert.match(h.speeches[0].text, /\[laughs\]/);
  assert.equal(h.speeches[0].speechEmotion, 'proud');
  assert.doesNotMatch(JSON.stringify(h.events), /\[laughs\]|\[proud\]|\[invented\]/);
  assert.doesNotMatch(h.history[0].content, /\[|\]/);
});

test('all 49 native selfie choices stay outside image slots, prompts and moderation', async () => {
  const baseline = (await selfie(CAPTION)).result;
  assert.equal(baseline.ok, true);
  for (const speechEmotion of FISH_EMOTION_NAMES) {
    const { result, requests } = await selfie({ ...CAPTION, speechEmotion }, { params: { speechStyle: { enabled: false } } });
    assert.equal(result.ok, true);
    assert.equal(result.blocked, false);
    assert.equal(result.plan.speechEmotion, speechEmotion);
    assert.equal(result.plan.emotion, 'sayang');
    assert.deepEqual(result.plan.slots, baseline.plan.slots);
    assert.equal(result.plan.positivePrompt, baseline.plan.positivePrompt);
    assert.equal(result.plan.negativePrompt, baseline.plan.negativePrompt);
    assert.equal(result.plan.referenceImage, baseline.plan.referenceImage);
    assert.equal(requests.length, 1);
    assert.match(requests[0].messages[0].content, /speechEmotion/);
    assert.match(requests[0].messages[0].content, /FORBIDDEN.*free-form image prompts/);
  }
});

test('selfie mapped, unavailable and invalid metadata retain the legacy caption plan', async () => {
  for (const options of [{ params: { expression: { selection: 'mapped' } } }, { ttsAvailable: false }]) {
    const { result, requests } = await selfie({ ...CAPTION, speechEmotion: 'compassionate' }, options);
    assert.equal(result.plan.speechEmotion, undefined);
    assert.doesNotMatch(requests[0].messages[0].content, /speechEmotion/);
  }
  for (const speechEmotion of [undefined, '[compassionate]', 'unknown', 'nude', ['sad']]) {
    const { result } = await selfie({ ...CAPTION, speechEmotion });
    assert.equal(result.ok, true);
    assert.equal(result.plan.speechEmotion, undefined);
    assert.equal(result.plan.caption, CAPTION.caption);
  }
});

test('speech metadata does not bypass selfie moderation or introduce a generation call', async () => {
  const results = [];
  for (const speechEmotion of ['compassionate', 'angry', 'nude']) {
    const { result, requests } = await selfie({ ...CAPTION, speechEmotion }, { userText: 'pap telanjang dong' });
    const { ok, blocked, reason, matchedWord, emotion } = result;
    results.push({ ok, blocked, reason, matchedWord, emotion });
    assert.equal(requests.length, 0);
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'FORBIDDEN_CONTENT');
    assert.equal(result.speechEmotion, undefined);
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], results[2]);
});

test('selfie captions strip displayed tags while preserving allowed speech cues internally', async () => {
  const { result } = await selfie({ ...CAPTION, caption: '[compassionate][sigh] Ini fotonya. (angry) [unknown]', speechEmotion: 'compassionate' },
    { params: { inlineTags: { enabled: true, allowList: ['sigh'] } } });
  assert.doesNotMatch(result.plan.caption, /\[|\]|\(angry\)/);
  assert.equal(result.plan.slots.caption, result.plan.caption);
  assert.match(result.plan.captionSpeechText, /\[sigh\]/);
  assert.equal(result.plan.speechEmotion, 'compassionate');
  assert.equal('speechEmotion' in result.plan.slots, false);
});

function jobHarness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-selfie-tests-'));
  const manager = new JobManager({ ...loadSelfieConfig(), cooldownMs: 0, dailyLimit: 10, maxQueue: 2,
    freeVramAfter: false, limitsStorePath: path.join(directory, 'limits.json'), etaStorePath: path.join(directory, 'eta.json') });
  const speeches = [];
  const events = [];
  const imageRequests = [];
  manager.setSpeechHandler(message => speeches.push(message));
  manager.setBroadcaster(event => events.push(event));
  manager.provider = { name: 'fake', isAvailable: async () => true, release: async () => {},
    generate: async params => {
      imageRequests.push(params);
      return { imagePath: path.join(directory, 'fake.png') };
    } };
  t.after(async () => {
    await manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { manager, speeches, events, imageRequests };
}

test('selfie job speech snapshots native metadata and fixed messages retain mapped emotions', async t => {
  const h = jobHarness(t);
  const { result } = await selfie({ ...CAPTION, speechEmotion: 'compassionate' });
  const submitted = await h.manager.submitJob({ plan: result.plan });
  assert.equal(submitted.ok, true);
  result.plan.speechEmotion = 'angry';
  await Promise.all([...h.manager._runTasks]);
  assert.equal(h.speeches.length, 2);
  assert.equal(h.speeches[0].speechEmotion, undefined);
  assert.equal(h.speeches[0].emotion, 'sayang');
  assert.deepEqual(h.speeches[1], { text: CAPTION.caption, emotion: 'sayang', speechEmotion: 'compassionate' });
  assert.equal(h.imageRequests[0].speechEmotion, undefined);
  assert.equal(h.events.some(event => 'speechEmotion' in event), false);
  assert.equal(h.events.find(event => event.type === 'selfie_ready').emotion, 'sayang');
});

test('direct selfie plans publish tag-free captions and reject tag-only captions without leaking a reservation', async t => {
  const h = jobHarness(t);
  const plan = { slots: {}, positivePrompt: 'portrait', negativePrompt: 'blur', caption: '[proud] Ini fotonya.',
    emotion: 'sayang', speechEmotion: 'proud' };
  assert.equal((await h.manager.submitJob({ plan, skipInitialSpeech: true })).ok, true);
  await Promise.all([...h.manager._runTasks]);
  assert.equal(h.events.find(event => event.type === 'selfie_ready').caption, ' Ini fotonya.');
  assert.equal(h.speeches[0].speechEmotion, 'proud');
  const admission = h.manager.tryAdmit();
  assert.equal(admission.allowed, true);
  const invalid = await h.manager.submitJob({ plan: { ...plan, caption: '[proud]' }, admission });
  assert.equal(invalid.reason, 'INVALID_PLAN');
  assert.equal(h.manager.isAdmitted(admission.jobId), false);
});
