import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadSelfieConfig } from '../selfie/config.js';
import packageSelfieConfig from '../../desktop-companion/scripts/packageSelfieConfig.js';
import { resolveLocalSelfieOutputDir } from '../../desktop-companion/src/main/selfieOutputDir.js';

function fixture(t) {
  const serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'selfie-local-config-'));
  t.after(() => fs.rmSync(serverRoot, { recursive: true, force: true }));
  const configPath = path.join(serverRoot, 'selfie.config.json');
  const projectDir = path.join(serverRoot, 'desktop-companion');
  const appOutDir = path.join(projectDir, 'dist-electron', 'win-unpacked');
  const resourcesPath = path.join(appOutDir, 'resources');
  return { serverRoot, configPath, projectDir, appOutDir, resourcesPath,
    write: value => fs.writeFileSync(configPath, JSON.stringify(value)) };
}

function serverOutputDir(serverRoot) {
  return loadSelfieConfig({}, { repoRoot: serverRoot }).outputDir;
}

test('development and installed gallery folders match backend default, absolute, relative, and home paths', (t) => {
  const f = fixture(t);
  for (const outputDir of ['', '  ', path.join(f.serverRoot, 'absolute-photos'), 'photos', '../shared-photos',
    '~', '~/Pictures/CustomSelfies', '~\\Pictures\\CustomSelfies']) {
    f.write({ outputDir, provider: 'comfyui', comfyUrl: 'http://private-provider', privateSetting: '/private/path' });
    const expected = serverOutputDir(f.serverRoot);
    assert.equal(resolveLocalSelfieOutputDir({ serverRoot: f.serverRoot }), expected, `development: ${outputDir}`);
    packageSelfieConfig({ appOutDir: f.appOutDir, packager: { projectDir: f.projectDir } });
    assert.equal(resolveLocalSelfieOutputDir({ isPackaged: true, resourcesPath: f.resourcesPath }), expected, `installed: ${outputDir}`);
    const bundled = JSON.parse(fs.readFileSync(path.join(f.resourcesPath, 'selfie.config.json'), 'utf8'));
    assert.deepEqual(Object.keys(bundled), ['outputDir']);
    assert.equal(bundled.outputDir, expected);
    if (outputDir === 'photos') assert.equal(bundled.outputDir, path.join(f.serverRoot, 'photos'));
  }
});

test('missing development config follows backend defaults and gets a default installed snapshot', (t) => {
  const f = fixture(t);
  const expected = serverOutputDir(f.serverRoot);
  assert.equal(resolveLocalSelfieOutputDir({ serverRoot: f.serverRoot }), expected);
  packageSelfieConfig({ appOutDir: f.appOutDir, packager: { projectDir: f.projectDir } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.resourcesPath, 'selfie.config.json'), 'utf8')), { outputDir: expected });
  assert.equal(resolveLocalSelfieOutputDir({ isPackaged: true, resourcesPath: f.resourcesPath }), expected);
});

test('main-only local config override keeps an external backend folder when packaged settings differ', (t) => {
  const f = fixture(t);
  f.write({ outputDir: 'current-photos' });
  fs.mkdirSync(f.resourcesPath, { recursive: true });
  fs.writeFileSync(path.join(f.resourcesPath, 'selfie.config.json'), JSON.stringify({ outputDir: 'stale-photos' }));
  const expected = serverOutputDir(f.serverRoot);
  assert.equal(resolveLocalSelfieOutputDir({ isPackaged: true, resourcesPath: f.resourcesPath, configPath: f.configPath }), expected);
  assert.equal(resolveLocalSelfieOutputDir({ serverRoot: path.join(f.serverRoot, 'other-root'), configPath: f.configPath }), expected);
  f.write({ outputDir: 'updated-photos' });
  assert.equal(resolveLocalSelfieOutputDir({ isPackaged: true, resourcesPath: f.resourcesPath, configPath: f.configPath }), serverOutputDir(f.serverRoot));
});

test('chosen config files reject missing, invalid JSON, and malformed directories without fallback', (t) => {
  const f = fixture(t);
  assert.throws(() => resolveLocalSelfieOutputDir({ isPackaged: true, resourcesPath: f.resourcesPath }), /Cannot read local/);
  assert.throws(() => resolveLocalSelfieOutputDir({ serverRoot: f.serverRoot, configPath: f.configPath }), /Cannot read local/);
  assert.throws(() => resolveLocalSelfieOutputDir({ serverRoot: f.serverRoot, configPath: 'relative-config.json' }), /must be absolute/);
  for (const invalid of ['{broken', 'null', '[]', '{"outputDir":null}', '{"outputDir":12}', '{"outputDir":{}}']) {
    fs.writeFileSync(f.configPath, invalid);
    assert.throws(() => resolveLocalSelfieOutputDir({ serverRoot: f.serverRoot }), /Cannot read local|Invalid local/);
    assert.throws(() => resolveLocalSelfieOutputDir({ configPath: f.configPath, isPackaged: true, resourcesPath: f.resourcesPath }), /Cannot read local|Invalid local/);
    assert.throws(() => packageSelfieConfig({ appOutDir: f.appOutDir, packager: { projectDir: f.projectDir } }), /Cannot read local|Invalid local/);
  }
});

test('electron-builder selects the ESM packaging hook that writes the narrow local snapshot', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../desktop-companion/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.build.afterPack, './scripts/packageSelfieConfig.js');
  assert.equal(typeof packageSelfieConfig, 'function');
  assert.equal(manifest.build.files.includes('src/**/*'), true);
  assert.ok(manifest.build.extraResources.some(resource => resource.from === '../server/selfie/localPaths.js'
    && resource.to === 'selfie/localPaths.js'));
});

test('gallery merges machine output paths and LOCAL consistently with the backend', (t) => {
  const f = fixture(t);
  f.write({ outputDir: 'base-photos' });
  fs.writeFileSync(path.join(f.serverRoot, 'selfie.config.local.json'), JSON.stringify({ outputDir: '${LOCAL}/outputs/machine' }));
  const expected = serverOutputDir(f.serverRoot);
  assert.equal(resolveLocalSelfieOutputDir({ serverRoot: f.serverRoot }), expected);
  packageSelfieConfig({ appOutDir: f.appOutDir, packager: { projectDir: f.projectDir } });
  assert.equal(resolveLocalSelfieOutputDir({ isPackaged: true, resourcesPath: f.resourcesPath }), expected);
});

test('gallery reads machine output override when shared development config is absent', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.serverRoot, 'selfie.config.local.json'), JSON.stringify({ outputDir: 'machine-only' }));
  assert.equal(resolveLocalSelfieOutputDir({ serverRoot: f.serverRoot }), serverOutputDir(f.serverRoot));
});

test('packaged gallery loads the bundled single-source resolver without a server checkout', (t) => {
  const f = fixture(t);
  const appDir = path.join(f.serverRoot, 'application');
  const mainDir = path.join(appDir, 'src', 'main');
  fs.mkdirSync(mainDir, { recursive: true });
  fs.mkdirSync(path.join(f.resourcesPath, 'selfie'), { recursive: true });
  fs.copyFileSync(new URL('../../desktop-companion/src/main/selfieOutputDir.js', import.meta.url), path.join(mainDir, 'selfieOutputDir.js'));
  fs.copyFileSync(new URL('../selfie/localPaths.js', import.meta.url), path.join(f.resourcesPath, 'selfie', 'localPaths.js'));
  fs.writeFileSync(path.join(f.serverRoot, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(f.resourcesPath, 'selfie.config.json'), '{"outputDir":"${LOCAL}/outputs"}');
  const probe = path.join(appDir, 'probe.mjs');
  fs.writeFileSync(probe, `process.resourcesPath = ${JSON.stringify(f.resourcesPath)};\n`
    + `const { resolveLocalSelfieOutputDir } = await import('./src/main/selfieOutputDir.js');\n`
    + `console.log(resolveLocalSelfieOutputDir({ isPackaged: true, resourcesPath: process.resourcesPath }));\n`);
  const output = execFileSync(process.execPath, [probe], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(output.trim(), path.join(f.resourcesPath, 'local', 'outputs'));
});
