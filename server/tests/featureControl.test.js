import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installSelfieFeatureControl, disabledSelfieResult } from '../selfie/featureControl.js';
import { prepareSelfieJob } from '../selfie/backendLifecycle.js';
import { SpeechController } from '../speechController.js';

function harness(socket = {}) {
  const events = [];
  let snapshots = 0;
  const snapshot = { type: 'selfie_snapshot', activeJobId: 'active-job',
    events: [{ type: 'selfie_started', jobId: 'active-job', etaSeconds: null }] };
  const manager = {
    config: { outputDir: 'configured/selfies' },
    sendSnapshot(send) { snapshots++; send(snapshot); },
  };
  const handle = installSelfieFeatureControl({ socket, manager, send: event => events.push(event) });
  return { socket, manager, handle, events, get snapshots() { return snapshots; } };
}

test('feature control defaults enabled without sending or accepting malformed settings', () => {
  const h = harness();
  assert.equal(h.socket.selfieEnabled, true);
  assert.deepEqual(h.events, []);
  for (const message of [null, {}, { type: 'text_input', enabled: false },
    { type: 'selfie_feature' }, { type: 'selfie_feature', enabled: 'false' },
    { type: 'selfie_feature', enabled: 0 }]) {
    assert.equal(h.handle(message), false);
  }
  assert.equal(h.socket.selfieEnabled, true);
  assert.equal(h.snapshots, 0);
  assert.deepEqual(h.events, []);
});

test('disabling confirms feature state without output paths and re-enabling restores the snapshot', () => {
  const h = harness();
  assert.equal(h.handle({ type: 'selfie_feature', enabled: false }), true);
  assert.equal(h.socket.selfieEnabled, false);
  assert.equal(h.snapshots, 0);
  assert.deepEqual(h.events, [{ type: 'selfie_feature', enabled: false }]);
  assert.equal(disabledSelfieResult(h.socket).reason, 'FEATURE_DISABLED');

  assert.equal(h.handle({ type: 'selfie_feature', enabled: true }), true);
  assert.equal(h.snapshots, 1);
  assert.equal(disabledSelfieResult(h.socket), null);
  assert.deepEqual(h.events.slice(1), [
    { type: 'selfie_feature', enabled: true },
    { type: 'selfie_snapshot', activeJobId: 'active-job',
      events: [{ type: 'selfie_started', jobId: 'active-job', etaSeconds: null }] },
  ]);
});

test('feature control remains per socket and preserves a supplied setting', () => {
  const first = harness({ selfieEnabled: false });
  const second = harness();
  assert.equal(first.socket.selfieEnabled, false);
  assert.equal(disabledSelfieResult(second.socket), null);
  first.handle({ type: 'selfie_feature', enabled: true });
  second.handle({ type: 'selfie_feature', enabled: false });
  assert.equal(disabledSelfieResult(first.socket), null);
  assert.equal(disabledSelfieResult(second.socket).reason, 'FEATURE_DISABLED');
  assert.deepEqual(first.manager.config, { outputDir: 'configured/selfies' });
  assert.deepEqual(second.manager.config, { outputDir: 'configured/selfies' });
});

test('the real selfie input branch skips provider and planner while disabled and still replies', async () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf("    if (msg.type !== 'audio_input' && msg.type !== 'text_input') return;");
  const end = source.indexOf('\n  });\n});', start);
  assert.ok(start >= 0 && end > start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('socket', 'speechController', 'history', 'msg',
    'detectSelfieIntent', 'markConversationActivity', 'disabledSelfieResult',
    'prepareSelfieJob', 'jobManager', 'planSelfie', 'playSpokenMessage', source.slice(start, end));
  const socket = { selfieEnabled: false };
  const events = [];
  const history = [];
  let providers = 0;
  let planners = 0;
  let submissions = 0;
  const controller = new SpeechController({
    generateSpeech: async function* () {},
    isVoiceConfigured: () => false,
  });
  controller.register(socket, event => events.push(event));
  const jobManager = {
    tryAdmit: () => ({ allowed: true, jobId: 'fake-job' }),
    getProvider: async () => { providers++; return { isAvailable: async () => true }; },
    isAdmitted: () => true,
    submitJob: async () => { submissions++; return { ok: true }; },
    cancelJob: async () => {},
    pickPhrase: () => 'Tunggu ya sayang.',
  };
  const planner = async () => { planners++; return { ok: true, plan: { caption: 'Ini fotoku.' } }; };
  const playSpokenMessage = (text, emotion, target, turnId) => controller.play({
    text, emotion, recipients: [target], turnId,
  });
  const input = () => run(socket, controller, history, { type: 'text_input', text: 'pap dong' },
    () => ({ isSelfie: true, matchedKeyword: 'pap' }), () => {}, disabledSelfieResult,
    prepareSelfieJob, jobManager, planner, playSpokenMessage);
  try {
    await input();
    assert.equal(providers, 0);
    assert.equal(planners, 0);
    assert.equal(submissions, 0);
    assert.equal(socket.conversationState, 'idle');
    assert.ok(events.some(event => event.type === 'amika_replied' && event.text === disabledSelfieResult(socket).text));

    socket.selfieEnabled = true;
    await input();
    assert.equal(providers, 1);
    assert.equal(planners, 1);
    assert.equal(submissions, 1);
    assert.equal(socket.conversationState, 'idle');
    assert.equal(history.at(-1).content, 'Ini fotoku.');
  } finally {
    controller.unregister(socket);
  }
});
