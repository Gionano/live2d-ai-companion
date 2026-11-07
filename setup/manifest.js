import fs from 'node:fs';
import path from 'node:path';

export const COMPONENT_IDS = ['comfyui-portable', 'comfyui-gguf-node', 'sd-cli', 'cudart'];
const STRING_FIELDS = ['name', 'url', 'sha256', 'licenseName', 'licenseUrl', 'kind', 'destination'];
const COMPONENT_FIELDS = new Set([...STRING_FIELDS, 'version', 'commit', 'sizeBytes', 'required', 'id', 'engines', 'role', 'when', 'variant']);
export const ENGINE_NAMES = ['comfyui', 'sdcpp'];
export const ROLES = ['diffusion', 'vae', 'text_encoder', 'vision_projector', 'node', 'runtime', 'runtime_library'];
export const V1_MIGRATION_WARNING = 'MIGRATION: manifest schemaVersion 1 is supported for compatibility; migrate to schemaVersion 2 for explicit engines, roles, conditions, and separate CUDA/Vulkan variants.';

export function readManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

export function listComponents(manifest) {
  const components = manifest?.components || {};
  const result = [];
  for (const id of [...COMPONENT_IDS, 'constraints', '7zip-extractor']) {
    if (!components[id]) continue;
    const entries = Array.isArray(components[id]) ? components[id] : [components[id]];
    for (const component of entries) result.push({ ...component, id: Array.isArray(components[id]) ? `${id}:${component?.variant}` : id });
  }
  for (const [index, component] of (Array.isArray(components.models) ? components.models : []).entries()) result.push({ ...component, id: `models[${index}]` });
  if (manifest?.schemaVersion !== 1) return result;
  return result.map((component) => {
    const comfy = component.id.startsWith('comfyui') || component.id === 'constraints';
    const model = component.id.startsWith('models[');
    const role = component.id === 'comfyui-gguf-node' ? 'node'
      : ['cudart', 'constraints'].includes(component.id) ? 'runtime_library'
        : !model ? 'runtime' : /diffusion|unet/i.test(component.kind) ? 'diffusion'
          : /vae/i.test(component.kind) ? 'vae' : /mmproj|projector/i.test(component.destination) ? 'vision_projector' : 'text_encoder';
    return { ...component, engines: component.engines || (model ? ENGINE_NAMES : [comfy ? 'comfyui' : 'sdcpp']),
      role: component.role || role, when: component.when || { gpuVendor: 'any', os: 'any' } };
  });
}

export function isPlaceholder(value) {
  return typeof value === 'string' && /\b(TODO|TBD|PLACEHOLDER)\b|<[^>]+>/i.test(value);
}

export function validateComponent(component, label = component?.id || 'component', { schemaVersion = 1, metadata = true } = {}) {
  const errors = [];
  if (!component || typeof component !== 'object' || Array.isArray(component)) {
    return [`${label}: must be an object`];
  }
  for (const field of Object.keys(component)) {
    if (!COMPONENT_FIELDS.has(field)) errors.push(`${label}.${field}: unknown component field`);
  }
  for (const field of STRING_FIELDS) {
    if (!metadata && !['kind', 'destination'].includes(field)) continue;
    if (typeof component[field] !== 'string' || !component[field].trim()) {
      errors.push(`${label}.${field}: a non-empty string is required`);
    } else if (metadata && isPlaceholder(component[field])) {
      errors.push(`${label}.${field}: TODO placeholder must be replaced with verified metadata`);
    }
  }
  const pinFields = metadata ? ['version', 'commit'].filter((field) => Object.hasOwn(component, field)) : [];
  if (metadata && !pinFields.length) errors.push(`${label}.version/commit: a pinned version or commit is required`);
  for (const field of pinFields) {
    const pin = component[field];
    if (typeof pin !== 'string' || !pin.trim()) errors.push(`${label}.${field}: a non-empty pinned string is required`);
    else if (isPlaceholder(pin)) errors.push(`${label}.${field}: TODO placeholder must be replaced with a verified pin`);
    else if (/^(latest|main|master|head)$/i.test(pin.trim())) errors.push(`${label}.${field}: moving branch/latest references are not pinned`);
    else if (field === 'commit' && !/^[a-f0-9]{40}$/i.test(pin)) errors.push(`${label}.commit: use a full 40-character commit SHA`);
  }
  for (const field of ['url', 'licenseUrl']) {
    if (!metadata) continue;
    if (typeof component[field] === 'string' && !isPlaceholder(component[field])) {
      try {
        const url = new URL(component[field]);
        if (!/^https?:\/\//i.test(component[field]) || !url.hostname || !['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch { errors.push(`${label}.${field}: an HTTP(S) URL is required`); }
    }
  }
  if (metadata && typeof component.sha256 === 'string' && !isPlaceholder(component.sha256) && !/^[a-f0-9]{64}$/i.test(component.sha256)) {
    errors.push(`${label}.sha256: a verified 64-character SHA-256 is required`);
  }
  if (metadata && (!Number.isSafeInteger(component.sizeBytes) || component.sizeBytes <= 0)) {
    errors.push(`${label}.sizeBytes: TODO/missing size; provide the verified positive byte count`);
  }
  if (typeof component.required !== 'boolean') errors.push(`${label}.required: a boolean is required`);
  if (schemaVersion === 2) {
    if (!Array.isArray(component.engines) || !component.engines.length || component.engines.some((engine) => !ENGINE_NAMES.includes(engine)) || new Set(component.engines).size !== component.engines.length) {
      errors.push(`${label}.engines: a non-empty unique array of comfyui|sdcpp is required`);
    }
    if (!ROLES.includes(component.role)) errors.push(`${label}.role: must be one of ${ROLES.join('|')}`);
    if (!component.when || typeof component.when !== 'object' || Array.isArray(component.when) ||
      !['nvidia', 'any'].includes(component.when.gpuVendor) || component.when.os !== 'win32' ||
      Object.keys(component.when).some((key) => !['gpuVendor', 'os'].includes(key))) {
      errors.push(`${label}.when: requires {gpuVendor: nvidia|any, os: win32}`);
    }
    if (component.variant !== undefined && !['cuda12', 'vulkan'].includes(component.variant)) errors.push(`${label}.variant: must be cuda12|vulkan`);
  }
  const destination = component.destination;
  if (typeof destination === 'string' && !isPlaceholder(destination) && (
    path.isAbsolute(destination) || /^[a-z]:/i.test(destination) || destination.includes('\0') ||
    destination.split(/[\\/]/).some((part) => part === '..') || destination.includes(':')
  )) errors.push(`${label}.destination: must stay relative to local/ without traversal`);
  return errors;
}

export function sameOrNestedDestination(first, second) {
  const normalize = (value) => path.posix.normalize(value.replace(/\\/g, '/')).replace(/\/$/, '').toLowerCase();
  const a = normalize(first);
  const b = normalize(second);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function validateManifest(manifest, { selectedIds } = {}) {
  const errors = [];
  const warnings = manifest?.schemaVersion === 1 ? [V1_MIGRATION_WARNING] : [];
  if (manifest && typeof manifest === 'object') {
    for (const field of Object.keys(manifest)) {
      if (!['$schema', 'schemaVersion', 'components'].includes(field)) errors.push(`${field}: unknown manifest field`);
    }
  }
  if (![1, 2].includes(manifest?.schemaVersion)) errors.push('schemaVersion: must be 1 or 2');
  if (!manifest?.components || typeof manifest.components !== 'object' || Array.isArray(manifest.components)) {
    errors.push('components: an object is required');
  } else {
    for (const id of Object.keys(manifest.components)) {
      if (![...COMPONENT_IDS, 'models', 'constraints', '7zip-extractor'].includes(id)) errors.push(`components.${id}: unknown component group`);
    }
    for (const id of COMPONENT_IDS) {
      if (!manifest.components[id]) errors.push(`components.${id}: required component definition is missing`);
    }
    if (!Array.isArray(manifest.components.models)) errors.push('components.models: an array is required');
    const components = listComponents(manifest);
    if (manifest.schemaVersion === 2 && (!Array.isArray(manifest.components['sd-cli']) || !manifest.components['sd-cli'].length)) errors.push('components.sd-cli: schemaVersion 2 requires a non-empty variants array');
    if (manifest.schemaVersion === 1 && Array.isArray(manifest.components['sd-cli'])) errors.push('components.sd-cli: schemaVersion 1 requires a single component; migrate to version 2 for variants');
    for (const component of components) errors.push(...validateComponent(component, `components.${component.id}`, {
      schemaVersion: manifest.schemaVersion, metadata: !selectedIds || selectedIds.includes(component.id),
    }));
    if (manifest.schemaVersion === 2) {
      for (const [id, role, engine] of [['comfyui-portable', 'runtime', 'comfyui'], ['comfyui-gguf-node', 'node', 'comfyui'], ['cudart', 'runtime_library', 'sdcpp'], ['constraints', 'runtime_library', 'comfyui']]) {
        const component = manifest.components[id];
        if (component && (component.role !== role || !component.engines?.includes(engine))) errors.push(`components.${id}: requires role ${role} and engine ${engine}`);
      }
      for (const component of components.filter((entry) => entry.id.startsWith('models['))) {
        if (!['diffusion', 'vae', 'text_encoder', 'vision_projector'].includes(component.role)) errors.push(`components.${component.id}.role: models require a model role`);
      }
      const variants = components.filter((component) => component.id.startsWith('sd-cli:'));
      const seen = new Set();
      for (const component of variants) {
        if (!component.variant) errors.push(`components.${component.id}.variant: a variant is required`);
        if (seen.has(component.variant)) errors.push(`components.sd-cli: duplicate variant ${component.variant}`);
        seen.add(component.variant);
        if (component.role !== 'runtime' || !component.engines?.includes('sdcpp')) errors.push(`components.${component.id}: sd-cli variants require role runtime and engine sdcpp`);
        if (component.variant === 'cuda12' && component.when?.gpuVendor !== 'nvidia') errors.push(`components.${component.id}.when: CUDA12 requires the NVIDIA GPU condition`);
      }
      const variantEntries = components.filter((component) => component.variant);
      for (const [index, first] of variantEntries.entries()) {
        for (const second of variantEntries.slice(index + 1)) {
          if (first.variant !== second.variant && typeof first.destination === 'string' && typeof second.destination === 'string' && sameOrNestedDestination(first.destination, second.destination)) errors.push(`components.sd-cli: cross-variant destination collision between ${first.variant} and ${second.variant}; --force cannot mix variants`);
        }
      }
      const cuda = variants.find((component) => component.variant === 'cuda12');
      const cudart = manifest.components.cudart;
      if (cuda && (!cudart || cudart.variant !== 'cuda12' || cudart.required !== true || cudart.role !== 'runtime_library' ||
        typeof cudart.destination !== 'string' || typeof cuda.destination !== 'string' ||
        path.posix.normalize(cudart.destination.replace(/\\/g, '/')).toLowerCase() !== path.posix.normalize(cuda.destination.replace(/\\/g, '/')).toLowerCase() ||
        cudart.when?.gpuVendor !== 'nvidia' || cudart.when?.os !== cuda.when?.os || !cudart.engines?.includes('sdcpp'))) {
        errors.push('components.cudart: CUDA12 requires a required matching cuda12 runtime_library in the CUDA12 destination with the same OS/NVIDIA condition');
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function selectComponents(manifest, { command = 'plan', engine, variant, gpuVendor = 'any', os = process.platform } = {}) {
  if (!['plan', 'models', 'sdcli', 'comfyui'].includes(command)) throw new Error(`Unknown setup command: ${command}`);
  if (engine && !ENGINE_NAMES.includes(engine)) throw new Error(`Unknown engine: ${engine}; use comfyui|sdcpp`);
  if (variant && !['cuda12', 'vulkan'].includes(variant)) throw new Error(`Unknown variant: ${variant}; use cuda12|vulkan`);
  const engines = engine ? [engine] : command === 'sdcli' ? ['sdcpp'] : command === 'comfyui' ? ['comfyui'] : ENGINE_NAMES;
  const components = listComponents(manifest);
  const variants = components.filter((component) => component.id.startsWith('sd-cli:') && component.when?.os === os);
  const chosenVariant = variant || (gpuVendor === 'nvidia' && variants.some((component) => component.variant === 'cuda12') ? 'cuda12' : 'vulkan');
  return components.filter((component) => {
    if (!component.engines?.some((name) => engines.includes(name))) return false;
    if (manifest.schemaVersion === 2 && component.when?.os !== os) return false;
    if (component.variant && component.variant !== chosenVariant) return false;
    if (manifest.schemaVersion === 2 && !(variant && component.variant) && component.when?.gpuVendor === 'nvidia' && gpuVendor !== 'nvidia') return false;
    if (command === 'models') return component.id.startsWith('models[');
    if (command === 'sdcli') return component.id === 'sd-cli' || component.id.startsWith('sd-cli:') || component.id === 'cudart';
    if (command === 'comfyui') return component.id.startsWith('comfyui') || component.id === 'constraints' || component.id === '7zip-extractor';
    return true;
  });
}

export function validatePlanRoles(components, { engines = ENGINE_NAMES, includeRuntime = true } = {}) {
  const errors = [];
  for (const engine of engines) {
    const models = components.filter((component) => component.id.startsWith('models[') && component.engines?.includes(engine));
    const required = ['diffusion', 'vae', 'text_encoder'];
    if (engine === 'sdcpp' && models.some((component) => component.role === 'text_encoder' &&
      ([component.destination, component.url].some((value) => /\.gguf(?:$|[?#])/i.test(value || '')) || /gguf/i.test(component.kind)))) required.push('vision_projector');
    for (const role of required) {
      if (!models.some((component) => component.role === role && component.required)) errors.push(`${engine}: missing required model role ${role}`);
    }
    if (includeRuntime) {
      for (const role of engine === 'comfyui' ? ['runtime', 'node'] : ['runtime']) {
        if (!components.some((component) => component.engines?.includes(engine) && component.role === role && component.required)) errors.push(`${engine}: missing required component role ${role}`);
      }
      if (engine === 'sdcpp' && components.some((component) => component.engines?.includes(engine) && component.role === 'runtime' && component.variant === 'cuda12') &&
        !components.some((component) => component.engines?.includes(engine) && component.role === 'runtime_library' && component.variant === 'cuda12' && component.required)) {
        errors.push(`${engine}/cuda12: missing required component role runtime_library (matching cudart)`);
      }
    }
  }
  return { valid: !errors.length, errors };
}
