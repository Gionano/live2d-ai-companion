import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalPaths, inspectManagedRuntime, inspectSdRuntimeStructure, resolveManagedPaths, resolveSelfiePaths } from '../selfie/localPaths.js';
import { inspectSdRuntime } from '../selfie/runtimeValidity.js';
import { SdCppProvider } from '../selfie/providers/sdcppProvider.js';
import { ComfyUiManagedProcess } from '../selfie/comfyuiManagedProcess.js';
import { ComfyUiManagedProvider } from '../selfie/providers/comfyuiManagedProvider.js';
import { ProviderResolver } from '../selfie/providerResolver.js';

const HELP = '--diffusion-model --vae --llm -r -p -n --steps --cfg-scale -W -H -s -o';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu runtime validity '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, paths: createLocalPaths({ repoRoot: root, env: {} }) };
}

function write(filename, contents = 'tiny fake executable') {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
  return filename;
}

function sdConfig(root, binaryPath) {
  return { rootDir: root, provider: 'sdcpp', availabilityCacheMs: 0, preset: 'cepat',
    sdcpp: { binaryPath, diffusionModel: write(path.join(root, 'models', 'diffusion.gguf')),
      vae: write(path.join(root, 'models', 'vae.gguf')), llm: write(path.join(root, 'models', 'llm.gguf')),
      args: [], extraArgs: [], modelArgs: [], allowCpu: true, helpTimeoutMs: 50, deviceTimeoutMs: 50 } };
}

test('managed runtime requires embedded Python and ComfyUI/main.py files rather than directory existence', t => {
  const { paths } = fixture(t);
  fs.mkdirSync(paths.runtimeDir('comfyui'), { recursive: true });
  assert.equal(inspectManagedRuntime(paths).valid, false);
  assert.equal(inspectManagedRuntime(paths).missing.length, 2);
  write(path.join(paths.runtimeDir('comfyui'), 'main.py'));
  write(path.join(paths.runtimeDir('comfyui'), 'python_embeded', 'python.exe'));
  assert.equal(inspectManagedRuntime(paths).valid, false, 'direct main.py does not validate the portable layout');
  write(path.join(paths.runtimeDir('comfyui'), 'ComfyUI', 'main.py'));
  assert.equal(inspectManagedRuntime(paths).valid, true);
});

test('invalid local managed runtime preserves explicit legacy paths across repeated resolution', t => {
  const { root, paths } = fixture(t);
  fs.mkdirSync(paths.runtimeDir('comfyui'), { recursive: true });
  const legacy = { installDir: path.join(root, 'legacy'), pythonPath: 'python.exe', mainScript: 'main.py' };
  const resolved = resolveManagedPaths(legacy, paths);
  const again = resolveSelfiePaths({ rootDir: root, comfyuiManaged: resolved }, { env: {} });
  assert.equal(again.comfyuiManaged.installDir, legacy.installDir);
  assert.equal(again.comfyuiManaged.pythonPath, path.join(legacy.installDir, 'python.exe'));
  assert.equal(again.comfyuiManaged._runtimeWarnings[0].code, 'LOCAL_COMFYUI_RUNTIME_FALLBACK');
  assert.equal(again.comfyuiManaged._runtimeWarnings[0].message.includes(root), false);
});

test('managed legacy fallback is usable and prominently warned in safe provider status', async t => {
  const { root, paths } = fixture(t);
  fs.mkdirSync(paths.runtimeDir('comfyui'), { recursive: true });
  const installDir = path.join(root, 'legacy');
  const cfg = { rootDir: root, comfyuiManaged: { installDir,
    pythonPath: write(path.join(installDir, 'python.exe')), mainScript: write(path.join(installDir, 'main.py')),
    host: '127.0.0.1', args: [], profiles: {} } };
  const lifecycle = new ComfyUiManagedProcess(cfg, { env: {}, commandRunner: async () => ({ code: 0, stdout: '--listen --port' }),
    processIdentity: async () => null, logger: () => {}, warner: () => {},
    spawnProcess: () => { assert.fail('readiness must not launch the server'); } });
  const provider = new ComfyUiManagedProvider(cfg, { lifecycle });
  const readiness = await provider.checkReady();
  assert.equal(readiness.ready, true);
  assert.match(readiness.publicMessage, /Warning: Local ComfyUI/);
  assert.equal(provider.getStatus().warnings[0].code, 'LOCAL_COMFYUI_RUNTIME_FALLBACK');
  assert.equal(JSON.stringify(provider.getStatus()).includes(root), false);
});

test('invalid local managed runtime without a legacy config reports exact missing files', async t => {
  const { root, paths } = fixture(t);
  fs.mkdirSync(paths.runtimeDir('comfyui'), { recursive: true });
  let probed = false;
  const lifecycle = new ComfyUiManagedProcess({ rootDir: root, comfyuiManaged: {} }, { env: {},
    commandRunner: async () => { probed = true; throw new Error('must not probe'); }, logger: () => {}, warner: () => {} });
  const result = await lifecycle.checkReady();
  assert.equal(result.ready, false);
  assert.equal(probed, false);
  assert.ok(result.reasons.some(reason => reason.includes(path.join(paths.runtimeDir('comfyui'), 'ComfyUI', 'main.py'))));
  assert.ok(result.reasons.some(reason => reason.includes(path.join(paths.runtimeDir('comfyui'), 'python_embeded', 'python.exe'))));
});

test('local sd-cli validity requires a successful bounded injected help probe', async t => {
  const { paths } = fixture(t);
  const binary = write(path.join(paths.runtimeDir('sd-cli'), 'bin', 'sd-cli.exe'));
  const calls = [];
  const valid = await inspectSdRuntime(paths, { env: {}, timeoutMs: 33, probeCommand: async (command, args, options) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    return { code: 0, stdout: HELP };
  } });
  assert.equal(valid.valid, true);
  assert.equal(valid.helpOutput.trim(), HELP);
  assert.deepEqual(calls, [{ command: binary, args: ['--help'], timeoutMs: 33 }]);
  const invalid = await inspectSdRuntime(paths, { probeCommand: async () => ({ code: 7 }), env: {} });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.code, 'LOCAL_SDCLI_HELP_FAILED');
});

test('hanging local help probes time out and caller cancellation propagates', async t => {
  const { paths } = fixture(t);
  write(path.join(paths.runtimeDir('sd-cli'), 'sd-cli.exe'));
  const timedOut = await inspectSdRuntime(paths, { env: {}, timeoutMs: 20, probeCommand: async () => new Promise(() => {}) });
  assert.equal(timedOut.code, 'LOCAL_SDCLI_HELP_TIMEOUT');
  const controller = new AbortController();
  const pending = inspectSdRuntime(paths, { env: {}, signal: controller.signal,
    probeCommand: async () => { controller.abort(new Error('stop help validation')); return new Promise(() => {}); } });
  await assert.rejects(pending, /stop help validation/);
});

test('a selected variant is validated alone without probing or combining the other build', async t => {
  const { paths } = fixture(t);
  write(path.join(paths.runtimeDir('sd-cli'), 'cuda12', 'bin', 'sd-cli.exe'));
  const vulkan = write(path.join(paths.runtimeDir('sd-cli'), 'vulkan', 'sd-cli.exe'));
  write(path.join(paths.localDir, 'installed.json'), JSON.stringify({ schemaVersion: 1, components: {}, activeVariants: { sdcpp: 'vulkan' } }));
  const calls = [];
  const result = await inspectSdRuntime(paths, { env: {}, probeCommand: async command => { calls.push(command); return { code: 0 }; } });
  assert.equal(result.variant, 'vulkan');
  assert.equal(result.valid, true);
  assert.deepEqual(calls, [vulkan]);
});

test('ambiguous variants and stale selected variants require a precise explicit fix', async t => {
  const { paths } = fixture(t);
  write(path.join(paths.runtimeDir('sd-cli'), 'cuda12', 'sd-cli.exe'));
  write(path.join(paths.runtimeDir('sd-cli'), 'vulkan', 'sd-cli.exe'));
  const ambiguous = await inspectSdRuntime(paths, { env: {}, probeCommand: () => assert.fail('ambiguous builds must not run') });
  assert.equal(ambiguous.code, 'SDCLI_VARIANT_SELECTION_REQUIRED');
  assert.equal(ambiguous.binaryPath, '');
  assert.match(ambiguous.publicMessage, /--variant=cuda12.*--variant=vulkan/);
  fs.rmSync(path.join(paths.runtimeDir('sd-cli'), 'cuda12'), { recursive: true });
  write(path.join(paths.localDir, 'installed.json'), JSON.stringify({ activeVariants: { sdcpp: 'cuda12' } }));
  const stale = inspectSdRuntimeStructure(paths);
  assert.equal(stale.structurallyValid, false);
  assert.ok(stale.missing[0].includes('cuda12'));
});

test('sd.cpp constructor never probes and valid local help is reused during readiness', async t => {
  const { root, paths } = fixture(t);
  const local = write(path.join(paths.runtimeDir('sd-cli'), 'sd-cli.exe'));
  const legacy = write(path.join(root, 'legacy.exe'));
  const calls = [];
  const provider = new SdCppProvider(sdConfig(root, legacy), { env: {}, logger: () => {}, warner: () => {},
    runCommand: async (command, args) => { calls.push({ command, args }); return { code: 0, stdout: args.includes('--help') ? HELP : 'Vulkan0: Fake GPU' }; },
    spawnProcess: () => assert.fail('only injected probes may run') });
  assert.equal(calls.length, 0);
  assert.equal((await provider.checkReady()).ready, true);
  assert.equal((await provider.checkReady()).ready, true);
  assert.equal(provider.sd.binaryPath, local);
  assert.equal(calls.filter(call => call.args.includes('--help')).length, 1);
  assert.equal(calls.every(call => call.command === local), true);
});

test('failed local sd-cli help falls back to configured legacy with a safe visible warning', async t => {
  const { root, paths } = fixture(t);
  const local = write(path.join(paths.runtimeDir('sd-cli'), 'sd-cli.exe'));
  const legacy = write(path.join(root, 'legacy.exe'));
  const calls = [];
  const cfg = sdConfig(root, legacy);
  const provider = new SdCppProvider(cfg, { env: {}, logger: () => {}, warner: () => {},
    runCommand: async (command, args) => {
      calls.push(command);
      return command === local ? { code: 9 } : { code: 0, stdout: args.includes('--help') ? HELP : 'CUDA0: Legacy GPU' };
    }, spawnProcess: () => assert.fail('only injected probes may run') });
  const resolver = new ProviderResolver(cfg, { createProvider: () => provider, initializeManaged: null });
  assert.equal((await resolver.checkReady()).ready, true);
  assert.equal(provider.sd.binaryPath, legacy);
  assert.deepEqual(calls, [local, legacy, legacy]);
  const publicStatus = resolver.getPublicStatus();
  assert.match(publicStatus.reasons.sdcpp, /Warning: Local sd-cli/);
  assert.equal(publicStatus.sdcpp.warnings[0].code, 'LOCAL_SDCLI_RUNTIME_FALLBACK');
  assert.equal(JSON.stringify(publicStatus).includes(root), false);
});

test('invalid local sd-cli with no legacy binary reports the exact local failure', async t => {
  const { root, paths } = fixture(t);
  const local = write(path.join(paths.runtimeDir('sd-cli'), 'sd-cli.exe'));
  const provider = new SdCppProvider(sdConfig(root, ''), { env: {}, logger: () => {}, warner: () => {},
    runCommand: async () => ({ code: 12 }), spawnProcess: () => assert.fail('only injected probes may run') });
  const result = await provider.checkReady();
  assert.equal(result.ready, false);
  assert.equal(result.code, 'LOCAL_SDCLI_HELP_FAILED');
  assert.ok(result.message.includes(local));
  assert.equal(result.publicMessage.includes(root), false);
});

test('resolver whitelists static runtime warnings and never forwards injected warning paths', async () => {
  const provider = { checkReady: async () => ({ ready: true, code: 'READY', message: 'ready' }),
    getStatus: () => ({ ready: true, code: 'READY', warnings: [
      { code: 'LOCAL_SDCLI_RUNTIME_FALLBACK', message: '/private/person/models' },
      { code: 'UNKNOWN', message: path.win32.join('X:', '/', 'Path With Spaces', 'Models') },
    ] }) };
  const resolver = new ProviderResolver({ provider: 'sdcpp' }, { createProvider: () => provider, initializeManaged: null });
  await resolver.checkReady();
  const status = resolver.getPublicStatus();
  assert.equal(status.sdcpp.warnings.length, 1);
  assert.equal(JSON.stringify(status).includes('private'), false);
  assert.equal(JSON.stringify(status).includes('Private'), false);
});

test('canonical sdcpp root takes precedence and probes only its selected variant', async t => {
  const { paths } = fixture(t);
  const selected = write(path.join(paths.runtimeDir('sdcpp'), 'vulkan', 'sd-cli.exe'));
  write(path.join(paths.runtimeDir('sd-cli'), 'cuda12', 'sd-cli.exe'));
  const calls = [];
  const local = await inspectSdRuntime(paths, { env: {}, probeCommand: async command => { calls.push(command); return { code: 0, stdout: HELP }; } });
  assert.equal(local.valid, true);
  assert.equal(local.root, paths.runtimeDir('sdcpp'));
  assert.equal(local.variant, 'vulkan');
  assert.deepEqual(calls, [selected]);
});

test('invalid canonical runtime falls back only to an explicitly configured legacy binary', async t => {
  const { root, paths } = fixture(t);
  fs.mkdirSync(paths.runtimeDir('sdcpp'), { recursive: true });
  const legacy = write(path.join(paths.runtimeDir('sd-cli'), 'sd-cli.exe'));
  const calls = [];
  const dependencies = { env: {}, logger: () => {}, warner: () => {},
    runCommand: async (command, args) => { calls.push(command); return { code: 0, stdout: args.includes('--help') ? HELP : 'Vulkan0: Fake GPU' }; },
    spawnProcess: () => assert.fail('only injected probes may run') };
  const provider = new SdCppProvider(sdConfig(root, legacy), dependencies);
  assert.equal((await provider.checkReady()).ready, true);
  assert.equal(provider.getStatus().warnings[0].code, 'LOCAL_SDCLI_RUNTIME_FALLBACK');
  assert.ok(calls.every(command => command === legacy));
  const noLegacy = new SdCppProvider(sdConfig(root, ''), dependencies);
  const result = await noLegacy.checkReady();
  assert.equal(result.ready, false);
  assert.equal(result.code, 'LOCAL_SDCLI_BINARY_MISSING');
  assert.match(result.publicMessage, /runtime\/sdcpp\/sd-cli/);
  assert.equal(calls.length, 2);
});

test('public managed status names the exact missing embedded Python and main script without private paths', async t => {
  const { root, paths } = fixture(t);
  fs.mkdirSync(paths.runtimeDir('comfyui'), { recursive: true });
  const cfg = { rootDir: root, provider: 'comfyui-managed', comfyuiManaged: {} };
  const lifecycle = new ComfyUiManagedProcess(cfg, { env: {}, logger: () => {}, warner: () => {},
    commandRunner: () => assert.fail('missing runtime must not launch a process'),
    spawnProcess: () => assert.fail('missing runtime must not launch a process') });
  const provider = new ComfyUiManagedProvider(cfg, { lifecycle });
  const resolver = new ProviderResolver(cfg, { createProvider: () => provider, initializeManaged: null });
  assert.equal((await resolver.checkReady()).ready, false);
  const status = resolver.getPublicStatus();
  assert.match(status.reasons['comfyui-managed'], /python_embeded\/python\.exe.*ComfyUI\/main\.py/);
  assert.equal(JSON.stringify(status).includes(root), false);
});
