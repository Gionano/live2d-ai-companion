import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { committableFiles } from './checkPrivacy.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-tests-'));
const sourceRoot = path.join(runRoot, 'source');
const directories = ['server/', 'src/', 'config/', 'workflows/', 'setup/', 'scripts/',
  'desktop-companion/src/', 'desktop-companion/scripts/', 'vision-monitor/src/', 'vision-monitor/server/'];
const files = new Set(['.gitignore', 'package.json', 'index.html', 'providers.config.json', 'selfie.config.json',
  'selfie.mapping.json', 'vite.config.js', 'desktop-companion/package.json', 'vision-monitor/vite.config.js']);

try {
  const eligible = committableFiles(repoRoot);
  for (const relative of new Set(eligible)) {
    if (!files.has(relative) && !directories.some(prefix => relative.startsWith(prefix))) continue;
    if (/(^|\/)(?:\.env(?:\..*)?|[^/]*\.local\.json)$/.test(relative)) continue;
    const from = path.join(repoRoot, relative);
    if (!fs.existsSync(from)) continue;
    if (!fs.lstatSync(from).isFile()) throw new Error('Test sources must be regular files.');
    const to = path.join(sourceRoot, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(sourceRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  // An allowlist also removes custom apiKeyEnv names without reading private config.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|LANG|LC_[A-Z_]+|TERM|CI|FORCE_COLOR|NUMBER_OF_PROCESSORS|PROCESSOR_[A-Z_]+)$/i.test(key)));
  const home = `${path.basename(runRoot)}-profile`;
  const locations = { HOME: home, USERPROFILE: home, APPDATA: `${home}/appdata`,
    LOCALAPPDATA: `${home}/localappdata`, XDG_CONFIG_HOME: `${home}/config`, XDG_DATA_HOME: `${home}/data`,
    XDG_CACHE_HOME: `${home}/cache`, TEMP: 'tmp', TMP: 'tmp', TMPDIR: 'tmp',
    WAIFU_LOCAL_DIR: 'local', WAIFU_DATA_DIR: 'data', SELFIE_USER_DATA_DIR: 'userdata' };
  for (const [key, relative] of Object.entries(locations)) {
    env[key] = path.join(runRoot, relative);
    fs.mkdirSync(env[key], { recursive: true });
  }
  env.WAIFU_TEST_RUN_ROOT = runRoot;
  env.WAIFU_TEST_SOURCE_ROOT = sourceRoot;
  env.WAIFU_TEST_REPO_ROOT = path.resolve(repoRoot);
  env.WAIFU_TEST_REAL_HOME = os.homedir();
  env.DOTENV_CONFIG_PATH = path.join(runRoot, 'empty.env');
  fs.writeFileSync(env.DOTENV_CONFIG_PATH, '');
  env.GIT_CONFIG_GLOBAL = path.join(runRoot, 'empty.gitconfig');
  env.GIT_CONFIG_NOSYSTEM = '1';
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  env.NODE_OPTIONS = `--require ${JSON.stringify(path.join(sourceRoot, 'server/tests/testSetup.cjs'))}`;
  const selected = process.argv.slice(2);
  const testFiles = selected.length ? selected : fs.readdirSync(path.join(sourceRoot, 'server/tests'))
    .filter(name => name.endsWith('.test.js')).sort().map(name => `server/tests/${name}`);
  if (testFiles.some(file => !/^server\/tests\/[A-Za-z0-9_.-]+\.test\.js$/.test(file))) {
    throw new Error('Select test files using server/tests/<name>.test.js.');
  }
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...testFiles], {
    cwd: sourceRoot, env, stdio: 'inherit', windowsHide: true,
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
} finally {
  fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
