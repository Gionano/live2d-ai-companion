import { loadProvidersConfig, resolveSlot, effectiveProfile, slotProblem } from './config.js';
import { OpenAiCompatible } from './adapters/openaiCompatible.js';
import { AnthropicNative } from './adapters/anthropicNative.js';
import { FishAudio } from './adapters/fishAudio.js';
import { ElevenLabs } from './adapters/elevenLabs.js';
import { LocalEmbedding } from './adapters/localEmbedding.js';
import { validateBaseUrl } from './baseUrl.js';
import { getSettingsService } from '../settings/service.js';

export const ADAPTERS = { openaiCompatible: OpenAiCompatible, anthropicNative: AnthropicNative, fishAudio: FishAudio, elevenLabs: ElevenLabs, localEmbedding: LocalEmbedding };
export const envSecretResolver = { resolve: name => process.env[name] };

export class ProviderRegistry {
  constructor({ config, loadConfig = loadProvidersConfig, secretResolver = envSecretResolver, adapterOptions = {} } = {}) {
    Object.assign(this, { loadConfig, secretResolver, adapterOptions });
    this.instances = new Map();
    this.reload(config);
  }

  reload(config) {
    this.instances.clear();
    this.configError = null;
    try { this.config = config ?? this.loadConfig(); }
    catch { this.config = {}; this.configError = 'Provider configuration must be readable JSON. Check providers.config.local.json.'; }
  }

  getSlotStatus(slot) {
    const settings = resolveSlot(this.config, slot);
    const profile = effectiveProfile(this.config, settings);
    const reason = this.configError ?? slotProblem(this.config, slot, this.secretResolver);
    let insecureTransport = false;
    try { insecureTransport = validateBaseUrl(profile?.baseUrl, { websocket: profile?.adapter === 'fishAudio' }).insecureTransport; }
    catch { /* Invalid endpoints are explained by slotProblem. */ }
    return { available: !reason, reason, profile: settings?.profile ?? null,
      model: settings?.model ?? null, adapter: profile?.adapter ?? null, insecureTransport,
      warnings: insecureTransport ? ['HTTP/WS is unencrypted; use only a trusted loopback or private-LAN service.'] : [] };
  }

  get(slot) {
    if (!this.getSlotStatus(slot).available) return null;
    if (!this.instances.has(slot)) {
      const settings = resolveSlot(this.config, slot);
      const profile = effectiveProfile(this.config, settings);
      this.instances.set(slot, new ADAPTERS[profile.adapter]({ ...this.adapterOptions, profile,
        model: settings.model, params: settings.params, timeouts: settings.timeouts,
        providerId: settings.profile, slot, secretResolver: this.secretResolver }));
    }
    return this.instances.get(slot);
  }

  getLlm(role = 'llm') { return ['llm', 'surface', 'reflection', 'router', 'vision', 'planner', 'visionFilter', 'memoryWriter'].includes(role) ? this.get(role) : null; }
  getEmbedding() { return this.get('memoryEmbedding'); }
  getStt() { return this.get('stt'); }
  getTts() { return this.get('tts'); }

  withSlotOverride(slot, { profile, model, voice } = {}) {
    const settings = resolveSlot(this.config, slot) ?? {};
    const params = profile && profile !== settings.profile
      ? { ...settings.params, bodyExtras: null, omitParams: null } : settings.params;
    const sourceAdapter = effectiveProfile(this.config, settings)?.adapter;
    const targetAdapter = this.config.profiles?.[profile]?.adapter;
    const voiceParams = slot === 'tts' && (voice !== undefined || profile && targetAdapter !== sourceAdapter)
      ? { ...params } : params;
    if (slot === 'tts' && profile && targetAdapter !== sourceAdapter) delete voiceParams.voice;
    if (slot === 'tts' && voice !== undefined) voiceParams.voice = voice;
    const config = structuredClone(this.config);
    config.slots ||= {};
    config.slots[slot] = {
      ...settings, params: voiceParams, ...(profile && { profile }), ...(model && { model }),
    };
    return new ProviderRegistry({ config, secretResolver: this.secretResolver, adapterOptions: this.adapterOptions });
  }
}

let defaultRegistry;
export function getProviderRegistry() {
  if (!defaultRegistry) {
    const settings = getSettingsService();
    defaultRegistry = new ProviderRegistry({ loadConfig: () => settings.config(), secretResolver: settings.resolver() });
    settings.attach(defaultRegistry);
  }
  return defaultRegistry;
}
export const getSlotStatus = slot => getProviderRegistry().getSlotStatus(slot);
export const getLlm = role => getProviderRegistry().getLlm(role);
export const getStt = () => getProviderRegistry().getStt();
export const getTts = () => getProviderRegistry().getTts();
export const getEmbedding = () => getProviderRegistry().getEmbedding();
export const reload = () => {
  const registry = getProviderRegistry();
  const settings = getSettingsService();
  settings.refresh();
  registry.secretResolver = settings.resolver();
  registry.reload(settings.config());
};

export const UNAVAILABLE_MESSAGES = {
  llm: 'Maaf sayang, aku belum bisa mengobrol sekarang. Atur penyedia obrolan dulu ya.',
  vision: 'Maaf sayang, aku belum bisa melihat kamera atau layarmu sekarang. Atur penyedia penglihatan dulu ya.',
  stt: 'Maaf sayang, aku belum bisa mendengar suaramu. Atur penyedia pengenal suara dulu, atau ketik ya.',
  tts: 'Sayang, suaraku belum tersedia. Atur penyedia suara dulu ya. Aku jawab lewat teks dulu.',
};
