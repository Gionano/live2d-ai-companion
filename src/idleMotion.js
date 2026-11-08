// Authored idle poses, evaluated locally without camera frames or AI requests.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const KEYS = ['headX', 'headY', 'headZ', 'eyeX', 'eyeY', 'browL', 'browR', 'bodyX', 'bodyY', 'bodyZ'];
const zeroPose = () => Object.fromEntries(KEYS.map(key => [key, 0]));
const pose = (headX, headY, headZ, eyeX, eyeY, bodyX, bodyY, bodyZ, brow = 0) =>
  ({ headX, headY, headZ, eyeX, eyeY, bodyX, bodyY, bodyZ, browL: brow, browR: brow });
const clip = (name, duration, weight, peak, settled) => Object.freeze({ name, duration, weight,
  peak: Object.freeze(peak), settled: Object.freeze(settled) });

// Head angles use degrees; body channels use the existing normalized pose scale.
// Each variant has its own direction, rhythm, gaze and ending stance.
export const IDLE_MOTION_BANK = Object.freeze([
  clip('lookLeft', 5.6, 1.3, pose(-9, -1, -2, -0.27, 0.02, -0.38, 0.04, -0.18, 0.03),
    pose(-2, 0, -1, 0, 0, -0.12, 0, -0.06)),
  clip('lookRight', 6.1, 1.3, pose(9, -1, 2, 0.27, 0.02, 0.38, 0.04, 0.18, 0.03),
    pose(2, 0, 1, 0, 0, 0.12, 0, 0.06)),
  clip('lookUp', 4.8, 0.7, pose(1, 5, 1, 0.03, 0.15, 0.08, 0.32, 0.04, 0.04),
    pose(0, 1, 0, 0, 0.01, 0, 0.08, 0)),
  clip('lookDown', 4.5, 0.7, pose(-1, -5, 1, -0.03, -0.18, -0.08, -0.28, 0.04),
    pose(0, -1, 0, 0, 0, 0, -0.08, 0)),
  clip('tiltLeft', 6.6, 1.1, pose(-3, 1, -8, -0.06, 0, -0.45, 0.04, -0.65, 0.02),
    pose(-1, 0, -2, 0, 0, -0.14, 0, -0.15)),
  clip('tiltRight', 6.9, 1.1, pose(3, 1, 8, 0.06, 0, 0.45, 0.04, 0.65, 0.02),
    pose(1, 0, 2, 0, 0, 0.14, 0, 0.15)),
  clip('postureLeft', 7.4, 1.2, pose(-6, 2, -3, -0.08, 0.02, -0.8, 0.2, -0.25),
    pose(-2, 0, -1, 0, 0, -0.24, 0.06, -0.08)),
  clip('postureRight', 7.8, 1.2, pose(6, 2, 3, 0.08, 0.02, 0.8, 0.2, 0.25),
    pose(2, 0, 1, 0, 0, 0.24, 0.06, 0.08)),
  clip('softNod', 4.1, 0.6, pose(1, -4, 0, 0.02, -0.07, 0.08, -0.28, 0, 0.02),
    pose(0, -1, 0, 0, 0, 0, -0.06, 0)),
  clip('listenTurn', 6.3, 0.9, pose(8, -3, 2, 0.2, -0.04, 0.45, -0.3, 0.12, 0.06),
    pose(2, -1, 0, 0.02, 0, 0.12, -0.08, 0)),
  clip('slowTurnLeft', 8.6, 0.8, pose(-11, 1, -4, -0.24, 0.02, -0.5, 0.1, -0.3),
    pose(-3, 0, -1, -0.02, 0, -0.16, 0.04, -0.08)),
  clip('slowTurnRight', 8.9, 0.8, pose(11, 1, 4, 0.24, 0.02, 0.5, 0.1, 0.3),
    pose(3, 0, 1, 0.02, 0, 0.16, 0.04, 0.08)),
  clip('settleCenter', 7, 1.4, pose(-2, 2, 1, -0.03, 0.02, 0.25, 0.3, 0.08),
    pose(0, 0, 0, 0, 0, 0, 0.06, 0)),
  clip('relaxShoulders', 7.6, 1, pose(3, -2, 2, 0.04, -0.03, 0.18, -0.55, 0.18, -0.05),
    pose(1, -1, 0, 0, 0, 0.06, -0.14, 0, -0.01)),
  clip('curiousLean', 5.7, 0.8, pose(2, -2, 5, 0.12, -0.08, 0.55, -0.4, 0.35, 0.09),
    pose(0, -1, 1, 0, 0, 0.12, -0.1, 0.08, 0.01)),
]);

const mix = (from, to, amount) => Object.fromEntries(KEYS.map(key =>
  [key, finite(from[key]) + (finite(to[key]) - finite(from[key])) * amount]));
const ease = amount => amount * amount * (3 - 2 * amount);

function sampleClip(recording, time) {
  if (recording.sample) {
    const elapsed = Math.max(0, time - recording.startAt);
    const target = recording.sample(elapsed * recording.pace);
    return mix(recording.origin, mix(zeroPose(), target, recording.strength), ease(clamp(elapsed / 0.4, 0, 1)));
  }
  const phase = clamp((time - recording.startAt) / recording.duration, 0, 1);
  const frames = recording.frames;
  for (let index = 1; index < frames.length; index++) {
    const next = frames[index];
    if (phase > next.at) continue;
    const previous = frames[index - 1];
    return mix(previous.pose, next.pose, ease(clamp((phase - previous.at) / (next.at - previous.at), 0, 1)));
  }
  return { ...frames.at(-1).pose };
}

export class IdleMotionController {
  constructor({ bank = IDLE_MOTION_BANK, random = Math.random, getOptions = () => ({}) } = {}) {
    this.bank = bank;
    this.random = random;
    this.getOptions = getOptions;
    this.reset();
  }

  reset() {
    this.time = 0;
    this.nextCheckAt = 0;
    this.resumeAt = 0;
    this.current = null;
    this.lastName = null;
    this.pose = zeroPose();
    this.amount = 0;
    this.speaking = false;
  }

  choose(pace) {
    const candidates = this.bank.filter(item => item && item.weight > 0 && item.duration > 0
      && (this.bank.length === 1 || item.name !== this.lastName));
    if (!candidates.length) return;
    let remaining = clamp(finite(this.random(), 0.5), 0, 0.999999)
      * candidates.reduce((sum, item) => sum + item.weight, 0);
    const selected = candidates.find(item => { remaining -= item.weight; return remaining < 0; }) ?? candidates.at(-1);
    const origin = { ...this.pose };
    if (selected.sample) {
      this.current = { name: selected.name, startAt: this.time, duration: selected.duration / pace,
        sample: selected.sample, pace, origin, strength: this.strength };
      this.lastName = selected.name;
      return;
    }
    const peak = mix(zeroPose(), selected.peak, this.strength);
    const settled = mix(zeroPose(), selected.settled, this.strength);
    this.current = { name: selected.name, startAt: this.time, duration: selected.duration / pace,
      frames: [
        { at: 0, pose: origin },
        { at: 0.16, pose: mix(origin, peak, 0.12) },
        { at: 0.42, pose: peak },
        { at: 0.68, pose: mix(peak, settled, 0.18) },
        { at: 1, pose: settled },
      ] };
    this.lastName = selected.name;
  }

  update(delta, { speaking = false, enabled = true } = {}) {
    const options = this.getOptions();
    const strength = enabled ? clamp(finite(options.strength, 1), 0, 2) : 0;
    const pace = clamp(finite(options.pace, 1), 0.5, 2);
    const dt = clamp(finite(delta), 0, 0.1);
    // Integrate on the same local 120 Hz clock at either renderer frame rate.
    const steps = Math.ceil(dt * 120);
    for (let step = 0; step < steps; step++) {
      const stepDelta = dt / steps;
      this.time += stepDelta;
      if (speaking) {
        this.resumeAt = this.time + 0.4;
        this.nextCheckAt = this.resumeAt;
        this.current = null;
      }
      if (strength !== this.strength) {
        this.strength = strength;
        // Start from the visible pose when a tuning change rescales a clip.
        this.current = null;
      }
      const allowed = !speaking && this.time + 1e-8 >= this.resumeAt && strength > 0;
      if (this.time + 1e-8 >= this.nextCheckAt) {
        this.nextCheckAt += Math.max(1, Math.floor((this.time - this.nextCheckAt + 1e-8) / 0.3) + 1) * 0.3;
        if (allowed && (!this.current || this.time + 1e-8 >= this.current.startAt + this.current.duration)) this.choose(pace);
      }
      const target = allowed && this.current ? sampleClip(this.current, this.time) : zeroPose();
      const alpha = 1 - Math.exp(-stepDelta / (allowed ? 0.12 : 0.16));
      this.pose = mix(this.pose, target, alpha);
      const amount = allowed && this.current ? Math.min(1, strength) : 0;
      this.amount += (amount - this.amount) * alpha;
    }
    this.speaking = Boolean(speaking);
    return { ...this.pose, active: this.amount > 0.001, motion: this.current?.name ?? null,
      trackingWeight: 1 - this.amount * 0.75 };
  }
}

export function composeIdlePose(tracking = {}, bank = {}) {
  const weight = clamp(finite(bank.trackingWeight, 1), 0, 1);
  return Object.fromEntries(KEYS.map(key => [key, finite(bank[key]) + finite(tracking[key]) * weight]));
}

// Physics-controlled torso channels receive only an additive base before physics.
// Their regular speech-follow controller keeps its own gains and smoothing.
export function applyIdlePhysicsBodyOffsets(model, parameters = {}, bank = {}) {
  for (const key of ['bodyX', 'bodyY', 'bodyZ']) {
    const parameter = parameters[key]?.body;
    if (!parameter || !Number.isInteger(parameter.index) || parameter.index < 0
      || parameter.index >= model.getParameterCount() || ![parameter.min, parameter.max].every(Number.isFinite)
      || parameter.min >= parameter.max) continue;
    const current = model.getParameterValueByIndex(parameter.index);
    if (!Number.isFinite(current)) continue;
    const range = key === 'bodyZ' ? 10 : 20;
    const center = clamp(finite(parameter.defaultValue), parameter.min, parameter.max);
    model.setParameterValueByIndex(parameter.index, clamp(current + finite(bank[key]) * 5,
      Math.max(parameter.min, center - range), Math.min(parameter.max, center + range)));
  }
}
