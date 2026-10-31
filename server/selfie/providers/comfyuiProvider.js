// ---------------------------------------------------------------------------
// comfyuiProvider.js  (server-side, modul selfie / pap)
// ImageProvider untuk ComfyUI (HTTP + WebSocket API).
//  - Workflow template (format API) + pemetaan node lewat selfie.mapping.json
//  - Seed WAJIB diacak backend tiap job; hasil cache -> ulangi dengan seed baru
//  - Gambar referensi dari whitelist assets/references/, di-upload bila belum ada
//  - Progres lewat ws://host/ws?clientId=..., fallback polling /history/{id}
//  - Pembatalan: /interrupt + /queue delete; timeout otomatis (jobTimeoutMs)
//  - VRAM dibebaskan via /free setelah job (sukses/gagal/batal) bila freeVramAfter
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { ImageProvider, ImageProviderError, IMAGE_ERROR } from '../imageProvider.js';
import { resolveMapping, describeDetection } from './workflowMapping.js';
import { selfieLog as log, selfieWarn as warn } from '../log.js';
import { resolveSelfiePaths } from '../localPaths.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const LOADER_FILE_INPUT = /^(?:unet_name|vae_name|clip_name\d*|clip_vision_name|ckpt_name|lora_name|control_net_name|style_model_name|gligen_name|model_name|audio_encoder_name|image)$/;

function workflowShapeError(workflow) {
  if (!workflow || Array.isArray(workflow) || typeof workflow !== 'object' || Array.isArray(workflow.nodes)) {
    return 'expected a ComfyUI API workflow object';
  }
  const entries = Object.entries(workflow);
  if (entries.length === 0) return 'workflow has no nodes';
  const invalid = entries.find(([, node]) => !node || typeof node !== 'object'
    || typeof node.class_type !== 'string' || !node.class_type.trim()
    || !node.inputs || Array.isArray(node.inputs) || typeof node.inputs !== 'object');
  return invalid ? `node "${invalid[0]}" has no valid class_type or inputs` : null;
}

function errorHasCode(error, code, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  if (error.code === code) return true;
  if (errorHasCode(error.cause, code, seen)) return true;
  return Array.isArray(error.errors) && error.errors.some((item) => errorHasCode(item, code, seen));
}

function objectInfoChoices(nodeInfo, inputName) {
  const spec = nodeInfo?.input?.required?.[inputName] ?? nodeInfo?.input?.optional?.[inputName];
  const choices = Array.isArray(spec) ? spec[0] : null;
  return Array.isArray(choices) ? choices.map(String) : null;
}

export function validateComfyObjectInfo(workflow, objectInfo) {
  const shapeError = workflowShapeError(workflow);
  if (shapeError) {
    return {
      ready: false,
      code: 'COMFYUI_WORKFLOW_INVALID',
      message: `ComfyUI workflow is invalid: ${shapeError}.`,
      publicMessage: 'ComfyUI workflow is invalid.',
    };
  }
  const nodes = Object.values(workflow || {});
  const classTypes = [...new Set(nodes.map((node) => node?.class_type).filter(Boolean))];
  const missingNodes = classTypes.filter((classType) => !objectInfo?.[classType]);
  const missingFiles = [];
  const publicMissingFiles = [];

  for (const node of nodes) {
    const nodeInfo = objectInfo?.[node?.class_type];
    if (!nodeInfo) continue;
    for (const [inputName, configuredValue] of Object.entries(node.inputs || {})) {
      if (!LOADER_FILE_INPUT.test(inputName) || typeof configuredValue !== 'string') continue;
      const choices = objectInfoChoices(nodeInfo, inputName);
      if (!choices || !choices.includes(configuredValue)) {
        missingFiles.push(`${node.class_type}.${inputName}="${configuredValue}"`);
        publicMissingFiles.push(`${path.win32.basename(node.class_type)}.${inputName}="${path.win32.basename(configuredValue)}"`);
      }
    }
  }

  if (missingNodes.length || missingFiles.length) {
    const details = [];
    if (missingNodes.length) details.push(`Missing ComfyUI nodes: ${missingNodes.join(', ')}`);
    if (missingFiles.length) details.push(`Missing ComfyUI files: ${missingFiles.join(', ')}`);
    const publicDetails = [];
    if (missingNodes.length) publicDetails.push(`Missing ComfyUI nodes: ${missingNodes.map(name => path.win32.basename(name)).join(', ')}`);
    if (publicMissingFiles.length) publicDetails.push(`Missing ComfyUI files: ${publicMissingFiles.join(', ')}`);
    return {
      ready: false,
      code: missingNodes.length ? 'COMFYUI_NODES_MISSING' : 'COMFYUI_FILES_MISSING',
      message: `${details.join('. ')}.`,
      publicMessage: `${publicDetails.join('. ')}.`,
    };
  }

  return { ready: true, code: 'READY', message: 'ComfyUI is ready.' };
}

export function randomSeed() {
  return randomBytes(6).readUIntBE(0, 6); // 0 .. 2^48-1 (aman sebagai Number)
}

function timestampName(ext) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${p(d.getMilliseconds(), 3)}`;
  return `selfie_${stamp}${ext}`;
}

export class ComfyUiProvider extends ImageProvider {
  constructor(cfg, { env = process.env } = {}) {
    super();
    Object.assign(cfg, resolveSelfiePaths(cfg, { env }));
    this.cfg = cfg;
    this.baseUrl = cfg.comfyUrl;
    this.wsBase = cfg.comfyUrl.replace(/^http/i, 'ws');
    this.clientId = randomUUID();
    this.template = null; // workflow JSON mentah
    this.map = null; // hasil resolveMapping
    this.uploadedRefs = new Set();
    this.active = null; // { ctl, promptId }
  }

  get name() {
    return 'comfyui';
  }

  // ----- util HTTP ---------------------------------------------------------
  async _fetch(pathname, init = {}, timeoutMs = 15000) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(`${this.baseUrl}${pathname}`, { ...init, signal });
  }

  async _json(pathname, init, timeoutMs) {
    const res = await this._fetch(pathname, init, timeoutMs);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ImageProviderError(
        IMAGE_ERROR.FAILED,
        `ComfyUI ${init?.method ?? 'GET'} ${pathname} -> HTTP ${res.status} ${body.slice(0, 400)}`,
        { httpStatus: res.status },
      );
    }
    return res.json();
  }

  // ----- interface ---------------------------------------------------------
  /** Health check: GET /system_stats. */
  async isAvailable(signal) {
    signal?.throwIfAborted();
    try {
      const res = await this._fetch(
        this.cfg.comfyHealthPath || '/system_stats',
        { signal },
        this.cfg.healthTimeoutMs ?? this.cfg.healthCheckTimeoutMs ?? 1500,
      );
      signal?.throwIfAborted();
      return res.ok;
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }

  /** Verify the server, workflow nodes, and configured loader files without loading models. */
  async checkReady(signal) {
    signal?.throwIfAborted();
    const timeoutMs = this.cfg.healthTimeoutMs ?? this.cfg.healthCheckTimeoutMs ?? 1500;
    try {
      const healthPath = this.cfg.comfyHealthPath || '/system_stats';
      const stats = await this._fetch(healthPath, { signal }, timeoutMs);
      signal?.throwIfAborted();
      if (!stats.ok) {
        return {
          ready: false,
          code: 'COMFYUI_UNREACHABLE',
          message: `ComfyUI GET ${healthPath} returned HTTP ${stats.status}.`,
          publicMessage: `ComfyUI GET ${healthPath} returned HTTP ${stats.status}.`,
        };
      }
    } catch (err) {
      signal?.throwIfAborted();
      return {
        ready: false,
        code: 'COMFYUI_UNREACHABLE',
        message: `ComfyUI is unreachable at ${this.baseUrl}: ${err.message}`,
        publicMessage: 'ComfyUI is unreachable.',
      };
    }

    let workflow;
    try {
      workflow = JSON.parse(await fs.promises.readFile(this.cfg.workflowPath, { encoding: 'utf-8', signal }));
      signal?.throwIfAborted();
      const shapeError = workflowShapeError(workflow);
      if (shapeError) throw new Error(shapeError);
    } catch (err) {
      signal?.throwIfAborted();
      return {
        ready: false,
        code: 'COMFYUI_WORKFLOW_INVALID',
        message: `ComfyUI workflow is unavailable or invalid at ${this.cfg.workflowPath}: ${err.message}`,
        publicMessage: `ComfyUI workflow is missing or invalid: ${path.win32.basename(this.cfg.workflowPath)}.`,
      };
    }

    // A fresh portable install has no baked workflow reference in its input directory.
    // Prepare the configured whitelisted reference before checking loader choices.
    if (this.cfg.defaultReference) {
      try {
        await this.init(signal);
        const name = await this.ensureReference(this.cfg.defaultReference, signal);
        signal?.throwIfAborted();
        workflow[this.map.reference.id].inputs[this.map.reference.fields.image] = name;
      } catch (err) {
        signal?.throwIfAborted();
        return {
          ready: false,
          code: 'COMFYUI_REFERENCE_UNAVAILABLE',
          message: `ComfyUI reference preparation failed: ${err.message}`,
          publicMessage: `ComfyUI reference is unavailable: ${path.win32.basename(this.cfg.defaultReference)}.`,
        };
      }
    }

    let objectInfo;
    try {
      const response = await this._fetch('/object_info', { signal }, timeoutMs);
      signal?.throwIfAborted();
      if (!response.ok) {
        return {
          ready: false,
          code: 'COMFYUI_OBJECT_INFO',
          message: `ComfyUI GET /object_info returned HTTP ${response.status}.`,
          publicMessage: `ComfyUI GET /object_info returned HTTP ${response.status}.`,
        };
      }
      objectInfo = await response.json();
      signal?.throwIfAborted();
    } catch (err) {
      signal?.throwIfAborted();
      return {
        ready: false,
        code: 'COMFYUI_OBJECT_INFO',
        message: `ComfyUI /object_info could not be read: ${err.message}`,
        publicMessage: 'ComfyUI /object_info could not be read.',
      };
    }

    return validateComfyObjectInfo(workflow, objectInfo);
  }

  /**
   * Muat workflow + mapping, cetak node/field terdeteksi, dan pastikan referensi
   * default ada di ComfyUI. Melempar ImageProviderError(MAPPING) bila mapping salah.
   */
  async init(signal) {
    signal?.throwIfAborted();
    if (this.map) return;
    if (!fs.existsSync(this.cfg.workflowPath)) {
      throw new ImageProviderError(
        IMAGE_ERROR.MAPPING,
        `Workflow tidak ditemukan: ${this.cfg.workflowPath}. Ekspor dari ComfyUI lewat Workflow > Export (API).`,
      );
    }
    let workflow;
    let mapping;
    try {
      workflow = JSON.parse(await fs.promises.readFile(this.cfg.workflowPath, { encoding: 'utf-8', signal }));
      signal?.throwIfAborted();
    } catch (err) {
      signal?.throwIfAborted();
      throw new ImageProviderError(IMAGE_ERROR.MAPPING, `Workflow bukan JSON valid: ${err.message}`);
    }
    if (workflow.nodes && Array.isArray(workflow.nodes)) {
      throw new ImageProviderError(
        IMAGE_ERROR.MAPPING,
        'File workflow tampaknya format UI (punya "nodes"), bukan format API. Ekspor ulang lewat Workflow > Export (API).',
      );
    }
    try {
      mapping = JSON.parse(await fs.promises.readFile(this.cfg.mappingPath, { encoding: 'utf-8', signal }));
      signal?.throwIfAborted();
    } catch (err) {
      signal?.throwIfAborted();
      throw new ImageProviderError(IMAGE_ERROR.MAPPING, `selfie.mapping.json tidak bisa dibaca: ${err.message}`);
    }
    const resolved = resolveMapping(workflow, mapping);
    describeDetection(workflow, resolved, log);
    this.template = workflow;
    this.map = resolved;
  }

  /** Daftar gambar referensi (whitelist) di folder referensi. */
  listReferences() {
    try {
      return fs
        .readdirSync(this.cfg.referenceDir)
        .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
        .sort();
    } catch {
      return [];
    }
  }

  /** Pastikan file referensi (whitelist) ada di input ComfyUI; upload bila belum/berbeda. */
  async ensureReference(name, signal) {
    signal?.throwIfAborted();
    const whitelist = this.listReferences();
    if (!name || name !== path.basename(name) || !whitelist.includes(name)) {
      throw new ImageProviderError(
        IMAGE_ERROR.FAILED,
        `Referensi "${name}" tidak ada di whitelist (${this.cfg.referenceDir}). Tersedia: ${whitelist.join(', ') || '(kosong)'}`,
      );
    }
    if (this.uploadedRefs.has(name)) return name;

    const localPath = path.join(this.cfg.referenceDir, name);
    const bytes = await fs.promises.readFile(localPath, { signal });
    signal?.throwIfAborted();

    let needUpload = true;
    try {
      const res = await this._fetch(`/view?filename=${encodeURIComponent(name)}&type=input`, { signal }, 20000);
      signal?.throwIfAborted();
      if (res.ok) {
        const remote = Buffer.from(await res.arrayBuffer());
        signal?.throwIfAborted();
        needUpload = remote.length !== bytes.length || !remote.equals(bytes);
      }
    } catch {
      signal?.throwIfAborted();
      needUpload = true;
    }

    if (needUpload) {
      const form = new FormData();
      form.append('image', new Blob([bytes]), name);
      form.append('type', 'input');
      form.append('overwrite', 'true');
      const res = await this._fetch('/upload/image', { method: 'POST', body: form, signal }, 60000);
      signal?.throwIfAborted();
      if (!res.ok) {
        throw new ImageProviderError(IMAGE_ERROR.FAILED, `Upload referensi "${name}" gagal: HTTP ${res.status}`);
      }
      log(`Referensi "${name}" diunggah ke ComfyUI input.`);
    } else {
      log(`Referensi "${name}" sudah ada di ComfyUI input.`);
    }
    this.uploadedRefs.add(name);
    return name;
  }

  async generate(params, onProgress = () => {}, signal, onStarted = () => {}) {
    const t0 = Date.now();
    const ctl = new AbortController();
    const job = { ctl, promptId: null, submitted: false, generationStarted: false, onStarted };
    this.active = job;
    job.aborted = new Promise((_, reject) => {
      ctl.signal.addEventListener('abort', () => {
        job.abortError = ctl.signal.reason === 'timeout'
          ? new ImageProviderError(IMAGE_ERROR.TIMEOUT, `Job melewati batas waktu ${this.cfg.jobTimeoutMs}ms.`)
          : new ImageProviderError(IMAGE_ERROR.CANCELLED, 'Job dibatalkan.');
        reject(job.abortError);
      }, { once: true });
    });
    job.aborted.catch(() => {});
    const onAbortSignal = () => ctl.abort('cancelled');
    signal?.addEventListener('abort', onAbortSignal, { once: true });
    if (signal?.aborted) onAbortSignal();
    const timeoutTimer = setTimeout(() => ctl.abort('timeout'), this.cfg.jobTimeoutMs);
    const wait = async (operation) => {
      if (ctl.signal.aborted) throw job.abortError;
      const result = await Promise.race([operation(), job.aborted]);
      if (ctl.signal.aborted) throw job.abortError;
      return result;
    };
    try {
      if (!await wait(() => this.isAvailable(ctl.signal))) {
        throw new ImageProviderError(IMAGE_ERROR.UNAVAILABLE, `ComfyUI tidak terjangkau di ${this.baseUrl}.`);
      }
      await wait(() => this.init(ctl.signal));
      const reference = params.referenceImage || this.cfg.defaultReference;
      await wait(() => this.ensureReference(reference, ctl.signal));
      const maxAttempts = 1 + Math.max(0, this.cfg.cacheRetries ?? 1);
      let lastErr;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // SEED: selalu diacak backend, kecuali pemanggil menyediakan seed eksplisit (hanya attempt pertama).
        const seed = attempt === 1 && Number.isFinite(params.seed) ? params.seed : randomSeed();
        try {
          job.promptId = null;
          job.submitted = false;
          const result = await this._runOnce({ ...params, referenceImage: reference, seed }, onProgress, job);
          result.timings.totalMs = Date.now() - t0;
          log(
            `Selesai: ${result.imagePath} | seed=${seed} | antre=${result.timings.queueMs}ms ` +
              `generate=${result.timings.generateMs}ms unduh=${result.timings.downloadMs}ms total=${result.timings.totalMs}ms`,
          );
          return result;
        } catch (err) {
          lastErr = err;
          if (err.code === 'CACHED' && attempt < maxAttempts) {
            warn(`Job selesai tanpa output baru (hasil cache). Mengulang dengan seed baru (percobaan ${attempt + 1}/${maxAttempts}).`);
            continue;
          }
          throw err.code === 'CACHED'
            ? new ImageProviderError(IMAGE_ERROR.FAILED, 'ComfyUI mengembalikan hasil cache berulang kali tanpa output baru.')
            : err;
        }
      }
      throw lastErr;
    } catch (err) {
      const failure = ctl.signal.aborted ? job.abortError : err;
      if (failure && failure.generationStarted === undefined) {
        failure.generationStarted = job.generationStarted;
      }
      throw failure;
    } finally {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbortSignal);
      if (this.active === job) this.active = null;
      if (this.cfg.freeVramAfter) await this.release();
    }
  }

  async cancel() {
    if (this.active) this.active.ctl.abort('cancelled');
  }

  /** POST /free: bebaskan VRAM & model. */
  async release() {
    try {
      const res = await this._fetch(
        '/free',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ unload_models: true, free_memory: true }),
        },
        15000,
      );
      log(`VRAM dibebaskan via /free (HTTP ${res.status}).`);
    } catch (err) {
      warn(`Gagal memanggil /free: ${err.message}`);
    }
  }

  // ----- satu eksekusi job ---------------------------------------------------
  _buildPrompt(p) {
    const wf = JSON.parse(JSON.stringify(this.template));
    const m = this.map;
    const resolution = Number.isFinite(p.resolution) ? p.resolution : this.cfg.presets[this.cfg.preset].resolution;
    if ((p.width ?? resolution) !== (p.height ?? resolution)) {
      throw new ImageProviderError(IMAGE_ERROR.MAPPING,
        'This ComfyUI workflow exposes only square resolution. Use sdcpp for rectangular --size experiments.',
        { generationStarted: false });
    }
    const steps = Number.isFinite(p.steps) ? p.steps : this.cfg.presets[this.cfg.preset].steps;
    const cfgScale = Number.isFinite(p.cfgScale) ? p.cfgScale : this.cfg.presets[this.cfg.preset].cfg;

    wf[m.prompt.id].inputs[m.prompt.fields.positive] = p.positivePrompt ?? '';
    wf[m.prompt.id].inputs[m.prompt.fields.negative] = p.negativePrompt ?? '';
    wf[m.prompt.id].inputs[m.prompt.fields.resolution] = resolution;
    wf[m.reference.id].inputs[m.reference.fields.image] = p.referenceImage;
    wf[m.sampler.id].inputs[m.sampler.fields.seed] = p.seed;
    wf[m.sampler.id].inputs[m.sampler.fields.steps] = steps;
    if (m.sampler.fields.cfg) wf[m.sampler.id].inputs[m.sampler.fields.cfg] = cfgScale;
    wf[m.save.id].inputs[m.save.fields.filenamePrefix] = this.cfg.filenamePrefix;
    return wf;
  }

  async _runOnce(params, onProgress, job) {
    const { ctl, aborted } = job;
    const throwIfAborted = () => {
      if (ctl.signal.aborted) throw job.abortError;
    };

    let ws = null;
    let wsOpenTimer = null;
    let pollTimer = null;
    let submissionPending = false;
    const timings = { queueMs: 0, generateMs: 0, downloadMs: 0, totalMs: 0 };
    const markActualStart = () => {
      if (job.generationStarted) return;
      job.generationStarted = true;
      job.onStarted();
    };
    const markUnknownSubmission = (error) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.generationStarted = true;
      return failure;
    };

    try {
      throwIfAborted();
      const prompt = this._buildPrompt(params);
      // 1) WebSocket progres (dibuka sebelum submit agar tidak kehilangan event)
      const state = { wsConnected: false, sawExecuted: false, sawProgress: false, tStart: 0, tDone: 0, error: null };
      ws = new WebSocket(`${this.wsBase}/ws?clientId=${this.clientId}`);
      const earlyMessages = [];
      let finish; // diisi saat menunggu
      const done = new Promise((resolve, reject) => {
        finish = { resolve, reject };
      });
      done.catch(() => {}); // cegah unhandled bila reject sebelum di-await

      const handle = (type, data) => {
        if (data?.prompt_id && job.promptId && data.prompt_id !== job.promptId) return;
        switch (type) {
          case 'execution_start':
            if (!state.tStart) state.tStart = Date.now();
            break;
          case 'progress':
            state.sawProgress = true;
            if (!state.tStart) state.tStart = Date.now();
            onProgress({ value: data.value, max: data.max });
            break;
          case 'executed':
            if (data.node === this.map.save.id) state.sawExecuted = true;
            break;
          case 'executing':
            if (data.node === null && data.prompt_id === job.promptId) {
              state.tDone = Date.now();
              finish.resolve();
            }
            break;
          case 'execution_error':
            finish.reject(
              new ImageProviderError(
                IMAGE_ERROR.FAILED,
                `ComfyUI execution_error: ${data.exception_message ?? 'unknown'} (node ${data.node_id ?? '?'})`,
              ),
            );
            break;
          case 'execution_interrupted':
            finish.reject(new ImageProviderError(IMAGE_ERROR.CANCELLED, 'Job dihentikan (interrupted).'));
            break;
          default:
        }
      };

      ws.on('message', (raw, isBinary) => {
        if (isBinary) return; // preview gambar, abaikan
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!job.promptId) {
          earlyMessages.push(msg);
          return;
        }
        handle(msg.type, msg.data);
      });
      ws.on('error', (err) => warn(`WebSocket ComfyUI error: ${err.message}`));

      const wsOpened = new Promise((resolve) => {
        wsOpenTimer = setTimeout(resolve, 3000);
        ws.once('open', () => {
          state.wsConnected = true;
          clearTimeout(wsOpenTimer);
          resolve();
        });
        ws.once('error', () => {
          clearTimeout(wsOpenTimer);
          resolve();
        });
      });
      await Promise.race([wsOpened, aborted]);
      throwIfAborted();
      if (!state.wsConnected) warn('WebSocket ComfyUI tidak terhubung; memakai polling /history saja.');

      // 2) Submit job
      const tSubmit = Date.now();
      job.submitted = true;
      submissionPending = true;
      let submit;
      try {
        submit = await Promise.race([this._json(
          '/prompt',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, client_id: this.clientId }),
            signal: ctl.signal,
          },
          20000,
        ), aborted]);
        submissionPending = false;
      } catch (error) {
        if (ctl.signal.aborted) throw error;
        // HTTP rejection and connection refusal prove that ComfyUI did not accept this prompt.
        if (error?.httpStatus || errorHasCode(error, 'ECONNREFUSED')) {
          submissionPending = false;
          throw error;
        }
        // A lost 2xx response or reset connection may hide an accepted prompt. Never fail over.
        const failure = markUnknownSubmission(error);
        await this._cancelRemote(null, true);
        throw failure;
      }
      if (submit?.node_errors && Object.keys(submit.node_errors).length > 0) {
        throw new ImageProviderError(
          IMAGE_ERROR.FAILED,
          `ComfyUI menolak workflow: ${JSON.stringify(submit.node_errors).slice(0, 600)}`,
        );
      }
      if (typeof submit?.prompt_id !== 'string' || !submit.prompt_id.trim()) {
        const failure = new ImageProviderError(
          IMAGE_ERROR.FAILED,
          'ComfyUI accepted the prompt request but returned no valid prompt_id.',
          { generationStarted: true },
        );
        await this._cancelRemote(null, true);
        throw failure;
      }
      // Keep the submission response so cancellation can target the exact prompt.
      job.promptId = submit.prompt_id;
      try {
        markActualStart();
      } catch (error) {
        if (!ctl.signal.aborted) await this._cancelRemote(job.promptId, true);
        throw error;
      }
      throwIfAborted();
      log(`Job dikirim: prompt_id=${job.promptId} seed=${params.seed} ref=${params.referenceImage}`);
      for (const m of earlyMessages) handle(m.type, m.data);
      earlyMessages.length = 0;

      // 3) Fallback polling /history
      pollTimer = setInterval(async () => {
        try {
          const h = await this._json(`/history/${job.promptId}`, {}, 8000);
          const entry = h[job.promptId];
          if (!entry) return;
          // Selama WebSocket masih terbuka, penyelesaian ditentukan event WS (agar deteksi cache akurat).
          const wsOpen = ws && ws.readyState === WebSocket.OPEN;
          if (wsOpen && entry.status?.status_str !== 'error') return;
          if (entry.status?.status_str === 'error') {
            finish.reject(new ImageProviderError(IMAGE_ERROR.FAILED, 'ComfyUI melaporkan job error di /history.'));
          } else if (entry.status?.completed || entry.outputs) {
            if (!state.tDone) state.tDone = Date.now();
            finish.resolve();
          }
        } catch {
          // abaikan; coba lagi di interval berikutnya
        }
      }, this.cfg.pollIntervalMs);

      // 4) Tunggu selesai / abort
      await Promise.race([done, aborted]);
      throwIfAborted();

      if (!state.tStart) state.tStart = tSubmit;
      timings.queueMs = Math.max(0, state.tStart - tSubmit);
      timings.generateMs = Math.max(0, (state.tDone || Date.now()) - state.tStart);

      // 5) Hasil cache? (selesai tanpa eksekusi baru; hanya dinilai bila WS terhubung)
      if (state.wsConnected && !state.sawExecuted && !state.sawProgress) {
        const err = new Error('cache');
        err.code = 'CACHED';
        throw err;
      }

      // 6) Ambil info output dari /history, unduh, simpan
      const tDl = Date.now();
      const imagePath = await this._downloadResult(job.promptId, ctl.signal);
      throwIfAborted();
      timings.downloadMs = Date.now() - tDl;
      return { imagePath, seed: params.seed, promptId: job.promptId, timings };
    } catch (err) {
      if (ctl.signal.aborted) err = job.abortError;
      if (submissionPending && err && err.generationStarted === undefined) {
        err.generationStarted = true;
      }
      if (err.code === IMAGE_ERROR.CANCELLED || err.code === IMAGE_ERROR.TIMEOUT) {
        await this._cancelRemote(job.promptId, job.submitted);
      }
      throw err;
    } finally {
      clearTimeout(wsOpenTimer);
      if (pollTimer) clearInterval(pollTimer);
      try {
        ws?.close();
      } catch {
        // abaikan
      }
    }
  }

  async _cancelRemote(promptId, submitted = false) {
    if (!submitted) return;
    try {
      const owns = entry => promptId ? entry[1] === promptId : entry[3]?.client_id === this.clientId;
      let queue = await this._json('/queue', {}, 8000);
      const pendingIds = [...new Set((queue.queue_pending || []).filter(owns).map(entry => entry[1]))];
      if (pendingIds.length) {
        await this._json('/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: pendingIds }),
        }, 8000);
        // Our queued prompt may have started before deletion was processed.
        queue = await this._json('/queue', {}, 8000);
      }
      if ((queue.queue_running || []).some(owns)) {
        await this._fetch('/interrupt', { method: 'POST' }, 8000);
      }
      log(`Cancelled only owned ComfyUI prompt ${promptId || '(recovered by client ID)'}.`);
    } catch (err) {
      warn(`Could not clean up owned ComfyUI prompt: ${err.message}`);
    }
  }

  async _downloadResult(promptId, signal) {
    // History kadang butuh sesaat setelah event 'executing' null
    let entry;
    for (let i = 0; i < 10; i++) {
      signal?.throwIfAborted();
      const h = await this._json(`/history/${promptId}`, { signal }, 10000);
      entry = h[promptId];
      if (entry?.outputs) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    const images = entry?.outputs?.[this.map.save.id]?.images;
    if (!images || images.length === 0) {
      throw new ImageProviderError(IMAGE_ERROR.FAILED, 'ComfyUI selesai tetapi tidak ada gambar pada node SaveImage.');
    }
    const img = images[0];
    const ext = path.extname(img.filename || '').toLowerCase();
    if (!IMAGE_EXT.has(ext)) {
      throw new ImageProviderError(IMAGE_ERROR.FAILED, `Ekstensi output tidak didukung: "${img.filename}"`);
    }
    const q = new URLSearchParams({
      filename: img.filename,
      subfolder: img.subfolder ?? '',
      type: img.type ?? 'output',
    });
    const res = await this._fetch(`/view?${q}`, { signal }, 60000);
    if (!res.ok) {
      throw new ImageProviderError(IMAGE_ERROR.FAILED, `Gagal mengunduh hasil: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());

    signal?.throwIfAborted();
    fs.mkdirSync(this.cfg.outputDir, { recursive: true });
    const outDir = path.resolve(this.cfg.outputDir);
    const target = path.resolve(outDir, timestampName(ext));
    // Validasi path: tidak boleh keluar dari outputDir
    if (!target.startsWith(outDir + path.sep)) {
      throw new ImageProviderError(IMAGE_ERROR.FAILED, 'Path output di luar outputDir ditolak.');
    }
    fs.writeFileSync(target, buf, { flag: 'wx' });
    return target;
  }
}
