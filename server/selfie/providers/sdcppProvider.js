import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ImageProvider, ImageProviderError, IMAGE_ERROR } from '../imageProvider.js';
import { createSelfieLogger } from '../log.js';
import { SdCppMemoryMonitor } from '../sdcppMemory.js';
import { createLocalPaths, inspectSdRuntimeStructure, RUNTIME_WARNING_MESSAGES, resolveSelfiePaths } from '../localPaths.js';
import { inspectSdRuntime } from '../runtimeValidity.js';

const DEFAULT_HELP_TIMEOUT_MS = 5000;
const DEFAULT_STDERR_TAIL_BYTES = 8192;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const PROCESS_CLOSED = Symbol('sdcppProcessClosed');
const NO_GPU_MESSAGE = 'No CUDA or Vulkan GPU device is available. Likely causes: a CPU-only build; '
  + 'missing ggml-cuda.dll; missing cudart*/cublas* CUDA runtime DLLs next to sd-cli.exe '
  + '(the cudart zip was not extracted); stable-diffusion.dll and sd-cli.exe from different releases; '
  + 'or an old GPU driver.';

function cleanOutput(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

export function parseSdCppDevices(output) {
  let context = null;
  for (const rawLine of cleanOutput(output).split(/[\r\n]+/)) {
    const line = rawLine.trim();
    const found = /\bfound\s+[1-9]\d*\s+(CUDA|Vulkan)\s+devices?\b/i.exec(line);
    if (found) context = found[1].toLowerCase();
    if (/\b(?:no|zero)\s+(?:GPU|CUDA|Vulkan)\s+devices?\b|support\s*(?:=|:)\s*false|failed|unavailable/i.test(line)) continue;
    let match = /\b(CUDA|Vulkan)\s*(?:device\s*)?(\d+)\s*(?::|[-(])\s*(.+?)\)?$/i.exec(line);
    if (match) return { backend: match[1].toLowerCase(), deviceName: match[3].trim(), deviceIndex: Number(match[2]) };
    match = /\b(CUDA|Vulkan)\s*(?:device\s*)?(\d+)[ \t]+(.+)$/i.exec(line);
    if (match && !/^(?:devices?|not|none|false|disabled|initializ\w*|support|backend)\b/i.test(match[3])) {
      return { backend: match[1].toLowerCase(), deviceName: match[3].trim(), deviceIndex: Number(match[2]) };
    }
    match = /\b(?:device\s*)?(\d+)\s*:\s*(.+?)\s*\((CUDA|Vulkan)\)/i.exec(line);
    if (match) return { backend: match[3].toLowerCase(), deviceName: match[2].trim(), deviceIndex: Number(match[1]) };
    match = /\bDevice\s*(\d+)\s*:\s*(.+)$/i.exec(line);
    if (context && match) return { backend: context, deviceName: match[2].trim(), deviceIndex: Number(match[1]) };
  }
  return { backend: null, deviceName: null, deviceIndex: null };
}

function hasCpuFallback(output, flush = false) {
  const text = cleanOutput(output);
  if (/no\s+GPU\s+devices[\s\S]{0,120}?using\s+(?:the\s+)?default\s+backend\b/i.test(text)) return true;
  const lines = text.split(/[\r\n]+/);
  if (!flush) lines.pop();
  return lines.some((line) => {
    // CPU VAE/text encoders and offloaded buffers are valid alongside GPU diffusion.
    if (/\b(?:VAE|CLIP|LLM|text encoder|conditioning|offload(?:ed|ing)?)\b/i.test(line)) return false;
    return /\b(?:using|selected)\s+(?:the\s+)?CPU(?:[- ]only)?\s+(?:backend|device)\b/i.test(line)
      || /\b(?:using|selected)\s+(?:the\s+)?backend\s+CPU\b/i.test(line)
      || /\bCPU[- ]backend[- ]only\b|\bCPU\s+backend\s+only\b|\bonly\s+(?:the\s+)?CPU\s+backend\b/i.test(line)
      || /\bbackend\s*(?:=|:)\s*CPU(?:\d+)?(?:\s|$)/i.test(line);
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function helpHasFlag(helpText, flag) {
  const escaped = escapeRegExp(flag);
  return new RegExp(`(?:^|[\\s,|])${escaped}(?=$|[\\s,=<\\[])`, 'm').test(helpText);
}

function protectPromptValue(value) {
  const text = String(value ?? '');
  return text.startsWith('-') ? ` ${text}` : text;
}

function hasArgument(args, flag) {
  return args.some(value => String(value).split('=')[0] === flag);
}

function argumentValue(args, flag) {
  for (let index = args.length - 1; index >= 0; index--) {
    const token = String(args[index]);
    if (token === flag) return args[index + 1];
    if (token.startsWith(flag + '=')) return token.slice(flag.length + 1);
  }
  return null;
}

function safeFilenamePart(value, fallback) {
  const normalized = String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return normalized || fallback;
}

function timestampName(prefix) {
  const d = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_`
    + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}`;
  return `${safeFilenamePart(prefix, 'selfie')}_${stamp}_${randomUUID().slice(0, 8)}.png`;
}

async function removeFile(filePath) {
  if (!filePath) return;
  await fs.promises.rm(filePath, { force: true }).catch(() => {});
}

export class SdCppProvider extends ImageProvider {
  constructor(cfg, {
    runCommand = null,
    platform = process.platform,
    env = process.env,
    memoryMonitor = null,
    spawnProcess = spawn,
    readDirectory = directory => fs.promises.readdir(directory, { withFileTypes: true }),
    logger = null,
    warner = null,
  } = {}) {
    super();
    Object.assign(cfg, resolveSelfiePaths(cfg, { env }));
    this.cfg = cfg;
    this.sd = cfg.sdcpp || {};
    this.active = null;
    this._lastReady = null;
    this._helpText = null;
    this.platform = platform;
    this.env = env;
    this.paths = createLocalPaths({ repoRoot: cfg.rootDir, env: { ...env, WAIFU_LOCAL_DIR: cfg.localDir } });
    this._runtimeValidity = null;
    this._runtimeValidityKey = null;
    this.runCommand = runCommand;
    this.spawnProcess = spawnProcess;
    this.readDirectory = readDirectory;
    const fileLogger = createSelfieLogger(cfg.logPath);
    this.log = logger || fileLogger.log;
    this.warn = warner || fileLogger.warn;
    this.memoryMonitor = memoryMonitor || new SdCppMemoryMonitor(cfg, { platform, ...(runCommand && { runCommand }) });
    this.statusListener = null;
    this.status = {
      ready: false, code: 'NOT_CHECKED', backend: null, deviceName: null,
      memoryTier: null, memoryMessage: null, lastPeaks: null,
    };
    this.deviceIndex = null;
    this.finalArgv = null;
    this.effectiveConfig = null;
    this.sanityWarnings = [];
    this.generationPeaks = null;
  }

  get name() {
    return 'sdcpp';
  }

  get helpTimeoutMs() {
    const configured = Number(this.sd.helpTimeoutMs);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_HELP_TIMEOUT_MS;
  }

  get stderrTailBytes() {
    const configured = Number(this.sd.stderrTailBytes);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_STDERR_TAIL_BYTES;
  }

  get deviceTimeoutMs() {
    const configured = Number(this.sd.deviceTimeoutMs);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_HELP_TIMEOUT_MS;
  }

  setStatusListener(listener) {
    this.statusListener = typeof listener === 'function' ? listener : null;
  }

  getStatus() {
    const { warnings, ...status } = this.status;
    return { ...status, lastPeaks: this.status.lastPeaks ? { ...this.status.lastPeaks } : null,
      ...(warnings?.length && { warnings: warnings.map(value => ({ ...value })) }) };
  }

  getFinalArgv() {
    return this.finalArgv ? [...this.finalArgv] : null;
  }

  getEffectiveConfig() {
    return this.effectiveConfig ? {
      ...this.effectiveConfig,
      args: [...this.effectiveConfig.args], presetArgs: [...this.effectiveConfig.presetArgs],
    } : null;
  }

  getSanityWarnings() {
    return this.sanityWarnings.map(warning => ({ ...warning }));
  }

  getGenerationPeaks() {
    return this.generationPeaks ? { ...this.generationPeaks } : null;
  }

  _setStatus(patch) {
    this.status = { ...this.status, ...patch };
    try {
      this.statusListener?.(this.getStatus());
    } catch {
      // Status delivery cannot affect image generation.
    }
  }

  _spawnArgs(args) {
    const extraArgs = Array.isArray(this.sd.extraArgs) ? this.sd.extraArgs.map(String) : [];
    return [...extraArgs, ...args];
  }

  _spawn(args, binaryPath = this.sd.binaryPath) {
    const proc = this.spawnProcess(binaryPath, this._spawnArgs(args), {
      cwd: path.dirname(binaryPath),
      env: this.env,
      detached: this.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    proc[PROCESS_CLOSED] = false;
    proc.once('close', () => { proc[PROCESS_CLOSED] = true; });
    return proc;
  }

  async _waitForProcessClose(proc) {
    if (!proc || proc[PROCESS_CLOSED]) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.off('close', finish);
        resolve();
      };
      const timer = setTimeout(finish, this.helpTimeoutMs);
      proc.once('close', finish);
    });
  }

  async _terminateProcess(proc) {
    if (!proc) return;
    if (proc.exitCode !== null || proc.signalCode !== null) {
      await this._waitForProcessClose(proc);
      return;
    }
    if (this.platform === 'win32' && proc.pid) {
      await new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const killer = this.spawnProcess('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        });
        timer = setTimeout(finish, this.helpTimeoutMs);
        killer.once('error', finish);
        killer.once('close', finish);
      });
    } else if (proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        try {
          proc.kill('SIGKILL');
        } catch {
          // The process may already have exited.
        }
      }
    }
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // The process may already have exited.
      }
    }
    await this._waitForProcessClose(proc);
  }

  async _runProbe(flag, timeoutMs, signal, binaryPath = this.sd.binaryPath) {
    signal?.throwIfAborted();
    if (this.runCommand) {
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const timer = setTimeout(() => controller.abort(new Error(`sd-cli ${flag} exceeded ${timeoutMs}ms.`)), timeoutMs);
      let rejectAbort;
      const aborted = new Promise((resolve, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      });
      try {
        const result = await Promise.race([
          this.runCommand(binaryPath, this._spawnArgs([flag]), {
            signal: controller.signal, timeoutMs, cwd: path.dirname(binaryPath), env: this.env,
          }),
          aborted,
        ]);
        return { code: result.code ?? result.exitCode ?? 0, output: result.output ?? `${result.stdout || ''}\n${result.stderr || ''}` };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        controller.signal.removeEventListener('abort', rejectAbort);
      }
    }
    return new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      let stopError = null;
      let stopPromise = null;
      let timer;
      let proc;
      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(result);
      };
      const stop = (err) => {
        if (!stopError) stopError = err;
        if (!stopPromise) {
          stopPromise = this._terminateProcess(proc).then(
            () => finish(stopError),
            terminateError => finish(new Error(`${stopError.message} Cleanup failed: ${terminateError.message}`)),
          );
        }
        return stopPromise;
      };
      const onAbort = () => {
        void stop(new ImageProviderError(IMAGE_ERROR.CANCELLED, 'sd-cli readiness check was cancelled.', {
          generationStarted: false,
        }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        proc = this._spawn([flag], binaryPath);
      } catch (err) {
        finish(err);
        return;
      }
      const append = (chunk) => {
        output += chunk.toString();
        if (output.length > 256 * 1024) output = output.slice(-256 * 1024);
      };
      proc.stdout?.on('data', append);
      proc.stderr?.on('data', append);
      proc.once('error', (err) => {
        if (!stopError) finish(new Error(`sd-cli could not start: ${err.message}`));
      });
      proc.once('close', (code) => {
        if (stopError) return;
        finish(null, { code, output });
      });
      timer = setTimeout(() => {
        void stop(new Error(`sd-cli ${flag} exceeded ${timeoutMs}ms.`));
      }, timeoutMs);
    });
  }

  async _runHelp(signal) {
    return this._runProbe('--help', this.helpTimeoutMs, signal);
  }

  async _hasMissingCudaRuntime(signal) {
    if (this.platform !== 'win32') return false;
    signal?.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new Error('CUDA runtime DLL probe timed out.')), this.deviceTimeoutMs);
    let rejectAbort;
    const aborted = new Promise((resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    const readDllNames = async directory => {
      controller.signal.throwIfAborted();
      try {
        const entries = await this.readDirectory(directory);
        controller.signal.throwIfAborted();
        return entries.filter(entry => entry.isFile()).map(entry => entry.name.toLowerCase());
      } catch {
        controller.signal.throwIfAborted();
        return [];
      }
    };
    const scan = async () => {
      const nearby = await readDllNames(path.dirname(this.sd.binaryPath));
      if (!nearby.includes('ggml-cuda.dll')) return false;
      const hasRuntimes = names => names.some(name => /^cudart.*\.dll$/.test(name))
        && names.some(name => /^cublas.*\.dll$/.test(name));
      if (hasRuntimes(nearby)) return false;
      const paths = [...new Set(String(this.env.PATH || this.env.Path || '').split(';')
        .map(directory => directory.trim().replace(/^"|"$/g, '')).filter(Boolean))];
      const runtimeNames = [...nearby, ...(await Promise.all(paths.map(readDllNames))).flat()];
      return !hasRuntimes(runtimeNames);
    };
    try {
      return await Promise.race([scan(), aborted]);
    } catch (err) {
      signal?.throwIfAborted();
      this.warn(`CUDA runtime DLL probe unavailable: ${err.message}`);
      return false;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.signal.removeEventListener('abort', rejectAbort);
    }
  }

  async checkReady(signal) {
    signal?.throwIfAborted();
    this._setStatus({ backend: null, deviceName: null });
    const localStructure = inspectSdRuntimeStructure(this.paths);
    let local = localStructure;
    if (localStructure.structurallyValid) {
      const stat = await fs.promises.stat(localStructure.binaryPath);
      const key = JSON.stringify([localStructure.binaryPath, stat.mtimeMs, stat.size]);
      if (this._runtimeValidityKey === key && this._runtimeValidity?.valid) local = this._runtimeValidity;
      else {
        let probeCompletion;
        try {
          local = await inspectSdRuntime(this.paths, { env: this.env, signal, timeoutMs: this.helpTimeoutMs,
            probeCommand: (binary, args, options) => {
              probeCompletion = this._runProbe(args[0], options.timeoutMs, options.signal, binary);
              return probeCompletion;
            } });
        } finally {
          // Join local help-child cleanup before probing or starting a legacy fallback.
          await probeCompletion?.catch(() => {});
        }
        this._runtimeValidity = local;
        this._runtimeValidityKey = key;
      }
    }
    const legacyBinary = this.sd._legacyBinaryPath;
    const selectedBinary = local.valid ? local.binaryPath : local.exists ? legacyBinary || local.binaryPath
      : this._wasLocalRuntime ? legacyBinary || '' : this.sd.binaryPath;
    this._wasLocalRuntime = local.valid;
    const fallback = local.exists && !local.valid && Boolean(legacyBinary);
    const warnings = fallback ? [{ code: 'LOCAL_SDCLI_RUNTIME_FALLBACK', message: RUNTIME_WARNING_MESSAGES.LOCAL_SDCLI_RUNTIME_FALLBACK }] : [];
    this._setStatus({ warnings });
    if (this.sd.binaryPath !== selectedBinary) this._helpText = null;
    this.sd.binaryPath = selectedBinary;
    if (local.valid) this._helpText = local.helpOutput;
    if (fallback) this.warn(`${RUNTIME_WARNING_MESSAGES.LOCAL_SDCLI_RUNTIME_FALLBACK} ${local.message}`);
    if (!local.valid && !legacyBinary && local.exists) {
      return this._setReady(false, local.code, local.message, local.publicMessage);
    }
    const binaryPath = this.sd.binaryPath;
    if (!binaryPath) {
      return this._setReady(false, 'SDCPP_BINARY_NOT_CONFIGURED', `sdcpp.binaryPath is not configured. ${local.message}`,
        `sdcpp.binaryPath is not configured. ${local.publicMessage}`);
    }
    let binaryStat;
    try {
      binaryStat = await fs.promises.stat(binaryPath);
    } catch {
      return this._setReady(false, 'SDCPP_BINARY_MISSING', `sd-cli binary is missing: ${binaryPath}`,
        `sd-cli binary is missing: ${path.win32.basename(binaryPath)}`);
    }
    if (!binaryStat.isFile()) {
      return this._setReady(false, 'SDCPP_BINARY_INVALID', `sd-cli binary is not a file: ${binaryPath}`,
        `sd-cli binary is not a file: ${path.win32.basename(binaryPath)}`);
    }

    const configuredModels = [
      ['diffusionModel', this.sd.diffusionModel, true],
      ['vae', this.sd.vae, true],
      ['llm', this.sd.llm, true],
      ['llmVision', this.sd.llmVision, false],
    ];
    for (const [name, filePath, required] of configuredModels) {
      if (!filePath) {
        if (required) {
          return this._setReady(false, 'SDCPP_MODEL_NOT_CONFIGURED', `sdcpp.${name} is not configured.`,
            `sdcpp.${name} is not configured.`);
        }
        continue;
      }
      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        return this._setReady(false, 'SDCPP_MODEL_MISSING', `sdcpp.${name} is missing: ${filePath}`,
          `sdcpp.${name} is missing: ${path.win32.basename(filePath)}`);
      }
      if (!stat.isFile() || stat.size === 0) {
        return this._setReady(
          false,
          'SDCPP_MODEL_INVALID',
          `sdcpp.${name} must be a non-empty file: ${filePath}`,
          `sdcpp.${name} must be a non-empty file: ${path.win32.basename(filePath)}`,
        );
      }
    }

    let help;
    try {
      help = this._helpText ? { code: 0, output: this._helpText } : await this._runHelp(signal);
    } catch (err) {
      signal?.throwIfAborted();
      const code = /exceeded/.test(err.message) ? 'SDCPP_HELP_TIMEOUT' : 'SDCPP_HELP_FAILED';
      return this._setReady(false, code, err.message,
        code === 'SDCPP_HELP_TIMEOUT' ? 'sd-cli --help timed out.' : 'sd-cli --help failed; see backend logs.');
    }
    if (help.code !== 0) {
      return this._setReady(false, 'SDCPP_HELP_FAILED', `sd-cli --help exited with code ${help.code}.`,
        `sd-cli --help exited with code ${help.code}.`);
    }
    this._helpText = help.output;

    const requiredFlags = [
      '--diffusion-model', '--vae', '--llm', '-r', '-p', '-n', '--steps', '--cfg-scale',
      '-W', '-H', '-s', '-o',
    ];
    if (this.sd.llmVision) requiredFlags.push('--llm_vision');
    const missingFlags = requiredFlags.filter(flag => !helpHasFlag(help.output, flag));
    if (missingFlags.length > 0) {
      return this._setReady(
        false,
        'SDCPP_FLAG_MISMATCH',
        `sd-cli --help is missing required flags: ${missingFlags.join(', ')}`,
        `sd-cli --help is missing required flags: ${missingFlags.join(', ')}`,
      );
    }
    let deviceProbe;
    try {
      deviceProbe = await this._runProbe('--list-devices', this.deviceTimeoutMs, signal);
    } catch (err) {
      signal?.throwIfAborted();
      this.warn(`sd-cli device probe failed: ${err.message}`);
      deviceProbe = { code: 1, output: '' };
    }
    const devices = deviceProbe.code === 0 ? parseSdCppDevices(deviceProbe.output) : { backend: null, deviceName: null };
    for (const line of cleanOutput(deviceProbe.output).split(/[\r\n]+/).filter(line => /backend|device|cuda|vulkan/i.test(line)).slice(0, 5)) {
      this.log(`sd-cli device probe: ${line}`);
    }
    this.deviceIndex = devices.deviceIndex ?? null;
    if (!devices.backend && this.sd.allowCpu !== true) {
      const missingRuntime = await this._hasMissingCudaRuntime(signal);
      signal?.throwIfAborted();
      const code = missingRuntime ? 'CUDA_RUNTIME_MISSING' : 'NO_GPU_BACKEND';
      const message = missingRuntime
        ? 'ggml-cuda.dll is present but required cudart*/cublas* DLLs are missing beside sd-cli.exe and on PATH. '
          + 'Extract the cudart zip from the same release into the sd-cli folder. ' + NO_GPU_MESSAGE
        : NO_GPU_MESSAGE;
      return this._setReady(false, code, message, message);
    }
    const backend = devices.backend || 'cpu';
    const deviceName = devices.deviceName || 'CPU (allowCpu override)';
    this._setStatus({ backend, deviceName });
    this.log(`sd-cli backend/device: ${backend} / ${deviceName}`);
    return this._setReady(true, 'READY', 'sd.cpp is ready.');
  }

  _setReady(ready, code, message, publicMessage = code) {
    const warnings = this.status.warnings;
    if (warnings?.length) {
      const warningText = warnings.map(value => value.message).join(' ');
      message = `${message} Warning: ${warningText}`;
      publicMessage = `${publicMessage} Warning: ${warningText}`;
    }
    this._lastReady = {
      ready, code, message, backend: this.status.backend, deviceName: this.status.deviceName,
      ...((!ready || warnings?.length) && { publicMessage }),
      ...(warnings?.length && { warnings: warnings.map(value => ({ ...value })) }),
    };
    this._setStatus({ ready, code });
    return this._lastReady;
  }

  async isAvailable(signal) {
    return (await this.checkReady(signal)).ready;
  }

  listReferences() {
    try {
      return fs.readdirSync(this.cfg.referenceDir)
        .filter(name => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .sort();
    } catch {
      return [];
    }
  }

  resolveReference(referenceImage) {
    const name = referenceImage || this.cfg.defaultReference;
    const whitelist = this.listReferences();
    if (!name || name !== path.basename(name) || !whitelist.includes(name)) {
      throw new ImageProviderError(
        IMAGE_ERROR.FAILED,
        `Reference "${name || ''}" is not in the whitelist (${this.cfg.referenceDir}). Available: ${whitelist.join(', ') || '(empty)'}`,
        { generationStarted: false },
      );
    }
    return path.join(this.cfg.referenceDir, name);
  }

  buildArgs(params, outPath) {
    const seed = Number.isFinite(params.seed) ? params.seed : randomBytes(6).readUIntBE(0, 6);
    const width = Number(params.width ?? params.resolution);
    const height = Number(params.height ?? params.resolution);
    const steps = Number(params.steps);
    if ([width, height].some(value => !Number.isInteger(value) || value <= 0 || value % 32 !== 0)) {
      throw new ImageProviderError(IMAGE_ERROR.FAILED, 'sd.cpp width and height must be positive multiples of 32.', {
        generationStarted: false,
      });
    }
    if (!Number.isInteger(steps) || steps <= 0) {
      throw new ImageProviderError(IMAGE_ERROR.FAILED, 'sd.cpp steps must be a positive integer.', {
        generationStarted: false,
      });
    }
    const referencePath = this.resolveReference(params.referenceImage);
    const args = [
      '--diffusion-model', this.sd.diffusionModel,
      '--vae', this.sd.vae,
      '--llm', this.sd.llm,
    ];
    if (this.sd.llmVision) args.push('--llm_vision', this.sd.llmVision);
    args.push(
      '-r', referencePath,
      '-p', protectPromptValue(params.positivePrompt),
      '-n', protectPromptValue(params.negativePrompt),
      '--steps', String(steps),
      '--cfg-scale', String(params.cfgScale ?? 3),
      '-W', String(width),
      '-H', String(height),
      '-s', String(seed),
    );
    const preset = params.sdcpp || this.cfg.presets?.[params.preset]?.sdcpp || {};
    this._addImageToImageArgs(args, preset, referencePath);
    const baseArgs = [...(this.sd.args || [])];
    const presetArgs = [...(preset.args || [])];
    const offloadToCpu = typeof this.sd.offloadToCpu === 'boolean'
      ? this.sd.offloadToCpu : hasArgument(baseArgs, '--offload-to-cpu');
    const configuredArgs = offloadToCpu ? [...baseArgs]
      : baseArgs.filter(value => String(value).split('=')[0] !== '--offload-to-cpu');
    // Preset additions can explicitly enable offload even when the base setting is false.
    configuredArgs.push(...presetArgs);
    if (offloadToCpu && !hasArgument(configuredArgs, '--offload-to-cpu')) configuredArgs.push('--offload-to-cpu');
    args.push(...this._configuredArgs(configuredArgs));
    const modelArgs = [...(this.sd.modelArgs || []), ...(preset.modelArgs || [])];
    if (modelArgs.length) {
      this.log(`sd-cli modelArgs keys are not validated by --help: ${JSON.stringify(modelArgs)}`);
      if (helpHasFlag(this._helpText || '', '--model-args')) args.push('--model-args', modelArgs.join(','));
      else this.warn('Skipping configured --model-args: it is absent from sd-cli --help.');
    }
    args.push('-o', outPath);
    this.effectiveConfig = {
      offloadToCpu, args: baseArgs, presetArgs,
      effectiveOffloadToCpu: hasArgument(this._spawnArgs(args), '--offload-to-cpu'),
    };
    this.log(`sd-cli effective config: ${JSON.stringify(this.effectiveConfig)}`);
    return { args, seed };
  }

  _addImageToImageArgs(args, preset, referencePath) {
    const initImage = preset.initImage ?? this.sd.initImage;
    const strength = preset.strength ?? this.sd.strength;
    const supported = (flag) => {
      if (helpHasFlag(this._helpText || '', flag)) return true;
      const message = `Skipping configured ${flag}: it is absent from sd-cli --help.`;
      this.sanityWarnings.push({ code: 'SDCPP_FLAG_UNSUPPORTED', message });
      this.warn(message);
      return false;
    };
    if (initImage && supported('-i')) {
      if (typeof initImage !== 'string' || initImage.includes('\0')) {
        throw new ImageProviderError(IMAGE_ERROR.FAILED, 'sd.cpp initImage must be an image path or "reference".', {
          generationStarted: false,
        });
      }
      const initPath = initImage === 'reference' ? referencePath : path.resolve(initImage);
      let valid = false;
      try {
        const stat = fs.statSync(initPath);
        valid = stat.isFile() && stat.size > 0 && IMAGE_EXTENSIONS.has(path.extname(initPath).toLowerCase());
      } catch {
        // Reject missing inputs before the native process loads any models.
      }
      if (!valid) {
        throw new ImageProviderError(IMAGE_ERROR.FAILED, `sd.cpp init image is missing or invalid: ${initPath}`, {
          generationStarted: false,
        });
      }
      args.push('-i', initPath);
    }
    if (strength !== undefined && strength !== null && supported('--strength')) {
      const value = Number(strength);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new ImageProviderError(IMAGE_ERROR.FAILED, 'sd.cpp strength must be between 0 and 1.', {
          generationStarted: false,
        });
      }
      args.push('--strength', String(value));
    }
  }

  _checkVisionArgument(args) {
    const llm = argumentValue(args, '--llm');
    if (hasArgument(args, '-r') && /\.gguf$/i.test(String(llm || ''))
      && !argumentValue(args, '--llm_vision')) {
      const message = 'Reference generation with a GGUF --llm needs the Qwen3-VL mmproj file; '
        + 'configure sdcpp.llmVision to pass --llm_vision.';
      this._setStatus({ ready: false, code: 'LLM_VISION_MISSING' });
      this.warn(`sd-cli argument sanity [LLM_VISION_MISSING]: ${message}`);
      throw new ImageProviderError('LLM_VISION_MISSING', message, { generationStarted: false });
    }
  }

  _checkOffloadMemory(args, memory) {
    const need = memory.requirements?.vramGB;
    const free = memory.freeVramGB;
    if (!hasArgument(args, '--offload-to-cpu') && typeof need === 'number' && Number.isFinite(need)
      && typeof free === 'number' && Number.isFinite(free) && free >= 0 && need > free) {
      const message = `CPU offload is off: estimated VRAM need ${need.toFixed(1)} GB exceeds `
        + `${free.toFixed(1)} GB free. Enable sdcpp.offloadToCpu or add --offload-to-cpu to preset args.`;
      this.sanityWarnings.push({ code: 'OFFLOAD_OFF_LOW_VRAM', message });
      this.warn(`sd-cli argument sanity [OFFLOAD_OFF_LOW_VRAM]: ${message}`);
    }
  }

  _configuredArgs(configured) {
    const accepted = [];
    for (let index = 0; index < configured.length;) {
      const token = String(configured[index++]);
      const flag = token.split('=')[0];
      const values = [];
      while (index < configured.length && !/^--?[A-Za-z]/.test(String(configured[index]))) {
        values.push(String(configured[index++]));
      }
      if (!/^--?[A-Za-z]/.test(flag) || !helpHasFlag(this._helpText || '', flag)) {
        this.warn(`Skipping configured sd-cli argument ${flag}: it is absent from sd-cli --help.`);
        continue;
      }
      accepted.push(token, ...values);
    }
    return accepted;
  }

  static parseProgress(line) {
    const matches = [...String(line).matchAll(/(\d+)\s*\/\s*(\d+)/g)];
    for (let i = matches.length - 1; i >= 0; i--) {
      const value = Number(matches[i][1]);
      const max = Number(matches[i][2]);
      if (max > 0 && value >= 0 && value <= max) return { value, max };
    }
    const percent = /(\d+(?:\.\d+)?)\s*%/.exec(String(line));
    if (percent) return { value: Math.min(100, Math.round(Number(percent[1]))), max: 100 };
    return null;
  }

  _consumeProgress(chunk, state, onProgress) {
    state.buffer += chunk.toString();
    if (state.buffer.length > this.stderrTailBytes) {
      state.buffer = state.buffer.slice(-this.stderrTailBytes);
    }
    const lines = state.buffer.split(/[\r\n]+/);
    state.buffer = lines.pop() || '';
    for (const line of lines) {
      const progress = SdCppProvider.parseProgress(line);
      if (progress) onProgress(progress);
    }
  }

  async _validateOutput(filePath) {
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      throw new Error('sd-cli did not create an output file.');
    }
    if (!stat.isFile() || stat.size < PNG_SIGNATURE.length) {
      throw new Error('sd-cli output is empty or too small to be a PNG.');
    }
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const signature = Buffer.alloc(PNG_SIGNATURE.length);
      await handle.read(signature, 0, signature.length, 0);
      if (!signature.equals(PNG_SIGNATURE)) throw new Error('sd-cli output has an invalid PNG signature.');
    } finally {
      await handle.close();
    }
  }

  _throwIfStopped(active) {
    if (active.termination) throw active.termination;
    active.controller.signal.throwIfAborted();
  }

  _stopActive(active, error) {
    if (!active.termination) active.termination = error;
    if (!active.controller.signal.aborted) active.controller.abort(active.termination);
    if (!active.stopPromise) {
      active.stopPromise = active.proc
        ? this._terminateProcess(active.proc)
        : Promise.resolve();
    }
    return active.stopPromise;
  }

  _stopTelemetry(active) {
    if (!active.sampler || active.telemetryStopped) return;
    active.telemetryStopped = true;
    try {
      const peaks = active.sampler.stop();
      if (peaks && typeof peaks === 'object' && typeof peaks.then !== 'function') {
        active.peaks = { ...peaks };
        this.generationPeaks = active.peaks;
        this._setStatus({ lastPeaks: active.peaks });
        this.log(`sd-cli telemetry peaks (GB): ${JSON.stringify(active.peaks)}`);
      } else if (peaks?.catch) {
        peaks.catch(() => {});
      }
    } catch (err) {
      this.warn(`sd-cli telemetry stop failed: ${err.message}`);
    }
  }

  _consumeBackendOutput(chunk, state, active, flush = false) {
    state.scanBuffer = ((state.scanBuffer || '') + chunk.toString()).slice(-16384);
    state.buffer = (state.buffer + chunk.toString()).slice(-16384);
    if (!active.termination && this.sd.allowCpu !== true && hasCpuFallback(state.scanBuffer, flush)) {
      const error = new ImageProviderError('NO_GPU_BACKEND', 'sd-cli fell back to a CPU-only backend. ' + NO_GPU_MESSAGE, {
        generationStarted: active.started,
      });
      this._lastReady = null;
      this._setStatus({ ready: false, code: 'NO_GPU_BACKEND' });
      void this._stopActive(active, error);
    }
    const lines = state.buffer.split(/[\r\n]+/);
    state.buffer = lines.pop() || '';
    for (const line of lines) {
      if (active.backendLines < 10 && /backend|device|cuda|vulkan/i.test(cleanOutput(line))) {
        active.backendLines++;
        this.log(`sd-cli backend: ${cleanOutput(line)}`);
      }
    }
  }

  async _runProcess(active, built, onProgress, onStarted) {
    this._throwIfStopped(active);
    this.finalArgv = this._spawnArgs(built.args);
    this.log(`sd-cli final argv: ${JSON.stringify(this.finalArgv)}`);
    let proc;
    try {
      proc = this._spawn(built.args);
    } catch (err) {
      throw new ImageProviderError(IMAGE_ERROR.FAILED, `sd-cli could not start: ${err.message}`, {
        generationStarted: false,
      });
    }
    active.proc = proc;
    active.closePromise = new Promise(resolve => { active.resolveClose = resolve; });
    if (active.termination) void this._stopActive(active, active.termination);

    return new Promise((resolve, reject) => {
      let stderrTail = '';
      let spawnError = null;
      const stdoutState = { buffer: '' };
      const stderrState = { buffer: '' };
      const stdoutBackend = { buffer: '' };
      const stderrBackend = { buffer: '' };
      const safeProgress = (progress) => {
        if (active.termination) return;
        try {
          onProgress(progress);
        } catch (err) {
          this.warn(`sd-cli progress callback failed: ${err.message}`);
        }
      };

      proc.once('spawn', () => {
        if (active.termination) return;
        active.started = true;
        try {
          onStarted();
        } catch (err) {
          const startError = err instanceof ImageProviderError ? err : new ImageProviderError(
            IMAGE_ERROR.FAILED,
            err.message || 'Generation start callback failed.',
          );
          startError.generationStarted = true;
          void this._stopActive(active, startError);
          return;
        }
        safeProgress({ value: 0, max: 0 });
        this.log(`Started sd-cli with ${built.args.length} generated arguments.`);
        if (this.cfg.telemetry?.enabled !== false) {
          try {
            active.sampler = this.memoryMonitor.start(proc.pid, {
              backend: this.status.backend, deviceName: this.status.deviceName, deviceIndex: this.deviceIndex,
            });
          } catch (err) {
            this.warn(`sd-cli telemetry start failed: ${err.message}`);
          }
        }
      });
      proc.stdout?.on('data', (chunk) => {
        this._consumeBackendOutput(chunk, stdoutBackend, active);
        this._consumeProgress(chunk, stdoutState, safeProgress);
      });
      proc.stderr?.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-this.stderrTailBytes);
        this._consumeBackendOutput(chunk, stderrBackend, active);
        this._consumeProgress(chunk, stderrState, safeProgress);
      });
      proc.once('error', (err) => {
        spawnError = err;
      });
      proc.once('close', (code, closeSignal) => {
        this._consumeBackendOutput('', stdoutBackend, active, true);
        this._consumeBackendOutput('', stderrBackend, active, true);
        this._stopTelemetry(active);
        active.resolveClose();
        for (const state of [stdoutBackend, stderrBackend]) {
          if (state.buffer && active.backendLines < 10 && /backend|device|cuda|vulkan/i.test(cleanOutput(state.buffer))) {
            this.log(`sd-cli backend: ${cleanOutput(state.buffer)}`);
            active.backendLines++;
          }
        }
        if (!active.termination) {
          const trailingProgress = SdCppProvider.parseProgress(
            `${stdoutState.buffer}\n${stderrState.buffer}`,
          );
          if (trailingProgress) safeProgress(trailingProgress);
        }
        if (active.termination) {
          reject(active.termination);
          return;
        }
        if (spawnError) {
          reject(new ImageProviderError(IMAGE_ERROR.FAILED, `sd-cli could not start: ${spawnError.message}`, {
            generationStarted: false,
          }));
          return;
        }
        const stderrMessage = stderrTail.trim() ? ` stderr: ${stderrTail.trim()}` : '';
        if (code !== 0) {
          reject(new ImageProviderError(
            IMAGE_ERROR.FAILED,
            `sd-cli exited with code ${code}${closeSignal ? ` (${closeSignal})` : ''}.${stderrMessage}`,
            { generationStarted: active.started, stderrTail },
          ));
          return;
        }
        resolve({ stderrTail, stderrMessage });
      });
    });
  }

  async generate(params, onProgress = () => {}, signal, onStarted = () => {}) {
    if (this.active) {
      throw new ImageProviderError(IMAGE_ERROR.FAILED, 'sd-cli already has an active job.', {
        generationStarted: false,
      });
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const active = {
      controller,
      proc: null,
      partialPath: null,
      finalPath: null,
      started: false,
      termination: null,
      stopPromise: null,
      closePromise: null,
      resolveClose: null,
      resolveDone: null,
      donePromise: null,
      sampler: null,
      telemetryStopped: false,
      peaks: null,
      backendLines: 0,
    };
    active.donePromise = new Promise(resolve => { active.resolveDone = resolve; });
    this.active = active;
    this.finalArgv = null;
    this.effectiveConfig = null;
    this.sanityWarnings = [];
    this.generationPeaks = null;
    this._setStatus({ memoryTier: null, memoryMessage: null });
    let completed = false;
    const jobTimeoutMs = Math.max(1, Number(this.cfg.jobTimeoutMs) || 1);
    const cancelError = () => new ImageProviderError(
      IMAGE_ERROR.CANCELLED,
      'sd-cli job was cancelled.',
      { generationStarted: active.started },
    );
    const onAbort = () => { void this._stopActive(active, cancelError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timeoutTimer = setTimeout(() => {
      void this._stopActive(active, new ImageProviderError(
        IMAGE_ERROR.TIMEOUT,
        `sd-cli exceeded ${jobTimeoutMs}ms.`,
        { generationStarted: active.started },
      ));
    }, jobTimeoutMs);

    try {
      this._throwIfStopped(active);
      const readiness = this._lastReady?.ready
        ? this._lastReady
        : await this.checkReady(controller.signal);
      this._throwIfStopped(active);
      if (!readiness.ready) {
        throw new ImageProviderError(readiness.code || IMAGE_ERROR.UNAVAILABLE, readiness.message, {
          generationStarted: false,
          readiness,
        });
      }
      active.partialPath = path.join(this.cfg.outputDir, `.selfie-${randomUUID()}.tmp.png`);
      let built;
      try {
        built = this.buildArgs(params, active.partialPath);
      } catch (err) {
        if (err instanceof ImageProviderError) throw err;
        throw new ImageProviderError(IMAGE_ERROR.FAILED, err.message, { generationStarted: false });
      }
      this._throwIfStopped(active);
      this.finalArgv = this._spawnArgs(built.args);
      this._checkVisionArgument(this.finalArgv);

      let memory;
      try {
        memory = await this.memoryMonitor.preflight({
          signal: controller.signal, backend: this.status.backend, deviceName: this.status.deviceName,
          deviceIndex: this.deviceIndex, offloadToCpu: hasArgument(this.finalArgv, '--offload-to-cpu'),
        });
      } catch (err) {
        this._throwIfStopped(active);
        memory = { memoryTier: 'tight', message: 'Heuristic memory check is unavailable; memory pressure is unknown.', heuristic: true };
        this.warn(`sd-cli memory preflight unavailable: ${err.message}`);
      }
      this._throwIfStopped(active);
      this._checkOffloadMemory(this.finalArgv, memory);
      const insufficient = memory.memoryTier === 'insufficient' && this.sd.forceRun !== true;
      this._setStatus({
        memoryTier: memory.memoryTier, memoryMessage: memory.message,
        ready: !insufficient, code: insufficient ? 'MEMORY_INSUFFICIENT' : 'READY',
      });
      this.log(`sd-cli memory preflight (heuristic): ${JSON.stringify(memory)}`);
      if (insufficient) {
        throw new ImageProviderError('MEMORY_INSUFFICIENT', memory.message, { generationStarted: false, memory });
      }
      if (memory.memoryTier !== 'ok') this.warn(`sd-cli memory warning (heuristic): ${memory.message}`);
      await fs.promises.mkdir(this.cfg.outputDir, { recursive: true });
      this._throwIfStopped(active);

      const processResult = await this._runProcess(active, built, onProgress, onStarted);
      this._throwIfStopped(active);
      try {
        await this._validateOutput(active.partialPath);
        this._throwIfStopped(active);
        active.finalPath = path.join(this.cfg.outputDir, timestampName(this.cfg.filenamePrefix));
        await fs.promises.rename(active.partialPath, active.finalPath);
        this._throwIfStopped(active);
      } catch (err) {
        if (active.termination) throw active.termination;
        throw new ImageProviderError(
          IMAGE_ERROR.FAILED,
          `${err.message}${processResult.stderrMessage}`,
          { generationStarted: active.started, stderrTail: processResult.stderrTail },
        );
      }

      completed = true;
      const totalMs = Date.now() - startedAt;
      return {
        imagePath: active.finalPath,
        seed: built.seed,
        memory,
        peaks: active.peaks,
        argv: this.getFinalArgv(),
        effectiveConfig: this.getEffectiveConfig(),
        warnings: this.getSanityWarnings(),
        timings: { queueMs: 0, generateMs: totalMs, downloadMs: 0, totalMs },
      };
    } catch (err) {
      if (active.termination) throw active.termination;
      throw err;
    } finally {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort);
      if (active.stopPromise) await active.stopPromise.catch(() => {});
      this._stopTelemetry(active);
      if (!completed) {
        await removeFile(active.partialPath);
        await removeFile(active.finalPath);
      }
      if (this.active === active) this.active = null;
      active.resolveDone();
    }
  }

  async cancel() {
    const active = this.active;
    if (!active) return;
    await this._stopActive(active, new ImageProviderError(
      IMAGE_ERROR.CANCELLED,
      'sd-cli job was cancelled.',
      { generationStarted: active.started },
    ));
    await active.donePromise;
  }

  async release() {
    // sd-cli exits after every job, so process exit releases its VRAM.
  }
}
