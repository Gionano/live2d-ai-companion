import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { resolveLocalSelfieOutputDir } from '../../../desktop-companion/src/main/selfieOutputDir.js';

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

// Exercise the backend loader with a fixture root while retaining its actual resolution rules.
function serverOutputDir(serverRoot) {
  const source = fs.readFileSync(new URL('../config.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^export const ROOT_DIR = .*;$/m, '')
    .replace(/^export /gm, '');
  const context = vm.createContext({ fs, os, path, ROOT_DIR: serverRoot });
  vm.runInContext(source, context, { filename: 'server-selfie-config.js' });
  return context.loadSelfieConfig().outputDir;
}

test('development gallery folder matches backend default, absolute, relative, and home paths', (t) => {
  const f = fixture(t);
  for (const outputDir of ['', '  ', path.join(f.serverRoot, 'absolute-photos'), 'photos', '../shared-photos',
    '~', '~/Pictures/CustomSelfies', '~\\Pictures\\CustomSelfies']) {
    f.write({ outputDir, provider: 'comfyui', comfyUrl: 'http://private-provider', privateSetting: '/private/path' });
    const expected = serverOutputDir(f.serverRoot);
    assert.equal(resolveLocalSelfieOutputDir({ serverRoot: f.serverRoot }), expected, `development: ${outputDir}`);
  }
});

test('missing development config follows backend defaults', (t) => {
  const f = fixture(t);
  const expected = serverOutputDir(f.serverRoot);
  assert.equal(resolveLocalSelfieOutputDir({ serverRoot: f.serverRoot }), expected);
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
  }
});
