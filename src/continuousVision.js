import { createVisionSignature } from './visionSignature.js';
import { logger as console } from './logging.js';

export function captureSignature(video, source, canvas = document.createElement('canvas')) {
  canvas.width = source === 'screen' ? 128 : 64;
  canvas.height = source === 'screen' ? 72 : 48;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return createVisionSignature(context.getImageData(0, 0, canvas.width, canvas.height).data,
    canvas.width, canvas.height);
}

export async function signatureFromImage(image, source) {
  const decoded = new Image();
  decoded.src = image;
  await decoded.decode();
  return captureSignature(decoded, source);
}

// Source generations fence old frames when the monitor or a capture source stops.
export class ContinuousVisionCapture {
  constructor({ capture, send, canSend = () => true, now = () => performance.now(),
    makeId = () => crypto.randomUUID(),
    setIntervalFn = (callback, interval) => globalThis.setInterval(callback, interval),
    clearIntervalFn = timer => globalThis.clearInterval(timer) }) {
    Object.assign(this, { capture, send, canSend, now, makeId, setIntervalFn, clearIntervalFn });
    this.connected = false;
    this.monitorActive = false;
    this.sources = new Map(['screen', 'webcam'].map(source => [source,
      { active: false, sessionId: null, sequence: 0, timer: null, busy: false, generation: 0 }]));
  }

  setActive(source, active) {
    const state = this.sources.get(source);
    if (!state || state.active === Boolean(active)) return;
    this.stopTimer(state);
    state.active = Boolean(active);
    state.generation++;
    if (state.active || !state.sessionId) state.sessionId = this.makeId();
    state.sequence = 0;
    state.busy = false;
    this.announce(source);
    if (state.active && this.connected && this.monitorActive) this.startTimer(source);
  }

  restart(source) {
    const state = this.sources.get(source);
    if (!state?.active) return;
    this.setActive(source, false);
    this.setActive(source, true);
  }

  connect() {
    this.connected = true;
    for (const [source, state] of this.sources) {
      this.stopTimer(state);
      state.generation++;
      state.sessionId = this.makeId();
      state.sequence = 0;
      state.busy = false;
      this.announce(source);
      if (state.active && this.monitorActive) this.startTimer(source);
    }
  }

  setMonitorActive(active) {
    const next = Boolean(active) && this.connected;
    if (this.monitorActive === next) return;
    this.monitorActive = next;
    for (const [source, state] of this.sources) {
      this.stopTimer(state);
      state.generation++;
      state.busy = false;
      if (next) {
        state.sessionId = this.makeId();
        state.sequence = 0;
      }
      this.announce(source);
      if (next && state.active) this.startTimer(source);
    }
  }

  disconnect() {
    this.connected = false;
    this.monitorActive = false;
    for (const state of this.sources.values()) {
      this.stopTimer(state);
      state.generation++;
      state.busy = false;
    }
  }

  announce(source) {
    const state = this.sources.get(source);
    if (this.connected) this.send({ type: 'vision_source_status', source, active: state.active && this.monitorActive,
      sessionId: state.sessionId });
  }

  startTimer(source) {
    const state = this.sources.get(source);
    void this.tick(source);
    state.timer = this.setIntervalFn(() => { void this.tick(source); }, 1000);
  }

  stopTimer(state) {
    if (state.timer !== null) this.clearIntervalFn(state.timer);
    state.timer = null;
  }

  async tick(source) {
    const state = this.sources.get(source);
    if (!state?.active || !this.connected || !this.monitorActive || state.busy || !this.canSend()) return;
    const generation = state.generation;
    const capturedAt = this.now();
    state.busy = true;
    try {
      const frame = await this.capture(source);
      if (!frame || !state.active || !this.connected || !this.monitorActive || generation !== state.generation) return;
      const signature = frame.signature || await signatureFromImage(frame.image, source);
      if (!state.active || !this.connected || !this.monitorActive || generation !== state.generation || !this.canSend()) return;
      this.send({ type: 'continuous_frame', source, sessionId: state.sessionId,
        sequence: ++state.sequence, image: frame.image, signature,
        captureAgeMs: Math.max(0, this.now() - capturedAt) });
    } catch (error) {
      console.warn(`[vision:${source}] Capture failed:`, error?.message || error);
    } finally {
      if (generation === state.generation) state.busy = false;
    }
  }
}
