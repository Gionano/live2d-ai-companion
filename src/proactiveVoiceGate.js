// A sustained microphone level can interrupt unsolicited speech. This gate
// uses the existing echo-cancelled input; it is not a speech recognizer.
export class ProactiveVoiceGate {
  constructor({ durationMs = 200, thresholdGain = 1.5, maxSampleGapMs = 100 } = {}) {
    this.durationMs = durationMs;
    this.thresholdGain = thresholdGain;
    this.maxSampleGapMs = maxSampleGapMs;
    this.reset();
  }

  reset() {
    this.since = null;
    this.lastSampleAt = null;
  }

  sample({ active = false, muted = false, rms, now, threshold = 0.055 }) {
    if (!active || muted || !Number.isFinite(rms) || !Number.isFinite(now)
      || !Number.isFinite(threshold) || rms <= threshold * this.thresholdGain) {
      this.reset();
      return false;
    }
    if (this.since === null || now < this.lastSampleAt || now - this.lastSampleAt > this.maxSampleGapMs) this.since = now;
    this.lastSampleAt = now;
    if (now - this.since < this.durationMs) return false;
    this.reset();
    return true;
  }
}
