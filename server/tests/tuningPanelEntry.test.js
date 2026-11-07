import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('root startup keeps avatar speech cues without mounting the removed tuning panel', () => {
  let initialized = 0;
  let panels = 0;
  const events = new Map();
  const context = vm.createContext({
    document: { getElementById: () => ({}) },
    window: { addEventListener: (name, callback) => events.set(name, callback) },
    initTuningPanel: () => panels++,
    Live2DCompanion: class { initialize() { initialized++; return Promise.resolve(); } },
  });
  const main = fs.readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  vm.runInContext(main.replace(/^import .*;\r?\n/gm, ''), context);
  assert.equal(initialized, 1);
  assert.equal(panels, 0);
  assert.ok(events.has('waifu-speech-cue'));
  const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /tuning-toggle-btn/);
  assert.doesNotMatch(main, /tuningPanel/);
});
