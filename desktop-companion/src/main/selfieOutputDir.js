import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceResolver = new URL('../../../server/selfie/localPaths.js', import.meta.url);
const resolverUrl = fs.existsSync(sourceResolver) ? sourceResolver
  : pathToFileURL(path.join(process.resourcesPath, 'selfie', 'localPaths.js'));
const { createLocalPaths } = await import(resolverUrl.href);

export function readLocalSelfieOutputDir(configPath, { allowMissing = false } = {}) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') config = {};
    else throw new Error(`Cannot read local selfie configuration: ${error.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || config.outputDir !== undefined && typeof config.outputDir !== 'string') {
    throw new Error('Invalid local selfie output directory');
  }
  const localPath = path.join(path.dirname(configPath), 'selfie.config.local.json');
  let localConfig = {};
  try {
    localConfig = JSON.parse(fs.readFileSync(localPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read local selfie configuration: ${error.message}`);
  }
  if (!localConfig || typeof localConfig !== 'object' || Array.isArray(localConfig)
    || localConfig.outputDir !== undefined && typeof localConfig.outputDir !== 'string') {
    throw new Error('Invalid local selfie output directory');
  }
  return (localConfig.outputDir ?? config.outputDir ?? '').trim();
}

// Capture the backend's resolved folder in the main-process-only packaged snapshot.
export function createPackagedSelfieConfig(configPath) {
  const outputDir = readLocalSelfieOutputDir(configPath, { allowMissing: true });
  const paths = createLocalPaths({ repoRoot: path.dirname(configPath) });
  return { outputDir: paths.resolvePath(outputDir, { fallback: paths.outputsDir() }) };
}

export function resolveLocalSelfieOutputDir({ isPackaged = false, resourcesPath, serverRoot, configPath } = {}) {
  if (configPath && !path.isAbsolute(configPath)) throw new Error('SELFIE_CONFIG_PATH must be absolute');
  const sourcePath = configPath || path.join(isPackaged ? resourcesPath : serverRoot, 'selfie.config.json');
  const outputDir = readLocalSelfieOutputDir(sourcePath, { allowMissing: !configPath && !isPackaged });
  const paths = createLocalPaths({ repoRoot: path.dirname(sourcePath) });
  return paths.resolvePath(outputDir, { fallback: paths.outputsDir() });
}
