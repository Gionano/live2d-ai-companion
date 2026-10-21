// ---------------------------------------------------------------------------
// sdcppProvider.js  (server-side, modul selfie / pap)
// KERANGKA provider stable-diffusion.cpp (sd-cli). Belum diuji end-to-end:
//  - konfigurasi jalur sd-cli, diffusion model, VAE, text encoder (--llm), vision (--llm_vision)
//  - builder argumen dari parameter ImageProvider
//  - parsing progres dari output proses
//  - pembatalan dengan kill proses
// Nama flag mengikuti sd.cpp terbaru; sesuaikan di buildArgs() bila build Anda berbeda.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ImageProvider, ImageProviderError, IMAGE_ERROR } from '../imageProvider.js';
import { selfieLog as log, selfieWarn as warn } from '../log.js';

export class SdCppProvider extends ImageProvider {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.sd = cfg.sdcpp || {};
    this.proc = null;
    this.cancelled = false;
  }

  get name() {
    return 'sdcpp';
  }

  async isAvailable() {
    return Boolean(this.sd.cliPath) && fs.existsSync(this.sd.cliPath) && Boolean(this.sd.diffusionModel);
  }

  /** Susun argumen sd-cli dari parameter ImageProvider. */
  buildArgs({ positivePrompt, negativePrompt, referenceImage, resolution, steps, seed }, outPath) {
    const sd = this.sd;
    const args = [];
    const flag = (name, value) => {
      if (value !== undefined && value !== null && value !== '') args.push(name, String(value));
    };
    flag('--diffusion-model', sd.diffusionModel);
    flag('--vae', sd.vae);
    flag('--llm', sd.llm);
    flag('--llm_vision', sd.llmVision);
    flag('-p', positivePrompt);
    flag('-n', negativePrompt);
    if (referenceImage) flag('-r', path.join(this.cfg.referenceDir, referenceImage));
    flag('-W', resolution);
    flag('-H', resolution);
    flag('--steps', steps);
    flag('--seed', seed);
    flag('--cfg-scale', sd.cfgScale);
    flag('--sampling-method', sd.samplingMethod);
    flag('--flow-shift', sd.flowShift);
    if (sd.offloadToCpu) args.push('--offload-to-cpu');
    flag('-o', outPath);
    if (Array.isArray(sd.extraArgs)) args.push(...sd.extraArgs.map(String));
    return args;
  }

  /** Ambil progres "n/m" dari satu baris output sd-cli. */
  static parseProgress(line) {
    const m = /(\d+)\s*\/\s*(\d+)\s*-\s*[\d.]+s\/it/.exec(line) || /\|\s*(\d+)\s*\/\s*(\d+)/.exec(line);
    return m ? { value: Number(m[1]), max: Number(m[2]) } : null;
  }

  async generate(params, onProgress = () => {}, signal) {
    if (!(await this.isAvailable())) {
      throw new ImageProviderError(IMAGE_ERROR.UNAVAILABLE, 'sd.cpp belum dikonfigurasi (sdcpp.cliPath / diffusionModel).');
    }
    const t0 = Date.now();
    fs.mkdirSync(this.cfg.outputDir, { recursive: true });
    const outPath = path.join(this.cfg.outputDir, `selfie_${Date.now()}.png`);
    const args = this.buildArgs(params, outPath);
    this.cancelled = false;

    return new Promise((resolve, reject) => {
      log(`Menjalankan sd-cli: ${this.sd.cliPath} ${args.length} argumen`);
      const proc = spawn(this.sd.cliPath, args, { windowsHide: true });
      this.proc = proc;
      const timer = setTimeout(() => {
        this.cancelled = false;
        proc.kill();
        reject(new ImageProviderError(IMAGE_ERROR.TIMEOUT, `sd-cli melewati ${this.cfg.jobTimeoutMs}ms.`));
      }, this.cfg.jobTimeoutMs);
      const onAbort = () => this.cancel();
      signal?.addEventListener('abort', onAbort, { once: true });

      const onData = (chunk) => {
        for (const line of chunk.toString().split(/\r?\n|\r/)) {
          const p = SdCppProvider.parseProgress(line);
          if (p) onProgress(p);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new ImageProviderError(IMAGE_ERROR.FAILED, `sd-cli gagal dijalankan: ${err.message}`));
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.proc = null;
        if (this.cancelled) return reject(new ImageProviderError(IMAGE_ERROR.CANCELLED, 'Job dibatalkan.'));
        if (code !== 0 || !fs.existsSync(outPath)) {
          return reject(new ImageProviderError(IMAGE_ERROR.FAILED, `sd-cli selesai dengan kode ${code} tanpa output.`));
        }
        const totalMs = Date.now() - t0;
        resolve({
          imagePath: outPath,
          seed: params.seed,
          timings: { queueMs: 0, generateMs: totalMs, downloadMs: 0, totalMs },
        });
      });
    });
  }

  async cancel() {
    if (this.proc) {
      this.cancelled = true;
      try {
        this.proc.kill();
      } catch (err) {
        warn(`Gagal kill sd-cli: ${err.message}`);
      }
    }
  }

  async release() {
    // Proses sd-cli berakhir sendiri setelah job sehingga VRAM otomatis bebas.
  }
}
