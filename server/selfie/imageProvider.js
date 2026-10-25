// ---------------------------------------------------------------------------
// imageProvider.js  (server-side, modul selfie / pap)
// Interface ImageProvider + factory. Job manager, planner, dan popup HANYA bicara
// lewat interface ini, tidak pernah ke ComfyUI/sd.cpp langsung.
//
//   isAvailable()                                      -> Promise<boolean>
//   generate(params, onProgress, signal)               -> Promise<{ imagePath, seed, timings }>
//       params = { positivePrompt, negativePrompt, referenceImage, resolution, steps, seed }
//       onProgress({ value, max })
//   cancel()                                           -> Promise<void>
//   release()                                          -> Promise<void>   (bebaskan VRAM)
// ---------------------------------------------------------------------------

export const IMAGE_ERROR = {
  UNAVAILABLE: 'UNAVAILABLE',
  MAPPING: 'MAPPING',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
};

export class ImageProviderError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ImageProviderError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export class ImageProvider {
  get name() {
    return 'base';
  }
  async isAvailable() {
    throw new Error('isAvailable() belum diimplementasikan');
  }
  async checkReady(signal) {
    const ready = await this.isAvailable(signal);
    return {
      ready,
      code: ready ? 'READY' : IMAGE_ERROR.UNAVAILABLE,
      message: ready ? `${this.name} is ready.` : `${this.name} is unavailable.`,
    };
  }
  // eslint-disable-next-line no-unused-vars
  async generate(params, onProgress, signal) {
    throw new Error('generate() belum diimplementasikan');
  }
  async cancel() {}
  async release() {}
}

/** Create a resolver for an explicit provider or the automatic fallback order. */
export async function createImageProvider(cfg, options = {}) {
  const { ProviderResolver } = await import('./providerResolver.js');
  return new ProviderResolver(cfg, options);
}
