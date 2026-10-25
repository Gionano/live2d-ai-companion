import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSelfieConfig } from './config.js';
import { createImageProvider } from './imageProvider.js';
import { etaStore } from './etaStore.js';
import { appendSelfieRun, compareImages } from './selfieExperiments.js';

const VALUE_OPTIONS = new Set([
  'provider', 'preset', 'profile', 'steps', 'cfg', 'size', 'strength', 'init-image', 'seed',
  'arg', 'drop-arg', 'model-arg', 'label', 'reference',
]);
const FLAG_PATTERN = /^--?[A-Za-z][A-Za-z0-9_-]*$/;

export function parseSelfieTestArgs(argv = [], env = {}) {
  const options = { args: [], droppedArgs: [], modelArgs: [] };
  for (const name of ['provider', 'preset', 'profile']) {
    if (env['npm_config_' + name]) options[name] = env['npm_config_' + name];
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === '--compare') {
      if (argv.length !== 3 || index !== 0 || argv.slice(1).some(value => !value || String(value).startsWith('--'))) {
        throw new Error('--compare requires exactly two image paths and no generation options.');
      }
      return { ...options, compare: argv.slice(1).map(String) };
    }
    const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(token);
    if (!match || !VALUE_OPTIONS.has(match[1])) throw new Error('Unknown selfie:test option: ' + token);
    const name = match[1];
    let value = match[2];
    if (value === undefined) {
      value = argv[++index];
      if (value === undefined || (name !== 'arg' && name !== 'drop-arg' && String(value).startsWith('--'))) {
        throw new Error('--' + name + ' requires a value.');
      }
    }
    value = String(value);
    if (!value.trim() || value.includes('\0') || /[\r\n]/.test(value)) {
      throw new Error('--' + name + ' requires a nonempty value without null bytes or newlines.');
    }
    if (name === 'arg') {
      if (!FLAG_PATTERN.test(value.split('=')[0])) throw new Error('--arg requires FLAG[=VALUE].');
      options.args.push(value);
    } else if (name === 'drop-arg') {
      if (!FLAG_PATTERN.test(value)) throw new Error('--drop-arg requires a flag without a value.');
      options.droppedArgs.push(value);
    } else if (name === 'model-arg') {
      if (!/^[A-Za-z0-9_.-]+=[\s\S]+$/.test(value)) throw new Error('--model-arg requires key=value.');
      options.modelArgs.push(value);
    } else if (name === 'size') {
      const size = /^(\d+)[xX](\d+)$/.exec(value);
      if (!size || size.slice(1).some(part => !Number.isSafeInteger(Number(part)) || Number(part) <= 0 || Number(part) % 32 !== 0)) {
        throw new Error('--size requires WxH with positive multiples of 32.');
      }
      options.width = Number(size[1]);
      options.height = Number(size[2]);
    } else if (['steps', 'cfg', 'strength', 'seed'].includes(name)) {
      const number = Number(value);
      const valid = name === 'steps' ? /^\d+$/.test(value) && Number.isSafeInteger(number) && number > 0
        : name === 'seed' ? /^-?\d+$/.test(value) && Number.isSafeInteger(number) && number >= -1
          : Number.isFinite(number) && (name === 'cfg' ? number > 0 : number >= 0 && number <= 1);
      if (!valid) throw new Error('--' + name + ' is invalid.');
      options[name] = number;
    } else {
      options[name === 'init-image' ? 'initImage' : name] = value;
    }
  }
  if (options.provider && !['auto', 'comfyui', 'comfyui-managed', 'sdcpp'].includes(options.provider)) {
    throw new Error('--provider must be auto, comfyui, comfyui-managed, or sdcpp.');
  }
  return options;
}

function dropArguments(args, dropped) {
  const result = [];
  for (let index = 0; index < args.length;) {
    const token = args[index++];
    const values = [];
    while (index < args.length && !/^--?[A-Za-z]/.test(args[index])) values.push(args[index++]);
    if (!dropped.has(token.split('=')[0])) result.push(token, ...values);
  }
  return result;
}

export function applySelfieTestOverrides(baseConfig, options) {
  const config = structuredClone(baseConfig);
  if (options.provider) config.provider = options.provider;
  if (options.preset) config.preset = options.preset;
  if (options.profile !== undefined) {
    if (!Object.hasOwn(config.comfyuiManaged?.profiles || {}, options.profile)) {
      throw new Error('Unknown ComfyUI managed profile: ' + options.profile);
    }
    config.comfyuiManaged.profile = options.profile;
  }
  const preset = config.presets?.[config.preset];
  if (!preset) throw new Error('Unknown selfie preset: ' + config.preset);
  for (const [key, value] of [['steps', options.steps], ['cfg', options.cfg], ['resolution', options.width]]) {
    if (value === undefined) continue;
    preset[key] = value;
    for (const override of Object.values(preset.providers || {})) override[key] = value;
  }
  config.sdcpp ||= {};
  const dropped = new Set(options.droppedArgs || []);
  config.sdcpp.args = dropArguments(config.sdcpp.args || [], dropped);
  if (dropped.has('--offload-to-cpu')) config.sdcpp.offloadToCpu = false;
  if (preset.sdcpp || options.args?.length || options.modelArgs?.length
    || options.initImage !== undefined || options.strength !== undefined) {
    preset.sdcpp ||= {};
    const appendedArgs = (options.args || []).flatMap(value => {
      const separator = value.indexOf('=');
      return separator < 0 ? [value] : [value.slice(0, separator), value.slice(separator + 1)];
    });
    preset.sdcpp.args = [...dropArguments(preset.sdcpp.args || [], dropped), ...appendedArgs];
    preset.sdcpp.modelArgs = [...(preset.sdcpp.modelArgs || []), ...(options.modelArgs || [])];
    if (options.initImage !== undefined) {
      const initImage = options.initImage === 'reference' ? 'reference' : path.resolve(options.initImage);
      preset.sdcpp.initImage = initImage;
      config.sdcpp.initImage = initImage;
    }
    if (options.strength !== undefined) {
      preset.sdcpp.strength = options.strength;
      config.sdcpp.strength = options.strength;
    }
  }
  if (options.reference !== undefined) {
    const reference = path.resolve(options.reference);
    config.referenceDir = path.dirname(reference);
    config.defaultReference = path.basename(reference);
  }
  return config;
}

function argvValue(argv, flag) {
  if (!argv) return undefined;
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    if (argv[index] === flag) return argv[index + 1];
    if (argv[index].startsWith(flag + '=')) return argv[index].slice(flag.length + 1);
  }
  return undefined;
}

const DEFAULT_POSITIVE =
  'Keep the character from the reference image exactly as is. Change only: pose to a casual selfie ' +
  'holding the camera, expression to a gentle smile, background to a cozy bedroom, soft warm lighting.';
const DEFAULT_NEGATIVE = 'blurry, low quality, deformed hands, extra fingers, watermark, text, nsfw';

export async function runSelfieTest({
  config,
  options,
  createProvider = createImageProvider,
  history = etaStore,
  appendRun = appendSelfieRun,
  output = console,
  signal,
} = {}) {
  try {
    options ||= parseSelfieTestArgs(config ? [] : process.argv.slice(2), config ? {} : process.env);
    if (options.compare) return await compareImages(options.compare, output);
    config = applySelfieTestOverrides(config || loadSelfieConfig({ provider: options.provider, preset: options.preset }), options);
  } catch (err) {
    output.error('FAILED [' + (err.code || 'ERR') + ']: ' + err.message);
    return 1;
  }
  const preset = config.presets[config.preset];
  output.log('== selfie:test | provider=' + config.provider + ' preset=' + config.preset
    + (config.comfyuiManaged?.profile ? ' profile=' + config.comfyuiManaged.profile : '')
    + ' (' + JSON.stringify(preset) + ')');
  const prevEta = history.getEta(config.preset, config.etaStorePath);
  output.log('Previous ETA: ' + (prevEta === null ? '(unavailable)' : prevEta + 's'));
  if (config.sdcpp) {
    output.log('config   : ' + JSON.stringify({
      offloadToCpu: config.sdcpp.offloadToCpu,
      args: config.sdcpp.args || [],
      presetArgs: preset.sdcpp?.args || [],
    }));
  }
  const runStartedAt = performance.now();
  let provider;
  let readinessMs = 0;
  let generationStartedAt;
  let lastPct = -1;
  let startedProvider = null;
  let result = null;
  let exitCode = 1;
  let runStatus = 'failed';
  try {
    provider = await createProvider(config);
    const readinessStartedAt = performance.now();
    const readiness = await provider.checkReady({ force: true, signal });
    readinessMs = Math.round(performance.now() - readinessStartedAt);
    const status = provider.getStatus();
    output.log('readiness: ' + readiness.code + ' active=' + (status.active || '(none)') + ' (' + readinessMs + ' ms)');
    output.log('reasons  : ' + JSON.stringify(status.reasons));
    const device = status.sdcpp || readiness;
    output.log('device   : backend=' + (device.backend || '(unavailable)') + ' device=' + (device.deviceName || '(unavailable)'));
    if (!readiness.ready) {
      output.error('Provider "' + config.provider + '" is unavailable: ' + readiness.message);
      exitCode = 3;
      runStatus = 'unavailable';
    } else {
      generationStartedAt = performance.now();
      result = await provider.generate({
        preset: config.preset,
        recordRun: false,
        sdcpp: preset.sdcpp,
        positivePrompt: DEFAULT_POSITIVE,
        negativePrompt: DEFAULT_NEGATIVE,
        referenceImage: config.defaultReference,
        resolution: preset.resolution,
        ...(options.width !== undefined && { width: options.width, height: options.height }),
        steps: preset.steps,
        cfgScale: preset.cfg,
        ...(options.seed !== undefined && { seed: options.seed }),
        providerOverrides: preset.providers,
      }, ({ value, max }) => {
        if (!(max > 0)) {
          if (lastPct !== null) output.log('  progress is indeterminate');
          lastPct = null;
          return;
        }
        const pct = Math.floor(value / max * 100);
        if (pct !== lastPct && (pct % 25 === 0 || value === max)) {
          lastPct = pct;
          output.log('  progress ' + value + '/' + max + ' (' + pct + '%)');
        }
      }, signal, (name) => {
        startedProvider = name;
        output.log('started  : ' + name);
      });
      const etaMs = result.provider === 'comfyui-managed' ? result.timings.generateMs : result.timings.totalMs;
      history.recordDuration(config.preset, Math.round(etaMs / 1000), config.etaStorePath, config.etaHistorySize);
      output.log('file     : ' + result.imagePath);
      output.log('provider : ' + result.provider);
      output.log('seed     : ' + result.seed);
      output.log('New ETA  : ' + history.getEta(config.preset, config.etaStorePath) + 's');
      exitCode = 0;
      runStatus = 'success';
    }
  } catch (err) {
    output.error('FAILED [' + (err.code || 'ERR') + ']: ' + err.message);
    runStatus = err.code || 'failed';
  } finally {
    const status = provider?.getStatus?.();
    const providerName = result?.provider || startedProvider || status?.active || config.provider;
    const managed = providerName === 'comfyui-managed';
    const terminal = provider?.getGenerationStatus?.() || (managed ? status?.comfyuiManaged : status?.sdcpp);
    const timings = result?.timings || provider?.getGenerationTimings?.() || (managed ? {
      coldStartMs: 0,
      generateMs: generationStartedAt === undefined ? 0 : Math.round(performance.now() - generationStartedAt),
      totalMs: Math.round(performance.now() - runStartedAt),
    } : null);
    for (const key of ['coldStartMs', 'queueMs', 'generateMs', 'downloadMs', 'totalMs']) {
      if (timings?.[key] !== undefined) output.log(key.padEnd(11) + ': ' + timings[key] + ' ms');
    }
    const profile = managed ? status?.comfyuiManaged?.profile ?? config.comfyuiManaged?.profile : undefined;
    if (managed) output.log('profile  : ' + (profile || '(default)'));
    const memory = result?.memory;
    output.log('memory   : ' + (memory?.memoryTier || terminal?.memoryTier || '(unavailable)')
      + ' (' + (memory?.message || terminal?.memoryMessage || 'heuristic estimate unavailable') + ')');
    const argv = result?.argv || provider?.getFinalArgv?.();
    const effectiveConfig = result?.effectiveConfig || provider?.getEffectiveConfig?.();
    if (effectiveConfig) output.log('effective: ' + JSON.stringify(effectiveConfig));
    for (const warning of result?.warnings || provider?.getSanityWarnings?.() || []) {
      output.log('warning  : [' + warning.code + '] ' + warning.message);
    }
    output.log('argv     : ' + (argv ? JSON.stringify(argv) : '(no process launched)'));
    const peaks = result?.peaks || provider?.getGenerationPeaks?.();
    output.log('peaks GB : ' + (peaks ? JSON.stringify(peaks) : '(unavailable)'));
    if (['sdcpp', 'comfyui-managed'].includes(startedProvider) && config.telemetry?.enabled !== false) {
      history.recordPeaks(config.preset, peaks, config.etaStorePath, config.etaHistorySize);
    }
    const providerPreset = preset.providers?.[providerName] || (managed ? preset.providers?.comfyui : null) || {};
    try {
      await appendRun({
        label: options.label || '', provider: providerName, profile, status: runStatus,
        width: Number(argvValue(argv, '-W') ?? options.width ?? providerPreset.resolution ?? preset.resolution),
        height: Number(argvValue(argv, '-H') ?? options.height ?? providerPreset.resolution ?? preset.resolution),
        steps: Number(argvValue(argv, '--steps') ?? providerPreset.steps ?? preset.steps),
        cfg: Number(argvValue(argv, '--cfg-scale') ?? providerPreset.cfg ?? preset.cfg),
        strength: argv ? argvValue(argv, '--strength') : options.strength ?? preset.sdcpp?.strength ?? config.sdcpp?.strength,
        args: options.args || [], modelArgs: options.modelArgs || [], droppedArgs: options.droppedArgs || [],
        seed: result?.seed ?? argvValue(argv, '-s') ?? options.seed,
        initImage: argv ? argvValue(argv, '-i') : preset.sdcpp?.initImage ?? config.sdcpp?.initImage,
        reference: argvValue(argv, '-r') ?? path.join(config.referenceDir || '', config.defaultReference || ''),
        timings: timings ? { readinessMs, ...timings } : {
          readinessMs, generateMs: generationStartedAt === undefined ? 0 : Math.round(performance.now() - generationStartedAt),
          totalMs: Math.round(performance.now() - runStartedAt),
        },
        peaks, imagePath: result?.imagePath,
      });
    } catch (err) {
      output.error('FAILED [RUN_LOG]: ' + err.message);
      exitCode = 1;
    } finally {
      try {
        await provider?.release?.();
      } catch (err) {
        output.error('FAILED [RELEASE]: ' + err.message);
        exitCode = 1;
      } finally {
        try {
          await provider?.shutdown?.();
        } catch (err) {
          output.error('FAILED [SHUTDOWN]: ' + err.message);
          exitCode = 1;
        }
      }
    }
  }
  return exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once('SIGINT', onInterrupt);
  try {
    process.exitCode = await runSelfieTest({ signal: controller.signal });
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}
