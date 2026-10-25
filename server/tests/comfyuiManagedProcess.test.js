import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ComfyUiManagedProcess, findComfyUiManagedPort, cleanupManagedComfyUiOnStartup } from '../selfie/comfyuiManagedProcess.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fakeComfyUiManaged.cjs', import.meta.url));

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Condition did not become true.');
}

function fixture(t, overrides = {}, deps = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed ComfyUI paths with spaces '));
  const script = path.join(root, 'fake ComfyUI main.cjs');
  fs.copyFileSync(FIXTURE, script);
  const argvLog = path.join(root, 'launch argv.json');
  const helpLog = path.join(root, 'help.log');
  const cfg = { rootDir: root, comfyuiManaged: {
    installDir: root, pythonPath: process.execPath, mainScript: script,
    host: '127.0.0.1', port: 'auto', args: [], env: { FAKE_ARGV_LOG: argvLog, FAKE_HELP_LOG: helpLog },
    startTimeoutMs: 2000, idleStopSeconds: 0.05, healthPath: '/system_stats', profiles: {}, profile: null,
    ...overrides,
  } };
  const children = new Map();
  const warnings = [];
  const events = [];
  const lifecycle = new ComfyUiManagedProcess(cfg, {
    logger: () => {}, warner: message => warnings.push(message), gracefulTimeoutMs: 40,
    processIdentity: async pid => ({ name: path.basename(process.execPath), executablePath: process.execPath,
      commandLine: `${process.execPath} ${script}`, startedAt: `start-${pid}` }),
    onChild: child => { children.set(child.pid, child); },
    onStatus: status => events.push(status),
    killTree: async (pid) => { try { children.get(pid)?.kill(); } catch { /* Already exited. */ } },
    ...deps,
  });
  t.after(async () => { await lifecycle.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { lifecycle, root, script, cfg, argvLog, helpLog, warnings, events, children };
}

test('managed readiness checks paths and cached help without starting a server', async (t) => {
  const { lifecycle, helpLog } = fixture(t);
  assert.equal((await lifecycle.checkReady()).ready, true);
  assert.equal((await lifecycle.checkReady()).ready, true);
  assert.equal(fs.readFileSync(helpLog, 'utf8'), 'help\n');
  assert.equal(lifecycle.getStatus().running, false);
  assert.equal(lifecycle.child, null);
});

test('concurrent managed readiness shares one cached help probe', async (t) => {
  const { lifecycle, helpLog } = fixture(t);
  const results = await Promise.all([lifecycle.checkReady(), lifecycle.checkReady(), lifecycle.checkReady()]);
  assert.ok(results.every(result => result.ready));
  assert.equal(fs.readFileSync(helpLog, 'utf8'), 'help\n');
});

test('managed interpreter help probe has a fixed 15-second timeout and reports launch failure', async (t) => {
  let probe;
  const { lifecycle } = fixture(t, {}, { commandRunner: async (command, args, options) => {
    probe = { command, args, options };
    throw new Error('fake help timed out');
  } });
  const ready = await lifecycle.checkReady();
  assert.equal(ready.ready, false);
  assert.equal(probe.options.timeoutMs, 15000);
  assert.deepEqual(probe.args, [lifecycle.mainScript, '--help']);
  assert.ok(ready.reasons.some(reason => reason.includes('fake help timed out')));
  assert.equal(lifecycle.child, null);
});

test('managed start is hidden without a shell, honors spaces/profile/env and reuses only its child', async (t) => {
  const started = [];
  const spawnOptions = [];
  const { lifecycle, cfg, argvLog, events } = fixture(t, {
    args: ['--known', 'value with spaces'], profiles: { small: { args: ['--lowvram'] } }, profile: 'small',
  }, { onChild: child => started.push(child), spawnProcess: (command, args, options) => {
    spawnOptions.push(options);
    return spawn(command, args, options);
  } });
  const first = await lifecycle.ensureRunning();
  assert.equal(first.reused, false);
  assert.ok(first.coldStartMs >= 0);
  const second = await lifecycle.ensureRunning();
  assert.equal(second.pid, first.pid);
  assert.equal(second.reused, true);
  assert.equal(second.coldStartMs, 0);
  assert.equal(started.length, 1);
  for (const options of spawnOptions) {
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.cwd, cfg.comfyuiManaged.installDir);
  }
  const launched = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
  assert.equal(launched.cwd, cfg.comfyuiManaged.installDir);
  assert.deepEqual(launched.args.slice(-3), ['--known', 'value with spaces', '--lowvram']);
  assert.ok(launched.args.includes('--disable-auto-launch'));
  assert.equal(lifecycle.getStatus().profile, 'small');
  assert.ok(events.some(event => event.running));
  // This test overrides onChild, so use its tracked child to finish cleanup.
  started[0].kill();
  await waitFor(() => !lifecycle.getStatus().running);
});

test('managed idle release stops its child; a new job cancels the pending idle stop', async (t) => {
  const { lifecycle, events } = fixture(t);
  const first = await lifecycle.ensureRunning();
  lifecycle.armIdleStop();
  await new Promise(resolve => setTimeout(resolve, 20));
  const reused = await lifecycle.ensureRunning();
  assert.equal(reused.pid, first.pid);
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(lifecycle.getStatus().running, true);
  lifecycle.armIdleStop();
  await waitFor(() => !lifecycle.getStatus().running);
  assert.ok(events.some(event => !event.running));
  assert.equal(fs.existsSync(lifecycle.stateFile), false);
});

test('auto ports bind zero first and retry excluded ranges and occupied ports', async () => {
  const candidates = [];
  const port = await findComfyUiManagedPort('127.0.0.1', { random: () => 0.25,
    bind: async (host, candidate) => {
      candidates.push({ host, candidate });
      if (candidates.length <= 2) throw Object.assign(new Error('Windows excluded or occupied port'), {
        code: candidates.length === 1 ? 'EACCES' : 'EADDRINUSE',
      });
      return candidate;
    },
  });
  assert.equal(candidates[0].candidate, 0);
  assert.equal(candidates[0].host, '127.0.0.1');
  assert.equal(port, 53248);
  assert.equal(candidates.length, 3);
});

test('managed missing configured interpreter/script names their exact paths', async (t) => {
  const { lifecycle, root } = fixture(t, { pythonPath: 'missing python.exe', mainScript: 'missing main.py' });
  const result = await lifecycle.checkReady();
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes(`comfyuiManaged.pythonPath does not exist: ${path.join(root, 'missing python.exe')}`));
  assert.ok(result.reasons.includes(`comfyuiManaged.mainScript does not exist: ${path.join(root, 'missing main.py')}`));
  await assert.rejects(lifecycle.ensureRunning(), /missing python\.exe.*missing main\.py/);
  assert.equal(lifecycle.child, null);
});

test('managed unknown launch flags and their values are skipped with warnings', async (t) => {
  const { lifecycle, argvLog, warnings } = fixture(t, {
    args: ['--unknown', 'unwanted value', '--known=value with spaces', '--reserve-vram', '-1', '--port', '9999'],
  });
  await lifecycle.ensureRunning();
  const args = JSON.parse(fs.readFileSync(argvLog, 'utf8')).args;
  assert.ok(!args.includes('--unknown'));
  assert.ok(!args.includes('unwanted value'));
  assert.ok(!args.includes('9999'));
  assert.ok(args.includes('--known=value with spaces'));
  assert.ok(args.includes('-1'));
  assert.ok(warnings.some(message => message.includes('--unknown') && message.includes('--help')));
  assert.ok(warnings.some(message => message.includes('--port') && message.includes('app controls')));
});

test('managed startup timeout keeps output diagnostics and kills the owned child', async (t) => {
  const { lifecycle } = fixture(t, { startTimeoutMs: 200,
    env: { FAKE_UNHEALTHY: '1' },
  });
  await assert.rejects(lifecycle.ensureRunning(), /health.*timed out[\s\S]*Child output tail:[\s\S]*FAKE_COMFYUI_LISTENING/);
  assert.equal(lifecycle.getStatus().running, false);
  assert.equal(fs.existsSync(lifecycle.stateFile), false);
});

test('cancel during managed health startup terminates the owned child promptly', async (t) => {
  const { lifecycle } = fixture(t, { env: { FAKE_UNHEALTHY: '1' } });
  const controller = new AbortController();
  const starting = lifecycle.ensureRunning(controller.signal);
  await waitFor(() => lifecycle.getStatus().running);
  controller.abort(new Error('cancel managed startup'));
  await assert.rejects(starting, /cancel managed startup/);
  assert.equal(lifecycle.getStatus().running, false);
});

test('managed cancellation aborts an in-flight help probe without starting ComfyUI', async (t) => {
  let probeSignal;
  const { lifecycle } = fixture(t, {}, { commandRunner: async (command, args, options) => {
    probeSignal = options.signal;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const controller = new AbortController();
  const ready = lifecycle.checkReady(controller.signal);
  await waitFor(() => probeSignal);
  controller.abort(new Error('cancel help'));
  await assert.rejects(ready, /cancel help/);
  assert.equal(probeSignal.aborted, true);
  assert.equal(lifecycle.child, null);
});

test('managed stop never kills an already-exited child PID that may have been reused', async (t) => {
  const kills = [];
  const { lifecycle } = fixture(t, {}, { platform: 'win32', killTree: async (pid, options) => kills.push({ pid, ...options }) });
  await lifecycle.ensureRunning();
  lifecycle.child.kill();
  await waitFor(() => !lifecycle.getStatus().running);
  await lifecycle.stop();
  assert.deepEqual(kills, []);
});

test('managed custom health path is probed and external server is never reused or killed', async (t) => {
  let externalClosed = false;
  const server = http.createServer((request, response) => { response.end('{}'); });
  server.on('close', () => { externalClosed = true; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const externalPort = server.address().port;
  const { lifecycle } = fixture(t, { healthPath: '/custom-health', env: { FAKE_HEALTH_PATH: '/custom-health' } });
  const managed = await lifecycle.ensureRunning();
  assert.notEqual(new URL(managed.baseUrl).port, String(externalPort));
  await lifecycle.stop();
  assert.equal(externalClosed, false);
  assert.equal((await fetch(`http://127.0.0.1:${externalPort}/system_stats`)).ok, true);
});

function writeStaleRecord(root, script, patch = {}) {
  const stateFile = path.join(root, 'data', 'comfyui-managed-process.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ owner: 'amika-comfyui-managed-v1', rootDir: root,
    pid: 876543, backendPid: 876542, backendStartedAt: 'old-backend', pythonPath: process.execPath,
    mainScript: script, startedAt: 'old-child', ...patch }));
}

test('stale owned child is killed only after process name, executable, script and start-time match', async (t) => {
  const killed = [];
  const { lifecycle, root, script } = fixture(t, {}, {
    processIdentity: async pid => pid === 876543 ? { name: path.basename(process.execPath), executablePath: process.execPath,
      commandLine: `${process.execPath} ${script}`, startedAt: 'old-child' } : null,
    killTree: async (pid, options) => killed.push({ pid, ...options }),
  });
  await lifecycle._startup;
  writeStaleRecord(root, script);
  await lifecycle.cleanupStaleProcess();
  assert.deepEqual(killed, [{ pid: 876543, force: true, platform: process.platform }]);
  assert.equal(fs.existsSync(lifecycle.stateFile), false);
});

test('backend startup cleanup works with an explicit external provider without help or spawn', async (t) => {
  const { lifecycle, root, script, cfg, helpLog } = fixture(t);
  await lifecycle.initialize();
  writeStaleRecord(root, script);
  const killed = [];
  const deps = { logger: () => {}, warner: () => {},
    processIdentity: async pid => pid === 876543 ? { name: path.basename(process.execPath), executablePath: process.execPath,
      commandLine: `${process.execPath} ${script}`, startedAt: 'old-child' } : null,
    killTree: async pid => killed.push(pid),
    commandRunner: async () => assert.fail('Startup cleanup must not run --help.'),
    spawnProcess: () => assert.fail('Startup cleanup must not spawn a server.'),
  };
  await cleanupManagedComfyUiOnStartup({ ...cfg, provider: 'comfyui' }, deps);
  await cleanupManagedComfyUiOnStartup({ ...cfg, provider: 'sdcpp' }, deps);
  assert.deepEqual(killed, [876543]);
  assert.equal(fs.existsSync(helpLog), false);
});

test('stale PID process-name mismatch is left untouched and does not block readiness', async (t) => {
  const killed = [];
  const { lifecycle, root, script, warnings } = fixture(t, {}, {
    processIdentity: async pid => pid === 876543 ? { name: 'unrelated.exe', executablePath: process.execPath,
      commandLine: `${process.execPath} ${script}`, startedAt: 'old-child' } : null,
    killTree: async pid => killed.push(pid),
  });
  await lifecycle._startup;
  writeStaleRecord(root, script);
  await lifecycle.cleanupStaleProcess();
  assert.deepEqual(killed, []);
  assert.ok(warnings.some(message => message.includes('leaving it untouched')));
  assert.equal((await lifecycle.checkReady()).ready, true);
});

test('stale PID reuse or a live owning backend prevents killing someone else', async (t) => {
  const killed = [];
  const { lifecycle, root, script } = fixture(t, {}, {
    processIdentity: async pid => pid === 876543 ? { name: path.basename(process.execPath), executablePath: process.execPath,
      commandLine: `${process.execPath} ${script}`, startedAt: 'reused-child' } : null,
    killTree: async pid => killed.push(pid),
  });
  await lifecycle._startup;
  writeStaleRecord(root, script);
  await lifecycle.cleanupStaleProcess();
  assert.deepEqual(killed, []);
  writeStaleRecord(root, script);
  lifecycle.processIdentity = async pid => pid === 876542 ? { startedAt: 'old-backend' } : null;
  await assert.rejects(lifecycle.cleanupStaleProcess(), /backend that is still running/);
  assert.deepEqual(killed, []);
});

test('stale process identity access failure preserves ownership and reports not ready', async (t) => {
  const { lifecycle, root, script } = fixture(t, {}, { processIdentity: async () => { throw new Error('WMI Access denied'); } });
  await lifecycle._startup;
  writeStaleRecord(root, script);
  await assert.rejects(lifecycle.cleanupStaleProcess(), /WMI Access denied/);
  assert.equal(fs.existsSync(lifecycle.stateFile), true);
  const ready = await lifecycle.checkReady();
  assert.equal(ready.ready, false);
  assert.ok(ready.reasons.some(reason => reason.includes('WMI Access denied')));
  assert.equal(lifecycle.child, null);
});

test('managed native process probe denial is reported before spawning a server', async (t) => {
  const { lifecycle } = fixture(t, {}, { platform: 'win32', processIdentity: null,
    commandRunner: async (command, args, options) => {
      if (command === 'powershell.exe') return { code: 1, stdout: '', stderr: 'Get-CimInstance: Access denied' };
      const { runCommand } = await import('../selfie/sdcppMemory.js');
      return runCommand(command, args, options);
    },
  });
  const ready = await lifecycle.checkReady();
  assert.equal(ready.ready, false);
  assert.ok(ready.reasons.some(reason => reason.includes('Windows process identity probe failed') && reason.includes('Access denied')));
  assert.equal(lifecycle.child, null);
});

test('Windows force tree cleanup failure preserves running child and ownership record', async (t) => {
  const { lifecycle, children } = fixture(t, {}, { platform: 'win32', killTree: null,
    commandRunner: async (command, args, options) => {
      if (command === 'taskkill.exe') return { code: 1, stdout: '', stderr: 'Access denied' };
      const { runCommand } = await import('../selfie/sdcppMemory.js');
      return runCommand(command, args, options);
    },
  });
  await lifecycle.ensureRunning();
  await assert.rejects(lifecycle.stop(), /taskkill \/T \/F failed.*ownership record retained.*Access denied/);
  assert.equal(lifecycle.getStatus().running, true);
  assert.equal(fs.existsSync(lifecycle.stateFile), true);
  assert.equal((await lifecycle.checkReady()).ready, false);
  lifecycle.killTree = async pid => { children.get(pid)?.kill(); };
  await lifecycle.stop();
});

test('managed shutdown attempts graceful Windows tree termination before taskkill force', async (t) => {
  const calls = [];
  const { lifecycle } = fixture(t, {}, { platform: 'win32', killTree: null,
    commandRunner: async (command, args, options) => {
      if (command === 'taskkill.exe') {
        calls.push(args);
        if (args.includes('/F')) lifecycle.child?.kill();
        return { code: 0, stdout: '', stderr: '' };
      }
      const { runCommand } = await import('../selfie/sdcppMemory.js');
      return runCommand(command, args, options);
    },
  });
  const started = await lifecycle.ensureRunning();
  await lifecycle.stop();
  assert.deepEqual(calls, [
    ['/PID', String(started.pid), '/T'], ['/PID', String(started.pid), '/T', '/F'],
  ]);
});
