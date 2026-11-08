import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SpeechMotionController, resolveMotionParameters, applyMotionOffsets } from '../../src/speechMotion.js';
import { resolvePhysicsBodyParameters, prepareBodyPhysics, BodyMotionController } from '../../src/bodyMotion.js';
import { IdleMotionController, composeIdlePose, applyIdlePhysicsBodyOffsets } from '../../src/idleMotion.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const corePath = path.join(root, 'public/vendor/live2d/live2dcubismcore.min.js');
const modelPath = path.join(root, 'public/models/魔女/魔女.moc3');
const physicsPath = path.join(root, 'public/models/魔女/魔女.physics3.json');
const frameworkPath = path.join(root, 'vendor/live2d/framework/live2dcubismframework.ts');
const hasLocalAssets = [corePath, modelPath, physicsPath, frameworkPath].every(file => fs.existsSync(file));
const trackedIds = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ'];
const settleTimes = [4, 6, 8];

async function loadRuntime() {
  const { build } = await import('esbuild');
  const bundled = await build({
    stdin: {
      contents: "export { CubismFramework } from './vendor/live2d/framework/live2dcubismframework.ts';\n"
        + "export { CubismModel } from './vendor/live2d/framework/model/cubismmodel.ts';\n"
        + "export { CubismPhysics } from './vendor/live2d/framework/physics/cubismphysics.ts';\n"
        + "export { CubismBreath, BreathParameterData } from './vendor/live2d/framework/effect/cubismbreath.ts';\n"
        + "export { SyntheticTracker } from './src/syntheticTracking.js';\n"
        + "export { tuning } from './src/tuningConfig.js';\n"
        + "import './vendor/live2d/framework/rendering/cubismrenderer_webgl.ts';",
      resolveDir: root,
      sourcefile: 'motionRuntime.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const context = vm.createContext({ console, process, require: createRequire(import.meta.url),
    __dirname: path.dirname(corePath), setTimeout, clearTimeout, TextDecoder, TextEncoder, Buffer, structuredClone });
  context.Math = Object.create(Math);
  vm.runInContext(fs.readFileSync(corePath, 'utf8'), context, { filename: corePath });
  // Wait for the Core's embedded runtime without rendering or loading textures.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (context.Live2DCubismCore.Version.csmGetVersion()) break;
    } catch {
      if (attempt === 99) throw new Error('Cubism Core did not initialize.');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  context.module = { exports: {} };
  context.exports = context.module.exports;
  vm.runInContext(bundled.outputFiles[0].text, context, { filename: 'motionRuntime.cjs' });
  const framework = context.module.exports;
  framework.CubismFramework.startUp();
  framework.CubismFramework.initialize();
  return { core: context.Live2DCubismCore, ...framework, seedTracking: () => {
    let seed = 271828;
    context.Math.random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  } };
}

function createBreath(runtime, parameters) {
  const controls = [];
  const add = (id, offset, peakKey, cycleKey, weightKey) => {
    if (!parameters.has(id)) return;
    controls.push(new runtime.BreathParameterData(runtime.CubismFramework.getIdManager().getId(id),
      offset, runtime.tuning.get(`idle.${peakKey}`), runtime.tuning.get(`idle.${cycleKey}`),
      runtime.tuning.get(`idle.${weightKey}`)));
  };
  add('ParamAngleX', 0, 'angleXPeak', 'angleXCycle', 'angleXWeight');
  add('ParamAngleY', 0, 'angleYPeak', 'angleYCycle', 'angleYWeight');
  add('ParamAngleZ', 0, 'angleZPeak', 'angleZCycle', 'angleZWeight');
  add('ParamBreath', runtime.tuning.get('idle.chestOffset'), 'chestPeak', 'chestCycle', 'chestWeight');
  const breath = runtime.CubismBreath.create();
  breath.setParameters(controls);
  return breath;
}

function simulate(runtime, emotion, fps, { idleOnly = false, withIdleBank = false } = {}) {
  const bytes = fs.readFileSync(modelPath);
  const moc = runtime.core.Moc.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.ok(moc, 'The local moc3 must load.');
  const coreModel = runtime.core.Model.fromMoc(moc);
  const model = new runtime.CubismModel(coreModel);
  model.initialize();
  const parameters = new Map(coreModel.parameters.ids.map((id, index) => [id, { id, index,
    min: coreModel.parameters.minimumValues[index], max: coreModel.parameters.maximumValues[index],
    defaultValue: coreModel.parameters.defaultValues[index] }]));
  const json = JSON.parse(fs.readFileSync(physicsPath, 'utf8'));
  const outputs = new Set(json.PhysicsSettings.flatMap(setting => setting.Output.map(output => output.Destination.Id)));
  const bodyParameters = resolvePhysicsBodyParameters(parameters, outputs);
  const body = new BodyMotionController(bodyParameters, { getOptions: () => ({
    strength: runtime.tuning.get('talking.bodyGestureStrength'),
  }) });
  const motionParameters = resolveMotionParameters(parameters, outputs);
  const prepared = new TextEncoder().encode(JSON.stringify(prepareBodyPhysics(json, bodyParameters)));
  const physics = runtime.CubismPhysics.create(prepared.buffer, prepared.byteLength);
  let seed = 314159;
  const speech = new SpeechMotionController({ getOptions: () => ({
    strength: runtime.tuning.get('talking.gestureStrength'),
    frequency: runtime.tuning.get('talking.gestureFrequency'),
    smoothingMs: runtime.tuning.get('talking.gestureSmoothingMs'),
  }), random: () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  } });
  runtime.seedTracking();
  const tracker = new runtime.SyntheticTracker();
  const breath = createBreath(runtime, parameters);
  let idleSeed = 123;
  const idleBank = withIdleBank ? new IdleMotionController({ random: () => {
    idleSeed = (Math.imul(idleSeed, 1664525) + 1013904223) >>> 0;
    return idleSeed / 4294967296;
  } }) : null;
  const idleNames = new Set();
  const endAt = 9;
  if (!idleOnly) {
    speech.queue({ speechId: 'local-rig-check', startAt: 1, endAt, emotion,
      rhythm: { step: 0.02, envelope: Array(400).fill(0.7), events: [] } });
  }
  const peaks = Object.fromEntries(trackedIds.map(id => [id, 0]));
  const final = {};
  const tail = {};
  const maxStep = {};
  const squaredVelocity = { head: 0, body: 0 };
  let activeFrames = 0;
  let previous = Object.fromEntries(trackedIds.map(id => [id, parameters.get(id).defaultValue]));
  model.saveParameters();
  try {
    for (let frame = 0; frame <= fps * (endAt + settleTimes.at(-1)); frame++) {
      const time = frame / fps;
      model.loadParameters();
      model.saveParameters();
      const pose = speech.update(time, 1 / fps);
      breath.updateParameters(model, 1 / fps);
      const authored = idleBank?.update(1 / fps, { speaking: pose.active });
      if (authored?.motion) idleNames.add(authored.motion);
      const tracked = tracker.sample(1 / fps, pose.active);
      applyMotionOffsets(model, motionParameters, pose, authored ? composeIdlePose(tracked, authored) : tracked);
      body.update(model, pose, 1 / fps);
      if (authored) applyIdlePhysicsBodyOffsets(model, body.parameters, authored);
      const settledAt = settleTimes.find(seconds => frame === fps * (endAt + seconds));
      if (settledAt) {
        tail[settledAt] = { base: {}, actual: {} };
        for (const id of trackedIds) {
          const parameter = parameters.get(id);
          tail[settledAt].base[id] = model.getParameterValueByIndex(parameter.index) - parameter.defaultValue;
        }
      }
      physics.evaluate(model, 1 / fps);
      // Core updates compute drawable meshes, which these parameter checks do
      // not inspect. Keep physics and the parameter pipeline at full frame rate.
      if (frame % fps === 0) {
        const parameterValues = coreModel.parameters.values.slice();
        model.update();
        assert.deepEqual(coreModel.parameters.values, parameterValues,
          'Core drawable updates must leave the simulated parameter values unchanged.');
      }
      const inSpeechWindow = time >= 1 && time < endAt;
      if (inSpeechWindow) activeFrames++;
      for (const id of trackedIds) {
        const parameter = parameters.get(id);
        assert.ok(parameter, `${id} must be present in the local rig.`);
        const value = model.getParameterValueByIndex(parameter.index);
        assert.ok(Number.isFinite(value), `${emotion}: ${id} must remain finite.`);
        assert.ok(value >= parameter.min - 0.001 && value <= parameter.max + 0.001,
          `${emotion}: ${id} must remain within the actual moc3 bounds.`);
        const step = Math.abs(value - previous[id]);
        if (inSpeechWindow) {
          peaks[id] = Math.max(peaks[id], Math.abs(value - parameter.defaultValue));
          squaredVelocity[id.startsWith('ParamBody') ? 'body' : 'head'] += (step * fps) ** 2;
        }
        maxStep[id] = Math.max(maxStep[id] ?? 0, step);
        previous[id] = value;
        final[id] = value - parameter.defaultValue;
        if (settledAt) tail[settledAt].actual[id] = final[id];
      }
    }
    const activity = Object.fromEntries(Object.entries(squaredVelocity)
      .map(([group, sum]) => [group, Math.sqrt(sum / activeFrames)]));
    return { peaks, maxStep, final, activity, tail, speechFinal: { ...speech.pose },
      bodyOffsets: { ...body.offsets }, idleNames: [...idleNames] };
  } finally {
    runtime.CubismPhysics.delete(physics);
    model.release();
    moc._release();
  }
}

test('local witch rig preserves coordinated speech movement through real Cubism physics', {
  skip: !hasLocalAssets && 'Optional ignored witch assets or vendored runtime are unavailable.',
}, async t => {
  const runtime = await loadRuntime();
  try {
    const idle = simulate(runtime, 'netral', 60, { idleOnly: true });
    console.log(`idle peak degrees: ${JSON.stringify(idle.peaks)}; activity degrees/sec: ${JSON.stringify(idle.activity)}`);
    const results = {};
    for (const emotion of ['netral', 'kagum', 'sedih']) {
      const result = simulate(runtime, emotion, 60);
      results[emotion] = result;
      const returnError = Object.fromEntries(trackedIds
        .map(id => [id, result.tail[4].actual[id] - idle.tail[4].actual[id]]));
      const prePhysicsReturnError = Object.fromEntries(trackedIds
        .map(id => [id, result.tail[4].base[id] - idle.tail[4].base[id]]));
      const rollTail = Object.fromEntries(settleTimes.map(seconds =>
        [seconds, result.tail[seconds].actual.ParamBodyAngleZ - idle.tail[seconds].actual.ParamBodyAngleZ]));
      console.log(`${emotion} peak degrees: ${JSON.stringify(result.peaks)}; activity degrees/sec: ${JSON.stringify(result.activity)}; `
        + `maximum frame steps: ${JSON.stringify(result.maxStep)}; idle return error: ${JSON.stringify(returnError)}; `
        + `before-physics return error: ${JSON.stringify(prePhysicsReturnError)}; roll tail at 4/6/8 seconds: ${JSON.stringify(rollTail)}`);
      for (const id of trackedIds) {
        assert.ok(Math.abs(prePhysicsReturnError[id]) < 0.05,
          `${emotion}: ${id} procedural base must return to idle within four seconds.`);
        // The authored roll pendulum has radius 13.9 and delay 1.5. Large head
        // turns leave a secondary tail after the procedural pose has settled;
        // preserve that physics and allow it eight seconds at the same tolerance.
        if (id === 'ParamBodyAngleZ') {
          assert.ok(Math.abs(rollTail[8]) < 0.05,
            `${emotion}: secondary torso roll must settle within eight seconds (error ${rollTail[8]} degrees).`);
        } else {
          assert.ok(Math.abs(returnError[id]) < 0.05,
            `${emotion}: ${id} must return to idle within four seconds (error ${returnError[id]} degrees).`);
        }
        assert.ok(result.maxStep[id] < 2, `${emotion}: ${id} must transition without jumps.`);
      }
      if (emotion === 'netral') {
        assert.ok(Math.max(...trackedIds.slice(0, 3).map(id => result.peaks[id])) >= 24,
          'Neutral speech must use at least twenty-four degrees of real head rotation.');
        assert.ok(result.peaks.ParamBodyAngleX >= 8 && result.peaks.ParamBodyAngleY >= 8,
          'Neutral speech must use at least eight degrees on both torso X and Y.');
        assert.ok(result.activity.head >= idle.activity.head * 2,
          'Neutral speech head activity must exceed the full idle pipeline by at least 2x.');
        assert.ok(result.activity.body >= idle.activity.body * 3,
          'Neutral speech torso activity must exceed the full idle pipeline by at least 3x.');
      }
    }
    assert.ok(results.kagum.peaks.ParamBodyAngleY > results.sedih.peaks.ParamBodyAngleY * 1.5,
      'Excited speech must move the actual torso more than quiet speech.');
    const lowerFps = simulate(runtime, 'netral', 30);
    for (const id of trackedIds) {
      assert.ok(Math.abs(lowerFps.peaks[id] - results.netral.peaks[id]) < 0.6,
        `${id} should preserve its range at 30 and 60 FPS.`);
    }
  } finally {
    runtime.CubismFramework.dispose();
    runtime.CubismFramework.cleanUp();
  }
});

test('local witch idle bank moves the real torso smoothly through unchanged Cubism physics', {
  skip: !hasLocalAssets && 'Optional ignored witch assets or vendored runtime are unavailable.',
}, async () => {
  const runtime = await loadRuntime();
  try {
    const baseline = simulate(runtime, 'netral', 60, { idleOnly: true });
    const authored = simulate(runtime, 'netral', 60, { idleOnly: true, withIdleBank: true });
    const lowerFps = simulate(runtime, 'netral', 30, { idleOnly: true, withIdleBank: true });
    console.log(`authored idle peak degrees: ${JSON.stringify(authored.peaks)}; `
      + `baseline peak degrees: ${JSON.stringify(baseline.peaks)}; maximum frame steps: ${JSON.stringify(authored.maxStep)}`);
    assert.ok(authored.idleNames.length >= 2);
    assert.ok(authored.peaks.ParamBodyAngleX > baseline.peaks.ParamBodyAngleX * 1.5);
    // Pitch already follows the existing breath; variety need not amplify it.
    assert.ok(authored.peaks.ParamBodyAngleY > 0.5);
    for (const id of trackedIds) {
      assert.ok(authored.maxStep[id] < 1, `${id} must move without idle pose jumps.`);
      assert.ok(Math.abs(lowerFps.peaks[id] - authored.peaks[id]) < 0.6,
        `${id} idle range should remain comparable at 30 and 60 FPS.`);
    }
  } finally {
    runtime.CubismFramework.dispose();
    runtime.CubismFramework.cleanUp();
  }
});
