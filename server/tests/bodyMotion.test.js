import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePhysicsBodyParameters, prepareBodyPhysics, BodyMotionController } from '../../src/bodyMotion.js';

const bodyIds = ['ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ'];
const headIds = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ'];
const bodyKeys = ['bodyX', 'bodyY', 'bodyZ'];

function rig() {
  const ids = [...headIds, ...bodyIds, 'ParamMouthOpenY', 'ParamEyeLOpen', 'ParamHair', 'Param41'];
  return new Map(ids.map((id, index) => [id, {
    id, index, min: index === 5 ? -10 : -30, max: index === 5 ? 10 : 30, defaultValue: 0,
  }]));
}

function modelFor(available) {
  const values = Array(available.size).fill(0);
  const writes = [];
  function restore(overrides = {}) {
    for (const parameter of available.values()) {
      values[parameter.index] = overrides[parameter.id] ?? parameter.defaultValue;
    }
  }
  restore();
  return { values, writes, restore,
    getParameterCount: () => values.length,
    getParameterValueByIndex: index => values[index],
    setParameterValueByIndex: (index, value) => {
      assert.ok(index >= 0 && index < values.length, 'only real parameter indices may be written');
      assert.ok(Number.isFinite(value), 'parameter writes must be finite');
      values[index] = value;
      writes.push(index);
    },
    getParameterIndex: () => { throw new Error('virtual parameter lookup is not a capability check'); },
  };
}

function close(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be close to ${expected}`);
}

function physicsFixture() {
  return { Version: 3, Meta: { TotalOutputCount: 6 }, PhysicsSettings: [
    { Id: 'Torso', Input: [{ Source: { Target: 'Parameter', Id: headIds[0] }, Weight: 100 }],
      Output: [...bodyIds, 'ParamHair', 'Param41'].map((id, index) => ({
        Destination: { Target: 'Parameter', Id: id }, VertexIndex: 1,
        Scale: index + 1, Weight: index === 3 ? 80 : 100, Reflect: index === 4,
      })), Vertices: [{ Position: { X: 0, Y: 1 }, Mobility: 0.8 }] },
    { Id: 'Eye', Output: [{ Destination: { Target: 'Parameter', Id: 'ParamEyeLOpen' }, Weight: 50 }] },
  ] };
}

test('physics body controls require real matching heads and physics-controlled torso axes', () => {
  const available = rig();
  const resolved = resolvePhysicsBodyParameters(available, new Set(bodyIds));
  for (let axis = 0; axis < 3; axis++) {
    assert.deepEqual(resolved[bodyKeys[axis]], {
      body: available.get(bodyIds[axis]), head: available.get(headIds[axis]),
    });
  }
  assert.deepEqual(resolvePhysicsBodyParameters(available), { bodyX: null, bodyY: null, bodyZ: null });
  available.delete('ParamAngleY');
  available.delete('ParamBodyAngleZ');
  const partial = resolvePhysicsBodyParameters(available, new Set(bodyIds));
  assert.ok(partial.bodyX);
  assert.equal(partial.bodyY, null);
  assert.equal(partial.bodyZ, null);
  const absent = resolvePhysicsBodyParameters(new Map(), new Set(bodyIds));
  assert.deepEqual(absent, { bodyX: null, bodyY: null, bodyZ: null });
  const model = modelFor(new Map());
  new BodyMotionController(absent).update(model, { bodyX: 1 }, 1 / 60);
  assert.deepEqual(model.writes, []);
});

test('legacy torso aliases resolve only when scanned indices and matching head are real', () => {
  const available = rig();
  available.set('ParamBodyX', { id: 'ParamBodyX', index: available.size, min: -30, max: 30, defaultValue: 0 });
  const resolved = resolvePhysicsBodyParameters(available, new Set(['ParamBodyX']));
  assert.equal(resolved.bodyX.body.id, 'ParamBodyX');
  assert.equal(resolved.bodyY, null);
  available.get('ParamBodyX').index = 100;
  assert.equal(resolvePhysicsBodyParameters(available, new Set(['ParamBodyX'])).bodyX, null);
  available.get('ParamBodyAngleX').index = -1;
  assert.equal(resolvePhysicsBodyParameters(available, new Set(bodyIds)).bodyX, null);
  available.get('ParamAngleY').index = 0.5;
  assert.equal(resolvePhysicsBodyParameters(available, new Set(bodyIds)).bodyY, null);
});

test('physics preparation attenuates mapped torso outputs without mutating source or other physics', () => {
  const source = physicsFixture();
  const snapshot = structuredClone(source);
  const parameters = resolvePhysicsBodyParameters(rig(), new Set(bodyIds));
  const prepared = prepareBodyPhysics(source, parameters);
  const expected = structuredClone(source);
  expected.PhysicsSettings[0].Output.slice(0, 3).forEach(output => { output.Weight *= 0.35; });
  assert.deepEqual(prepared, expected);
  assert.deepEqual(source, snapshot);
  assert.notEqual(prepared, source);
  assert.notEqual(prepared.PhysicsSettings[0].Vertices, source.PhysicsSettings[0].Vertices);
  prepared.PhysicsSettings[0].Vertices[0].Mobility = 0;
  assert.deepEqual(source, snapshot);

  const partial = prepareBodyPhysics(source, { bodyX: parameters.bodyX, bodyY: null, bodyZ: null });
  assert.equal(partial.PhysicsSettings[0].Output[0].Weight, 35);
  assert.deepEqual(partial.PhysicsSettings[0].Output.slice(1), source.PhysicsSettings[0].Output.slice(1));
  assert.deepEqual(prepareBodyPhysics(source, {}), source);
});

test('repeated mapped torso outputs across physics rigs are attenuated, including zero weights', () => {
  const source = physicsFixture();
  source.PhysicsSettings.push({ Id: 'SecondaryTorso', Output: [
    { Destination: { Target: 'Parameter', Id: bodyIds[0] }, Weight: 40 },
    { Destination: { Target: 'Parameter', Id: bodyIds[1] }, Weight: 0 },
    { Destination: { Target: 'Parameter', Id: 'ParamHair' }, Weight: 60 },
  ] });
  const snapshot = structuredClone(source);
  const prepared = prepareBodyPhysics(source, resolvePhysicsBodyParameters(rig(), new Set(bodyIds)));
  assert.deepEqual(prepared.PhysicsSettings[2].Output.map(output => output.Weight), [14, 0, 60]);
  assert.deepEqual(source, snapshot);
});

test('quiet head movement reaches all torso axes even when physics computes zero', () => {
  const available = rig();
  const parameters = resolvePhysicsBodyParameters(available, new Set(bodyIds));
  const prepared = prepareBodyPhysics(physicsFixture(), parameters);
  const model = modelFor(available);
  const controller = new BodyMotionController(parameters);
  const heads = { ParamAngleX: 3, ParamAngleY: -2, ParamAngleZ: 1 };
  for (let frame = 0; frame < 60; frame++) {
    model.restore({ ...heads, ParamMouthOpenY: 0.4, ParamEyeLOpen: 0.8, ParamHair: 2, Param41: 0.3 });
    controller.update(model, { bodyX: 0, bodyY: 0, bodyZ: 0, active: true, emotion: 'sedih' }, 1 / 60);
    // Cubism blends a physics result into the value present before evaluation.
    for (const output of prepared.PhysicsSettings[0].Output.slice(0, 3)) {
      const index = available.get(output.Destination.Id).index;
      model.values[index] *= 1 - output.Weight / 100;
    }
  }
  assert.ok(model.values[3] > 0.5);
  assert.ok(model.values[4] < -0.3);
  assert.ok(model.values[5] > 0.15);
  assert.deepEqual(model.values.slice(6), [0.4, 0.8, 2, 0.3]);
  assert.ok(model.writes.every(index => index >= 3 && index <= 5));
});

test('body offsets respect head defaults, gesture contributions and the restored frame baseline', () => {
  const available = rig();
  available.get('ParamAngleX').defaultValue = 3;
  available.get('ParamBodyAngleX').defaultValue = 2;
  const model = modelFor(available);
  const controller = new BodyMotionController(resolvePhysicsBodyParameters(available, new Set(bodyIds)));
  for (let frame = 0; frame < 180; frame++) {
    model.restore({ ParamAngleX: 12 });
    controller.update(model, { bodyX: 0.2 }, 1 / 60);
    assert.ok(model.values[3] <= 6 + 1e-7, 'restoring the frame baseline must prevent offset accumulation');
  }
  close(model.values[3], 6, 1e-6);
});

test('body strength scales authored posture while preserving head follow and mouth values', () => {
  const available = rig();
  const parameters = resolvePhysicsBodyParameters(available, new Set(bodyIds));
  function settled(options) {
    const model = modelFor(available);
    const controller = new BodyMotionController(parameters, { getOptions: () => options });
    for (let frame = 0; frame < 180; frame++) {
      model.restore({ ParamAngleX: 6, ParamMouthOpenY: 0.4 });
      controller.update(model, { bodyX: 0.4 }, 1 / 60);
    }
    assert.equal(model.values[0], 6);
    assert.equal(model.values[6], 0.4);
    assert.ok(model.writes.every(index => index >= 3 && index <= 5));
    return model.values[3];
  }
  close(settled({ strength: 0 }), 2, 1e-6);
  close(settled({}), 4, 1e-6);
  close(settled({ strength: 1 }), 4, 1e-6);
  close(settled({ strength: 2 }), 6, 1e-6);
  close(settled({ strength: -1 }), 2, 1e-6);
  close(settled({ strength: 20 }), 6, 1e-6);
  close(settled({ strength: NaN }), 4, 1e-6);

  const options = { strength: 1 };
  const model = modelFor(available);
  const controller = new BodyMotionController(parameters, { getOptions: () => options });
  for (let frame = 0; frame < 180; frame++) {
    model.restore({ ParamAngleX: 6, ParamMouthOpenY: 0.4 });
    controller.update(model, { bodyX: 0.4 }, 1 / 60);
  }
  const before = model.values[3];
  options.strength = 0;
  model.restore({ ParamAngleX: 6, ParamMouthOpenY: 0.4 });
  controller.update(model, { bodyX: 0.4 }, 1 / 60);
  assert.ok(model.values[3] > 2 && model.values[3] < before);
  for (let frame = 0; frame < 180; frame++) {
    model.restore({ ParamAngleX: 6, ParamMouthOpenY: 0.4 });
    controller.update(model, { bodyX: 0.4 }, 1 / 60);
  }
  close(model.values[3], 2, 1e-6);
  assert.equal(model.values[6], 0.4);
});

test('torso writes respect wider X/Y limits while keeping roll within ten degrees', () => {
  const available = rig();
  available.get('ParamBodyAngleX').defaultValue = 5;
  available.get('ParamBodyAngleY').defaultValue = -4;
  const model = modelFor(available);
  const controller = new BodyMotionController(resolvePhysicsBodyParameters(available, new Set(bodyIds)));
  for (const sign of [1, -1]) {
    controller.reset();
    for (let frame = 0; frame < 180; frame++) {
      model.restore(Object.fromEntries(headIds.map(id => [id, sign * 1000])));
      controller.update(model, Object.fromEntries(bodyKeys.map(key => [key, sign * 1000])), 1 / 60);
      for (const id of bodyIds) {
        const parameter = available.get(id);
        const value = model.values[parameter.index];
        const range = id === 'ParamBodyAngleZ' ? 10 : 20;
        assert.ok(value >= Math.max(parameter.min, parameter.defaultValue - range));
        assert.ok(value <= Math.min(parameter.max, parameter.defaultValue + range));
      }
    }
  }
  available.get('ParamBodyAngleX').max = 8;
  available.get('ParamBodyAngleZ').min = -2;
  controller.reset();
  for (let frame = 0; frame < 180; frame++) {
    model.restore({ ParamAngleX: 30, ParamAngleZ: -30 });
    controller.update(model, { bodyX: 1, bodyZ: -1 }, 1 / 60);
  }
  close(model.values[3], 8, 1e-6);
  close(model.values[5], -2, 1e-6);
});

test('large speech shifts exceed the old torso cap and fade without clipping at stop', () => {
  const available = rig();
  const model = modelFor(available);
  const controller = new BodyMotionController(resolvePhysicsBodyParameters(available, new Set(bodyIds)));
  for (let frame = 0; frame < 180; frame++) {
    model.restore({ ParamAngleX: 12, ParamAngleY: -12 });
    controller.update(model, { bodyX: 3, bodyY: -3, bodyZ: 3, active: true }, 1 / 60);
  }
  close(model.values[3], 19, 2e-6);
  close(model.values[4], -19, 2e-6);
  close(model.values[5], 10, 1e-6);
  model.restore();
  controller.update(model, { active: false }, 1 / 60);
  assert.ok(model.values[3] > 10 && model.values[3] < 19);
  assert.ok(model.values[4] < -10 && model.values[4] > -19);
  let previous = model.values[3];
  for (let frame = 0; frame < 120; frame++) {
    model.restore();
    controller.update(model, {}, 1 / 60);
    assert.ok(model.values[3] >= 0 && model.values[3] < previous);
    previous = model.values[3];
  }
  assert.ok(model.values[3] < 0.001);
});

test('invalid indices and nonfinite input never create invalid parameter writes', () => {
  const available = rig();
  const parameters = resolvePhysicsBodyParameters(available, new Set(bodyIds));
  const model = modelFor(available);
  const invalid = { ...parameters, bodyX: { ...parameters.bodyX, body: { ...parameters.bodyX.body, index: 100 } },
    bodyY: { ...parameters.bodyY, head: { ...parameters.bodyY.head, index: -1 } } };
  new BodyMotionController(invalid).update(model, { bodyX: 1, bodyY: 1, bodyZ: NaN }, 1 / 60);
  assert.ok(model.writes.every(index => index === 5));
  const controller = new BodyMotionController(parameters);
  model.restore({ ParamAngleX: Infinity, ParamAngleY: NaN, ParamAngleZ: -Infinity });
  controller.update(model, { bodyX: NaN, bodyY: Infinity, bodyZ: -Infinity }, NaN);
  assert.ok(model.values.slice(3).every(Number.isFinite));
  model.restore();
  controller.update(model, {}, 1 / 60);
  assert.ok(model.values.every(Number.isFinite), 'invalid input must not poison future smoothing');
});

test('stopping fades torso offsets smoothly and reset clears the old model pose', () => {
  const available = rig();
  const model = modelFor(available);
  const controller = new BodyMotionController(resolvePhysicsBodyParameters(available, new Set(bodyIds)));
  for (let frame = 0; frame < 60; frame++) {
    model.restore({ ParamAngleX: 12 });
    controller.update(model, { bodyX: 0.5 }, 1 / 60);
  }
  const active = model.values[3];
  model.restore();
  controller.update(model, {}, 1 / 60);
  const firstStopped = model.values[3];
  assert.ok(firstStopped > 0 && firstStopped < active);
  let previous = firstStopped;
  for (let frame = 0; frame < 60; frame++) {
    model.restore();
    controller.update(model, {}, 1 / 60);
    assert.ok(model.values[3] >= 0 && model.values[3] < previous);
    previous = model.values[3];
  }
  assert.ok(model.values[3] < active * 0.01);
  controller.reset();
  model.restore();
  controller.update(model, {}, 1 / 60);
  assert.equal(model.values[3], 0);
  model.restore({ ParamAngleX: 3 });
  controller.update(model, { bodyX: 0.2 }, 1 / 60);
  const freshModel = modelFor(available);
  freshModel.restore({ ParamAngleX: 3 });
  new BodyMotionController(resolvePhysicsBodyParameters(available, new Set(bodyIds)))
    .update(freshModel, { bodyX: 0.2 }, 1 / 60);
  close(model.values[3], freshModel.values[3]);
});

test('bounded frame delta prevents jumps and preserves equal timing at 30 and 60 FPS', () => {
  const available = rig();
  const parameters = resolvePhysicsBodyParameters(available, new Set(bodyIds));
  function sample(delta) {
    const model = modelFor(available);
    model.restore({ ParamAngleX: 12 });
    new BodyMotionController(parameters).update(model, { bodyX: 0.5 }, delta);
    return model.values[3];
  }
  assert.equal(sample(0), 0);
  assert.equal(sample(-1), 0);
  assert.equal(sample(NaN), 0);
  assert.equal(sample(Infinity), 0);
  close(sample(10), sample(0.1));
  close(sample(0.1), 6.5 * (1 - Math.exp(-0.1 / 0.18)));

  function simulate(fps) {
    const model = modelFor(available);
    const controller = new BodyMotionController(parameters);
    const checkpoints = [];
    for (let second = 0; second < 2; second++) {
      for (let frame = 0; frame < fps; frame++) {
        model.restore(second === 0 ? { ParamAngleX: 12, ParamAngleY: -6, ParamAngleZ: 3 } : {});
        controller.update(model, second === 0 ? { bodyX: 0.5, bodyY: -0.2, bodyZ: 0.1 } : {}, 1 / fps);
        for (const id of bodyIds) {
          const parameter = available.get(id);
          const value = model.values[parameter.index];
          const range = id === 'ParamBodyAngleZ' ? 10 : 20;
          assert.ok(value >= Math.max(parameter.min, parameter.defaultValue - range), `${id} at ${fps} FPS`);
          assert.ok(value <= Math.min(parameter.max, parameter.defaultValue + range), `${id} at ${fps} FPS`);
        }
      }
      checkpoints.push(model.values.slice(3, 6));
    }
    return checkpoints;
  }
  const at30 = simulate(30);
  const at60 = simulate(60);
  for (let second = 0; second < 2; second++) {
    for (let axis = 0; axis < 3; axis++) close(at30[second][axis], at60[second][axis]);
  }
});
