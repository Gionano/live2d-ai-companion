import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { migrateConversationDefaults } from '../../src/conversationDefaults.js';

function store() {
  const rawConfig = JSON.parse(fs.readFileSync(new URL('../../config/animationConfig.json', import.meta.url), 'utf8'));
  const source = fs.readFileSync(new URL('../../src/tuningConfig.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export const tuning', 'globalThis.tuning');
  const context = vm.createContext({ rawConfig, console, structuredClone, migrateConversationDefaults });
  vm.runInContext(source, context);
  return context.tuning;
}

test('camera monitoring and quiet conversation start enabled on reload and reset', () => {
  for (const key of ['vision.webcamMonitoring', 'conversation.proactiveEnabled']) {
    const tuning = store();
    assert.equal(tuning.get(key), 'on');
    tuning.set(key, 'off');
    assert.equal(store().get(key), 'on');
    tuning.resetAll();
    assert.equal(tuning.get(key), 'on');
  }
  assert.equal(store().get('conversation.proactiveDelaySeconds'), 30);
});

test('tuning loads the structured server response without introducing NaN', () => {
  const tuning = store();
  const schema = JSON.parse(JSON.stringify(tuning.getSchema()));
  schema.talking.gestureStrength.value = 1.5;
  tuning.importValues(schema);
  assert.equal(tuning.get('talking.gestureStrength'), 1.5);
  assert.equal(tuning.get('talking.lipSyncGain'), 1.8);
  for (const group of Object.values(tuning.exportValues())) {
    for (const value of Object.values(group)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
  }
});

test('legacy flat settings remain readable and new controls keep defaults', () => {
  const tuning = store();
  tuning.importValues({ talking: { l1SineFreqX: 4.3, l2ProbTinggi: 0.85, lipSyncGain: 2.4 },
    tracking: { headRangeX: 15 } });
  assert.equal(tuning.get('talking.lipSyncGain'), 2.4);
  assert.equal(tuning.get('tracking.headRangeX'), 6);
  assert.equal(tuning.get('talking.gestureStrength'), 1);
  assert.equal(tuning.get('talking.bodyGestureStrength'), 1);
  assert.equal(tuning.get('talking.l1SineFreqX'), undefined);
  assert.equal(tuning.get('banks.enabled'), 'on');
  assert.equal(tuning.get('banks.speechBlendWeight'), 0.35);
  assert.equal(tuning.get('banks.symbolDurationMs'), 1500);
  tuning.importValues({ banks: { symbolSize: 1.25, poseStrength: 0.7 } });
  assert.equal(tuning.get('banks.symbolSize'), 1.25);
  assert.equal(tuning.get('talking.lipSyncGain'), 2.4);
});

test('torso strength persists independently of head strength and retains valid slider values', () => {
  const tuning = store();
  tuning.set('talking.bodyGestureStrength', 1.6);
  assert.equal(tuning.get('talking.gestureStrength'), 1);
  assert.equal(tuning.get('talking.bodyLeanStrength'), 1);

  const restored = store();
  restored.importValues(tuning.exportValues());
  assert.equal(restored.get('talking.bodyGestureStrength'), 1.6);
  restored.importValues({ talking: { bodyGestureStrength: { value: 5 }, gestureStrength: 0.75 } });
  assert.equal(restored.get('talking.bodyGestureStrength'), 2);
  assert.equal(restored.get('talking.gestureStrength'), 0.75);
  restored.importValues({ talking: { bodyGestureStrength: 'invalid' } });
  assert.equal(restored.get('talking.bodyGestureStrength'), 2);
  restored.set('talking.bodyGestureStrength', -1);
  assert.equal(restored.get('talking.bodyGestureStrength'), 0);
  restored.resetGroup('talking');
  assert.equal(restored.get('talking.bodyGestureStrength'), 1);
});

test('invalid saved values are ignored and slider limits are enforced', () => {
  const tuning = store();
  tuning.importValues({ talking: { gestureStrength: 'bad', bodyLeanStrength: null, gestureFrequency: { value: 100 } }, tracking: null });
  assert.equal(tuning.get('talking.gestureStrength'), 1);
  assert.equal(tuning.get('talking.bodyLeanStrength'), 1);
  assert.equal(tuning.get('talking.gestureFrequency'), 2);
});
