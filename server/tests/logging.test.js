import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimestampedLogger, formatLogTime } from '../../src/logging.js';

test('log clock uses Jakarta time with milliseconds across midnight, independent of host timezone', () => {
  assert.equal(formatLogTime(new Date('2026-11-07T14:12:23.456Z')), '21:12:23.456 WIB');
  assert.equal(formatLogTime(new Date('2026-11-07T17:00:00.007Z')), '00:00:00.007 WIB');
});

test('timestamped console preserves substitutions, object identity, receivers and original methods', () => {
  const calls = [];
  const target = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(level => [level, function (...args) {
    assert.equal(this, target);
    calls.push({ level, args });
  }]));
  const originalLog = target.log;
  const logger = createTimestampedLogger(target, () => new Date('2026-11-07T14:12:23.456Z'));
  const details = { remainingMs: 60000 };
  logger.log('[vision] %d ms', 20886, details);
  assert.deepEqual(calls[0].args.slice(0, 2), ['[21:12:23.456 WIB] [vision] %d ms', 20886]);
  assert.equal(calls[0].args[2], details);
  for (const level of ['info', 'warn', 'error', 'debug']) logger[level](details);
  assert.deepEqual(calls.map(call => call.level), ['log', 'info', 'warn', 'error', 'debug']);
  assert.equal(calls[1].args[1], details);
  assert.equal(target.log, originalLog);
});
