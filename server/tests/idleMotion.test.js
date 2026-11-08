import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { IDLE_MOTION_BANK, IdleMotionController, composeIdlePose, applyIdlePhysicsBodyOffsets } from '../../src/idleMotion.js';
import { applyMotionOffsets, resolveMotionParameters } from '../../src/speechMotion.js';
import { resolvePhysicsBodyParameters } from '../../src/bodyMotion.js';

const keys = ['headX', 'headY', 'headZ', 'eyeX', 'eyeY', 'browL', 'browR', 'bodyX', 'bodyY', 'bodyZ'];
function random(seed = 42) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
function step(controller, seconds, options = {}, fps = 60) {
  let result;
  for (let frame = 0; frame < Math.round(seconds * fps); frame++) result = controller.update(1 / fps, options);
  return result;
}
const magnitude = value => Math.max(...keys.map(key => Math.abs(value[key])));

test('the authored bank contains fifteen distinct ordinary poses with four to nine second default clips', () => {
  assert.equal(IDLE_MOTION_BANK.length, 15);
  assert.equal(new Set(IDLE_MOTION_BANK.map(item => item.name)).size, 15);
  assert.ok(IDLE_MOTION_BANK.every(item => item.duration >= 4 && item.duration <= 9 && item.weight > 0));
  for (const item of IDLE_MOTION_BANK) {
    assert.deepEqual(Object.keys(item.peak).sort(), [...keys].sort());
    assert.ok(Object.values(item.peak).every(Number.isFinite));
  }
});

test('idle movement starts without an audio clock, camera or connection and does not repeat adjacent choices', () => {
  const controller = new IdleMotionController({ random: random() });
  const choices = [];
  let last;
  let headPeak = 0, bodyPeak = 0, gazePeak = 0, browPeak = 0;
  for (let frame = 0; frame < 60 * 240; frame++) {
    const output = controller.update(1 / 60);
    if (output.motion !== last) { choices.push(output.motion); last = output.motion; }
    headPeak = Math.max(headPeak, Math.abs(output.headX), Math.abs(output.headY), Math.abs(output.headZ));
    bodyPeak = Math.max(bodyPeak, Math.abs(output.bodyX), Math.abs(output.bodyY), Math.abs(output.bodyZ));
    gazePeak = Math.max(gazePeak, Math.abs(output.eyeX), Math.abs(output.eyeY));
    browPeak = Math.max(browPeak, Math.abs(output.browL), Math.abs(output.browR));
  }
  assert.ok(choices.length > 30);
  assert.ok(new Set(choices).size >= 12);
  assert.ok(choices.every((choice, index) => !index || choice !== choices[index - 1]));
  assert.ok(headPeak > 7 && headPeak < 12);
  assert.ok(bodyPeak > 0.6 && bodyPeak < 1);
  assert.ok(gazePeak > 0.2 && gazePeak < 0.3);
  assert.ok(browPeak > 0.05 && browPeak < 0.1);
});

test('a running motion finishes before selection and transitions retain the visible pose', () => {
  const controller = new IdleMotionController({ random: () => 0 });
  controller.update(1 / 60);
  const first = controller.current;
  let previous = { ...controller.pose };
  let headStep = 0, bodyStep = 0;
  let changed = false;
  for (let frame = 0; frame < 60 * 12; frame++) {
    const output = controller.update(1 / 60);
    if (controller.time < first.startAt + first.duration - 1e-8) assert.equal(output.motion, first.name);
    if (output.motion !== first.name) changed = true;
    headStep = Math.max(headStep, Math.abs(output.headX - previous.headX));
    bodyStep = Math.max(bodyStep, Math.abs(output.bodyX - previous.bodyX));
    previous = output;
  }
  assert.ok(changed);
  assert.ok(headStep < 0.3, `head transition step ${headStep}`);
  assert.ok(bodyStep < 0.02, `torso transition step ${bodyStep}`);
});

test('playback suppresses idle motions and a short sentence gap cannot restart the bank', () => {
  const controller = new IdleMotionController({ random: () => 0 });
  const before = step(controller, 2);
  assert.ok(magnitude(before) > 1);
  const fade = controller.update(1 / 60, { speaking: true });
  assert.equal(fade.motion, null);
  assert.ok(magnitude(fade) > 0 && magnitude(fade) < magnitude(before));
  step(controller, 1, { speaking: true });
  const held = step(controller, 0.2);
  assert.equal(held.motion, null);
  controller.update(1 / 60, { speaking: true });
  step(controller, 0.2);
  assert.equal(controller.current, null);
  step(controller, 0.2);
  assert.notEqual(controller.current, null);
});

test('muting and model disposal fade or reset old idle poses, with no invalid timing or output', () => {
  const options = { strength: 1 };
  const controller = new IdleMotionController({ getOptions: () => options, random: () => 0 });
  const before = step(controller, 2);
  options.strength = 0;
  const first = controller.update(1 / 60);
  assert.ok(magnitude(first) > 0 && magnitude(first) < magnitude(before));
  const silent = step(controller, 2);
  assert.ok(magnitude(silent) < 0.001);
  assert.ok(silent.trackingWeight > 0.999);
  assert.equal(silent.motion, null);
  controller.reset();
  assert.equal(magnitude(controller.pose), 0);
  assert.equal(controller.lastName, null);
  const time = controller.time;
  for (const delta of [NaN, Infinity, -1, 0]) controller.update(delta);
  assert.equal(controller.time, time);
  assert.ok(keys.every(key => Number.isFinite(controller.pose[key])));
});

test('authored poses and speech transitions agree at thirty and sixty frames per second', () => {
  function simulate(fps) {
    const controller = new IdleMotionController({ random: random(31) });
    const checkpoints = [];
    for (let second = 0; second < 24; second++) {
      const output = step(controller, 1, { speaking: second >= 8 && second < 10 }, fps);
      checkpoints.push({ output, current: controller.current?.name });
    }
    return checkpoints;
  }
  const at30 = simulate(30), at60 = simulate(60);
  for (let index = 0; index < at30.length; index++) {
    assert.equal(at30[index].current, at60[index].current);
    for (const key of keys) assert.ok(Math.abs(at30[index].output[key] - at60[index].output[key]) < 1e-8,
      `${key} at second ${index + 1}`);
  }
});

test('idle strength and pace use their own bounds, while a recorded idle bank can retain its behavior', () => {
  const options = { strength: 2, pace: 2 };
  const controller = new IdleMotionController({ getOptions: () => options, random: () => 0 });
  controller.update(1 / 60);
  assert.equal(controller.current.duration, IDLE_MOTION_BANK[0].duration / 2);
  const fast = step(controller, 1.2);
  assert.ok(Math.abs(fast.headX) > 10);
  const stopped = step(controller, 2, { enabled: false });
  assert.equal(stopped.motion, null);
  assert.ok(magnitude(stopped) < 0.001);
});

test('tracking is reduced smoothly under a bank and missing or nonfinite channels stay finite', () => {
  const controller = new IdleMotionController({ random: () => 0 });
  const bank = step(controller, 1);
  const combined = composeIdlePose({ headX: 3, headY: NaN, eyeX: 0.2, bodyX: Infinity }, bank);
  assert.ok(Math.abs(combined.headX - bank.headX - 3 * 0.25) < 0.001);
  assert.equal(combined.headY, bank.headY);
  assert.equal(combined.bodyX, bank.bodyX);
  assert.ok(Object.values(combined).every(Number.isFinite));
  assert.equal(composeIdlePose({ headX: 3 }).headX, 3);
});

test('real parameter writes respect the rig, preserving mouth, blinking and unrelated physics controls', () => {
  const ids = ['ParamAngleX', 'ParamBodyAngleX', 'ParamMouthOpenY', 'ParamEyeLOpen', 'ParamHair', 'Param41'];
  const available = new Map(ids.map((id, index) => [id, { id, index, min: -1, max: 1, defaultValue: 0 }]));
  const outputs = new Set(['ParamBodyAngleX', 'ParamHair']);
  const values = [0, 0, 0.4, 0.8, 0.3, 0.6];
  const writes = [];
  const model = { getParameterCount: () => values.length, getParameterValueByIndex: index => values[index],
    setParameterValueByIndex(index, value) { values[index] = value; writes.push(index); } };
  const bank = { headX: 1000, bodyX: 1000, bodyY: NaN };
  applyMotionOffsets(model, resolveMotionParameters(available, outputs), {}, composeIdlePose({}, bank));
  applyIdlePhysicsBodyOffsets(model, resolvePhysicsBodyParameters(available, outputs), bank);
  assert.deepEqual(values, [1, 1, 0.4, 0.8, 0.3, 0.6]);
  assert.ok(writes.every(index => index === 0 || index === 1));
  applyIdlePhysicsBodyOffsets(model, { bodyX: { body: { index: 100, min: -1, max: 1 } } }, bank);
  applyIdlePhysicsBodyOffsets(model, {}, bank);
  assert.deepEqual(values, [1, 1, 0.4, 0.8, 0.3, 0.6]);
});

test('the browser model uses actual speech cues, not early queued playback, for idle priority', () => {
  const source = fs.readFileSync(new URL('../../src/live2dCompanion.js', import.meta.url), 'utf8');
  const start = source.indexOf('  update(delta, mouthLevel, speaking, audioTime) {');
  const method = source.slice(start, source.indexOf('\n  /**', start));
  const calls = [], pipeline = [];
  const context = vm.createContext({ console: { log() {} }, tuning: { get: () => 14 },
    composeIdlePose, applyMotionOffsets: () => pipeline.push('pose'),
    applyIdlePhysicsBodyOffsets: () => pipeline.push('idleBody') });
  vm.runInContext(`class Model { ${method} }; globalThis.Model = Model;`, context);
  const model = new context.Model();
  Object.assign(model, { ready: true, speechMotion: { update: time => ({ active: time >= 5 && time < 7 }) },
    idleMotion: { update(delta, options) { calls.push(options); return { bodyX: 0, bodyY: 0, bodyZ: 0 }; } },
    motionFor: () => null, _model: { loadParameters() {}, saveParameters() {}, update() {} },
    _motionManager: { isFinished: () => true, updateMotion() {} },
    actionMotionManager: { isFinished: () => true }, _expressionManager: { updateMotion() {} },
    syntheticTracker: { sample: () => ({}) }, bodyMotion: { parameters: {}, update() { pipeline.push('body'); } },
    _physics: { evaluate() { pipeline.push('physics'); } }, physicsFrameCount: 1,
    mouthParameterIndex: -1, smoothedMouth: 0, setEmotion() {} });
  model.update(1 / 60, 0, true, 4);
  model.update(1 / 60, 0, true, 5);
  model.update(1 / 60, 0, false, 7);
  assert.deepEqual(calls.map(item => item.speaking), [false, true, false]);
  assert.ok(calls.every(item => item.enabled));
  assert.deepEqual(pipeline.slice(0, 4), ['pose', 'body', 'idleBody', 'physics']);
});
