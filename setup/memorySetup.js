import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLocalPaths } from '../server/selfie/localPaths.js';
import { atomicWrite } from '../server/settings/files.js';
import { runCommand, diskSpace, assertContained } from './install.js';
import { acquireSetupLock, assertRuntimeIdle } from './setupLock.js';
import { detectGpuVendor } from './hardware.js';

export const MEMORY_MODEL = 'BAAI/bge-m3';
export const MEMORY_MODEL_TAG = 'bge-m3-d768';
export const MEMORY_DIMENSIONS = 768;
export const MEMORY_SETUP_LICENSES = [
  { id: 'bge-m3', name: 'MIT', url: 'https://huggingface.co/BAAI/bge-m3/blob/main/README.md' },
  { id: 'pytorch', name: 'BSD 3-Clause', url: 'https://github.com/pytorch/pytorch/blob/main/LICENSE' },
  { id: 'transformers', name: 'Apache 2.0', url: 'https://github.com/huggingface/transformers/blob/main/LICENSE' },
  { id: 'huggingface-hub', name: 'Apache 2.0', url: 'https://github.com/huggingface/huggingface_hub/blob/main/LICENSE' },
];
const REQUIRED_MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json'];
const SERVICE_SOURCE = fileURLToPath(new URL('../server/embedding/service.py', import.meta.url));
const INSTALL_SOURCE = fileURLToPath(new URL('../server/embedding/install_model.py', import.meta.url));
const GiB = 1024 ** 3;

const failure = code => Object.assign(new Error(code), { code });
const regularFile = filename => { try { const stat = fs.lstatSync(filename); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; } };
const hash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const jsonFile = filename => { try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return null; } };

export function memoryPaths(paths = createLocalPaths(), platform = process.platform) {
  const runtimeDir = assertContained(paths.localDir, paths.runtimeDir('memory'));
  const modelDir = assertContained(paths.localDir, paths.modelsDir('embeddings/bge-m3'));
  return { localDir: paths.localDir, repoRoot: paths.repoRoot, runtimeDir, modelDir,
    pythonPath: path.join(runtimeDir, 'venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    servicePath: path.join(runtimeDir, 'service.py'), markerPath: path.join(runtimeDir, 'installed.json'),
    progressPath: path.join(runtimeDir, 'installing.json'), processPath: path.join(runtimeDir, 'process.json') };
}

export function inspectMemoryInstallation(paths = createLocalPaths(), { platform = process.platform } = {}) {
  const resolved = memoryPaths(paths, platform);
  const marker = jsonFile(resolved.markerPath);
  const missing = [resolved.pythonPath, resolved.servicePath].filter(filename => !regularFile(filename))
    .map(filename => path.relative(resolved.runtimeDir, filename).replace(/\\/g, '/'));
  const markerValid = marker?.version === 1 && marker.model === MEMORY_MODEL && marker.tag === MEMORY_MODEL_TAG
    && marker.dimensions === MEMORY_DIMENSIONS && /^[a-f0-9]{40}$/.test(marker.modelRevision ?? '')
    && Array.isArray(marker.files) && REQUIRED_MODEL_FILES.every(name => marker.files.some(file => file.path === name))
    && (marker.files.some(file => ['model.safetensors', 'pytorch_model.bin'].includes(file.path))
      || marker.files.some(file => ['model.safetensors.index.json', 'pytorch_model.bin.index.json'].includes(file.path))
      && marker.files.some(file => /^(?:model|pytorch_model)-[0-9]+-of-[0-9]+\.(?:safetensors|bin)$/.test(file.path)))
    && marker.files.length <= 80 && /^[a-f0-9]{64}$/.test(marker.serviceSha256 ?? '');
  let invalid = !markerValid;
  if (markerValid) {
    for (const file of marker.files) {
      if (!file || typeof file.path !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(file.path)
        || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0 || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) { invalid = true; break; }
      const filename = path.join(resolved.modelDir, file.path);
      if (!regularFile(filename) || fs.statSync(filename).size !== file.sizeBytes) { invalid = true; break; }
    }
  }
  const modelPresent = markerValid && !invalid;
  const servicePresent = markerValid && regularFile(resolved.servicePath)
    && hash(resolved.servicePath) === marker.serviceSha256;
  const serviceCurrent = servicePresent && hash(resolved.servicePath) === hash(SERVICE_SOURCE);
  if (!serviceCurrent) invalid = true;
  return { ...resolved, marker, valid: missing.length === 0 && !invalid,
    code: missing.length ? 'MEMORY_SETUP_REQUIRED' : invalid ? 'MEMORY_INSTALL_INVALID' : 'READY',
    missing, modelPresent, servicePresent, serviceCurrent, interrupted: regularFile(resolved.progressPath) };
}

async function verifyCachedModel(status, signal) {
  if (!status.modelPresent) return false;
  for (const file of status.marker.files) {
    signal?.throwIfAborted();
    const digest = createHash('sha256');
    const stream = fs.createReadStream(path.join(status.modelDir, file.path), { highWaterMark: 1024 * 1024, signal });
    for await (const chunk of stream) digest.update(chunk);
    if (digest.digest('hex') !== file.sha256) return false;
  }
  return true;
}

/** Stream large weights so verification cannot allocate a model-sized Buffer. */
export async function verifyMemoryInstallation(paths = createLocalPaths(), { platform = process.platform, signal } = {}) {
  const status = inspectMemoryInstallation(paths, { platform });
  if (!status.valid) return status;
  return await verifyCachedModel(status, signal) ? status : { ...status, valid: false, code: 'MEMORY_INSTALL_INVALID' };
}

export async function detectMemoryPython({ python, platform = process.platform, commandRunner = runCommand, signal } = {}) {
  const candidates = python ? [{ command: python, args: [] }] : platform === 'win32'
    ? [{ command: 'py', args: ['-3.11'] }, { command: 'python', args: [] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    try {
      const result = await commandRunner(candidate.command, [...candidate.args, '-c',
        'import sys,json;print(json.dumps({"major":sys.version_info.major,"minor":sys.version_info.minor}))'], { signal });
      const version = JSON.parse(result.stdout.trim());
      if (version.major === 3 && version.minor >= 11) return { ...candidate, version: `3.${version.minor}` };
    } catch { signal?.throwIfAborted(); }
  }
  return null;
}

export async function planMemorySetup({ paths = createLocalPaths(), platform = process.platform, python,
  device = 'auto', signal, commandRunner = runCommand, gpuDetector = detectGpuVendor, spaceProbe = diskSpace } = {}) {
  if (!['auto', 'cpu', 'cuda'].includes(device)) throw failure('INVALID_MEMORY_DEVICE');
  let installed = inspectMemoryInstallation(paths, { platform });
  const cachedModel = await verifyCachedModel(installed, signal);
  if (installed.valid && !cachedModel) installed = { ...installed, valid: false, code: 'MEMORY_INSTALL_INVALID' };
  const interpreter = await detectMemoryPython({ python, platform, commandRunner, signal });
  const vendor = device === 'auto' ? await gpuDetector({ commandRunner, platform }) : null;
  const wheel = device === 'cuda' || device === 'auto' && (vendor === 'nvidia' || vendor?.gpuVendor === 'nvidia') ? 'cu128' : 'cpu';
  const needsEnvironment = !regularFile(installed.pythonPath) || !installed.marker?.packages?.torch;
  const requiredBytes = installed.valid ? 0 : Math.ceil((needsEnvironment ? (wheel === 'cpu' ? 2 : 8) : 1)
    + (cachedModel ? 0 : 4)) * GiB;
  const disk = spaceProbe(installed.localDir);
  const blockers = [...(!interpreter && !installed.valid ? ['PYTHON_311_REQUIRED'] : []),
    ...(Number.isFinite(disk.freeBytes) && disk.freeBytes < requiredBytes ? ['INSUFFICIENT_DISK'] : [])];
  return { provider: 'localBge', model: MEMORY_MODEL, tag: MEMORY_MODEL_TAG, dimensions: MEMORY_DIMENSIONS,
    ready: installed.valid, interrupted: installed.interrupted, device, wheel, modelBytes: 2300000000,
    requiredBytes, freeBytes: disk.freeBytes, licenses: MEMORY_SETUP_LICENSES, blockers,
    components: installed.valid ? [] : [
      ...(needsEnvironment ? [{ id: 'python-environment', estimatedBytes: (wheel === 'cpu' ? 1 : 5) * GiB }] : []),
      ...(!cachedModel ? [{ id: 'bge-m3', estimatedBytes: 2300000000 }] : []),
      ...(!installed.serviceCurrent ? [{ id: 'memory-service', estimatedBytes: fs.statSync(SERVICE_SOURCE).size }] : []),
    ], interpreter, installed, cachedModel, needsEnvironment };
}

function assertOwnedProcessStopped(filename, alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }) {
  if (!fs.existsSync(filename)) return;
  const record = jsonFile(filename);
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0) throw failure('MEMORY_PROCESS_UNKNOWN');
  if (alive(record.pid)) throw failure('MEMORY_SERVICE_RUNNING');
}

/** Only this explicitly invoked operation can install packages or download weights. */
export async function installMemorySetup({ acceptedLicenses = [], log = () => {}, ...options } = {}) {
  const plan = await planMemorySetup(options);
  if (plan.ready) return { ready: true, reused: true, code: 'READY' };
  if (plan.blockers.length) throw failure(plan.blockers[0]);
  if (MEMORY_SETUP_LICENSES.some(license => !acceptedLicenses.includes(license.id))) throw failure('LICENSE_ACCEPTANCE_REQUIRED');
  const { paths = createLocalPaths(), commandRunner = runCommand, signal, platform = process.platform } = options;
  const installed = plan.installed;
  const release = await acquireSetupLock(paths.localDir, { signal });
  try {
    await assertRuntimeIdle(paths.localDir, { repoRoot: paths.repoRoot });
    assertOwnedProcessStopped(installed.processPath, options.pidAlive);
    signal?.throwIfAborted();
    if (fs.existsSync(installed.runtimeDir) && !installed.interrupted && !installed.marker
      && fs.readdirSync(installed.runtimeDir).length) throw failure('MEMORY_INSTALL_UNOWNED');
    fs.mkdirSync(installed.runtimeDir, { recursive: true });
    fs.mkdirSync(installed.modelDir, { recursive: true });
    const publishStage = stage => {
      signal?.throwIfAborted();
      atomicWrite(installed.progressPath, JSON.stringify({ version: 1, stage, startedAt: new Date().toISOString(), pid: process.pid }));
      log(stage);
    };
    publishStage('Preparing isolated Python environment');
    if (!regularFile(installed.pythonPath)) await commandRunner(plan.interpreter.command,
      [...plan.interpreter.args, '-m', 'venv', path.join(installed.runtimeDir, 'venv')], { signal, timeout: 120000 });
    if (plan.needsEnvironment) {
      publishStage('Installing pinned embedding dependencies');
      await commandRunner(installed.pythonPath, ['-m', 'pip', 'install', '--only-binary=:all:',
        'torch==2.10.0', '--index-url', `https://download.pytorch.org/whl/${plan.wheel}`], { signal, timeout: 1800000 });
      await commandRunner(installed.pythonPath, ['-m', 'pip', 'install', '--only-binary=:all:',
        'transformers==5.22.0', 'huggingface_hub==1.33.0', 'safetensors>=0.4.3,<1', 'sentencepiece>=0.2,<1'],
      { signal, timeout: 1800000 });
    }
    let receipt = plan.cachedModel ? installed.marker : null;
    if (!receipt) {
      publishStage('Downloading and verifying the pinned official model snapshot');
      const response = await commandRunner(installed.pythonPath, [INSTALL_SOURCE, '--model-dir', installed.modelDir,
        ...(installed.marker?.modelRevision ? ['--revision', installed.marker.modelRevision] : [])],
      { signal, timeout: 3600000 });
      try { receipt = JSON.parse(response.stdout.trim().split(/\r?\n/).at(-1)); }
      catch { throw failure('MEMORY_MODEL_RECEIPT_INVALID'); }
    }
    if (!/^[a-f0-9]{40}$/.test(receipt.modelRevision ?? '') || !Array.isArray(receipt.files)) throw failure('MEMORY_MODEL_RECEIPT_INVALID');
    publishStage('Publishing verified runtime');
    if (regularFile(installed.servicePath) && hash(installed.servicePath) !== hash(SERVICE_SOURCE)
      && installed.marker?.serviceSha256 !== hash(installed.servicePath)) throw failure('MEMORY_SERVICE_FILE_UNOWNED');
    atomicWrite(installed.servicePath, fs.readFileSync(SERVICE_SOURCE));
    atomicWrite(installed.markerPath, JSON.stringify({ version: 1, model: MEMORY_MODEL, tag: MEMORY_MODEL_TAG,
      dimensions: MEMORY_DIMENSIONS, modelRevision: receipt.modelRevision, files: receipt.files,
      packages: receipt.packages, wheel: plan.wheel, serviceSha256: hash(SERVICE_SOURCE),
      installedAt: new Date().toISOString(), licenses: acceptedLicenses }));
    if (!(await verifyMemoryInstallation(paths, { platform, signal })).valid) throw failure('MEMORY_INSTALL_INVALID');
    fs.unlinkSync(installed.progressPath);
    return { ready: true, reused: false, code: 'READY', modelRevision: receipt.modelRevision };
  } finally { await release(); }
}
