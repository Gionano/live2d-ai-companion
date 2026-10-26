import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { readManifest, listComponents, selectComponents, validateManifest, validatePlanRoles } from '../../setup/manifest.js';
import { runSetup } from '../../setup/install.js';
import { parseArgs } from '../../setup/cli.js';

const BYTES = Buffer.from('local fixture');

function item(name, destination, engines, role, extra = {}) {
  return { name, version: 'test-fixture-2', url: 'https://example.invalid/test-fixture-2/test-fixture.gguf',
    sha256: crypto.createHash('sha256').update(BYTES).digest('hex'), sizeBytes: BYTES.length,
    licenseName: 'Test fixture license', licenseUrl: 'https://example.invalid/test-fixture-license',
    kind: role === 'runtime' ? 'runtime' : 'text_encoders', destination, required: true,
    engines, role, when: { gpuVendor: 'any', os: 'win32' }, ...extra };
}

function manifest() {
  return { schemaVersion: 2, components: {
    'comfyui-portable': item('portable', 'runtime/comfyui', ['comfyui'], 'runtime'),
    'comfyui-gguf-node': item('node', 'runtime/comfyui/ComfyUI/custom_nodes/ComfyUI-GGUF', ['comfyui'], 'node'),
    'sd-cli': [
      item('cuda fixture', 'runtime/sd-cli/cuda12', ['sdcpp'], 'runtime', { variant: 'cuda12', when: { gpuVendor: 'nvidia', os: 'win32' } }),
      item('vulkan fixture', 'runtime/sd-cli/vulkan', ['sdcpp'], 'runtime', { variant: 'vulkan' }),
    ],
    cudart: item('cudart fixture', 'runtime/sd-cli/cuda12', ['sdcpp'], 'runtime_library', { variant: 'cuda12', when: { gpuVendor: 'nvidia', os: 'win32' } }),
    models: [
      item('diffusion', 'models/diffusion_models/diffusion.gguf', ['comfyui', 'sdcpp'], 'diffusion', { kind: 'diffusion_models' }),
      item('vae', 'models/vae/vae.safetensors', ['comfyui', 'sdcpp'], 'vae', { kind: 'vae' }),
      item('sd encoder Q4', 'models/text_encoders/encoder-q4.gguf', ['sdcpp'], 'text_encoder'),
      item('mmproj', 'models/text_encoders/mmproj.gguf', ['sdcpp'], 'vision_projector'),
      item('comfy encoder', 'models/text_encoders/encoder.safetensors', ['comfyui'], 'text_encoder'),
    ],
  } };
}

async function fixture(t, data = manifest(), routes = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'waifu-setup-v2-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer((req, res) => { requests.push(req.url); res.end(routes[req.url] || BYTES); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const component of [data.components['comfyui-portable'], data.components['comfyui-gguf-node'], ...data.components['sd-cli'], data.components.cudart, ...data.components.models, ...(data.components.constraints ? [data.components.constraints] : [])]) {
    const pathname = component.idPath || (component.role === 'runtime' && component.engines.includes('sdcpp') ? '/sd-cli.exe' : component.name === 'cudart fixture' ? '/cudart.dll' : `/${path.basename(component.destination)}`);
    delete component.idPath;
    component.url = `${base}${pathname}`;
    const bytes = routes[pathname] || BYTES;
    component.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    component.sizeBytes = bytes.length;
  }
  const manifestPath = path.join(directory, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(data));
  const lines = [];
  const options = { repoRoot: directory, env: {}, platform: 'win32', manifestPath, log: (line) => lines.push(line),
    dependencies: { detectGpuVendor: async () => ({ gpuVendor: 'nvidia', devices: ['injected NVIDIA fixture'] }),
      runCommand: async () => assert.fail('test cannot run a native process or pip') },
  };
  return { directory, data, manifestPath, requests, lines, options };
}

test('committed v2 metadata checks runtime isolation, roles, pins and unresolved node fields', () => {
  const shipped = readManifest(new URL('../../setup/manifest.json', import.meta.url));
  assert.equal(shipped.schemaVersion, 2);
  assert.deepEqual(shipped.components['sd-cli'].map((component) => component.variant), ['cuda12', 'vulkan']);
  assert.equal(shipped.components.models.length, 5);
  assert.equal(shipped.components.cudart.required, true);
  for (const component of listComponents(shipped)) {
    assert.ok(component.engines.length);
    assert.ok(component.role);
    assert.deepEqual(Object.keys(component.when).sort(), ['gpuVendor', 'os']);
    const urlPin = component.id === 'cudart' ? shipped.components['sd-cli'].find(entry => entry.variant === 'cuda12').version
      : component.version || component.commit;
    assert.ok(component.url.includes(urlPin));
    if (component.id === 'comfyui-gguf-node') {
      assert.match(component.sha256, /TODO/);
      assert.equal(component.sizeBytes, null);
    } else {
      assert.match(component.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(component.sizeBytes) && component.sizeBytes > 0);
    }
  }
  assert.deepEqual(validateManifest(shipped).errors.map(error => error.split(':')[0]), [
    'components.comfyui-gguf-node.sha256',
    'components.comfyui-gguf-node.sizeBytes',
  ]);
  // Every component must reject incomplete metadata independently of local files.
  const placeholders = structuredClone(shipped);
  for (const group of Object.values(placeholders.components)) {
    for (const component of Array.isArray(group) ? group : [group]) {
      component.url = 'TODO verified artifact URL';
      component.sha256 = 'TODO verified SHA-256';
      component.sizeBytes = null;
    }
  }
  const errors = validateManifest(placeholders).errors;
  for (const component of listComponents(placeholders)) {
    for (const field of ['url', 'sha256', 'sizeBytes']) assert.ok(errors.some(error => error.startsWith(`components.${component.id}.${field}:`)));
  }
  const selected = selectComponents(shipped, { engine: 'sdcpp', gpuVendor: 'nvidia', os: 'win32' });
  assert.equal(validatePlanRoles(selected, { engines: ['sdcpp'] }).valid, true);
  const schema = readManifest(new URL('../../setup/manifest.schema.json', import.meta.url));
  assert.deepEqual(schema.oneOf.map((branch) => branch.properties.schemaVersion.const), [1, 2]);
  assert.ok(schema.$defs.component2.required.includes('engines'));
});

test('portable config and workflow filenames match committed manifest destinations', () => {
  const shipped = readManifest(new URL('../../setup/manifest.json', import.meta.url));
  const config = readManifest(new URL('../../selfie.config.json', import.meta.url));
  const workflow = readManifest(new URL('../../workflows/selfie.api.json', import.meta.url));
  const sdModels = selectComponents(shipped, { command: 'models', engine: 'sdcpp', os: 'win32' });
  for (const [role, key] of [['diffusion', 'diffusionModel'], ['vae', 'vae'], ['text_encoder', 'llm'], ['vision_projector', 'llmVision']]) {
    assert.equal(config.sdcpp[key], '${LOCAL}/' + sdModels.find(component => component.role === role).destination);
  }
  const comfyModels = selectComponents(shipped, { command: 'models', engine: 'comfyui', os: 'win32' });
  for (const [role, node, input] of [['diffusion', '1', 'unet_name'], ['vae', '3', 'vae_name'], ['text_encoder', '2', 'clip_name']]) {
    assert.equal(path.posix.basename(comfyModels.find(component => component.role === role).destination), workflow[node].inputs[input]);
  }
  assert.equal(sdModels.find(component => component.role === 'text_encoder').version, sdModels.find(component => component.role === 'vision_projector').version);
  for (const variant of ['cuda12', 'vulkan']) {
    const selected = selectComponents(shipped, { engine: 'sdcpp', variant, os: 'win32' });
    assert.equal(validateManifest(shipped, { selectedIds: selected.map(component => component.id) }).valid, true);
  }
});

test('default setup manifest supports offline model and sd.cpp plans in a fresh checkout', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'waifu-shipped-manifest-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'setup'));
  await fs.copyFile(new URL('../../setup/manifest.json', import.meta.url), path.join(directory, 'setup', 'manifest.json'));
  const options = { repoRoot: directory, env: {}, platform: 'win32', log: () => {},
    dependencies: { detectGpuVendor: async () => ({ gpuVendor: 'nvidia' }),
      runCommand: async () => assert.fail('manifest plans cannot run native processes') },
  };
  const shipped = readManifest(path.join(directory, 'setup', 'manifest.json'));
  for (const selection of [
    { command: 'models', engine: 'sdcpp', count: 4 },
    { command: 'models', engine: 'comfyui', count: 3 },
    { command: 'sdcli', variant: 'cuda12', count: 2 },
    { command: 'sdcli', variant: 'vulkan', count: 1 },
  ]) {
    const result = await runSetup(selection.command, { ...options, engine: selection.engine, variant: selection.variant });
    assert.equal(result.dryRun, true);
    assert.equal(result.components.length, selection.count);
    const validation = validateManifest(shipped, { selectedIds: result.components.map(component => component.id) });
    assert.equal(validation.valid, true, validation.errors.join('\n'));
  }
  await assert.rejects(fs.stat(path.join(directory, 'local')), { code: 'ENOENT' });
});

test('v2 selectors filter engines, choose CUDA only for NVIDIA, allow explicit Vulkan override, and retain OS conditions', () => {
  const data = manifest();
  assert.equal(validateManifest(data).valid, true);
  const ids = (options) => selectComponents(data, { os: 'win32', ...options }).map((component) => component.id);
  assert.deepEqual(ids({ command: 'sdcli', gpuVendor: 'nvidia' }), ['sd-cli:cuda12', 'cudart']);
  assert.deepEqual(ids({ command: 'sdcli', gpuVendor: 'any' }), ['sd-cli:vulkan']);
  assert.deepEqual(ids({ command: 'sdcli', gpuVendor: 'nvidia', variant: 'vulkan' }), ['sd-cli:vulkan']);
  assert.deepEqual(ids({ command: 'sdcli', gpuVendor: 'any', variant: 'cuda12' }), ['sd-cli:cuda12', 'cudart']);
  assert.deepEqual(ids({ command: 'sdcli', os: 'linux', variant: 'cuda12' }), []);
  assert.deepEqual(ids({ command: 'models', engine: 'comfyui' }), ['models[0]', 'models[1]', 'models[4]']);
  assert.deepEqual(ids({ command: 'models', engine: 'sdcpp' }), ['models[0]', 'models[1]', 'models[2]', 'models[3]']);
  assert.throws(() => ids({ engine: 'unknown' }), /Unknown engine/);
});

test('v2 validates engines, roles, conditions, matching required cudart, and cross-variant destination collisions', () => {
  for (const mutate of [
    (data) => { data.components.models[0].engines = ['invalid']; },
    (data) => { data.components.models[0].role = 'diffusions'; },
    (data) => { data.components.models[0].when = { gpuVendor: 'intel', os: 'win32' }; },
    (data) => { data.components.cudart.required = false; },
    (data) => { data.components.cudart.variant = 'vulkan'; },
    (data) => { data.components['sd-cli'][1].destination = data.components['sd-cli'][0].destination; },
    (data) => { data.components['sd-cli'][1].destination = `${data.components['sd-cli'][0].destination}/nested`; },
  ]) {
    const data = manifest();
    mutate(data);
    assert.equal(validateManifest(data).valid, false);
  }
});

test('GGUF destination with TODO URL requires a projector role and missing runtime/node roles are reported', () => {
  const data = manifest();
  data.components.models[2].url = 'TODO verified text encoder URL';
  data.components.models.splice(3, 1);
  const selected = selectComponents(data, { engine: 'sdcpp', os: 'win32', gpuVendor: 'nvidia' });
  assert.match(validatePlanRoles(selected, { engines: ['sdcpp'] }).errors.join('\n'), /vision_projector/);
  const all = listComponents(manifest()).filter((component) => component.role !== 'runtime' && component.role !== 'node');
  assert.match(validatePlanRoles(all).errors.join('\n'), /comfyui: missing required component role node/);
  assert.match(validatePlanRoles(all).errors.join('\n'), /sdcpp: missing required component role runtime/);
});

test('plan reports per-engine and both per-variant totals without HTTP, writes, or pip', async (t) => {
  const f = await fixture(t);
  const result = await runSetup('plan', { ...f.options, engine: 'sdcpp' });
  assert.equal(result.dryRun, true);
  assert.equal(f.requests.length, 0);
  assert.match(f.lines.join('\n'), /Plan total sdcpp\/cuda12:/);
  assert.match(f.lines.join('\n'), /Plan total sdcpp\/vulkan:/);
  assert.doesNotMatch(f.lines.join('\n'), /Plan total comfyui:/);
  await assert.rejects(fs.stat(path.join(f.directory, 'local')), { code: 'ENOENT' });
});

test('engine-specific model setup ignores unrelated TODO metadata and records selected file hashes', async (t) => {
  const f = await fixture(t);
  for (const index of [2, 3]) f.data.components.models[index].url = 'TODO unselected sd.cpp URL';
  await fs.writeFile(f.manifestPath, JSON.stringify(f.data));
  await runSetup('models', { ...f.options, engine: 'comfyui', yes: true, acceptLicenses: ['Test fixture license'] });
  assert.equal(f.requests.length, 3);
  const record = JSON.parse(await fs.readFile(path.join(f.directory, 'local', 'installed.json'), 'utf8'));
  assert.deepEqual(Object.keys(record.components), ['models[0]', 'models[1]', 'models[4]']);
  assert.equal(record.components['models[0]'].fileHashes['.'].sha256, f.data.components.models[0].sha256);
  assert.deepEqual(record.components['models[4]'].engines, ['comfyui']);
});

test('CUDA and Vulkan installations remain separate and active provenance switches only after successful setup', async (t) => {
  const f = await fixture(t);
  const options = { ...f.options, yes: true, acceptLicenses: ['Test fixture license'] };
  await runSetup('sdcli', options);
  let record = JSON.parse(await fs.readFile(path.join(f.directory, 'local', 'installed.json'), 'utf8'));
  assert.equal(record.activeVariants.sdcpp, 'cuda12');
  assert.equal(record.components.cudart.variant, 'cuda12');
  assert.equal(f.requests.length, 2);
  await runSetup('sdcli', { ...options, variant: 'vulkan' });
  record = JSON.parse(await fs.readFile(path.join(f.directory, 'local', 'installed.json'), 'utf8'));
  assert.equal(record.activeVariants.sdcpp, 'vulkan');
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'local', 'runtime', 'sd-cli', 'cuda12', 'sd-cli.exe')), BYTES);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'local', 'runtime', 'sd-cli', 'vulkan', 'sd-cli.exe')), BYTES);
  assert.equal(record.components['sd-cli:cuda12'].destination, 'runtime/sd-cli/cuda12');
  assert.equal(record.components['sd-cli:vulkan'].fileHashes['sd-cli.exe'].sizeBytes, BYTES.length);
  assert.equal(f.requests.length, 3);
});

test('variant collisions and unknown existing runtimes refuse --force before any HTTP', async (t) => {
  const f = await fixture(t);
  f.data.components['sd-cli'][1].destination = f.data.components['sd-cli'][0].destination;
  await fs.writeFile(f.manifestPath, JSON.stringify(f.data));
  const options = { ...f.options, yes: true, force: true, acceptLicenses: ['Test fixture license'] };
  await assert.rejects(runSetup('sdcli', options), /cross-variant destination collision/);
  f.data = manifest();
  await fs.writeFile(f.manifestPath, JSON.stringify(f.data));
  const runtime = path.join(f.directory, 'local', 'runtime', 'sd-cli', 'cuda12');
  await fs.mkdir(runtime, { recursive: true });
  await fs.writeFile(path.join(runtime, 'sd-cli.exe'), 'unknown binary');
  await assert.rejects(runSetup('sdcli', options), /Unrecorded incompatible runtime/);
  assert.equal(f.requests.length, 0);
  assert.equal(await fs.readFile(path.join(runtime, 'sd-cli.exe'), 'utf8'), 'unknown binary');
});

test('missing projector refuses real sd.cpp setup before any downloads', async (t) => {
  const f = await fixture(t);
  f.data.components.models.splice(3, 1);
  await fs.writeFile(f.manifestPath, JSON.stringify(f.data));
  await assert.rejects(runSetup('models', { ...f.options, engine: 'sdcpp', yes: true, acceptLicenses: ['Test fixture license'] }), /missing required model role vision_projector/);
  assert.equal(f.requests.length, 0);
});

test('ComfyUI uses pinned optional constraints in its logged pip command and --skip-pip launches nothing', async (t) => {
  const data = manifest();
  const portable = new AdmZip();
  portable.addFile('portable/ComfyUI/main.py', Buffer.from('fake main'));
  portable.addFile('portable/python_embeded/python.exe', Buffer.from('fake Python'));
  portable.addFile('portable/ComfyUI/extra_model_paths.yaml.example', Buffer.from('comfyui:\n  diffusion_models: models/diffusion_models/\n'));
  const node = new AdmZip();
  node.addFile('node/requirements.txt', Buffer.from('fake requirement'));
  node.addFile('node/__init__.py', Buffer.from('fake node'));
  data.components['comfyui-portable'].idPath = '/portable.zip';
  data.components['comfyui-gguf-node'].idPath = '/node.zip';
  data.components.constraints = item('constraints', 'runtime/comfyui/constraints.txt', ['comfyui'], 'runtime_library', { kind: 'constraints', required: false, idPath: '/constraints.txt' });
  const f = await fixture(t, data, { '/portable.zip': portable.toBuffer(), '/node.zip': node.toBuffer(), '/constraints.txt': Buffer.from('fake constraints') });
  await runSetup('comfyui', { ...f.options, yes: true, skipPip: true, acceptLicenses: ['Test fixture license'] });
  assert.deepEqual(f.requests, ['/portable.zip', '/node.zip', '/constraints.txt']);
  assert.match(f.lines.join('\n'), /Pip command:.*"-r".*"-c".*constraints\.txt/);
  assert.match(f.lines.join('\n'), /Pip skipped \(--skip-pip\)/);
  const record = JSON.parse(await fs.readFile(path.join(f.directory, 'local', 'installed.json'), 'utf8'));
  assert.equal(record.components['comfyui-gguf-node'].pip.skipped, true);
  assert.ok(record.components['comfyui-gguf-node'].pip.args.includes('-c'));
  assert.equal(record.components.constraints.fileHashes['.'].sizeBytes, 'fake constraints'.length);
});

test('CLI accepts engine/variant/skip-pip controls and the offline hash file argument', () => {
  const parsed = parseArgs(['sdcli', '--engine=sdcpp', '--variant', 'vulkan', '--skip-pip']);
  assert.equal(parsed.options.engine, 'sdcpp');
  assert.equal(parsed.options.variant, 'vulkan');
  assert.equal(parsed.options.skipPip, true);
  assert.equal(parseArgs(['hash', 'fixture.bin']).options.filePath, path.resolve('fixture.bin'));
  assert.throws(() => parseArgs(['hash', 'one.bin', 'two.bin']), /one local file/);
  assert.throws(() => parseArgs(['comfyui', '--skip-pip=false']), /does not accept a value/);
});

test('ComfyUI logs the actual constraints pip argv and hashes final bundled files after injected pip changes', async (t) => {
  const data = manifest();
  const portable = new AdmZip();
  portable.addFile('portable/ComfyUI/main.py', Buffer.from('fake main'));
  portable.addFile('portable/python_embeded/python.exe', Buffer.from('fake Python'));
  portable.addFile('portable/python_embeded/Lib/site-packages/fixture.py', Buffer.from('bundled fixture'));
  portable.addFile('portable/ComfyUI/extra_model_paths.yaml.example', Buffer.from('comfyui:\n  diffusion_models: models/diffusion_models/\n'));
  const node = new AdmZip();
  node.addFile('node/requirements.txt', Buffer.from('fake requirement'));
  node.addFile('node/__init__.py', Buffer.from('fake node'));
  data.components['comfyui-portable'].idPath = '/portable.zip';
  data.components['comfyui-gguf-node'].idPath = '/node.zip';
  data.components.constraints = item('constraints', 'runtime/comfyui/constraints.txt', ['comfyui'], 'runtime_library', { kind: 'constraints', required: false, idPath: '/constraints.txt' });
  const f = await fixture(t, data, { '/portable.zip': portable.toBuffer(), '/node.zip': node.toBuffer(), '/constraints.txt': Buffer.from('fake constraints') });
  const changedFile = path.join(f.directory, 'local', 'runtime', 'comfyui', 'python_embeded', 'Lib', 'site-packages', 'fixture.py');
  const calls = [];
  await runSetup('comfyui', { ...f.options, yes: true, acceptLicenses: ['Test fixture license'], dependencies: {
    ...f.options.dependencies, runCommand: async (command, args) => { calls.push({ command, args }); await fs.writeFile(changedFile, 'injected updated fixture'); return { stdout: '' }; },
  } });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('-c'));
  assert.match(f.lines.join('\n'), /Pip command:.*"-c".*constraints\.txt/);
  const record = JSON.parse(await fs.readFile(path.join(f.directory, 'local', 'installed.json'), 'utf8'));
  assert.equal(record.components['comfyui-gguf-node'].pip.skipped, false);
  assert.equal(record.components['comfyui-portable'].fileHashes[path.join('python_embeded', 'Lib', 'site-packages', 'fixture.py')].sha256,
    crypto.createHash('sha256').update('injected updated fixture').digest('hex'));
});

test('CUDA plans require a matching runtime library and validate its GPU condition', () => {
  const data = manifest();
  const selected = selectComponents(data, { command: 'plan', engine: 'sdcpp', gpuVendor: 'nvidia', os: 'win32' });
  const errors = validatePlanRoles(selected.filter(component => component.id !== 'cudart'), { engines: ['sdcpp'] }).errors;
  assert.match(errors.join('\n'), /sdcpp\/cuda12: missing required component role runtime_library/);
  data.components['sd-cli'][0].when.gpuVendor = 'any';
  assert.match(validateManifest(data).errors.join('\n'), /CUDA12 requires the NVIDIA GPU condition/);
});

test('runtime libraries cannot collide with another variant even without a CUDA runtime entry', () => {
  const data = manifest();
  data.components['sd-cli'].shift();
  data.components.cudart.destination = data.components['sd-cli'][0].destination;
  assert.match(validateManifest(data).errors.join('\n'), /cross-variant destination collision/);
});

test('v1 compatibility cannot overwrite a recorded typed variant with --force', async (t) => {
  const f = await fixture(t);
  const options = { ...f.options, yes: true, acceptLicenses: ['Test fixture license'] };
  await runSetup('sdcli', options);
  const before = await fs.readFile(path.join(f.directory, 'local', 'runtime', 'sd-cli', 'cuda12', 'sd-cli.exe'));
  f.data.schemaVersion = 1;
  f.data.components['sd-cli'] = f.data.components['sd-cli'][0];
  delete f.data.components['sd-cli'].variant;
  await fs.writeFile(f.manifestPath, JSON.stringify(f.data));
  await assert.rejects(runSetup('sdcli', { ...options, force: true }), /Cross-variant runtime collision/);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'local', 'runtime', 'sd-cli', 'cuda12', 'sd-cli.exe')), before);
});

test('canonical sdcpp destinations install and record one selected build without touching compatibility paths', async (t) => {
  const data = manifest();
  for (const entry of [...data.components['sd-cli'], data.components.cudart]) entry.destination = entry.destination.replace('runtime/sd-cli/', 'runtime/sdcpp/');
  const f = await fixture(t, data);
  await runSetup('sdcli', { ...f.options, variant: 'vulkan', yes: true, acceptLicenses: ['Test fixture license'] });
  assert.deepEqual(f.requests, ['/sd-cli.exe']);
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'local', 'runtime', 'sdcpp', 'vulkan', 'sd-cli.exe')), BYTES);
  await assert.rejects(fs.stat(path.join(f.directory, 'local', 'runtime', 'sd-cli')), { code: 'ENOENT' });
  const record = JSON.parse(await fs.readFile(path.join(f.directory, 'local', 'installed.json'), 'utf8'));
  assert.equal(record.activeVariants.sdcpp, 'vulkan');
});

test('physical junction aliases between variants fail before downloads even with saved provenance and --force', async (t) => {
  const f = await fixture(t);
  const local = path.join(f.directory, 'local');
  const cuda = path.join(local, 'runtime', 'sd-cli', 'cuda12');
  const vulkan = path.join(local, 'runtime', 'sd-cli', 'vulkan');
  await fs.mkdir(cuda, { recursive: true });
  await fs.writeFile(path.join(cuda, 'sd-cli.exe'), 'preserve CUDA files');
  await fs.symlink(cuda, vulkan, process.platform === 'win32' ? 'junction' : 'dir');
  const components = Object.fromEntries(listComponents(f.data).map(component => [component.id, component]));
  await fs.writeFile(path.join(local, 'installed.json'), JSON.stringify({ schemaVersion: 1, components, activeVariants: { sdcpp: 'cuda12' } }));
  await assert.rejects(runSetup('sdcli', { ...f.options, variant: 'vulkan', yes: true, force: true,
    acceptLicenses: ['Test fixture license'] }), /Cross-variant runtime collision/);
  assert.equal(f.requests.length, 0);
  assert.equal(await fs.readFile(path.join(cuda, 'sd-cli.exe'), 'utf8'), 'preserve CUDA files');
});

test('empty aliased variant destinations are refused without an installed record', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.directory, 'local', 'runtime', 'sd-cli');
  await fs.mkdir(path.join(root, 'cuda12'), { recursive: true });
  await fs.symlink(path.join(root, 'cuda12'), path.join(root, 'vulkan'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runSetup('sdcli', { ...f.options, yes: true, acceptLicenses: ['Test fixture license'] }), /Cross-variant runtime collision/);
  assert.equal(f.requests.length, 0);
  await assert.rejects(fs.stat(path.join(f.directory, 'local', 'installed.json')), { code: 'ENOENT' });
});
