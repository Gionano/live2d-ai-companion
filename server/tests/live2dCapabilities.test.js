import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelCapabilities, resolveMotionParameters, applyMotionOffsets } from '../../src/speechMotion.js';

function parameters(ids) {
  return new Map(ids.map((id, index) => [id, { id, index, min: -30, max: 30, defaultValue: 0 }]));
}

const headIds = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ'];
const eyeIds = ['ParamEyeLOpen', 'ParamEyeROpen'];
const bodyIds = ['ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ'];

test('a physics-driven torso counts as a real rig without allowing direct gesture writes', () => {
  // Witch's head rotations drive all three torso axes through physics.
  const available = parameters([...headIds, ...bodyIds, ...eyeIds, 'Param41']);
  const capabilities = resolveModelCapabilities(available);
  const writable = resolveMotionParameters(available, new Set(bodyIds));
  assert.equal(capabilities.hasBodyRig, true);
  assert.equal(writable.bodyX, null);
  assert.equal(writable.bodyY, null);
  assert.equal(writable.bodyZ, null);

  const values = Array(available.size).fill(0);
  const writes = [];
  const model = { getParameterCount: () => values.length,
    getParameterValueByIndex: index => values[index],
    setParameterValueByIndex: (index, value) => { values[index] = value; writes.push(index); } };
  applyMotionOffsets(model, writable, { headX: 5, bodyX: 1, bodyY: 1, bodyZ: 1 });
  assert.equal(values[0], 5);
  assert.deepEqual(values.slice(3, 6), [0, 0, 0]);
  assert.ok(writes.every(index => index < 3));
});

test('IceGirl retains the fallback lean and its registered wing control', () => {
  const available = parameters([...headIds, ...eyeIds, 'Param41']);
  const capabilities = resolveModelCapabilities(available, { wingExpressionRegistered: true });
  assert.equal(capabilities.hasBodyRig, false);
  assert.equal(capabilities.wingParameterIndex, available.get('Param41').index);
  assert.deepEqual(capabilities.blinkIds, eyeIds);
});

test('torso detection recognizes a partial rig and legacy body parameter aliases', () => {
  for (const id of [...bodyIds, 'ParamBodyX', 'ParamBodyY']) {
    assert.equal(resolveModelCapabilities(parameters([id])).hasBodyRig, true, id);
  }
  assert.equal(resolveModelCapabilities(parameters(headIds)).hasBodyRig, false);
});

test('a same-named ear parameter is never bound to IceGirl wing controls', () => {
  const available = parameters([...headIds, 'Param41']);
  assert.equal(resolveModelCapabilities(available).wingParameterIndex, -1);
  assert.equal(resolveModelCapabilities(available, { wingExpressionRegistered: false }).wingParameterIndex, -1);
  assert.equal(resolveModelCapabilities(parameters(headIds), { wingExpressionRegistered: true }).wingParameterIndex, -1);
});

test('valid declared blink parameters take precedence over the standard eye fallback', () => {
  const available = parameters([...eyeIds, 'CustomEyeOpen']);
  const capabilities = resolveModelCapabilities(available, { blinkIds: ['MissingEye', 'CustomEyeOpen'] });
  assert.deepEqual(capabilities.blinkIds, ['CustomEyeOpen']);
});

test('absent or invalid blink groups fall back to scanned eye-open controls', () => {
  const available = parameters(eyeIds);
  assert.deepEqual(resolveModelCapabilities(available).blinkIds, eyeIds);
  assert.deepEqual(resolveModelCapabilities(available, { blinkIds: [] }).blinkIds, eyeIds);
  assert.deepEqual(resolveModelCapabilities(available, { blinkIds: ['MissingEye'] }).blinkIds, eyeIds);
  assert.deepEqual(resolveModelCapabilities(parameters(['ParamEyeROpen'])).blinkIds, ['ParamEyeROpen']);
});

test('a model with no relevant rig parameters receives no invented capabilities', () => {
  assert.deepEqual(resolveModelCapabilities(new Map()), {
    hasBodyRig: false, blinkIds: [], wingParameterIndex: -1,
  });
});

test('Witch brow height uses its real control without writing secondary physics parameters', () => {
  const available = parameters([...headIds, ...bodyIds, ...eyeIds,
    'ParamEyeBallX', 'ParamEyeBallY', 'ParamBrowLY', 'ParamBrowLForm', 'Param43', 'Param44']);
  Object.assign(available.get('ParamBrowLY'), { min: -1, max: 1 });
  const physicsOutputs = new Set([...bodyIds, 'Param43', 'Param44']);
  const writable = resolveMotionParameters(available, physicsOutputs);
  assert.equal(writable.browL, available.get('ParamBrowLY'));
  assert.equal(writable.browR, null);

  const values = Array(available.size).fill(0);
  const writes = [];
  const model = { getParameterCount: () => values.length,
    getParameterValueByIndex: index => values[index],
    setParameterValueByIndex: (index, value) => { values[index] = value; writes.push(index); } };
  applyMotionOffsets(model, writable, { browL: 0.2, browR: 0.2, bodyX: 1, bodyY: 1, bodyZ: 1 });
  assert.equal(values[available.get('ParamBrowLY').index], 0.2);
  assert.equal(values[available.get('ParamBrowLForm').index], 0);
  for (const id of physicsOutputs) {
    assert.equal(values[available.get(id).index], 0, id);
    assert.ok(!writes.includes(available.get(id).index), id);
  }
});

test('standard brow angle controls take precedence over height controls', () => {
  const available = parameters(['ParamBrowLY', 'ParamBrowRY', 'ParamBrowLAngle', 'ParamBrowRAngle']);
  const writable = resolveMotionParameters(available);
  assert.equal(writable.browL, available.get('ParamBrowLAngle'));
  assert.equal(writable.browR, available.get('ParamBrowRAngle'));
});

test('brow height fallback excludes physics outputs and absent controls', () => {
  const available = parameters(['ParamBrowLAngle', 'ParamBrowLY', 'ParamBrowRY']);
  let writable = resolveMotionParameters(available, new Set(['ParamBrowLAngle']));
  assert.equal(writable.browL, available.get('ParamBrowLY'));
  assert.equal(writable.browR, available.get('ParamBrowRY'));
  writable = resolveMotionParameters(available, new Set(['ParamBrowLAngle', 'ParamBrowLY', 'ParamBrowRY']));
  assert.equal(writable.browL, null);
  assert.equal(writable.browR, null);
});
