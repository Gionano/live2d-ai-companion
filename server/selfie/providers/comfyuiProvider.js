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

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

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
  constructor(cfg) {
    super();
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
    return fetch(`${this.baseUrl}${pathname}`, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  }

  async _json(pathname, init, timeoutMs) {
    const res = await this._fetch(pathname, init, timeoutMs);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ImageProviderError(
        IMAGE_ERROR.FAILED,
        `ComfyUI ${init?.method ?? 'GET'} ${pathname} -> HTTP ${res.status} ${body.slice(0, 400)}`,
      );
    }
    return res.json();
  }

  // ----- interface ---------------------------------------------------------
  /** Health check: GET /system_stats. */
  async isAvailable() {
    try {
      const res = await this._fetch('/system_stats', {}, this.cfg.healthCheckTimeoutMs);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Muat workflow + mapping, cetak node/field terdeteksi, dan pastikan referensi
   * default ada di ComfyUI. Melempar ImageProviderError(MAPPING) bila mapping salah.
   */
  async init() {
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
      workflow = JSON.parse(fs.readFileSync(this.cfg.workflowPath, 'utf-8'));
    } catch (err) {
      throw new ImageProviderError(IMAGE_ERROR.MAPPING, `Workflow bukan JSON valid: ${err.message}`);
    }
    if (workflow.nodes && Array.isArray(workflow.nodes)) {
      throw new ImageProviderError(
        IMAGE_ERROR.MAPPING,
        'File workflow tampaknya format UI (punya "nodes"), bukan format API. Ekspor ulang lewat Workflow > Export (API).',
      );
    }
    try {
      mapping = JSON.parse(fs.readFileSync(this.cfg.mappingPath, 'utf-8'));
    } catch (err) {
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
  async ensureReference(name) {
    const whitelist = this.listReferences();
    if (!name || name !== path.basename(name) || !whitelist.includes(name)) {
      throw new ImageProviderError(
        IMAGE_ERROR.FAILED,
        `Referensi "${name}" tidak ada di whitelist (${this.cfg.referenceDir}). Tersedia: ${whitelist.join(', ') || '(kosong)'}`,
      );
    }
    if (this.uploadedRefs.has(name)) return name;

    const localPath = path.join(this.cfg.referenceDir, name);
    const bytes = fs.readFileSync(localPath);

    let needUpload = true;
    try {
      const res = await this._fetch(`/view?filename=${encodeURIComponent(name)}&type=input`, {}, 20000);
      if (res.ok) {
        const remote = Buffer.from(await res.arrayBuffer());
        needUpload = remote.length !== bytes.length || !remote.equals(bytes);
      }
    } catch {
      needUpload = true;
    }

    if (needUpload) {
      const form = new FormData();
      form.append('image', new Blob([bytes]), name);
      form.append('type', 'input');
      form.append('overwrite', 'true');
      const res = await this._fetch('/upload/image', { method: 'POST', body: form }, 60000);
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

  async generate(params, onProgress = () => {}, signal) {
    const t0 = Date.now();
    if (!(await this.isAvailable())) {
      throw new ImageProviderError(IMAGE_ERROR.UNAVAILABLE, `ComfyUI tidak terjangkau di ${this.baseUrl}.`);
    }
    await this.init();

    const reference = params.referenceImage || this.cfg.defaultReference;
    await this.ensureReference(reference);

    const maxAttempts = 1 + Math.max(0, this.cfg.cacheRetries ?? 1);
    let lastErr;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // SEED: selalu diacak backend, kecuali pemanggil menyediakan seed eksplisit (hanya attempt pertama).
        const seed = attempt === 1 && Number.isFinite(params.seed) ? params.seed : randomSeed();
        try {
          const result = await this._runOnce({ ...params, referenceImage: reference, seed }, onProgress, signal);
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
    } finally {
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
    const steps = Number.isFinite(p.steps) ? p.steps : this.cfg.presets[this.cfg.preset].steps;

    wf[m.prompt.id].inputs[m.prompt.fields.positive] = p.positivePrompt ?? '';
    wf[m.prompt.id].inputs[m.prompt.fields.negative] = p.negativePrompt ?? '';
    wf[m.prompt.id].inputs[m.prompt.fields.resolution] = resolution;
    wf[m.reference.id].inputs[m.reference.fields.image] = p.referenceImage;
    wf[m.sampler.id].inputs[m.sampler.fields.seed] = p.seed;
    wf[m.sampler.id].inputs[m.sampler.fields.steps] = steps;
    wf[m.save.id].inputs[m.save.fields.filenamePrefix] = this.cfg.filenamePrefix;
    return wf;
  }

  async _runOnce(params, onProgress, signal) {
    const prompt = this._buildPrompt(params);
    const ctl = new AbortController();
    const job = { ctl, promptId: null };
    this.active = job;

    const onAbortSignal = () => ctl.abort('cancelled');
    if (signal) {
      if (signal.aborted) ctl.abort('cancelled');
      else signal.addEventListener('abort', onAbortSignal, { once: true });
    }
    const timeoutTimer = setTimeout(() => ctl.abort('timeout'), this.cfg.jobTimeoutMs);

    let ws = null;
    let pollTimer = null;
    const timings = { queueMs: 0, generateMs: 0, downloadMs: 0, totalMs: 0 };

    try {
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

      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3000);
        ws.once('open', () => {
          state.wsConnected = true;
          clearTimeout(t);
          resolve();
        });
        ws.once('error', () => {
          clearTimeout(t);
          resolve();
        });
      });
      if (!state.wsConnected) warn('WebSocket ComfyUI tidak terhubung; memakai polling /history saja.');

      // 2) Submit job
      const tSubmit = Date.now();
      const submit = await this._json(
        '/prompt',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, client_id: this.clientId }),
        },
        20000,
      );
      if (submit.node_errors && Object.keys(submit.node_errors).length > 0) {
        throw new ImageProviderError(
          IMAGE_ERROR.FAILED,
          `ComfyUI menolak workflow: ${JSON.stringify(submit.node_errors).slice(0, 600)}`,
        );
      }
      job.promptId = submit.prompt_id;
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
      const aborted = new Promise((_, reject) => {
        ctl.signal.addEventListener(
          'abort',
          () => {
            const reason = ctl.signal.reason;
            reject(
              reason === 'timeout'
                ? new ImageProviderError(IMAGE_ERROR.TIMEOUT, `Job melewati batas waktu ${this.cfg.jobTimeoutMs}ms.`)
                : new ImageProviderError(IMAGE_ERROR.CANCELLED, 'Job dibatalkan.'),
            );
          },
          { once: true },
        );
      });
      aborted.catch(() => {});
      try {
        await Promise.race([done, aborted]);
      } catch (err) {
        if (err.code === IMAGE_ERROR.CANCELLED || err.code === IMAGE_ERROR.TIMEOUT) {
          await this._cancelRemote(job.promptId);
        }
        throw err;
      }

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
      const imagePath = await this._downloadResult(job.promptId);
      timings.downloadMs = Date.now() - tDl;
      return { imagePath, seed: params.seed, promptId: job.promptId, timings };
    } finally {
      clearTimeout(timeoutTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (signal) signal.removeEventListener('abort', onAbortSignal);
      try {
        ws?.close();
      } catch {
        // abaikan
      }
      if (this.active === job) this.active = null;
    }
  }

  async _cancelRemote(promptId) {
    try {
      await this._fetch('/interrupt', { method: 'POST' }, 8000);
    } catch (err) {
      warn(`Gagal /interrupt: ${err.message}`);
    }
    if (promptId) {
      try {
        await this._fetch(
          '/queue',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ delete: [promptId] }),
          },
          8000,
        );
      } catch (err) {
        warn(`Gagal menghapus job dari antrean: ${err.message}`);
      }
    }
    log(`Job ${promptId} dibatalkan di ComfyUI (interrupt + hapus antrean).`);
  }

  async _downloadResult(promptId) {
    // History kadang butuh sesaat setelah event 'executing' null
    let entry;
    for (let i = 0; i < 10; i++) {
      const h = await this._json(`/history/${promptId}`, {}, 10000);
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
    const res = await this._fetch(`/view?${q}`, {}, 60000);
    if (!res.ok) {
      throw new ImageProviderError(IMAGE_ERROR.FAILED, `Gagal mengunduh hasil: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());

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
