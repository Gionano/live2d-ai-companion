import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { listComponents, validateManifest } from '../../setup/manifest.js';
import { parseArgs } from '../../setup/cli.js';
import {
  downloadComponent, runSetup as runSetupReal, extractArchive, detect7zExtractor, writeExtraModelPaths,
  installGgufRequirements, licenseKey, assertContained,
} from '../../setup/install.js';

function runSetup(command, options = {}) {
  return runSetupReal(command, { ...options, dependencies: {
    detectGpuVendor: async () => ({ gpuVendor: 'any', devices: ['injected test fixture'] }), ...options.dependencies,
  } });
}

async function temp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'waifu-setup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function component(buffer, url, overrides = {}) {
  return {
    name: 'Tiny local test fixture', version: 'test-fixture-1', url,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'), sizeBytes: buffer.length,
    licenseName: 'Test fixture license', licenseUrl: 'https://example.invalid/test-fixture-license',
    kind: 'runtime', destination: 'runtime/test', required: true, ...overrides,
  };
}

function manifest(item) {
  return { schemaVersion: 1, components: {
    'comfyui-portable': { ...item, destination: 'runtime/comfyui' },
    'comfyui-gguf-node': { ...item, destination: 'runtime/comfyui/ComfyUI/custom_nodes/ComfyUI-GGUF' },
    'sd-cli': { ...item, destination: 'runtime/sd-cli' },
    cudart: { ...item, destination: 'runtime/sd-cli', required: false },
    models: [{ ...item, kind: 'diffusion_models', destination: 'models/diffusion_models/tiny.gguf' }],
  } };
}

async function fakeServer(t, bytes, { ignoreRange = false, badRange = false } = {}) {
  const ranges = [];
  const server = http.createServer((req, res) => {
    ranges.push(req.headers.range || null);
    const offset = Number(/^bytes=(\d+)-$/.exec(req.headers.range || '')?.[1] || 0);
    if (offset && !ignoreRange) {
      res.writeHead(206, { 'Content-Range': `bytes ${badRange ? 0 : offset}-${bytes.length - 1}/${bytes.length}` });
      res.end(bytes.subarray(offset));
    } else { res.writeHead(200); res.end(bytes); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/tiny.gguf`, ranges };
}

async function writeManifest(directory, contents) {
  const target = path.join(directory, 'manifest.json');
  await fs.writeFile(target, JSON.stringify(contents));
  return target;
}

test('setup rejects synthetic TODO metadata and unsafe destinations', () => {
  const incomplete = manifest(component(Buffer.from('x'), 'TODO verified URL', {
    sha256: 'TODO verified SHA-256', sizeBytes: null,
  }));
  const checked = validateManifest(incomplete);
  assert.equal(checked.valid, false);
  assert.ok(checked.errors.some((error) => /TODO placeholder/.test(error)));
  assert.ok(checked.errors.some((error) => /sizeBytes.*TODO/.test(error)));
  assert.equal(incomplete.schemaVersion, 1);
  assert.deepEqual(listComponents(incomplete).map((item) => item.id), ['comfyui-portable', 'comfyui-gguf-node', 'sd-cli', 'cudart', 'models[0]']);
  const valid = manifest(component(Buffer.from('x'), 'https://example.invalid/tiny.gguf'));
  assert.deepEqual(listComponents(valid).map((item) => item.id), ['comfyui-portable', 'comfyui-gguf-node', 'sd-cli', 'cudart', 'models[0]']);
  assert.equal(validateManifest(valid).valid, true);
  assert.match(validateManifest(valid).warnings.join('\n'), /MIGRATION.*schemaVersion 1/);
  valid.components['sd-cli'].destination = '../outside';
  valid.components['comfyui-gguf-node'].commit = 'short';
  valid.components['sd-cli'].unexpected = true;
  valid.components.cudart.version = 'latest';
  assert.match(validateManifest(valid).errors.join('\n'), /destination.*traversal/);
  assert.match(validateManifest(valid).errors.join('\n'), /full 40-character/);
  assert.match(validateManifest(valid).errors.join('\n'), /unknown component field/);
  assert.match(validateManifest(valid).errors.join('\n'), /not pinned/);
});

test('manifest validates every supplied pin independently and rejects non-string pins and incomplete URLs', () => {
  const item = component(Buffer.from('fixture'), 'https://example.invalid/tiny.gguf');
  for (const value of ['TODO verified version', 'latest', '', null, undefined, 42, false, {}, []]) {
    const data = manifest(item);
    data.components['comfyui-gguf-node'] = { ...item, commit: 'a'.repeat(40), version: value };
    const checked = validateManifest(data);
    assert.equal(checked.valid, false, `version ${String(value)} must not be hidden by a valid commit`);
    assert.ok(checked.errors.some((error) => /comfyui-gguf-node\.version:/.test(error)));
  }
  for (const value of ['TODO verified commit', '', null, undefined, 42, false, {}, []]) {
    const data = manifest(item);
    data.components['comfyui-gguf-node'] = { ...item, commit: value };
    assert.ok(validateManifest(data).errors.some((error) => /comfyui-gguf-node\.commit:/.test(error)), 'valid version must not hide an invalid supplied commit');
  }
  const data = manifest(item);
  data.components['sd-cli'].url = 'https:example.invalid/binary';
  data.components['sd-cli'].licenseUrl = 'http:license';
  assert.match(validateManifest(data).errors.join('\n'), /sd-cli\.url: an HTTP\(S\) URL/);
  assert.match(validateManifest(data).errors.join('\n'), /sd-cli\.licenseUrl: an HTTP\(S\) URL/);
});

test('setup commands are dry runs by default and never write, download, extract, or install', async (t) => {
  const directory = await temp(t);
  const bytes = Buffer.from('fake model');
  const server = await fakeServer(t, bytes);
  const manifestPath = await writeManifest(directory, manifest(component(bytes, server.url)));
  const localDir = path.join(directory, 'absent local');
  const lines = [];
  for (const command of ['plan', 'models', 'sdcli', 'comfyui']) {
    const result = await runSetup(command, { repoRoot: directory, env: { WAIFU_LOCAL_DIR: localDir }, manifestPath, log: (line) => lines.push(line),
      dependencies: { runCommand: () => assert.fail('dry run cannot launch processes') },
    });
    assert.equal(result.dryRun, true);
  }
  assert.equal(server.ranges.length, 0);
  await assert.rejects(fs.stat(localDir), { code: 'ENOENT' });
  assert.match(lines.join('\n'), /Free disk:.*bytes/);
  assert.match(lines.join('\n'), /License: Test fixture license/);
  assert.match(lines.join('\n'), /Dry run/);
});

test('setup --yes refuses placeholders before any network or writes', async (t) => {
  const directory = await temp(t);
  const bytes = Buffer.from('fixture');
  const server = await fakeServer(t, bytes);
  const data = manifest(component(bytes, server.url));
  data.components.models[0].sha256 = 'TODO verified hash';
  const manifestPath = await writeManifest(directory, data);
  await assert.rejects(runSetup('models', { repoRoot: directory, env: {}, manifestPath, yes: true,
    acceptLicenses: ['Test fixture license'], log: () => {},
  }), /Setup refused.*placeholders/);
  assert.equal(server.ranges.length, 0);
  await assert.rejects(fs.stat(path.join(directory, 'local')), { code: 'ENOENT' });
});

test('setup requires --yes and per-license consent, records acceptance, and gates a changed license URL', async (t) => {
  const directory = await temp(t);
  const bytes = Buffer.from('tiny model');
  const server = await fakeServer(t, bytes);
  const item = component(bytes, server.url);
  const data = manifest(item);
  const manifestPath = await writeManifest(directory, data);
  const options = { repoRoot: directory, env: {}, manifestPath, yes: true, log: () => {} };
  await assert.rejects(runSetup('models', options), /License consent required.*--accept-license/);
  assert.equal(server.ranges.length, 0);
  await assert.rejects(fs.stat(path.join(directory, 'local')), { code: 'ENOENT' });
  await runSetup('models', { ...options, acceptLicenses: [item.licenseName] });
  const record = JSON.parse(await fs.readFile(path.join(directory, 'local', 'accepted-licenses.json'), 'utf8'));
  assert.equal(record.licenses[licenseKey(item)].url, item.licenseUrl);
  assert.equal(server.ranges.length, 1);
  await runSetup('models', options);
  assert.equal(server.ranges.length, 1, 'matching model is reused without a network call');
  data.components.models[0].licenseUrl = 'https://example.invalid/changed-license';
  await fs.writeFile(manifestPath, JSON.stringify(data));
  await assert.rejects(runSetup('models', options), /License consent required/);
  assert.equal(server.ranges.length, 1);
});

test('setup refuses incomplete or mismatched saved license acceptance before downloading', async (t) => {
  const directory = await temp(t);
  const bytes = Buffer.from('tiny model');
  const server = await fakeServer(t, bytes);
  const item = component(bytes, server.url);
  const manifestPath = await writeManifest(directory, manifest(item));
  const localDir = path.join(directory, 'local');
  await fs.mkdir(localDir);
  const consentPath = path.join(localDir, 'accepted-licenses.json');
  const options = { repoRoot: directory, env: {}, manifestPath, yes: true, log: () => {} };
  await fs.writeFile(consentPath, JSON.stringify({ schemaVersion: 1, licenses: { [licenseKey(item)]: {} } }));
  await assert.rejects(runSetup('models', options), /Invalid license acceptance/);
  await fs.writeFile(consentPath, JSON.stringify({ schemaVersion: 1, licenses: { [licenseKey(item)]: {
    name: item.licenseName, url: 'https://example.invalid/different-license', acceptedAt: new Date().toISOString(),
  } } }));
  await assert.rejects(runSetup('models', options), /Invalid license acceptance/);
  assert.equal(server.ranges.length, 0);
});

test('downloads resume .part files using HTTP Range and verify the completed bytes', async (t) => {
  const directory = await temp(t);
  const bytes = Buffer.from('tiny fixture with resumable bytes');
  const server = await fakeServer(t, bytes);
  const target = path.join(directory, 'tiny.gguf');
  await fs.writeFile(`${target}.part`, bytes.subarray(0, 9));
  await downloadComponent(component(bytes, server.url), target);
  assert.deepEqual(server.ranges, ['bytes=9-']);
  assert.deepEqual(await fs.readFile(target), bytes);
  await assert.rejects(fs.stat(`${target}.part`), { code: 'ENOENT' });
});

test('interrupted downloads retain partial bytes and resume on the next attempt', async (t) => {
  const directory = await temp(t);
  const bytes = Buffer.from('a tiny model that survives an interrupted response');
  const ranges = [];
  const server = http.createServer((req, res) => {
    ranges.push(req.headers.range || null);
    const offset = Number(/^bytes=(\d+)-$/.exec(req.headers.range || '')?.[1] || 0);
    if (!offset) {
      res.writeHead(200, { 'Content-Length': bytes.length });
      res.write(bytes.subarray(0, 10));
      setTimeout(() => res.destroy(), 20);
    } else {
      res.writeHead(206, { 'Content-Range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` });
      res.end(bytes.subarray(offset));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const item = component(bytes, `http://127.0.0.1:${server.address().port}/tiny.gguf`);
  const target = path.join(directory, 'tiny.gguf');
  await assert.rejects(downloadComponent(item, target), /aborted|premature|reset/i);
  assert.equal((await fs.stat(`${target}.part`)).size, 10);
  await downloadComponent(item, target);
  assert.deepEqual(ranges, [null, 'bytes=10-']);
  assert.deepEqual(await fs.readFile(target), bytes);
});

test('downloads restart safely when an HTTP server ignores Range and reject malformed range responses', async (t) => {
  const directory = await temp(t);
  const bytes = Buffer.from('resumable bytes');
  const ignored = await fakeServer(t, bytes, { ignoreRange: true });
  const target = path.join(directory, 'ignored.gguf');
  await fs.writeFile(`${target}.part`, bytes.subarray(0, 3));
  await downloadComponent(component(bytes, ignored.url), target);
  assert.deepEqual(await fs.readFile(target), bytes);
  const malformed = await fakeServer(t, bytes, { badRange: true });
  const badTarget = path.join(directory, 'bad.gguf');
  await fs.writeFile(`${badTarget}.part`, bytes.subarray(0, 3));
  await assert.rejects(downloadComponent(component(bytes, malformed.url), badTarget), /invalid HTTP Content-Range/);
  await assert.rejects(fs.stat(badTarget), { code: 'ENOENT' });
});

test('checksum mismatch never publishes downloaded data and existing files require --force', async (t) => {
  const directory = await temp(t);
  const bytes = Buffer.from('fixture');
  const server = await fakeServer(t, bytes);
  const target = path.join(directory, 'tiny.gguf');
  await assert.rejects(downloadComponent(component(bytes, server.url, { sha256: 'a'.repeat(64) }), target), /checksum mismatch/);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  await fs.writeFile(target, 'existing personal file');
  await assert.rejects(downloadComponent(component(bytes, server.url), target), /already exists.*--force/);
  assert.equal(await fs.readFile(target, 'utf8'), 'existing personal file');
  await downloadComponent(component(bytes, server.url), target, { force: true });
  assert.deepEqual(await fs.readFile(target), bytes);
});

test('download publication never overwrites a file created during the HTTP request without --force', async (t) => {
  const directory = await temp(t);
  const bytes = Buffer.from('downloaded fixture');
  const target = path.join(directory, 'tiny.gguf');
  const server = http.createServer(async (req, res) => {
    await fs.writeFile(target, 'file created during download');
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const item = component(bytes, `http://127.0.0.1:${server.address().port}/tiny.gguf`);
  await assert.rejects(downloadComponent(item, target), /already exists.*--force/);
  assert.equal(await fs.readFile(target, 'utf8'), 'file created during download');
  assert.deepEqual(await fs.readFile(`${target}.part`), bytes);
});

test('downloads refuse dangling target and partial links before contacting HTTP', async (t) => {
  const directory = await temp(t);
  const bytes = Buffer.from('fixture');
  const server = await fakeServer(t, bytes);
  const item = component(bytes, server.url);
  const target = path.join(directory, 'linked.gguf');
  await fs.symlink(path.join(directory, 'missing target'), target, 'junction');
  await assert.rejects(downloadComponent(item, target), /already exists.*--force/);
  await assert.rejects(downloadComponent(item, target, { force: true }), /Refusing linked download target/);
  const partialTarget = path.join(directory, 'partial.gguf');
  await fs.symlink(path.join(directory, 'missing partial'), `${partialTarget}.part`, 'junction');
  await assert.rejects(downloadComponent(item, partialTarget), /Refusing linked partial download/);
  assert.equal(server.ranges.length, 0);
});

test('tiny zip archives extract into staging and refuse links, traversal, and existing files', async (t) => {
  const directory = await temp(t);
  const zip = new AdmZip();
  zip.addFile('release/bin/sd-cli.exe', Buffer.from('fake executable'));
  const archive = path.join(directory, 'tiny.zip');
  await fs.writeFile(archive, zip.toBuffer());
  const extracted = path.join(directory, 'extracted');
  await extractArchive(archive, extracted);
  assert.equal(await fs.readFile(path.join(extracted, 'release', 'bin', 'sd-cli.exe'), 'utf8'), 'fake executable');
  await assert.rejects(extractArchive(archive, extracted), /not empty/);
  const bad = new AdmZip();
  bad.addFile('unsafe.txt', Buffer.from('bad'));
  bad.getEntries()[0].entryName = '../outside.txt';
  const badArchive = path.join(directory, 'bad.zip');
  await fs.writeFile(badArchive, bad.toBuffer());
  await assert.rejects(extractArchive(badArchive, path.join(directory, 'bad extract')), /Unsafe archive entry/);
  const linked = new AdmZip();
  linked.addFile('linked', Buffer.from('../outside'));
  linked.getEntries()[0].header.attr = (0o120777 << 16) >>> 0;
  const linkedArchive = path.join(directory, 'linked.zip');
  await fs.writeFile(linkedArchive, linked.toBuffer());
  await assert.rejects(extractArchive(linkedArchive, path.join(directory, 'linked extract')), /link or special file/);
});

test('tar archives accept standard current-directory prefixes while refusing parent traversal', async (t) => {
  const directory = await temp(t);
  const archive = path.join(directory, 'tiny.tar.gz');
  await fs.writeFile(archive, 'tiny fixture handled by the injected tar extractor');
  const destination = path.join(directory, 'extracted');
  const calls = [];
  await extractArchive(archive, destination, { commandRunner: async (command, args) => {
    calls.push(args[0]);
    if (args[0] === '-tf') return { stdout: './release/\n./release/sd-cli\n' };
    if (args[0] === '-tvf') return { stdout: 'drwxr-xr-x user/group 0 date ./release/\n-rwxr-xr-x user/group 4 date ./release/sd-cli\n' };
    await fs.mkdir(path.join(destination, 'release'), { recursive: true });
    await fs.writeFile(path.join(destination, 'release', 'sd-cli'), 'fake binary');
    return { stdout: '' };
  } });
  assert.deepEqual(calls, ['-tf', '-tvf', '-xf']);
  assert.equal(await fs.readFile(path.join(destination, 'release', 'sd-cli'), 'utf8'), 'fake binary');
  let extracted = false;
  await assert.rejects(extractArchive(archive, path.join(directory, 'unsafe tar'), { commandRunner: async (command, args) => {
    if (args[0] === '-tf') return { stdout: './release/../../outside\n' };
    if (args[0] === '-tvf') return { stdout: '-rwxr-xr-x user/group 4 date ./release/../../outside\n' };
    extracted = true;
    return { stdout: '' };
  } }), /Unsafe archive entry/);
  assert.equal(extracted, false);
});

test('sd-cli setup extracts local fake archives and preserves existing binaries without --force', async (t) => {
  const directory = await temp(t);
  const zip = new AdmZip();
  zip.addFile('release/sd-cli.exe', Buffer.from('fake sd-cli'));
  const bytes = zip.toBuffer();
  const server = await fakeServer(t, bytes);
  const data = manifest(component(bytes, server.url.replace('tiny.gguf', 'tiny.zip')));
  // The runtime-library fixture is raw bytes in a different destination, avoiding a binary collision.
  data.components.cudart.destination = 'runtime/sd-cli/cuda';
  const manifestPath = await writeManifest(directory, data);
  const options = { repoRoot: directory, env: {}, manifestPath, yes: true, acceptLicenses: ['Test fixture license'], log: () => {} };
  await runSetup('sdcli', options);
  const binary = path.join(directory, 'local', 'runtime', 'sd-cli', 'sd-cli.exe');
  assert.equal(await fs.readFile(binary, 'utf8'), 'fake sd-cli');
  await fs.writeFile(binary, 'existing binary');
  await assert.rejects(runSetup('sdcli', options), /already exists.*--force/);
  assert.equal(await fs.readFile(binary, 'utf8'), 'existing binary');
  await runSetup('sdcli', { ...options, force: true });
  assert.equal(await fs.readFile(binary, 'utf8'), 'fake sd-cli');
});

test('portable .7z requires a detected 7-Zip or bsdtar and supplies explicit installation guidance', async () => {
  await assert.rejects(detect7zExtractor({ commandRunner: async () => { throw new Error('not installed'); }, platform: 'win32' }), /requires 7-Zip.*bsdtar.*does not install/);
  const selected = await detect7zExtractor({ commandRunner: async (command) => {
    if (command === 'bsdtar') return { stdout: 'bsdtar 3.7 fixture' };
    throw new Error('not installed');
  }, platform: 'linux' });
  assert.deepEqual(selected, { command: 'bsdtar', type: 'tar' });
});

test('portable .7z entry listing is validated before the injected extractor runs', async (t) => {
  const directory = await temp(t);
  const archive = path.join(directory, 'tiny.7z');
  await fs.writeFile(archive, 'fake archive handled by injected extractor');
  const destination = path.join(directory, 'extracted');
  const calls = [];
  await extractArchive(archive, destination, { extractor: { command: 'fake-7z', type: '7z' }, commandRunner: async (command, args) => {
    calls.push(args[0]);
    if (args[0] === 'l') return { stdout: 'Path = archive.7z\n----------\nPath = ComfyUI/main.py\nAttributes = A\n\n' };
    await fs.mkdir(path.join(destination, 'ComfyUI'), { recursive: true });
    await fs.writeFile(path.join(destination, 'ComfyUI', 'main.py'), 'fake python');
    return { stdout: '' };
  } });
  assert.deepEqual(calls, ['l', 'x']);
  let extracted = false;
  await assert.rejects(extractArchive(archive, path.join(directory, 'unsafe'), { extractor: { command: 'fake-7z', type: '7z' }, commandRunner: async (command, args) => {
    if (args[0] === 'l') return { stdout: 'Path = archive.7z\n----------\nPath = ../outside.py\nAttributes = A\n\n' };
    extracted = true;
    return { stdout: '' };
  } }), /Unsafe archive entry/);
  assert.equal(extracted, false);
});

test('ComfyUI setup installs two tiny local archives and invokes only an injected embedded Python', async (t) => {
  const directory = await temp(t);
  const portableZip = new AdmZip();
  portableZip.addFile('portable/ComfyUI/main.py', Buffer.from('fake ComfyUI'));
  portableZip.addFile('portable/python_embeded/python.exe', Buffer.from('fake embedded interpreter'));
  portableZip.addFile('portable/ComfyUI/extra_model_paths.yaml.example', Buffer.from('comfyui:\n  base_path: path/to/comfyui\n  diffusion_models: models/diffusion_models/\n'));
  const nodeZip = new AdmZip();
  nodeZip.addFile('gguf-pinned/requirements.txt', Buffer.from('fake fixture requirement'));
  nodeZip.addFile('gguf-pinned/__init__.py', Buffer.from('fake node'));
  const buffers = { '/portable.zip': portableZip.toBuffer(), '/node.zip': nodeZip.toBuffer() };
  const requests = [];
  const server = http.createServer((req, res) => { requests.push(req.url); res.end(buffers[req.url]); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const data = manifest(component(buffers['/portable.zip'], `${url}/portable.zip`));
  data.components['comfyui-gguf-node'] = component(buffers['/node.zip'], `${url}/node.zip`, {
    commit: 'a'.repeat(40), destination: 'runtime/comfyui/ComfyUI/custom_nodes/ComfyUI-GGUF',
  });
  const manifestPath = await writeManifest(directory, data);
  const launched = [];
  await runSetup('comfyui', { repoRoot: directory, env: {}, manifestPath, yes: true,
    acceptLicenses: ['Test fixture license'], log: () => {}, dependencies: {
      runCommand: async (...args) => { launched.push(args); return { stdout: '' }; },
    },
  });
  assert.deepEqual(requests, ['/portable.zip', '/node.zip']);
  assert.equal(launched.length, 1);
  assert.match(launched[0][0], /python_embeded[\\/]python\.exe$/);
  assert.deepEqual(launched[0][1].slice(0, 5), ['-s', '-m', 'pip', 'install', '-r']);
  const comfyRoot = path.join(directory, 'local', 'runtime', 'comfyui', 'ComfyUI');
  assert.equal(await fs.readFile(path.join(comfyRoot, 'main.py'), 'utf8'), 'fake ComfyUI');
  assert.match(await fs.readFile(path.join(comfyRoot, 'extra_model_paths.yaml'), 'utf8'), /diffusion_models: "diffusion_models"/);
});

test('ComfyUI YAML uses installed example model key names and does not overwrite without --force', async (t) => {
  const directory = await temp(t);
  const localDir = path.join(directory, 'local');
  const comfyRoot = path.join(localDir, 'runtime', 'comfyui', 'ComfyUI');
  await fs.mkdir(comfyRoot, { recursive: true });
  await fs.writeFile(path.join(comfyRoot, 'extra_model_paths.yaml.example'), [
    'comfyui:', '  base_path: path/to/comfyui/', '  checkpoints: models/checkpoints/',
    '  text_encoders: |', '    models/text_encoders/', '  diffusion_models: |',
    '    models/diffusion_models/', '    models/unet/',
    '  unusual_installed_key: models/custom_kind/',
  ].join('\n'));
  const target = await writeExtraModelPaths(comfyRoot, localDir);
  const yaml = await fs.readFile(target, 'utf8');
  assert.match(yaml, /text_encoders: "text_encoders"/);
  assert.match(yaml, /unusual_installed_key: "custom_kind"/);
  assert.match(yaml, /diffusion_models: \|\n    diffusion_models\n    unet/);
  assert.ok(yaml.includes(path.join(localDir, 'models').replace(/\\/g, '/')));
  assert.doesNotMatch(yaml, /  clip:/);
  await assert.rejects(writeExtraModelPaths(comfyRoot, localDir), /already exists.*--force/);
  await writeExtraModelPaths(comfyRoot, localDir, { force: true });
  await fs.rm(path.join(comfyRoot, 'extra_model_paths.yaml.example'));
  await assert.rejects(writeExtraModelPaths(comfyRoot, localDir, { force: true }), /cannot infer ComfyUI model keys/);
});

test('GGUF requirements install uses portable embedded Python with argv and no shell', async (t) => {
  const directory = await temp(t);
  const portable = path.join(directory, 'runtime', 'comfyui');
  const node = path.join(portable, 'ComfyUI', 'custom_nodes', 'ComfyUI-GGUF');
  await fs.mkdir(path.join(portable, 'python_embeded'), { recursive: true });
  await fs.mkdir(node, { recursive: true });
  await fs.writeFile(path.join(portable, 'python_embeded', 'python.exe'), 'fake python');
  await fs.writeFile(path.join(node, 'requirements.txt'), 'fake requirement');
  const calls = [];
  await installGgufRequirements(directory, node, { commandRunner: async (...args) => { calls.push(args); return { stdout: '' }; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], path.join(portable, 'python_embeded', 'python.exe'));
  assert.deepEqual(calls[0][1], ['-s', '-m', 'pip', 'install', '-r', path.join(node, 'requirements.txt')]);
  assert.equal(calls[0][2].cwd, node);
});

test('setup CLI parses consent and machine manifest flags while rejecting unknown arguments', () => {
  const parsed = parseArgs(['models', '--yes', '--force', '--manifest=machine.json', '--accept-license', 'License A', '--accept-license=License B']);
  assert.equal(parsed.command, 'models');
  assert.equal(parsed.options.yes, true);
  assert.equal(parsed.options.force, true);
  assert.deepEqual(parsed.options.acceptLicenses, ['License A', 'License B']);
  assert.equal(parsed.options.manifestPath, path.resolve('machine.json'));
  assert.throws(() => parseArgs(['models', '--accept-license']), /requires a value/);
  assert.throws(() => parseArgs(['models', '--download']), /Unknown setup option/);
  assert.throws(() => parseArgs(['models', '--yes=false']), /does not accept a value/);
});

test('setup containment rejects filesystem traversal before installation', async (t) => {
  const directory = await temp(t);
  assert.throws(() => assertContained(path.join(directory, 'local'), path.join(directory, 'outside')), /escapes local directory/);
  assert.equal(assertContained(directory, path.join(directory, 'local', 'models')), path.join(directory, 'local', 'models'));
  const localDir = path.join(directory, 'local');
  const externalDir = path.join(directory, 'external');
  await fs.mkdir(localDir);
  await fs.mkdir(externalDir);
  await fs.symlink(externalDir, path.join(localDir, 'models'), 'junction');
  assert.throws(() => assertContained(localDir, path.join(localDir, 'models', 'new.gguf')), /link outside local directory/);
});
