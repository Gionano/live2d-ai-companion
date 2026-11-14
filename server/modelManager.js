import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WITCH_MODEL_PATH } from '../src/characterModel.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

export function getActiveModelPath() {
  return WITCH_MODEL_PATH;
}

// Keep the read-only API for clients that display model information.
export function scanAvailableModels() {
  const models = [];
  const modelFile = path.join(PUBLIC_DIR, WITCH_MODEL_PATH.slice(1));
  if (fs.existsSync(modelFile)) {
    const json = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
    const references = json.FileReferences ?? {};
    models.push({
      id: 'witch',
      name: 'Witch',
      folder: '魔女',
      fileName: path.basename(modelFile),
      modelPath: WITCH_MODEL_PATH,
      thumbnail: references.Textures?.[0] ? `/models/魔女/${references.Textures[0]}` : null,
      hasPhysics: Boolean(references.Physics),
      expressionCount: references.Expressions?.length ?? 0,
      motionGroupCount: Object.keys(references.Motions ?? {}).length,
      isActive: true,
    });
  }
  return { models, activeModelPath: WITCH_MODEL_PATH };
}
