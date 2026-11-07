import test from 'node:test';
import assert from 'node:assert/strict';
import { ProactiveVoiceGate } from '../../src/proactiveVoiceGate.js';

const sample = (gate, now, changes = {}) => gate.sample({ active: true, rms: 0.1, now, ...changes });

test('only sustained input above the raised threshold interrupts proactive speech', () => {
  const gate = new ProactiveVoiceGate();
  assert.equal(sample(gate, 0), false);
  assert.equal(sample(gate, 100), false);
  assert.equal(sample(gate, 199), false);
  assert.equal(sample(gate, 200), true);
  assert.equal(sample(gate, 210), false);
});

test('noise spikes, low-level echo and silence cannot accumulate into an interruption', () => {
  const gate = new ProactiveVoiceGate();
  for (const [now, rms] of [[0, 0.07], [100, 0.1], [150, 0], [200, 0.1], [250, 0.07], [300, 0.1]]) {
    assert.equal(sample(gate, now, { rms }), false);
  }
});

test('ordinary replies, mute and invalid levels reset the proactive gate', () => {
  for (const changes of [{ active: false }, { muted: true }, { rms: NaN }, { now: NaN }]) {
    const gate = new ProactiveVoiceGate();
    sample(gate, 0); sample(gate, 100);
    assert.equal(sample(gate, 150, changes), false);
    assert.equal(sample(gate, 200), false);
    assert.equal(sample(gate, 300), false);
    assert.equal(sample(gate, 400), true);
  }
});

test('a suspended frame loop or clock rewind cannot count as continuous voice activity', () => {
  const gate = new ProactiveVoiceGate();
  sample(gate, 0); sample(gate, 100);
  assert.equal(sample(gate, 500), false);
  assert.equal(sample(gate, 550), false);
  assert.equal(sample(gate, 20), false);
  assert.equal(sample(gate, 120), false);
  assert.equal(sample(gate, 220), true);
});
