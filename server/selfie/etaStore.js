// ---------------------------------------------------------------------------
// etaStore.js  (server-side, modul selfie / pap)
// Menyimpan rata-rata N durasi terakhir per preset untuk estimasi waktu (ETA).
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';

export class EtaStore {
  constructor(cfg) {
    this.file = cfg.etaStorePath;
    this.size = cfg.etaHistorySize || 5;
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch {
      return {};
    }
  }

  /** Catat durasi total (ms) satu job sukses untuk preset tertentu. */
  record(preset, totalMs) {
    const data = this._read();
    const list = Array.isArray(data[preset]) ? data[preset] : [];
    list.push(Math.round(totalMs));
    data[preset] = list.slice(-this.size);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[selfie] Gagal menyimpan durasi ETA:', err.message);
    }
  }

  /** Rata-rata ms, atau null bila belum ada riwayat. */
  estimateMs(preset) {
    const list = this._read()[preset];
    if (!Array.isArray(list) || list.length === 0) return null;
    return Math.round(list.reduce((a, b) => a + b, 0) / list.length);
  }

  estimateSeconds(preset) {
    const ms = this.estimateMs(preset);
    return ms === null ? null : Math.round(ms / 1000);
  }
}

let defaultStoreInstance = null;
export async function getEtaStore(cfg) {
  if (!defaultStoreInstance || cfg) {
    const { loadSelfieConfig } = await import('./config.js');
    defaultStoreInstance = new EtaStore(cfg || loadSelfieConfig());
  }
  return defaultStoreInstance;
}

export const etaStore = {
  getEta(preset, filePath = null) {
    try {
      const target = filePath || path.resolve(process.cwd(), 'data/selfie-durations.json');
      if (!fs.existsSync(target)) return null;
      const data = JSON.parse(fs.readFileSync(target, 'utf-8'));
      const list = data[preset];
      if (!Array.isArray(list) || list.length === 0) return null;
      const avgMs = list.reduce((a, b) => a + b, 0) / list.length;
      return Math.round(avgMs / 1000);
    } catch {
      return null;
    }
  },
  recordDuration(preset, durationSec, filePath = null) {
    try {
      const target = filePath || path.resolve(process.cwd(), 'data/selfie-durations.json');
      let data = {};
      try {
        data = JSON.parse(fs.readFileSync(target, 'utf-8'));
      } catch (_) {}
      const list = Array.isArray(data[preset]) ? data[preset] : [];
      list.push(Math.round(durationSec * 1000));
      data[preset] = list.slice(-5);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf-8');
    } catch (_) {}
  },
};
