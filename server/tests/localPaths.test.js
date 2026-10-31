import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ROOT_DIR, createLocalPaths, deepMerge, resolveManagedPaths, resolveSdCliBinary, resolveSelfiePaths } from '../selfie/localPaths.js';
import { loadSelfieConfig } from '../selfie/config.js';
import { SdCppProvider } from '../selfie/providers/sdcppProvider.js';
import { ComfyUiProvider } from '../selfie/providers/comfyuiProvider.js';
import { ComfyUiManagedProcess } from '../selfie/comfyuiManagedProcess.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu local layout '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = createLocalPaths({ repoRoot: root, env: {} });
  return { root, paths, load: overrides => loadSelfieConfig(overrides, { repoRoot: root, env: {} }) };
}

test('local directory defaults beneath the repository and environment takes precedence', t => {
  const { root, paths } = fixture(t);
  assert.equal(paths.localDir, path.join(root, 'local'));
  assert.equal(createLocalPaths({ repoRoot: root, env: { WAIFU_LOCAL_DIR: 'machine data' } }).localDir,
    path.join(root, 'machine data'));
  const external = path.join(os.tmpdir(), 'external local');
  assert.equal(createLocalPaths({ repoRoot: root, env: { WAIFU_LOCAL_DIR: external } }).localDir, external);
  assert.equal(createLocalPaths({ repoRoot: root, env: { WAIFU_LOCAL_DIR: '  ' } }).localDir, paths.localDir);
});

test('local path helpers and LOCAL templates share one directory', t => {
  const { root, paths } = fixture(t);
  assert.equal(paths.modelsDir('diffusion_models'), path.join(root, 'local', 'models', 'diffusion_models'));
  assert.equal(paths.runtimeDir('comfyui'), path.join(root, 'local', 'runtime', 'comfyui'));
  assert.equal(paths.outputsDir(), path.join(root, 'local', 'outputs'));
  assert.equal(paths.logsDir(), path.join(root, 'local', 'logs'));
  assert.equal(paths.resolvePath('${LOCAL}/models/vae/x.gguf'), path.join(paths.modelsDir('vae'), 'x.gguf'));
  assert.equal(paths.resolvePath('x', { baseDir: paths.logsDir() }), path.join(paths.logsDir(), 'x'));
  assert.equal(paths.resolvePath('', { fallback: paths.outputsDir() }), paths.outputsDir());
  const absolute = path.join(os.tmpdir(), 'existing model.gguf');
  assert.equal(paths.resolvePath(absolute), absolute);
  assert.equal(paths.resolvePath('~/waifu'), path.join(os.homedir(), 'waifu'));
});

test('deep merge preserves nested values while arrays and null replace without mutating input', () => {
  const base = { nested: { keep: 1, replace: 2 }, list: ['base'], nullable: { key: 1 } };
  const result = deepMerge(base, { nested: { replace: 3 }, list: ['local'], nullable: null });
  assert.deepEqual(result, { nested: { keep: 1, replace: 3 }, list: ['local'], nullable: null });
  result.list.push('new');
  result.nested.keep = 4;
  assert.deepEqual(base, { nested: { keep: 1, replace: 2 }, list: ['base'], nullable: { key: 1 } });
  assert.equal({}.polluted, undefined);
  deepMerge(JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal({}.polluted, undefined);
});

test('config precedence is defaults then base then local then explicit overrides', t => {
  const { root, paths, load } = fixture(t);
  fs.writeFileSync(path.join(root, 'selfie.config.json'), JSON.stringify({
    outputDir: '${LOCAL}/outputs/base', sdcpp: { args: ['--base'], memory: { minFreeRamGB: 5, marginGB: 3 } },
    presets: { cepat: { cfg: 4, providers: { sdcpp: { steps: 9 } } } },
    comfyuiManaged: { env: { BASE: 'keep', BOTH: 'base' } },
  }));
  fs.writeFileSync(path.join(root, 'selfie.config.local.json'), JSON.stringify({
    outputDir: '${LOCAL}/outputs/machine', sdcpp: { args: ['--local'], memory: { marginGB: 4 } },
    presets: { cepat: { providers: { sdcpp: { cfg: 2 } } } },
    comfyuiManaged: { env: { BOTH: 'local' } },
  }));
  const cfg = load({ sdcpp: { args: ['--cli'], memory: { computeBufferGB: 1 } } });
  assert.equal(cfg.outputDir, path.join(paths.outputsDir(), 'machine'));
  assert.deepEqual(cfg.sdcpp.args, ['--cli']);
  assert.equal(cfg.sdcpp.memory.minFreeRamGB, 5);
  assert.equal(cfg.sdcpp.memory.marginGB, 4);
  assert.equal(cfg.sdcpp.memory.computeBufferGB, 1);
  assert.deepEqual(cfg.presets.cepat.providers.sdcpp, { resolution: 768, steps: 9, cfg: 2 });
  assert.deepEqual(cfg.comfyuiManaged.env, { BASE: 'keep', BOTH: 'local' });
});

test('portable config plus a copied local config preserves the previous effective configuration', t => {
  const { root, load } = fixture(t);
  const write = (filename, value) => fs.writeFileSync(path.join(root, filename), JSON.stringify(value));
  const previous = {
    provider: 'sdcpp', outputDir: path.join(root, 'previous outputs'),
    logFile: path.join(root, 'previous logs', 'selfie.log'),
    autoOrder: ['sdcpp', 'comfyui'],
    sdcpp: {
      binaryPath: path.join(root, 'previous engine', 'sd-cli.exe'),
      diffusionModel: path.join(root, 'previous models', 'diffusion.gguf'),
      vae: path.join(root, 'previous models', 'vae.safetensors'),
      llm: path.join(root, 'previous models', 'encoder.gguf'), llmVision: null,
      offloadToCpu: false, args: ['--sampling-method', 'euler'], modelArgs: [],
      memory: { marginGB: 4 },
    },
    presets: { hemat: { steps: 8, sdcpp: { args: ['--vae-tiling'], strength: 0.4 } } },
    comfyuiManaged: {
      installDir: path.join(root, 'previous ComfyUI'), pythonPath: 'python.exe', mainScript: 'main.py',
      env: { SYNTHETIC_SETTING: 'preserved' }, profiles: { low: { args: ['--lowvram'] } }, profile: 'low',
    },
  };
  write('selfie.config.json', previous);
  const before = load();
  write('selfie.config.local.json', previous);
  const portable = {
    provider: 'auto', outputDir: '${LOCAL}/outputs', logFile: '${LOCAL}/logs/selfie.log',
    autoOrder: ['comfyui', 'comfyui-managed', 'sdcpp'],
    sdcpp: { binaryPath: '', diffusionModel: '${LOCAL}/models/diffusion_models/shared.gguf',
      vae: '${LOCAL}/models/vae/shared.safetensors', llm: '${LOCAL}/models/text_encoders/shared.gguf',
      llmVision: '${LOCAL}/models/text_encoders/projector.gguf', offloadToCpu: true,
      args: ['--offload-to-cpu'], modelArgs: ['shared=true'] },
  };
  write('selfie.config.json', portable);
  assert.deepEqual(load(), before);
  const overridden = load({ sdcpp: { args: ['--override'], memory: { computeBufferGB: 1 } },
    comfyuiManaged: { profiles: { low: { args: ['--reserve-vram', '1'] } } } });
  assert.equal(overridden.sdcpp.memory.marginGB, 4);
  assert.equal(overridden.sdcpp.memory.computeBufferGB, 1);
  assert.deepEqual(overridden.sdcpp.args, ['--override']);
  assert.deepEqual(overridden.comfyuiManaged.profiles.low.args, ['--reserve-vram', '1']);
});

test('missing config files use local outputs and logs with kind-specific models', t => {
  const { paths, load } = fixture(t);
  const cfg = load({ sdcpp: { diffusionModel: 'd.gguf', vae: 'v.safetensors', llm: 'l.gguf', llmVision: 'p.gguf' } });
  assert.equal(cfg.outputDir, paths.outputsDir());
  assert.equal(cfg.logPath, path.join(paths.logsDir(), 'selfie.log'));
  assert.equal(cfg.sdcpp.diffusionModel, path.join(paths.modelsDir('diffusion_models'), 'd.gguf'));
  assert.equal(cfg.sdcpp.vae, path.join(paths.modelsDir('vae'), 'v.safetensors'));
  assert.equal(cfg.sdcpp.llm, path.join(paths.modelsDir('text_encoders'), 'l.gguf'));
  assert.equal(cfg.sdcpp.llmVision, path.join(paths.modelsDir('text_encoders'), 'p.gguf'));
});

test('machine config LOCAL references use the environment local directory', t => {
  const { root } = fixture(t);
  const localDir = path.join(root, 'alternate runtime');
  fs.writeFileSync(path.join(root, 'selfie.config.local.json'), JSON.stringify({
    referenceDir: '${LOCAL}/references', sdcpp: { diffusionModel: '${LOCAL}/models/diffusion_models/d.gguf' },
  }));
  const cfg = loadSelfieConfig({}, { repoRoot: root, env: { WAIFU_LOCAL_DIR: localDir } });
  assert.equal(cfg.referenceDir, path.join(localDir, 'references'));
  assert.equal(cfg.sdcpp.diffusionModel, path.join(localDir, 'models', 'diffusion_models', 'd.gguf'));
});

test('invalid local config reports its filename instead of silently ignoring overrides', t => {
  const { root, load } = fixture(t);
  fs.writeFileSync(path.join(root, 'selfie.config.local.json'), '{bad json');
  assert.throws(() => load(), /selfie\.config\.local\.json is invalid/);
  fs.writeFileSync(path.join(root, 'selfie.config.local.json'), '[]');
  assert.throws(() => load(), /must contain an object/);
});

test('managed portable runtime wins over legacy paths and expands launch arguments', t => {
  const { root, paths } = fixture(t);
  const runtime = paths.runtimeDir('comfyui');
  fs.mkdirSync(path.join(runtime, 'ComfyUI'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'python_embeded'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'ComfyUI', 'main.py'), '# fake');
  fs.writeFileSync(path.join(runtime, 'python_embeded', 'python.exe'), 'fake');
  const actual = resolveManagedPaths({ installDir: path.join(root, 'legacy'), pythonPath: 'python.exe', mainScript: 'main.py',
    args: ['--output-directory', '${LOCAL}/outputs'] }, paths);
  assert.equal(actual.installDir, runtime);
  assert.equal(actual.pythonPath, path.join(runtime, 'python_embeded', 'python.exe'));
  assert.equal(actual.mainScript, path.join(runtime, 'ComfyUI', 'main.py'));
  assert.deepEqual(actual.args, ['--output-directory', paths.outputsDir()]);
});

test('incomplete local engines fall back to explicit legacy paths and report missing local files', t => {
  const { root, paths } = fixture(t);
  fs.mkdirSync(paths.runtimeDir('comfyui'), { recursive: true });
  fs.mkdirSync(paths.runtimeDir('sd-cli'), { recursive: true });
  const managed = resolveManagedPaths({ installDir: path.join(root, 'legacy') }, paths);
  assert.equal(managed.installDir, path.join(root, 'legacy'));
  assert.equal(managed._runtimeWarnings[0].code, 'LOCAL_COMFYUI_RUNTIME_FALLBACK');
  assert.equal(managed._localRuntime.missing.length, 2);
  assert.equal(resolveSdCliBinary(path.join(root, 'legacy.exe'), paths), path.join(root, 'legacy.exe'));
  assert.equal(resolveSdCliBinary('', paths),
    path.join(paths.runtimeDir('sd-cli'), process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli'));
});

test('absent local runtime falls back only to explicit engine paths', t => {
  const { root, paths } = fixture(t);
  const settings = resolveManagedPaths({ installDir: 'old engine', pythonPath: 'venv/python.exe', mainScript: 'app/main.py' }, paths);
  assert.equal(settings.installDir, path.join(root, 'old engine'));
  assert.equal(settings.pythonPath, path.join(root, 'old engine', 'venv', 'python.exe'));
  assert.equal(settings.mainScript, path.join(root, 'old engine', 'app', 'main.py'));
  assert.equal(resolveManagedPaths({}, paths).installDir, '');
  assert.equal(resolveSdCliBinary('', paths), '');
  assert.equal(resolveSdCliBinary('old engine/sd-cli.exe', paths), path.join(root, 'old engine', 'sd-cli.exe'));
});

test('raw ComfyUI and sd.cpp provider configurations resolve references and outputs through LOCAL', t => {
  const { root, paths } = fixture(t);
  const cfg = { rootDir: root, localDir: paths.localDir, comfyUrl: 'http://127.0.0.1:1',
    outputDir: '${LOCAL}/outputs', referenceDir: '${LOCAL}/references',
    sdcpp: { binaryPath: '${LOCAL}/legacy.exe', diffusionModel: '${LOCAL}/models/diffusion_models/d.gguf' } };
  const comfy = new ComfyUiProvider({ ...cfg }, { env: {} });
  const sd = new SdCppProvider({ ...cfg }, { logger: () => {}, warner: () => {}, env: {} });
  for (const provider of [comfy, sd]) {
    assert.equal(provider.cfg.outputDir, paths.outputsDir());
    assert.equal(provider.cfg.referenceDir, path.join(paths.localDir, 'references'));
  }
  assert.equal(sd.sd.binaryPath, path.join(paths.localDir, 'legacy.exe'));
  assert.equal(sd.sd.diffusionModel, path.join(paths.modelsDir('diffusion_models'), 'd.gguf'));
});

test('managed process uses the same automatic local paths without launching', async t => {
  const { root, paths } = fixture(t);
  fs.mkdirSync(paths.runtimeDir('comfyui'), { recursive: true });
  fs.mkdirSync(path.join(paths.runtimeDir('comfyui'), 'ComfyUI'), { recursive: true });
  fs.mkdirSync(path.join(paths.runtimeDir('comfyui'), 'python_embeded'), { recursive: true });
  fs.writeFileSync(path.join(paths.runtimeDir('comfyui'), 'python_embeded', 'python.exe'), 'fake');
  fs.writeFileSync(path.join(paths.runtimeDir('comfyui'), 'ComfyUI', 'main.py'), '# fake');
  const cfg = { rootDir: root, comfyuiManaged: { installDir: 'legacy', pythonPath: 'python.exe', mainScript: 'main.py' } };
  let spawned = false;
  const lifecycle = new ComfyUiManagedProcess(cfg, { env: {}, logger: () => {}, warner: () => {},
    spawnProcess: () => { spawned = true; throw new Error('must not start'); } });
  await lifecycle.initialize();
  assert.equal(lifecycle.installDir, paths.runtimeDir('comfyui'));
  assert.equal(lifecycle.mainScript, path.join(paths.runtimeDir('comfyui'), 'ComfyUI', 'main.py'));
  assert.equal(spawned, false);
});

test('explicit userData model base remains a legacy compatibility override', t => {
  const { root, paths } = fixture(t);
  const userDataDir = path.join(root, 'old userdata');
  const cfg = resolveSelfiePaths({ userDataDir, sdcpp: { binaryPath: 'bin/sd-cli.exe', diffusionModel: 'd.gguf' } },
    { repoRoot: root, env: {} });
  assert.equal(cfg.sdcpp.binaryPath, path.join(userDataDir, 'models', 'sdcpp', 'bin', 'sd-cli.exe'));
  assert.equal(cfg.sdcpp.diffusionModel, path.join(userDataDir, 'models', 'sdcpp', 'd.gguf'));
  assert.equal(paths.localDir, path.join(root, 'local'));
});

test('archive bin directories and non-Windows embedded Python layouts are detected locally', t => {
  const { paths } = fixture(t);
  const binary = path.join(paths.runtimeDir('sd-cli'), 'bin', 'sd-cli.exe');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'fake');
  const python = path.join(paths.runtimeDir('comfyui'), 'python_embedded', 'python');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, 'fake');
  fs.mkdirSync(path.join(paths.runtimeDir('comfyui'), 'ComfyUI'), { recursive: true });
  fs.writeFileSync(path.join(paths.runtimeDir('comfyui'), 'ComfyUI', 'main.py'), '# fake');
  assert.equal(resolveSdCliBinary('legacy.exe', paths), binary);
  assert.equal(resolveManagedPaths({}, paths).pythonPath, python);
});

test('LOCAL expands sd.cpp base and preset arguments and initial images', t => {
  const { root, paths } = fixture(t);
  const cfg = resolveSelfiePaths({ sdcpp: { args: ['--llm', '${LOCAL}/models/text_encoders/l.gguf'],
    modelArgs: ['cache=${LOCAL}/cache'], extraArgs: ['--output=${LOCAL}/outputs'] },
  presets: { cepat: { sdcpp: { initImage: '${LOCAL}/references/start.png', args: ['-i', '${LOCAL}/references/start.png'] } } } },
  { repoRoot: root, env: {} });
  assert.equal(cfg.sdcpp.args[1], path.join(paths.modelsDir('text_encoders'), 'l.gguf'));
  assert.equal(cfg.sdcpp.modelArgs[0], `cache=${paths.localDir}/cache`);
  assert.equal(cfg.sdcpp.extraArgs[0], `--output=${paths.localDir}/outputs`);
  assert.equal(cfg.presets.cepat.sdcpp.initImage, path.join(paths.localDir, 'references', 'start.png'));
  assert.equal(cfg.presets.cepat.sdcpp.args[1], cfg.presets.cepat.sdcpp.initImage);
});

async function freshComfyFixture(t, { holdUpload = false, missingReference = false } = {}) {
  const { root, paths } = fixture(t);
  const name = 'machine reference.png';
  const bytes = Buffer.from('tiny fake reference');
  fs.mkdirSync(path.join(paths.localDir, 'references'), { recursive: true });
  if (!missingReference) fs.writeFileSync(path.join(paths.localDir, 'references', name), bytes);
  const workflow = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'workflows', 'selfie.api.json'), 'utf8'));
  const info = {};
  for (const node of Object.values(workflow)) {
    info[node.class_type] ||= { input: { required: {} } };
    for (const [key, value] of Object.entries(node.inputs)) {
      if (/^(unet_name|vae_name|clip_name\d*|image)$/.test(key) && typeof value === 'string') {
        info[node.class_type].input.required[key] = [[...(key === 'image' ? [] : [value])], {}];
      }
    }
  }
  const requests = [];
  let uploadBytes;
  let notifyUpload;
  const uploaded = new Promise(resolve => { notifyUpload = resolve; });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(`${request.method} ${url.pathname}`);
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/system_stats') { response.end('{}'); return; }
    if (url.pathname === '/view') { response.statusCode = 404; response.end('{}'); return; }
    if (url.pathname === '/upload/image') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      uploadBytes = Buffer.concat(chunks);
      notifyUpload();
      if (holdUpload) return;
      info.LoadImage.input.required.image[0] = [name];
      response.end(JSON.stringify({ name, type: 'input', subfolder: '' }));
      return;
    }
    if (url.pathname === '/object_info') { response.end(JSON.stringify(info)); return; }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const provider = new ComfyUiProvider({ rootDir: root, localDir: paths.localDir,
    comfyUrl: `http://127.0.0.1:${server.address().port}`, referenceDir: '${LOCAL}/references',
    defaultReference: name, workflowPath: path.join(ROOT_DIR, 'workflows', 'selfie.api.json'),
    mappingPath: path.join(ROOT_DIR, 'selfie.mapping.json'), healthTimeoutMs: 500 }, { env: {} });
  return { provider, requests, uploaded, bytes, getUpload: () => uploadBytes, name };
}

test('fresh ComfyUI readiness uploads the configured local reference before validating workflow choices', async t => {
  const { provider, requests, getUpload, bytes, name } = await freshComfyFixture(t);
  assert.equal((await provider.checkReady()).ready, true);
  assert.ok(getUpload().includes(bytes));
  assert.ok(requests.indexOf('POST /upload/image') < requests.indexOf('GET /object_info'));
  assert.equal(requests.some(entry => /\/prompt|\/interrupt|\/queue/.test(entry)), false);
  assert.equal(provider.uploadedRefs.has(name), true);
  const original = JSON.parse(fs.readFileSync(provider.cfg.workflowPath, 'utf8'));
  assert.notEqual(original[provider.map.reference.id].inputs[provider.map.reference.fields.image], name);
  assert.equal((await provider.checkReady()).ready, true);
  assert.equal(requests.filter(entry => entry === 'POST /upload/image').length, 1);
});

test('cancelled readiness reference upload respects the caller signal without submitting a prompt', async t => {
  const { provider, requests, uploaded } = await freshComfyFixture(t, { holdUpload: true });
  const controller = new AbortController();
  const checking = provider.checkReady(controller.signal);
  const rejected = assert.rejects(checking, /cancel readiness/);
  await uploaded;
  controller.abort(new Error('cancel readiness'));
  await rejected;
  assert.equal(provider.uploadedRefs.size, 0);
  assert.equal(requests.includes('GET /object_info'), false);
  assert.equal(requests.some(entry => /\/prompt|\/interrupt|\/queue/.test(entry)), false);
});

test('missing configured local reference gives an actionable private readiness diagnosis', async t => {
  const { provider, requests, name } = await freshComfyFixture(t, { missingReference: true });
  const result = await provider.checkReady();
  assert.equal(result.code, 'COMFYUI_REFERENCE_UNAVAILABLE');
  assert.ok(result.message.includes(provider.cfg.referenceDir));
  assert.ok(result.publicMessage.includes(name));
  assert.equal(result.publicMessage.includes(provider.cfg.referenceDir), false);
  assert.equal(requests.includes('POST /upload/image'), false);
});
