import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { createLocalPaths } from '../server/selfie/localPaths.js';
import { readManifest, listComponents, validateManifest, validateComponent, selectComponents, validatePlanRoles, sameOrNestedDestination, ENGINE_NAMES } from './manifest.js';
import { detectGpuVendor } from './hardware.js';
import { hashFile } from './hash.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const ARCHIVE_RE = /\.(zip|7z|tar|tar\.gz|tgz|tar\.xz)$/i;

export async function runCommand(command, args, options = {}) {
  return execFileAsync(command, args, { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...options });
}

export function diskSpace(directory) {
  let existing = path.resolve(directory);
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  try {
    const stats = fs.statfsSync(existing);
    return { freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize) };
  } catch { return { freeBytes: null, totalBytes: null }; }
}

export function assertContained(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Destination escapes local directory: ${target}`);
  }
  let existingRoot = resolvedRoot;
  while (!fs.existsSync(existingRoot) && path.dirname(existingRoot) !== existingRoot) existingRoot = path.dirname(existingRoot);
  let existingTarget = resolvedTarget;
  while (!fs.existsSync(existingTarget) && path.dirname(existingTarget) !== existingTarget) existingTarget = path.dirname(existingTarget);
  const expectedRoot = path.resolve(fs.realpathSync(existingRoot), path.relative(existingRoot, resolvedRoot));
  const actualTarget = path.resolve(fs.realpathSync(existingTarget), path.relative(existingTarget, resolvedTarget));
  const realRelative = path.relative(expectedRoot, actualTarget);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`Destination follows a link outside local directory: ${target}`);
  }
  return resolvedTarget;
}

export async function verifyFile(filePath, component) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile() || stat.size !== component.sizeBytes) {
    throw new Error(`${component.name}: size mismatch (expected ${component.sizeBytes}, found ${stat.size})`);
  }
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  if (hash.digest('hex') !== component.sha256.toLowerCase()) throw new Error(`${component.name}: SHA-256 checksum mismatch`);
  return stat.size;
}

async function request(url, headers, redirects = 0) {
  if (redirects > 5) throw new Error('Too many download redirects');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Downloads require HTTP(S)');
  const response = await new Promise((resolve, reject) => {
    const req = (parsed.protocol === 'https:' ? https : http).get(parsed, { headers }, resolve);
    req.setTimeout(30000, () => req.destroy(new Error('Download timed out')));
    req.once('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume();
    if (!response.headers.location) throw new Error('Download redirect has no Location');
    return request(new URL(response.headers.location, parsed).href, headers, redirects + 1);
  }
  return response;
}

async function lstatOptional(filename) {
  try { return await fsp.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function downloadComponent(component, target, { force = false, log = () => {} } = {}) {
  const errors = validateComponent(component);
  if (errors.length) throw new Error(errors.join('\n'));
  const existingTarget = await lstatOptional(target);
  if (existingTarget) {
    if (!force) {
      try { await verifyFile(target, component); return { path: target, reused: true }; }
      catch { throw new Error(`${target} already exists; use --force to replace it`); }
    }
    if (existingTarget.isSymbolicLink()) throw new Error(`Refusing linked download target: ${target}`);
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  const existingPartial = await lstatOptional(partial);
  if (existingPartial?.isSymbolicLink()) throw new Error(`Refusing linked partial download: ${partial}`);
  if (existingPartial && !existingPartial.isFile()) throw new Error(`Partial download is not a regular file: ${partial}`);
  let offset = existingPartial?.size || 0;
  if (offset > component.sizeBytes) {
    if (!force) throw new Error(`${partial} exceeds expected size; use --force to restart`);
    await fsp.truncate(partial, 0);
    offset = 0;
  }
  if (offset < component.sizeBytes) {
    log(`${component.name}: ${offset ? `resuming at byte ${offset}` : 'downloading'}`);
    const response = await request(component.url, offset ? { Range: `bytes=${offset}-` } : {});
    let append = false;
    if (response.statusCode === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
      if (!range || Number(range[1]) !== offset || Number(range[3]) !== component.sizeBytes) {
        response.resume();
        throw new Error(`${component.name}: invalid HTTP Content-Range response`);
      }
      append = offset > 0;
    } else if (response.statusCode !== 200) {
      response.resume();
      throw new Error(`${component.name}: HTTP ${response.statusCode}`);
    }
    let downloaded = append ? offset : 0;
    response.on('data', (chunk) => {
      downloaded += chunk.length;
      if (downloaded > component.sizeBytes) response.destroy(new Error(`${component.name}: download exceeds declared size`));
    });
    await pipeline(response, fs.createWriteStream(partial, { flags: append ? 'a' : 'w' }));
  }
  try { await verifyFile(partial, component); }
  catch (error) {
    // A corrupt completed partial cannot be resumed safely.
    if (fs.existsSync(partial) && (await fsp.stat(partial)).size >= component.sizeBytes) await fsp.rm(partial);
    throw error;
  }
  if (force) {
    if (fs.existsSync(target)) await fsp.rm(target);
    await fsp.rename(partial, target);
  } else {
    try {
      // Exclusive publication also protects files created while HTTP was in flight.
      try { await fsp.link(partial, target); }
      catch (error) {
        if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM'].includes(error.code)) throw error;
        await fsp.copyFile(partial, target, fs.constants.COPYFILE_EXCL);
      }
      await fsp.rm(partial);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`${target} already exists; use --force to replace it`);
      throw error;
    }
  }
  return { path: target, reused: false };
}

function safeArchiveName(name) {
  const normalized = name.replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || normalized.includes(':') ||
    normalized.split('/').some((part) => part === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || (part !== '.' && /[. ]$/.test(part)))) {
    throw new Error(`Unsafe archive entry: ${name}`);
  }
  return normalized;
}

export async function detect7zExtractor({ commandRunner = runCommand, platform = process.platform } = {}) {
  const candidates = platform === 'win32'
    ? ['7z.exe', '7zz.exe', path.join(process.env.ProgramFiles || path.win32.join(process.env.SystemDrive || 'C:', '/', 'Program Files'), '7-Zip', '7z.exe')]
    : ['7zz', '7z'];
  for (const command of candidates) {
    try { await commandRunner(command, ['-h']); return { command, type: '7z' }; } catch { /* next installed extractor */ }
  }
  for (const command of ['bsdtar', 'tar']) {
    try {
      const result = await commandRunner(command, ['--version']);
      if (/bsdtar/i.test(result.stdout || '')) return { command, type: 'tar' };
    } catch { /* next installed extractor */ }
  }
  throw new Error('ComfyUI portable .7z extraction requires 7-Zip (7z/7zz) or bsdtar. Install one yourself, put it on PATH, then rerun npm run setup:comfyui -- --yes with license flags. Setup does not install an extractor.');
}

async function validateExtractedTree(directory) {
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Archive contains a symbolic link: ${target}`);
    if (entry.isDirectory()) await validateExtractedTree(target);
    else if (!entry.isFile()) throw new Error(`Archive contains a special file: ${target}`);
  }
}

export async function extractArchive(archive, destination, { commandRunner = runCommand, extractor } = {}) {
  if (fs.existsSync(destination) && (await fsp.readdir(destination)).length) throw new Error(`Extraction staging directory is not empty: ${destination}`);
  await fsp.mkdir(destination, { recursive: true });
  if (/\.zip$/i.test(archive)) {
    const zip = new AdmZip(archive);
    const entries = zip.getEntries();
    for (const entry of entries) {
      safeArchiveName(entry.entryName);
      const mode = (entry.header.attr >>> 16) & 0xf000;
      if (mode && mode !== 0x8000 && mode !== 0x4000) throw new Error(`Archive contains a link or special file: ${entry.entryName}`);
    }
    for (const entry of entries) {
      const target = assertContained(destination, path.join(destination, safeArchiveName(entry.entryName)));
      if (entry.isDirectory) await fsp.mkdir(target, { recursive: true });
      else {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, entry.getData(), { flag: 'wx', mode: ((entry.header.attr >>> 16) & 0o777) || 0o644 });
      }
    }
  } else {
    const selected = /\.7z$/i.test(archive) ? (extractor || await detect7zExtractor({ commandRunner })) : { command: 'tar', type: 'tar' };
    if (selected.type === '7z') {
      const listing = await commandRunner(selected.command, ['l', '-slt', archive]);
      const blocks = (listing.stdout || '').split(/----------\r?\n/).slice(1).join('\n').split(/\r?\n\r?\n/);
      if (!blocks.length || !blocks.some((block) => /^Path = /m.test(block))) throw new Error('Cannot validate .7z archive listing');
      for (const block of blocks) {
        const name = /^Path = (.+)$/m.exec(block)?.[1]?.trim();
        if (name) safeArchiveName(name);
        if (/^(Symbolic Link|Hard Link) = /m.test(block) || /^Attributes = .*\bl[rwx-]{9}/m.test(block)) {
          throw new Error(`Archive contains a link: ${name}`);
        }
      }
      await commandRunner(selected.command, ['x', '-y', '-aos', `-o${destination}`, archive], { timeout: 30 * 60 * 1000 });
    } else {
      const listing = await commandRunner(selected.command, ['-tf', archive]);
      const verbose = await commandRunner(selected.command, ['-tvf', archive]);
      for (const name of (listing.stdout || '').split(/\r?\n/).filter(Boolean)) safeArchiveName(name);
      if ((verbose.stdout || '').split(/\r?\n/).some((line) => /^[lhbcps]/.test(line))) throw new Error('Archive contains links or special files');
      await commandRunner(selected.command, ['-xf', archive, '-C', destination], { timeout: 30 * 60 * 1000 });
    }
  }
  await validateExtractedTree(destination);
  return destination;
}

async function unwrap(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  return entries.length === 1 && entries[0].isDirectory() ? path.join(directory, entries[0].name) : directory;
}

async function collectFiles(directory, relative = '') {
  const files = [];
  for (const entry of await fsp.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(directory, next));
    else files.push(next);
  }
  return files;
}

async function mergeStaging(source, destination, localDir, force) {
  const files = await collectFiles(source);
  for (const relative of files) {
    const target = assertContained(localDir, path.join(destination, relative));
    if (fs.existsSync(target) && !force) throw new Error(`${target} already exists; use --force to replace it`);
    if (fs.existsSync(target) && (await fsp.lstat(target)).isSymbolicLink()) throw new Error(`Refusing linked install target: ${target}`);
  }
  for (const relative of files) {
    const target = assertContained(localDir, path.join(destination, relative));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(path.join(source, relative), target, force ? 0 : fs.constants.COPYFILE_EXCL);
    await fsp.chmod(target, (await fsp.stat(path.join(source, relative))).mode);
  }
}

export function licenseKey(component) {
  return crypto.createHash('sha256').update(`${component.licenseName}\0${component.licenseUrl}`).digest('hex');
}

function acceptedLicenses(filePath) {
  if (!fs.existsSync(filePath)) return { schemaVersion: 1, licenses: {} };
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (data.schemaVersion !== 1 || !data.licenses || typeof data.licenses !== 'object' || Array.isArray(data.licenses)) throw new Error(`Invalid license record: ${filePath}`);
  for (const [key, entry] of Object.entries(data.licenses)) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.name.trim() ||
      typeof entry.url !== 'string' || !/^https?:\/\//i.test(entry.url) ||
      typeof entry.acceptedAt !== 'string' || !Number.isFinite(Date.parse(entry.acceptedAt)) ||
      licenseKey({ licenseName: entry.name, licenseUrl: entry.url }) !== key) {
      throw new Error(`Invalid license acceptance in ${filePath}: ${key}. Repair the record and explicitly accept each license again.`);
    }
  }
  return data;
}

export async function writeExtraModelPaths(comfyRoot, localDir, { force = false } = {}) {
  const example = path.join(comfyRoot, 'extra_model_paths.yaml.example');
  if (!fs.existsSync(example)) throw new Error(`Missing installed ${example}; cannot infer ComfyUI model keys. Restore the portable's example and rerun setup:comfyui.`);
  const target = path.join(comfyRoot, 'extra_model_paths.yaml');
  if (fs.existsSync(target) && !force) throw new Error(`${target} already exists; use --force to replace it`);
  const lines = fs.readFileSync(example, 'utf8').split(/\r?\n/);
  const keys = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/^(\s*)#\s?/, '$1');
    const match = /^(\s+)([a-zA-Z][\w-]*):\s*(.*)$/.exec(line);
    if (!match || ['base_path', 'is_default'].includes(match[2])) continue;
    const value = match[3].split('#')[0].trim().replace(/^['"]|['"]$/g, '');
    const values = [];
    if (value === '|' || value === '>') {
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next].replace(/^(\s*)#\s?/, '$1');
        if (!candidate.trim()) continue;
        if ((/^\s*/.exec(candidate)?.[0].length || 0) <= match[1].length) break;
        values.push(candidate.trim());
      }
    } else values.push(value);
    const modelDirectories = [...new Set(values.map((entry) => /(?:^|[/\\])models[/\\](.+)/.exec(entry)?.[1]?.replace(/\\/g, '/').replace(/\/$/, '')))]
      .filter((entry) => entry && !entry.split('/').includes('..'));
    if (modelDirectories.length && !keys.has(match[2])) keys.set(match[2], modelDirectories);
  }
  if (!keys.size) throw new Error(`No model path keys found in ${example}; refusing to guess YAML keys`);
  const modelBase = path.join(localDir, 'models').replace(/\\/g, '/');
  const yaml = `# Model keys read from the installed ComfyUI example.\nwaifu_local:\n  base_path: ${JSON.stringify(modelBase)}\n${[...keys].map(([key, values]) => values.length === 1
    ? `  ${key}: ${JSON.stringify(values[0])}\n`
    : `  ${key}: |\n${values.map((value) => `    ${value}\n`).join('')}`).join('')}`;
  assertContained(localDir, target);
  await fsp.writeFile(target, yaml, { flag: force ? 'w' : 'wx' });
  return target;
}

export async function installGgufRequirements(localDir, nodeDirectory, { commandRunner = runCommand, constraintsPath, skipPip = false, log = console.log } = {}) {
  const portable = path.join(localDir, 'runtime', 'comfyui');
  const pythonCandidates = ['python_embeded/python.exe', 'python_embedded/python.exe', 'python_embeded/python', 'python_embedded/python'];
  const python = pythonCandidates.map((relative) => path.join(portable, relative)).find((candidate) => fs.existsSync(candidate));
  if (!python) throw new Error(`Portable embedded Python is missing in ${portable}; rerun setup:comfyui -- --yes with license flags.`);
  const requirements = path.join(nodeDirectory, 'requirements.txt');
  if (!fs.existsSync(requirements)) throw new Error(`Pinned ComfyUI-GGUF archive has no requirements.txt: ${requirements}`);
  if (constraintsPath && !fs.existsSync(constraintsPath)) throw new Error(`Pinned pip constraints file is missing: ${constraintsPath}`);
  const args = ['-s', '-m', 'pip', 'install', '-r', requirements, ...(constraintsPath ? ['-c', constraintsPath] : [])];
  log(`Pip command: ${[python, ...args].map((value) => JSON.stringify(value)).join(' ')}`);
  if (skipPip) { log('Pip skipped (--skip-pip); install the logged requirements command before using the custom node.'); return { skipped: true, command: python, args }; }
  await commandRunner(python, args, { cwd: nodeDirectory, timeout: 30 * 60 * 1000 });
  return { skipped: false, command: python, args };
}

function readInstalled(filePath) {
  if (!fs.existsSync(filePath)) return { schemaVersion: 1, components: {}, activeVariants: {} };
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (record.schemaVersion !== 1 || !record.components || typeof record.components !== 'object' || Array.isArray(record.components) ||
    !record.activeVariants || typeof record.activeVariants !== 'object' || Array.isArray(record.activeVariants)) throw new Error(`Invalid installation record: ${filePath}`);
  return record;
}

function preflightRuntimeComponents(selected, installed, paths, manifest) {
  const runtimes = selected.filter((component) => ['runtime', 'runtime_library'].includes(component.role));
  const physicalDestination = value => {
    const target = assertContained(paths.localDir, path.resolve(paths.localDir, value));
    let ancestor = target;
    while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    return path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, target));
  };
  const declaredVariants = listComponents(manifest).filter((component) => component.variant);
  for (const component of runtimes) {
    const destination = assertContained(paths.localDir, path.join(paths.localDir, component.destination));
    const physical = physicalDestination(component.destination);
    const recorded = installed.components[component.id];
    if (manifest.schemaVersion === 2 && component.role === 'runtime' && fs.existsSync(destination) && fs.readdirSync(destination).length && !recorded) throw new Error(`Unrecorded incompatible runtime at ${destination}; move it outside this variant directory or use its explicit legacy config. --force cannot adopt an unknown runtime.`);
    if (recorded && (recorded.variant !== component.variant || typeof recorded.destination !== 'string' ||
      path.posix.normalize(recorded.destination.replace(/\\/g, '/')).toLowerCase() !== path.posix.normalize(component.destination.replace(/\\/g, '/')).toLowerCase())) throw new Error(`Runtime provenance conflicts with ${component.id}; --force cannot mix variants or destinations.`);
    for (const other of [...declaredVariants, ...Object.values(installed.components)]) {
      if (other?.variant && other.variant !== component.variant && typeof other.destination === 'string') {
        if (sameOrNestedDestination(other.destination, component.destination) || sameOrNestedDestination(physicalDestination(other.destination), physical)) throw new Error(`Cross-variant runtime collision at ${destination}; --force cannot mix ${other.variant} and ${component.variant || 'an untyped legacy runtime'}.`);
      }
    }
  }
  if (manifest.schemaVersion === 2 && runtimes.some((component) => component.engines.includes('sdcpp'))) {
    for (const root of [paths.runtimeDir('sdcpp'), paths.runtimeDir('sd-cli')]) {
      if (fs.existsSync(root) && !installed.components['sd-cli'] && fs.readdirSync(root).some((name) => !['cuda12', 'vulkan'].includes(name))) throw new Error(`Unrecorded legacy sd-cli runtime at ${root}; move it to a legacy location and configure its path before installing a variant. --force cannot infer CUDA/Vulkan compatibility.`);
    }
  }
}

function printPlanTotals(manifest, { engine, gpuVendor, platform, log }) {
  for (const engineName of engine ? [engine] : ENGINE_NAMES) {
    for (const variant of engineName === 'sdcpp' && manifest.schemaVersion === 2 ? ['cuda12', 'vulkan'] : [undefined]) {
      const selected = selectComponents(manifest, { command: 'plan', engine: engineName, variant, gpuVendor, os: platform });
      const known = selected.filter((component) => Number.isSafeInteger(component.sizeBytes) && component.sizeBytes > 0);
      const bytes = known.reduce((sum, component) => sum + component.sizeBytes, 0);
      log(`Plan total ${engineName}${variant ? `/${variant}` : ''}: ${bytes.toLocaleString('en-US')} bytes; ${selected.length - known.length} unknown TODO sizes`);
      for (const error of validatePlanRoles(selected, { engines: [engineName] }).errors) log(`Required roles: ${error}`);
    }
  }
}

export async function runSetup(command, options = {}) {
  const {
    repoRoot = REPO_ROOT, env = process.env, manifestPath = path.join(repoRoot, 'setup', 'manifest.json'),
    yes = false, force = false, acceptLicenses = [], engine, variant, skipPip = false, platform = process.platform, log = console.log, dependencies = {},
  } = options;
  const paths = createLocalPaths({ repoRoot, env });
  const manifest = readManifest(manifestPath);
  const validation = validateManifest(manifest);
  const hardware = await (dependencies.detectGpuVendor || detectGpuVendor)({
    platform,
    ...(dependencies.runCommand && { commandRunner: (cmd, args, options) => dependencies.runCommand(cmd, args, { timeout: options?.timeoutMs }) }),
  });
  const selected = selectComponents(manifest, { command, engine, variant, gpuVendor: hardware.gpuVendor, os: platform });
  const disk = (dependencies.diskSpace || diskSpace)(paths.localDir);
  const total = selected.reduce((sum, component) => sum + (Number.isSafeInteger(component.sizeBytes) ? component.sizeBytes : 0), 0);
  log(`Local directory: ${paths.localDir}`);
  log(`GPU vendor: ${hardware.gpuVendor}${hardware.warning ? ` (${hardware.warning})` : ''}; OS: ${platform}; selected engine: ${engine || (command === 'sdcli' ? 'sdcpp' : command === 'comfyui' ? 'comfyui' : 'both')}${variant ? `; variant override: ${variant}` : ''}`);
  for (const warning of validation.warnings) log(warning);
  log(`Free disk: ${disk.freeBytes === null ? 'unknown' : `${disk.freeBytes.toLocaleString('en-US')} bytes`}; planned downloads: ${total.toLocaleString('en-US')} bytes (unknown TODO sizes excluded)`);
  for (const component of selected) {
    log(`${component.name} [${component.id}, ${component.required ? 'required' : 'optional'}]: ${component.sizeBytes ?? 'TODO size'} bytes -> ${component.destination}`);
    log(`  URL: ${component.url}`);
    log(`  License: ${component.licenseName} (${component.licenseUrl})`);
  }
  for (const error of validation.errors) log(`Manifest: ${error}`);
  if (command === 'plan') printPlanTotals(manifest, { engine, gpuVendor: hardware.gpuVendor, platform, log });
  if (command === 'plan' || !yes) {
    log('Dry run: no downloads, extraction, installs, consent records, or other files written. Real setup requires --yes and --accept-license NAME for each license.');
    return { dryRun: true, components: selected, validation, localDir: paths.localDir };
  }
  const selectedValidation = manifest.schemaVersion === 2 ? validateManifest(manifest, { selectedIds: selected.map((component) => component.id) }) : validation;
  if (!selectedValidation.valid) throw new Error(`Setup refused: manifest contains placeholders or invalid metadata:\n${selectedValidation.errors.join('\n')}`);
  if (!selected.length) throw new Error(`No components match engine/variant on ${platform}; check --engine, --variant, and manifest when conditions.`);
  if (manifest.schemaVersion === 2) {
    const engines = engine ? [engine] : command === 'sdcli' ? ['sdcpp'] : command === 'comfyui' ? ['comfyui'] : ENGINE_NAMES;
    const roles = validatePlanRoles(selectComponents(manifest, { command: 'plan', engine, variant, gpuVendor: hardware.gpuVendor, os: platform }), { engines });
    if (!roles.valid) throw new Error(`Setup refused: ${roles.errors.join('; ')}`);
  }
  const installedPath = assertContained(paths.localDir, path.join(paths.localDir, 'installed.json'));
  const installed = readInstalled(installedPath);
  preflightRuntimeComponents(selected, installed, paths, manifest);
  const consentPath = assertContained(paths.localDir, path.join(paths.localDir, 'accepted-licenses.json'));
  const record = acceptedLicenses(consentPath);
  const missingLicenses = selected.filter((component) => !record.licenses[licenseKey(component)] && !acceptLicenses.includes(component.licenseName));
  if (missingLicenses.length) {
    throw new Error(`License consent required; rerun with --yes ${[...new Set(missingLicenses.map((component) => `--accept-license ${JSON.stringify(component.licenseName)}`))].join(' ')}. Each license acceptance is recorded in local/accepted-licenses.json.`);
  }
  if (disk.freeBytes !== null && disk.freeBytes < total * 2) throw new Error(`Insufficient free disk: allow at least ${total * 2} bytes for downloads and staged extraction; free space is ${disk.freeBytes}`);
  const commandRunner = dependencies.runCommand || runCommand;
  let extractor;
  if (selected.some((component) => /\.7z$/i.test(new URL(component.url).pathname))) extractor = await detect7zExtractor({ commandRunner });
  for (const component of selected) {
    assertContained(paths.localDir, path.join(paths.localDir, component.destination));
    record.licenses[licenseKey(component)] ||= { name: component.licenseName, url: component.licenseUrl, acceptedAt: new Date().toISOString() };
  }
  await fsp.mkdir(paths.localDir, { recursive: true });
  await fsp.writeFile(consentPath, `${JSON.stringify(record, null, 2)}\n`);
  for (const component of selected) {
    const destination = assertContained(paths.localDir, path.join(paths.localDir, component.destination));
    const filename = path.posix.basename(new URL(component.url).pathname);
    const archive = ARCHIVE_RE.test(filename);
    let installedFiles;
    if (!archive) {
      // Models name an exact file; runtime directories receive the URL's filename.
      const exactFile = component.id.startsWith('models[') || component.id === 'constraints';
      const target = exactFile ? destination : assertContained(paths.localDir, path.join(destination, filename));
      await downloadComponent(component, target, { force, log });
      if ((component.id === 'sd-cli' || component.id.startsWith('sd-cli:')) && platform !== 'win32') await fsp.chmod(target, 0o755);
      installedFiles = [exactFile ? '.' : filename];
    } else {
      const cache = assertContained(paths.localDir, path.join(paths.localDir, '.downloads', `${component.id.replace(/[^a-z0-9-]/gi, '-')}-${filename}`));
      await downloadComponent(component, cache, { force, log });
      const stagingParent = assertContained(paths.localDir, path.join(paths.localDir, '.staging'));
      await fsp.mkdir(stagingParent, { recursive: true });
      const staging = await fsp.mkdtemp(path.join(stagingParent, 'extract-'));
      try {
        await extractArchive(cache, staging, { commandRunner, extractor });
        const source = await unwrap(staging);
        installedFiles = await collectFiles(source);
        await mergeStaging(source, destination, paths.localDir, force);
      } finally { await fsp.rm(staging, { recursive: true, force: true }); }
    }
    const fileHashes = {};
    for (const relative of installedFiles) {
      const checked = await hashFile(path.join(destination, relative));
      fileHashes[relative] = { sha256: checked.sha256, sizeBytes: checked.sizeBytes };
    }
    installed.components[component.id] = Object.fromEntries(['name', 'version', 'commit', 'sha256', 'sizeBytes', 'destination', 'variant', 'engines', 'role'].filter((key) => component[key] !== undefined).map((key) => [key, component[key]]));
    Object.assign(installed.components[component.id], { files: installedFiles, fileHashes, installedAt: new Date().toISOString() });
    installed.updatedAt = new Date().toISOString();
    await fsp.writeFile(installedPath, `${JSON.stringify(installed, null, 2)}\n`);
    log(`Installed ${component.name}: ${destination}`);
  }
  if (command === 'comfyui') {
    const node = selected.find((component) => component.id === 'comfyui-gguf-node');
    const constraints = selected.find((component) => component.id === 'constraints');
    const pip = await installGgufRequirements(paths.localDir, path.join(paths.localDir, node.destination), { commandRunner, log, skipPip,
      constraintsPath: constraints ? path.join(paths.localDir, constraints.destination) : undefined });
    installed.components[node.id].pip = pip;
    // Pip can update files bundled in the portable; provenance describes the final installed runtime.
    if (!pip.skipped) {
      for (const component of selected.filter((entry) => entry.engines.includes('comfyui'))) {
        const record = installed.components[component.id];
        for (const relative of record.files) {
          const checked = await hashFile(path.join(paths.localDir, record.destination, relative));
          record.fileHashes[relative] = { sha256: checked.sha256, sizeBytes: checked.sizeBytes };
        }
      }
    }
    await writeExtraModelPaths(path.join(paths.localDir, 'runtime', 'comfyui', 'ComfyUI'), paths.localDir, { force });
  }
  const runtime = selected.find((component) => component.id.startsWith('sd-cli:'));
  if (runtime) installed.activeVariants.sdcpp = runtime.variant;
  installed.updatedAt = new Date().toISOString();
  await fsp.writeFile(installedPath, `${JSON.stringify(installed, null, 2)}\n`);
  for (const directory of ['models', 'outputs', 'logs']) await fsp.mkdir(assertContained(paths.localDir, path.join(paths.localDir, directory)), { recursive: true });
  return { dryRun: false, components: selected, validation, localDir: paths.localDir };
}
