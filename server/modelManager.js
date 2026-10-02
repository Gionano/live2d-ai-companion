// ---------------------------------------------------------------------------
// modelManager.js  (server-side)
// Manages available Live2D models in public/models/, handles ZIP and folder
// uploads, extracts assets, and tracks the active model in activeModel.json.
// ---------------------------------------------------------------------------
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

const ROOT_DIR = process.cwd();
const MODELS_DIR = path.resolve(ROOT_DIR, 'public', 'models');
const CONFIG_FILE = path.resolve(ROOT_DIR, 'server', 'activeModel.json');
const DEFAULT_MODEL_PATH = '/models/live2d/IceGirl.model3.json';

/**
 * Ensure directories exist.
 */
function ensureDirs() {
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
  }
}

/**
 * Get active model path from server/activeModel.json or default.
 * @returns {string}
 */
export function getActiveModelPath() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (data && typeof data.activeModelPath === 'string') {
        const fullPath = path.resolve(ROOT_DIR, 'public', data.activeModelPath.replace(/^\//, ''));
        if (fs.existsSync(fullPath)) {
          return data.activeModelPath;
        }
      }
    }
  } catch (err) {
    console.warn('[ModelManager] Gagal membaca activeModel.json:', err.message);
  }

  // Fallback to default
  const defaultFullPath = path.resolve(ROOT_DIR, 'public', DEFAULT_MODEL_PATH.replace(/^\//, ''));
  if (fs.existsSync(defaultFullPath)) {
    return DEFAULT_MODEL_PATH;
  }

  // Fallback to first discovered model
  const list = scanAvailableModels().models;
  return list.length > 0 ? list[0].modelPath : DEFAULT_MODEL_PATH;
}

/**
 * Save active model path to server/activeModel.json.
 * @param {string} modelPath
 * @returns {boolean}
 */
export function setActiveModelPath(modelPath) {
  try {
    const configDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify(
        {
          activeModelPath: modelPath,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf-8',
    );
    console.log(`[ModelManager] Active model diubah ke: ${modelPath}`);
    return true;
  } catch (err) {
    console.error('[ModelManager] Gagal menyimpan activeModel.json:', err);
    return false;
  }
}

/**
 * Recursively find all *.model3.json files under a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function findModel3JsonFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findModel3JsonFiles(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.model3.json')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Find icon or thumbnail for a model folder.
 * @param {string} modelDir
 * @param {object} modelJson
 * @returns {string|null} - relative URL path starting with /models/...
 */
function findThumbnailUrl(modelDir, modelJson) {
  const iconCandidates = ['icon.jpg', 'icon.png', 'icon.webp', 'thumbnail.jpg', 'thumbnail.png'];
  for (const name of iconCandidates) {
    const candidatePath = path.join(modelDir, name);
    if (fs.existsSync(candidatePath)) {
      const rel = path.relative(path.resolve(ROOT_DIR, 'public'), candidatePath).replace(/\\/g, '/');
      return '/' + rel;
    }
  }

  // Fallback to first texture if available
  const textures = modelJson?.FileReferences?.Textures;
  if (Array.isArray(textures) && textures.length > 0) {
    const firstTex = textures[0];
    const texPath = path.join(modelDir, firstTex);
    if (fs.existsSync(texPath)) {
      const rel = path.relative(path.resolve(ROOT_DIR, 'public'), texPath).replace(/\\/g, '/');
      return '/' + rel;
    }
  }

  return null;
}

/**
 * Scan public/models/ and return a list of all detected Live2D models.
 * @returns {{ models: Array, activeModelPath: string }}
 */
export function scanAvailableModels() {
  ensureDirs();
  const activePath = getActiveModelPath();
  const models = [];
  const model3Files = findModel3JsonFiles(MODELS_DIR);

  for (const filePath of model3Files) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const json = JSON.parse(content);
      const modelDir = path.dirname(filePath);
      const relPath = path.relative(path.resolve(ROOT_DIR, 'public'), filePath).replace(/\\/g, '/');
      const webUrl = '/' + relPath;

      // Extract model display name
      const mocFile = json.FileReferences?.Moc;
      let displayName = path.basename(filePath, '.model3.json');
      if (mocFile) {
        displayName = path.basename(mocFile, '.moc3');
      }

      // Folder identifier (immediate subfolder of public/models)
      const relDir = path.relative(MODELS_DIR, modelDir).replace(/\\/g, '/');
      const folderId = relDir.split('/')[0] || displayName;

      const thumbnail = findThumbnailUrl(modelDir, json);

      models.push({
        id: folderId,
        name: displayName,
        folder: folderId,
        fileName: path.basename(filePath),
        modelPath: webUrl,
        thumbnail,
        hasPhysics: Boolean(json.FileReferences?.Physics),
        expressionCount: json.FileReferences?.Expressions?.length ?? 0,
        motionGroupCount: json.FileReferences?.Motions ? Object.keys(json.FileReferences.Motions).length : 0,
        isActive: webUrl === activePath,
      });
    } catch (err) {
      console.warn(`[ModelManager] Gagal parse model file ${filePath}:`, err.message);
    }
  }

  // Sort: active model first, then alphabetically
  models.sort((a, b) => {
    if (a.isActive) return -1;
    if (b.isActive) return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    models,
    activeModelPath: activePath,
  };
}

/**
 * Extract an uploaded ZIP file into public/models/<sanitizedName>/.
 * @param {Buffer} zipBuffer
 * @param {string} originalName
 * @returns {Promise<{ success: boolean, modelPath?: string, message?: string, model?: object }>}
 */
export async function extractZipModel(zipBuffer, originalName = 'model') {
  ensureDirs();
  const rawName = path.basename(originalName, path.extname(originalName))
    .trim()
    .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_') || 'model_' + Date.now();

  const targetDir = path.join(MODELS_DIR, rawName);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  try {
    const zip = new AdmZip(zipBuffer);
    zip.extractAllTo(targetDir, true);

    // Scan the newly extracted directory for *.model3.json
    const foundModelFiles = findModel3JsonFiles(targetDir);
    if (foundModelFiles.length === 0) {
      // Clean up empty/invalid folder
      fs.rmSync(targetDir, { recursive: true, force: true });
      return {
        success: false,
        message: 'File ZIP tidak berisi file .model3.json yang valid.',
      };
    }

    const mainModelFile = foundModelFiles[0];
    const relPath = path.relative(path.resolve(ROOT_DIR, 'public'), mainModelFile).replace(/\\/g, '/');
    const modelUrl = '/' + relPath;

    // Automatically set as active and return
    setActiveModelPath(modelUrl);
    const scanned = scanAvailableModels();
    const uploadedModel = scanned.models.find((m) => m.modelPath === modelUrl);

    console.log(`[ModelManager] Model berhasil di-upload dan diekstrak ke: ${modelUrl}`);

    return {
      success: true,
      message: `Model "${rawName}" berhasil di-upload dan diekstrak!`,
      modelPath: modelUrl,
      model: uploadedModel,
    };
  } catch (err) {
    console.error('[ModelManager] Gagal ekstrak ZIP:', err);
    return {
      success: false,
      message: `Gagal mengekstrak ZIP: ${err.message}`,
    };
  }
}
