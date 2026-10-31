import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SdCppProvider, parseSdCppDevices } from '../selfie/providers/sdcppProvider.js';
import { ImageProviderError, IMAGE_ERROR } from '../selfie/imageProvider.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
  'base64',
);

const FAKE_CLI = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
if (args[0] === '--grandchild') {
  const heartbeat = args[1];
  setInterval(() => fs.appendFileSync(heartbeat, 'x'), 25);
  return;
}

const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const setting = name => {
  const prefix = '--' + name + '=';
  const value = args.find(arg => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : '';
};
const mode = setting('mode') || 'valid';
let flags = '--diffusion-model --vae --llm --llm_vision -r -p -n --steps --cfg-scale '
  + '--sampling-method -W -H -s --offload-to-cpu --model-args --diffusion-fa --vae-tiling -i --strength -o';
if (args.includes('--help')) {
  if (mode === 'help-hang') {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'bad-help') flags = flags.replace('--steps', '');
  flags = flags.split(' ').filter(flag => !setting('omit-flags').split(',').includes(flag)).join(' ');
  process.stdout.write(flags + '\n');
  process.exit(0);
}
if (args.includes('--list-devices')) {
  process.stdout.write(mode === 'cpu-only' ? 'CPU0: CPU backend only\n'
    : mode === 'vulkan' ? 'Vulkan0: Fake AMD GPU\n' : 'CUDA0: Fake NVIDIA GPU\n');
  process.exit(0);
}

const argvLog = setting('argv-log');
if (argvLog) fs.writeFileSync(argvLog, JSON.stringify(args));
const output = option('-o');
if (mode === 'cpu-fallback' || mode === 'cpu-multiline') {
  fs.writeFileSync(output, 'partial');
  const heartbeat = setting('heartbeat');
  const pidFile = setting('pid-file');
  if (heartbeat && pidFile) {
    const child = spawn(process.execPath, [__filename, '--grandchild', heartbeat], { stdio: 'ignore' });
    fs.writeFileSync(pidFile, String(child.pid));
  }
  process.stderr.write(mode === 'cpu-multiline' ? 'no GPU devices\n' : '\x1b[33mno GPU devices; using the def');
  setTimeout(() => process.stderr.write(mode === 'cpu-multiline'
    ? 'using the default backend\n' : 'ault backend\x1b[0m\n'), 30);
  setInterval(() => {}, 1000);
  return;
}
if (mode === 'cpu-message') process.stderr.write('no GPU devices; using the default backend\n');
if (mode === 'cpu-offload') process.stderr.write('using CPU for VAE offload; CUDA0 remains selected\n'
  + 'VAE backend: CPU\nusing CPU backend for VAE offload\nCLIP backend: CPU\nLLM backend: CPU\n');
if (mode === 'invalid') {
  fs.writeFileSync(output, 'not a png');
  process.exit(0);
}
if (mode === 'empty') {
  fs.writeFileSync(output, '');
  process.exit(0);
}
if (mode === 'missing') process.exit(0);
if (mode === 'failure') {
  process.stderr.write('provider setup failed\nTAIL_MARKER\n');
  process.exit(7);
}
if (mode === 'slow') {
  fs.writeFileSync(output, 'partial');
  const heartbeat = setting('heartbeat');
  const pidFile = setting('pid-file');
  const child = spawn(process.execPath, [__filename, '--grandchild', heartbeat], { stdio: 'ignore' });
  fs.writeFileSync(pidFile, String(child.pid));
  setInterval(() => {}, 1000);
  return;
}

if (mode === 'progress-split') {
  process.stderr.write('\x1b[32msampling 1/');
  setTimeout(() => {
    process.stderr.write('2 [00:00<00:01, 1.00it/s]\x1b[0m\r');
    fs.writeFileSync(output, Buffer.from('${PNG.toString('base64')}', 'base64'));
  }, 20);
  return;
}
if (mode === 'cpu-offload-split') {
  process.stderr.write('using CPU backend');
  setTimeout(() => {
    process.stderr.write(' for VAE offload\n');
    fs.writeFileSync(output, Buffer.from('${PNG.toString('base64')}', 'base64'));
  }, 30);
  return;
}

process.stderr.write('sampling 1/2 [00:00<00:01, 1.00it/s]\r');
fs.writeFileSync(output, Buffer.from('${PNG.toString('base64')}', 'base64'));
`;

function createFixture(t, mode = 'valid', options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdcpp Path With Spaces '));
  const referenceDir = path.join(root, 'reference files');
  const outputDir = path.join(root, 'output files');
  const modelDir = path.join(root, 'model files');
  fs.mkdirSync(referenceDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(modelDir, { recursive: true });
  const script = path.join(root, 'fake sd-cli.cjs');
  const reference = path.join(referenceDir, 'default image.png');
  fs.writeFileSync(script, FAKE_CLI);
  fs.writeFileSync(reference, PNG);
  const models = {};
  for (const name of ['diffusionModel', 'vae', 'llm']) {
    const extension = name === 'llm' ? options.llmExtension || 'safetensors' : 'gguf';
    models[name] = path.join(modelDir, `${name}.${extension}`);
    fs.writeFileSync(models[name], name);
  }
  const extraArgs = [script, `--mode=${mode}`];
  for (const [name, value] of Object.entries(options.fakeArgs || {})) {
    extraArgs.push(`--${name}=${value}`);
  }
  const cfg = {
    rootDir: root,
    localDir: path.join(root, 'local'),
    outputDir,
    referenceDir,
    defaultReference: 'default image.png',
    filenamePrefix: 'waifu selfie',
    jobTimeoutMs: options.jobTimeoutMs ?? 3000,
    logPath: path.join(root, 'selfie.log'),
    telemetry: { enabled: options.telemetryEnabled ?? false },
    presets: options.presets || {},
    sdcpp: {
      binaryPath: process.execPath,
      ...models,
      llmVision: null,
      offloadToCpu: options.offloadToCpu ?? true,
      allowCpu: options.allowCpu ?? false,
      forceRun: options.forceRun ?? false,
      args: options.args ?? ['--sampling-method', 'euler', '--offload-to-cpu'],
      modelArgs: options.modelArgs || [],
      initImage: options.initImage,
      strength: options.strength,
      helpTimeoutMs: options.helpTimeoutMs ?? 1000,
      deviceTimeoutMs: options.deviceTimeoutMs ?? 1000,
      stderrTailBytes: options.stderrTailBytes ?? 8192,
      extraArgs,
    },
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memoryMonitor = options.memoryMonitor || {
    preflight: async () => ({ memoryTier: 'ok', message: 'Heuristic memory check passed.', heuristic: true }),
    start: () => ({ stop: () => null }),
  };
  return { root, reference, outputDir, cfg,
    provider: new SdCppProvider(cfg, { memoryMonitor, ...(options.providerOptions || {}) }) };
}

function argumentValue(args, flag) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `missing ${flag}`);
  return args[index + 1];
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Timed out waiting for condition');
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function generationParams(overrides = {}) {
  return {
    positivePrompt: 'safe',
    negativePrompt: '',
    referenceImage: 'default image.png',
    resolution: 768,
    steps: 12,
    ...overrides,
  };
}

test('sd.cpp readiness verifies help flags and non-empty model files', async (t) => {
  const ready = createFixture(t);
  assert.deepEqual(await ready.provider.checkReady(), {
    ready: true,
    code: 'READY',
    message: 'sd.cpp is ready.',
    backend: 'cuda',
    deviceName: 'Fake NVIDIA GPU',
  });

  const mismatch = createFixture(t, 'bad-help');
  const status = await mismatch.provider.checkReady();
  assert.equal(status.ready, false);
  assert.equal(status.code, 'SDCPP_FLAG_MISMATCH');
  assert.match(status.message, /--steps/);

  fs.writeFileSync(mismatch.cfg.sdcpp.vae, '');
  const emptyModel = await mismatch.provider.checkReady();
  assert.equal(emptyModel.code, 'SDCPP_MODEL_INVALID');
  assert.match(emptyModel.message, /vae.*non-empty/);
});

test('sd.cpp help timeout is configurable and an aborted check cannot resolve ready', async (t) => {
  const timedOut = createFixture(t, 'help-hang', { helpTimeoutMs: 100 });
  const startedAt = Date.now();
  const status = await timedOut.provider.checkReady();
  assert.equal(status.ready, false);
  assert.equal(status.code, 'SDCPP_HELP_TIMEOUT');
  assert.ok(Date.now() - startedAt < 1000);

  const cancelled = createFixture(t, 'help-hang', { helpTimeoutMs: 2000 });
  const controller = new AbortController();
  const checking = cancelled.provider.checkReady(controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(checking, err => err.name === 'AbortError');
  assert.notEqual(cancelled.provider._lastReady?.ready, true);
});

test('sd.cpp public diagnostics preserve missing filenames without exposing model directories', async (t) => {
  const fixture = createFixture(t);
  fixture.cfg.sdcpp.vae = path.join(fixture.root, 'private models', 'missing vae.gguf');
  const readiness = await fixture.provider.checkReady();
  assert.equal(readiness.code, 'SDCPP_MODEL_MISSING');
  assert.ok(readiness.message.includes(fixture.cfg.sdcpp.vae));
  assert.equal(readiness.publicMessage, 'sdcpp.vae is missing: missing vae.gguf');
  assert.equal(readiness.publicMessage.includes(fixture.root), false);
});

test('sd.cpp uses safe argv, direct reference paths, progress, and paths with spaces', async (t) => {
  const argvLog = path.join(os.tmpdir(), `sdcpp argv ${process.pid} ${Date.now()}.json`);
  const sentinel = path.join(os.tmpdir(), `sdcpp injected ${process.pid} ${Date.now()}.txt`);
  t.after(() => {
    fs.rmSync(argvLog, { force: true });
    fs.rmSync(sentinel, { force: true });
  });
  const fixture = createFixture(t, 'valid', { fakeArgs: { 'argv-log': argvLog } });
  assert.equal((await fixture.provider.checkReady()).ready, true);
  const progress = [];
  let starts = 0;
  const hostilePrompt = `-portrait "quoted" && echo hacked > "${sentinel}"\nnext line`;
  const result = await fixture.provider.generate({
    positivePrompt: hostilePrompt,
    negativePrompt: 'bad "quote" && more',
    referenceImage: 'default image.png',
    resolution: 768,
    steps: 12,
    cfgScale: 4,
    samplingMethod: 'dpm++',
    seed: 123456,
  }, value => progress.push(value), undefined, () => { starts++; });

  assert.ok(result.imagePath.startsWith(`${fixture.outputDir}${path.sep}`));
  assert.equal(path.extname(result.imagePath), '.png');
  assert.deepEqual(fs.readFileSync(result.imagePath).subarray(0, 8), PNG.subarray(0, 8));
  assert.equal(result.seed, 123456);
  assert.equal(starts, 1);
  assert.ok(progress.some(value => value.value === 0 && value.max === 0));
  assert.ok(progress.some(value => value.value === 1 && value.max === 2));

  const args = JSON.parse(fs.readFileSync(argvLog, 'utf-8'));
  assert.equal(argumentValue(args, '--diffusion-model'), fixture.cfg.sdcpp.diffusionModel);
  assert.equal(argumentValue(args, '-r'), fixture.reference);
  assert.equal(argumentValue(args, '-p'), ` ${hostilePrompt}`);
  assert.equal(argumentValue(args, '-n'), 'bad "quote" && more');
  assert.equal(argumentValue(args, '--steps'), '12');
  assert.equal(argumentValue(args, '--cfg-scale'), '4');
  assert.equal(argumentValue(args, '--sampling-method'), 'euler');
  assert.equal(argumentValue(args, '-W'), '768');
  assert.equal(argumentValue(args, '-H'), '768');
  assert.equal(argumentValue(args, '-s'), '123456');
  assert.ok(args.includes('--offload-to-cpu'));
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(fs.readdirSync(fixture.outputDir).some(name => name.includes('.tmp.png')), false);
});

test('sd.cpp parses ANSI progress split across stderr chunks', async (t) => {
  const fixture = createFixture(t, 'progress-split');
  await fixture.provider.checkReady();
  const progress = [];
  await fixture.provider.generate(generationParams(), value => progress.push(value));
  assert.ok(progress.some(value => value.value === 1 && value.max === 2));
  assert.deepEqual(SdCppProvider.parseProgress('\u001b[36m42%\u001b[0m'), { value: 42, max: 100 });
});

test('sd.cpp maps base initImage reference and strength using the cached help', async (t) => {
  const fixture = createFixture(t, 'valid', { initImage: 'reference', strength: 0.65 });
  let helpCalls = 0;
  const runHelp = fixture.provider._runHelp.bind(fixture.provider);
  fixture.provider._runHelp = async signal => { helpCalls++; return runHelp(signal); };
  await fixture.provider.checkReady();
  const result = await fixture.provider.generate(generationParams());
  assert.equal(argumentValue(result.argv, '-i'), argumentValue(result.argv, '-r'));
  assert.equal(argumentValue(result.argv, '--strength'), '0.65');
  assert.equal(helpCalls, 1);
});

test('sd.cpp preset and per-run image inputs override base config and retain zero strength', async (t) => {
  const fixture = createFixture(t, 'valid', { initImage: 'reference', strength: 0.8 });
  const initPath = path.join(fixture.root, 'different init image.png');
  fs.writeFileSync(initPath, PNG);
  fixture.cfg.presets.quality = { sdcpp: { initImage: initPath, strength: 0.35 } };
  await fixture.provider.checkReady();
  const preset = await fixture.provider.generate(generationParams({ preset: 'quality' }));
  assert.equal(argumentValue(preset.argv, '-i'), initPath);
  assert.equal(argumentValue(preset.argv, '--strength'), '0.35');
  assert.notEqual(argumentValue(preset.argv, '-i'), argumentValue(preset.argv, '-r'));
  const override = await fixture.provider.generate(generationParams({
    preset: 'quality', sdcpp: { initImage: 'reference', strength: 0 },
  }));
  assert.equal(argumentValue(override.argv, '-i'), fixture.reference);
  assert.equal(argumentValue(override.argv, '--strength'), '0');
  assert.equal(fixture.cfg.sdcpp.strength, 0.8);
  assert.equal(fixture.cfg.presets.quality.sdcpp.strength, 0.35);
});

test('sd.cpp skips each unsupported image input flag with a warning and still generates', async (t) => {
  for (const missingFlag of ['-i', '--strength']) {
    const warnings = [];
    const fixture = createFixture(t, 'valid', {
      initImage: missingFlag === '-i' ? 'missing image.png' : 'reference', strength: 0.5,
      fakeArgs: { 'omit-flags': missingFlag },
      providerOptions: { warner: message => warnings.push(message) },
    });
    assert.equal((await fixture.provider.checkReady()).ready, true);
    const result = await fixture.provider.generate(generationParams());
    assert.equal(result.argv.includes(missingFlag), false);
    assert.ok(warnings.some(message => message.includes(`Skipping configured ${missingFlag}:`)));
    assert.ok(result.warnings.some(warning => warning.code === 'SDCPP_FLAG_UNSUPPORTED'));
    assert.ok(result.argv.includes(missingFlag === '-i' ? '--strength' : '-i'));
  }
});

test('sd.cpp maps rectangular dimensions and rejects sizes outside multiples of 32', async (t) => {
  const fixture = createFixture(t);
  await fixture.provider.checkReady();
  const result = await fixture.provider.generate(generationParams({ width: 640, height: 960 }));
  assert.equal(argumentValue(result.argv, '-W'), '640');
  assert.equal(argumentValue(result.argv, '-H'), '960');
  for (const dimensions of [{ width: 641 }, { height: 0 }, { width: -32 }, { height: 32.5 }]) {
    await assert.rejects(fixture.provider.generate(generationParams(dimensions)), error => {
      assert.equal(error.generationStarted, false);
      assert.match(error.message, /multiples of 32/);
      return true;
    });
  }
});

test('sd.cpp rejects invalid supported image inputs before generation starts', async (t) => {
  const fixture = createFixture(t);
  await fixture.provider.checkReady();
  let starts = 0;
  for (const [sdcpp, message] of [
    [{ strength: -0.1 }, /strength must be between/],
    [{ strength: 1.1 }, /strength must be between/],
    [{ strength: 'invalid' }, /strength must be between/],
    [{ initImage: path.join(fixture.root, 'missing.png') }, /init image is missing or invalid/],
    [{ initImage: fixture.root }, /init image is missing or invalid/],
  ]) {
    await assert.rejects(fixture.provider.generate(generationParams({ sdcpp }), () => {}, undefined,
      () => { starts++; }), error => error.generationStarted === false && message.test(error.message));
  }
  assert.equal(starts, 0);
  assert.deepEqual(fs.readdirSync(fixture.outputDir), []);
});

test('sd.cpp rejects missing, empty, and invalid PNG output and preserves the stderr tail', async (t) => {
  for (const [mode, message] of [
    ['missing', /did not create/],
    ['empty', /empty or too small/],
    ['invalid', /PNG signature/],
  ]) {
    const fixture = createFixture(t, mode);
    await fixture.provider.checkReady();
    await assert.rejects(
      fixture.provider.generate(generationParams()),
      err => err.code === IMAGE_ERROR.FAILED
        && err.generationStarted === true
        && message.test(err.message),
    );
    assert.deepEqual(fs.readdirSync(fixture.outputDir), []);
  }

  const failed = createFixture(t, 'failure', { stderrTailBytes: 32 });
  await failed.provider.checkReady();
  await assert.rejects(
    failed.provider.generate({
      positivePrompt: 'safe',
      negativePrompt: '',
      referenceImage: 'default image.png',
      resolution: 768,
      steps: 12,
    }),
    (err) => {
      assert.equal(err.code, IMAGE_ERROR.FAILED);
      assert.equal(err.generationStarted, true);
      assert.match(err.message, /TAIL_MARKER/);
      assert.ok(err.stderrTail.length <= 32);
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(failed.outputDir), []);
});

test('sd.cpp rejects an already-aborted job before readiness or process spawn', async (t) => {
  const fixture = createFixture(t);
  let spawns = 0;
  let starts = 0;
  fixture.provider._spawn = () => {
    spawns++;
    throw new Error('must not spawn');
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fixture.provider.generate(
      generationParams(),
      () => {},
      controller.signal,
      () => { starts++; },
    ),
    err => err.code === IMAGE_ERROR.CANCELLED && err.generationStarted === false,
  );
  assert.equal(spawns, 0);
  assert.equal(starts, 0);
  assert.equal(fixture.provider.active, null);
});

test('sd.cpp job timeout covers readiness and preparation before process spawn', async (t) => {
  const fixture = createFixture(t, 'valid', { jobTimeoutMs: 50 });
  let spawns = 0;
  let starts = 0;
  fixture.provider._spawn = () => {
    spawns++;
    throw new Error('must not spawn');
  };
  fixture.provider.checkReady = signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(
    fixture.provider.generate(generationParams(), () => {}, undefined, () => { starts++; }),
    err => err.code === IMAGE_ERROR.TIMEOUT && err.generationStarted === false,
  );
  assert.equal(spawns, 0);
  assert.equal(starts, 0);
  assert.equal(fixture.provider.active, null);
});

test('sd.cpp cancellation after process exit cannot publish a validated output', async (t) => {
  const fixture = createFixture(t);
  await fixture.provider.checkReady();
  let enteredValidation;
  const validationStarted = new Promise(resolve => { enteredValidation = resolve; });
  let releaseValidation;
  const validationGate = new Promise(resolve => { releaseValidation = resolve; });
  const validateOutput = fixture.provider._validateOutput.bind(fixture.provider);
  fixture.provider._validateOutput = async (filePath) => {
    await validateOutput(filePath);
    enteredValidation();
    await validationGate;
  };

  const generation = fixture.provider.generate(generationParams());
  await validationStarted;
  const cancellation = fixture.provider.cancel();
  releaseValidation();
  await assert.rejects(generation, err => err.code === IMAGE_ERROR.CANCELLED);
  await cancellation;
  assert.deepEqual(fs.readdirSync(fixture.outputDir), []);
});

test('sd.cpp treats a rejected start callback as a post-start failure', async (t) => {
  const fixture = createFixture(t);
  await fixture.provider.checkReady();
  await assert.rejects(
    fixture.provider.generate(
      generationParams(),
      () => {},
      undefined,
      () => { throw new ImageProviderError(IMAGE_ERROR.CANCELLED, 'start rejected'); },
    ),
    err => err.code === IMAGE_ERROR.CANCELLED && err.generationStarted === true,
  );
  assert.deepEqual(fs.readdirSync(fixture.outputDir), []);
});

test('sd.cpp cancellation kills the whole child tree and deletes partial output', async (t) => {
  const heartbeat = path.join(os.tmpdir(), `sdcpp heartbeat ${process.pid} ${Date.now()}.txt`);
  const pidFile = path.join(os.tmpdir(), `sdcpp child ${process.pid} ${Date.now()}.txt`);
  t.after(() => {
    fs.rmSync(heartbeat, { force: true });
    fs.rmSync(pidFile, { force: true });
  });
  const fixture = createFixture(t, 'slow', {
    fakeArgs: { heartbeat, 'pid-file': pidFile },
    jobTimeoutMs: 5000,
  });
  await fixture.provider.checkReady();
  const controller = new AbortController();
  const generation = fixture.provider.generate({
    positivePrompt: 'safe',
    negativePrompt: '',
    referenceImage: 'default image.png',
    resolution: 768,
    steps: 12,
  }, () => {}, controller.signal);
  await waitFor(() => fs.existsSync(pidFile) && fs.existsSync(heartbeat));
  const childPid = Number(fs.readFileSync(pidFile, 'utf-8'));
  assert.equal(processIsAlive(childPid), true);
  controller.abort();
  await assert.rejects(generation, err => err.code === IMAGE_ERROR.CANCELLED);
  await waitFor(() => !processIsAlive(childPid));
  const heartbeatSize = fs.statSync(heartbeat).size;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fs.statSync(heartbeat).size, heartbeatSize);
  assert.deepEqual(fs.readdirSync(fixture.outputDir), []);
});

test('sd.cpp timeout kills the process tree and reports TIMEOUT', async (t) => {
  const heartbeat = path.join(os.tmpdir(), `sdcpp timeout heartbeat ${process.pid} ${Date.now()}.txt`);
  const pidFile = path.join(os.tmpdir(), `sdcpp timeout child ${process.pid} ${Date.now()}.txt`);
  t.after(() => {
    fs.rmSync(heartbeat, { force: true });
    fs.rmSync(pidFile, { force: true });
  });
  const fixture = createFixture(t, 'slow', {
    fakeArgs: { heartbeat, 'pid-file': pidFile },
    jobTimeoutMs: 500,
  });
  await fixture.provider.checkReady();
  const generation = fixture.provider.generate({
    positivePrompt: 'safe',
    negativePrompt: '',
    referenceImage: 'default image.png',
    resolution: 768,
    steps: 12,
  });
  await waitFor(() => fs.existsSync(pidFile));
  const childPid = Number(fs.readFileSync(pidFile, 'utf-8'));
  await assert.rejects(generation, err => err.code === IMAGE_ERROR.TIMEOUT);
  await waitFor(() => !processIsAlive(childPid));
  assert.deepEqual(fs.readdirSync(fixture.outputDir), []);
});

test('sd.cpp device preflight recognizes CUDA and Vulkan and rejects CPU-only listings', async (t) => {
  const cuda = createFixture(t);
  const vulkan = createFixture(t, 'vulkan');
  const cpu = createFixture(t, 'cpu-only');
  assert.equal((await cuda.provider.checkReady()).backend, 'cuda');
  const vk = await vulkan.provider.checkReady();
  assert.equal(vk.backend, 'vulkan');
  assert.equal(vk.deviceName, 'Fake AMD GPU');
  const offline = await cpu.provider.checkReady();
  assert.equal(offline.ready, false);
  assert.equal(offline.code, 'NO_GPU_BACKEND');
  for (const cause of ['CPU-only build', 'ggml-cuda.dll', 'cudart', 'different releases', 'old GPU driver']) {
    assert.ok(offline.message.includes(cause));
  }
  assert.deepEqual(parseSdCppDevices('CUDA support = false\nCPU0: CPU backend only'), {
    backend: null, deviceName: null, deviceIndex: null,
  });
  assert.deepEqual(parseSdCppDevices('ggml_cuda_init: found 1 CUDA devices:\nDevice 0: NVIDIA RTX 4090, VMM: yes'), {
    backend: 'cuda', deviceName: 'NVIDIA RTX 4090, VMM: yes', deviceIndex: 0,
  });
});

test('sd.cpp device parsing rejects unindexed CUDA diagnostics and zero-device counts', () => {
  for (const output of ['CUDA: 0 devices', 'CUDA: not available', 'CUDA: initializing backend',
    'Vulkan: 0 devices', 'CUDA support = true\nCPU0: CPU backend only']) {
    assert.equal(parseSdCppDevices(output).backend, null, output);
  }
});

test('sd.cpp parses terse indexed CUDA and Vulkan device tables without initialization logs', () => {
  assert.deepEqual(parseSdCppDevices('CUDA0\tNVIDIA GeForce RTX 5050 Laptop GPU'), {
    backend: 'cuda', deviceName: 'NVIDIA GeForce RTX 5050 Laptop GPU', deviceIndex: 0,
  });
  assert.deepEqual(parseSdCppDevices('Vulkan1  AMD Radeon RX 7900'), {
    backend: 'vulkan', deviceName: 'AMD Radeon RX 7900', deviceIndex: 1,
  });
  assert.equal(parseSdCppDevices('CUDA0 initializing backend').backend, null);
  assert.equal(parseSdCppDevices('CUDA0 devices: 0').backend, null);
});

test('sd.cpp device runner is injectable and its timeout is enforced even when it ignores abort', async (t) => {
  const calls = [];
  const fixture = createFixture(t, 'valid', {
    deviceTimeoutMs: 20,
    providerOptions: { runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args.includes('--list-devices')) return new Promise(() => {});
      return { code: 0, stdout: '--diffusion-model --vae --llm -r -p -n --steps --cfg-scale -W -H -s -o' };
    } },
  });
  const startedAt = Date.now();
  const readiness = await fixture.provider.checkReady();
  assert.equal(readiness.code, 'NO_GPU_BACKEND');
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.at(-1), '--list-devices');
  assert.equal(calls[1].options.timeoutMs, 20);
  assert.equal(calls[1].options.signal.aborted, true);
});

test('sd.cpp diagnoses CUDA runtime DLLs beside the binary and on PATH without executing them', async (t) => {
  const fixture = createFixture(t, 'cpu-only', {
    providerOptions: {
      platform: 'win32', env: { PATH: '' },
      runCommand: async (_command, args) => ({ code: 0, stdout: args.includes('--help')
        ? '--diffusion-model --vae --llm -r -p -n --steps --cfg-scale -W -H -s -o'
        : 'CPU0: CPU backend only' }),
    },
  });
  fixture.cfg.sdcpp.binaryPath = path.join(fixture.root, 'sd-cli.exe');
  fs.writeFileSync(fixture.cfg.sdcpp.binaryPath, 'fake binary');
  fs.writeFileSync(path.join(fixture.root, 'ggml-cuda.dll'), 'fake cuda backend');
  const missing = await fixture.provider.checkReady();
  assert.equal(missing.code, 'CUDA_RUNTIME_MISSING');
  assert.match(missing.message, /cudart zip from the same release/);
  const runtimePath = path.join(fixture.root, 'CUDA runtime with spaces');
  fs.mkdirSync(runtimePath);
  fs.writeFileSync(path.join(runtimePath, 'cudart64_12.dll'), 'fake runtime');
  fs.writeFileSync(path.join(runtimePath, 'cublas64_12.dll'), 'fake runtime');
  fixture.provider.env.PATH = runtimePath;
  assert.equal((await fixture.provider.checkReady()).code, 'NO_GPU_BACKEND');
  fixture.provider.platform = 'linux';
  fixture.provider.env.PATH = '';
  assert.equal((await fixture.provider.checkReady()).code, 'NO_GPU_BACKEND');
});

test('sd.cpp CUDA runtime directory scans are bounded and caller-abortable', async (t) => {
  let binaryDirectory;
  let enteredPath = () => {};
  const fixture = createFixture(t, 'cpu-only', {
    deviceTimeoutMs: 20,
    providerOptions: {
      platform: 'win32', env: { PATH: path.win32.join('X:', '/', 'Path With Spaces', 'unavailable network path') },
      runCommand: async (_command, args) => ({ code: 0, stdout: args.includes('--help')
        ? '--diffusion-model --vae --llm -r -p -n --steps --cfg-scale -W -H -s -o'
        : 'CPU0: CPU backend only' }),
      readDirectory: async directory => {
        if (directory === binaryDirectory) return [{ name: 'ggml-cuda.dll', isFile: () => true }];
        enteredPath();
        return new Promise(() => {});
      },
    },
  });
  binaryDirectory = fixture.root;
  fixture.cfg.sdcpp.binaryPath = path.join(fixture.root, 'sd-cli.exe');
  fs.writeFileSync(fixture.cfg.sdcpp.binaryPath, 'fake binary');
  const startedAt = Date.now();
  assert.equal((await fixture.provider.checkReady()).code, 'NO_GPU_BACKEND');
  assert.ok(Date.now() - startedAt < 1000);
  fixture.cfg.sdcpp.deviceTimeoutMs = 1000;
  const entered = new Promise(resolve => { enteredPath = resolve; });
  const controller = new AbortController();
  const pending = fixture.provider.checkReady(controller.signal);
  await entered;
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('sd.cpp allowCpu overrides device and runtime CPU checks', async (t) => {
  const cpu = createFixture(t, 'cpu-only', { allowCpu: true });
  const readiness = await cpu.provider.checkReady();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.backend, 'cpu');
  const allowed = createFixture(t, 'cpu-message', { allowCpu: true });
  await allowed.provider.checkReady();
  const result = await allowed.provider.generate(generationParams());
  assert.ok(fs.existsSync(result.imagePath));
});

test('sd.cpp runtime CPU fallback aborts a split warning, kills its child tree, and removes partial output', async (t) => {
  const fixture = createFixture(t, 'cpu-fallback', { jobTimeoutMs: 5000 });
  const heartbeat = path.join(fixture.root, 'CPU child heartbeat.txt');
  const pidFile = path.join(fixture.root, 'CPU child pid.txt');
  fixture.cfg.sdcpp.extraArgs.push(`--heartbeat=${heartbeat}`, `--pid-file=${pidFile}`);
  await fixture.provider.checkReady();
  const startedAt = Date.now();
  await assert.rejects(fixture.provider.generate(generationParams()), error => {
    assert.equal(error.code, 'NO_GPU_BACKEND');
    assert.equal(error.generationStarted, true);
    return true;
  });
  assert.ok(Date.now() - startedAt < 2000);
  const childPid = Number(fs.readFileSync(pidFile, 'utf-8'));
  await waitFor(() => !processIsAlive(childPid));
  assert.deepEqual(fs.readdirSync(fixture.outputDir), []);
  assert.equal(fixture.provider.getStatus().code, 'NO_GPU_BACKEND');
  assert.ok(fixture.provider.getFinalArgv().includes('-o'));
});

test('sd.cpp CPU offload messages do not trigger the runtime CPU-only guard', async (t) => {
  const fixture = createFixture(t, 'cpu-offload');
  await fixture.provider.checkReady();
  const result = await fixture.provider.generate(generationParams());
  assert.ok(fs.existsSync(result.imagePath));
  assert.equal(fixture.provider.getStatus().ready, true);
});

test('sd.cpp runtime guard joins newline-separated CPU fallback diagnostics across chunks', async (t) => {
  const fixture = createFixture(t, 'cpu-multiline', { jobTimeoutMs: 5000 });
  await fixture.provider.checkReady();
  const startedAt = Date.now();
  await assert.rejects(fixture.provider.generate(generationParams()), error => error.code === 'NO_GPU_BACKEND');
  assert.ok(Date.now() - startedAt < 2000);
  assert.deepEqual(fs.readdirSync(fixture.outputDir), []);
});

test('sd.cpp runtime guard waits for complete component CPU backend lines before deciding', async (t) => {
  const fixture = createFixture(t, 'cpu-offload-split');
  await fixture.provider.checkReady();
  const result = await fixture.provider.generate(generationParams());
  assert.ok(fs.existsSync(result.imagePath));
  assert.equal(fixture.provider.getStatus().ready, true);
});

test('sd.cpp config and preset arguments append, skip unknown flags with their values, and cache help', async (t) => {
  const warnings = [];
  const fixture = createFixture(t, 'valid', {
    args: ['--sampling-method', 'euler', '--unknown-flag', 'discard me', '--diffusion-fa'],
    modelArgs: ['qwen_image_2_1_prefix_cache=false'],
    presets: { hemat: { sdcpp: { args: ['--vae-tiling'], modelArgs: ['another_key=true'] } } },
    providerOptions: { warner: message => warnings.push(message) },
  });
  let helpCalls = 0;
  const runHelp = fixture.provider._runHelp.bind(fixture.provider);
  fixture.provider._runHelp = async signal => { helpCalls++; return runHelp(signal); };
  await fixture.provider.checkReady();
  await fixture.provider.checkReady();
  assert.equal(helpCalls, 1);
  const result = await fixture.provider.generate(generationParams({ preset: 'hemat' }));
  assert.ok(result.argv.includes('--diffusion-fa'));
  assert.ok(result.argv.includes('--vae-tiling'));
  assert.equal(result.argv.includes('--unknown-flag'), false);
  assert.equal(result.argv.includes('discard me'), false);
  assert.equal(argumentValue(result.argv, '--model-args'), 'qwen_image_2_1_prefix_cache=false,another_key=true');
  assert.ok(warnings.some(message => message.includes('--unknown-flag')));
  assert.equal(argumentValue(result.argv, '-o').endsWith('.tmp.png'), true);
  const logText = fs.readFileSync(fixture.cfg.logPath, 'utf-8');
  assert.match(logText, /final argv: \[/);
  assert.match(logText, /backend\/device: cuda \/ Fake NVIDIA GPU/);
});

test('sd.cpp missing optional tuning flags and modelArgs support are skipped rather than disabling readiness', async (t) => {
  const warnings = [];
  const fixture = createFixture(t, 'valid', {
    args: ['--offload-to-cpu'], modelArgs: ['custom_key=false'],
    providerOptions: { warner: message => warnings.push(message) },
  });
  await fixture.provider.checkReady();
  fixture.provider._helpText = '--diffusion-model --vae --llm -r -p -n --steps --cfg-scale -W -H -s -o';
  const built = fixture.provider.buildArgs(generationParams(), path.join(fixture.outputDir, 'out.png'));
  assert.equal(built.args.includes('--offload-to-cpu'), false);
  assert.equal(built.args.includes('--model-args'), false);
  assert.equal(warnings.length, 2);
  assert.equal(argumentValue(built.args, '-p'), 'safe');
});

test('sd.cpp refuses insufficient heuristic memory before spawn and forceRun permits the same tier', async (t) => {
  const memory = { memoryTier: 'insufficient', message: 'Heuristic: insufficient RAM.', heuristic: true };
  const fixture = createFixture(t, 'valid', { memoryMonitor: {
    preflight: async () => memory, start: () => ({ stop: () => null }),
  } });
  await fixture.provider.checkReady();
  let starts = 0;
  await assert.rejects(fixture.provider.generate(generationParams(), () => {}, undefined, () => { starts++; }), error => {
    assert.equal(error.code, 'MEMORY_INSUFFICIENT');
    assert.equal(error.generationStarted, false);
    return true;
  });
  assert.equal(starts, 0);
  assert.equal(fixture.provider.getStatus().memoryTier, 'insufficient');
  assert.ok(fixture.provider.getFinalArgv());
  fixture.cfg.sdcpp.forceRun = true;
  const result = await fixture.provider.generate(generationParams());
  assert.equal(result.memory.memoryTier, 'insufficient');
  assert.ok(fs.existsSync(result.imagePath));
});

test('sd.cpp forwards effective offload and device to memory preflight and logs a tight warning', async (t) => {
  const calls = [];
  const warnings = [];
  const fixture = createFixture(t, 'valid', {
    args: [], presets: { hemat: { sdcpp: { args: ['--offload-to-cpu'] } } },
    providerOptions: { warner: message => warnings.push(message) },
    memoryMonitor: { preflight: async options => {
      calls.push(options);
      return { memoryTier: 'tight', message: 'Heuristic: VRAM is tight.', heuristic: true };
    } },
  });
  await fixture.provider.checkReady();
  await fixture.provider.generate(generationParams({ preset: 'hemat' }));
  assert.equal(calls[0].offloadToCpu, true);
  assert.equal(calls[0].backend, 'cuda');
  assert.equal(calls[0].deviceName, 'Fake NVIDIA GPU');
  assert.equal(calls[0].deviceIndex, 0);
  assert.ok(warnings.some(message => message.includes('VRAM is tight')));
  assert.equal(fixture.provider.getStatus().memoryTier, 'tight');
});

test('sd.cpp telemetry stops on process exit and retains peaks for successful and failed jobs', async (t) => {
  const peaks = { vramUsedGB: 7, privateBytesGB: 5, peakWorkingSetGB: 4, commitUsedGB: 30, commitLimitGB: 48 };
  for (const mode of ['valid', 'failure']) {
    let starts = 0;
    let stops = 0;
    const fixture = createFixture(t, mode, {
      telemetryEnabled: true,
      memoryMonitor: {
        preflight: async () => ({ memoryTier: 'ok', message: 'Heuristic memory check passed.', heuristic: true }),
        start: pid => {
          assert.ok(Number.isSafeInteger(pid)); starts++;
          return { stop: () => { stops++; return peaks; } };
        },
      },
    });
    await fixture.provider.checkReady();
    const generation = fixture.provider.generate(generationParams());
    if (mode === 'valid') assert.deepEqual((await generation).peaks, peaks);
    else await assert.rejects(generation, error => error.code === IMAGE_ERROR.FAILED);
    assert.equal(starts, 1);
    assert.equal(stops, 1);
    assert.deepEqual(fixture.provider.getStatus().lastPeaks, peaks);
  }
});

test('sd.cpp memory and telemetry probe failures cannot fail image generation', async (t) => {
  for (const failure of ['preflight', 'start', 'stop']) {
    const fixture = createFixture(t, 'valid', {
      telemetryEnabled: true,
      memoryMonitor: {
        preflight: async () => {
          if (failure === 'preflight') throw new Error('Probe unavailable');
          return { memoryTier: 'ok', message: 'Heuristic memory check passed.', heuristic: true };
        },
        start: () => {
          if (failure === 'start') throw new Error('Sampler unavailable');
          return { stop: () => { if (failure === 'stop') throw new Error('Stop unavailable'); return null; } };
        },
      },
    });
    await fixture.provider.checkReady();
    const result = await fixture.provider.generate(generationParams());
    assert.ok(fs.existsSync(result.imagePath));
  }
});

test('sd.cpp retains display history while refusing to attribute prior peaks to a later failed sampler', async (t) => {
  const peaks = { vramUsedGB: 7, privateBytesGB: 5, peakWorkingSetGB: 4, commitUsedGB: 30, commitLimitGB: 48 };
  let jobs = 0;
  const fixture = createFixture(t, 'valid', {
    telemetryEnabled: true,
    memoryMonitor: {
      preflight: async () => ({ memoryTier: 'ok', message: 'Heuristic memory check passed.', heuristic: true }),
      start: () => {
        jobs++;
        if (jobs === 2) throw new Error('Sampler unavailable for the second job');
        return { stop: () => peaks };
      },
    },
  });
  await fixture.provider.checkReady();
  await fixture.provider.generate(generationParams());
  assert.deepEqual(fixture.provider.getGenerationPeaks(), peaks);
  const second = await fixture.provider.generate(generationParams());
  assert.equal(second.peaks, null);
  assert.equal(fixture.provider.getGenerationPeaks(), null);
  assert.deepEqual(fixture.provider.getStatus().lastPeaks, peaks);
});

test('sd.cpp maps offloadToCpu without an args flag and logs the effective base and preset config', async (t) => {
  const calls = [];
  const fixture = createFixture(t, 'valid', {
    offloadToCpu: true,
    args: ['--sampling-method', 'euler'],
    presets: { hemat: { sdcpp: { args: ['--vae-tiling'] } } },
    memoryMonitor: { preflight: async options => {
      calls.push(options);
      return { memoryTier: 'ok', message: 'Heuristic memory check passed.', heuristic: true };
    } },
  });
  await fixture.provider.checkReady();
  const result = await fixture.provider.generate(generationParams({ preset: 'hemat' }));
  assert.equal(result.argv.filter(value => value === '--offload-to-cpu').length, 1);
  assert.equal(calls[0].offloadToCpu, true);
  const expected = {
    offloadToCpu: true, args: ['--sampling-method', 'euler'],
    presetArgs: ['--vae-tiling'], effectiveOffloadToCpu: true,
  };
  assert.deepEqual(result.effectiveConfig, expected);
  assert.deepEqual(fixture.provider.getEffectiveConfig(), expected);
  assert.ok(fs.readFileSync(fixture.cfg.logPath, 'utf-8').includes('effective config: ' + JSON.stringify(expected)));
  assert.deepEqual(fixture.cfg.sdcpp.args, ['--sampling-method', 'euler']);
  result.effectiveConfig.args.push('--unexpected');
  assert.deepEqual(fixture.provider.getEffectiveConfig(), expected);
});

test('sd.cpp explicit offload false removes the base flag and a preset can enable it', async (t) => {
  const calls = [];
  const fixture = createFixture(t, 'valid', {
    offloadToCpu: false,
    args: ['--sampling-method', 'euler', '--offload-to-cpu'],
    presets: { hemat: { sdcpp: { args: ['--offload-to-cpu'] } } },
    memoryMonitor: { preflight: async options => {
      calls.push(options);
      return { memoryTier: 'ok', message: 'Heuristic memory check passed.', heuristic: true };
    } },
  });
  await fixture.provider.checkReady();
  const base = await fixture.provider.generate(generationParams());
  assert.equal(base.argv.includes('--offload-to-cpu'), false);
  assert.equal(calls[0].offloadToCpu, false);
  const preset = await fixture.provider.generate(generationParams({ preset: 'hemat' }));
  assert.equal(preset.argv.filter(value => value === '--offload-to-cpu').length, 1);
  assert.equal(calls[1].offloadToCpu, true);
  assert.equal(preset.effectiveConfig.offloadToCpu, false);
  assert.equal(preset.effectiveConfig.effectiveOffloadToCpu, true);
});

test('sd.cpp unsupported mapped offload warns and preflight uses the effective GPU-only argv', async (t) => {
  const calls = [];
  const warnings = [];
  const fixture = createFixture(t, 'valid', {
    args: [], offloadToCpu: true,
    providerOptions: { warner: message => warnings.push(message) },
    memoryMonitor: { preflight: async options => {
      calls.push(options);
      return { memoryTier: 'ok', message: 'Heuristic memory check passed.', heuristic: true };
    } },
  });
  await fixture.provider.checkReady();
  fixture.provider._helpText = fixture.provider._helpText.replace('--offload-to-cpu', '');
  const result = await fixture.provider.generate(generationParams());
  assert.equal(calls[0].offloadToCpu, false);
  assert.equal(result.effectiveConfig.offloadToCpu, true);
  assert.equal(result.effectiveConfig.effectiveOffloadToCpu, false);
  assert.ok(warnings.some(message => message.includes('Skipping configured sd-cli argument --offload-to-cpu')));
});

test('sd.cpp GGUF reference generation refuses missing vision projection before preflight or spawn', async (t) => {
  let preflights = 0;
  let spawns = 0;
  const fixture = createFixture(t, 'valid', {
    llmExtension: 'GGUF', forceRun: true,
    memoryMonitor: { preflight: async () => { preflights++; } },
  });
  await fixture.provider.checkReady();
  fixture.provider.spawnProcess = () => { spawns++; throw new Error('Unexpected native process'); };
  await assert.rejects(fixture.provider.generate(generationParams()), error => {
    assert.equal(error.code, 'LLM_VISION_MISSING');
    assert.equal(error.generationStarted, false);
    assert.match(error.message, /needs the Qwen3-VL mmproj file/);
    return true;
  });
  assert.equal(preflights, 0);
  assert.equal(spawns, 0);
  assert.equal(fixture.provider.getStatus().code, 'LLM_VISION_MISSING');
  assert.ok(fixture.provider.getFinalArgv().includes('-r'));
  assert.equal(fixture.provider.getFinalArgv().includes('--llm_vision'), false);
  assert.ok(fixture.provider.getEffectiveConfig());
  assert.match(fs.readFileSync(fixture.cfg.logPath, 'utf-8'), /effective config:/);
  assert.deepEqual(fs.readdirSync(fixture.outputDir), []);
});

test('sd.cpp GGUF reference generation accepts the configured mmproj and safetensors need no projection', async (t) => {
  const gguf = createFixture(t, 'valid', { llmExtension: 'gguf' });
  gguf.cfg.sdcpp.llmVision = path.join(gguf.root, 'Qwen3-VL mmproj.gguf');
  fs.writeFileSync(gguf.cfg.sdcpp.llmVision, 'fake mmproj');
  await gguf.provider.checkReady();
  const result = await gguf.provider.generate(generationParams());
  assert.equal(argumentValue(result.argv, '--llm_vision'), gguf.cfg.sdcpp.llmVision);
  assert.ok(fs.existsSync(result.imagePath));
  const safetensors = createFixture(t);
  await safetensors.provider.checkReady();
  const safe = await safetensors.provider.generate(generationParams());
  assert.equal(safe.argv.includes('--llm_vision'), false);
  assert.ok(fs.existsSync(safe.imagePath));
});

test('sd.cpp early vision failure does not reuse the preceding generation memory diagnostics', async (t) => {
  let preflights = 0;
  const fixture = createFixture(t, 'valid', { memoryMonitor: {
    preflight: async () => {
      preflights++;
      return { memoryTier: 'tight', message: 'Earlier job memory check.', heuristic: true };
    },
  } });
  await fixture.provider.checkReady();
  await fixture.provider.generate(generationParams());
  assert.equal(fixture.provider.getStatus().memoryTier, 'tight');
  fixture.cfg.sdcpp.args = ['--llm', 'new-encoder.gguf'];
  await assert.rejects(fixture.provider.generate(generationParams()), error => error.code === 'LLM_VISION_MISSING');
  assert.equal(preflights, 1);
  assert.equal(fixture.provider.getStatus().memoryTier, null);
  assert.equal(fixture.provider.getStatus().memoryMessage, null);
});

test('sd.cpp vision sanity inspects effective LLM and projection overrides in argv', async (t) => {
  const fixture = createFixture(t, 'valid', { args: ['--llm', 'overridden.gguf'] });
  await fixture.provider.checkReady();
  await assert.rejects(fixture.provider.generate(generationParams()), error => error.code === 'LLM_VISION_MISSING');
  fixture.cfg.sdcpp.args.push('--llm_vision', 'Qwen3-VL mmproj.gguf');
  const result = await fixture.provider.generate(generationParams());
  assert.ok(fs.existsSync(result.imagePath));
});

test('sd.cpp offload-off low VRAM sanity warns with a code and permits a tight run', async (t) => {
  const warnings = [];
  const fixture = createFixture(t, 'valid', {
    offloadToCpu: false, args: [],
    providerOptions: { warner: message => warnings.push(message) },
    memoryMonitor: { preflight: async () => ({
      memoryTier: 'tight', message: 'Heuristic VRAM below estimate.', heuristic: true,
      requirements: { vramGB: 10.2 }, freeVramGB: 6.9,
    }) },
  });
  await fixture.provider.checkReady();
  const result = await fixture.provider.generate(generationParams());
  assert.ok(fs.existsSync(result.imagePath));
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'OFFLOAD_OFF_LOW_VRAM');
  assert.match(result.warnings[0].message, /10\.2 GB.*6\.9 GB/);
  assert.ok(warnings.some(message => message.includes('[OFFLOAD_OFF_LOW_VRAM]')));
  assert.deepEqual(fixture.provider.getSanityWarnings(), result.warnings);
  fixture.cfg.sdcpp.offloadToCpu = true;
  const offloaded = await fixture.provider.generate(generationParams());
  assert.deepEqual(offloaded.warnings, []);
});

test('sd.cpp offload-off sanity treats unavailable VRAM as unknown and retains hard memory refusal', async (t) => {
  const warnings = [];
  const memory = {
    memoryTier: 'tight', message: 'Heuristic unknown VRAM.', heuristic: true,
    requirements: { vramGB: 10 }, freeVramGB: null,
  };
  const fixture = createFixture(t, 'valid', {
    offloadToCpu: false, args: [],
    providerOptions: { warner: message => warnings.push(message) },
    memoryMonitor: { preflight: async () => memory },
  });
  await fixture.provider.checkReady();
  assert.deepEqual((await fixture.provider.generate(generationParams())).warnings, []);
  memory.memoryTier = 'insufficient';
  memory.freeVramGB = 1;
  await assert.rejects(fixture.provider.generate(generationParams()), error => error.code === 'MEMORY_INSUFFICIENT');
  assert.equal(fixture.provider.getSanityWarnings()[0].code, 'OFFLOAD_OFF_LOW_VRAM');
  assert.ok(warnings.some(message => message.includes('[OFFLOAD_OFF_LOW_VRAM]')));
});
