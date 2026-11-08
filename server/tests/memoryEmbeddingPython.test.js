import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Python embedding service and pinned download logic pass fake-encoder regressions', t => {
  const script = fileURLToPath(new URL('../embedding/service_test.py', import.meta.url));
  const candidates = process.env.WAIFU_MEMORY_TEST_PYTHON
    ? [{ command: process.env.WAIFU_MEMORY_TEST_PYTHON, args: [] }]
    : process.platform === 'win32' ? [{ command: 'py', args: ['-3.11'] }, { command: 'python', args: [] }]
      : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];
  for (const candidate of candidates) {
    const version = spawnSync(candidate.command, [...candidate.args, '-c', 'import sys;print(sys.version_info.major)'],
      { timeout: 5000, windowsHide: true, encoding: 'utf8' });
    if (version.status !== 0 || version.stdout.trim() !== '3') continue;
    const result = spawnSync(candidate.command, [...candidate.args, script], { timeout: 30000,
      windowsHide: true, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /Ran 16 tests/);
    return;
  }
  t.skip('Python is unavailable; fake-encoder service tests require Python 3.11+.');
});
