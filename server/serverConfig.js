// ---------------------------------------------------------------------------
// serverConfig.js  (server-side)
// Helper to read centralized tuning values from config/animationConfig.json
// with in-memory caching and automatic reload on file changes.
// ---------------------------------------------------------------------------
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.resolve(__dirname, '../config/animationConfig.json');

let cachedConfig = null;

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    cachedConfig = JSON.parse(raw);
  } catch (err) {
    console.warn('[serverConfig] Could not read animationConfig.json:', err.message);
  }
}

// Initial load
loadConfig();

// Watch for file changes without holding process open
try {
  const watcher = fs.watch(CONFIG_PATH, () => {
    loadConfig();
  });
  watcher.unref?.();
} catch (_) {}

/**
 * Get a parameter value from animationConfig.json with fallback
 * @param {string} group - e.g. 'vad', 'vision', 'models'
 * @param {string} key - e.g. 'noSpeechThreshold', 'captureInterval'
 * @param {*} fallback - Default fallback value
 */
export function getServerTuning(group, key, fallback) {
  if (!cachedConfig) loadConfig();
  return cachedConfig?.[group]?.[key]?.value ?? fallback;
}
