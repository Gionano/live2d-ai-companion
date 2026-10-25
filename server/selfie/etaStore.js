// ---------------------------------------------------------------------------
// etaStore.js  (server-side, modul selfie / pap)
// Menyimpan rata-rata N durasi terakhir per preset untuk estimasi waktu (ETA).
// Satuan penyimpanan: milidetik (ms). Input dan output diseragamkan.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_HISTORY_SIZE = 5;
const PEAK_FIELDS = ['vramUsedGB', 'privateBytesGB', 'peakWorkingSetGB', 'commitUsedGB', 'commitLimitGB', 'sharedGpuUsedGB'];

export function normalizeMemoryPeaks(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(PEAK_FIELDS.map(field => [field,
    Number.isFinite(value[field]) && value[field] >= 0 ? value[field] : null,
  ]));
}

/**
 * Singleton ETA store. Menyimpan durasi job ke file JSON,
 * mengembalikan estimasi rata-rata N terakhir.
 *
 * Satuan internal: milidetik (ms).
 * - recordDuration(preset, durationSec) — input dalam DETIK, disimpan sebagai ms.
 * - getEta(preset)                      — return dalam DETIK (rata-rata ms / 1000).
 * - getEtaMs(preset)                    — return dalam MS.
 */
export const etaStore = {
  /**
   * Ambil estimasi ETA dalam detik, atau null bila belum ada riwayat.
   */
  getEta(preset, filePath = null) {
    const ms = this.getEtaMs(preset, filePath);
    return ms === null ? null : Math.round(ms / 1000);
  },

  /**
   * Ambil estimasi ETA dalam milidetik, atau null bila belum ada riwayat.
   */
  getEtaMs(preset, filePath = null) {
    try {
      const target = resolveStorePath(filePath);
      if (!fs.existsSync(target)) return null;
      const data = JSON.parse(fs.readFileSync(target, 'utf-8'));
      const list = data[preset];
      if (!Array.isArray(list) || list.length === 0) return null;
      return Math.round(list.reduce((a, b) => a + b, 0) / list.length);
    } catch {
      return null;
    }
  },

  /**
   * Catat durasi satu job sukses.
   * @param {string} preset - Nama preset ('cepat', 'kualitas')
   * @param {number} durationSec - Durasi dalam DETIK
   * @param {string} [filePath] - Path file penyimpanan (opsional)
   * @param {number} [historySize] - Jumlah riwayat yang disimpan (default 5)
   */
  recordDuration(preset, durationSec, filePath = null, historySize = DEFAULT_HISTORY_SIZE) {
    try {
      const target = resolveStorePath(filePath);
      let data = {};
      try {
        data = JSON.parse(fs.readFileSync(target, 'utf-8'));
      } catch (_) {}
      const list = Array.isArray(data[preset]) ? data[preset] : [];
      list.push(Math.round(durationSec * 1000)); // simpan sebagai ms
      data[preset] = list.slice(-historySize);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[selfie] [etaStore] Gagal menyimpan durasi ETA:', err.message);
    }
  },

  getLastPeaks(preset, filePath = null) {
    try {
      const data = JSON.parse(fs.readFileSync(resolveStorePath(filePath), 'utf-8'));
      const history = data._peaks?.[preset];
      return Array.isArray(history) ? normalizeMemoryPeaks(history.at(-1)) : null;
    } catch {
      return null;
    }
  },

  recordPeaks(preset, peaks, filePath = null, historySize = DEFAULT_HISTORY_SIZE) {
    const normalized = normalizeMemoryPeaks(peaks);
    if (!normalized) return;
    try {
      const target = resolveStorePath(filePath);
      let data = {};
      try {
        data = JSON.parse(fs.readFileSync(target, 'utf-8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
      } catch {}
      if (!data._peaks || typeof data._peaks !== 'object' || Array.isArray(data._peaks)) data._peaks = {};
      const history = Array.isArray(data._peaks[preset]) ? data._peaks[preset] : [];
      const limit = Number.isSafeInteger(historySize) && historySize > 0 ? historySize : DEFAULT_HISTORY_SIZE;
      data._peaks[preset] = [...history, { timestamp: Date.now(), ...normalized }].slice(-limit);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[selfie] Could not persist memory peaks:', err.message);
    }
  },
};

function resolveStorePath(filePath) {
  return filePath || path.resolve(process.cwd(), 'data/selfie-durations.json');
}
