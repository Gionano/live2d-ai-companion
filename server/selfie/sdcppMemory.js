import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';

const GB = 1024 ** 3;
const DEFAULT_THRESHOLDS = {
  minFreeRamGB: 4, minFreeVramGB: 1, commitHeadroomGB: 8,
  computeBufferGB: 2.5, marginGB: 2, hardFailRatio: 0.6,
};
const PEAK_KEYS = ['vramUsedGB', 'privateBytesGB', 'peakWorkingSetGB', 'commitUsedGB', 'commitLimitGB', 'sharedGpuUsedGB'];
const WINDOWS_MEMORY_PROBE = '$e15Os = Get-CimInstance Win32_OperatingSystem; '
  + '$e15Memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction SilentlyContinue; ';
const WINDOWS_MEMORY_FIELDS = 'availablePhysicalBytes = $e15Memory.AvailableBytes; '
  + 'freePhysicalBytes = $e15Memory.FreeAndZeroPageListBytes; '
  + 'perfCommitLimitBytes = $e15Memory.CommitLimit; perfCommittedBytes = $e15Memory.CommittedBytes; '
  + 'commitLimitBytes = [double]$e15Os.TotalVirtualMemorySize * 1KB; '
  + 'commitFreeBytes = [double]$e15Os.FreeVirtualMemory * 1KB; ';

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
}

function numeric(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function emptyPeaks() {
  return Object.fromEntries(PEAK_KEYS.map(key => [key, null]));
}

function notify(callback, value) {
  try { callback?.(value); } catch { /* Observers cannot affect generation. */ }
}

async function withSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** A bounded, hidden command runner; arguments are never interpreted by a shell. */
export async function runCommand(command, args, {
  signal, timeoutMs = 1500, cwd, env, spawnProcess = spawn,
} = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const kill = () => { try { child?.kill(); } catch { /* Already exited. */ } };
    const onAbort = () => { kill(); finish(abortReason(signal)); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    try {
      child = spawnProcess(command, args, {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd, env,
      });
    } catch (error) {
      finish(error);
      return;
    }
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-65536); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-65536); });
    child.once('error', error => finish(error));
    child.once('close', code => finish(null, { code, stdout, stderr }));
    timer = setTimeout(() => {
      kill();
      finish(new Error(`${command} probe timed out after ${timeoutMs} ms.`));
    }, Math.max(1, timeoutMs));
  });
}

/** Parse nvidia-smi CSV memory values (MiB); malformed/unavailable rows are ignored. */
export function parseNvidiaMemory(output) {
  const devices = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const parts = line.split(',').map(value => value.trim());
    if (parts.length !== 2 && parts.length !== 3) continue;
    const offset = parts.length === 3 ? 1 : 0;
    const values = parts.slice(offset).map(value => {
      const match = /^(\d+(?:\.\d+)?)(?:\s*MiB)?$/.exec(value);
      return match ? Number(match[1]) / 1024 : null;
    });
    const [usedGB, totalGB] = values;
    if (usedGB === null || totalGB === null || usedGB > totalGB || totalGB <= 0) continue;
    devices.push({
      usedGB, totalGB, freeGB: totalGB - usedGB,
      ...(offset && { name: parts[0] }),
    });
  }
  return devices;
}

/** Sum shared GPU usage for one child process across its adapter instances. */
export function sumWindowsSharedGpuBytes(instances, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !instances || typeof instances !== 'object') return null;
  const rows = Array.isArray(instances) ? instances : [instances];
  const prefix = `pid_${pid}_`;
  const usageByInstance = new Map();
  for (const row of rows) {
    const name = typeof row?.Name === 'string' ? row.Name.toLowerCase() : '';
    if (!name.startsWith(prefix)) continue;
    const usage = numeric(row.SharedUsage);
    if (usage === null) return null;
    // Repeated names identify the same adapter instance, so they count once.
    usageByInstance.set(name, Math.max(usageByInstance.get(name) ?? 0, usage));
  }
  if (!usageByInstance.size) return null;
  const total = [...usageByInstance.values()].reduce((sum, usage) => sum + usage, 0);
  return Number.isSafeInteger(total) ? total : null;
}

/** PowerShell emits numeric bytes; raw Win32 virtual-memory properties are KiB. */
export function parseWindowsMemory(output, pid = null) {
  let value;
  try { value = typeof output === 'object' ? output : JSON.parse(String(output).trim()); } catch { return null; }
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  let limit = numeric(value.commitLimitBytes)
    ?? (numeric(value.TotalVirtualMemorySize) === null ? null : Number(value.TotalVirtualMemorySize) * 1024);
  let free = numeric(value.commitFreeBytes)
    ?? (numeric(value.FreeVirtualMemory) === null ? null : Number(value.FreeVirtualMemory) * 1024);
  const perfLimit = numeric(value.perfCommitLimitBytes ?? value.CommitLimit);
  const perfUsed = numeric(value.perfCommittedBytes ?? value.CommittedBytes);
  // Prefer a complete counter pair; never mix its limit with OS virtual-memory free bytes.
  if (perfLimit !== null && perfLimit > 0 && perfUsed !== null && perfUsed <= perfLimit) {
    limit = perfLimit;
    free = perfLimit - perfUsed;
  }
  const privateBytes = numeric(value.privateBytes ?? value.PrivateMemorySize64);
  const workingSet = numeric(value.peakWorkingSetBytes ?? value.PeakWorkingSet64);
  const sharedGpuBytes = numeric(value.sharedGpuBytes) ?? sumWindowsSharedGpuBytes(value.sharedGpuInstances, pid);
  const availablePhysical = numeric(value.availablePhysicalBytes ?? value.AvailableBytes);
  const freePhysical = numeric(value.freePhysicalBytes ?? value.FreeAndZeroPageListBytes);
  const validCommit = limit !== null && limit > 0 && free !== null && free <= limit;
  return {
    privateBytesGB: privateBytes === null ? null : privateBytes / GB,
    peakWorkingSetGB: workingSet === null ? null : workingSet / GB,
    sharedGpuUsedGB: sharedGpuBytes === null ? null : sharedGpuBytes / GB,
    commitUsedGB: validCommit ? (limit - free) / GB : null,
    commitLimitGB: validCommit ? limit / GB : null,
    commitHeadroomGB: validCommit ? free / GB : null,
    availableRamGB: availablePhysical === null ? null : availablePhysical / GB,
    freeRamGB: freePhysical === null ? null : freePhysical / GB,
  };
}

export class SdCppMemoryMonitor {
  constructor(config, {
    runCommand: commandRunner = runCommand,
    platform = process.platform,
    // Windows os.freemem() includes standby pages, so it is an available-memory fallback.
    freeMemory = platform === 'win32' ? () => null : () => os.freemem(),
    availableMemory = async () => {
      if (platform === 'linux') {
        try {
          const contents = await fs.promises.readFile('/proc/meminfo', 'utf8');
          const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(contents);
          if (match) return Number(match[1]) * 1024;
        } catch { /* Fall back to the OS API when meminfo is unavailable. */ }
      }
      return os.freemem();
    },
    totalMemory = () => os.totalmem(),
    stat = filePath => fs.promises.stat(filePath),
    setInterval: schedule = globalThis.setInterval,
    clearInterval: unschedule = globalThis.clearInterval,
    workingSetMode = 'peak',
  } = {}) {
    this.config = config;
    this.runCommand = commandRunner;
    this.platform = platform;
    this.freeMemory = freeMemory;
    this.availableMemory = availableMemory;
    this.totalMemory = totalMemory;
    this.stat = stat;
    this.schedule = schedule;
    this.unschedule = unschedule;
    this.workingSetMode = workingSetMode === 'current' ? 'current' : 'peak';
  }

  get probeTimeoutMs() {
    return Math.max(1, numeric(this.config.telemetry?.probeTimeoutMs) ?? 1500);
  }

  async _command(command, args, signal) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(abortReason(signal));
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    let onAbort;
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => reject(abortReason(controller.signal));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    const timer = setTimeout(() => controller.abort(new Error('Memory probe timed out.')), this.probeTimeoutMs);
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => this.runCommand(command, args, {
          signal: controller.signal, timeoutMs: this.probeTimeoutMs,
        })),
        aborted,
      ]);
      signal?.throwIfAborted();
      return result && (result.code === 0 || result.exitCode === 0) ? result.stdout : null;
    } catch (error) {
      signal?.throwIfAborted();
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  async _gpuMemory(signal, deviceName, deviceIndex) {
    const output = await this._command(this.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi', [
      '--query-gpu=name,memory.used,memory.total', '--format=csv,noheader,nounits',
    ], signal);
    const devices = parseNvidiaMemory(output);
    const namedDevices = devices.some(device => device.name);
    const matches = device => device?.name && String(deviceName).toLowerCase().includes(device.name.toLowerCase());
    const indexed = Number.isSafeInteger(deviceIndex) ? devices[deviceIndex] : null;
    if (deviceName && namedDevices) {
      return (matches(indexed) ? indexed : devices.find(matches)) || null;
    }
    return indexed || devices[0] || null;
  }

  async _windowsMemory(signal, pid = null) {
    if (this.platform !== 'win32') return null;
    const script = (pid === null ? '' : `$e15Process = Get-Process -Id ${pid} -ErrorAction Stop; `)
      + (pid === null ? '' : '$e15GpuProcessMemory = @(); try { '
        + '$e15GpuProcessMemory = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory '
        + `-ErrorAction Stop | Where-Object { $_.Name -like 'pid_${pid}_*' } | Select-Object Name, SharedUsage); `
        + '} catch { }; ')
      + WINDOWS_MEMORY_PROBE + '[pscustomobject]@{ '
      + (pid === null ? '' : 'privateBytes = [double]$e15Process.PrivateMemorySize64; '
        + `peakWorkingSetBytes = [double]$e15Process.${this.workingSetMode === 'current' ? 'WorkingSet64' : 'PeakWorkingSet64'}; `
        + 'sharedGpuInstances = $e15GpuProcessMemory; ')
      + WINDOWS_MEMORY_FIELDS + '} | ConvertTo-Json -Compress';
    const output = await this._command('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], signal);
    return parseWindowsMemory(output, pid);
  }

  async _modelSizes(modelSizes, signal) {
    if (modelSizes !== undefined) {
      const sizes = Array.isArray(modelSizes) ? modelSizes : Object.values(modelSizes || {});
      return sizes.map(size => numeric(size) ?? 0);
    }
    const paths = [...new Set(['diffusionModel', 'vae', 'llm', 'llmVision']
      .map(name => this.config.sdcpp?.[name]).filter(Boolean))];
    const sizes = await withSignal(Promise.all(paths.map(async (filePath) => {
      try { return numeric((await this.stat(filePath)).size) ?? 0; } catch { return 0; }
    })), signal);
    signal?.throwIfAborted();
    return sizes;
  }

  async preflight({ signal, backend, deviceName, deviceIndex, modelSizes, offloadToCpu } = {}) {
    signal?.throwIfAborted();
    const [sizes, gpu, windows] = await Promise.all([
      this._modelSizes(modelSizes, signal),
      backend === 'cpu' ? null : this._gpuMemory(signal, deviceName, deviceIndex),
      this._windowsMemory(signal),
    ]);
    signal?.throwIfAborted();
    let freeRamGB = null;
    let availableRamGB = windows?.availableRamGB ?? null;
    let totalRamGB = null;
    try { freeRamGB = numeric(this.freeMemory()); } catch { /* Probe unavailable. */ }
    try { totalRamGB = numeric(this.totalMemory()); } catch { /* Probe unavailable. */ }
    if (freeRamGB !== null) freeRamGB /= GB;
    freeRamGB = windows?.freeRamGB ?? freeRamGB;
    if (availableRamGB === null) {
      try {
        const available = numeric(await withSignal(Promise.resolve().then(() => this.availableMemory()), signal));
        availableRamGB = available === null ? null : available / GB;
      } catch { signal?.throwIfAborted(); /* Probe unavailable. */ }
    }
    if (totalRamGB !== null) totalRamGB /= GB;
    const estimatedNeedGB = sizes.reduce((sum, size) => sum + size, 0) / GB;
    const largestComponentGB = sizes.reduce((largest, size) => Math.max(largest, size), 0) / GB;
    const configured = this.config.sdcpp?.memory || {};
    const thresholds = Object.fromEntries(Object.entries(DEFAULT_THRESHOLDS)
      .map(([key, fallback]) => [key, numeric(configured[key]) ?? fallback]));
    const hardFailRatio = thresholds.hardFailRatio > 0 && thresholds.hardFailRatio <= 1
      ? thresholds.hardFailRatio : DEFAULT_THRESHOLDS.hardFailRatio;
    const offloaded = offloadToCpu ?? (this.config.sdcpp?.offloadToCpu !== false);
    const requirements = {
      ramGB: Math.max(thresholds.minFreeRamGB, offloaded || backend === 'cpu' ? estimatedNeedGB : 0),
      vramGB: backend === 'cpu' ? 0 : Math.max(thresholds.minFreeVramGB,
        offloaded ? largestComponentGB + thresholds.computeBufferGB : estimatedNeedGB),
      commitGB: Math.max(thresholds.commitHeadroomGB, estimatedNeedGB + thresholds.marginGB),
    };
    const checks = [
      { name: 'RAM', availableGB: availableRamGB, requiredGB: requirements.ramGB },
      ...(backend === 'cpu' ? [] : [{
        name: 'VRAM', availableGB: gpu?.freeGB ?? null, requiredGB: requirements.vramGB,
      }]),
      ...(this.platform === 'win32' ? [{
        name: 'commit', availableGB: windows?.commitHeadroomGB ?? null, requiredGB: requirements.commitGB,
      }] : []),
    ].map(check => ({
      ...check,
      ratio: check.availableGB === null || check.requiredGB === 0 ? null : check.availableGB / check.requiredGB,
      tier: check.availableGB === null ? 'tight'
        : check.availableGB < check.requiredGB * hardFailRatio ? 'insufficient'
          : check.availableGB < check.requiredGB ? 'tight' : 'ok',
    }));
    const failedRequirements = checks.filter(check => check.availableGB !== null && check.availableGB < check.requiredGB)
      .map(check => check.name);
    const hardFailedRequirements = checks.filter(check => check.tier === 'insufficient').map(check => check.name);
    const memoryTier = hardFailedRequirements.length ? 'insufficient'
      : checks.some(check => check.tier === 'tight') ? 'tight' : 'ok';
    const details = checks.map(check => `${check.name === 'commit' ? 'commit headroom' : check.name} `
      + `${check.availableGB === null ? 'unavailable' : `${check.availableGB.toFixed(1)} GB ${check.name === 'RAM' ? 'available' : 'free'}`} `
      + `${check.name === 'RAM' ? `(${freeRamGB === null ? 'free unavailable' : `${freeRamGB.toFixed(1)} GB free`}); ` : ''}`
      + `(estimated need ${check.requiredGB.toFixed(1)} GB, ${check.tier})`).join('; ');
    return {
      memoryTier,
      heuristic: true,
      message: `Heuristic memory preflight: ${memoryTier}; offload-to-cpu ${offloaded ? 'on' : 'off'}; `
        + `model files ${estimatedNeedGB.toFixed(1)} GB; ${details}; `
        + `below need: ${failedRequirements.join(', ') || 'none'}; `
        + `hard failed (below ${hardFailRatio * 100}% of need): ${hardFailedRequirements.join(', ') || 'none'}.`,
      estimatedNeedGB, largestComponentGB, freeRamGB, availableRamGB, totalRamGB, freeVramGB: gpu?.freeGB ?? null,
      commitHeadroomGB: windows?.commitHeadroomGB ?? null, requirements,
      offloadToCpu: offloaded, hardFailRatio, checks, failedRequirements, hardFailedRequirements,
    };
  }

  start(pid, { onSample, onPeaks, deviceName, deviceIndex } = {}) {
    const peaks = emptyPeaks();
    if (this.config.telemetry?.enabled === false || !Number.isSafeInteger(pid) || pid <= 0) {
      return { stop: () => ({ ...peaks }) };
    }
    const controller = new AbortController();
    let stopped = false;
    let sampling = false;
    let timer;
    const sample = async () => {
      if (stopped || sampling) return;
      sampling = true;
      try {
        const [gpu, windows] = await Promise.all([
          this._gpuMemory(controller.signal, deviceName, deviceIndex), this._windowsMemory(controller.signal, pid),
        ]);
        if (stopped) return;
        const metrics = { ...emptyPeaks(), ...(windows || {}), vramUsedGB: gpu?.usedGB ?? null };
        for (const key of PEAK_KEYS) {
          const value = numeric(metrics[key]);
          if (value !== null) peaks[key] = peaks[key] === null ? value : Math.max(peaks[key], value);
        }
        notify(onSample, metrics);
        notify(onPeaks, { ...peaks });
      } catch { /* Telemetry never fails generation. */ }
      finally { sampling = false; }
    };
    const stop = () => {
      if (!stopped) {
        stopped = true;
        try { this.unschedule(timer); } catch { /* Timer unavailable. */ }
        controller.abort();
      }
      return { ...peaks };
    };
    try {
      timer = this.schedule(() => { void sample(); }, Math.max(1, numeric(this.config.telemetry?.intervalMs) ?? 2000));
      timer?.unref?.();
      void sample();
    } catch { stop(); }
    return { stop };
  }
}
