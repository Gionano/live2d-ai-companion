import fs from 'node:fs/promises';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ImageProvider, ImageProviderError, IMAGE_ERROR } from '../imageProvider.js';

export const CLOUDFLARE_MODEL = '@cf/black-forest-labs/flux-2-klein-9b';
export const CLOUDFLARE_ORIGIN = 'https://api.cloudflare.com';
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp']);

function cloudError(code, message, extra = {}) {
  return new ImageProviderError(code, message, extra);
}

function abortError(signal) {
  return signal?.reason instanceof ImageProviderError ? signal.reason
    : cloudError(IMAGE_ERROR.CANCELLED, 'Cloud photo cancelled.');
}

async function untilAborted(promise, signal) {
  if (signal?.aborted) {
    Promise.resolve(promise).catch(() => {});
    throw abortError(signal);
  }
  if (!signal) return promise;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([promise, aborted]);
    if (signal.aborted) throw abortError(signal);
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function readJson(response, maxBytes, signal) {
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) throw cloudError(IMAGE_ERROR.FAILED, 'Cloud response exceeds the size limit.');
  if (!response.body) throw cloudError(IMAGE_ERROR.FAILED, 'Cloud response is empty.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await untilAborted(reader.read(), signal);
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw cloudError(IMAGE_ERROR.FAILED, 'Cloud response exceeds the size limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (signal?.aborted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw cloudError(IMAGE_ERROR.FAILED, 'Cloud response is not valid JSON.');
  }
}

function httpError(status) {
  if (status === 401 || status === 403) return cloudError(IMAGE_ERROR.AUTH, 'Cloudflare authentication or permission failed.');
  if (status === 429) return cloudError(IMAGE_ERROR.RATE_LIMIT, 'Cloudflare rate limit reached.');
  return cloudError(IMAGE_ERROR.UNAVAILABLE, `Cloudflare request failed (HTTP ${status}).`);
}

export function buildCloudPrompt(positivePrompt) {
  if (typeof positivePrompt !== 'string' || !positivePrompt.trim() || positivePrompt.length > 20000) {
    throw cloudError(IMAGE_ERROR.FAILED, 'The photo scene prompt is invalid.', { beforeGeneration: true });
  }
  return 'Create one new portrait photograph using the person in image 0 as the identity reference. '
    + 'Preserve their face, hair, and recognizable appearance. Apply only the following requested scene, '
    + 'pose, expression, outfit, composition, and lighting: ' + positivePrompt.trim();
}

export class CloudProvider extends ImageProvider {
  constructor(config, { fetchImpl = fetch, sharpImpl = sharp, now = () => Date.now(), env = process.env } = {}) {
    super();
    this.cfg = config;
    this.fetchImpl = fetchImpl;
    this.sharpImpl = sharpImpl;
    this.now = now;
    this.env = env;
    this.active = null;
  }

  get name() { return 'cloud'; }

  async credentials() {
    const resolved = typeof this.cfg.cloudCredentials === 'function' ? await this.cfg.cloudCredentials() : {};
    const accountId = resolved?.accountId || this.cfg.cloud?.accountId || this.env.CLOUDFLARE_ACCOUNT_ID || '';
    const token = resolved?.token || this.env.CLOUDFLARE_API_TOKEN || '';
    if (!/^[a-f0-9]{32}$/i.test(accountId) || typeof token !== 'string' || !token || /[\r\n\0]/.test(token)) {
      throw cloudError(IMAGE_ERROR.UNAVAILABLE, 'Cloudflare account ID and API token are required.', { beforeGeneration: true });
    }
    if (this.cfg.cloud?.model && this.cfg.cloud.model !== CLOUDFLARE_MODEL) {
      throw cloudError(IMAGE_ERROR.UNAVAILABLE, 'The configured cloud image model is unsupported.', { beforeGeneration: true });
    }
    return { accountId, token };
  }

  async checkReady(signal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(cloudError(IMAGE_ERROR.TIMEOUT, 'Cloudflare connection check timed out.')),
      this.cfg.cloud?.healthTimeoutMs || 10000);
    try {
      const { accountId, token } = await untilAborted(this.credentials(), controller.signal);
      const url = `${CLOUDFLARE_ORIGIN}/client/v4/accounts/${accountId}/ai/models/search?search=flux-2-klein-9b`;
      const response = await untilAborted(this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: controller.signal,
      }), controller.signal);
      if (!response.ok) throw httpError(response.status);
      const data = await readJson(response, 1024 * 1024, controller.signal);
      const models = Array.isArray(data.result) ? data.result : [];
      if (data.success !== true || !models.some(model => model.name === CLOUDFLARE_MODEL || model.id === CLOUDFLARE_MODEL)) {
        throw cloudError(IMAGE_ERROR.UNAVAILABLE, 'Cloudflare Klein 9B is unavailable for this account.');
      }
      return { ready: true, code: 'READY', model: CLOUDFLARE_MODEL, generationTested: false,
        message: 'Cloudflare credentials verified; generation has not been tested.',
        publicMessage: 'Kredensial Cloudflare terverifikasi. Generasi belum diuji.' };
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      const safe = error instanceof ImageProviderError ? error : cloudError(IMAGE_ERROR.UNAVAILABLE, 'Cloudflare connection check failed.');
      return { ready: false, code: safe.code, message: safe.message,
        publicMessage: ({ AUTH: 'Token Cloudflare atau izin akun tidak valid.', RATE_LIMIT: 'Batas permintaan Cloudflare tercapai.',
          TIMEOUT: 'Pemeriksaan Cloudflare kehabisan waktu.' })[safe.code] || 'Cloudflare belum siap. Periksa akun, token, dan koneksi.' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async isAvailable(signal) { return (await this.checkReady(signal)).ready; }

  async prepareReference(name, signal) {
    const reference = name || this.cfg.defaultReference;
    if (typeof reference !== 'string' || !reference || path.basename(reference) !== reference
      || !/\.(png|jpe?g|webp)$/i.test(reference)) {
      throw cloudError(IMAGE_ERROR.FAILED, 'The photo reference is not in the reference whitelist.', { beforeGeneration: true });
    }
    const directory = await fs.realpath(this.cfg.referenceDir);
    const file = await fs.realpath(path.join(directory, reference));
    if (!file.startsWith(directory + path.sep)) throw cloudError(IMAGE_ERROR.FAILED, 'The photo reference is outside the reference directory.', { beforeGeneration: true });
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_REFERENCE_BYTES) throw cloudError(IMAGE_ERROR.FAILED, 'The photo reference exceeds the size limit.', { beforeGeneration: true });
    const bytes = await fs.readFile(file, { signal });
    const image = this.sharpImpl(bytes, { limitInputPixels: 40 * 1024 * 1024, animated: false });
    const metadata = await untilAborted(image.metadata(), signal);
    if (!IMAGE_FORMATS.has(metadata.format)) throw cloudError(IMAGE_ERROR.FAILED, 'The photo reference format is unsupported.', { beforeGeneration: true });
    return untilAborted(image.rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).png().toBuffer(), signal);
  }

  async decodeImage(base64, signal) {
    if (typeof base64 !== 'string' || !base64.length || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
      || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw cloudError(IMAGE_ERROR.FAILED, 'Cloudflare returned an invalid image.');
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== base64) throw cloudError(IMAGE_ERROR.FAILED, 'Cloudflare returned an invalid image.');
    const image = this.sharpImpl(bytes, { limitInputPixels: 4 * 1024 * 1024, animated: false });
    const metadata = await untilAborted(image.metadata(), signal);
    if (!IMAGE_FORMATS.has(metadata.format) || metadata.width !== 1024 || metadata.height !== 1024 || metadata.pages > 1) {
      throw cloudError(IMAGE_ERROR.FAILED, 'Cloudflare returned unexpected image dimensions or format.');
    }
    return untilAborted(image.png().toBuffer(), signal);
  }

  async generate(params, onProgress = () => {}, signal, onStarted = () => {}) {
    if (this.active) throw cloudError(IMAGE_ERROR.UNAVAILABLE, 'A cloud photo is already running.', { beforeGeneration: true });
    const controller = new AbortController();
    const job = { controller, submitted: false, target: null };
    this.active = job;
    const onAbort = () => controller.abort(cloudError(IMAGE_ERROR.CANCELLED, 'Cloud photo cancelled.'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(cloudError(IMAGE_ERROR.TIMEOUT, 'Cloud photo generation timed out.')),
      this.cfg.jobTimeoutMs || 600000);
    const t0 = this.now();
    try {
      const { accountId, token } = await untilAborted(this.credentials(), controller.signal);
      onProgress({ phase: 'preparing', percentage: null });
      const prompt = buildCloudPrompt(params.positivePrompt);
      const reference = await untilAborted(this.prepareReference(params.referenceImage, controller.signal), controller.signal);
      const seed = Number.isInteger(params.seed) && params.seed >= 0 && params.seed <= 2147483647 ? params.seed : randomInt(0, 2147483647);
      const form = new FormData();
      form.append('prompt', prompt);
      form.append('input_image_0', new Blob([reference], { type: 'image/png' }), 'reference.png');
      form.append('width', '1024');
      form.append('height', '1024');
      form.append('seed', String(seed));
      if (controller.signal.aborted) throw abortError(controller.signal);
      onStarted();
      if (controller.signal.aborted) throw abortError(controller.signal);
      job.submitted = true;
      onProgress({ phase: 'generating', percentage: null });
      const response = await untilAborted(this.fetchImpl(`${CLOUDFLARE_ORIGIN}/client/v4/accounts/${accountId}/ai/run/${CLOUDFLARE_MODEL}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
        signal: controller.signal, redirect: 'error',
      }), controller.signal);
      if (!response.ok) throw httpError(response.status);
      const data = await readJson(response, MAX_RESPONSE_BYTES, controller.signal);
      if (data.success !== true || typeof data.result?.image !== 'string') throw cloudError(IMAGE_ERROR.FAILED, 'Cloudflare did not return an image.');
      onProgress({ phase: 'validating', percentage: null });
      const image = await this.decodeImage(data.result.image, controller.signal);
      if (controller.signal.aborted) throw abortError(controller.signal);
      if (!this.cfg.outputDir) throw cloudError(IMAGE_ERROR.FAILED, 'The photo output directory is not configured.');
      await fs.mkdir(this.cfg.outputDir, { recursive: true });
      if (controller.signal.aborted) throw abortError(controller.signal);
      job.target = path.join(path.resolve(this.cfg.outputDir), `cloud_${randomUUID()}.png`);
      onProgress({ phase: 'saving', percentage: null });
      await fs.writeFile(job.target, image, { flag: 'wx', signal: controller.signal });
      if (controller.signal.aborted) throw abortError(controller.signal);
      return { imagePath: job.target, seed, timings: { generateMs: this.now() - t0, steps: 4 } };
    } catch (error) {
      if (job.target) await fs.unlink(job.target).catch(() => {});
      const safe = controller.signal.aborted ? abortError(controller.signal)
        : error instanceof ImageProviderError ? error : cloudError(IMAGE_ERROR.FAILED, 'Cloud photo generation failed.');
      safe.generationStarted = job.submitted;
      safe.beforeGeneration = !job.submitted;
      throw safe;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (this.active === job) this.active = null;
    }
  }

  async cancel() { this.active?.controller.abort(cloudError(IMAGE_ERROR.CANCELLED, 'Cloud photo cancelled.')); }
  async shutdown() { await this.cancel(); }
}
