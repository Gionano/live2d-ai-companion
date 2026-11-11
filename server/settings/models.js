import { providerFetch } from '../providers/resilience.js';
import { validateBaseUrl, validateProviderHeaders } from '../providers/baseUrl.js';
import { normalizeProviderError, httpProviderError } from '../providers/errors.js';
import { looksLikeLocalPath, looksLikeSecret } from './schema.js';
import { ELEVENLABS_MODELS } from '../elevenLabsTts.js';

export async function listModels(service, { profile: id, apiKey, signal, fetchImpl = fetch }) {
  try {
    const profile = service.config().profiles[id];
    if (!profile || profile.adapter === 'fishAudio') return { models: [], reason: 'UNSUPPORTED' };
    if (profile.adapter === 'localEmbedding') {
      return { models: ['bge-m3-d768'], reason: null };
    }
    const base = validateBaseUrl(profile.baseUrl);
    const credentials = service.resolver().profileSecrets(id, profile);
    const key = apiKey || credentials.apiKey;
    if (profile.adapter === 'elevenLabs' && !key) return { models: [], reason: 'AUTH' };
    const headers = { ...credentials.headers, ...(key && (profile.adapter === 'anthropicNative'
      ? { 'x-api-key': key, 'anthropic-version': profile.anthropicVersion || '2023-06-01' }
      : profile.adapter === 'elevenLabs' ? { 'xi-api-key': key } : { Authorization: 'Bearer ' + key })) };
    validateProviderHeaders(headers);
    const response = await providerFetch(base.url.replace(/\/$/, '') + '/models', { method: 'GET', headers, signal }, { baseUrl: base.url, fetchImpl });
    if (!response.ok) { await response.body?.cancel(); throw httpProviderError(response); }
    if (!response.body?.getReader) return { models: [], reason: 'BAD_RESPONSE' };
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
    const entries = profile.adapter === 'elevenLabs' ? body : body?.data;
    if (!Array.isArray(entries)) return { models: [], reason: 'BAD_RESPONSE' };
    const hidden = [key, ...Object.values(credentials.headers || {})].filter(Boolean);
    const models = [...new Set(entries.slice(0, 1000)
      .filter(item => profile.adapter !== 'elevenLabs' || item?.can_do_text_to_speech === true)
      .map(item => profile.adapter === 'elevenLabs' ? item?.model_id : item?.id).filter(name => typeof name === 'string'
      && (profile.adapter !== 'elevenLabs' || ELEVENLABS_MODELS.includes(name))
      && name.length > 0 && name.length <= 128 && /^[\p{L}\p{N}_.:/@ -]+$/u.test(name)
      && !looksLikeSecret(name) && !looksLikeLocalPath(name) && !hidden.some(secret => name.includes(secret))
      && !service.secrets.containsSecret(name)))].slice(0, 200);
    return { models, reason: models.length ? null : 'EMPTY' };
  } catch (error) { return { models: [], reason: normalizeProviderError(error, {}, signal).code }; }
}
