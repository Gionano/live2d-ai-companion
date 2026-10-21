// ---------------------------------------------------------------------------
// jobManager.js  (server-side, modul selfie / pap)
// Pengelola antrean dan siklus hidup job selfie:
// - 1 job aktif, maxQueue antrean, cooldown antar foto, batas harian
// - Berjalan ASYNCHRONOUS dan TIDAK memblokir percakapan turn-taking
// - Mengirim event WebSocket (selfie_started, selfie_progress, selfie_ready, selfie_failed, selfie_cancelled)
// - Menyajikan gambar lewat token acak tidak tertebak (/selfies/:token)
// - Membersihkan job dan membebaskan VRAM setelah selesai/gagal/batal
// ---------------------------------------------------------------------------
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { loadSelfieConfig } from './config.js';
import { createImageProvider } from './imageProvider.js';
import { etaStore } from './etaStore.js';
import { logSelfie } from './log.js';

// Batas maksimal token yang disimpan dan TTL (24 jam).
const TOKEN_MAX_ENTRIES = 100;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export class JobManager {
  constructor(config = null) {
    this.config = config || loadSelfieConfig();
    this.provider = null;
    this.activeJob = null;
    this.queue = [];
    this.lastCompletedTime = 0;
    this.dailyRecords = { date: this._getTodayDateString(), count: 0 };
    this.tokenMap = new Map(); // token -> { filePath, jobId, timestamp }
    this.broadcaster = null;
    this.speechHandler = null;
  }

  setBroadcaster(fn) {
    this.broadcaster = fn;
  }

  setSpeechHandler(fn) {
    this.speechHandler = fn;
  }

  async getProvider() {
    if (!this.provider) {
      this.provider = await createImageProvider(this.config);
    }
    return this.provider;
  }

  _getTodayDateString() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  getDailyCount() {
    const today = this._getTodayDateString();
    if (this.dailyRecords.date !== today) {
      this.dailyRecords = { date: today, count: 0 };
    }
    return this.dailyRecords.count;
  }

  incrementDailyCount() {
    this.getDailyCount(); // reset jika tanggal ganti
    this.dailyRecords.count += 1;
    return this.dailyRecords.count;
  }

  pickPhrase(type) {
    const phrases = this.config.phrases?.[type] || [];
    if (!phrases.length) return '';
    return phrases[Math.floor(Math.random() * phrases.length)];
  }

  broadcast(eventObj) {
    if (typeof this.broadcaster === 'function') {
      try {
        this.broadcaster(eventObj);
      } catch (err) {
        logSelfie(`[jobManager] Broadcast error: ${err.message}`, 'warn');
      }
    }
  }

  queueSpeech(text, emotion = 'sayang') {
    if (!text) return;
    if (typeof this.speechHandler === 'function') {
      try {
        this.speechHandler({ text, emotion });
      } catch (err) {
        logSelfie(`[jobManager] Speech handler error: ${err.message}`, 'warn');
      }
    }
  }

  /**
   * Cek apakah sistem dapat menerima job baru (batas harian, cooldown, status sibuk, ketersediaan provider).
   */
  async canAcceptJob() {
    // 1. Batas harian
    const currentDaily = this.getDailyCount();
    if (currentDaily >= this.config.dailyLimit) {
      return {
        allowed: false,
        reason: 'DAILY_LIMIT',
        text: this.pickPhrase('dailyLimit') || 'Kamera aku istirahat dulu ya sayang, kuota foto hari ini sudah habis.',
        emotion: 'sayang',
      };
    }

    // 2. Cooldown antar foto
    if (this.lastCompletedTime > 0) {
      const elapsed = Date.now() - this.lastCompletedTime;
      if (elapsed < this.config.cooldownMs) {
        const remainingSec = Math.ceil((this.config.cooldownMs - elapsed) / 1000);
        return {
          allowed: false,
          reason: 'COOLDOWN',
          remainingSec,
          text: this.pickPhrase('cooldown') || `Baru aja selesai foto nih sayang, bentar ya ${remainingSec} detik lagi~`,
          emotion: 'malu',
        };
      }
    }

    // 3. Status antrean & job aktif
    if (this.activeJob) {
      if (this.queue.length >= (this.config.maxQueue || 1)) {
        return {
          allowed: false,
          reason: 'BUSY',
          text: this.pickPhrase('busy') || 'Masih fotoin yang tadi ya sayang, tunggu sebentar yaa~',
          emotion: 'sayang',
        };
      }
    }

    // 4. Ketersediaan provider
    try {
      const prov = await this.getProvider();
      const isAvailable = await prov.isAvailable();
      if (!isAvailable) {
        return {
          allowed: false,
          reason: 'PROVIDER_UNAVAILABLE',
          text: this.pickPhrase('providerUnavailable') || 'Aduh sayang, generator gambar lokal sedang mati. Coba nyalakan ComfyUI dulu yaa.',
          emotion: 'malu',
        };
      }
    } catch (err) {
      return {
        allowed: false,
        reason: 'PROVIDER_UNAVAILABLE',
        text: this.pickPhrase('providerUnavailable') || 'Generator gambar lokal belum aktif nih sayang.',
        emotion: 'malu',
      };
    }

    return { allowed: true };
  }

  /**
   * Daftarkan job selfie baru dan jalankan secara asinkron.
   * @param {object} params
   * @param {object} params.plan - Hasil dari planSelfie (slots, positivePrompt, negativePrompt, referenceImage, caption, emotion)
   * @param {string} [params.preset] - 'cepat' | 'kualitas'
   * @returns {Promise<{ ok: boolean, jobId: string, etaSeconds: number, initialText: string }>}
   */
  async submitJob({ plan, preset = null, skipInitialSpeech = false }) {
    const chosenPreset = preset || this.config.preset || 'cepat';
    const presetCfg = this.config.presets?.[chosenPreset] || { resolution: 768, steps: 12 };

    const jobId = crypto.randomUUID();
    const storedEta = etaStore.getEta(chosenPreset, this.config.etaStorePath);
    const etaSeconds = storedEta || (chosenPreset === 'cepat' ? 95 : 150);

    const initialText = this.pickPhrase('initial') || 'Tunggu ya sayang, aku pose dulu sebentar...';

    // Ucapan awal avatar ("tunggu ya, aku pose dulu") diantrekan jika tidak di-skip
    if (!skipInitialSpeech) {
      this.queueSpeech(initialText, 'sayang');
    }

    const jobData = {
      jobId,
      plan,
      preset: chosenPreset,
      presetCfg,
      etaSeconds,
      initialText,
      abortController: new AbortController(),
      startTime: Date.now(),
    };

    if (this.activeJob) {
      this.queue.push(jobData);
      logSelfie(`[jobManager] Job dimasukkan ke antrean (${this.queue.length}/${this.config.maxQueue}) [jobId: ${jobId}]`);
      this.broadcast({
        type: 'selfie_started',
        jobId,
        etaSeconds,
        preset: chosenPreset,
        status: 'queued',
      });
      return { ok: true, jobId, etaSeconds, initialText, queued: true };
    }

    // Jalankan segera di background tanpa memblokir pemanggil
    this._runJobAsync(jobData);

    return { ok: true, jobId, etaSeconds, initialText, queued: false };
  }

  async _runJobAsync(jobData) {
    this.activeJob = jobData;
    const { jobId, plan, preset, presetCfg, etaSeconds } = jobData;

    logSelfie(`[jobManager] Memulai job selfie [${jobId}] (preset: ${preset}, ETA: ${etaSeconds}s)`);
    this.broadcast({
      type: 'selfie_started',
      jobId,
      etaSeconds,
      preset,
      caption: plan.caption,
    });

    try {
      const prov = await this.getProvider();
      const t0 = performance.now();

      const genParams = {
        positivePrompt: plan.positivePrompt,
        negativePrompt: plan.negativePrompt,
        referenceImage: plan.referenceImage,
        resolution: presetCfg.resolution,
        steps: presetCfg.steps,
      };

      const result = await prov.generate(
        genParams,
        ({ value, max }) => {
          const percentage = max > 0 ? Math.round((value / max) * 100) : 0;
          this.broadcast({
            type: 'selfie_progress',
            jobId,
            value,
            max,
            percentage,
          });
        },
        jobData.abortController.signal,
      );

      const durationMs = Math.round(performance.now() - t0);
      etaStore.recordDuration(preset, Math.round(durationMs / 1000), this.config.etaStorePath);

      // Buat token akses acak yang tidak bisa ditebak (Point 15)
      const token = crypto.randomBytes(16).toString('hex');
      this.tokenMap.set(token, {
        filePath: result.imagePath,
        jobId,
        timestamp: Date.now(),
      });
      this._pruneTokens();

      this.lastCompletedTime = Date.now();
      this.incrementDailyCount();

      const imageUrl = `/selfies/${token}`;
      logSelfie(`[jobManager] Job selesai sukses dalam ${durationMs}ms -> ${imageUrl}`);

      // Broadcast event selesai ke semua client
      this.broadcast({
        type: 'selfie_ready',
        jobId,
        imageUrl,
        caption: plan.caption,
        emotion: plan.emotion,
        durationMs,
      });

      // Suara avatar membacakan caption dengan emotion sesuai
      this.queueSpeech(plan.caption, plan.emotion);

      if (this.config.freeVramAfter) {
        await prov.release();
      }
    } catch (err) {
      const isCancelled = jobData.abortController.signal.aborted || err.code === 'CANCELLED';
      if (isCancelled) {
        logSelfie(`[jobManager] Job dibatalkan [${jobId}]`);
        this.broadcast({ type: 'selfie_cancelled', jobId });
        this.queueSpeech(this.pickPhrase('cancelled') || 'Pengambilan fotonya sudah aku batalkan ya sayang.', 'netral');
      } else {
        logSelfie(`[jobManager] Job gagal [${jobId}]: ${err.message}`, 'warn');
        this.broadcast({ type: 'selfie_failed', jobId, reason: err.message });
        this.queueSpeech(this.pickPhrase('failed') || 'Yah sayang, fotonya gagal diproses nih.', 'malu');
      }

      try {
        const prov = await this.getProvider();
        await prov.release();
      } catch (_) {}
    } finally {
      this.activeJob = null;
      // Jika masih ada job di antrean, jalankan berikutnya
      if (this.queue.length > 0) {
        const nextJob = this.queue.shift();
        this._runJobAsync(nextJob);
      }
    }
  }

  /**
   * Batalkan job aktif atau job di dalam antrean.
   */
  async cancelJob(jobId) {
    if (this.activeJob && (!jobId || this.activeJob.jobId === jobId)) {
      logSelfie(`[jobManager] Membatalkan active job [${this.activeJob.jobId}]`);
      this.activeJob.abortController.abort();
      try {
        const prov = await this.getProvider();
        await prov.cancel();
      } catch (_) {}
      return true;
    }

    const idx = this.queue.findIndex((j) => j.jobId === jobId);
    if (idx !== -1) {
      const removed = this.queue.splice(idx, 1)[0];
      logSelfie(`[jobManager] Menghapus job dari antrean [${removed.jobId}]`);
      this.broadcast({ type: 'selfie_cancelled', jobId: removed.jobId });
      return true;
    }

    return false;
  }

  /**
   * Ambil data file berdasarkan token acak (Point 15).
   * Mengembalikan null jika token tidak ada atau sudah kedaluwarsa (>24 jam).
   */
  getFileByToken(token) {
    if (!token || typeof token !== 'string') return null;
    const entry = this.tokenMap.get(token);
    if (!entry) return null;
    // Hapus token kedaluwarsa saat diakses
    if (Date.now() - entry.timestamp > TOKEN_TTL_MS) {
      this.tokenMap.delete(token);
      return null;
    }
    return entry;
  }

  /**
   * Bersihkan token lama: hapus yang sudah kedaluwarsa (>24 jam),
   * dan jika masih melebihi TOKEN_MAX_ENTRIES, hapus yang paling tua.
   */
  _pruneTokens() {
    const now = Date.now();
    // 1. Hapus token kedaluwarsa
    for (const [key, val] of this.tokenMap) {
      if (now - val.timestamp > TOKEN_TTL_MS) {
        this.tokenMap.delete(key);
      }
    }
    // 2. Jika masih terlalu banyak, hapus yang paling tua
    if (this.tokenMap.size > TOKEN_MAX_ENTRIES) {
      const entries = [...this.tokenMap.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = entries.slice(0, this.tokenMap.size - TOKEN_MAX_ENTRIES);
      for (const [key] of toRemove) {
        this.tokenMap.delete(key);
      }
    }
  }
}

export const jobManager = new JobManager();
