import { invalid, object, text } from './schema.js';
import { validateBaseUrl } from '../providers/baseUrl.js';

export const CLOUD_IMAGE_MODEL = '@cf/black-forest-labs/flux-2-klein-9b';
export const CLOUD_IMAGE_ORIGIN = 'https://api.cloudflare.com';
export const CLOUD_IMAGE_SECRET_ID = 'pap-cloudflare';
export const IMAGE_PROVIDERS = ['comfyui', 'comfyui-managed', 'sdcpp', 'cloud'];

export function validateImageSettings(value) {
  object(value, ['provider', 'preset', 'comfyuiUrl', 'variant', 'cloud']);
  if (value.provider !== undefined && !IMAGE_PROVIDERS.includes(value.provider)) invalid();
  if (value.preset !== undefined && !['cepat', 'kualitas', 'hemat'].includes(value.preset)) invalid();
  if (value.variant !== undefined && !['auto', 'cuda12', 'vulkan'].includes(value.variant)) invalid();
  if (value.comfyuiUrl !== undefined) {
    text(value.comfyuiUrl, 2048);
    try { validateBaseUrl(value.comfyuiUrl); } catch { invalid(); }
  }
  if (value.cloud !== undefined) {
    object(value.cloud, ['accountId', 'model']);
    if (value.cloud.accountId !== undefined && (typeof value.cloud.accountId !== 'string'
      || value.cloud.accountId !== '' && !/^[a-f0-9]{32}$/i.test(value.cloud.accountId))) invalid();
    if (value.cloud.model !== undefined && value.cloud.model !== CLOUD_IMAGE_MODEL) invalid();
  }
  return structuredClone(value);
}

export function imageOverridesToSelfie(images = {}) {
  const result = {};
  for (const key of ['provider', 'preset', 'cloud']) if (images[key] !== undefined) result[key] = images[key];
  if (images.comfyuiUrl !== undefined) result.comfyUrl = images.comfyuiUrl;
  // Installation selects the runtime marker; advanced executable paths remain file/CLI settings.
  if (images.variant !== undefined) result.runtimeVariant = images.variant;
  return result;
}
