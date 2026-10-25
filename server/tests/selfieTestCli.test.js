import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySelfieTestOverrides, parseSelfieTestArgs, runSelfieTest } from '../selfie/selfieTest.js';
import { appendSelfieRun } from '../selfie/selfieExperiments.js';
import { ProviderResolver } from '../selfie/providerResolver.js';
import { SdCppProvider } from '../selfie/providers/sdcppProvider.js';

function harness(outcome = 'success') {
  const lines = [];
  const records = [];
  const rows = [];
  const config = {
    provider: 'sdcpp', preset: 'hemat', defaultReference: 'reference.png', etaStorePath: 'unused-history.json',
    etaHistorySize: 5, telemetry: { enabled: true },
    sdcpp: { offloadToCpu: false, args: ['--sampling-method', 'euler'] },
    presets: { hemat: { resolution: 768, steps: 12, cfg: 3, sdcpp: { args: ['--vae-tiling'], modelArgs: [] } } },
  };
  const peaks = { vramUsedGB: 2, privateBytesGB: 4, peakWorkingSetGB: 3, commitUsedGB: 12, commitLimitGB: 32 };
  const argv = ['--llm', path.win32.join('X:', '/', 'Path With Spaces', 'llm.gguf'), '--vae-tiling'];
  const effectiveConfig = {
    offloadToCpu: false, args: ['--sampling-method', 'euler'],
    presetArgs: ['--vae-tiling'], effectiveOffloadToCpu: false,
  };
  const warnings = [{ code: 'OFFLOAD_OFF_LOW_VRAM', message: 'Estimated VRAM exceeds free VRAM.' }];
  const metadata = { ready: true, code: 'READY', backend: 'cuda', deviceName: 'Fake GPU',
    memoryTier: 'tight', memoryMessage: 'Heuristic: memory is tight.', lastPeaks: peaks };
  let received;
  const provider = {
    checkReady: async () => ({ ready: true, code: 'READY' }),
    getStatus: () => ({ active: 'sdcpp', reasons: { comfyui: 'Offline.', sdcpp: null }, sdcpp: metadata }),
    getGenerationStatus: () => metadata,
    getGenerationPeaks: () => peaks,
    getFinalArgv: () => [...argv],
    getEffectiveConfig: () => effectiveConfig,
    getSanityWarnings: () => warnings,
    generate: async (params, progress, signal, onStarted) => {
      received = params;
      onStarted('sdcpp');
      if (outcome === 'failed') throw Object.assign(new Error('CPU fallback'), { code: 'NO_GPU_BACKEND' });
      progress({ value: 1, max: 1 });
      return { imagePath: 'fake.png', provider: 'sdcpp', seed: 42, argv, peaks, effectiveConfig, warnings,
        memory: { memoryTier: 'tight', message: metadata.memoryMessage },
        timings: { queueMs: 0, generateMs: 100, downloadMs: 0, totalMs: 100 } };
    },
  };
  return {
    config, provider, records, rows, lines, get received() { return received; },
    appendRun: async row => rows.push(row),
    history: {
      getEta: () => null,
      recordDuration: (...values) => records.push({ type: 'duration', values }),
      recordPeaks: (...values) => records.push({ type: 'peaks', values }),
    },
    output: { log: line => lines.push(line), error: line => lines.push(line) },
  };
}

test('selfie:test hemat prints readiness, device, memory, safe argv, timings and peaks using only fakes', async () => {
  const h = harness();
  assert.equal(await runSelfieTest({ ...h, createProvider: async () => h.provider }), 0);
  const text = h.lines.join('\n');
  for (const match of [/readiness: READY/, /cuda.*Fake GPU/, /memory\s+: tight/, /argv.*Path With Spaces/,
    /totalMs\s+: 100 ms/, /peaks GB.*vramUsedGB.*commitUsedGB.*peakWorkingSetGB|peaks GB.*peakWorkingSetGB.*commitUsedGB/]) {
    assert.match(text, match);
  }
  assert.equal(h.received.preset, 'hemat');
  assert.deepEqual(h.received.sdcpp.args, ['--vae-tiling']);
  assert.deepEqual(h.records.map(record => record.type), ['duration', 'peaks']);
});

test('selfie:test prints failed-job argv and peaks, persists telemetry, and leaves ETA unchanged', async () => {
  const h = harness('failed');
  assert.equal(await runSelfieTest({ ...h, createProvider: async () => h.provider }), 1);
  assert.match(h.lines.join('\n'), /FAILED \[NO_GPU_BACKEND\]/);
  assert.match(h.lines.join('\n'), /argv.*Path With Spaces/);
  assert.deepEqual(h.records.map(record => record.type), ['peaks']);
});

test('selfie:test prints requested and effective config and warning codes on success and failure', async () => {
  for (const outcome of ['success', 'failed']) {
    const h = harness(outcome);
    assert.equal(await runSelfieTest({ ...h, createProvider: async () => h.provider }), outcome === 'success' ? 0 : 1);
    const config = JSON.parse(h.lines.find(line => line.startsWith('config   : ')).slice('config   : '.length));
    const effective = JSON.parse(h.lines.find(line => line.startsWith('effective: ')).slice('effective: '.length));
    assert.deepEqual(config, {
      offloadToCpu: false, args: ['--sampling-method', 'euler'], presetArgs: ['--vae-tiling'],
    });
    assert.equal(effective.effectiveOffloadToCpu, false);
    assert.deepEqual(effective.args, config.args);
    assert.deepEqual(effective.presetArgs, config.presetArgs);
    assert.match(h.lines.join('\n'), /warning\s+: \[OFFLOAD_OFF_LOW_VRAM\]/);
  }
});

test('selfie:test prints config and projection sanity failure before generation without recording history', async () => {
  const h = harness();
  h.provider.getSanityWarnings = () => [];
  h.provider.generate = async () => {
    throw Object.assign(new Error('Reference input with a GGUF LLM needs the Qwen3-VL mmproj file.'), {
      code: 'LLM_VISION_MISSING', generationStarted: false,
    });
  };
  assert.equal(await runSelfieTest({ ...h, createProvider: async () => h.provider }), 1);
  assert.match(h.lines.join('\n'), /FAILED \[LLM_VISION_MISSING\].*Qwen3-VL mmproj/);
  assert.match(h.lines.join('\n'), /effective:.*offloadToCpu/);
  assert.deepEqual(h.records, []);
});

test('selfie:test prints loaded config when readiness fails before an argv is built', async () => {
  const h = harness();
  h.provider.checkReady = async () => ({ ready: false, code: 'NO_GPU_BACKEND', message: 'No GPU.' });
  assert.equal(await runSelfieTest({ ...h, createProvider: async () => h.provider }), 3);
  assert.match(h.lines.join('\n'), /config\s+:.*"offloadToCpu":false/);
  assert.deepEqual(h.records, []);
});

test('selfie:test parses split and equals forms, zero strength/seed and repeated additions', () => {
  const options = parseSelfieTestArgs([
    '--provider=sdcpp', '--preset', 'hemat', '--steps', '20', '--cfg=4.5', '--size', '512x768',
    '--strength=0', '--init-image', 'reference', '--seed', '0', '--arg', '--diffusion-fa',
    '--arg=--batch-count=2', '--drop-arg', '--vae-tiling', '--drop-arg=--offload-to-cpu',
    '--model-arg', 'shift=0.5', '--model-arg=offload=true', '--label', 'A | B', '--reference', 'some image.png',
  ], { npm_config_provider: 'comfyui', npm_config_preset: 'kualitas' });
  assert.deepEqual(options, {
    provider: 'sdcpp', preset: 'hemat', steps: 20, cfg: 4.5, width: 512, height: 768,
    strength: 0, initImage: 'reference', seed: 0, args: ['--diffusion-fa', '--batch-count=2'],
    droppedArgs: ['--vae-tiling', '--offload-to-cpu'], modelArgs: ['shift=0.5', 'offload=true'],
    label: 'A | B', reference: 'some image.png',
  });
  assert.equal(parseSelfieTestArgs(['--seed=-1']).seed, -1);
  assert.equal(parseSelfieTestArgs([], { npm_config_provider: 'sdcpp' }).provider, 'sdcpp');
});

test('selfie:test accepts managed profiles in both forms and applies them without changing config', () => {
  const h = harness();
  h.config.comfyuiManaged = {
    profile: 'base', profiles: { base: { args: [] }, lowvram: { args: ['--lowvram'] } },
  };
  const before = structuredClone(h.config);
  for (const args of [['--profile', 'lowvram'], ['--profile=lowvram']]) {
    const options = parseSelfieTestArgs(['--provider=comfyui-managed', ...args]);
    assert.equal(options.provider, 'comfyui-managed');
    assert.equal(options.profile, 'lowvram');
    const config = applySelfieTestOverrides(h.config, options);
    assert.equal(config.comfyuiManaged.profile, 'lowvram');
    assert.deepEqual(config.comfyuiManaged.profiles, h.config.comfyuiManaged.profiles);
  }
  assert.deepEqual(h.config, before);
  assert.equal(parseSelfieTestArgs([], { npm_config_profile: 'lowvram' }).profile, 'lowvram');
  assert.throws(() => applySelfieTestOverrides(h.config, { profile: 'missing' }), /Unknown ComfyUI managed profile: missing/);
  assert.throws(() => parseSelfieTestArgs(['--profile']), /requires a value/);
});

test('selfie:test reports managed cold start separately, records profile and peaks, and shuts down after release', async () => {
  for (const outcome of ['success', 'failed']) {
    const h = harness();
    h.config.provider = 'comfyui-managed';
    h.config.comfyuiManaged = { profile: 'lowvram', profiles: { lowvram: { args: ['--lowvram'] } } };
    const peaks = { vramUsedGB: 6, sharedGpuUsedGB: 2, privateBytesGB: 8, peakWorkingSetGB: 7, commitUsedGB: 20 };
    const timings = { coldStartMs: 650, queueMs: 10, generateMs: 100, downloadMs: 5, totalMs: 115 };
    const lifecycle = [];
    const metadata = { profile: 'lowvram', running: true, ready: true, code: 'READY' };
    h.provider.getStatus = () => ({ active: 'comfyui-managed', reasons: {}, comfyuiManaged: metadata });
    h.provider.getGenerationStatus = () => metadata;
    h.provider.getGenerationTimings = () => timings;
    h.provider.getGenerationPeaks = () => peaks;
    h.provider.getFinalArgv = () => [path.win32.join('X:', '/', 'Path With Spaces', 'main.py'), '--lowvram'];
    h.provider.generate = async (params, progress, signal, onStarted) => {
      assert.equal(params.recordRun, false, 'CLI owns its one run-log row');
      onStarted('comfyui-managed');
      if (outcome === 'failed') throw Object.assign(new Error('Missing node: ExampleLoader'), { code: 'COMFY_NODE_MISSING' });
      return { imagePath: 'managed.png', provider: 'comfyui-managed', seed: 7, timings, peaks };
    };
    h.provider.release = async () => { lifecycle.push('release'); };
    h.provider.shutdown = async () => { lifecycle.push('shutdown'); };
    assert.equal(await runSelfieTest({ ...h, createProvider: async () => h.provider }), outcome === 'success' ? 0 : 1);
    assert.match(h.lines.join('\n'), /coldStartMs\s*: 650 ms/);
    assert.match(h.lines.join('\n'), /generateMs\s*: 100 ms/);
    assert.match(h.lines.join('\n'), /profile\s*: lowvram/);
    assert.match(h.lines.join('\n'), /peaks GB.*sharedGpuUsedGB.*privateBytesGB.*peakWorkingSetGB.*commitUsedGB/);
    assert.equal(h.rows.length, 1);
    assert.equal(h.rows[0].provider, 'comfyui-managed');
    assert.equal(h.rows[0].profile, 'lowvram');
    assert.equal(h.rows[0].timings.coldStartMs, 650);
    assert.equal(h.rows[0].timings.generateMs, 100);
    assert.deepEqual(h.rows[0].peaks, peaks);
    assert.deepEqual(lifecycle, ['release', 'shutdown']);
    assert.equal(h.records.filter(record => record.type === 'peaks').length, 1);
  }
});

test('selfie:test shuts down even when run logging and provider release fail', async () => {
  const h = harness();
  const lifecycle = [];
  h.provider.release = async () => { lifecycle.push('release'); throw new Error('free failed'); };
  h.provider.shutdown = async () => { lifecycle.push('shutdown'); };
  assert.equal(await runSelfieTest({
    ...h, createProvider: async () => h.provider,
    appendRun: async () => { lifecycle.push('append'); throw new Error('log failed'); },
  }), 1);
  assert.deepEqual(lifecycle, ['append', 'release', 'shutdown']);
  assert.match(h.lines.join('\n'), /FAILED \[RUN_LOG\]: log failed/);
  assert.match(h.lines.join('\n'), /FAILED \[RELEASE\]: free failed/);
});

test('selfie:test rejects invalid numeric, size, flag, model and missing-value options', () => {
  for (const args of [
    ['--steps=0'], ['--steps=1.5'], ['--cfg=0'], ['--cfg=Infinity'], ['--strength=-0.1'], ['--strength=1.1'],
    ['--size=512x767'], ['--size=0x768'], ['--size=512'], ['--size=9007199254740992x768'],
    ['--seed=9007199254740992'], ['--seed=-2'], ['--arg=vae-tiling'], ['--drop-arg=--steps=2'],
    ['--model-arg=missing'], ['--model-arg=key='], ['--steps'], ['--steps', '--cfg=3'], ['--reference='],
    ['--label=a\nb'], ['--unknown=x'], ['--provider=other'],
  ]) assert.throws(() => parseSelfieTestArgs(args), Error, args.join(' '));
});

test('selfie:test keeps config immutable, drops flag values and lets explicit overrides beat provider presets', () => {
  const h = harness();
  h.config.sdcpp.offloadToCpu = true;
  h.config.sdcpp.args = ['--sampling-method', 'euler', '--offload-to-cpu', '--batch-count=2', '--vae-tiling'];
  h.config.presets.hemat.providers = { sdcpp: { resolution: 1024, steps: 8, cfg: 2 } };
  const before = structuredClone(h.config);
  const result = applySelfieTestOverrides(h.config, parseSelfieTestArgs([
    '--steps=24', '--cfg=5', '--size=512x768', '--drop-arg=--sampling-method',
    '--drop-arg=--offload-to-cpu', '--drop-arg=--batch-count', '--drop-arg=--vae-tiling',
    '--arg=--diffusion-fa', '--model-arg=shift=0.7', '--reference=new image.png', '--init-image=init image.png',
  ]));
  assert.deepEqual(h.config, before);
  assert.deepEqual(result.sdcpp.args, []);
  assert.equal(result.sdcpp.offloadToCpu, false);
  assert.deepEqual(result.presets.hemat.sdcpp.args, ['--diffusion-fa']);
  assert.deepEqual(result.presets.hemat.sdcpp.modelArgs, ['shift=0.7']);
  assert.deepEqual(result.presets.hemat.providers.sdcpp, { resolution: 512, steps: 24, cfg: 5 });
  assert.equal(result.sdcpp.initImage, path.resolve('init image.png'));
  assert.equal(result.referenceDir, path.dirname(path.resolve('new image.png')));
  assert.equal(result.defaultReference, 'new image.png');
});

test('selfie:test passes ephemeral overrides and appends one run row', async () => {
  const h = harness();
  const before = structuredClone(h.config);
  let receivedConfig;
  assert.equal(await runSelfieTest({
    ...h,
    options: parseSelfieTestArgs(['--steps=22', '--cfg=4', '--size=512x768', '--strength=0.3', '--seed=12', '--label=experiment']),
    createProvider: async config => { receivedConfig = config; return h.provider; },
  }), 0);
  assert.deepEqual(h.config, before);
  assert.equal(receivedConfig.presets.hemat.steps, 22);
  assert.equal(h.received.steps, 22);
  assert.equal(h.received.cfgScale, 4);
  assert.equal(h.received.seed, 12);
  assert.equal(h.received.width, 512);
  assert.equal(h.received.height, 768);
  assert.equal(h.received.sdcpp.strength, 0.3);
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].label, 'experiment');
  assert.equal(h.rows[0].seed, 42);
  assert.equal(h.rows[0].imagePath, 'fake.png');
  assert.equal(h.rows[0].timings.totalMs, 100);
});

test('selfie:test appends failed and unavailable attempts exactly once with available diagnostics', async () => {
  for (const outcome of ['failed', 'unavailable']) {
    const h = harness(outcome);
    if (outcome === 'unavailable') {
      h.provider.checkReady = async () => ({ ready: false, code: 'NO_GPU_BACKEND', message: 'No GPU.' });
      h.provider.getFinalArgv = () => null;
      h.provider.getGenerationPeaks = () => null;
    }
    assert.equal(await runSelfieTest({ ...h, createProvider: async () => h.provider }), outcome === 'failed' ? 1 : 3);
    assert.equal(h.rows.length, 1);
    assert.equal(h.rows[0].imagePath, undefined);
    assert.ok(h.rows[0].timings.totalMs >= 0);
    assert.equal(h.rows[0].status, outcome === 'failed' ? 'NO_GPU_BACKEND' : 'unavailable');
    assert.equal(h.rows[0].peaks?.vramUsedGB, outcome === 'failed' ? 2 : undefined);
  }
});

test('selfie:test reports a run-log failure as nonzero', async () => {
  const h = harness();
  assert.equal(await runSelfieTest({
    ...h, createProvider: async () => h.provider,
    appendRun: async () => { throw new Error('read-only run log'); },
  }), 1);
  assert.match(h.lines.join('\n'), /FAILED \[RUN_LOG\]: read-only run log/);
});

test('selfie:test compare skips provider setup, ETA and run logging', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfie compare CLI '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const files = ['first image.png', 'second.png'].map(name => path.join(root, name));
  for (const file of files) fs.writeFileSync(file, png);
  const h = harness();
  assert.equal(await runSelfieTest({
    ...h, config: {}, options: parseSelfieTestArgs(['--compare', ...files]),
    createProvider: async () => assert.fail('compare must not create a provider'),
  }), 0);
  assert.deepEqual(h.records, []);
  assert.deepEqual(h.rows, []);
  assert.equal(h.lines.length, 2);
  assert.ok(h.lines.every(line => /1x1/.test(line) && line.includes(String(png.length))));
  for (const args of [['--compare', files[0]], ['--compare', ...files, '--steps=4'], ['--steps=4', '--compare', ...files]]) {
    assert.throws(() => parseSelfieTestArgs(args), Error);
  }
});

test('selfie:test experiments run through fake sd-cli, drop base args and append two preserved rows', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'selfie experiment CLI '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const h = harness();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  const script = path.join(root, 'fake sd-cli.cjs');
  fs.writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('--diffusion-model --vae --llm -r -i --strength -p -n --steps --cfg-scale -W -H -s -o --sampling-method --offload-to-cpu --vae-tiling --batch-count --diffusion-fa --model-args');
} else if (args.includes('--list-devices')) {
  process.stdout.write('CUDA0: Fake NVIDIA GPU');
} else {
  if (args.some(value => /^--?[^=]+=/.test(value))) {
    process.stderr.write('Native flags require separate values.');
    process.exit(9);
  }
  fs.writeFileSync(path.join(__dirname, 'argv.json'), JSON.stringify(args));
  fs.writeFileSync(args[args.indexOf('-o') + 1], Buffer.from('${png.toString('base64')}', 'base64'));
}
`);
  const models = {};
  for (const name of ['diffusionModel', 'vae', 'llm']) {
    models[name] = path.join(root, name + '.safetensors');
    fs.writeFileSync(models[name], name);
  }
  const referenceDir = path.join(root, 'references');
  fs.mkdirSync(referenceDir);
  const reference = path.join(referenceDir, 'selected image.png');
  fs.writeFileSync(reference, png);
  h.config.outputDir = path.join(root, 'outputs');
  h.config.referenceDir = root;
  h.config.jobTimeoutMs = 5000;
  h.config.telemetry.enabled = false;
  h.config.sdcpp = {
    binaryPath: process.execPath, extraArgs: [script], ...models, offloadToCpu: true,
    args: ['--sampling-method', 'euler', '--vae-tiling', '--offload-to-cpu', '--batch-count', '2'],
    modelArgs: ['base=1'],
  };
  h.config.presets.hemat.sdcpp = { args: ['--vae-tiling'], modelArgs: ['preset=2'] };
  h.config.presets.hemat.providers = { sdcpp: { resolution: 1024, steps: 8, cfg: 2 } };
  const before = structuredClone(h.config);
  const filePath = path.join(root, 'selfie-runs.md');
  const peaks = { vramUsedGB: 2, peakWorkingSetGB: 3, commitUsedGB: 8, sharedGpuUsedGB: 0.2 };
  const createProvider = config => new ProviderResolver(config, {
    createProvider: async (name, cfg) => new SdCppProvider(cfg, {
      logger: () => {}, warner: line => h.lines.push(line),
      memoryMonitor: {
        preflight: async () => ({ memoryTier: 'ok', message: 'Fake memory.' }),
        start: () => ({ stop: () => peaks }),
      },
    }),
  });
  const args = ['--steps=24', '--cfg=4.5', '--size=512x768', '--strength=0.4', '--init-image=reference',
    '--seed=123', '--reference', reference, '--drop-arg=--vae-tiling', '--drop-arg=--offload-to-cpu',
    '--drop-arg=--batch-count', '--arg=--diffusion-fa', '--arg=--batch-count=1', '--model-arg=shift=0.6'];
  const appendRun = row => appendSelfieRun(row, { filePath });
  assert.equal(await runSelfieTest({ ...h, options: parseSelfieTestArgs([...args, '--label=first']), createProvider, appendRun }), 0);
  const firstLog = fs.readFileSync(filePath, 'utf8');
  assert.equal(await runSelfieTest({ ...h, options: parseSelfieTestArgs([...args, '--label=second']), createProvider, appendRun }), 0);
  const finalLog = fs.readFileSync(filePath, 'utf8');
  assert.ok(finalLog.startsWith(firstLog));
  assert.equal(finalLog.split('\n').filter(line => /^\| (first|second) \|/.test(line)).length, 2);
  assert.match(finalLog, /512x768/);
  assert.match(finalLog, /--diffusion-fa/);
  assert.deepEqual(h.config, before);
  const argv = JSON.parse(fs.readFileSync(path.join(root, 'argv.json'), 'utf8'));
  const value = flag => argv[argv.indexOf(flag) + 1];
  assert.equal(value('--steps'), '24');
  assert.equal(value('--cfg-scale'), '4.5');
  assert.equal(value('-W'), '512');
  assert.equal(value('-H'), '768');
  assert.equal(value('-s'), '123');
  assert.equal(value('-r'), reference);
  assert.equal(value('-i'), reference);
  assert.equal(value('--strength'), '0.4');
  assert.ok(!argv.includes('--vae-tiling'));
  assert.ok(!argv.includes('--offload-to-cpu'));
  assert.ok(!argv.includes('2'));
  assert.ok(argv.includes('--diffusion-fa'));
  assert.equal(value('--batch-count'), '1');
  assert.equal(value('--model-args'), 'base=1,preset=2,shift=0.6');
});
