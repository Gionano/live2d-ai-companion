import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { WITCH_MODEL_PATH } from '../../src/characterModel.js';
import { EMOTION_MAP } from '../../src/expressionMap.js';
import { CONFIG } from '../../desktop-companion/src/main/config.js';

const adapterSource = fs.readFileSync(new URL('../../src/live2dCompanion.js', import.meta.url), 'utf8');
const modelUrl = new URL(`../../public${WITCH_MODEL_PATH}`, import.meta.url);
const manifest = JSON.parse(fs.readFileSync(modelUrl, 'utf8'));

async function managerFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'witch-model-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['server', 'src', 'public/models/魔女', 'public/models/other']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  for (const file of ['server/modelManager.js', 'src/characterModel.js']) {
    fs.copyFileSync(new URL(`../../${file}`, import.meta.url), path.join(root, file));
  }
  fs.writeFileSync(path.join(root, 'server/activeModel.json'), JSON.stringify({ activeModelPath: '/models/other/other.model3.json' }));
  fs.writeFileSync(path.join(root, 'public/models/other/other.model3.json'), JSON.stringify(manifest));
  return { root, manager: await import(pathToFileURL(path.join(root, 'server/modelManager.js'))) };
}

test('stale active-model state and additional assets cannot select a different character', async t => {
  const { root, manager } = await managerFixture(t);
  const file = path.join(root, 'public', WITCH_MODEL_PATH.slice(1));
  fs.writeFileSync(file, JSON.stringify(manifest));
  assert.equal(manager.getActiveModelPath(), WITCH_MODEL_PATH);
  assert.deepEqual(manager.scanAvailableModels().models.map(model => model.modelPath), [WITCH_MODEL_PATH]);
  fs.unlinkSync(file);
  assert.deepEqual(manager.scanAvailableModels(), { models: [], activeModelPath: WITCH_MODEL_PATH });
});

test('every speech emotion has a registered Witch expression even with banks disabled', () => {
  const expressions = new Map(manifest.FileReferences.Expressions.map(item => [item.Name, item.File]));
  assert.equal(expressions.size, 18);
  for (const { expression } of Object.values(EMOTION_MAP)) {
    if (!expression) continue;
    assert.ok(expressions.has(expression), expression);
    const document = JSON.parse(fs.readFileSync(new URL(expressions.get(expression), modelUrl), 'utf8'));
    assert.ok(document.Parameters.length > 0, expression);
  }
});

test('startup loads Witch directly without consulting persisted server selection', async () => {
  const method = adapterSource.slice(adapterSource.indexOf('  async initialize() {'), adapterSource.indexOf('  setupOverlayEditControls() {'));
  const loaded = [];
  const context = vm.createContext({ WITCH_MODEL_PATH, initializeCubism() {}, requestAnimationFrame() {},
    window: { addEventListener() {} }, console });
  vm.runInContext(`class Adapter { ${method} }; globalThis.Adapter = Adapter;`, context);
  const adapter = new context.Adapter();
  Object.assign(adapter, { canvas: { getContext: () => ({}) }, resize() {}, isOverlay: false,
    async switchModel(modelPath) { loaded.push(modelPath); } });
  await adapter.initialize();
  assert.deepEqual(loaded, [WITCH_MODEL_PATH]);
});

test('unsupported model requests are rejected before disposing the active Witch', async () => {
  const method = adapterSource.slice(adapterSource.indexOf('  async switchModel('), adapterSource.indexOf('  getModelInfo() {', adapterSource.indexOf('  async switchModel(')));
  const context = vm.createContext({ WITCH_MODEL_PATH, URL, location: { href: 'http://localhost:5173/', origin: 'http://localhost:5173' } });
  vm.runInContext(`class Adapter { ${method} }; globalThis.Adapter = Adapter;`, context);
  const adapter = new context.Adapter();
  let disposed = false;
  adapter.model = { dispose() { disposed = true; } };
  await assert.rejects(adapter.switchModel('/models/other/other.model3.json'), /Only the Witch/);
  await assert.rejects(adapter.switchModel(`https://example.com${WITCH_MODEL_PATH}`), /Only the Witch/);
  assert.equal(disposed, false);
});

test('Witch overlay state leaves ear and expression parameters unchanged', () => {
  assert.deepEqual(Object.keys(CONFIG.overlay.presets), ['witch']);
  assert.equal(CONFIG.overlay.defaultPreset, 'witch');
  const start = adapterSource.indexOf('  applyOverlayState(overlayState) {');
  const method = adapterSource.slice(start, adapterSource.indexOf('  invalidateOverlayFit(', start));
  const context = vm.createContext({});
  vm.runInContext(`class Model { ${method} }; globalThis.Model = Model;`, context);
  const model = new context.Model();
  let writes = 0;
  model._model = { setParameterValueByIndex() { writes++; } };
  model.ready = true;
  model.measureRestPoseOverlayBounds = () => {};
  model.invalidateOverlayFit = () => {};
  model.applyOverlayState({ activePreset: 'obsolete', presetConfig: CONFIG.overlay.presets.witch });
  assert.equal(model.overlayPresetId, 'witch');
  assert.equal(writes, 0);
});
