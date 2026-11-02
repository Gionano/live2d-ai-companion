import { deepMerge, createLocalPaths } from '../selfie/localPaths.js';
import { readProviderLayers, resolveSlot } from '../providers/config.js';
import { validateBaseUrl } from '../providers/baseUrl.js';
import { settingsDoctor } from './doctor.js';
import { SettingsStore } from './store.js';
import { EnvSecretStore, SecretStore, validateSecretValues } from './secretStore.js';
import { bounded, CAPABILITIES, FLAGS, headerName, identifier, invalid, isObject, looksLikeLocalPath,
  looksLikeSecret, MODEL_FIELDS, object, PARAMS, PROFILE_FIELDS, SettingsError, SLOT_NAMES, splitExtras, validateDocument,
  validateProfile, validateSlot } from './schema.js';

const KNOWN_ENV = ['EXPLABS_API_KEY', 'NINEINFERENCE_API_KEY', 'GROQ_API_KEY', 'FISH_API_KEY',
  'ANTHROPIC_API_KEY', 'PROVIDER_API_KEY', 'EXPLABS_BASE_URL', 'EXPLABS_MODEL', 'GROQ_BASE_URL'];
const LEGACY_ENDPOINTS = { EXPLABS_API_KEY: 'EXPLABS_BASE_URL', GROQ_API_KEY: 'GROQ_BASE_URL' };
const LEGACY_MODELS = { EXPLABS_API_KEY: 'EXPLABS_MODEL' };
const originOf = profile => {
  try { return validateBaseUrl(profile?.baseUrl, { websocket: profile?.adapter === 'fishAudio' }).origin; }
  catch { return null; }
};
const present = value => isObject(value) && Object.keys(value).length > 0;
function safePublic(value) {
  if (typeof value === 'string') return looksLikeSecret(value) || looksLikeLocalPath(value) ? undefined : value;
  if (Array.isArray(value)) return value.map(safePublic).filter(item => item !== undefined);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key))
    .map(([key, item]) => [key, safePublic(item)]).filter(([, item]) => item !== undefined));
  return value;
}
function sourcesFor(value, source, prefix = '', result = {}) {
  for (const [key, item] of Object.entries(value || {})) {
    const name = prefix ? prefix + '.' + key : key;
    if (isObject(item) && Object.keys(item).length) sourcesFor(item, source, name, result);
    else result[name] = source;
  }
  return result;
}

const pick = (value, keys) => isObject(value) ? Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) : {};
const secretStrings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(secretStrings) : [];
function redact(value, secrets, containsStored = () => false) {
  const contains = value => typeof value === 'string' && (containsStored(value) || secrets.some(secret => secret && value.includes(secret)));
  if (contains(value)) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => redact(item, secrets, containsStored));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !contains(key)).map(([key, item]) => [key, redact(item, secrets, containsStored)]));
  return value;
}

// Developer files support partial overrides. Validate each supported field rather
// than echoing unrecognized nested data into the future settings UI.
function profileFields(raw) {
  const result = {};
  for (const key of PROFILE_FIELDS.filter(key => !['bodyExtras', 'headerNames'].includes(key))) {
    if (!Object.hasOwn(raw, key)) continue;
    let value = raw[key];
    if (key === 'models') value = Object.fromEntries(Object.entries(isObject(value) ? value : {}).flatMap(([model, override]) => {
      try {
        const candidate = pick(profileFields(pick(override, MODEL_FIELDS)), MODEL_FIELDS);
        if (override.bodyExtras !== undefined) candidate.bodyExtras = splitExtras(override.bodyExtras).publicValues;
        validateProfile({ adapter: 'openaiCompatible', baseUrl: 'https://example.invalid', models: { [model]: candidate } });
        return [[model, candidate]];
      } catch { return []; }
    }));
    if (key === 'flags' || key === 'capabilities') value = Object.fromEntries(Object.entries(pick(value, key === 'flags' ? FLAGS : CAPABILITIES)).filter(([, item]) => typeof item === 'boolean'));
    if (key === 'baseUrl') {
      result.baseUrl = originOf(raw) ? raw.baseUrl : /^REPLACE_WITH_[A-Z_]+$/.test(raw.baseUrl) ? raw.baseUrl : '';
      continue;
    }
    try {
      const checked = validateProfile({ adapter: 'openaiCompatible', baseUrl: key === 'adapter' && value === 'fishAudio'
        ? 'wss://example.invalid' : 'https://example.invalid', [key]: value });
      result[key] = checked.profile[key];
    } catch { /* Ignore unsupported developer fields without returning their contents. */ }
  }
  if (Array.isArray(raw.headerNames)) result.headerNames = raw.headerNames.flatMap(name => { try { return [headerName(name)]; } catch { return []; } });
  return result;
}

function slotFields(raw) {
  const result = {};
  for (const key of ['profile', 'model', 'params', 'timeouts']) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = key === 'params' ? pick(raw.params, PARAMS.filter(name => name !== 'bodyExtras'))
      : key === 'timeouts' ? pick(raw.timeouts, ['firstByteMs', 'idleMs', 'totalMs']) : raw[key];
    try { result[key] = validateSlot({ profile: 'sample', model: 'sample', [key]: value }).slot[key]; }
    catch { /* Invalid choices remain unconfigured. */ }
  }
  return result;
}

function publicLayer(layer = {}) {
  const output = { profiles: {}, slots: {} };
  const secrets = {};
  for (const [id, raw] of Object.entries(layer.profiles || {})) {
    try { identifier(id); } catch { continue; }
    if (raw === null) { output.profiles[id] = null; continue; }
    if (!isObject(raw)) continue;
    const profile = profileFields(raw);
    const headers = {};
    for (const [name, value] of Object.entries(raw.extraHeaders || {})) {
      try { if (typeof value === 'string') headers[headerName(name)] = value; } catch { /* Invalid developer header. */ }
    }
    if (Object.hasOwn(raw, 'extraHeaders')) profile.headerNames = Object.keys(headers);
    let extras = { publicValues: {}, secrets: {} };
    try { extras = splitExtras(raw.bodyExtras, { allowSecrets: true }); } catch { /* Unsupported developer extension. */ }
    if (Object.hasOwn(raw, 'bodyExtras')) profile.bodyExtras = extras.publicValues;
    if (raw.baseUrl !== undefined && !originOf(raw) && !String(raw.baseUrl).startsWith('REPLACE_WITH_')) profile.baseUrl = '';
    output.profiles[id] = safePublic(profile);
    secrets[id] = { origin: originOf(raw), values: { headers, bodyExtras: extras.secrets } };
  }
  for (const name of SLOT_NAMES) {
    if (!Object.hasOwn(layer.slots || {}, name)) continue;
    const raw = layer.slots[name];
    if (raw === null) { output.slots[name] = null; continue; }
    if (!isObject(raw)) continue;
    if (raw.followLlm === true && ['planner', 'visionFilter'].includes(name)) {
      output.slots[name] = { followLlm: true }; continue;
    }
    const slot = slotFields(raw);
    let extras = { publicValues: {}, secrets: {} };
    try { extras = splitExtras(raw.params?.bodyExtras, { allowSecrets: true }); } catch { /* Unsupported developer extension. */ }
    if (raw.params?.bodyExtras !== undefined) { slot.params ??= {}; slot.params.bodyExtras = extras.publicValues; }
    output.slots[name] = slot;
    if (present(extras.secrets) && slot.profile) {
      secrets[raw.profile] ??= { origin: null, values: {} };
      secrets[raw.profile].values.slotBodyExtras ??= {};
      secrets[raw.profile].values.slotBodyExtras[name] = extras.secrets;
    }
  }
  return { config: output, secrets };
}

function exportDocument(config) {
  const data = { schemaVersion: 1, profiles: {}, slots: {}, ui: config.ui || { language: 'id' } };
  for (const [id, profile] of Object.entries(config.profiles || {})) {
    if (!profile || !originOf(profile)) continue;
    try { data.profiles[id] = validateProfile(profile).profile; } catch { /* Unsupported developer extension. */ }
  }
  for (const name of SLOT_NAMES) {
    data.slots[name] = null;
    if (config.slots?.[name]?.followLlm) { data.slots[name] = { followLlm: true }; continue; }
    const slot = resolveSlot(config, name);
    if (slot?.profile && data.profiles[slot.profile]) {
      try { data.slots[name] = validateSlot(slot).slot; } catch { /* Invalid developer choice. */ }
    }
  }
  return bounded(data);
}

export class SettingsService {
  #layers;
  #config;
  #sources;
  #document;
  #devSecrets;
  #env;
  #resolver;
  #registry;
  #broadcast;
  #loadLayers;
  #privateStrings = [];
  #doctorOptions;
  constructor({ repoRoot, localDir, env = process.env, layers, secretStore, platform, runner, allowPlaintext } = {}) {
    const paths = createLocalPaths({ repoRoot, env });
    this.#doctorOptions = { localDir: localDir || paths.localDir, platform, runner,
      allowPlaintext: allowPlaintext ?? env.WAIFU_ALLOW_PLAINTEXT_SECRETS === '1' };
    this.store = new SettingsStore({ localDir: localDir || paths.localDir });
    this.secrets = secretStore || new SecretStore({ localDir: localDir || paths.localDir, platform, runner,
      allowPlaintext: allowPlaintext ?? env.WAIFU_ALLOW_PLAINTEXT_SECRETS === '1' });
    this.#env = env;
    this.#loadLayers = layers ? () => layers : () => readProviderLayers({ repoRoot: paths.repoRoot });
    this.refresh();
  }

  refresh() {
    this.#layers = this.#loadLayers();
    this.#document = this.store.read();
    const defaults = publicLayer(this.#layers.defaults);
    const dev = publicLayer(deepMerge(this.#layers.defaults, this.#layers.dev));
    // The developer file is trusted input, but credential values never enter registry config.
    this.#devSecrets = dev.secrets;
    const { profiles, slots, ui } = this.#document;
    this.#config = deepMerge(dev.config, { profiles, slots, ui });
    for (const [name, slot] of Object.entries(slots)) {
      if (slot?.followLlm) this.#config.slots[name] = { followLlm: true };
      else if (slot?.profile) delete this.#config.slots[name].followLlm;
    }
    const declared = sourcesFor(defaults.config, 'default');
    sourcesFor(publicLayer(this.#layers.dev).config, 'dev-file', '', declared);
    sourcesFor({ profiles, slots, ui }, 'settings', '', declared);
    this.#sources = Object.fromEntries(Object.keys(sourcesFor(this.#config, '')).map(key => [key, declared[key] || 'default']));
    if (this.#document.version === 0) this.#sources['ui.language'] = 'default';
    const stored = this.secrets.snapshot();
    const developer = structuredClone(this.#devSecrets);
    const config = structuredClone(this.#config);
    const environment = new EnvSecretStore({ ...this.#env });
    const values = (id, profile, slot) => {
      const origin = originOf(profile);
      if (!origin) return {};
      const devValues = developer[id]?.origin === origin ? developer[id].values : {};
      let saved = {};
      try { saved = stored(id, origin) || {}; } catch { /* Environment credentials may still work. */ }
      const combined = deepMerge(devValues, saved);
      const allowedHeaders = new Set((profile.headerNames || []).map(name => name.toLowerCase()));
      combined.headers = Object.fromEntries(Object.entries(combined.headers || {}).filter(([name]) => allowedHeaders.has(name.toLowerCase())));
      if (profile.apiKeyEnv && environment.has(profile.apiKeyEnv)) combined.apiKey = environment.get(profile.apiKeyEnv);
      return { apiKey: combined.apiKey, headers: combined.headers, bodyExtras: combined.bodyExtras || {},
        slotBodyExtras: combined.slotBodyExtras?.[slot] || {} };
    };
    this.#resolver = {
      resolve: name => environment.get(name),
      hasKey: (id, profile) => Boolean(values(id, profile).apiKey),
      profileSecrets: (id, profile, slot) => values(id, profile, slot),
    };
    this.#privateStrings = Object.values(developer).flatMap(entry => secretStrings(entry.values));
    for (const [id, profile] of Object.entries(config.profiles || {})) {
      if (profile?.apiKeyEnv && environment.has(profile.apiKeyEnv)) this.#privateStrings.push(environment.get(profile.apiKeyEnv));
      this.#privateStrings.push(...secretStrings(values(id, profile)), ...SLOT_NAMES.flatMap(slot => secretStrings(values(id, profile, slot))));
      try { this.#privateStrings.push(...secretStrings(stored(id, originOf(profile)))); } catch { /* Failed closed. */ }
      const prefix = 'profiles.' + id + '.secrets';
      if (developer[id]?.origin === originOf(profile)) sourcesFor(developer[id].values, 'dev-file', prefix, this.#sources);
      try { sourcesFor(stored(id, originOf(profile)), 'settings', prefix, this.#sources); } catch { /* Failed closed. */ }
      if (profile?.apiKeyEnv && environment.has(profile.apiKeyEnv)) this.#sources[prefix + '.apiKey'] = 'env';
    }
    this.#config = this.#redact(this.#config);
  }

  #redact(value, extra = []) { return redact(value, [...this.#privateStrings, ...extra], text => this.secrets.containsSecret(text)); }
  config() { return structuredClone(this.#config); }
  diagnostics({ includePaths = false } = {}) { return settingsDoctor({ ...this.#doctorOptions, version: this.#document.version, includePaths }); }
  resolver() { return this.#resolver; }
  attach(registry, broadcast) { this.#registry = registry; if (broadcast) this.#broadcast = broadcast; }
  setBroadcaster(broadcast) { this.#broadcast = broadcast; }
  #changed() {
    this.refresh();
    if (this.#registry) {
      this.#registry.secretResolver = this.#resolver;
      this.#registry.reload(this.config());
    }
    // A disconnected client must not turn an already durable update into a failure.
    try { this.#broadcast?.({ type: 'settings_changed', slots: [...SLOT_NAMES] }); } catch { /* Best-effort notification. */ }
  }
  effective() {
    const secrets = {};
    for (const [id, profile] of Object.entries(this.#config.profiles || {})) {
      if (!profile) continue;
      const values = this.#resolver.profileSecrets(id, profile);
      secrets[id] = { apiKey: { has: Boolean(values.apiKey),
        ...(values.apiKey?.length >= 20 && { last4: values.apiKey.slice(-4) }) },
      headers: Object.fromEntries((profile.headerNames || []).map(name => [name, { has: Boolean(values.headers?.[name]) }])),
      bodyExtras: { has: present(values.bodyExtras) },
      slotBodyExtras: Object.fromEntries(SLOT_NAMES.map(slot => [slot, { has: present(this.#resolver.profileSecrets(id, profile, slot).slotBodyExtras) }])) };
    }
    return this.#redact({ version: this.#document.version, settings: this.config(), sources: { ...this.#sources }, secrets });
  }
  status() {
    const slots = Object.fromEntries(SLOT_NAMES.map(slot => [slot, this.#registry?.getSlotStatus(slot) || { available: false } ]));
    return this.#redact({ version: this.#document.version, backendName: this.secrets.backendName,
      firstRun: !SLOT_NAMES.some(name => this.#config.slots?.[name]?.profile), slots,
      warningCodes: [...(this.secrets.error ? ['SECRET_STORAGE'] : []),
        ...(this.store.recovered ? ['SETTINGS_RECOVERED'] : [])],
      warnings: [...(this.secrets.warning ? [this.secrets.warning] : []),
        ...(this.secrets.error ? ['Secret storage is unavailable.'] : []),
        ...(this.store.recovered ? ['Corrupt settings were backed up and reset.'] : []),
        ...SLOT_NAMES.filter(name => !slots[name].available).map(name => 'Slot ' + name + ' is unavailable.'),
        ...Object.values(slots).flatMap(slot => slot.warnings || [])] });
  }

  #update(version, change) {
    let rollback;
    let result;
    try {
      result = this.store.update(version, current => {
        rollback = this.secrets.checkpoint();
        return change(current);
      });
    } catch (error) {
      rollback?.();
      throw error;
    }
    this.#changed();
    return { version: result.version };
  }
  #hasCredentials(id, profile) {
    return this.secrets.has(id) || present(this.#resolver.profileSecrets(id, profile).headers)
      || Boolean(this.#resolver.profileSecrets(id, profile).apiKey)
      || present(this.#resolver.profileSecrets(id, profile).bodyExtras)
      || SLOT_NAMES.some(slot => present(this.#resolver.profileSecrets(id, profile, slot).slotBodyExtras));
  }
  #validatePublic(document, extra = {}) {
    validateDocument(document, { persisted: true });
    if (JSON.stringify(this.#redact(document, secretStrings(extra))) !== JSON.stringify(document)) invalid();
  }
  putProfile(id, request) {
    identifier(id);
    object(request, ['version', 'profile', 'secrets', 'confirmDeleteSecrets']);
    if (request.confirmDeleteSecrets !== undefined && typeof request.confirmDeleteSecrets !== 'boolean') invalid();
    const checked = validateProfile(request.profile, { allowSecrets: true });
    if (checked.profile.id !== undefined && checked.profile.id !== id) invalid();
    const supplied = validateSecretValues(deepMerge(request.secrets || {}, present(checked.secrets) ? { bodyExtras: checked.secrets } : {}));
    if (request.secrets !== undefined && !secretStrings(supplied).some(Boolean)) invalid();
    return this.#update(request.version, current => {
      this.refresh();
      const previous = this.#config.profiles[id];
      const profile = deepMerge(previous || {}, checked.profile);
      const origin = originOf(profile);
      const oldOrigin = originOf(previous);
      const hasOld = this.#hasCredentials(id, previous);
      const changedOrigin = oldOrigin !== origin || (this.secrets.has(id) && !this.secrets.has(id, origin));
      if (changedOrigin && hasOld) {
        if (!present(supplied) && request.confirmDeleteSecrets !== true) throw new SettingsError('ORIGIN_CHANGE', 409);
        // An origin change detaches read-only developer/environment credentials too.
        profile.apiKeyEnv = null;
        profile.headerNames = Object.keys(supplied.headers || {});
      }
      if (supplied.headers) profile.headerNames = [...new Set([...(profile.headerNames || []), ...Object.keys(supplied.headers)])];
      current.profiles[id] = profile;
      this.#validatePublic(current, supplied);
      if (changedOrigin && !present(supplied) && this.secrets.has(id)) this.secrets.delete(id);
      if (present(supplied)) this.secrets.set(id, origin, !changedOrigin
        ? deepMerge(this.secrets.get(id, origin) || {}, supplied) : supplied);
      return current;
    });
  }
  putSlot(name, request) {
    if (!SLOT_NAMES.includes(name)) invalid();
    object(request, ['version', 'slot']);
    const checked = validateSlot(request.slot, { allowSecrets: true });
    return this.#update(request.version, current => {
      this.refresh();
      const profile = checked.slot && this.#config.profiles[checked.slot.profile];
      if (checked.slot && !checked.slot.followLlm && !profile) throw new SettingsError('NOT_FOUND', 404);
      current.slots[name] = checked.slot;
      this.#validatePublic(current, checked.secrets);
      if (present(checked.secrets)) {
        const origin = originOf(profile);
        this.secrets.set(checked.slot.profile, origin, deepMerge(this.secrets.get(checked.slot.profile, origin) || {},
          { slotBodyExtras: { [name]: checked.secrets } }));
      }
      return current;
    });
  }
  deleteProfile(id, request) {
    identifier(id);
    object(request, ['version', 'force']);
    if (request.force !== undefined && typeof request.force !== 'boolean') invalid();
    return this.#update(request.version, current => {
      this.refresh();
      if (!this.#config.profiles[id]) throw new SettingsError('NOT_FOUND', 404);
      const used = SLOT_NAMES.filter(name => resolveSlot(this.#config, name)?.profile === id);
      if (used.length && request.force !== true) throw new SettingsError('IN_USE', 409);
      current.profiles[id] = null;
      used.forEach(name => { current.slots[name] = null; });
      if (this.secrets.has(id)) this.secrets.delete(id);
      return current;
    });
  }
  putSecret(id, request) {
    identifier(id);
    object(request, ['version', 'values']);
    const values = validateSecretValues(request.values);
    if (!secretStrings(values).some(Boolean)) invalid();
    return this.#update(request.version, current => {
      this.refresh();
      const profile = this.#config.profiles[id];
      if (!profile || !originOf(profile)) throw new SettingsError('NOT_FOUND', 404);
      if (values.headers) current.profiles[id] = deepMerge(profile, { headerNames:
        [...new Set([...(profile.headerNames || []), ...Object.keys(values.headers)])] });
      this.#validatePublic(current, values);
      this.secrets.set(id, originOf(profile), deepMerge(this.secrets.get(id, originOf(profile)) || {}, values));
      return current;
    });
  }
  deleteSecret(id, request) {
    identifier(id);
    object(request, ['version']);
    return this.#update(request.version, current => {
      if (this.secrets.has(id)) this.secrets.delete(id);
      return current;
    });
  }
  putUi(request) {
    object(request, ['version', 'ui']);
    object(request.ui, ['language']);
    if (!['id', 'en'].includes(request.ui.language)) invalid();
    return this.#update(request.version, current => { current.ui = structuredClone(request.ui); return current; });
  }
  export() {
    return exportDocument(this.#redact(this.#config));
  }
  import(request) {
    object(request, ['version', 'settings']);
    const input = validateDocument(request.settings);
    return this.#update(request.version, current => {
      this.refresh();
      const next = { ...input, profiles: { ...input.profiles }, version: current.version };
      // Import replaces the settings selection. Tombstones keep omitted lower
      // layers from silently restoring old profiles or credentials.
      for (const id of Object.keys(this.#config.profiles)) next.profiles[id] ??= null;
      for (const [id, profile] of Object.entries(next.profiles)) {
        const old = this.#config.profiles[id];
        if ((originOf(old) !== originOf(profile) && this.#hasCredentials(id, old))
          || (this.secrets.has(id) && !this.secrets.has(id, originOf(profile)))) {
          throw new SettingsError('ORIGIN_CHANGE', 409);
        }
      }
      for (const name of SLOT_NAMES) next.slots[name] ??= null;
      const effective = deepMerge(publicLayer(deepMerge(this.#layers.defaults, this.#layers.dev)).config, next);
      for (const slot of Object.values(next.slots)) if (slot && !slot.followLlm && !effective.profiles[slot.profile]) invalid();
      this.#validatePublic(next);
      return next;
    });
  }
  legacy() {
    const dev = this.#layers.dev || {};
    const mappings = [...Object.values(this.#layers.defaults?.profiles || {}), ...Object.values(dev.profiles || {})]
      .flatMap(profile => [profile?.apiKeyEnv, profile?.baseUrlEnv]);
    mappings.push(...Object.values(this.#layers.defaults?.slots || {}).map(slot => slot?.modelEnv), ...Object.values(dev.slots || {}).map(slot => slot?.modelEnv));
    const names = [...new Set([...KNOWN_ENV, ...mappings.filter(name => typeof name === 'string' && /^[A-Z_][A-Z0-9_]{0,79}$/.test(name))])];
    return this.#redact({ env: names.filter(name => Boolean(this.#env[name])),
      profiles: Object.keys(dev.profiles || {}).filter(id => { try { identifier(id); return true; } catch { return false; } }),
      slots: SLOT_NAMES.filter(name => Object.hasOwn(dev.slots || {}, name)) });
  }
  importLegacy(request) {
    object(request, ['version']);
    this.refresh();
    const legacy = deepMerge(this.#layers.defaults, this.#layers.dev);
    const selections = { profiles: {}, slots: {} };
    for (const [id, profile] of Object.entries(legacy.profiles || {})) {
      const variable = profile?.baseUrlEnv || LEGACY_ENDPOINTS[profile?.apiKeyEnv];
      if (variable && this.#env[variable]) selections.profiles[id] = {
        baseUrl: this.#env[variable].replace(/\/$/, '') + (profile.baseUrlEnvSuffix || '') };
    }
    for (const name of SLOT_NAMES) {
      const slot = legacy.slots?.[name];
      const variable = slot?.modelEnv || LEGACY_MODELS[legacy.profiles?.[slot?.profile]?.apiKeyEnv];
      if (slot && variable && this.#env[variable]) selections.slots[name] = { model: this.#env[variable] };
    }
    // Existing settings and explicit developer choices win over legacy env hints.
    const projected = publicLayer(deepMerge(this.#layers.defaults, selections, this.#layers.dev)).config;
    const data = exportDocument(this.#redact(deepMerge(projected, this.#document)));
    return this.import({ version: request.version, settings: data });
  }
}

let defaultService;
export function getSettingsService() { return defaultService ??= new SettingsService(); }
