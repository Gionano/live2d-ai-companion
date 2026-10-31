// Loaded before every test worker and inherited by Node fixture subprocesses.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');

const runRoot = process.env.WAIFU_TEST_RUN_ROOT;
if (!runRoot) throw new Error('Run tests with npm test so filesystem isolation is enabled.');
const sourceRoot = process.env.WAIFU_TEST_SOURCE_ROOT;
const repoRoot = process.env.WAIFU_TEST_REPO_ROOT;
const realHome = process.env.WAIFU_TEST_REAL_HOME;
const dependencyRoot = path.join(repoRoot, 'node_modules');
const originalLstat = fs.lstatSync;
const originalReadlink = fs.readlinkSync;
const normalize = value => {
  if (process.platform !== 'win32') return value;
  // Windows recursive removal uses extended-length paths internally.
  if (value.startsWith('\\\\?\\UNC\\')) value = `\\\\${value.slice(8)}`;
  else if (value.startsWith('\\\\?\\')) value = value.slice(4);
  return value.toLowerCase();
};
const inside = (filename, parent) => {
  const relative = path.relative(normalize(parent), normalize(filename));
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
let violated = false;

function resolvedPath(filename, depth = 0) {
  if (depth > 40) fail('resolve', 'a symbolic link cycle');
  let current = path.parse(filename).root;
  // Resolve aliases, not regular files: Windows realpath can report a transient
  // NTFS deleted-file location while fixture cleanup removes an open file.
  for (const segment of path.relative(current, filename).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let target;
    try { if (originalLstat(current).isSymbolicLink()) target = originalReadlink(current); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    if (target !== undefined) current = resolvedPath(path.resolve(path.dirname(current), target), depth + 1);
  }
  return current;
}

function fail(operation, zone) {
  const first = !violated;
  violated = true;
  const error = new Error(`TEST_FILESYSTEM_ISOLATION: ${operation} blocked for ${zone}. Use a temporary fixture.`);
  error.code = 'ERR_TEST_FILESYSTEM_ISOLATION';
  if (first) process.stderr.write(`${error.stack}\n`);
  throw error;
}

function check(value, write, operation) {
  if (typeof value === 'number' || value === undefined || value === null) return;
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== 'string') return;
  const requested = path.resolve(value);
  const resolved = resolvedPath(requested);
  for (const filename of new Set([requested, resolved])) {
    if (inside(filename, dependencyRoot) && !write) continue;
    if (inside(filename, sourceRoot)) {
      if (write) fail(operation, 'immutable test sources');
      continue;
    }
    if (inside(filename, runRoot)) continue;
    if (inside(filename, repoRoot)) fail(operation, 'the working checkout');
    if (inside(filename, realHome)) fail(operation, 'the real home directory');
    if (write) fail(operation, 'a location outside the test run');
  }
}

const writingFlags = flags => typeof flags === 'number'
  ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
  : /[wa+]/.test(flags || 'r');
const read = args => [[args[0], false]];
const write = args => [[args[0], true]];
const readNames = ['access', 'exists', 'lstat', 'stat', 'statfs', 'realpath', 'readFile', 'readdir', 'readlink', 'opendir', 'watch', 'watchFile'];
const writeNames = ['appendFile', 'writeFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'truncate', 'chmod', 'chown', 'lchmod', 'lchown', 'utimes', 'lutimes'];
const rules = Object.fromEntries([...readNames.map(name => [name, read]), ...writeNames.map(name => [name, write]),
  ['open', args => [[args[0], writingFlags(args[1])]]],
  ['copyFile', args => [[args[0], false], [args[1], true]]],
  ['cp', args => [[args[0], false], [args[1], true]]],
  ['rename', args => [[args[0], true], [args[1], true]]],
  ['link', args => [[args[0], true], [args[1], true]]],
  ['symlink', args => [[path.resolve(path.dirname(args[1]), args[0]), false], [args[1], true]]],
  ['createReadStream', read], ['createWriteStream', write]]);

for (const [name, paths] of Object.entries(rules)) {
  for (const method of [name, `${name}Sync`]) {
    const original = fs[method];
    if (typeof original !== 'function') continue;
    const wrapped = function (...args) {
      for (const [filename, write] of paths(args)) check(filename, write, method);
      return original.apply(this, args);
    };
    if (original.native) wrapped.native = function (...args) {
      for (const [filename, write] of paths(args)) check(filename, write, `${method}.native`);
      return original.native.apply(this, args);
    };
    fs[method] = wrapped;
  }
  const original = fs.promises[name];
  if (typeof original === 'function') fs.promises[name] = async function (...args) {
    for (const [filename, write] of paths(args)) check(filename, write, `promises.${name}`);
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
process.on('exit', () => { if (violated) process.exitCode = 1; });
