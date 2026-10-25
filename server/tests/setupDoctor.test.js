import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runDoctor, formatDoctor, probeSystem } from '../../setup/doctor.js';
import { listComponents } from '../../setup/manifest.js';

const fakeSystem = {
  freeBytes: 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3,
  freeRamBytes: 8 * 1024 ** 3, totalRamBytes: 16 * 1024 ** 3,
  commitUsedBytes: 10 * 1024 ** 3, commitLimitBytes: 32 * 1024 ** 3,
};

function component(name, destination, overrides = {}) {
  return {
    name, version: 'fake-test-pin', url: 'http://invalid.example/never-downloaded.zip',
    sha256: 'a'.repeat(64), sizeBytes: 4, licenseName: 'Test license',
    licenseUrl: 'http://invalid.example/never-contacted-license', kind: 'runtime', destination,
    required: true, ...overrides,
  };
}

function manifest() {
  return { schemaVersion: 1, components: {
    'comfyui-portable': component('ComfyUI portable', 'runtime/comfyui'),
    'comfyui-gguf-node': component('ComfyUI-GGUF', 'runtime/comfyui/ComfyUI/custom_nodes/ComfyUI-GGUF', { kind: 'custom-node' }),
    'sd-cli': component('sd-cli', 'runtime/sd-cli'),
    cudart: component('cudart', 'runtime/sd-cli', { required: false, kind: 'runtime-library' }),
    models: [component('test.gguf', 'models/diffusion_models/test.gguf', { kind: 'diffusion_models' })],
  } };
}

function v2Manifest() {
  const data = manifest();
  data.schemaVersion = 2;
  data.components['comfyui-portable'] = { ...data.components['comfyui-portable'], engines: ['comfyui'], role: 'runtime', when: { gpuVendor: 'any', os: 'win32' } };
  data.components['comfyui-gguf-node'] = { ...data.components['comfyui-gguf-node'], engines: ['comfyui'], role: 'node', when: { gpuVendor: 'any', os: 'win32' } };
  data.components['sd-cli'] = ['cuda12', 'vulkan'].map(variant => ({
    ...component(`sd-cli ${variant}`, `runtime/sd-cli/${variant}`), engines: ['sdcpp'], role: 'runtime', variant,
    when: { gpuVendor: variant === 'cuda12' ? 'nvidia' : 'any', os: 'win32' },
  }));
  data.components.cudart = { ...data.components.cudart, engines: ['sdcpp'], role: 'runtime_library', variant: 'cuda12', required: true,
    destination: 'runtime/sd-cli/cuda12', when: { gpuVendor: 'nvidia', os: 'win32' } };
  data.components.models = [
    ['test.gguf', 'diffusion_models', 'diffusion', ['comfyui', 'sdcpp']],
    ['vae.safetensors', 'vae', 'vae', ['comfyui', 'sdcpp']],
    ['clip.safetensors', 'text_encoders', 'text_encoder', ['comfyui']],
    ['llm.gguf', 'text_encoders', 'text_encoder', ['sdcpp']],
    ['mmproj.gguf', 'text_encoders', 'vision_projector', ['sdcpp']],
  ].map(([name, kind, role, engines]) => ({ ...component(name, `models/${kind}/${name}`, { kind }), engines, role, when: { gpuVendor: 'any', os: 'win32' } }));
  return data;
}

function installedRecord(data, active = 'cuda12') {
  return { schemaVersion: 1, components: Object.fromEntries(listComponents(data).map(entry => [entry.id, { ...entry, files: [] }])), activeVariants: { sdcpp: active } };
}

async function fixture(t) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'waifu-doctor-'));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  const write = async (relative, contents = 'fake') => {
    const filename = path.join(repoRoot, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, contents);
    return filename;
  };
  const calls = [];
  const config = {
    provider: 'auto', comfyUrl: 'http://127.0.0.1:8188',
    workflowFile: 'workflows/selfie.api.json', mappingFile: 'selfie.mapping.json',
    comfyuiManaged: {}, sdcpp: {
      diffusionModel: 'test.gguf', vae: 'vae.safetensors', llm: 'llm.gguf', llmVision: null,
    },
  };
  const options = {
    repoRoot, env: {}, manifest: manifest(), config,
    probeCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: args.includes('--list-devices') ? 'CUDA0: Fake test GPU' : 'usage: fake comfy --help', stderr: '' };
    },
    probeSystem: async () => ({ ...fakeSystem }),
    detectGpuVendor: async () => ({ gpuVendor: 'nvidia', devices: ['Fake test GPU'] }),
  };
  const install = async () => {
    await write('local/runtime/comfyui/python_embeded/python.exe');
    await write('local/runtime/comfyui/ComfyUI/main.py');
    await write('local/runtime/comfyui/ComfyUI/custom_nodes/ComfyUI-GGUF/__init__.py');
    await write('local/runtime/comfyui/ComfyUI/extra_model_paths.yaml', `waifu_local:\n  base_path: ${JSON.stringify(path.join(repoRoot, 'local', 'models').replace(/\\/g, '/'))}\n`);
    await write(`local/runtime/sd-cli/${process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'}`);
    await write('local/runtime/sd-cli/ggml-cuda.dll');
    await write('local/runtime/sd-cli/cudart64_12.dll');
    await write('local/runtime/sd-cli/cublas64_12.dll');
    await write('local/models/diffusion_models/test.gguf');
    await write('local/models/vae/vae.safetensors');
    await write('local/models/text_encoders/llm.gguf');
    await write('workflows/selfie.api.json', '{}');
    await write('selfie.mapping.json', '{}');
  };
  return { repoRoot, write, options, config, calls, install };
}

test('offline doctor reports missing components, providers, system capacity and exact setup commands', async t => {
  const { options, calls } = await fixture(t);
  const report = await runDoctor(options);
  assert.equal(report.ok, false);
  assert.equal(report.components.length, 5);
  assert.equal(report.components.find(check => check.componentId === 'cudart').status, 'warning');
  assert.equal(report.providers.length, 3);
  assert.equal(calls.length, 0, 'missing engines must not be launched');
  const output = formatDoctor(report);
  assert.match(output, /npm run setup:models -- --yes --accept-license "Test license"/);
  assert.match(output, /npm run setup:sdcli -- --yes/);
  assert.match(output, /npm run setup:comfyui -- --yes/);
  assert.match(output, /RAM total:.*16\.00 GiB/);
  assert.match(output, /Commit used:.*10\.00 GiB.*limit:.*32\.00 GiB/);
  assert.match(output, /No downloads, installs, server starts, or files written/);
  assert.match(output, /MIGRATION: manifest schemaVersion 1/);
  for (const issue of report.checks.filter(check => check.status !== 'ok')) assert.ok(issue.fix, issue.id);
});

test('doctor refuses to suggest real setup when the manifest has TODO placeholders', async t => {
  const { options } = await fixture(t);
  options.manifest.components['sd-cli'].url = 'TODO verified archive URL';
  options.manifest.components.models[0].sizeBytes = null;
  const report = await runDoctor(options);
  const output = formatDoctor(report);
  assert.match(output, /TODO placeholder must be replaced/);
  assert.match(output, /TODO\/missing size/);
  assert.match(output, /Edit setup\/manifest.json/);
  assert.match(output, /npm run setup:plan/);
  assert.doesNotMatch(output, /npm run setup:sdcli -- --yes/);
});

test('local runtimes win over explicitly configured legacy engines and use offline bounded probes', async t => {
  const { options, config, calls, install, repoRoot } = await fixture(t);
  await install();
  config.sdcpp.binaryPath = path.join(repoRoot, 'old', 'sd-cli.exe');
  config.comfyuiManaged = {
    installDir: path.join(repoRoot, 'old-comfy'), pythonPath: 'python.exe', mainScript: 'main.py', env: { FAKE_FLAG: '1' },
  };
  const report = await runDoctor(options);
  assert.equal(report.providers.find(provider => provider.name === 'sdcpp').ready, true);
  assert.equal(report.providers.find(provider => provider.name === 'comfyui-managed').ready, true);
  assert.equal(calls.length, 3);
  const sd = calls.find(call => call.args.includes('--list-devices'));
  assert.equal(sd.command, path.join(repoRoot, 'local', 'runtime', 'sd-cli', process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'));
  assert.equal(sd.options.timeoutMs, 5000);
  const comfy = calls.find(call => call.args.includes('-B'));
  assert.deepEqual(comfy.args, ['-B', path.join(repoRoot, 'local', 'runtime', 'comfyui', 'ComfyUI', 'main.py'), '--help']);
  assert.equal(comfy.options.timeoutMs, 15000);
  assert.equal(comfy.options.env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(comfy.options.env.FAKE_FLAG, '1');
  assert.match(formatDoctor(report), /CUDA0: Fake test GPU/);
});

test('doctor falls back to existing legacy paths without requiring local engine downloads', async t => {
  const { options, config, calls, write, repoRoot } = await fixture(t);
  config.sdcpp.binaryPath = await write('legacy/sd-cli.exe');
  config.sdcpp.diffusionModel = await write('legacy-models/test.gguf');
  config.sdcpp.vae = await write('legacy-models/vae.safetensors');
  config.sdcpp.llm = await write('legacy-models/llm.gguf');
  const installDir = path.join(repoRoot, 'legacy-comfy');
  config.comfyuiManaged = { installDir, pythonPath: 'python.exe', mainScript: 'main.py' };
  await write('legacy-comfy/python.exe');
  await write('legacy-comfy/main.py');
  await write('legacy-comfy/custom_nodes/ComfyUI-GGUF/__init__.py');
  await write('legacy-comfy/extra_model_paths.yaml', `base_path: ${JSON.stringify(path.join(repoRoot, 'local', 'models').replace(/\\/g, '/'))}`);
  await runDoctor(options);
  assert.equal(calls.find(call => call.args.includes('--list-devices')).command, config.sdcpp.binaryPath);
  assert.equal(calls.find(call => call.args.includes('-B')).command, path.join(installDir, 'python.exe'));
  await assert.rejects(fs.stat(path.join(repoRoot, 'local')), { code: 'ENOENT' });
});

test('doctor detects wrong model sizes, empty binaries and missing CUDA runtime libraries', async t => {
  const { options, install, write } = await fixture(t);
  await install();
  await write('local/models/diffusion_models/test.gguf', 'wrong-size');
  await write(`local/runtime/sd-cli/${process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'}`, '');
  await fs.unlink(path.join(options.repoRoot, 'local', 'runtime', 'sd-cli', 'cublas64_12.dll'));
  const report = await runDoctor(options);
  assert.equal(report.components.find(check => check.componentId === 'models[0]').status, 'wrong');
  assert.equal(report.checks.find(check => check.id === 'sdcpp:binary').status, 'wrong');
  assert.match(report.components.find(check => check.componentId === 'models[0]').fix, /--force/);
  assert.equal(report.components.find(check => check.componentId === 'cudart').status, 'warning');
});

test('doctor reports device and ComfyUI launch failures with fix commands', async t => {
  const { options, install } = await fixture(t);
  await install();
  options.probeCommand = async (command, args) => {
    if (args.includes('--list-devices')) return { code: 2, stdout: '', stderr: 'missing ggml-cuda.dll' };
    if (args.length === 1 && args[0] === '--help') return { code: 0, stdout: 'fake sd-cli help', stderr: '' };
    throw new Error('fake missing Python dependency');
  };
  const report = await runDoctor(options);
  assert.match(formatDoctor(report), /sd-cli --list-devices failed: exit 2: missing ggml-cuda.dll/);
  assert.match(formatDoctor(report), /ComfyUI launch check failed: fake missing Python dependency/);
  assert.match(report.checks.find(check => check.id === 'comfyui-managed:launch').fix, /setup:comfyui.*--force/);
});

test('doctor finds basename plus size duplicates in local and configured legacy model paths', async t => {
  const { options, config, install, write } = await fixture(t);
  await install();
  config.sdcpp.diffusionModel = await write('legacy-models/test.gguf');
  await write('legacy-models/different-size.gguf', 'abc');
  await write('local/models/diffusion_models/different-size.gguf', 'abcdef');
  const report = await runDoctor(options);
  assert.equal(report.duplicates.length, 1);
  assert.equal(report.duplicates[0].name, 'test.gguf');
  assert.equal(report.duplicates[0].sizeBytes, 4);
  assert.equal(report.duplicates[0].paths.length, 2);
  assert.match(formatDoctor(report), /Contents have not been hashed/);
});

test('doctor loads machine overrides and WAIFU_LOCAL_DIR without writing files or networking', async t => {
  const { options, write, repoRoot, calls } = await fixture(t);
  const customLocal = path.join(repoRoot, 'machine-local');
  await write('selfie.config.json', JSON.stringify({ sdcpp: { diffusionModel: 'base.gguf', vae: 'base-vae', llm: 'base-llm' } }));
  await write('selfie.config.local.json', JSON.stringify({ sdcpp: { diffusionModel: '${LOCAL}/models/diffusion_models/override.gguf' } }));
  options.config = undefined;
  options.env = { WAIFU_LOCAL_DIR: customLocal };
  const report = await runDoctor(options);
  assert.equal(report.localDir, customLocal);
  assert.equal(report.checks.find(check => check.id === 'sdcpp:diffusionModel').path, path.join(customLocal, 'models', 'diffusion_models', 'override.gguf'));
  assert.equal(report.checks.find(check => check.id === 'sdcpp:vae').path, path.join(customLocal, 'models', 'vae', 'base-vae'));
  assert.equal(calls.length, 0);
  await assert.rejects(fs.stat(customLocal), { code: 'ENOENT' });
});

test('doctor explains insufficient disk space and unavailable commit counters', async t => {
  const { options } = await fixture(t);
  options.probeSystem = async () => ({ ...fakeSystem, freeBytes: 1, commitLimitBytes: null, commitUsedBytes: null });
  const report = await runDoctor(options);
  assert.equal(report.checks.find(check => check.id === 'system:disk').status, 'wrong');
  assert.match(report.checks.find(check => check.id === 'system:disk').fix, /WAIFU_LOCAL_DIR.*npm run setup:plan/);
  assert.equal(report.checks.find(check => check.id === 'system:commit').status, 'warning');
  assert.match(formatDoctor(report), /System commit usage\/limit unavailable/);
});

test('doctor keeps a custom manifest path in every setup fix command', async t => {
  const { options, repoRoot } = await fixture(t);
  options.manifestPath = path.join(repoRoot, 'verified metadata', 'manifest.json');
  let report = await runDoctor(options);
  assert.match(report.checks.find(check => check.id === 'sdcpp:binary').fix, /--manifest/);
  assert.ok(report.checks.find(check => check.id === 'sdcpp:binary').fix.includes(JSON.stringify(options.manifestPath)));
  options.manifest.components['sd-cli'].url = 'TODO archive URL';
  report = await runDoctor(options);
  assert.ok(report.checks.find(check => check.id === 'manifest').fix.includes(options.manifestPath));
  assert.ok(report.checks.find(check => check.id === 'sdcpp:binary').fix.includes(`npm run setup:plan -- --manifest ${JSON.stringify(options.manifestPath)}`));
});

test('duplicate scans honor the configured userData legacy model base', async t => {
  const { options, config, install, write, repoRoot } = await fixture(t);
  await install();
  config.userDataDir = path.join(repoRoot, 'userData');
  await write('userData/models/sdcpp/test.gguf');
  const report = await runDoctor(options);
  assert.equal(report.duplicates.length, 1);
  assert.ok(report.duplicates[0].paths.includes(path.join(repoRoot, 'userData', 'models', 'sdcpp', 'test.gguf')));
});

test('duplicate scans follow local model directory junctions and avoid loops', async t => {
  const { options, install, write, repoRoot } = await fixture(t);
  await install();
  await write('reused-models/test.gguf');
  const reused = path.join(repoRoot, 'reused-models');
  const localModels = path.join(repoRoot, 'local', 'models');
  await fs.symlink(reused, path.join(localModels, 'reused'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.symlink(localModels, path.join(reused, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
  const report = await runDoctor(options);
  assert.equal(report.duplicates.length, 1);
  assert.equal(report.duplicates[0].paths.length, 2);
});

test('doctor reports ComfyUI workflow model names, sizes and missing loader inputs', async t => {
  const { options, install, write, config } = await fixture(t);
  await install();
  await write('legacy-comfy/models/clip/comfy-clip.safetensors', 'legacy-clip');
  config.comfyuiManaged.installDir = path.join(options.repoRoot, 'legacy-comfy');
  await write('workflows/selfie.api.json', JSON.stringify({
    '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'test.gguf' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'comfy-clip.safetensors' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'missing-vae.safetensors' } },
  }));
  const report = await runDoctor(options);
  assert.equal(report.checks.find(check => check.id === 'comfyui:model:1:unet_name').sizeBytes, 4);
  assert.equal(report.checks.find(check => check.id === 'comfyui:model:2:clip_name').sizeBytes, 11);
  assert.equal(report.checks.find(check => check.id === 'comfyui:model:3:vae_name').status, 'missing');
  assert.equal(report.providers.find(provider => provider.name === 'comfyui-managed').ready, false);
});

test('doctor marks CPU-only device output unavailable unless CPU use is explicit', async t => {
  const { options, install, config } = await fixture(t);
  await install();
  options.probeCommand = async (command, args) => ({ code: 0, stdout: args.includes('--list-devices') ? 'CPU0: Fake CPU' : 'usage: fake comfy', stderr: '' });
  let report = await runDoctor(options);
  assert.equal(report.checks.find(check => check.id === 'sdcpp:devices').status, 'wrong');
  config.sdcpp.allowCpu = true;
  report = await runDoctor(options);
  assert.equal(report.checks.find(check => check.id === 'sdcpp:devices').status, 'ok');
});

test('Windows memory probe reports null and blank commit counters as unavailable', async t => {
  const { repoRoot } = await fixture(t);
  const calls = [];
  for (const value of [null, '', '   ']) {
    const system = await probeSystem({
      localDir: repoRoot, platform: 'win32',
      commandRunner: async (command, args) => {
        calls.push({ command, args });
        return { stdout: JSON.stringify({ commitLimitBytes: value, commitUsedBytes: value }) };
      },
    });
    assert.equal(system.commitLimitBytes, null);
    assert.equal(system.commitUsedBytes, null);
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.command === 'powershell.exe' && call.args.includes('-NonInteractive')));
});

test('doctor rejects injected zero-limit or blank commit counters as unavailable', async t => {
  const { options } = await fixture(t);
  for (const counters of [
    { commitLimitBytes: 0, commitUsedBytes: 0 },
    { commitLimitBytes: null, commitUsedBytes: null },
    { commitLimitBytes: '', commitUsedBytes: '' },
  ]) {
    options.probeSystem = async () => ({ ...fakeSystem, ...counters });
    const report = await runDoctor(options);
    assert.equal(report.checks.find(check => check.id === 'system:commit').status, 'warning');
    assert.equal(report.system.commitLimitBytes, null);
    assert.equal(report.system.commitUsedBytes, null);
    assert.match(formatDoctor(report), /System commit usage\/limit unavailable/);
  }
});

test('v2 doctor reports recorded version/hash drift and an absent required projector role', async t => {
  const { options, write } = await fixture(t);
  options.manifest = v2Manifest();
  const record = installedRecord(options.manifest);
  record.components['sd-cli:cuda12'].version = 'previous-fixture-pin';
  record.components['sd-cli:cuda12'].sha256 = 'b'.repeat(64);
  await write('local/installed.json', JSON.stringify(record));
  options.manifest.components.models.pop();
  const report = await runDoctor(options);
  const drift = report.checks.find(check => check.id === 'installed:sd-cli:cuda12:metadata');
  assert.equal(drift.status, 'wrong');
  assert.match(drift.message, /version, sha256/);
  assert.match(drift.fix, /--engine sdcpp.*--variant cuda12/);
  assert.match(report.checks.find(check => check.id === 'manifest:required-role').message, /vision_projector/);
  assert.match(formatDoctor(report), /npm run setup:hash -- <path>/);
});

test('doctor checks runtime file size drift and optionally rehashes same-size replacements offline', async t => {
  const { options, write, install } = await fixture(t);
  await install();
  const record = installedRecord(options.manifest);
  record.components['sd-cli'].files = ['extra.dll'];
  record.components['sd-cli'].fileHashes = { 'extra.dll': {
    sizeBytes: 4, sha256: crypto.createHash('sha256').update('fake').digest('hex'),
  } };
  await write('local/installed.json', JSON.stringify(record));
  await write('local/runtime/sd-cli/extra.dll', 'longer than the installed file');
  const changedSize = await runDoctor(options);
  assert.equal(changedSize.checks.find(check => check.id === 'installed:sd-cli:file:0:size').status, 'wrong');
  await write('local/runtime/sd-cli/extra.dll', 'swap');
  const replaced = await runDoctor({ ...options, verifyHashes: true });
  assert.equal(replaced.checks.find(check => check.id === 'installed:sd-cli:file:0:checksum').status, 'wrong');
  await write('local/runtime/sd-cli/extra.dll', 'fake');
  const restored = await runDoctor({ ...options, verifyHashes: true });
  assert.equal(restored.checks.find(check => check.id === 'installed:sd-cli:file:0:checksum').status, 'ok');
});

test('doctor prominently warns for invalid local runtimes while probing configured legacy paths', async t => {
  const { options, config, write, calls, repoRoot } = await fixture(t);
  const localBinary = await write('local/runtime/sdcpp/vulkan/sd-cli.exe');
  const legacyBinary = await write('legacy/sd-cli.exe');
  config.sdcpp.binaryPath = legacyBinary;
  config.comfyuiManaged = { installDir: path.join(repoRoot, 'legacy-comfy'), pythonPath: 'python.exe', mainScript: 'main.py' };
  await write('legacy-comfy/python.exe');
  await write('legacy-comfy/main.py');
  await write('local/runtime/comfyui/ComfyUI/main.py');
  options.probeCommand = async (command, args) => {
    calls.push({ command, args });
    return { code: command === localBinary ? 7 : 0, stdout: args.includes('--list-devices') ? 'Vulkan0: Fake GPU' : 'fake help' };
  };
  const report = await runDoctor(options);
  const output = formatDoctor(report);
  assert.match(output, /\[WARNING\] PROMINENT WARNING: Local sd-cli/);
  assert.match(output, /\[WARNING\] PROMINENT WARNING: Local ComfyUI.*missing required files:.*python_embeded/);
  assert.equal(calls.find(call => call.args.includes('--list-devices')).command, legacyBinary);
  assert.equal(calls.find(call => call.args.includes('-B')).command, path.join(repoRoot, 'legacy-comfy', 'python.exe'));
});

test('doctor reports canonical selected runtime variants and skipped pip provenance', async t => {
  const { options, write } = await fixture(t);
  options.manifest = v2Manifest();
  for (const entry of [...options.manifest.components['sd-cli'], options.manifest.components.cudart]) entry.destination = entry.destination.replace('runtime/sd-cli/', 'runtime/sdcpp/');
  const record = installedRecord(options.manifest, 'vulkan');
  record.components['comfyui-gguf-node'].pip = { skipped: true, command: 'fake-python', args: ['-m', 'pip'] };
  await write('local/installed.json', JSON.stringify(record));
  await write('local/runtime/sdcpp/vulkan/sd-cli.exe');
  const report = await runDoctor(options);
  assert.equal(report.activeVariant, 'vulkan');
  assert.equal(report.checks.find(check => check.id === 'sdcpp:local-runtime').variant, 'vulkan');
  assert.equal(report.checks.find(check => check.id === 'installed:comfyui-gguf-node:pip').status, 'warning');
});

test('an inactive local GGUF node cannot satisfy the configured legacy ComfyUI readiness check', async t => {
  const { options, config, write, repoRoot } = await fixture(t);
  await write('local/runtime/comfyui/ComfyUI/custom_nodes/ComfyUI-GGUF/__init__.py');
  config.comfyuiManaged = { installDir: path.join(repoRoot, 'legacy-comfy'), pythonPath: 'python.exe', mainScript: 'main.py' };
  await write('legacy-comfy/python.exe');
  await write('legacy-comfy/main.py');
  const report = await runDoctor(options);
  const check = report.checks.find(item => item.id === 'comfyui-managed:gguf-node');
  assert.equal(check.status, 'missing');
  assert.equal(check.path, path.join(repoRoot, 'legacy-comfy', 'custom_nodes', 'ComfyUI-GGUF', '__init__.py'));
  assert.equal(report.providers.find(provider => provider.name === 'comfyui-managed').ready, false);
});
