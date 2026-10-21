// Stub provider "cloud": belum diimplementasikan (sesuai spesifikasi Fase A).
import { ImageProvider, ImageProviderError, IMAGE_ERROR } from '../imageProvider.js';

export class CloudProvider extends ImageProvider {
  get name() {
    return 'cloud';
  }
  async isAvailable() {
    return false;
  }
  async generate() {
    throw new ImageProviderError(IMAGE_ERROR.NOT_IMPLEMENTED, 'Provider "cloud" belum diimplementasikan.');
  }
}
