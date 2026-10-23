import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function readLocalSelfieOutputDir(configPath, { allowMissing = false } = {}) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return '';
    throw new Error(`Cannot read local selfie configuration: ${error.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || config.outputDir !== undefined && typeof config.outputDir !== 'string') {
    throw new Error('Invalid local selfie output directory');
  }
  return (config.outputDir || '').trim();
}

function isHomeRelative(value) {
  return value === '~' || value.startsWith('~/') || value.startsWith('~\\');
}

export function resolveLocalSelfieOutputDir({ isPackaged = false, resourcesPath, serverRoot, configPath } = {}) {
  if (configPath && !path.isAbsolute(configPath)) throw new Error('SELFIE_CONFIG_PATH must be absolute');
  const sourcePath = configPath || path.join(isPackaged ? resourcesPath : serverRoot, 'selfie.config.json');
  const outputDir = readLocalSelfieOutputDir(sourcePath, { allowMissing: !configPath && !isPackaged });
  if (!outputDir) return path.join(os.homedir(), 'Pictures', 'WaifuSelfies');
  if (isHomeRelative(outputDir)) return path.join(os.homedir(), outputDir.slice(1));
  return path.isAbsolute(outputDir) ? outputDir : path.resolve(path.dirname(sourcePath), outputDir);
}
