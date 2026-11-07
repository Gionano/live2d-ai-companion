import test from 'node:test';
import assert from 'node:assert/strict';
import { VisionMonitorPresence } from '../visionMonitorPresence.js';

test('bridges require an open dashboard and only the last active monitor can stop capture', () => {
  const changes = [];
  const presence = new VisionMonitorPresence(active => changes.push(active));
  const first = {}, second = {}, unknown = {};
  presence.add(first);
  presence.add(second);
  assert.equal(presence.active, false);
  presence.update(unknown, true);
  presence.update(first, 'on');
  assert.deepEqual(changes, []);
  presence.update(first, true);
  presence.update(second, true);
  presence.update(first, false);
  assert.equal(presence.active, true);
  assert.deepEqual(changes, [true]);
  presence.remove(second);
  assert.equal(presence.active, false);
  assert.deepEqual(changes, [true, false]);
  presence.remove(first);
  presence.add(second);
  assert.equal(presence.active, false);
  presence.update(second, true);
  assert.deepEqual(changes, [true, false, true]);
});
