import { providerFetch } from '../providers/resilience.js';
import { validateBaseUrl, validateProviderHeaders } from '../providers/baseUrl.js';
import { normalizeProviderError, httpProviderError } from '../providers/errors.js';
import { looksLikeLocalPath, looksLikeSecret } from './schema.js';

export async function listModels(service, { profile: id, apiKey, signal, fetchImpl = fetch }) {
  try {
    const profile = service.config().profiles[id];
    if (!profile || profile.adapter === 'fishAudio') return { models: [], reason: 'UNSUPPORTED' };
    const base = validateBaseUrl(profile.baseUrl);
    const credentials = service.resolver().profileSecrets(id, profile);
    const key = apiKey || credentials.apiKey;
    const headers = { ...credentials.headers, ...(key && (profile.adapter === 'anthropicNative'
      ? { 'x-api-key': key, 'anthropic-version': profile.anthropicVersion || '2023-06-01' }
      : { Authorization: 'Bearer ' + key })) };
    validateProviderHeaders(headers);
    const response = await providerFetch(base.url.replace(/\/$/, '') + '/models', { method: 'GET', headers, signal }, { baseUrl: base.url, fetchImpl });
    if (!response.ok) { await response.body?.cancel(); throw httpProviderError(response); }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024) return { models: [], reason: 'TOO_LARGE' };
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(body.data)) return { models: [], reason: 'BAD_RESPONSE' };
    const hidden = [key, ...Object.values(credentials.headers || {})].filter(Boolean);
    const models = [...new Set(body.data.slice(0, 1000).map(item => item?.id).filter(name => typeof name === 'string'
      && name.length > 0 && name.length <= 128 && /^[\p{L}\p{N}_.:/@ -]+$/u.test(name)
      && !looksLikeSecret(name) && !looksLikeLocalPath(name) && !hidden.some(secret => name.includes(secret))
      && !service.secrets.containsSecret(name)))].slice(0, 200);
    return { models, reason: models.length ? null : 'EMPTY' };
  } catch (error) { return { models: [], reason: normalizeProviderError(error, {}, signal).code }; }
}
