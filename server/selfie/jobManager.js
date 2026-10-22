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
    this._providerPromise = null;
    this._runTasks = new Set();
    this._shuttingDown = false;
    this._shutdownPromise = null;
    this._lastReleasePromise = null;
    this._readyEvent = null;
    this.limitsStorePath = this.config.limitsStorePath === undefined
      ? path.resolve('data/selfie-limits.json') : this.config.limitsStorePath;
    this._loadLimits();
  }

  setBroadcaster(fn) {
    this.broadcaster = fn;
  }

  setSpeechHandler(fn) {
    this.speechHandler = fn;
  }

  async getProvider() {
    if (!this.provider) {
      if (!this._providerPromise) {
        if (this._shuttingDown) throw new Error('Selfie manager is shutting down');
        // The manager owns release, including shutdown; standalone providers still auto-release.
        this._providerPromise = createImageProvider({ ...this.config, freeVramAfter: false });
      }
      try {
        this.provider = await this._providerPromise;
      } catch (err) {
        this._providerPromise = null;
        throw err;
      }
    }
    return this.provider;
  }

  _loadLimits() {
    if (!this.limitsStorePath) return;
    try {
      const stored = JSON.parse(fs.readFileSync(this.limitsStorePath, 'utf-8'));
      const records = stored?.dailyRecords;
      if (!Number.isFinite(stored?.lastCompletedTime) || stored.lastCompletedTime < 0
        || !Number.isSafeInteger(records?.count) || records.count < 0
        || !/^\d{4}-\d{2}-\d{2}$/.test(records?.date)) {
        throw new Error('Invalid limits data');
      }
      const date = new Date(`${records.date}T00:00:00`);
      if (!Number.isFinite(date.getTime()) || date.getFullYear() !== Number(records.date.slice(0, 4))
        || date.getMonth() + 1 !== Number(records.date.slice(5, 7))
        || date.getDate() !== Number(records.date.slice(8, 10))) {
        throw new Error('Invalid limits date');
      }
      this.lastCompletedTime = stored.lastCompletedTime;
      this.dailyRecords = records;
      this.getDailyCount();
    } catch (err) {
      logSelfie(`[jobManager] Limits file missing or corrupt; reset counters: ${err.message}`, 'warn');
    }
  }

  _saveLimits() {
    if (!this.limitsStorePath) return;
    try {
      fs.mkdirSync(path.dirname(this.limitsStorePath), { recursive: true });
      const temporaryPath = `${this.limitsStorePath}.tmp`;
      fs.writeFileSync(temporaryPath, JSON.stringify({
        lastCompletedTime: this.lastCompletedTime,
        dailyRecords: this.dailyRecords,
      }, null, 2), 'utf-8');
      fs.renameSync(temporaryPath, this.limitsStorePath);
    } catch (err) {
      logSelfie(`[jobManager] Could not persist limits: ${err.message}`, 'warn');
    }
  }

  _getTodayDateString() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  getDailyCount() {
    const today = this._getTodayDateString();
    if (this.dailyRecords.date !== today) {
      this.dailyRecords = { date: today, count: 0 };
      this._saveLimits();
    }
    return this.dailyRecords.count;
  }

  incrementDailyCount() {
    this.getDailyCount(); // reset jika tanggal ganti
    this.dailyRecords.count += 1;
    this._saveLimits();
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

  _checkLimits(reservedCount = 0) {
    const currentDaily = this.getDailyCount();
    if (currentDaily + reservedCount >= (this.config.dailyLimit ?? 20)) {
      return {
        allowed: false,
        reason: 'DAILY_LIMIT',
        text: this.pickPhrase('dailyLimit') || 'Kamera aku istirahat dulu ya sayang, kuota foto hari ini sudah habis.',
        emotion: 'sayang',
      };
    }

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

    return { allowed: true };
  }

  _checkAdmission() {
    if (this._shuttingDown) return { allowed: false, reason: 'SHUTDOWN' };
    const reservations = [this.activeJob, ...this.queue].filter(job => job?.reserved).length;
    const limits = this._checkLimits(reservations);
    if (!limits.allowed) return limits;
    if ((this.activeJob || this.queue.length) && this.queue.length >= (this.config.maxQueue ?? 1)) {
      return {
        allowed: false,
        reason: 'BUSY',
        text: this.pickPhrase('busy') || 'Masih fotoin yang tadi ya sayang, tunggu sebentar yaa~',
        emotion: 'sayang',
      };
    }
    return { allowed: true };
  }

  // Admission and reservation must stay synchronous, before any provider/planner await.
  tryAdmit() {
    const check = this._checkAdmission();
    if (!check.allowed) return check;
    const job = {
      jobId: crypto.randomUUID(),
      abortController: new AbortController(),
      reserved: true,
      submitted: false,
      started: false,
      running: false,
    };
    if (this.activeJob || this.queue.length) this.queue.push(job);
    else this.activeJob = job;
    return { allowed: true, jobId: job.jobId };
  }

  _findJob(jobId) {
    return this.activeJob?.jobId === jobId ? this.activeJob
      : this.queue.find(job => job.jobId === jobId);
  }

  isAdmitted(jobId) {
    const job = this._findJob(jobId);
    return Boolean(job && !this._shuttingDown && !job.abortController.signal.aborted);
  }

  // Advisory only. Every actual request must reserve with tryAdmit or submitJob.
  async canAcceptJob() {
    const check = this._checkAdmission();
    if (!check.allowed) return check;
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

  async submitJob({ plan, preset = null, skipInitialSpeech = false, admission = null }) {
    let jobData = null;
    try {
      if (!plan || typeof plan !== 'object' || Array.isArray(plan)
        || typeof plan.caption !== 'string' || !plan.caption.trim()
        || !plan.slots || typeof plan.slots !== 'object' || Array.isArray(plan.slots)) {
        const reserved = admission?.allowed && this._findJob(admission.jobId);
        if (reserved && !reserved.submitted) this._refundSubmission(reserved);
        return { ok: false, reason: 'INVALID_PLAN' };
      }
      // Read caller-owned fields before reserving; getters cannot strand a slot.
      plan = { ...plan, slots: { ...plan.slots } };
      const admitted = admission || this.tryAdmit();
      if (!admitted.allowed) return { ...admitted, ok: false };
      jobData = this._findJob(admitted.jobId);
      if (!jobData || jobData.submitted || !this.isAdmitted(admitted.jobId)) {
        jobData = null;
        return { ok: false, reason: 'CANCELLED' };
      }
      const chosenPreset = preset || this.config.preset || 'cepat';
      const presetCfg = this.config.presets?.[chosenPreset] || { resolution: 768, steps: 12 };
      const { jobId } = jobData;
      const etaSeconds = etaStore.getEta(chosenPreset, this.config.etaStorePath);
      const initialText = this.pickPhrase('initial') || 'Tunggu ya sayang, aku pose dulu sebentar...';
      const queued = this.activeJob !== jobData;
      Object.assign(jobData, {
        plan,
        preset: chosenPreset,
        presetCfg,
        etaSeconds,
        initialText,
        submitted: true,
        startedEvent: { type: 'selfie_started', jobId, etaSeconds, preset: chosenPreset,
          caption: plan.caption, status: queued ? 'queued' : 'preparing' },
      });
      if (!skipInitialSpeech) {
        this.queueSpeech(initialText, 'sayang');
      }
      if (queued) {
        logSelfie(`[jobManager] Job dimasukkan ke antrean (${this.queue.length}/${this.config.maxQueue}) [jobId: ${jobId}]`);
        this.broadcast(jobData.startedEvent);
      } else {
        this._launchJob(jobData);
      }
      return { ok: true, jobId, etaSeconds, initialText, queued };
    } catch (err) {
      const reserved = jobData || (admission?.allowed && this._findJob(admission.jobId));
      if (reserved && (jobData || !reserved.submitted)) this._refundSubmission(reserved);
      throw err;
    }
  }

  _refundSubmission(job) {
    if (job.started) return;
    job.reserved = false;
    job.abortController.abort();
    if (this.activeJob === job) this.activeJob = null;
    else {
      const index = this.queue.indexOf(job);
      if (index >= 0) this.queue.splice(index, 1);
    }
    this._pumpQueue();
  }

  _launchJob(jobData) {
    if (!jobData.submitted || jobData.running || this._shuttingDown) return;
    jobData.running = true;
    const task = this._runJobAsync(jobData);
    this._runTasks.add(task);
    task.then(() => this._runTasks.delete(task));
  }

  _pumpQueue() {
    if (this._shuttingDown) return;
    if (!this.activeJob) this.activeJob = this.queue.shift() || null;
    if (this.activeJob) this._launchJob(this.activeJob);
  }

  _throwIfCancelled(jobData) {
    if (jobData.abortController.signal.aborted || this._shuttingDown) {
      throw Object.assign(new Error('Job cancelled'), { code: 'CANCELLED' });
    }
  }

  async _untilCancelled(jobData, operation) {
    const signal = jobData.abortController.signal;
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(Object.assign(new Error('Job cancelled'), { code: 'CANCELLED' }));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([operation, cancelled]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async _waitForStart(jobData) {
    while (true) {
      this._throwIfCancelled(jobData);
      const check = this._checkLimits();
      if (check.allowed) return;
      if (check.reason !== 'COOLDOWN') throw Object.assign(new Error(check.reason), check, { code: check.reason });
      const delay = Math.max(1, this.config.cooldownMs - (Date.now() - this.lastCompletedTime));
      await new Promise((resolve) => {
        const signal = jobData.abortController.signal;
        let timer;
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        signal.addEventListener('abort', finish, { once: true });
        timer = setTimeout(finish, delay);
        if (signal.aborted) finish();
      });
    }
  }

  _releaseProvider(prov) {
    if (!this._lastReleasePromise) {
      this._lastReleasePromise = Promise.resolve().then(() => prov.release()).catch((err) => {
        logSelfie(`[jobManager] Provider release failed: ${err.message}`, 'warn');
      });
    }
    return this._lastReleasePromise;
  }

  async _runJobAsync(jobData) {
    const { jobId, plan, preset, presetCfg, etaSeconds } = jobData;
    let prov = null;
    let failed = false;
    try {
      this._throwIfCancelled(jobData);
      prov = await this._untilCancelled(jobData, this.getProvider());
      this._throwIfCancelled(jobData);
      if (!await this._untilCancelled(jobData, prov.isAvailable())) {
        throw new Error('Generator gambar lokal belum aktif nih sayang.');
      }
      await this._waitForStart(jobData);
      // Consume the quota only when generation starts; pending cancellations refund it.
      this._throwIfCancelled(jobData);
      const startCheck = this._checkLimits();
      if (!startCheck.allowed) throw Object.assign(new Error(startCheck.reason), startCheck, { code: startCheck.reason });
      jobData.reserved = false;
      jobData.started = true;
      jobData.startTime = Date.now();
      this.incrementDailyCount();
      this._lastReleasePromise = null;
      this._readyEvent = null;
      jobData.startedEvent = { type: 'selfie_started', jobId, etaSeconds, preset, caption: plan.caption };
      logSelfie(`[jobManager] Memulai job selfie [${jobId}] (preset: ${preset}, ETA: ${etaSeconds}s)`);
      this.broadcast(jobData.startedEvent);
      this._throwIfCancelled(jobData);
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
          if (jobData.abortController.signal.aborted || jobData.readyEvent) return;
          const percentage = max > 0 ? Math.round((value / max) * 100) : 0;
          jobData.lastProgress = {
            type: 'selfie_progress',
            jobId,
            value,
            max,
            percentage,
          };
          this.broadcast(jobData.lastProgress);
        },
        jobData.abortController.signal,
      );
      this._throwIfCancelled(jobData);
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
      this._saveLimits();

      const imageUrl = `/selfies/${token}`;
      logSelfie(`[jobManager] Job selesai sukses dalam ${durationMs}ms -> ${imageUrl}`);

      // Broadcast event selesai ke semua client
      jobData.readyEvent = {
        type: 'selfie_ready',
        jobId,
        imageUrl,
        caption: plan.caption,
        emotion: plan.emotion,
        durationMs,
      };
      this._readyEvent = jobData.readyEvent;
      this.broadcast(jobData.readyEvent);

      // Suara avatar membacakan caption dengan emotion sesuai
      this.queueSpeech(plan.caption, plan.emotion);

    } catch (err) {
      failed = true;
      const isCancelled = jobData.abortController.signal.aborted || err.code === 'CANCELLED';
      if (isCancelled) {
        logSelfie(`[jobManager] Job dibatalkan [${jobId}]`);
        this._notifyCancelled(jobData);
      } else {
        logSelfie(`[jobManager] Job gagal [${jobId}]: ${err.message}`, 'warn');
        this.broadcast({ type: 'selfie_failed', jobId, reason: err.code || err.message });
        this.queueSpeech(err.text || this.pickPhrase('failed') || 'Yah sayang, fotonya gagal diproses nih.', err.emotion || 'malu');
      }
    } finally {
      jobData.reserved = false;
      if (jobData.cancelPromise) await jobData.cancelPromise;
      if (prov && jobData.started && (failed || this.config.freeVramAfter)) {
        await this._releaseProvider(prov);
      }
      if (this.activeJob === jobData) this.activeJob = null;
      this._pumpQueue();
    }
  }

  /**
   * Batalkan job aktif atau job di dalam antrean.
   */
  async cancelJob(jobId) {
    const job = jobId ? this._findJob(jobId) : this.activeJob;
    if (!job) return false;
    // A ready job may still be releasing VRAM; its result cannot be cancelled.
    if (job.readyEvent) return false;
    job.abortController.abort();
    if (!job.started) {
      job.reserved = false;
      if (this.activeJob === job) this.activeJob = null;
      else this.queue.splice(this.queue.indexOf(job), 1);
      this._notifyCancelled(job);
      this._pumpQueue();
    } else if (!job.cancelPromise) {
      job.cancelPromise = Promise.resolve().then(() => this.provider?.cancel()).catch((err) => {
        logSelfie(`[jobManager] Provider cancel failed: ${err.message}`, 'warn');
      });
    }
    if (job.cancelPromise) await job.cancelPromise;
    return true;
  }

  _notifyCancelled(job) {
    if (job.cancelledEvent) return;
    job.cancelledEvent = { type: 'selfie_cancelled', jobId: job.jobId };
    this.broadcast(job.cancelledEvent);
    if (job.submitted && !this._shuttingDown) {
      this.queueSpeech(this.pickPhrase('cancelled') || 'Pengambilan fotonya sudah aku batalkan ya sayang.', 'netral');
    }
  }

  sendSnapshot(send) {
    const job = this.activeJob;
    const ready = job?.readyEvent || (!job?.startedEvent && this._readyEvent);
    if (ready) {
      const token = ready.imageUrl.slice('/selfies/'.length);
      if (this.getFileByToken(token)) send({ ...ready });
    } else if (job?.startedEvent) {
      send({ ...job.startedEvent });
      if (job.lastProgress) send({ ...job.lastProgress });
    }
  }

  shutdown() {
    if (this._shutdownPromise) return this._shutdownPromise;
    this._shuttingDown = true;
    this._shutdownPromise = Promise.resolve().then(async () => {
      for (const job of [...this.queue]) await this.cancelJob(job.jobId);
      if (this.activeJob && !this.activeJob.readyEvent) await this.cancelJob(this.activeJob.jobId);
      await Promise.all([...this._runTasks]);
      // Join an existing release if shutdown races successful or failed cleanup.
      const prov = this.provider || (this._providerPromise && await this._providerPromise.catch(() => null));
      if (prov) await this._releaseProvider(prov);
      this.activeJob = null;
      this.queue = [];
    });
    return this._shutdownPromise;
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
