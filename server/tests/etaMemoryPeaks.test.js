import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { etaStore, normalizeMemoryPeaks } from '../selfie/etaStore.js';

test('memory history normalizes shared GPU measurements without fabricating unavailable values', () => {
  assert.equal(normalizeMemoryPeaks({ sharedGpuUsedGB: 1.5 }).sharedGpuUsedGB, 1.5);
  assert.equal(normalizeMemoryPeaks({ sharedGpuUsedGB: 0 }).sharedGpuUsedGB, 0);
  for (const sharedGpuUsedGB of [undefined, null, -1, '1', NaN, Infinity]) {
    assert.equal(normalizeMemoryPeaks({ sharedGpuUsedGB }).sharedGpuUsedGB, null);
  }
});

test('shared GPU peaks persist through bounded history and legacy entries remain readable', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selfie shared GPU history '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'durations.json');
  fs.writeFileSync(filePath, JSON.stringify({ cepat: [1000], _peaks: { cepat: [{ vramUsedGB: 2 }] } }));
  assert.equal(etaStore.getLastPeaks('cepat', filePath).sharedGpuUsedGB, null);
  etaStore.recordPeaks('cepat', { vramUsedGB: 3, sharedGpuUsedGB: 1.5 }, filePath, 2);
  assert.equal(etaStore.getLastPeaks('cepat', filePath).sharedGpuUsedGB, 1.5);
  etaStore.recordPeaks('cepat', { sharedGpuUsedGB: 0 }, filePath, 2);
  const history = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(history.cepat, [1000]);
  assert.deepEqual(history._peaks.cepat.map(entry => entry.sharedGpuUsedGB), [1.5, 0]);
  assert.equal(etaStore.getEta('cepat', filePath), 1);
});
