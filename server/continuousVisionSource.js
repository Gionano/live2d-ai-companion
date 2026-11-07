import { compareVisionSignatures, normalizeVisionSignature, VISION_SIGNATURE_SIZES } from '../src/visionSignature.js';

const freshStats = () => ({ captured: 0, inferred: 0, unchanged: 0, rateLimited: 0,
  superseded: 0, rejected: 0, expired: 0, errors: 0 });

export class ContinuousVisionSource {
  constructor(source, manager) {
    this.source = source;
    this.manager = manager;
    this.active = false;
    this.sessionId = null;
    this.epoch = 0;
    this.lastSequence = -1;
    this.latest = null;
    this.accepted = null;
    this.recent = null;
    this.pending = null;
    this.inflight = null;
    this.timer = null;
    this.lastInferenceAt = -Infinity;
    this.lastFilterAt = manager.now();
    this.filterController = null;
    this.window = [];
    this.stats = freshStats();
    this.lastScore = null;
  }

  setStatus(active, sessionId) {
    if (typeof active !== 'boolean' || active && (typeof sessionId !== 'string'
      || !sessionId.trim() || sessionId.length > 128)) return false;
    if (!active && this.active && sessionId && sessionId !== this.sessionId) return false;
    if (this.active === active && (!active || this.sessionId === sessionId)) return true;
    this.epoch++;
    this.active = active;
    this.sessionId = active ? sessionId : null;
    this.lastSequence = -1;
    this.latest = this.accepted = this.recent = this.pending = null;
    this.lastInferenceAt = -Infinity;
    this.lastFilterAt = this.manager.now();
    this.window = [];
    clearTimeout(this.timer);
    this.timer = null;
    this.inflight?.controller.abort();
    this.filterController?.abort();
    this.manager.refreshBuffer();
    return true;
  }

  isFresh(frame = this.latest) {
    return !!frame && this.manager.now() - frame.capturedAt <= this.manager.settings.freshnessMs;
  }

  comparison(signature) {
    return compareVisionSignatures(this.accepted?.signature, signature, this.source,
      this.manager.settings[this.source === 'screen' ? 'screenChangeThreshold' : 'webcamChangeThreshold']);
  }

  async handle(image, options) {
    const { sessionId, sequence, signal } = options;
    const legacy = options.legacy === true;
    const captureAgeMs = options.captureAgeMs ?? 0;
    const capturedAt = this.manager.now() - captureAgeMs;
    const signature = normalizeVisionSignature(options.signature);
    const size = VISION_SIGNATURE_SIZES[this.source];
    if (!this.active || this.manager.disposed || sessionId !== this.sessionId
      || !Number.isSafeInteger(sequence) || sequence <= this.lastSequence
      || !Number.isFinite(captureAgeMs) || captureAgeMs < 0
      || captureAgeMs > this.manager.settings.freshnessMs || (!legacy && (!signature
        || signature.width !== size.width || signature.height !== size.height))
      || this.latest && capturedAt < this.latest.capturedAt
      || typeof image !== 'string' || image.length > 16 * 1024 * 1024
      || !/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=\s]+$/i.test(image) || signal?.aborted) {
      this.stats.rejected++;
      this.manager.publishStats();
      return { accepted: false };
    }
    this.lastSequence = sequence;
    this.stats.captured++;
    this.manager.stats.totalFramesCaptured++;
    const frame = { image, signature, capturedAt, sequence, sessionId, epoch: this.epoch,
      promptVersion: this.manager.promptVersion, signal };
    this.latest = frame;
    this.manager.broadcast({ type: 'monitor_frame', source: this.source, sessionId,
      image, timestamp: this.manager.now() });
    const comparison = this.comparison(signature);
    this.lastScore = comparison.score;
    if (this.accepted && !comparison.changed && this.accepted.promptVersion === this.manager.promptVersion) {
      this.accepted.verifiedAt = capturedAt;
      this.pending = null;
      clearTimeout(this.timer);
      this.timer = null;
      this.stats.unchanged++;
      this.manager.publishStats();
      return { accepted: true, skipped: 'unchanged' };
    }
    if (this.pending) this.stats.superseded++;
    this.pending = frame;
    if (this.inflight) {
      this.manager.publishStats();
      return { accepted: true, pending: true };
    }
    return this.pump();
  }

  async pump() {
    if (this.manager.disposed || !this.active || this.inflight || !this.pending) return;
    if (!this.isFresh(this.pending) || this.pending.epoch !== this.epoch || this.pending.signal?.aborted) {
      this.stats.expired++;
      this.pending = null;
      this.manager.publishStats();
      return;
    }
    const remaining = this.manager.settings.minInferenceIntervalMs - (this.manager.now() - this.lastInferenceAt);
    if (remaining > 0) {
      this.stats.rateLimited++;
      if (!this.timer) {
        this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, remaining);
        this.timer.unref?.();
      }
      this.manager.publishStats();
      return { accepted: true, skipped: 'rate' };
    }
    if (!this.manager.registry.getSlotStatus('vision').available) {
      this.pending = null;
      return { accepted: false, skipped: 'unavailable' };
    }
    const frame = this.pending;
    this.pending = null;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    frame.signal?.addEventListener('abort', forwardAbort, { once: true });
    const job = { controller, frame };
    this.inflight = job;
    this.lastInferenceAt = this.manager.now();
    this.stats.inferred++;
    this.manager.stats.totalVisionCalls++;
    this.manager.updateBusy();
    this.manager.publishStats();
    try {
      const entry = await this.manager.describeContinuousFrame(frame, this.source, controller.signal);
      if (this.manager.disposed || !this.active || frame.epoch !== this.epoch || controller.signal.aborted) return;
      const matchesLatest = !compareVisionSignatures(frame.signature, this.latest?.signature, this.source,
        this.manager.settings[this.source === 'screen' ? 'screenChangeThreshold' : 'webcamChangeThreshold']).changed;
      // Legacy requests have no signature and cannot prove unchanged captures.
      if (matchesLatest || this.latest?.sequence === frame.sequence) {
        this.recent = this.accepted;
        this.accepted = { ...entry, signature: frame.signature, promptVersion: frame.promptVersion,
          verifiedAt: matchesLatest ? this.latest.capturedAt : frame.capturedAt };
      } else {
        this.recent = { ...entry, signature: frame.signature, promptVersion: frame.promptVersion };
      }
      this.window.push(entry);
      this.window = this.window.slice(-100);
      this.manager.refreshBuffer();
      this.manager.broadcast({ type: 'vision_entry', source: this.source, entry,
        bufferCount: this.manager.buffer.length, stats: this.manager.stats });
    } catch (error) {
      if (!controller.signal.aborted && frame.epoch === this.epoch && !this.manager.disposed) {
        this.stats.errors++;
        this.manager.broadcast({ type: 'vision_error', source: this.source,
          message: 'Deskripsi visual belum tersedia. Aku akan mencoba pada tangkapan berikutnya.' });
      }
    } finally {
      frame.signal?.removeEventListener('abort', forwardAbort);
      if (this.inflight === job) this.inflight = null;
      this.manager.updateBusy();
      if (!this.manager.disposed && this.active) void this.pump();
      this.manager.publishStats();
    }
    return { accepted: true };
  }

  context() {
    if (!this.active || !this.isFresh()) return null;
    const label = this.source === 'screen' ? 'Layar' : 'Kamera';
    if (this.accepted && !this.comparison(this.latest.signature).changed) {
      return `[${label} saat ini] ${this.accepted.description}`;
    }
    const recent = [this.accepted, this.recent].filter(entry => entry
      && this.manager.now() - entry.capturedAt <= this.manager.settings.freshnessMs)
      .sort((left, right) => right.generatedAt - left.generatedAt)[0];
    return recent ? `[${label} baru saja, bukan kondisi saat ini] ${recent.description}` : null;
  }

  snapshot() {
    const completed = [this.accepted, this.recent].filter(Boolean)
      .sort((left, right) => right.generatedAt - left.generatedAt)[0];
    return { source: this.source, active: this.active, sessionId: this.sessionId,
      freshness: !this.active ? 'off' : !this.isFresh() ? 'expired'
        : this.accepted && !this.comparison(this.latest.signature).changed ? 'current'
          : this.context() ? 'recent' : 'waiting',
      lastCaptureAgeMs: this.latest ? Math.max(0, this.manager.now() - this.latest.capturedAt) : null,
      lastInferenceAgeMs: this.accepted ? Math.max(0, this.manager.now() - this.accepted.generatedAt) : null,
      score: this.lastScore, pending: !!this.pending, inFlight: !!this.inflight,
      inFlightAgeMs: this.inflight ? Math.max(0, this.manager.now() - this.lastInferenceAt) : null,
      lastLatencyMs: completed?.latencyMs ?? null, lastFirstResponseMs: completed?.firstResponseMs ?? null,
      sequence: this.lastSequence, bufferCount: this.window.length, ...this.stats };
  }

  dispose() {
    this.setStatus(false, null);
    clearTimeout(this.timer);
    this.timer = null;
  }
}
