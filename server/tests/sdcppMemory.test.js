import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  SdCppMemoryMonitor, parseNvidiaMemory, parseWindowsMemory, sumWindowsSharedGpuBytes, runCommand,
} from '../selfie/sdcppMemory.js';

const GB = 1024 ** 3;
const EMPTY_PEAKS = {
  vramUsedGB: null, privateBytesGB: null, peakWorkingSetGB: null,
  commitUsedGB: null, commitLimitGB: null, sharedGpuUsedGB: null,
};

test('managed warm-job telemetry samples current working set without prior child lifetime peaks', async () => {
  const scripts = [];
  for (const workingSetMode of ['current', 'peak']) {
    const monitor = new SdCppMemoryMonitor({ telemetry: { probeTimeoutMs: 100 } }, {
      platform: 'win32', workingSetMode,
      runCommand: async (_command, args) => {
        scripts.push(args.at(-1));
        return { code: 0, stdout: JSON.stringify({ peakWorkingSetBytes: 1024 ** 3 }), stderr: '' };
      },
    });
    assert.equal((await monitor._windowsMemory(undefined, 123)).peakWorkingSetGB, 1);
  }
  assert.match(scripts[0], /\$e15Process\.WorkingSet64/);
  assert.doesNotMatch(scripts[0], /\$e15Process\.PeakWorkingSet64/);
  assert.match(scripts[1], /\$e15Process\.PeakWorkingSet64/);
});

function config(overrides = {}) {
  return {
    sdcpp: {
      offloadToCpu: true,
      memory: { minFreeRamGB: 4, minFreeVramGB: 1, commitHeadroomGB: 8 },
      ...overrides.sdcpp,
    },
    telemetry: { enabled: true, intervalMs: 2000, probeTimeoutMs: 100, ...overrides.telemetry },
  };
}

function windowsOutput({ free = 24, limit = 40, privateBytes = 2, workingSet = 3, sharedGpu = null } = {}) {
  return JSON.stringify({
    commitLimitBytes: limit * GB, commitFreeBytes: free * GB,
    privateBytes: privateBytes * GB, peakWorkingSetBytes: workingSet * GB,
    sharedGpuBytes: sharedGpu === null ? null : sharedGpu * GB,
  });
}

function monitor({ freeRam = 16, availableRam = freeRam, gpu = 'NVIDIA Test GPU, 4096, 16384', windows = windowsOutput(), ...overrides } = {}) {
  const calls = [];
  const instance = new SdCppMemoryMonitor(config(overrides.config), {
    platform: 'win32',
    freeMemory: () => freeRam * GB,
    availableMemory: () => availableRam * GB,
    totalMemory: () => 32 * GB,
    stat: async () => ({ size: GB }),
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: command.startsWith('nvidia-smi') ? gpu : windows };
    },
    ...overrides.dependencies,
  });
  return { monitor: instance, calls };
}

async function flush() {
  for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve));
}

test('NVIDIA CSV parsing converts MiB, handles multiple named devices, and ignores malformed rows', () => {
  assert.deepEqual(parseNvidiaMemory('name, memory.used [MiB], memory.total [MiB]\n'
    + 'NVIDIA A, 2048, 8192\r\nNVIDIA B, 512 MiB, 4096 MiB\n'
    + 'N/A, N/A\n9, 4\n-1, 20\n'), [
    { name: 'NVIDIA A', usedGB: 2, totalGB: 8, freeGB: 6 },
    { name: 'NVIDIA B', usedGB: 0.5, totalGB: 4, freeGB: 3.5 },
  ]);
  assert.deepEqual(parseNvidiaMemory('1024, 4096'), [{ usedGB: 1, totalGB: 4, freeGB: 3 }]);
});

test('Windows parsing converts byte process metrics and KiB virtual-memory values without fabricating unavailable values', () => {
  assert.deepEqual(parseWindowsMemory({
    PrivateMemorySize64: 2 * GB, PeakWorkingSet64: 3 * GB,
    TotalVirtualMemorySize: 40 * GB / 1024, FreeVirtualMemory: 24 * GB / 1024,
  }), { privateBytesGB: 2, peakWorkingSetGB: 3, commitUsedGB: 16, commitLimitGB: 40, commitHeadroomGB: 24,
    availableRamGB: null, freeRamGB: null, sharedGpuUsedGB: null });
  assert.equal(parseWindowsMemory('not JSON'), null);
  assert.equal(parseWindowsMemory('[]'), null);
  assert.equal(parseWindowsMemory(null), null);
  assert.deepEqual(parseWindowsMemory('{"commitLimitBytes":10,"commitFreeBytes":20}'), {
    privateBytesGB: null, peakWorkingSetGB: null, commitUsedGB: null, commitLimitGB: null, commitHeadroomGB: null,
    availableRamGB: null, freeRamGB: null, sharedGpuUsedGB: null,
  });
});

test('shared GPU counters aggregate only the child PID across adapters without double-counting instances', () => {
  const instances = [
    { Name: 'pid_123_luid_a_phys_0', SharedUsage: GB },
    { Name: 'pid_123_luid_b_phys_1', SharedUsage: 0.5 * GB },
    { Name: 'PID_123_LUID_A_PHYS_0', SharedUsage: GB },
    { Name: 'pid_1234_luid_a_phys_0', SharedUsage: 9 * GB },
    { Name: 'pid_456_luid_b_phys_1', SharedUsage: 9 * GB },
    { Name: '_Total', SharedUsage: 20 * GB },
  ];
  assert.equal(sumWindowsSharedGpuBytes(instances, 123), 1.5 * GB);
  assert.equal(parseWindowsMemory({ sharedGpuInstances: instances }, 123).sharedGpuUsedGB, 1.5);
  assert.equal(sumWindowsSharedGpuBytes(instances, 789), null);
  assert.equal(sumWindowsSharedGpuBytes(instances, '123'), null);
  assert.equal(sumWindowsSharedGpuBytes({ Name: 'pid_123_adapter', SharedUsage: 0 }, 123), 0);
  assert.equal(sumWindowsSharedGpuBytes([{ Name: 'pid_123_adapter', SharedUsage: 'N/A' }], 123), null);
});

test('Windows shared GPU byte parsing distinguishes measured zero from unavailable counters', () => {
  assert.equal(parseWindowsMemory({ sharedGpuBytes: 1.25 * GB }).sharedGpuUsedGB, 1.25);
  assert.equal(parseWindowsMemory({ sharedGpuBytes: 0 }).sharedGpuUsedGB, 0);
  for (const sharedGpuBytes of [undefined, null, '', false, -1, 'N/A']) {
    assert.equal(parseWindowsMemory({ sharedGpuBytes }).sharedGpuUsedGB, null);
  }
  assert.equal(parseWindowsMemory({ sharedGpuInstances: [] }, 123).sharedGpuUsedGB, null);
});

test('Windows telemetry scopes optional GPUProcessMemory counters and survives unsupported counters', async () => {
  const { monitor: probe, calls } = monitor({
    windows: JSON.stringify({
      ...JSON.parse(windowsOutput()),
      sharedGpuInstances: [
        { Name: 'pid_123_luid_a_phys_0', SharedUsage: 0.75 * GB },
        { Name: 'pid_123_luid_b_phys_1', SharedUsage: 0.25 * GB },
        { Name: 'pid_1234_luid_a_phys_0', SharedUsage: 7 * GB },
      ],
    }),
  });
  const result = await probe._windowsMemory(undefined, 123);
  assert.equal(result.sharedGpuUsedGB, 1);
  const script = calls[0].args.at(-1);
  assert.match(script, /Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory/);
  assert.match(script, /Name -like 'pid_123_\*'/);
  assert.match(script, /Select-Object Name, SharedUsage/);
  assert.match(script, /try \{[\s\S]*\} catch \{ \}/);
  const unavailable = monitor({ windows: windowsOutput() });
  const missing = await unavailable.monitor._windowsMemory(undefined, 123);
  assert.equal(missing.sharedGpuUsedGB, null);
  assert.equal(missing.peakWorkingSetGB, 3);
  await unavailable.monitor.preflight({ modelSizes: [] });
  assert.equal(unavailable.calls.filter(call => call.command === 'powershell.exe').at(-1).args.at(-1)
    .includes('GPUProcessMemory'), false);
});

test('Windows commit counters override virtual-memory estimates and fall back only as a complete pair', () => {
  const fallback = JSON.parse(windowsOutput({ free: 24, limit: 40 }));
  const preferred = parseWindowsMemory({ ...fallback, perfCommitLimitBytes: 48 * GB, perfCommittedBytes: 30 * GB });
  assert.equal(preferred.commitLimitGB, 48);
  assert.equal(preferred.commitUsedGB, 30);
  assert.equal(preferred.commitHeadroomGB, 18);
  const raw = parseWindowsMemory({ CommitLimit: 48 * GB, CommittedBytes: 48 * GB });
  assert.equal(raw.commitHeadroomGB, 0);
  assert.equal(raw.commitUsedGB, 48);
  for (const counters of [
    {}, { perfCommitLimitBytes: 48 * GB }, { perfCommittedBytes: 30 * GB },
    { perfCommitLimitBytes: 0, perfCommittedBytes: 0 },
    { perfCommitLimitBytes: 48 * GB, perfCommittedBytes: 50 * GB },
  ]) {
    const result = parseWindowsMemory({ ...fallback, ...counters });
    assert.equal(result.commitLimitGB, 40);
    assert.equal(result.commitHeadroomGB, 24);
    assert.equal(result.commitUsedGB, 16);
  }
});

test('preflight and telemetry use actual Windows commit counters through the same probe', async () => {
  const { monitor: probe, calls } = monitor({
    windows: JSON.stringify({
      ...JSON.parse(windowsOutput({ free: 24, limit: 40 })),
      perfCommitLimitBytes: 48 * GB, perfCommittedBytes: 44 * GB,
    }),
    dependencies: { setInterval: () => ({}), clearInterval: () => {} },
  });
  const result = await probe.preflight({ modelSizes: [4 * GB] });
  assert.equal(result.commitHeadroomGB, 4);
  assert.equal(result.memoryTier, 'insufficient');
  assert.deepEqual(result.hardFailedRequirements, ['commit']);
  const sampler = probe.start(123);
  await flush();
  const peaks = sampler.stop();
  assert.equal(peaks.commitUsedGB, 44);
  assert.equal(peaks.commitLimitGB, 48);
  const scripts = calls.filter(call => call.command === 'powershell.exe').map(call => call.args.at(-1));
  assert.equal(scripts.length, 2);
  for (const script of scripts) {
    assert.match(script, /Win32_PerfFormattedData_PerfOS_Memory/);
    assert.match(script, /perfCommitLimitBytes = \$e15Memory\.CommitLimit/);
    assert.match(script, /perfCommittedBytes = \$e15Memory\.CommittedBytes/);
    assert.match(script, /FreeVirtualMemory \* 1KB/);
  }
});

test('heuristic memory preflight distinguishes ok, tight, and insufficient available RAM', async () => {
  for (const [freeRam, tier] of [[16, 'ok'], [3, 'tight'], [2, 'insufficient']]) {
    const { monitor: probe } = monitor({ freeRam });
    const result = await probe.preflight({ backend: 'cuda', deviceName: 'NVIDIA Test GPU', modelSizes: [4 * GB] });
    assert.equal(result.memoryTier, tier);
    assert.equal(result.heuristic, true);
    assert.equal(result.estimatedNeedGB, 4);
    assert.match(result.message, /Heuristic memory preflight/);
  }
});

test('model-size estimates warn rather than refuse when RAM has at least the hard-fail ratio', async () => {
  const { monitor: probe } = monitor();
  const result = await probe.preflight({ modelSizes: { diffusionModel: 12 * GB, llm: 8 * GB } });
  assert.equal(result.estimatedNeedGB, 20);
  assert.equal(result.requirements.ramGB, 20);
  assert.equal(result.memoryTier, 'tight');
  assert.deepEqual(result.failedRequirements, ['RAM', 'VRAM']);
  assert.deepEqual(result.hardFailedRequirements, []);
});

test('preflight uses largest component plus compute buffers when offloaded and sum when resident', async () => {
  const { monitor: probe } = monitor();
  const offloaded = await probe.preflight({ modelSizes: [6 * GB, 4 * GB], offloadToCpu: true });
  const resident = await probe.preflight({ modelSizes: [6 * GB, 4 * GB], offloadToCpu: false });
  assert.equal(offloaded.memoryTier, 'ok');
  assert.equal(offloaded.requirements.vramGB, 8.5);
  assert.equal(offloaded.requirements.ramGB, 10);
  assert.equal(offloaded.requirements.commitGB, 12);
  assert.equal(offloaded.largestComponentGB, 6);
  assert.equal(resident.memoryTier, 'ok');
  assert.equal(resident.requirements.vramGB, 10);
  assert.equal(resident.requirements.ramGB, 4);
  assert.equal(resident.requirements.commitGB, 12);
  const { monitor: committed } = monitor({ windows: windowsOutput({ free: 4 }) });
  const result = await committed.preflight({ modelSizes: [4 * GB] });
  assert.equal(result.memoryTier, 'insufficient');
  assert.deepEqual(result.hardFailedRequirements, ['commit']);
  assert.match(result.message, /commit headroom 4\.0 GB free/);
});

for (const resource of ['RAM', 'VRAM', 'commit']) {
  test(`preflight ${resource} tier boundaries include the hard-fail ratio and full need`, async () => {
    for (const [available, tier] of [[0, 'insufficient'], [5.999, 'insufficient'], [6, 'tight'], [9.999, 'tight'], [10, 'ok']]) {
      const { monitor: probe } = monitor({
        availableRam: resource === 'RAM' ? available : 20,
        gpu: `NVIDIA Test GPU, ${(resource === 'VRAM' ? 20 - available : 0) * 1024}, 20480`,
        windows: windowsOutput({ free: resource === 'commit' ? available : 20 }),
        config: { sdcpp: { memory: {
          minFreeRamGB: 0, minFreeVramGB: 0, commitHeadroomGB: 0,
          computeBufferGB: 4, marginGB: 0, hardFailRatio: 0.6,
        } } },
      });
      const result = await probe.preflight({ backend: 'cuda', modelSizes: [6 * GB, 4 * GB] });
      assert.equal(result.memoryTier, tier, `${resource}: ${available} GB available`);
      const check = result.checks.find(entry => entry.name === resource);
      assert.equal(check.requiredGB, 10);
      assert.ok(Math.abs(check.ratio - available / 10) < 1e-9);
      assert.equal(check.tier, tier);
      assert.deepEqual(result.failedRequirements, available < 10 ? [resource] : []);
      assert.deepEqual(result.hardFailedRequirements, tier === 'insufficient' ? [resource] : []);
    }
  });
}

test('preflight configurable compute buffers, commit margin, and hard-fail ratio affect independent needs', async () => {
  const { monitor: probe } = monitor({ availableRam: 7, config: { sdcpp: { memory: {
    minFreeRamGB: 0, minFreeVramGB: 0, commitHeadroomGB: 0,
    computeBufferGB: 1, marginGB: 3, hardFailRatio: 0.8,
  } } } });
  const result = await probe.preflight({ modelSizes: [6 * GB, 4 * GB] });
  assert.deepEqual(result.requirements, { ramGB: 10, vramGB: 7, commitGB: 13 });
  assert.equal(result.hardFailRatio, 0.8);
  assert.equal(result.memoryTier, 'insufficient');
  assert.deepEqual(result.hardFailedRequirements, ['RAM']);
  assert.match(result.message, /hard failed \(below 80% of need\): RAM/);
});

test('available RAM including standby is used for admission while strictly free RAM is logged separately', async () => {
  const { monitor: probe } = monitor({ freeRam: 1, availableRam: 12 });
  const result = await probe.preflight({ modelSizes: [6 * GB, 4 * GB] });
  assert.equal(result.freeRamGB, 1);
  assert.equal(result.availableRamGB, 12);
  assert.equal(result.memoryTier, 'ok');
  assert.match(result.message, /RAM 12\.0 GB available \(1\.0 GB free\)/);
  assert.deepEqual(result.failedRequirements, []);
});

test('Windows available and free counters override OS fallbacks without conflating standby with free pages', async () => {
  const { monitor: probe, calls } = monitor({ freeRam: 2, availableRam: 2, windows: JSON.stringify({
    ...JSON.parse(windowsOutput()), availablePhysicalBytes: 12 * GB, freePhysicalBytes: GB,
  }) });
  const result = await probe.preflight({ modelSizes: [6 * GB, 4 * GB] });
  assert.equal(result.availableRamGB, 12);
  assert.equal(result.freeRamGB, 1);
  assert.equal(result.memoryTier, 'ok');
  const script = calls.find(call => call.command === 'powershell.exe').args.at(-1);
  assert.match(script, /Win32_PerfFormattedData_PerfOS_Memory/);
  assert.match(script, /AvailableBytes/);
  assert.match(script, /FreeAndZeroPageListBytes/);
});

test('missing available-memory probe is tight and unknown strictly free memory never blocks', async () => {
  const { monitor: unknown } = monitor({ dependencies: {
    availableMemory: () => null, freeMemory: () => null,
  } });
  const result = await unknown.preflight({ modelSizes: [4 * GB] });
  assert.equal(result.memoryTier, 'tight');
  assert.equal(result.availableRamGB, null);
  assert.equal(result.freeRamGB, null);
  assert.deepEqual(result.failedRequirements, []);
  assert.match(result.message, /RAM unavailable \(free unavailable\)/);
  const { monitor: available } = monitor({ dependencies: { freeMemory: () => null } });
  const known = await available.preflight({ modelSizes: [4 * GB] });
  assert.equal(known.memoryTier, 'ok');
  assert.equal(known.freeRamGB, null);
});

test('CPU mode stages all weights in RAM and skips the GPU requirement with offload disabled', async () => {
  const { monitor: probe } = monitor();
  const result = await probe.preflight({ backend: 'cpu', modelSizes: [6 * GB, 4 * GB], offloadToCpu: false });
  assert.deepEqual(result.requirements, { ramGB: 10, vramGB: 0, commitGB: 12 });
  assert.deepEqual(result.checks.map(check => check.name), ['RAM', 'commit']);
  assert.equal(result.memoryTier, 'ok');
});

test('preflight checks the selected GPU instead of the largest or first unrelated GPU', async () => {
  const { monitor: probe } = monitor({ gpu: 'NVIDIA A, 8100, 8192\nNVIDIA B, 1024, 16384' });
  const selected = await probe.preflight({ deviceName: 'NVIDIA B', modelSizes: [4 * GB] });
  assert.equal(selected.freeVramGB, 15);
  assert.equal(selected.memoryTier, 'ok');
  const unmatched = await probe.preflight({ deviceName: 'AMD Vulkan GPU', modelSizes: [4 * GB] });
  assert.equal(unmatched.freeVramGB, null);
  assert.equal(unmatched.memoryTier, 'tight');
});

test('a device index disambiguates identical NVIDIA device names', async () => {
  const { monitor: probe } = monitor({ gpu: 'NVIDIA Test GPU, 8100, 8192\nNVIDIA Test GPU, 1024, 16384' });
  const result = await probe.preflight({ deviceName: 'NVIDIA Test GPU', deviceIndex: 1, modelSizes: [4 * GB] });
  assert.equal(result.freeVramGB, 15);
  assert.equal(result.memoryTier, 'ok');
});

test('unavailable GPU and Windows probes degrade to tight with null metrics rather than refusal', async () => {
  const { monitor: probe } = monitor({ dependencies: { runCommand: async () => { throw new Error('Command missing'); } } });
  const result = await probe.preflight({ modelSizes: [4 * GB] });
  assert.equal(result.memoryTier, 'tight');
  assert.equal(result.freeVramGB, null);
  assert.equal(result.commitHeadroomGB, null);
  assert.match(result.message, /VRAM unavailable/);
});

test('Windows probes stay behind platform checks and CPU mode omits GPU memory', async () => {
  const calls = [];
  const { monitor: probe } = monitor({ dependencies: {
    platform: 'linux', runCommand: async command => { calls.push(command); throw new Error('Must not run'); },
  } });
  const result = await probe.preflight({ backend: 'cpu', modelSizes: [4 * GB] });
  assert.deepEqual(calls, []);
  assert.equal(result.memoryTier, 'ok');
  assert.equal(result.freeVramGB, null);
  assert.equal(result.commitHeadroomGB, null);
});

test('model-size probes preserve paths with spaces and avoid duplicate models', async () => {
  const paths = [];
  const model = path.win32.join('X:', '/', 'Path With Spaces', 'diffusion.gguf');
  const { monitor: probe } = monitor({
    config: { sdcpp: { diffusionModel: model, llm: model, vae: path.win32.join('X:', '/', 'Path With Spaces', 'vae.gguf') } },
    dependencies: { stat: async filePath => { paths.push(filePath); return { size: GB }; } },
  });
  const result = await probe.preflight();
  assert.deepEqual(paths, [model, path.win32.join('X:', '/', 'Path With Spaces', 'vae.gguf')]);
  assert.equal(result.estimatedNeedGB, 2);
});

test('preflight remains cancellable when command runners ignore abort', async () => {
  const { monitor: probe } = monitor({ dependencies: { runCommand: () => new Promise(() => {}) } });
  const controller = new AbortController();
  const pending = probe.preflight({ signal: controller.signal, modelSizes: [4 * GB] });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('preflight remains cancellable when an injected model stat never resolves', async () => {
  const { monitor: probe } = monitor({
    config: { sdcpp: { diffusionModel: 'held.gguf' } },
    dependencies: { platform: 'linux', stat: () => new Promise(() => {}) },
  });
  const controller = new AbortController();
  const pending = probe.preflight({ signal: controller.signal, backend: 'cpu' });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('telemetry samples every configured interval and reports independent job peaks', async () => {
  let tick;
  let interval;
  let unscheduled = 0;
  let sampleIndex = 0;
  const samples = [];
  const { monitor: probe } = monitor({ dependencies: {
    setInterval: (callback, intervalMs) => { tick = callback; interval = intervalMs; return {}; },
    clearInterval: () => { unscheduled++; },
    runCommand: async (command, args) => {
      if (command.startsWith('nvidia-smi')) {
        return { code: 0, stdout: `NVIDIA Test GPU, ${sampleIndex ? 6144 : 4096}, 16384` };
      }
      assert.ok(args.at(-1).includes('Get-Process -Id 123'));
      return { code: 0, stdout: windowsOutput(sampleIndex
        ? { free: 20, privateBytes: 1, workingSet: 5, sharedGpu: 1 } : { sharedGpu: 4 }) };
    },
  } });
  const sampler = probe.start(123, { onSample: sample => samples.push(sample), deviceName: 'NVIDIA Test GPU' });
  await flush();
  sampleIndex = 1;
  tick();
  await flush();
  const peaks = sampler.stop();
  assert.equal(interval, 2000);
  assert.equal(unscheduled, 1);
  assert.equal(samples.length, 2);
  assert.deepEqual(peaks, { vramUsedGB: 6, privateBytesGB: 2, peakWorkingSetGB: 5,
    commitUsedGB: 20, commitLimitGB: 40, sharedGpuUsedGB: 4 });
  assert.deepEqual(samples.map(sample => sample.sharedGpuUsedGB), [4, 1]);
  assert.deepEqual(sampler.stop(), peaks);
  assert.equal(unscheduled, 1);
});

test('telemetry command and observer failures never fail the sampler or fabricate zero usage', async () => {
  const { monitor: probe } = monitor({ dependencies: {
    setInterval: () => ({}), clearInterval: () => {},
    runCommand: async () => { throw new Error('Probe unavailable'); },
  } });
  const sampler = probe.start(123, {
    onSample: () => { throw new Error('Observer failed'); },
    onPeaks: () => { throw new Error('Observer failed'); },
  });
  await flush();
  assert.deepEqual(sampler.stop(), EMPTY_PEAKS);
});

test('disabled telemetry does not invoke runners or timers', () => {
  const { monitor: probe } = monitor({
    config: { telemetry: { enabled: false } },
    dependencies: {
      runCommand: () => assert.fail('Telemetry must not run'),
      setInterval: () => assert.fail('Telemetry must not schedule'),
    },
  });
  assert.deepEqual(probe.start(123).stop(), EMPTY_PEAKS);
});

test('sampler stop is synchronous and excludes late results even when runners ignore abort', async () => {
  const pending = [];
  const signals = [];
  let updates = 0;
  let unscheduled = 0;
  const { monitor: probe } = monitor({ dependencies: {
    setInterval: () => ({}), clearInterval: () => { unscheduled++; },
    runCommand: (command, args, { signal }) => new Promise((resolve) => {
      signals.push(signal);
      pending.push(() => resolve({ code: 0, stdout: command.startsWith('nvidia-smi')
        ? 'NVIDIA Test GPU, 1024, 16384' : windowsOutput() }));
    }),
  } });
  const sampler = probe.start(123, { onPeaks: () => { updates++; } });
  await flush();
  const peaks = sampler.stop();
  assert.equal(peaks instanceof Promise, false);
  assert.deepEqual(peaks, EMPTY_PEAKS);
  assert.ok(signals.length > 0 && signals.every(signal => signal.aborted));
  for (const resolve of pending) resolve();
  await flush();
  assert.equal(updates, 0);
  assert.deepEqual(sampler.stop(), EMPTY_PEAKS);
  assert.equal(unscheduled, 1);
});

test('hidden command runner preserves array arguments and paths with spaces', async () => {
  let received;
  const result = await runCommand(path.win32.join('X:', '/', 'Path With Spaces', 'nvidia-smi.exe'), ['--query-gpu=memory.used,memory.total'], {
    spawnProcess: (command, args, options) => {
      received = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => { child.stdout.emit('data', '1024, 4096'); child.emit('close', 0); });
      return child;
    },
  });
  assert.equal(received.command, path.win32.join('X:', '/', 'Path With Spaces', 'nvidia-smi.exe'));
  assert.deepEqual(received.args, ['--query-gpu=memory.used,memory.total']);
  assert.equal(received.options.shell, false);
  assert.equal(received.options.windowsHide, true);
  assert.deepEqual(result, { code: 0, stdout: '1024, 4096', stderr: '' });
});

test('hidden command runner timeout and abort kill the probe without waiting for close', async () => {
  let kills = 0;
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.kill = () => { kills++; };
    return child;
  };
  await assert.rejects(runCommand('fake-probe', [], { spawnProcess, timeoutMs: 5 }), /timed out/);
  const controller = new AbortController();
  const pending = runCommand('fake-probe', [], { spawnProcess, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(kills, 2);
});
