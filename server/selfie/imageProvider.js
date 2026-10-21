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
  // eslint-disable-next-line no-unused-vars
  async generate(params, onProgress, signal) {
    throw new Error('generate() belum diimplementasikan');
  }
  async cancel() {}
  async release() {}
}

/** Buat provider sesuai cfg.provider. */
export async function createImageProvider(cfg) {
  switch (cfg.provider) {
    case 'comfyui': {
      const { ComfyUiProvider } = await import('./providers/comfyuiProvider.js');
      return new ComfyUiProvider(cfg);
    }
    case 'sdcpp': {
      const { SdCppProvider } = await import('./providers/sdcppProvider.js');
      return new SdCppProvider(cfg);
    }
    case 'cloud': {
      const { CloudProvider } = await import('./providers/cloudProvider.js');
      return new CloudProvider(cfg);
    }
    default:
      throw new Error(`Provider selfie tidak dikenal: ${cfg.provider}`);
  }
}
