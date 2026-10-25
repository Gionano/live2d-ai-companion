import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadSelfieConfig } from '../server/selfie/config.js';
import { ROOT_DIR, createLocalPaths, deepMerge, resolveSelfiePaths, resolveManagedPaths, inspectManagedRuntime, RUNTIME_WARNING_MESSAGES } from '../server/selfie/localPaths.js';
import { inspectSdRuntime } from '../server/selfie/runtimeValidity.js';
import { parseSdCppDevices } from '../server/selfie/providers/sdcppProvider.js';
import { readManifest, validateManifest, listComponents, isPlaceholder, selectComponents, validatePlanRoles, ENGINE_NAMES } from './manifest.js';
import { diskSpace, licenseKey } from './install.js';
import { detectGpuVendor } from './hardware.js';

const execFileAsync = promisify(execFile);
const MODEL_KEYS = ['diffusionModel', 'vae', 'llm', 'llmVision'];
const GB = 1024 ** 3;
const WINDOWS_COMMIT_PROBE = '$doctorMemory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory; '
  + '[pscustomobject]@{commitLimitBytes=[double]$doctorMemory.CommitLimit; '
  + 'commitUsedBytes=[double]$doctorMemory.CommittedBytes} | ConvertTo-Json -Compress';

function numericBytes(value) {
  if (value == null || typeof value === 'boolean' || typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeCommit(system) {
  const limit = numericBytes(system.commitLimitBytes);
  const used = numericBytes(system.commitUsedBytes);
  const known = limit !== null && limit > 0 && used !== null && used <= limit;
  return { ...system, commitLimitBytes: known ? limit : null, commitUsedBytes: known ? used : null };
}

/** Offline, bounded probes: never spawn a server or invoke a shell. */
export async function probeCommand(command, args, { timeoutMs = 15000, ...options } = {}) {
  const result = await execFileAsync(command, args, {
    windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, ...options,
  });
  return { code: 0, ...result };
}

export async function probeSystem({ localDir, commandRunner = probeCommand, platform = process.platform }) {
  const result = {
    ...diskSpace(localDir), totalRamBytes: os.totalmem(), freeRamBytes: os.freemem(),
    commitLimitBytes: null, commitUsedBytes: null,
  };
  try {
    if (platform === 'win32') {
      const probe = await commandRunner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_COMMIT_PROBE], { timeoutMs: 5000 });
      const value = JSON.parse(probe.stdout.trim());
      result.commitLimitBytes = numericBytes(value.commitLimitBytes);
      result.commitUsedBytes = numericBytes(value.commitUsedBytes);
    } else if (platform === 'linux') {
      const value = await fsp.readFile('/proc/meminfo', 'utf8');
      const field = name => Number(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, 'm').exec(value)?.[1]) * 1024;
      result.commitLimitBytes = field('CommitLimit');
      result.commitUsedBytes = field('Committed_AS');
      const available = field('MemAvailable');
      if (Number.isFinite(available)) result.freeRamBytes = available;
    }
  } catch { /* An unavailable system counter is reported below, not fatal. */ }
  for (const key of ['commitLimitBytes', 'commitUsedBytes']) {
    if (!Number.isFinite(result[key]) || result[key] < 0) result[key] = null;
  }
  return normalizeCommit(result);
}

async function stat(filename) {
  if (!filename) return null;
  try { return await fsp.stat(filename); } catch { return null; }
}

function groupFor(id) {
  return id.startsWith('models[') ? 'models' : id === 'sd-cli' || id.startsWith('sd-cli:') || id === 'cudart' ? 'sdcli' : 'comfyui';
}

function setupFix(group, components, validation, force = false, manifestFlag = '', { engine, variant } = {}) {
  if (!validation.valid) return `Edit the reported manifest to replace its TODO/invalid metadata; then run npm run setup:plan${manifestFlag ? ` --${manifestFlag}` : ''}`;
  const licenses = [...new Set(components.filter(component => groupFor(component.id) === group
    && (!engine || !component.engines || component.engines.includes(engine))
    && (!variant || !component.variant || component.variant === variant)).map(component => component.licenseName))];
  return `npm run setup:${group} -- --yes${force ? ' --force' : ''}${licenses.map(license => ` --accept-license ${JSON.stringify(license)}`).join('')}${engine ? ` --engine ${engine}` : ''}${variant ? ` --variant ${variant}` : ''}${manifestFlag}`;
}

async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

function sameMetadata(field, saved, expected) {
  if (field === 'engines') return Array.isArray(saved) && JSON.stringify([...saved].sort()) === JSON.stringify([...(expected || [])].sort());
  if (field === 'sha256') return String(saved || '').toLowerCase() === String(expected || '').toLowerCase();
  if (field === 'destination') return String(saved || '').replace(/\\/g, '/') === String(expected || '').replace(/\\/g, '/');
  return saved === expected;
}

function bytes(value) {
  return Number.isFinite(value) ? `${value.toLocaleString('en-US')} bytes (${(value / GB).toFixed(2)} GiB)` : 'unknown';
}

/** Size and basename are duplicate candidates; this is deliberately not a hash claim. */
async function findDuplicates(roots) {
  const visited = new Set();
  const files = new Map();
  const failures = [];
  const visit = async directory => {
    let realDirectory;
    try { realDirectory = await fsp.realpath(directory); } catch { return; }
    const directoryKey = process.platform === 'win32' ? realDirectory.toLowerCase() : realDirectory;
    if (visited.has(directoryKey)) return;
    visited.add(directoryKey);
    let entries;
    try { entries = await fsp.readdir(realDirectory, { withFileTypes: true }); }
    catch (error) { failures.push(`${realDirectory}: ${error.message}`); return; }
    for (const entry of entries) {
      const filename = path.join(realDirectory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        const info = await stat(filename);
        if (info?.isDirectory()) { await visit(filename); continue; }
        if (!info?.isFile()) continue;
        const key = `${entry.name.toLowerCase()}\0${info.size}`;
        if (!files.has(key)) files.set(key, { name: entry.name, sizeBytes: info.size, paths: new Set() });
        const realFile = await fsp.realpath(filename);
        files.get(key).paths.add(realFile);
      }
    }
  };
  for (const root of roots) await visit(root);
  return {
    duplicates: [...files.values()].filter(value => value.paths.size > 1)
      .map(value => ({ ...value, paths: [...value.paths].sort() })).sort((a, b) => a.name.localeCompare(b.name)),
    failures,
  };
}

export async function runDoctor({
  repoRoot = ROOT_DIR, env = process.env, manifest, config,
  manifestPath = path.join(repoRoot, 'setup', 'manifest.json'),
  probeCommand: commandRunner = probeCommand, probeSystem: systemRunner = probeSystem,
  detectGpuVendor: gpuRunner = detectGpuVendor, engine, variant, verifyHashes = false,
  platform = process.platform,
} = {}) {
  const paths = createLocalPaths({ repoRoot, env });
  const manifestFlag = path.resolve(manifestPath) === path.join(paths.repoRoot, 'setup', 'manifest.json')
    ? '' : ` --manifest ${JSON.stringify(path.resolve(manifestPath))}`;
  const checks = [];
  const add = (id, status, message, details = {}) => {
    const check = { id, status, message, ...details };
    checks.push(check);
    return check;
  };
  let validation;
  try {
    manifest ??= readManifest(manifestPath);
    validation = validateManifest(manifest);
  } catch (error) {
    manifest = { components: { models: [] } };
    validation = { valid: false, errors: [`Cannot read ${manifestPath}: ${error.message}`] };
  }
  const components = listComponents(manifest);
  add('manifest', validation.valid ? 'ok' : 'wrong', validation.valid ? 'All manifest metadata is pinned and complete.' : validation.errors.join('\n'), {
    ...(!validation.valid && { fix: `Edit ${manifestFlag ? path.resolve(manifestPath) : 'setup/manifest.json'} with verified URLs, pins, SHA-256 hashes, sizes and licenses; then run npm run setup:plan${manifestFlag ? ` --${manifestFlag}` : ''}` }),
  });
  for (const warning of validation.warnings || []) add('manifest:migration', 'warning', warning, {
    fix: `Migrate ${manifestFlag ? path.resolve(manifestPath) : 'setup/manifest.json'} to schemaVersion 2 with engines, roles, conditions and pinned variants; then run npm run setup:plan${manifestFlag ? ` --${manifestFlag}` : ''}`,
  });
  if (manifest.schemaVersion === 1 && !validation.warnings?.length) add('manifest:migration', 'warning', 'Manifest schemaVersion 1 is a legacy format; migrate to schemaVersion 2 for engine/role/variant selection.', {
    fix: `Migrate ${manifestFlag ? path.resolve(manifestPath) : 'setup/manifest.json'} to schemaVersion 2; then run npm run setup:plan${manifestFlag ? ` --${manifestFlag}` : ''}`,
  });
  let gpu;
  try { gpu = await gpuRunner({ commandRunner, platform }); }
  catch (error) { gpu = { gpuVendor: 'any', devices: [], warning: error.message }; }
  if (!gpu || !['nvidia', 'any'].includes(gpu.gpuVendor)) gpu = { gpuVendor: 'any', devices: [], warning: 'GPU vendor could not be detected.' };
  add('system:gpu', gpu.warning ? 'warning' : 'ok', `Detected GPU vendor: ${gpu.gpuVendor}; devices: ${(gpu.devices || []).join(', ') || 'none reported'}.${gpu.warning ? ` ${gpu.warning}` : ''}`, {
    ...(gpu.warning && { fix: `npm run setup:plan -- --variant vulkan${manifestFlag}` }),
  });
  let selectedIds = new Set(components.map(component => component.id));
  try {
    const selected = selectComponents(manifest, { command: 'plan', engine, variant, gpuVendor: gpu.gpuVendor, os: platform });
    selectedIds = new Set(selected.map(component => component.id));
    if (manifest.schemaVersion === 2) {
      for (const message of validatePlanRoles(selected, { engines: engine ? [engine] : ENGINE_NAMES }).errors) {
        add('manifest:required-role', 'wrong', message, { fix: `Restore the required role in the manifest; then run npm run setup:plan${manifestFlag ? ` --${manifestFlag}` : ''}` });
      }
    }
  } catch (error) {
    add('selection', 'wrong', error.message, { fix: `npm run setup:plan${manifestFlag ? ` --${manifestFlag}` : ''}` });
  }
  let rawConfig = config;
  try {
    if (!rawConfig) {
      rawConfig = {};
      for (const filename of ['selfie.config.json', 'selfie.config.local.json']) {
        try { rawConfig = deepMerge(rawConfig, JSON.parse(await fsp.readFile(path.join(repoRoot, filename), 'utf8'))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      config = loadSelfieConfig({}, { repoRoot, env });
    } else config = resolveSelfiePaths(rawConfig, { repoRoot, env });
    add('config', 'ok', `Provider selection: ${config.provider || 'auto'}; local directory: ${paths.localDir}`);
  } catch (error) {
    rawConfig = {};
    config = {};
    add('config', 'wrong', error.message, { fix: 'Edit selfie.config.local.json with valid machine-specific values; then run npm run doctor' });
  }
  const fixOptions = (component = {}) => manifest.schemaVersion === 2 ? {
    engine: component.engines?.length === 1 ? component.engines[0] : engine || (groupFor(component.id || '') === 'comfyui' ? 'comfyui' : 'sdcpp'),
    variant: component.variant || (groupFor(component.id || '') === 'sdcli' ? variant : undefined),
  } : {};
  const installFix = (group, force = false, component) => setupFix(group, components, validation, force, manifestFlag,
    component ? fixOptions(component) : manifest.schemaVersion === 2 ? { engine: group === 'comfyui' ? 'comfyui' : engine || 'sdcpp', ...(group === 'sdcli' && variant && { variant }) } : {});
  let accepted = {};
  const consentPath = path.join(paths.localDir, 'accepted-licenses.json');
  try {
    accepted = JSON.parse(await fsp.readFile(consentPath, 'utf8')).licenses || {};
  } catch (error) {
    if (error.code !== 'ENOENT') add('licenses', 'wrong', `Unreadable acceptance record: ${error.message}`, {
      fix: 'Repair local/accepted-licenses.json, then rerun the setup command with --yes and its --accept-license flags',
    });
  }
  const componentChecks = [];
  for (const component of components) {
    const destination = typeof component.destination === 'string' && !isPlaceholder(component.destination)
      ? paths.resolvePath(component.destination, { baseDir: paths.localDir }) : '';
    const info = await stat(destination);
    const group = groupFor(component.id);
    const selected = selectedIds.has(component.id);
    let status = 'ok';
    let message;
    if (!destination) { status = 'wrong'; message = 'Destination is a TODO placeholder or missing.'; }
    else if (!info) { status = component.required && selected ? 'missing' : 'warning'; message = `${!selected ? 'Not selected for this engine/GPU/variant' : component.required ? 'Required' : 'Optional'} component is absent.`; }
    else if (component.id.startsWith('models[') || component.kind === 'constraints') {
      const label = component.kind === 'constraints' ? 'Constraints file' : 'Model';
      if (!info.isFile() || info.size === 0) { status = 'wrong'; message = `${label} must be a non-empty file.`; }
      else if (Number.isSafeInteger(component.sizeBytes) && info.size !== component.sizeBytes) {
        status = 'wrong'; message = `${label} size is ${info.size} bytes; expected ${component.sizeBytes}.`;
      } else message = `${label} present: ${info.size} bytes${component.sizeBytes == null ? '; expected size is TODO' : ''}.`;
    } else if (!info.isDirectory()) {
      status = 'wrong'; message = 'Runtime/custom-node destination must be a directory.';
    } else if (component.id === 'cudart') {
      const entries = await fsp.readdir(destination);
      const present = entries.some(name => /^(?:lib)?cudart.*\.(dll|so(?:\.\d+)*)$/i.test(name))
        && entries.some(name => /^(?:lib)?cublas.*\.(dll|so(?:\.\d+)*)$/i.test(name));
      status = present ? 'ok' : component.required && selected ? 'missing' : 'warning';
      message = present ? 'CUDA cudart and cublas runtime libraries present.' : 'CUDA cudart/cublas runtime libraries are absent.';
    } else message = 'Installation directory present; executable and launch checks follow.';
    componentChecks.push(add(`component:${component.id}`, status, `${component.name}: ${message}`, {
      path: destination || undefined, required: component.required, selected, componentId: component.id,
      engines: component.engines, role: component.role, variant: component.variant,
      ...(info?.isFile() && { sizeBytes: info.size }),
      ...(status !== 'ok' && { fix: installFix(group, status === 'wrong', component) }),
    }));
    if (validation.valid && !accepted[licenseKey(component)]) add(`license:${component.id}`, 'warning', `${component.licenseName} acceptance is not recorded (${component.licenseUrl}).`, {
      fix: installFix(group, false, component),
    });
  }

  let installed = { schemaVersion: 1, components: {}, activeVariants: {} };
  const installedPath = path.join(paths.localDir, 'installed.json');
  try {
    installed = JSON.parse(await fsp.readFile(installedPath, 'utf8'));
    if (installed.schemaVersion !== 1 || !installed.components || typeof installed.components !== 'object' || Array.isArray(installed.components) ||
      !installed.activeVariants || typeof installed.activeVariants !== 'object' || Array.isArray(installed.activeVariants)) throw new Error('Expected schemaVersion 1, components and activeVariants objects.');
    add('installed:record', 'ok', 'Installed download pins/checksums are recorded; archive hashes describe downloaded archives, not extracted binaries.', { path: installedPath });
  } catch (error) {
    installed = { schemaVersion: 1, components: {}, activeVariants: {} };
    add('installed:record', error.code === 'ENOENT' ? 'warning' : 'wrong', error.code === 'ENOENT'
      ? 'local/installed.json is absent; installation provenance is unrecorded.' : `Cannot read installation record: ${error.message}`, {
      path: installedPath, fix: installFix(engine === 'comfyui' ? 'comfyui' : 'sdcli', true),
    });
  }
  for (const component of components) {
    const saved = installed.components[component.id];
    const destination = typeof component.destination === 'string' && !isPlaceholder(component.destination)
      ? paths.resolvePath(component.destination, { baseDir: paths.localDir }) : '';
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) add(`installed:${component.id}:record`, 'warning',
      `${component.name}: no installed metadata entry; existing files alone do not establish the pinned version/checksum.`, {
        fix: installFix(groupFor(component.id), true, component),
      });
    else {
      const fields = ['version', 'commit', 'sha256', 'sizeBytes', 'destination', 'engines', 'role', 'variant'];
      const drift = fields.filter(field => Object.hasOwn(component, field)
        && !isPlaceholder(component[field]) && component[field] != null && !sameMetadata(field, saved[field], component[field]));
      add(`installed:${component.id}:metadata`, drift.length ? 'wrong' : 'ok', drift.length
        ? `${component.name}: installed metadata drift in ${drift.join(', ')}.`
        : `${component.name}: recorded pin ${saved.commit || saved.version || 'unknown'} and download SHA-256 ${saved.sha256 || 'unknown'} match available manifest metadata.`, {
        ...(drift.length && { fix: installFix(groupFor(component.id), true, component) }),
      });
      if (Array.isArray(saved.files) && !component.id.startsWith('models[') && component.kind !== 'constraints') {
        for (const [index, file] of saved.files.entries()) {
          const filename = typeof file === 'string' ? path.resolve(destination, file) : '';
          const relative = filename && path.relative(destination, filename);
          if (!filename || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
            add(`installed:${component.id}:file:${index}`, 'wrong', 'Installed file record contains an invalid path.', { fix: installFix(groupFor(component.id), true, component) });
            continue;
          }
          const info = await stat(filename);
          if (!info?.isFile()) add(`installed:${component.id}:file:${index}`, 'missing', `Recorded installed file is absent: ${file}`, {
            path: filename, fix: installFix(groupFor(component.id), true, component),
          });
          else {
            const fingerprint = saved.fileHashes?.[file];
            if (Number.isSafeInteger(fingerprint?.sizeBytes) && info.size !== fingerprint.sizeBytes) {
              add(`installed:${component.id}:file:${index}:size`, 'wrong', `Installed file size drift: ${file} has ${info.size} bytes; recorded ${fingerprint.sizeBytes}.`, {
                path: filename, fix: installFix(groupFor(component.id), true, component),
              });
            }
            if (verifyHashes && /^[a-f0-9]{64}$/i.test(fingerprint?.sha256 || '')) {
              const actual = await hashFile(filename);
              const matches = actual.toLowerCase() === fingerprint.sha256.toLowerCase();
              add(`installed:${component.id}:file:${index}:checksum`, matches ? 'ok' : 'wrong', matches
                ? `Installed file SHA-256 matches: ${file}` : `Installed file SHA-256 drift: ${file}`, {
                path: filename, ...(!matches && { fix: installFix(groupFor(component.id), true, component) }),
              });
            }
          }
        }
      }
      if (component.id === 'comfyui-gguf-node' && saved.pip?.skipped) add('installed:comfyui-gguf-node:pip', 'warning',
        'ComfyUI-GGUF pip requirements were skipped; install them with the recorded embedded-Python command before using the node.', {
          fix: installFix('comfyui', true, component), command: saved.pip.command, args: saved.pip.args,
        });
    }
    if ((component.kind === 'constraints' || verifyHashes && component.id.startsWith('models['))
      && /^[a-f0-9]{64}$/i.test(component.sha256 || '') && (await stat(destination))?.isFile()) {
      const actual = await hashFile(destination);
      add(`installed:${component.id}:checksum`, actual.toLowerCase() === component.sha256.toLowerCase() ? 'ok' : 'wrong',
        actual.toLowerCase() === component.sha256.toLowerCase() ? `${component.name}: current file SHA-256 matches.` : `${component.name}: current file SHA-256 checksum mismatch.`, {
        path: destination, ...(actual.toLowerCase() !== component.sha256.toLowerCase() && { fix: installFix(groupFor(component.id), true, component) }),
      });
    }
  }
  for (const id of Object.keys(installed.components)) if (!components.some(component => component.id === id)) add(`installed:${id}:orphan`, 'warning',
    `Installed entry ${id} is no longer present in the current manifest.`, {
      fix: 'Reconcile the obsolete entry in local/installed.json with your current manifest; then run npm run doctor',
    });

  const providers = [];
  const sd = { ...(config.sdcpp || {}) };
  const sdLocal = await inspectSdRuntime(paths, { probeCommand: commandRunner, env, timeoutMs: 5000 });
  const sdLegacy = sd._legacyBinaryPath || paths.resolvePath(rawConfig.sdcpp?.binaryPath, { baseDir: rawConfig.sdcppBaseDir || (rawConfig.userDataDir
    ? path.join(paths.resolvePath(rawConfig.userDataDir), 'models', 'sdcpp') : paths.repoRoot) });
  const sdFallback = sdLocal.exists && !sdLocal.valid && Boolean(sdLegacy);
  sd.binaryPath = sdLocal.valid ? sdLocal.binaryPath : sdLegacy || sdLocal.binaryPath;
  const sdComponent = components.find(component => component.id === `sd-cli:${sdLocal.variant || variant}`)
    || components.find(component => selectedIds.has(component.id) && (component.id === 'sd-cli' || component.id.startsWith('sd-cli:')));
  const sdFix = force => installFix('sdcli', force, sdComponent);
  const sdChecks = [];
  if (sdFallback) sdChecks.push(add('sdcpp:local-runtime', 'warning', `PROMINENT WARNING: ${RUNTIME_WARNING_MESSAGES.LOCAL_SDCLI_RUNTIME_FALLBACK} ${sdLocal.message}`, {
    path: sdLocal.binaryPath || sdLocal.runtimeDir, code: 'LOCAL_SDCLI_RUNTIME_FALLBACK', fix: sdFix(true),
  }));
  else if (!sdLocal.valid && !sdLegacy) sdChecks.push(add('sdcpp:local-runtime', sdLocal.selectionRequired || sdLocal.exists ? 'wrong' : 'missing', sdLocal.message, {
    path: sdLocal.binaryPath || sdLocal.runtimeDir, code: sdLocal.code, fix: sdFix(!!sdLocal.exists),
  }));
  else if (sdLocal.valid) sdChecks.push(add('sdcpp:local-runtime', 'ok', `${sdLocal.message}${sdLocal.variant ? ` Active variant: ${sdLocal.variant}.` : ''}`, {
    path: sdLocal.binaryPath, variant: sdLocal.variant,
  }));
  const binaryInfo = await stat(sd.binaryPath);
  const binaryCheck = add('sdcpp:binary', !binaryInfo ? 'missing' : binaryInfo.isFile() && binaryInfo.size > 0 ? 'ok' : 'wrong',
    !binaryInfo ? 'sd-cli binary is absent or not configured.' : `sd-cli binary ${binaryInfo.isFile() ? 'present' : 'is not a file'}.`, {
      path: sd.binaryPath || undefined, ...(!binaryInfo || !binaryInfo.isFile() || !binaryInfo.size ? { fix: sdFix(!!binaryInfo) } : {}),
    });
  sdChecks.push(binaryCheck);
  for (const key of MODEL_KEYS) {
    if (key === 'llmVision' && sd[key] == null) continue;
    const info = await stat(sd[key]);
    const ready = info?.isFile() && info.size > 0;
    sdChecks.push(add(`sdcpp:${key}`, ready ? 'ok' : info ? 'wrong' : 'missing',
      ready ? `${key} model present: ${info.size} bytes.` : `${key} model is missing, empty, or not configured.`, {
        path: sd[key] || undefined, ...(info?.isFile() && { sizeBytes: info.size }),
        ...(!ready && { fix: installFix('models', !!info) }),
      }));
  }
  if (binaryCheck.status === 'ok') {
    if (!sdLocal.valid) {
      try {
        const help = await commandRunner(sd.binaryPath, ['--help'], { cwd: path.dirname(sd.binaryPath), env, timeoutMs: 5000 });
        if (help.code && help.code !== 0) throw new Error(`exit ${help.code}: ${help.stderr || help.stdout || ''}`);
        sdChecks.push(add('sdcpp:help', 'ok', 'Configured legacy sd-cli --help passed.'));
      } catch (error) {
        sdChecks.push(add('sdcpp:help', 'wrong', `Configured sd-cli --help failed: ${error.message}`, { fix: sdFix(true) }));
      }
    }
    let gpuBackend = null;
    try {
      const result = await commandRunner(sd.binaryPath, ['--list-devices'], {
        cwd: path.dirname(sd.binaryPath), env, timeoutMs: 5000,
      });
      const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
      if (result.code && result.code !== 0) throw new Error(`exit ${result.code}: ${output}`);
      gpuBackend = parseSdCppDevices(output).backend;
      const ready = output && (gpuBackend || sd.allowCpu === true);
      sdChecks.push(add('sdcpp:devices', ready ? 'ok' : 'wrong', output
        ? `sd-cli devices:\n${output}${!gpuBackend ? '\nNo CUDA/Vulkan GPU was listed; CPU use requires explicit sdcpp.allowCpu.' : ''}` : 'sd-cli --list-devices returned no devices.', {
        ...(!ready && { fix: sdFix(true) }),
      }));
    } catch (error) {
      sdChecks.push(add('sdcpp:devices', 'wrong', `sd-cli --list-devices failed: ${error.message}`, { fix: sdFix(true) }));
    }
    if (platform === 'win32') {
      const names = (await fsp.readdir(path.dirname(sd.binaryPath))).map(name => name.toLowerCase());
      const cudaPresent = names.some(name => /^ggml-cuda.*\.dll$/.test(name));
      const runtimePresent = names.some(name => /^cudart.*\.dll$/.test(name)) && names.some(name => /^cublas.*\.dll$/.test(name));
      const cpuAllowed = sd.allowCpu === true;
      sdChecks.push(add('sdcpp:cuda-runtime', cudaPresent && runtimePresent || gpuBackend === 'vulkan' ? 'ok' : cpuAllowed || gpuBackend ? 'warning' : 'missing',
        gpuBackend === 'vulkan' ? 'Vulkan device available; CUDA DLLs are optional.'
          : cudaPresent && runtimePresent ? 'CUDA ggml, cudart and cublas DLLs are present beside sd-cli.'
          : 'CUDA ggml/cudart/cublas DLLs are missing beside sd-cli; device output above can also reveal DLLs found on PATH.', {
          ...(!(cudaPresent && runtimePresent) && { fix: sdFix(true) }),
        }));
    }
  }
  providers.push({ name: 'sdcpp', checks: sdChecks, ready: sdChecks.every(check => !['wrong', 'missing'].includes(check.status)) });

  let managed = resolveManagedPaths(config.comfyuiManaged || {}, paths);
  const comfyLocal = inspectManagedRuntime(paths);
  const managedHasLegacy = Object.values(managed._legacyPaths || {}).some(Boolean);
  if (!comfyLocal.valid && !managedHasLegacy) managed = { ...managed, ...comfyLocal };
  const managedChecks = [];
  const comfyComponent = components.find(component => component.id === 'comfyui-portable');
  const comfyFix = force => installFix('comfyui', force, comfyComponent);
  if (comfyLocal.exists && !comfyLocal.valid && managedHasLegacy) managedChecks.push(add('comfyui-managed:local-runtime', 'warning',
    `PROMINENT WARNING: ${RUNTIME_WARNING_MESSAGES.LOCAL_COMFYUI_RUNTIME_FALLBACK} ${comfyLocal.message}`, {
      code: 'LOCAL_COMFYUI_RUNTIME_FALLBACK', path: comfyLocal.installDir, fix: comfyFix(true),
    }));
  else if (!comfyLocal.valid && !managedHasLegacy) managedChecks.push(add('comfyui-managed:local-runtime', 'missing', comfyLocal.message, {
    code: comfyLocal.code, path: comfyLocal.installDir, fix: comfyFix(!!comfyLocal.exists),
  }));
  for (const [key, directory] of [['installDir', true], ['pythonPath', false], ['mainScript', false]]) {
    const info = await stat(managed[key]);
    const ready = directory ? info?.isDirectory() : info?.isFile() && info.size > 0;
    managedChecks.push(add(`comfyui-managed:${key}`, ready ? 'ok' : info ? 'wrong' : 'missing',
      ready ? `${key} present.` : `${key} is missing, empty, or not configured.`, {
        path: managed[key] || undefined, ...(!ready && { fix: comfyFix(!!info) }),
      }));
  }
  if (managedChecks.every(check => !['wrong', 'missing'].includes(check.status))) {
    try {
      const result = await commandRunner(managed.pythonPath, ['-B', managed.mainScript, '--help'], {
        cwd: managed.installDir, env: { ...env, ...managed.env, PYTHONDONTWRITEBYTECODE: '1' }, timeoutMs: 15000,
      });
      if (result.code && result.code !== 0) throw new Error(`exit ${result.code}: ${result.stderr || result.stdout || ''}`);
      managedChecks.push(add('comfyui-managed:launch', 'ok', 'Embedded/configured Python main.py --help passed; no server was started.'));
    } catch (error) {
      managedChecks.push(add('comfyui-managed:launch', 'wrong', `ComfyUI launch check failed: ${error.message}`, { fix: comfyFix(true) }));
    }
  }
  const comfyRoot = managed.mainScript ? path.dirname(managed.mainScript) : path.join(paths.runtimeDir('comfyui'), 'ComfyUI');
  const nodeComponent = components.find(component => component.id === 'comfyui-gguf-node');
  const nodePath = nodeComponent?.destination && !isPlaceholder(nodeComponent.destination)
    ? paths.resolvePath(nodeComponent.destination, { baseDir: paths.localDir }) : path.join(comfyRoot, 'custom_nodes', 'ComfyUI-GGUF');
  const legacyNodePath = path.join(comfyRoot, 'custom_nodes', 'ComfyUI-GGUF', '__init__.py');
  const selectedNodePath = comfyLocal.valid ? path.join(nodePath, '__init__.py') : legacyNodePath;
  const nodeInfo = await stat(selectedNodePath);
  managedChecks.push(add('comfyui-managed:gguf-node', nodeInfo?.isFile() && nodeInfo.size > 0 ? 'ok' : 'missing',
    nodeInfo?.isFile() && nodeInfo.size > 0 ? 'ComfyUI-GGUF custom node present.' : 'ComfyUI-GGUF custom node is missing or empty.', {
      path: selectedNodePath,
      ...(!(nodeInfo?.isFile() && nodeInfo.size > 0) && { fix: installFix('comfyui') }),
    }));
  const yamlPath = path.join(comfyRoot, 'extra_model_paths.yaml');
  let yamlReady = false;
  try {
    const yaml = await fsp.readFile(yamlPath, 'utf8');
    yamlReady = yaml.replace(/\\/g, '/').includes(paths.modelsDir().replace(/\\/g, '/'));
  } catch { /* Missing file gets an actionable diagnostic. */ }
  managedChecks.push(add('comfyui-managed:model-paths', yamlReady ? 'ok' : 'missing',
    yamlReady ? 'extra_model_paths.yaml points at local/models.' : 'extra_model_paths.yaml is missing or does not point at local/models.', {
      path: yamlPath, ...(!yamlReady && { fix: installFix('comfyui', !!(await stat(yamlPath))) }),
    }));
  providers.push({ name: 'comfyui-managed', checks: managedChecks, ready: managedChecks.every(check => !['wrong', 'missing'].includes(check.status)) });

  const externalChecks = [];
  let urlReady = false;
  try { urlReady = ['http:', 'https:'].includes(new URL(config.comfyUrl).protocol); } catch { /* Config diagnostic below. */ }
  externalChecks.push(add('comfyui:url', urlReady ? 'ok' : 'wrong', urlReady
    ? `External ComfyUI URL configured: ${config.comfyUrl}. Health is not contacted by offline doctor.` : 'External ComfyUI URL is missing or invalid.', {
    ...(!urlReady && { fix: 'Edit selfie.config.local.json and set comfyUrl to the running ComfyUI HTTP URL; then run npm run doctor' }),
  }));
  for (const [id, filename] of [['workflow', config.workflowPath], ['mapping', config.mappingPath]]) {
    const info = await stat(filename);
    const ready = info?.isFile() && info.size > 0;
    const check = add(`comfyui:${id}`, ready ? 'ok' : 'missing', ready ? `${id} file present.` : `${id} file is missing or empty.`, {
      path: filename, ...(!ready && { fix: `Edit selfie.config.local.json and set ${id}File to an existing file; then run npm run doctor` }),
    });
    externalChecks.push(check);
    managedChecks.push(check);
  }
  if (await stat(config.workflowPath)) {
    try {
      const workflow = JSON.parse(await fsp.readFile(config.workflowPath, 'utf8'));
      const kindsFor = field => /^unet_name$/.test(field) ? ['diffusion_models', 'unet']
        : /^clip_name\d*$/.test(field) ? ['text_encoders', 'clip']
          : { vae_name: ['vae'], ckpt_name: ['checkpoints'], lora_name: ['loras'], clip_vision_name: ['clip_vision'], control_net_name: ['controlnet'] }[field];
      const legacyRoot = paths.resolvePath(rawConfig.comfyuiManaged?.installDir);
      const comfyModelRoots = [path.join(comfyRoot, 'models'), ...(legacyRoot
        ? [path.join(legacyRoot, 'models'), path.join(legacyRoot, 'ComfyUI', 'models')] : [])];
      for (const [nodeId, node] of Object.entries(workflow)) {
        for (const [field, value] of Object.entries(node?.inputs || {})) {
          const kinds = kindsFor(field);
          if (!kinds || typeof value !== 'string' || !value.trim()) continue;
          const candidates = kinds.flatMap(kind => [path.join(paths.modelsDir(kind), value), ...comfyModelRoots.map(root => path.join(root, kind, value))]);
          if (path.isAbsolute(value) || value.includes('${LOCAL}')) candidates.unshift(paths.resolvePath(value));
          for (const key of MODEL_KEYS) if (config.sdcpp?.[key] && path.basename(config.sdcpp[key]) === path.basename(value)) candidates.push(config.sdcpp[key]);
          let found;
          for (const filename of [...new Set(candidates)]) {
            const info = await stat(filename);
            if (info?.isFile() && info.size > 0) { found = { filename, info }; break; }
          }
          const check = add(`comfyui:model:${nodeId}:${field}`, found ? 'ok' : 'missing', found
            ? `Workflow ${field} ${value} present: ${found.info.size} bytes.` : `Workflow ${field} model ${value} is missing from local/configured ComfyUI model paths.`, {
            path: found?.filename || candidates[0], ...(found && { sizeBytes: found.info.size }), ...(!found && { fix: installFix('models') }),
          });
          externalChecks.push(check);
          managedChecks.push(check);
        }
      }
    } catch (error) {
      const check = add('comfyui:workflow-json', 'wrong', `Workflow JSON is invalid: ${error.message}`, { fix: 'Edit the configured workflow JSON, then run npm run doctor' });
      externalChecks.push(check);
      managedChecks.push(check);
    }
  }
  if (config.defaultReference) {
    const reference = paths.resolvePath(config.defaultReference, { baseDir: config.referenceDir || paths.repoRoot });
    const info = await stat(reference);
    const ready = info?.isFile() && info.size > 0;
    externalChecks.push(add('comfyui:reference', ready ? 'ok' : 'missing', ready ? 'Default reference image present.' : 'Default reference image is missing or empty.', {
      path: reference, ...(!ready && { fix: 'Place your licensed reference at the reported path, or set referenceDir/defaultReference in selfie.config.local.json; then run npm run doctor' }),
    }));
  }
  providers.push({ name: 'comfyui', checks: externalChecks, ready: null, note: 'Offline only: external HTTP health is not probed.' });
  providers.find(provider => provider.name === 'comfyui-managed').ready = managedChecks.every(check => !['wrong', 'missing'].includes(check.status));

  const legacyRoots = new Set();
  const rawSd = rawConfig.sdcpp || {};
  const legacyBase = rawConfig.sdcppBaseDir || (rawConfig.userDataDir
    ? path.join(paths.resolvePath(rawConfig.userDataDir), 'models', 'sdcpp') : null);
  for (const key of MODEL_KEYS) {
    const value = paths.resolvePath(rawSd[key], { baseDir: legacyBase || paths.modelsDir(key === 'vae' ? 'vae' : key === 'diffusionModel' ? 'diffusion_models' : 'text_encoders') });
    if (value) legacyRoots.add(path.dirname(value));
  }
  const legacyComfy = paths.resolvePath(rawConfig.comfyuiManaged?.installDir);
  if (legacyComfy) {
    legacyRoots.add(path.join(legacyComfy, 'models'));
    legacyRoots.add(path.join(legacyComfy, 'ComfyUI', 'models'));
  }
  for (const value of Array.isArray(rawConfig.legacyModelDirs) ? rawConfig.legacyModelDirs : []) {
    if (typeof value === 'string') legacyRoots.add(paths.resolvePath(value));
  }
  const { duplicates, failures } = await findDuplicates([paths.modelsDir(), ...legacyRoots]);
  add('models:duplicates', duplicates.length ? 'warning' : 'ok', duplicates.length
    ? `${duplicates.length} duplicate candidate(s) share basename and size across local/configured model paths. Contents have not been hashed.` : 'No duplicate model names and sizes found.', {
    ...(duplicates.length && { fix: 'Reuse one existing absolute model path in selfie.config.local.json (see docs/setup.md); then run npm run doctor' }),
  });
  for (const failure of failures) add('models:scan', 'warning', `Duplicate scan could not read ${failure}`, { fix: 'Grant read access to the reported model directory, then run npm run doctor' });

  let system;
  try { system = normalizeCommit(await systemRunner({ localDir: paths.localDir, commandRunner, platform })); }
  catch (error) {
    system = {};
    add('system:probe', 'warning', error.message, { fix: 'Run npm run doctor from a terminal with access to system memory and disk counters' });
  }
  const missingBytes = componentChecks.reduce((sum, check) => sum + (check.selected && check.status !== 'ok' ? components.find(component => component.id === check.componentId)?.sizeBytes || 0 : 0), 0);
  const insufficient = Number.isFinite(system.freeBytes) && system.freeBytes < missingBytes * 2;
  add('system:disk', insufficient ? 'wrong' : Number.isFinite(system.freeBytes) ? 'ok' : 'warning',
    `Free disk at ${paths.localDir}: ${bytes(system.freeBytes)}; total: ${bytes(system.totalBytes)}; missing downloads need at least ${bytes(missingBytes * 2)} for download/extraction (TODO sizes excluded).`, {
      ...(insufficient || !Number.isFinite(system.freeBytes) ? { fix: 'Set WAIFU_LOCAL_DIR to a volume with enough free space (docs/setup.md), then run npm run setup:plan' } : {}),
    });
  add('system:ram', Number.isFinite(system.totalRamBytes) ? 'ok' : 'warning', `RAM total: ${bytes(system.totalRamBytes)}; available: ${bytes(system.freeRamBytes)}.`, {
    ...(!Number.isFinite(system.totalRamBytes) && { fix: 'Run npm run doctor from a terminal with access to system memory counters' }),
  });
  const commitKnown = Number.isFinite(system.commitLimitBytes) && Number.isFinite(system.commitUsedBytes);
  add('system:commit', commitKnown ? 'ok' : 'warning', commitKnown
    ? `Commit used: ${bytes(system.commitUsedBytes)}; limit: ${bytes(system.commitLimitBytes)}; headroom: ${bytes(Math.max(0, system.commitLimitBytes - system.commitUsedBytes))}.`
    : 'System commit usage/limit unavailable.', {
      ...(!commitKnown && { fix: platform === 'win32' ? 'powershell.exe -NoProfile -Command "Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object CommitLimit,CommittedBytes"'
        : platform === 'linux' ? 'cat /proc/meminfo' : 'Run npm run doctor on a system that exposes commit counters' }),
    });
  return { checks, components: componentChecks, providers, duplicates, system, gpu, gpuVendor: gpu.gpuVendor,
    installed, activeVariant: sdLocal.variant || installed.activeVariants?.sdcpp || null, localDir: paths.localDir,
    ok: checks.every(check => !['missing', 'wrong'].includes(check.status)) };
}

export function formatDoctor(report) {
  const lines = [`Offline local setup doctor: ${report.localDir}`];
  for (const check of report.checks.filter(check => /^LOCAL_(?:COMFYUI|SDCLI)_RUNTIME_FALLBACK$/.test(check.code || ''))) {
    lines.push(`[WARNING] ${check.message}`);
  }
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id}: ${check.message}`);
    if (check.path) lines.push(`  Path: ${check.path}`);
    if (check.fix) lines.push(`  Fix: ${check.fix}`);
  }
  for (const duplicate of report.duplicates) lines.push(`  Duplicate candidate ${duplicate.name} (${duplicate.sizeBytes} bytes):\n${duplicate.paths.map(filename => `    ${filename}`).join('\n')}`);
  lines.push('Installed metadata compares recorded download pins and hashes; runtime file sizes are checked. Use npm run doctor -- --verify-hashes to rehash installed files, or npm run setup:hash -- <path> for one offline file.');
  lines.push('Offline checks complete. No downloads, installs, server starts, or files written.');
  return lines.join('\n');
}
