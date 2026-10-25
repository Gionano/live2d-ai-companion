import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createSelfieLogger } from './log.js';
import { runCommand } from './sdcppMemory.js';
import { ROOT_DIR, createLocalPaths, resolveManagedPaths, resolveSelfiePaths } from './localPaths.js';

const OWNER = 'amika-comfyui-managed-v1';
const HELP_TIMEOUT_MS = 15000;
const TAIL_BYTES = 16384;
const HELP_CACHE = new Map();
const STARTUP_CLEANUPS = new Map();
const RESERVED_FLAGS = new Set(['--listen', '--port', '--disable-auto-launch']);

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
}

function isFlag(token) {
  return /^--?[a-zA-Z]/.test(String(token));
}

function helpHasFlag(help, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s,|])${escaped}(?=$|[\\s,=<\\[])`, 'm').test(help);
}

/** Unsupported option values leave with their flag, including negative numbers. */
export function filterComfyUiManagedArgs(args, help, warn = () => {}) {
  const filtered = [];
  for (let index = 0; index < args.length; index++) {
    const token = String(args[index]);
    const flag = token.split('=')[0];
    if (isFlag(token) && (RESERVED_FLAGS.has(flag) || !helpHasFlag(help, flag))) {
      warn(RESERVED_FLAGS.has(flag)
        ? `comfyui-managed: skipped configured ${flag}; the app controls this launch option.`
        : `comfyui-managed: skipped configured ${flag}; it is missing from the installed ComfyUI --help.`);
      if (!token.includes('=')) {
        while (index + 1 < args.length && !isFlag(args[index + 1])) index++;
      }
      continue;
    }
    filtered.push(token);
  }
  return filtered;
}

function bindPort(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host, port, exclusive: true }, () => {
      const selected = server.address().port;
      server.close(error => error ? reject(error) : resolve(selected));
    });
  });
}

/** Binding is authoritative, including Windows excluded-port EACCES errors. */
export async function findComfyUiManagedPort(host, {
  requestedPort = 'auto', bind = bindPort, random = Math.random, attempts = 32,
} = {}) {
  const automatic = requestedPort === 'auto' || requestedPort === undefined;
  let lastError;
  for (let attempt = 0; attempt < (automatic ? attempts : 1); attempt++) {
    const candidate = automatic ? (attempt === 0 ? 0 : 49152 + Math.floor(random() * 16384)) : Number(requestedPort);
    try { return await bind(host, candidate); }
    catch (error) {
      lastError = error;
      if (!automatic || !['EACCES', 'EADDRINUSE'].includes(error.code)) throw error;
    }
  }
  throw new Error(`comfyui-managed: could not bind a usable local port after ${attempts} attempts (${lastError?.code || lastError?.message}).`);
}

function sleep(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortReason(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function isAlive(child) {
  return Boolean(child && !child.managedClosed && child.exitCode === null && child.signalCode === null);
}

async function waitForClose(child, timeoutMs) {
  if (!isAlive(child)) return;
  await new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); child.off('close', finish); resolve(); };
    const timer = setTimeout(finish, timeoutMs);
    child.once('close', finish);
    if (!isAlive(child)) finish();
  });
}

function normalizeIdentity(value) {
  if (!value) return null;
  return {
    name: String(value.name ?? value.Name ?? ''),
    executablePath: String(value.executablePath ?? value.ExecutablePath ?? ''),
    commandLine: String(value.commandLine ?? value.CommandLine ?? ''),
    startedAt: String(value.startedAt ?? value.CreationDate ?? ''),
  };
}

function samePath(left, right, platform) {
  if (!left || !right) return false;
  const normalize = value => path.resolve(value).replace(/\\/g, '/');
  return platform === 'win32' ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function getProcessIdentity(pid, platform, commandRunner) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (platform === 'win32') {
    const script = `$managedProcess = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; `
      + 'if ($managedProcess) { $managedProcess | Select-Object Name,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress }';
    const result = await commandRunner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 1500 });
    if (result.code !== 0) throw new Error(`Windows process identity probe failed: ${(result.stderr || result.stdout || `exit ${result.code}`).trim()}`);
    if (!result.stdout.trim()) return null;
    return normalizeIdentity(JSON.parse(result.stdout));
  }
  if (platform === 'linux') {
    try {
      const [executablePath, commandLine, stat] = await Promise.all([
        fs.promises.readlink(`/proc/${pid}/exe`), fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf8'),
        fs.promises.readFile(`/proc/${pid}/stat`, 'utf8'),
      ]);
      return normalizeIdentity({ name: path.basename(executablePath), executablePath,
        commandLine: commandLine.replace(/\0/g, ' '), startedAt: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] });
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
      throw error;
    }
  }
  const result = await commandRunner('ps', ['-p', String(pid), '-o', 'comm=', '-o', 'lstart=', '-o', 'args='], { timeoutMs: 1500 });
  if (result.code !== 0) throw new Error(`Process identity probe failed: ${(result.stderr || result.stdout || `exit ${result.code}`).trim()}`);
  if (!result.stdout.trim()) return null;
  const match = /^\s*(\S+)\s+(.{24})\s+([\s\S]+)$/.exec(result.stdout);
  return match ? normalizeIdentity({ name: path.basename(match[1]), executablePath: match[1], startedAt: match[2], commandLine: match[3] }) : null;
}

export class ComfyUiManagedProcess {
  constructor(cfg, {
    spawnProcess = spawn, platform = process.platform, env = process.env,
    fetchImpl = globalThis.fetch, bind = bindPort, random = Math.random,
    commandRunner = runCommand, processIdentity = null, processAlive = processExists, killTree = null,
    stateFile = null, logger = null, warner = null, onChild = null, onStatus = null,
    pollIntervalMs = 100, gracefulTimeoutMs = 750,
  } = {}) {
    Object.assign(cfg, resolveSelfiePaths(cfg, { env }));
    this.cfg = cfg;
    this.paths = createLocalPaths({ repoRoot: cfg.rootDir, env: { ...env, WAIFU_LOCAL_DIR: cfg.localDir } });
    this.settings = cfg.comfyuiManaged || resolveManagedPaths(cfg, this.paths);
    this.rootDir = cfg.rootDir || ROOT_DIR;
    this.installDir = this._resolve(this.settings.installDir, this.rootDir);
    this.pythonPath = this._resolve(this.settings.pythonPath, this.installDir || this.rootDir);
    this.mainScript = this._resolve(this.settings.mainScript, this.installDir || this.rootDir);
    this.host = this.settings.host || '127.0.0.1';
    this.profile = this.settings.profile || null;
    this.spawnProcess = spawnProcess;
    this.platform = platform;
    this.env = { ...env, ...(this.settings.env || {}) };
    this.fetch = fetchImpl;
    this.bind = bind;
    this.random = random;
    this.commandRunner = commandRunner;
    this.processIdentity = processIdentity || (pid => getProcessIdentity(pid, platform, commandRunner));
    this.processAlive = processAlive;
    this.killTree = killTree;
    this.stateFile = stateFile || path.join(this.rootDir, 'data', 'comfyui-managed-process.json');
    const fileLogger = createSelfieLogger(cfg.logPath);
    this.log = logger || fileLogger.log;
    this.warn = warner || fileLogger.warn;
    this.onChild = onChild;
    this.pollIntervalMs = pollIntervalMs;
    this.gracefulTimeoutMs = gracefulTimeoutMs;
    this.child = null;
    this.baseUrl = null;
    this.coldStartMs = 0;
    this.stdoutTail = '';
    this.stderrTail = '';
    this.launchArgs = null;
    this.statusListener = onStatus;
    this._helpPromise = null;
    this._helpController = null;
    this._startPromise = null;
    this._stopPromise = null;
    this._startController = null;
    this._idleTimer = null;
    this._ownedRecord = null;
    this._startupError = null;
    this._cleanupError = null;
    this._readyChild = false;
    this._identityProbed = false;
    this._backendIdentity = null;
    this._startup = Promise.resolve().then(() => this.cleanupStaleProcess()).catch(error => { this._startupError = error; });
  }

  _resolve(value, base) {
    return this.paths.resolvePath(value, { baseDir: base });
  }

  setStatusListener(listener) { this.statusListener = typeof listener === 'function' ? listener : null; }

  _notify() {
    try { this.statusListener?.(this.getStatus()); } catch { /* Observers cannot affect the child. */ }
  }

  getStatus() {
    return { profile: this.profile, running: isAlive(this.child), starting: Boolean(this._startPromise),
      pid: isAlive(this.child) ? this.child.pid : null, coldStartMs: this.coldStartMs,
      ...(this.settings._runtimeWarnings?.length && { warnings: this.settings._runtimeWarnings.map(value => ({ ...value })) }) };
  }

  getDiagnostics() { return { stdoutTail: this.stdoutTail, stderrTail: this.stderrTail }; }

  async initialize() {
    await this._startup;
    if (this._startupError) throw this._startupError;
  }

  async cleanupStaleProcess() {
    let record;
    try { record = JSON.parse(await fs.promises.readFile(this.stateFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') this.warn(`comfyui-managed: ignored unreadable ownership record: ${error.message}`);
      return;
    }
    if (record.owner !== OWNER || !Number.isSafeInteger(record.pid) || record.pid <= 0
      || !samePath(record.rootDir, this.rootDir, this.platform)) {
      this.warn('comfyui-managed: ignored an unrecognized process ownership record.');
      return;
    }
    const owner = await this.processIdentity(record.backendPid);
    if ((owner && (!record.backendStartedAt || owner.startedAt === record.backendStartedAt))
      || (!owner && this.processAlive(record.backendPid))) {
      throw new Error('comfyui-managed: the recorded child belongs to a backend that is still running; refusing to stop or reuse it.');
    }
    const identity = await this.processIdentity(record.pid);
    const expectedName = path.basename(record.pythonPath || '').toLowerCase();
    const actualName = path.basename(identity?.name || '').toLowerCase();
    const command = (identity?.commandLine || '').replace(/\\/g, '/');
    const script = String(record.mainScript || '').replace(/\\/g, '/');
    const hasScript = script && (this.platform === 'win32' ? command.toLowerCase().includes(script.toLowerCase()) : command.includes(script));
    if (identity && actualName === expectedName && samePath(identity.executablePath, record.pythonPath, this.platform)
      && hasScript && !record.startedAt) {
      throw new Error(`comfyui-managed: owned PID ${record.pid} has no verified recorded start time; refusing unsafe cleanup and retaining its ownership record.`);
    }
    if (identity && actualName === expectedName && samePath(identity.executablePath, record.pythonPath, this.platform)
      && hasScript && record.startedAt && identity.startedAt === record.startedAt) {
      this.log(`comfyui-managed: stopping owned stale ComfyUI child ${record.pid}.`);
      await this._killPid(record.pid, true);
    } else if (identity) {
      this.warn(`comfyui-managed: stale PID ${record.pid} no longer matches its recorded process name, executable, script, and start time; leaving it untouched.`);
    }
    await fs.promises.rm(this.stateFile, { force: true });
  }

  async checkReady(signal) {
    signal?.throwIfAborted();
    await this._startup;
    signal?.throwIfAborted();
    if (!isAlive(this.child)) {
      const previousPaths = JSON.stringify([this.installDir, this.pythonPath, this.mainScript]);
      Object.assign(this.settings, resolveManagedPaths(this.settings, this.paths));
      this.installDir = this.settings.installDir;
      this.pythonPath = this.settings.pythonPath;
      this.mainScript = this.settings.mainScript;
      if (previousPaths !== JSON.stringify([this.installDir, this.pythonPath, this.mainScript])) this._helpPromise = null;
    }
    const reasons = [];
    if (!Object.values(this.settings._legacyPaths || {}).some(Boolean) && !this.settings._localRuntime?.valid) {
      reasons.push(this.settings._localRuntime?.message || 'Local ComfyUI runtime is missing.');
    }
    for (const warning of this.settings._runtimeWarnings || []) {
      this.warn(`${warning.message} ${this.settings._localRuntime?.message || ''}`);
    }
    if (this._startupError) reasons.push(this._startupError.message);
    if (this._cleanupError) reasons.push(this._cleanupError.message);
    for (const [field, value, directory] of [
      ['installDir', this.installDir, true], ['pythonPath', this.pythonPath, false], ['mainScript', this.mainScript, false],
    ]) {
      if (!value) { reasons.push(`comfyuiManaged.${field} is not configured.`); continue; }
      try {
        const stat = await fs.promises.stat(value);
        if (directory ? !stat.isDirectory() : !stat.isFile()) reasons.push(`comfyuiManaged.${field} is not a ${directory ? 'directory' : 'file'}: ${value}`);
      } catch (error) {
        reasons.push(`comfyuiManaged.${field} ${error.code === 'ENOENT' ? 'does not exist' : 'cannot be accessed'}: ${value}`);
      }
    }
    if (!['127.0.0.1', 'localhost', '::1'].includes(this.host)) reasons.push(`comfyuiManaged.host must be loopback; received ${this.host}.`);
    if (this.profile && !Object.hasOwn(this.settings.profiles || {}, this.profile)) reasons.push(`comfyuiManaged.profile does not exist: ${this.profile}`);
    const warnings = [];
    if (!reasons.length) {
      try {
        const help = await this._getHelp(signal);
        this.launchArgs = filterComfyUiManagedArgs([
          ...(this.settings.args || []), ...(this.settings.profiles?.[this.profile]?.args || []),
        ], help, message => { warnings.push(message); this.warn(message); });
        if (!this._identityProbed) {
          this._backendIdentity = await this.processIdentity(process.pid);
          this._identityProbed = true;
        }
      } catch (error) {
        signal?.throwIfAborted();
        reasons.push(`comfyui-managed: launch readiness failed for ${this.pythonPath} ${this.mainScript}: ${error.message}`);
      }
    }
    signal?.throwIfAborted();
    return { ready: reasons.length === 0, reasons, warnings,
      ...(!Object.values(this.settings._legacyPaths || {}).some(Boolean) && !this.settings._localRuntime?.valid && {
        code: this.settings._localRuntime.code, publicMessage: this.settings._localRuntime.publicMessage,
      }),
      ...(this.settings._runtimeWarnings?.length && { runtimeWarnings: this.settings._runtimeWarnings.map(value => ({ ...value })) }) };
  }

  async _getHelp(signal) {
    if (!this._helpPromise) {
      this._helpController = new AbortController();
      const controller = this._helpController;
      this._helpPromise = (async () => {
        const [pythonStat, mainStat] = await Promise.all([fs.promises.stat(this.pythonPath), fs.promises.stat(this.mainScript)]);
        const key = JSON.stringify([this.pythonPath, pythonStat.mtimeMs, this.mainScript, mainStat.mtimeMs, this.installDir, this.settings.env || {}]);
        controller.signal.throwIfAborted();
        if (HELP_CACHE.has(key)) return HELP_CACHE.get(key);
        const result = await this.commandRunner(this.pythonPath, [this.mainScript, '--help'], {
          cwd: this.installDir, env: this.env, timeoutMs: HELP_TIMEOUT_MS, spawnProcess: this.spawnProcess,
          signal: controller.signal,
        });
        if (result.code !== 0) throw new Error(`help exited ${result.code}: ${(result.stderr || result.stdout || '').slice(-TAIL_BYTES)}`);
        const text = `${result.stdout || ''}\n${result.stderr || ''}`;
        HELP_CACHE.set(key, text);
        return text;
      })().finally(() => {
        if (this._helpController === controller) this._helpController = null;
      });
      this._helpPromise.catch(() => { this._helpPromise = null; });
    }
    if (!signal) return this._helpPromise;
    signal.throwIfAborted();
    let onAbort;
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => { this._helpController?.abort(abortReason(signal)); reject(abortReason(signal)); };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try { return await Promise.race([this._helpPromise, aborted]); }
    finally { signal.removeEventListener('abort', onAbort); }
  }

  async ensureRunning(signal) {
    signal?.throwIfAborted();
    this.cancelIdleStop();
    if (this._stopPromise) await this._stopPromise;
    signal?.throwIfAborted();
    if (isAlive(this.child) && !this._startPromise) {
      if (!this._readyChild) throw this._cleanupError || new Error('comfyui-managed: an owned child failed readiness and could not be stopped; refusing to start another child.');
      return { baseUrl: this.baseUrl, coldStartMs: 0, pid: this.child.pid, reused: true };
    }
    if (!this._startPromise) {
      this._startController = new AbortController();
      const onAbort = () => this._startController?.abort(abortReason(signal));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      this._startPromise = this._start(this._startController.signal).finally(() => {
        signal?.removeEventListener('abort', onAbort);
        this._startPromise = null;
        this._startController = null;
        this._notify();
      });
    }
    const result = await this._startPromise;
    signal?.throwIfAborted();
    return result;
  }

  async _start(signal) {
    const ready = await this.checkReady(signal);
    if (!ready.ready) throw new Error(ready.reasons.join('; '));
    const port = await findComfyUiManagedPort(this.host, {
      requestedPort: this.settings.port ?? 'auto', bind: this.bind, random: this.random,
    });
    signal.throwIfAborted();
    const start = Date.now();
    this.stdoutTail = '';
    this.stderrTail = '';
    this._readyChild = false;
    this._cleanupError = null;
    this.baseUrl = `http://${this.host.includes(':') ? `[${this.host}]` : this.host}:${port}`;
    let childError;
    const args = [this.mainScript, '--listen', this.host, '--port', String(port), '--disable-auto-launch', ...this.launchArgs];
    this.child = this.spawnProcess(this.pythonPath, args, {
      cwd: this.installDir, env: this.env, shell: false, windowsHide: true,
      detached: this.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = this.child;
    child.managedClosed = false;
    child.stdout?.on('data', chunk => { this.stdoutTail = (this.stdoutTail + chunk.toString()).slice(-TAIL_BYTES); });
    child.stderr?.on('data', chunk => { this.stderrTail = (this.stderrTail + chunk.toString()).slice(-TAIL_BYTES); });
    child.once('error', error => { childError = error; });
    child.once('close', () => {
      child.managedClosed = true;
      if (this.child === child) {
        this._notify();
        if (!this._cleanupError) void this._removeOwnedRecord(child.pid).catch(error => this.warn(`comfyui-managed: ${error.message}`));
      }
    });
    try {
      this.onChild?.(child);
      this._notify();
      if (!child.pid) throw childError || new Error('The configured interpreter could not start.');
      this._ownedRecord = { owner: OWNER, rootDir: this.rootDir, pid: child.pid,
        pythonPath: this.pythonPath, mainScript: this.mainScript, startedAt: null,
        backendPid: process.pid, backendStartedAt: '', profile: this.profile };
      await fs.promises.mkdir(path.dirname(this.stateFile), { recursive: true });
      await fs.promises.writeFile(this.stateFile, JSON.stringify(this._ownedRecord, null, 2), 'utf8');
      const identity = await this.processIdentity(child.pid);
      const backendIdentity = this._backendIdentity;
      if (!identity?.startedAt) throw new Error('Cannot verify the managed child identity and start time for safe orphan cleanup.');
      this._ownedRecord = { owner: OWNER, rootDir: this.rootDir, pid: child.pid,
        pythonPath: this.pythonPath, mainScript: this.mainScript, startedAt: identity.startedAt,
        backendPid: process.pid, backendStartedAt: backendIdentity?.startedAt || '', profile: this.profile };
      await fs.promises.mkdir(path.dirname(this.stateFile), { recursive: true });
      await fs.promises.writeFile(this.stateFile, JSON.stringify(this._ownedRecord, null, 2), 'utf8');
      const timeoutMs = Number(this.settings.startTimeoutMs) > 0 ? Number(this.settings.startTimeoutMs) : 120000;
      const deadline = start + timeoutMs;
      let healthError = null;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (!isAlive(child)) throw childError || new Error(`ComfyUI exited before readiness (${child.exitCode ?? child.signalCode}).`);
        const controller = new AbortController();
        const onAbort = () => controller.abort(abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        const timer = setTimeout(() => controller.abort(new Error('Health request timed out.')), Math.max(1, Math.min(1000, deadline - Date.now())));
        try {
          const response = await this.fetch(new URL(this.settings.healthPath || '/system_stats', this.baseUrl), { signal: controller.signal });
          if (response.ok) {
            this.coldStartMs = Date.now() - start;
            this._readyChild = true;
            this.log(`comfyui-managed: ready on ${this.baseUrl} (${this.coldStartMs} ms cold start, profile ${this.profile || 'default'}).`);
            this._notify();
            return { baseUrl: this.baseUrl, coldStartMs: this.coldStartMs, pid: child.pid, reused: false };
          }
          healthError = `HTTP ${response.status}`;
        } catch (error) { healthError = error.message; }
        finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
        await sleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
      }
      throw new Error(`ComfyUI health ${this.settings.healthPath || '/system_stats'} timed out after ${timeoutMs} ms${healthError ? ` (${healthError})` : ''}.`);
    } catch (error) {
      this.coldStartMs = Date.now() - start;
      try { await this._stopOwnedChild(); }
      catch (cleanupError) {
        this._cleanupError = cleanupError;
        this.warn(cleanupError.message);
        throw new Error(`comfyui-managed: ${error.message}; cleanup failed: ${cleanupError.message}`);
      }
      const tail = [this.stderrTail, this.stdoutTail].filter(Boolean).join('\n').trim();
      if (signal.aborted) throw abortReason(signal);
      throw new Error(`comfyui-managed: ${error.message}${tail ? `\nChild output tail:\n${tail}` : ''}`);
    }
  }

  cancelIdleStop() {
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
  }

  armIdleStop() {
    this.cancelIdleStop();
    if (!isAlive(this.child)) return;
    const seconds = Number(this.settings.idleStopSeconds ?? 90);
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      void this.stop().catch(error => this.warn(`comfyui-managed: idle stop failed: ${error.message}`));
    }, Math.max(0, Number.isFinite(seconds) ? seconds : 90) * 1000);
    this._idleTimer.unref?.();
  }

  async _killPid(pid, force) {
    if (this.killTree) return this.killTree(pid, { force, platform: this.platform });
    if (this.platform === 'win32') {
      try {
        const result = await this.commandRunner('taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { timeoutMs: 2000 });
        if (force && result.code !== 0) throw new Error((result.stderr || result.stdout || `exit ${result.code}`).trim());
      } catch (error) {
        if (force) throw new Error(`comfyui-managed: taskkill /T /F failed for owned PID ${pid}; ownership record retained: ${error.message}`);
      }
      return;
    }
    try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }

  async _removeOwnedRecord(pid) {
    if (!pid) return;
    let record;
    try { record = JSON.parse(await fs.promises.readFile(this.stateFile, 'utf8')); }
    catch { return; }
    if (record.owner === OWNER && record.pid === pid && record.backendPid === process.pid
      && record.startedAt === this._ownedRecord?.startedAt) await fs.promises.rm(this.stateFile, { force: true });
  }

  async _stopOwnedChild() {
    const child = this.child;
    if (!child) return;
    this.cancelIdleStop();
    if (child.pid) {
      const wasAlive = isAlive(child);
      if (wasAlive) {
        await this._killPid(child.pid, false);
        await waitForClose(child, this.gracefulTimeoutMs);
      }
      // Windows /T already targets descendants. Never force an exited/reused Windows PID.
      if (isAlive(child) || (wasAlive && this.platform !== 'win32')) {
        try { await this._killPid(child.pid, true); }
        catch (error) { this._cleanupError = error; this._notify(); throw error; }
      }
      await waitForClose(child, 2000);
      if (isAlive(child)) {
        this._cleanupError = new Error(`comfyui-managed: owned PID ${child.pid} is still running after tree termination; ownership record retained.`);
        this._notify();
        throw this._cleanupError;
      }
      await this._removeOwnedRecord(child.pid);
    }
    if (this.child === child) this.child = null;
    this.baseUrl = null;
    this._ownedRecord = null;
    this._readyChild = false;
    this._cleanupError = null;
    this._notify();
  }

  stop() {
    this.cancelIdleStop();
    if (!this._stopPromise) {
      this._helpController?.abort(new Error('Managed ComfyUI stopped.'));
      this._startController?.abort(new Error('Managed ComfyUI stopped.'));
      this._stopPromise = (async () => {
        if (this._startPromise) await this._startPromise.catch(() => {});
        await this._stopOwnedChild();
      })().finally(() => { this._stopPromise = null; });
    }
    return this._stopPromise;
  }
}

/** Backend startup also cleans owned stale children when another provider is selected. */
export function cleanupManagedComfyUiOnStartup(cfg, deps = {}) {
  const stateFile = deps.stateFile || path.join(cfg.rootDir || ROOT_DIR, 'data', 'comfyui-managed-process.json');
  if (!STARTUP_CLEANUPS.has(stateFile)) {
    const lifecycle = new ComfyUiManagedProcess(cfg, { ...deps, stateFile });
    const cleanup = lifecycle.initialize();
    STARTUP_CLEANUPS.set(stateFile, cleanup);
    cleanup.catch(() => STARTUP_CLEANUPS.delete(stateFile));
  }
  return STARTUP_CLEANUPS.get(stateFile);
}
