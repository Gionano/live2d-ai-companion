import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const runRoot = process.env.WAIFU_TEST_RUN_ROOT;
const sourceRoot = process.env.WAIFU_TEST_SOURCE_ROOT;
const withinRun = value => value && !path.relative(runRoot, value).startsWith('..');

test('global setup uses temporary home, config, data and local paths without machine overrides', () => {
  assert.ok(runRoot, 'Use npm test to enable the global setup.');
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME',
    'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'WAIFU_LOCAL_DIR', 'WAIFU_DATA_DIR', 'SELFIE_USER_DATA_DIR']) {
    assert.ok(withinRun(process.env[key]), `${key} must be temporary`);
  }
  assert.ok(withinRun(os.homedir()));
  assert.ok(withinRun(os.tmpdir()));
  for (const name of ['selfie.config.local.json', 'providers.config.local.json', '.env', '.git']) {
    assert.equal(fs.existsSync(path.join(sourceRoot, name)), false);
  }
  assert.equal(Object.keys(process.env).some(key => /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)), false);
  assert.ok(process.env.NODE_OPTIONS.includes('testSetup.cjs'));
});

for (const [name, script] of [
  ['checkout reads', "fs.readFileSync(path.join(process.env.WAIFU_TEST_REPO_ROOT, 'package.json'))"],
  ['checkout writes', "fs.writeFileSync(path.join(process.env.WAIFU_TEST_REPO_ROOT, 'waifu-guard-forbidden-' + process.pid + '.txt'), 'no', { flag: 'wx' })"],
  ['home reads', "fs.existsSync(path.join(process.env.WAIFU_TEST_REAL_HOME, 'private-config'))"],
  ['home writes', "fs.mkdirSync(path.join(process.env.WAIFU_TEST_REAL_HOME, 'waifu-guard-forbidden-' + process.pid))"],
  ['source writes', "fs.writeFileSync(path.join(process.env.WAIFU_TEST_SOURCE_ROOT, 'forbidden.txt'), 'no')"],
  ['callback reads', "fs.readFile(path.join(process.env.WAIFU_TEST_REPO_ROOT, 'package.json'), () => {})"],
  ['stream reads', "fs.createReadStream(path.join(process.env.WAIFU_TEST_REPO_ROOT, 'package.json'))"],
  ['promise reads', "await fs.promises.readFile(path.join(process.env.WAIFU_TEST_REPO_ROOT, 'package.json'))"],
  ['file descriptor opens', "fs.openSync(path.join(process.env.WAIFU_TEST_REPO_ROOT, 'package.json'), 'r')"],
  ['extended-length checkout reads', "fs.readFileSync(path.toNamespacedPath(path.join(process.env.WAIFU_TEST_REPO_ROOT, 'package.json')))"],
  ['hard links to immutable sources', "fs.linkSync(path.join(process.env.WAIFU_TEST_SOURCE_ROOT, 'package.json'), path.join(process.env.TMP, 'forbidden-link.json'))"],
  ['writes through the dependency junction', "fs.writeFileSync(path.join(process.env.WAIFU_TEST_SOURCE_ROOT, 'node_modules', 'waifu-guard-forbidden-' + process.pid + '.txt'), 'no', { flag: 'wx' })"],
  ['writes through a source junction', `
    const alias = path.join(process.env.TMP, 'source-junction');
    fs.symlinkSync(process.env.WAIFU_TEST_SOURCE_ROOT, alias, process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(path.join(alias, 'package.json'), 'no');
  `],
]) {
  test(`global guard fails the subprocess after swallowed ${name}`, () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import fs from 'node:fs'; import path from 'node:path'; try { ${script}; } catch {}`],
    { encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /TEST_FILESYSTEM_ISOLATION/);
  });
}

test('global guard protects named filesystem imports and propagates to grandchildren', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { spawnSync } from 'node:child_process';
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      "import { readFileSync } from 'node:fs'; try { readFileSync(process.env.WAIFU_TEST_REPO_ROOT + '/package.json'); } catch {}"],
    { encoding: 'utf8' });
    process.stderr.write(child.stderr);
    process.exitCode = child.status;
  `], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /TEST_FILESYSTEM_ISOLATION/);
});

test('global guard permits fixture IO and immutable source reads', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-fixture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'value.txt');
  fs.writeFileSync(filename, 'fixture');
  assert.equal(fs.readFileSync(filename, 'utf8'), 'fixture');
  fs.writeFileSync(path.toNamespacedPath(filename), 'extended fixture');
  assert.equal(fs.readFileSync(filename, 'utf8'), 'extended fixture');
  assert.equal(JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).type, 'module');
});
