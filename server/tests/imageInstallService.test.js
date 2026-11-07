import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import AdmZip from 'adm-zip';
import { ImageInstallService } from '../settings/imageInstallService.js';
import { createSetupPlan, runSetup, downloadComponent, licenseKey } from '../../setup/install.js';
import { acquireSetupLock, acquireSetupReservation, acquireRuntimeLease, assertRuntimeIdle } from '../../setup/setupLock.js';

const bytes = Buffer.from('fixture');
const fixtureComponent = (overrides = {}) => ({ id: 'sd-cli:vulkan', name: 'Fixture runtime', version: 'fixture-1',
  url: 'https://example.invalid/runtime.zip', sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  sizeBytes: bytes.length, licenseName: 'Fixture license', licenseUrl: 'https://example.invalid/license',
  kind: 'runtime', destination: 'runtime/sdcpp/vulkan', required: true, engines: ['sdcpp'], role: 'runtime',
  when: { gpuVendor: 'any', os: 'win32' }, variant: 'vulkan', ...overrides });

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amika-image-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function fakePlan(overrides = {}) {
  const component = fixtureComponent({ installed: false, status: 'missing' });
  return { components: [component], downloadBytes: component.sizeBytes, requiredDiskBytes: component.sizeBytes * 2,
    freeBytes: 100000, hardware: { gpuVendor: 'any', devices: ['Fixture GPU'] }, variant: 'vulkan',
    licenses: [{ key: licenseKey(component), name: component.licenseName, url: component.licenseUrl, accepted: false }],
    blockers: [], fingerprint: 'fixture-pinned-manifest', ...overrides };
}

async function service(t, overrides = {}) {
  const repoRoot = await directory(t);
  const calls = [];
  const instance = new ImageInstallService({ repoRoot, env: {}, platform: 'win32',
    dependencies: { createSetupPlan: async () => fakePlan(), runSetup: async (_command, options) => {
      calls.push(options);
      options.onProgress({ phase: 'downloading', componentId: 'fixture', component: 'Fixture', downloadedBytes: 3, totalBytes: 7 });
    }, ...overrides.dependencies }, ...overrides });
  t.after(() => instance.shutdown());
  return { instance, repoRoot, calls };
}

test('PAP setup preview is read-only and execution requires reviewed server plan/license keys', async t => {
  const { instance, repoRoot, calls } = await service(t);
  const plan = await instance.plan({ provider: 'sdcpp' });
  assert.equal(plan.components[0].status, 'missing');
  assert.equal(plan.components[0].url, undefined, 'browser does not receive executable download inputs');
  assert.equal(calls.length, 0);
  await assert.rejects(fs.stat(path.join(repoRoot, 'local')), { code: 'ENOENT' });
  await assert.rejects(instance.start({ planId: plan.planId, acceptedLicenses: [] }), { code: 'INVALID_SETTINGS' });
  await assert.rejects(instance.start({ planId: plan.planId, acceptedLicenses: plan.licenses.map(l => l.key), url: 'https://bad.invalid' }), { code: 'INVALID_SETTINGS' });
  const job = await instance.start({ planId: plan.planId, acceptedLicenses: plan.licenses.map(l => l.key) });
  await instance.running;
  assert.equal((await instance.get(job.id)).state, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].installPlan, true);
  assert.equal(calls[0].force, false);
  assert.deepEqual(calls[0].acceptLicenses, ['Fixture license']);
  assert.equal((await instance.latest()).id, job.id, 'refresh can reconnect to the durable job');
});

test('PAP setup blocks invalid metadata, hardware, disk prerequisites, and stale reviewed manifests', async t => {
  for (const code of ['BLOCKED_METADATA', 'UNSUPPORTED_GPU', 'INSUFFICIENT_DISK']) {
    const { instance, calls } = await service(t, { dependencies: {
      createSetupPlan: async () => fakePlan({ blockers: [{ code, message: 'Fixture prerequisite' }] }),
      runSetup: async () => calls.push('unexpected'),
    } });
    const plan = await instance.plan({ provider: 'comfyui-managed' });
    assert.equal(plan.blockers[0].code, code);
    await assert.rejects(instance.start({ planId: plan.planId, acceptedLicenses: plan.licenses.map(l => l.key) }), { code: 'UNSUPPORTED' });
    assert.equal(calls.length, 0);
  }
  let fingerprint = 'first';
  const { instance } = await service(t, { dependencies: { createSetupPlan: async () => fakePlan({ fingerprint }) } });
  const plan = await instance.plan({ provider: 'sdcpp' });
  fingerprint = 'changed';
  await assert.rejects(instance.start({ planId: plan.planId, acceptedLicenses: plan.licenses.map(l => l.key) }), { code: 'CONFLICT' });
});

test('PAP setup lease includes queued wait, serializes UI/CLI, and supports cancellation before installing', async t => {
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const { instance, repoRoot, calls } = await service(t, { beforeInstall: async ({ signal }) => {
    started();
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } });
  const plan = await instance.plan({ provider: 'sdcpp' });
  const job = await instance.start({ planId: plan.planId, acceptedLicenses: plan.licenses.map(l => l.key) });
  await waiting;
  await assert.rejects(acquireSetupReservation(path.join(repoRoot, 'local')), { code: 'LOCK_BUSY' });
  const finishQueuedRuntime = await acquireRuntimeLease(path.join(repoRoot, 'local'));
  await finishQueuedRuntime();
  await assert.rejects(instance.start({ planId: plan.planId, acceptedLicenses: plan.licenses.map(l => l.key) }), { code: 'IN_USE' });
  await instance.cancel(job.id);
  await instance.running;
  assert.equal(calls.length, 0);
  assert.equal((await instance.get(job.id)).state, 'cancelled');
  const release = await acquireSetupLock(path.join(repoRoot, 'local'));
  await release();
});

test('backend restart marks unfinished PAP setup interrupted without executing or automatically retrying', async t => {
  const repoRoot = await directory(t);
  const localDir = path.join(repoRoot, 'local');
  await fs.mkdir(localDir);
  const id = crypto.randomUUID();
  await fs.writeFile(path.join(localDir, 'image-install-job.json'), JSON.stringify({ schemaVersion: 1,
    job: { id, provider: 'sdcpp', state: 'running', phase: 'downloading' } }));
  let ran = false;
  const instance = new ImageInstallService({ repoRoot, env: {}, dependencies: { runSetup: async () => { ran = true; } } });
  t.after(() => instance.shutdown());
  assert.equal((await instance.get(id)).state, 'interrupted');
  assert.equal(ran, false);
  const journal = JSON.parse(await fs.readFile(path.join(localDir, 'image-install-job.json'), 'utf8'));
  assert.equal(journal.job.state, 'interrupted');
});

test('running PAP setup cancellation aborts the shared installer and retains a cancelled durable job', async t => {
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const { instance } = await service(t, { dependencies: {
    createSetupPlan: async () => fakePlan(),
    runSetup: async (_command, { signal, onProgress }) => {
      onProgress({ phase: 'downloading', component: 'Fixture model', downloadedBytes: 2, totalBytes: 7 });
      entered();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  } });
  const plan = await instance.plan({ provider: 'sdcpp' });
  const job = await instance.start({ planId: plan.planId, acceptedLicenses: plan.licenses.map(l => l.key) });
  await waiting;
  assert.equal((await instance.get(job.id)).state, 'running');
  await instance.cancel(job.id);
  await instance.running;
  assert.equal((await instance.get(job.id)).state, 'cancelled');
});

test('runtime leases and warm managed ownership prevent standalone CLI publication', async t => {
  const repoRoot = await directory(t);
  const localDir = path.join(repoRoot, 'local');
  const release = await acquireRuntimeLease(localDir);
  await assert.rejects(assertRuntimeIdle(localDir, { repoRoot }), { code: 'LOCK_BUSY' });
  await release();
  await fs.mkdir(path.join(repoRoot, 'data'));
  await fs.writeFile(path.join(repoRoot, 'data', 'comfyui-managed-process.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(assertRuntimeIdle(localDir, { repoRoot }), { code: 'LOCK_BUSY' });
});

test('shared downloader reports bytes, cancels with retained partials, and resumes without replacing files', async t => {
  const repoRoot = await directory(t);
  const model = Buffer.from('a fixture model with enough bytes to resume');
  const ranges = [];
  const server = http.createServer((request, response) => {
    ranges.push(request.headers.range || null);
    const offset = Number(/^bytes=(\d+)-$/.exec(request.headers.range || '')?.[1] || 0);
    if (offset) {
      response.writeHead(206, { 'Content-Range': `bytes ${offset}-${model.length - 1}/${model.length}` });
      response.end(model.subarray(offset));
    } else { response.writeHead(200, { 'Content-Length': model.length }); response.write(model.subarray(0, 8)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const component = fixtureComponent({ url: `http://127.0.0.1:${server.address().port}/model.gguf`,
    sizeBytes: model.length, sha256: crypto.createHash('sha256').update(model).digest('hex') });
  const target = path.join(repoRoot, 'model.gguf');
  const controller = new AbortController();
  let received;
  const firstBytes = new Promise(resolve => { received = resolve; });
  const downloading = downloadComponent(component, target, { signal: controller.signal, onProgress: progress => {
    if (progress.downloadedBytes >= 8) received();
  } });
  downloading.catch(() => {});
  await firstBytes;
  for (let count = 0; count < 100; count += 1) {
    try { if ((await fs.stat(`${target}.part`)).size >= 8) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  controller.abort();
  await assert.rejects(downloading, error => error.name === 'AbortError');
  assert.equal((await fs.stat(`${target}.part`)).size, 8);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  const progress = [];
  await downloadComponent(component, target, { onProgress: value => progress.push(value) });
  assert.deepEqual(ranges, [null, 'bytes=8-']);
  assert.deepEqual(await fs.readFile(target), model);
  assert.ok(progress.some(value => value.phase === 'verifying'));
});

test('verified CLI archives are reused without re-extraction and altered installed files remain protected', async t => {
  const repoRoot = await directory(t);
  const zip = new AdmZip();
  zip.addFile('release/sd-cli.exe', bytes);
  const archive = zip.toBuffer();
  const component = fixtureComponent({ id: undefined, sha256: crypto.createHash('sha256').update(archive).digest('hex'), sizeBytes: archive.length });
  delete component.id;
  const legacy = { ...component, engines: undefined, role: undefined, when: undefined, variant: undefined };
  for (const key of Object.keys(legacy)) if (legacy[key] === undefined) delete legacy[key];
  const manifest = { schemaVersion: 1, components: {
    'sd-cli': legacy, cudart: { ...legacy, required: false, url: 'https://example.invalid/library.bin' },
    'comfyui-portable': { ...legacy, destination: 'runtime/comfyui' },
    'comfyui-gguf-node': { ...legacy, destination: 'runtime/comfyui/ComfyUI/custom_nodes/ComfyUI-GGUF' },
    models: [],
  } };
  const manifestPath = path.join(repoRoot, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  let downloads = 0;
  const options = { repoRoot, env: {}, manifestPath, yes: true, acceptLicenses: ['Fixture license'], log: () => {},
    dependencies: { detectGpuVendor: async () => ({ gpuVendor: 'any' }), downloadComponent: async (c, target) => {
      downloads += 1;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, c.url.endsWith('.zip') ? archive : bytes);
    } } };
  // sdcli also selects its optional runtime library; exclude it for this exact archive fixture.
  manifest.components.cudart.destination = 'runtime/library';
  manifest.components.cudart.sizeBytes = bytes.length;
  manifest.components.cudart.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await runSetup('sdcli', options);
  const first = downloads;
  await runSetup('sdcli', options);
  assert.equal(downloads, first);
  const installed = path.join(repoRoot, 'local', 'runtime', 'sdcpp', 'vulkan', 'sd-cli.exe');
  const recordPath = path.join(repoRoot, 'local', 'installed.json');
  const oldRecord = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  for (const component of Object.values(oldRecord.components)) { delete component.files; delete component.fileHashes; }
  await fs.writeFile(recordPath, JSON.stringify(oldRecord));
  await runSetup('sdcli', options);
  assert.equal(downloads, first, 'pre-update CLI provenance is adopted without downloading or overwriting');
  const migrated = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  assert.ok(migrated.components['sd-cli'].fileHashes['sd-cli.exe']);
  // Simulate a process crash between publication and the installed.json commit.
  const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  const published = record.components['sd-cli'];
  delete record.components['sd-cli'];
  await fs.writeFile(recordPath, JSON.stringify(record));
  const staging = path.join(repoRoot, 'local', '.staging');
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(staging, 'publication.json'), JSON.stringify({ schemaVersion: 1,
    component: { id: 'sd-cli', sha256: published.sha256, destination: published.destination },
    files: published.files, fileHashes: published.fileHashes, staging: '.staging/extract-fixture/release' }));
  await runSetup('sdcli', options);
  assert.deepEqual(await fs.readFile(installed), bytes, 'interrupted owned publication is safely restored');
  await assert.rejects(fs.stat(path.join(staging, 'publication.json')), { code: 'ENOENT' });
  await fs.writeFile(installed, 'altered runtime');
  await assert.rejects(runSetup('sdcli', options), /installed file changed/);
  assert.equal(await fs.readFile(installed, 'utf8'), 'altered runtime');
});

test('shipped guided setup limits components by engine and requires complete metadata without downloads', async t => {
  const repoRoot = await directory(t);
  const manifestPath = new URL('../../setup/manifest.json', import.meta.url);
  const options = { repoRoot, env: {}, manifestPath, platform: 'win32',
    dependencies: { detectGpuVendor: async () => ({ gpuVendor: 'nvidia' }),
      runCommand: async () => { throw new Error('No extractor installed'); }, diskSpace: () => ({ freeBytes: Number.MAX_SAFE_INTEGER }) } };
  const sd = await createSetupPlan({ ...options, engine: 'sdcpp', variant: 'vulkan' });
  assert.equal(sd.blockers.length, 0);
  assert.ok(sd.components.every(c => c.engines.includes('sdcpp')));
  assert.ok(!sd.components.some(c => c.id.startsWith('comfyui')));
  const comfy = await createSetupPlan({ ...options, engine: 'comfyui' });
  assert.equal(comfy.components[0].id, '7zip-extractor');
  assert.equal(comfy.blockers.length, 0);
  const invalid = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  invalid.components['comfyui-gguf-node'].sha256 = 'TODO test fixture metadata';
  const invalidManifest = path.join(repoRoot, 'invalid-manifest.json');
  await fs.writeFile(invalidManifest, JSON.stringify(invalid));
  const blocked = await createSetupPlan({ ...options, manifestPath: invalidManifest, engine: 'comfyui' });
  assert.ok(blocked.blockers.some(b => b.code === 'BLOCKED_METADATA'));
  await assert.rejects(fs.stat(path.join(repoRoot, 'local')), { code: 'ENOENT' });
});

test('guided managed setup installs a local portable extractor before archives and reuses it on retry', async t => {
  const repoRoot = await directory(t);
  const localDir = path.join(repoRoot, 'local');
  const base = fixtureComponent({ variant: undefined });
  for (const field of ['id', 'engines', 'role', 'when', 'variant']) delete base[field];
  const data = { schemaVersion: 1, components: {
    'comfyui-portable': { ...base, url: 'https://example.invalid/portable.7z', destination: 'runtime/comfyui' },
    'comfyui-gguf-node': { ...base, url: 'https://example.invalid/node.zip', destination: 'runtime/comfyui/ComfyUI/custom_nodes/ComfyUI-GGUF' },
    '7zip-extractor': { ...base, url: 'https://example.invalid/7zr.exe', destination: 'runtime/tools/7zip', required: false,
      engines: ['comfyui'], role: 'runtime_library', when: { gpuVendor: 'any', os: 'win32' } },
    'sd-cli': { ...base, url: 'https://example.invalid/sd-cli.exe', destination: 'runtime/sdcpp/vulkan' },
    cudart: { ...base, url: 'https://example.invalid/library.bin', destination: 'runtime/library' },
    models: [{ ...base, url: 'https://example.invalid/model.gguf', destination: 'models/diffusion/model.gguf', kind: 'diffusion_models' }],
  } };
  const manifestPath = path.join(repoRoot, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(data));
  const downloaded = [];
  const extracted = [];
  let pip = 0;
  const options = { repoRoot, env: {}, manifestPath, platform: 'win32', engine: 'comfyui',
    yes: true, installPlan: true, acceptLicenses: ['Fixture license'], log: () => {}, dependencies: {
      detectGpuVendor: async () => ({ gpuVendor: 'nvidia' }),
      runCommand: async (command, args) => {
        if (args[0] === '-h' && command === path.join(localDir, 'runtime', 'tools', '7zip', '7zr.exe')) {
          await fs.stat(command); return { stdout: 'fixture 7zr' };
        }
        if (command.endsWith('python.exe')) { pip += 1; return { stdout: '' }; }
        throw new Error('No system extractor');
      },
      downloadComponent: async (component, target) => {
        downloaded.push(component.id);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
      },
      extractArchive: async (archive, destination, { extractor }) => {
        assert.equal(extractor.command, path.join(localDir, 'runtime', 'tools', '7zip', '7zr.exe'));
        assert.deepEqual(await fs.readFile(extractor.command), bytes);
        extracted.push(path.basename(archive));
        if (archive.endsWith('portable.7z')) {
          await fs.mkdir(path.join(destination, 'portable', 'ComfyUI'), { recursive: true });
          await fs.mkdir(path.join(destination, 'portable', 'python_embeded'), { recursive: true });
          await fs.writeFile(path.join(destination, 'portable', 'ComfyUI', 'main.py'), bytes);
          await fs.writeFile(path.join(destination, 'portable', 'python_embeded', 'python.exe'), bytes);
          await fs.writeFile(path.join(destination, 'portable', 'ComfyUI', 'extra_model_paths.yaml.example'), 'comfyui:\n  base_path: fixture\n  diffusion_models: models/diffusion_models/\n');
        } else {
          await fs.mkdir(path.join(destination, 'node'), { recursive: true });
          await fs.writeFile(path.join(destination, 'node', 'requirements.txt'), bytes);
          await fs.writeFile(path.join(destination, 'node', '__init__.py'), bytes);
        }
      },
    } };
  await runSetup('plan', options);
  assert.equal(downloaded[0], '7zip-extractor');
  assert.ok(!downloaded.some(id => id.startsWith('sd-cli') || id === 'cudart'));
  const first = downloaded.length;
  await runSetup('plan', options);
  assert.equal(downloaded.length, first);
  assert.equal(extracted.length, 2);
  assert.equal(pip, 1);
});
