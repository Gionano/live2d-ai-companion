import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { loadSelfieConfig as loadConfig } from '../selfie/config.js';

const ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'selfie config '));
test.after(() => fs.rmSync(ROOT_DIR, { recursive: true, force: true }));
const loadSelfieConfig = overrides => loadConfig(overrides, { repoRoot: ROOT_DIR, env: {} });

test('selfie config defaults to auto with bounded readiness checks and local providers', () => {
  const config = loadSelfieConfig();
  assert.equal(config.provider, 'auto');
  assert.deepEqual(config.autoOrder, ['comfyui', 'comfyui-managed', 'sdcpp']);
  assert.equal(config.availabilityCacheMs, 30000);
  assert.equal(config.healthTimeoutMs, 1500);
  for (const provider of ['auto', 'comfyui', 'comfyui-managed', 'sdcpp']) {
    assert.equal(loadSelfieConfig({ provider }).provider, provider);
  }
  assert.throws(() => loadSelfieConfig({ provider: 'cloud' }), /provider/);
  assert.throws(() => loadSelfieConfig({ autoOrder: ['cloud'] }), /autoOrder/);
  assert.throws(() => loadSelfieConfig({ autoOrder: 'comfyui' }), /autoOrder/);
  assert.throws(() => loadSelfieConfig({ healthTimeoutMs: 0 }), /healthTimeoutMs/);
  assert.equal(loadSelfieConfig({ availabilityCacheMs: 0 }).availabilityCacheMs, 0);
});

test('sd.cpp paths resolve beneath userData models while preserving absolute paths', () => {
  const userDataDir = path.resolve('test data', 'Path With Spaces');
  const absoluteVae = path.resolve('external models', 'vae.gguf');
  const config = loadSelfieConfig({
    userDataDir,
    sdcpp: {
      binaryPath: 'bin/sd-cli.exe',
      diffusionModel: 'diffusion.gguf',
      vae: absoluteVae,
      llm: 'encoders/llm.gguf',
      llmVision: null,
      offloadToCpu: true,
      extraArgs: [],
    },
  });
  const baseDir = path.join(userDataDir, 'models', 'sdcpp');
  assert.equal(config.sdcpp.binaryPath, path.join(baseDir, 'bin', 'sd-cli.exe'));
  assert.equal(config.sdcpp.diffusionModel, path.join(baseDir, 'diffusion.gguf'));
  assert.equal(config.sdcpp.vae, absoluteVae);
  assert.equal(config.sdcpp.llm, path.join(baseDir, 'encoders', 'llm.gguf'));
  assert.equal(config.sdcpp.llmVision, null);
  assert.equal(config.sdcpp.offloadToCpu, true);
  assert.deepEqual(config.sdcpp.extraArgs, []);
});

test('presets retain shared cfg and validate optional per-provider overrides', () => {
  const config = loadSelfieConfig({
    presets: {
      cepat: { cfg: 4, providers: { sdcpp: { resolution: 512, steps: 8, cfg: 2 } } },
    },
  });
  assert.deepEqual(config.presets.cepat, {
    resolution: 768, steps: 12, cfg: 4,
    providers: { sdcpp: { resolution: 512, steps: 8, cfg: 2 } },
  });
  assert.equal(config.presets.kualitas.cfg, 3);
  assert.throws(() => loadSelfieConfig({ presets: { cepat: { resolution: 777 } } }), /multiple of 32/);
  assert.throws(() => loadSelfieConfig({ presets: { cepat: { steps: 0 } } }), /steps\/cfg/);
  assert.throws(() => loadSelfieConfig({
    presets: { cepat: { providers: { comfyui: { resolution: 777 } } } },
  }), /override/);
});

test('hardening config normalizes hemat, sd.cpp argv, nested memory limits, and telemetry defaults', () => {
  const config = loadSelfieConfig({
    preset: 'hemat',
    sdcpp: {
      args: ['--diffusion-fa'], offloadToCpu: false,
      allowCpu: false, forceRun: false,
      modelArgs: ['qwen_image_2_1_prefix_cache=false'], memory: { minFreeRamGB: 6 },
    },
    telemetry: { enabled: false },
    presets: { hemat: { sdcpp: { args: ['--vae-tiling'] } } },
  });
  assert.deepEqual(config.sdcpp.args, ['--diffusion-fa']);
  assert.equal(config.sdcpp.offloadToCpu, false);
  assert.deepEqual(config.sdcpp.memory, {
    minFreeRamGB: 6, minFreeVramGB: 1, commitHeadroomGB: 8,
    computeBufferGB: 2.5, marginGB: 2, hardFailRatio: 0.6,
  });
  assert.deepEqual(config.telemetry, { enabled: false, intervalMs: 2000, probeTimeoutMs: 1500 });
  assert.deepEqual(config.presets.hemat, {
    resolution: 768, steps: 12, cfg: 3, providers: {}, sdcpp: { args: ['--vae-tiling'], modelArgs: [] },
  });
  assert.equal(config.sdcpp.allowCpu, false);
  assert.equal(config.sdcpp.forceRun, false);
  assert.equal(config.sdcpp.deviceTimeoutMs, 5000);
  assert.ok(path.isAbsolute(config.logPath));
});

test('hardening config rejects invalid command arrays, modelArgs, thresholds, and telemetry intervals', () => {
  for (const sdcpp of [
    { args: '--vae-tiling' }, { args: [42] }, { modelArgs: ['missing_equals'] },
    { allowCpu: 'false' }, { forceRun: 1 }, { offloadToCpu: 'true' }, { offloadToCpu: null },
    { memory: { minFreeRamGB: -1 } }, { memory: { computeBufferGB: -1 } },
    { memory: { marginGB: -1 } }, { memory: { hardFailRatio: 0 } },
    { memory: { hardFailRatio: 1.01 } }, { deviceTimeoutMs: 0 },
  ]) assert.throws(() => loadSelfieConfig({ sdcpp }), /sdcpp/);
  assert.throws(() => loadSelfieConfig({ presets: { hemat: { sdcpp: { args: 'invalid' } } } }), /presets\.hemat/);
  assert.throws(() => loadSelfieConfig({ telemetry: { intervalMs: 0 } }), /telemetry/);
});

test('sd.cpp config preserves explicit offload values independently of base arguments', () => {
  const enabled = loadSelfieConfig({ sdcpp: { offloadToCpu: true, args: ['--sampling-method', 'euler'] } });
  assert.equal(enabled.sdcpp.offloadToCpu, true);
  assert.deepEqual(enabled.sdcpp.args, ['--sampling-method', 'euler']);
  const disabled = loadSelfieConfig({ sdcpp: { offloadToCpu: false, args: ['--offload-to-cpu'] } });
  assert.equal(disabled.sdcpp.offloadToCpu, false);
});

test('sd.cpp config merges configurable compute buffers, commit margins, and hard failure ratios', () => {
  const cfg = loadSelfieConfig({ sdcpp: { memory: { computeBufferGB: 3, marginGB: 1, hardFailRatio: 0.75 } } });
  assert.deepEqual(cfg.sdcpp.memory, {
    minFreeRamGB: 4, minFreeVramGB: 1, commitHeadroomGB: 8,
    computeBufferGB: 3, marginGB: 1, hardFailRatio: 0.75,
  });
});

test('sd.cpp config retains init image and strength keys in base and presets without changing files', () => {
  const config = loadSelfieConfig({
    sdcpp: { initImage: 'assets/references/start.png', strength: 0.4 },
    presets: {
      hemat: { sdcpp: { initImage: 'reference', strength: 0 } },
      kualitas: { sdcpp: { initImage: path.resolve('alternate.png'), strength: 1 } },
    },
  });
  assert.equal(config.sdcpp.initImage, path.join(ROOT_DIR, 'assets', 'references', 'start.png'));
  assert.equal(config.sdcpp.strength, 0.4);
  assert.deepEqual(config.presets.hemat.sdcpp, { args: [], modelArgs: [], initImage: 'reference', strength: 0 });
  assert.equal(config.presets.kualitas.sdcpp.initImage, path.resolve('alternate.png'));
  assert.equal(config.presets.kualitas.sdcpp.strength, 1);
});

test('sd.cpp config rejects invalid init image and strength keys in base and presets', () => {
  for (const options of [{ initImage: 42 }, { initImage: 'bad\0path' },
    { strength: -0.1 }, { strength: 1.1 }, { strength: '0.5' }, { strength: NaN }]) {
    assert.throws(() => loadSelfieConfig({ sdcpp: options }), /sdcpp\.(initImage|strength)/);
    assert.throws(() => loadSelfieConfig({ presets: { hemat: { sdcpp: options } } }), /presets\.hemat\.sdcpp/);
  }
});

test('managed ComfyUI keeps unset paths empty and resolves configured paths without layout guesses', () => {
  const empty = loadSelfieConfig({ comfyuiManaged: { installDir: '', pythonPath: '', mainScript: '' } });
  assert.equal(empty.comfyuiManaged.installDir, '');
  assert.equal(empty.comfyuiManaged.pythonPath, '');
  assert.equal(empty.comfyuiManaged.mainScript, '');
  assert.equal(empty.comfyuiManaged.idleStopSeconds, 90);
  const installation = path.resolve(ROOT_DIR, 'User Installed', 'Comfy UI');
  const absolutePython = path.resolve('External Python', 'python.exe');
  const config = loadSelfieConfig({ provider: 'comfyui-managed', comfyuiManaged: {
    installDir: 'User Installed/Comfy UI', pythonPath: absolutePython, mainScript: 'app/main.py',
    args: ['--lowvram'], env: { MANAGED_TEST: 'space separated value' },
    profiles: { memory: { args: ['--reserve-vram', '1.5'] } }, profile: 'memory',
  } });
  assert.equal(config.comfyuiManaged.installDir, installation);
  assert.equal(config.comfyuiManaged.pythonPath, absolutePython);
  assert.equal(config.comfyuiManaged.mainScript, path.join(installation, 'app', 'main.py'));
  assert.deepEqual(config.comfyuiManaged.profiles.memory.args, ['--reserve-vram', '1.5']);
  assert.deepEqual(config.comfyuiManaged.env, { MANAGED_TEST: 'space separated value' });
});

test('managed ComfyUI rejects remote hosts, malformed argv, ports, paths, and env', () => {
  for (const comfyuiManaged of [
    null, [], 'invalid',
    { host: '0.0.0.0' }, { host: 'example.com' }, { port: 0 }, { port: 65536 }, { port: '8188' },
    { pythonPath: 42 }, { mainScript: 'main\0.py' }, { args: '--lowvram' }, { args: ['--bad\0flag'] },
    { env: [] }, { env: { TEST: 42 } }, { env: { 'BAD=NAME': 'value' } }, { env: { TEST: 'bad\0value' } },
    { startTimeoutMs: 0 }, { idleStopSeconds: -1 }, { healthPath: '//external/path' },
    { healthPath: '/system_stats?query' },
  ]) assert.throws(() => loadSelfieConfig({ comfyuiManaged }), /comfyuiManaged/);
});

test('managed ComfyUI validates profile selection and copies argument arrays', () => {
  for (const comfyuiManaged of [
    { profiles: [] }, { profiles: { low: null } }, { profiles: { low: { args: 'invalid' } } },
    { profile: 'missing', profiles: {} },
  ]) assert.throws(() => loadSelfieConfig({ comfyuiManaged }), /comfyuiManaged/);
  const args = ['--lowvram'];
  const config = loadSelfieConfig({ comfyuiManaged: { args, profiles: { low: { args } }, profile: 'low' },
    presets: { cepat: { providers: { 'comfyui-managed': { resolution: 512, steps: 8 } } } } });
  args.push('--unexpected');
  assert.deepEqual(config.comfyuiManaged.args, ['--lowvram']);
  assert.deepEqual(config.comfyuiManaged.profiles.low.args, ['--lowvram']);
  assert.deepEqual(config.presets.cepat.providers['comfyui-managed'], { resolution: 512, steps: 8, cfg: 3 });
});
