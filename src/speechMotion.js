// Speech gestures use authored pose curves and the audio playback clock.
// OpenAmika's emotion-bank scheduling inspired the approach; these curves are
// authored here for standard Cubism parameters, without external motion assets.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const SPEECH_HEAD_GAIN = 3.5;
const SPEECH_BODY_GAIN = 3;
const zeroPose = () => ({ headX: 0, headY: 0, headZ: 0, eyeX: 0, eyeY: 0,
  browL: 0, browR: 0, bodyX: 0, bodyY: 0, bodyZ: 0 });

export const GESTURES = ['singleNod', 'doubleNod', 'leftTilt', 'rightTilt', 'glance', 'recenterLean'];
export const MOTION_PROFILES = {
  netral: { strength: 1, pace: 1, weights: [4, 1, 2, 2, 1, 2] },
  terkejut: { strength: 1.25, pace: 1.2, weights: [3, 3, 1, 1, 1, 2] },
  marah: { strength: 1.2, pace: 1.15, weights: [5, 3, 1, 1, 1, 2] },
  bingung: { strength: 0.85, pace: 0.85, weights: [1, 1, 4, 4, 3, 1] },
  jengkel: { strength: 0.9, pace: 1, weights: [3, 1, 2, 2, 3, 2] },
  malu: { strength: 0.55, pace: 0.8, weights: [2, 1, 3, 3, 4, 2] },
  kesal: { strength: 0.65, pace: 0.9, weights: [3, 1, 2, 2, 3, 3] },
  sedih: { strength: 0.5, pace: 0.75, weights: [3, 1, 2, 2, 3, 3] },
  kagum: { strength: 1.2, pace: 1.15, weights: [3, 4, 2, 2, 1, 2] },
  sayang: { strength: 0.8, pace: 0.85, weights: [3, 1, 3, 3, 1, 3] },
  jahil: { strength: 1.15, pace: 1.1, weights: [2, 3, 4, 4, 2, 2] },
  penasaran: { strength: 0.95, pace: 0.9, weights: [2, 1, 4, 4, 3, 2] },
};

export function analyzeSpeechRhythm(buffer) {
  const step = 0.02;
  const size = Math.max(1, Math.round(buffer.sampleRate * step));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const raw = [];
  for (let start = 0; start < buffer.length; start += size) {
    const end = Math.min(buffer.length, start + size);
    let sum = 0;
    for (const channel of channels) {
      for (let i = start; i < end; i++) sum += channel[i] * channel[i];
    }
    raw.push(Math.sqrt(sum / Math.max(1, (end - start) * channels.length)));
  }
  const sorted = raw.slice().sort((a, b) => a - b);
  const reference = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const envelope = raw.map(value => reference > 0.001 ? clamp(value / reference, 0, 1) : 0);
  const events = [];
  let lastPeak = -Infinity;
  let silenceStart = null;
  let voiced = false;
  for (let i = 0; i < envelope.length; i++) {
    const time = i * step;
    const energy = envelope[i];
    if (energy > 0.12) {
      if (!voiced) events.push({ time, kind: 'onset', strength: energy });
      voiced = true;
      silenceStart = null;
    } else if (voiced) {
      silenceStart ??= time;
      if (time - silenceStart >= 0.22 && envelope[i + 1] > 0.12) {
        events.push({ time: silenceStart + 0.16, kind: 'pause', strength: 0.35 });
      }
    }
    const floor = Math.min(...envelope.slice(Math.max(0, i - 10), i + 1));
    if (energy >= 0.45 && energy >= (envelope[i - 1] ?? 0) && energy > (envelope[i + 1] ?? 0)
      && energy - floor > 0.15 && time - lastPeak >= 0.45) {
      events.push({ time, kind: 'emphasis', strength: energy });
      lastPeak = time;
    }
  }
  return { step, envelope, events: events.sort((a, b) => a.time - b.time) };
}

function energyAt(rhythm, time) {
  if (!rhythm?.envelope?.length || time < 0) return 0;
  const index = time / rhythm.step;
  const left = Math.floor(index);
  return (rhythm.envelope[left] ?? 0) * (1 - (index - left))
    + (rhythm.envelope[left + 1] ?? 0) * (index - left);
}

const BODY_KEYS = ['bodyX', 'bodyY', 'bodyZ'];
const bodyPose = (bodyX = 0, bodyY = 0, bodyZ = 0) => ({ bodyX, bodyY, bodyZ });

function bodyGestureFrames(kind, side, strength, from) {
  const direction = kind === 'leftTilt' ? -1 : kind === 'rightTilt' ? 1 : side;
  let peak, hold, settled;
  if (kind === 'singleNod' || kind === 'doubleNod') {
    peak = bodyPose(direction * 0.6, -0.8, direction * 0.2);
    hold = bodyPose(direction * 0.5, -0.55, direction * 0.2);
    settled = bodyPose(direction * 0.18, -0.1, direction * 0.1);
  } else if (kind === 'leftTilt' || kind === 'rightTilt') {
    peak = bodyPose(direction * 0.85, -0.45, direction * 1.1);
    hold = bodyPose(direction * 0.7, -0.3, direction * 1.0);
    settled = bodyPose(direction * 0.25, -0.06, direction * 0.3);
  } else if (kind === 'glance') {
    peak = bodyPose(direction * 1.1, -0.45, direction * 0.38);
    hold = bodyPose(direction * 1.0, -0.3, direction * 0.35);
    settled = bodyPose(direction * 0.3, -0.05, direction * 0.12);
  } else {
    peak = bodyPose(direction * 0.85, direction * 0.5, -direction * 0.55);
    hold = bodyPose(direction * 0.65, direction * 0.3, -direction * 0.4);
    settled = bodyPose();
  }
  const scaled = pose => Object.fromEntries(BODY_KEYS.map(key => [key, pose[key] * strength]));
  const anticipation = bodyPose(-direction * 0.1, 0.08, -direction * 0.08);
  const frames = [
    { time: 0, pose: { ...from } },
    { time: 0.12, pose: Object.fromEntries(BODY_KEYS.map(key => [key, from[key] + anticipation[key] * strength])) },
    { time: 0.48, pose: scaled(peak) },
    { time: 0.68, pose: scaled(hold) },
    { time: 1, pose: scaled(settled) },
  ];
  if (kind === 'doubleNod') {
    frames.splice(2, 2,
      { time: 0.32, pose: scaled(bodyPose(direction * 0.35, -0.6, direction * 0.18)) },
      { time: 0.46, pose: scaled(bodyPose(direction * 0.4, -0.25, direction * 0.2)) },
      { time: 0.66, pose: scaled(bodyPose(direction * 0.45, -0.8, direction * 0.24)) },
      { time: 0.8, pose: scaled(hold) });
  }
  return frames;
}

function sampleBodyGesture(gesture, time) {
  // The torso anticipates, shifts weight, holds, then settles. Its final stance
  // remains through speech gaps instead of resetting after every head gesture.
  const phase = clamp((time - gesture.start - 0.12) / (gesture.duration - 0.12), 0, 1);
  const frames = gesture.bodyFrames;
  for (let i = 1; i < frames.length; i++) {
    if (phase > frames[i].time) continue;
    const from = frames[i - 1], to = frames[i];
    const t = clamp((phase - from.time) / (to.time - from.time), 0, 1);
    const ease = t * t * (3 - 2 * t);
    return Object.fromEntries(BODY_KEYS.map(key => [key, from.pose[key] + (to.pose[key] - from.pose[key]) * ease]));
  }
  return { ...frames.at(-1).pose };
}

const FACE_KEYS = ['headX', 'headY', 'headZ', 'eyeX', 'eyeY', 'browL', 'browR'];
const facePose = (headX = 0, headY = 0, headZ = 0, eyeX = 0, eyeY = 0, brow = 0) =>
  ({ headX, headY, headZ, eyeX, eyeY, browL: brow, browR: brow });

function faceGestureFrames(kind, side, strength, from) {
  const direction = kind === 'leftTilt' ? -1 : kind === 'rightTilt' ? 1 : side;
  let peak, hold, settled;
  if (kind === 'singleNod' || kind === 'doubleNod') {
    peak = facePose(direction * 3, -9, direction * 2, direction * 0.06, -0.18, 0.1);
    hold = facePose(direction * 2.5, -5, direction * 1.5, direction * 0.04, -0.1, 0.06);
    settled = facePose(direction * 1.5, -1.2, direction * 0.8, direction * 0.03, -0.02, 0.02);
  } else if (kind === 'leftTilt' || kind === 'rightTilt') {
    peak = facePose(direction * 6, -5, direction * 10, direction * 0.28, -0.08, 0.1);
    hold = facePose(direction * 5, -3.5, direction * 8, direction * 0.2, -0.04, 0.06);
    settled = facePose(direction * 3, -0.6, direction * 3, direction * 0.1, 0, 0.02);
  } else if (kind === 'glance') {
    peak = facePose(direction * 12, -4, direction * 3, direction * 0.45, -0.15, 0.08);
    hold = facePose(direction * 10, -3, direction * 2.5, direction * 0.28, -0.08, 0.05);
    settled = facePose(direction * 3, -0.7, direction * 1.3, direction * 0.1, -0.02, 0.02);
  } else {
    peak = facePose(-direction * 5, direction * 3.5, -direction * 5, -direction * 0.12, 0, 0.06);
    hold = facePose(-direction * 3, direction * 2, -direction * 3, -direction * 0.06, 0, 0.03);
    settled = facePose();
  }
  const scaled = pose => Object.fromEntries(FACE_KEYS.map(key => [key, pose[key] * strength]));
  const frames = [
    { time: 0, pose: { ...from } },
    { time: 0.12, pose: { ...from, headY: from.headY + 0.3 * strength,
      eyeX: from.eyeX + peak.eyeX * 0.12 * strength, eyeY: from.eyeY + peak.eyeY * 0.12 * strength } },
    { time: 0.48, pose: scaled(peak) },
    { time: 0.68, pose: scaled(hold) },
    { time: 1, pose: scaled(settled) },
  ];
  if (kind === 'doubleNod') {
    frames.splice(2, 2,
      { time: 0.32, pose: scaled(peak) },
      { time: 0.46, pose: scaled(facePose(direction * 2.5, -2, direction * 1.5, direction * 0.04, -0.02, 0.04)) },
      { time: 0.66, pose: scaled(facePose(direction * 3.5, -10, direction * 2.5, direction * 0.06, -0.18, 0.1)) },
      { time: 0.8, pose: scaled(hold) });
  }
  return frames;
}

function sampleFaceGesture(gesture, time) {
  const sample = phase => {
    const frames = gesture.faceFrames;
    for (let i = 1; i < frames.length; i++) {
      if (phase > frames[i].time) continue;
      const from = frames[i - 1], to = frames[i];
      const t = clamp((phase - from.time) / (to.time - from.time), 0, 1);
      const ease = t * t * (3 - 2 * t);
      return Object.fromEntries(FACE_KEYS.map(key => [key, from.pose[key] + (to.pose[key] - from.pose[key]) * ease]));
    }
    return { ...frames.at(-1).pose };
  };
  const phase = clamp((time - gesture.start) / gesture.duration, 0, 1);
  const pose = sample(phase);
  // Eyes lead the turn; the torso follows the head on its existing delayed path.
  const gaze = sample(clamp(phase + 0.08 / gesture.duration, 0, 1));
  pose.eyeX = gaze.eyeX;
  pose.eyeY = gaze.eyeY;
  return pose;
}

function gesturePose(gesture, time) {
  return { ...sampleFaceGesture(gesture, time), ...sampleBodyGesture(gesture, time) };
}

export class SpeechMotionController {
  constructor({ random = Math.random, getOptions = () => ({}) } = {}) {
    this.random = random;
    this.getOptions = getOptions;
    this.cues = [];
    this.pose = zeroPose();
    this.lastKind = null;
    this.lastGestureEnd = -Infinity;
    this.lastGestureStart = -Infinity;
    this.lastTime = null;
    this.lastBodyPose = bodyPose();
    this.lastFacePose = facePose();
    this.lastSpeechGesture = null;
    this.lastSpeechId = null;
  }

  queue(cue) {
    if (!cue?.speechId || !Number.isFinite(cue.startAt) || !Number.isFinite(cue.endAt)
      || cue.endAt <= cue.startAt || !cue.rhythm?.envelope?.length || !(cue.rhythm.step > 0)) return false;
    if (this.cues.some(item => item.speechId === cue.speechId && item.startAt === cue.startAt)) return false;
    const profile = MOTION_PROFILES[cue.emotion] ?? MOTION_PROFILES.netral;
    const options = this.getOptions();
    const frequency = clamp(finite(options.frequency, 1), 0, 2);
    const gestures = [];
    if (this.lastSpeechId !== cue.speechId) {
      this.lastBodyPose = bodyPose();
      this.lastFacePose = facePose();
      this.lastSpeechGesture = null;
    }
    const bodyStart = { ...this.lastBodyPose };
    const faceStart = { ...this.lastFacePose };
    if (frequency > 0) {
      // A streamed audio segment may end before its gesture. Keep sampling the
      // original trajectory when the next segment belongs to the same speech.
      const tail = this.lastSpeechGesture;
      if (tail && tail.start < cue.startAt && tail.start + tail.duration > cue.startAt) gestures.push(tail);
      // Include sustained speech opportunities, so flat delivery still has varied poses.
      const events = [...(cue.rhythm.events ?? [])];
      for (let time = 0; time < cue.endAt - cue.startAt; time += 0.25) {
        if (energyAt(cue.rhythm, time) > 0.2) events.push({ time, kind: 'sustain', strength: 0.6 });
      }
      events.sort((a, b) => a.time - b.time);
      for (const event of events) {
        const start = cue.startAt + event.time;
        if (start < this.lastGestureEnd + 0.04 || start - this.lastGestureStart < Math.max(0.75, 0.95 / frequency)
          || start >= cue.endAt - 0.15 || start < cue.startAt) continue;
        const weights = profile.weights.map((weight, i) => GESTURES[i] === this.lastKind ? 0
          : weight * (event.kind === 'pause' && i >= 4 ? 3 : 1));
        let pick = this.random() * weights.reduce((sum, weight) => sum + weight, 0);
        let index = weights.findIndex(weight => { pick -= weight; return pick < 0; });
        if (index < 0) index = weights.findIndex(weight => weight > 0);
        const kind = GESTURES[index];
        const duration = clamp((0.95 + this.random() * 0.6) / profile.pace, 0.9, 1.9);
        const side = this.random() < 0.5 ? -1 : 1;
        const strength = profile.strength * (0.65 + clamp(finite(event.strength, 0.6), 0, 1) * 0.35);
        const bodyFrom = { ...this.lastBodyPose };
        const bodyFrames = bodyGestureFrames(kind, side, strength, bodyFrom);
        const faceFrom = { ...this.lastFacePose };
        const faceFrames = faceGestureFrames(kind, side, strength, faceFrom);
        gestures.push({ kind, start, duration, side, strength, bodyFrom, bodyFrames, faceFrom, faceFrames });
        this.lastBodyPose = { ...bodyFrames.at(-1).pose };
        this.lastFacePose = { ...faceFrames.at(-1).pose };
        this.lastSpeechGesture = gestures.at(-1);
        this.lastKind = kind;
        this.lastGestureStart = start;
        this.lastGestureEnd = start + duration;
      }
    }
    this.lastSpeechId = cue.speechId;
    this.cues.push({ ...cue, emotion: MOTION_PROFILES[cue.emotion] ? cue.emotion : 'netral', gestures, bodyStart, faceStart });
    this.cues.sort((a, b) => a.startAt - b.startAt);
    return true;
  }

  cancel(speechId) {
    const remaining = speechId ? this.cues.filter(cue => cue.speechId !== speechId) : [];
    if (speechId && remaining.length === this.cues.length && speechId !== this.lastSpeechId) return;
    this.cues = remaining;
    // Other speech IDs have independent origins. Cancelling a pending reply
    // must not re-author the body trajectory of a surviving active reply.
    const lastCue = this.cues.at(-1);
    this.lastBodyPose = { ...(lastCue?.gestures.at(-1)?.bodyFrames.at(-1).pose ?? lastCue?.bodyStart ?? bodyPose()) };
    this.lastFacePose = { ...(lastCue?.gestures.at(-1)?.faceFrames.at(-1).pose ?? lastCue?.faceStart ?? facePose()) };
    this.lastSpeechGesture = lastCue?.gestures.at(-1) ?? null;
    this.lastSpeechId = lastCue?.speechId ?? null;
    const gestures = this.cues.flatMap(cue => cue.gestures);
    this.lastGestureEnd = Math.max(-Infinity, ...gestures.map(gesture => gesture.start + gesture.duration));
    this.lastGestureStart = Math.max(-Infinity, ...gestures.map(gesture => gesture.start));
  }

  reset() {
    this.cancel();
    this.pose = zeroPose();
    this.lastKind = null;
    this.lastTime = null;
  }

  update(audioTime, delta) {
    const time = finite(audioTime, 0);
    const cue = this.cues.find(item => item.startAt <= time && time < item.endAt);
    const options = this.getOptions();
    const gesture = options.frequency === 0 ? null
      : cue?.gestures.find(item => item.start <= time && time < item.start + item.duration);
    const dt = this.lastTime === time && cue ? 0 : clamp(finite(delta, 0), 0, 0.1);
    const strength = clamp(finite(options.strength, 1), 0, 2);
    const smoothing = clamp(finite(options.smoothingMs, 140), 40, 600) / 1000;
    // A suspended AudioContext freezes speech motion, including smoothing.
    this.lastTime = time;
    // Integrate at 120 Hz so the larger, faster curves keep the same trajectory
    // across render rates, including frames that cross a gesture boundary.
    const steps = Math.ceil(dt * 120);
    for (let step = 0; step < steps; step++) {
      const stepDelta = dt / steps;
      const sampleTime = time - dt + (step + 0.5) * stepDelta;
      const sampledCue = this.cues.find(item => item.startAt <= sampleTime && sampleTime < item.endAt);
      const sampledGesture = options.frequency === 0 ? null
        : sampledCue?.gestures.find(item => item.start <= sampleTime && sampleTime < item.start + item.duration);
      const target = sampledGesture ? gesturePose(sampledGesture, sampleTime) : zeroPose();
      if (sampledCue && !sampledGesture && options.frequency !== 0) {
        const previous = sampledCue.gestures.filter(item => item.start + item.duration <= sampleTime).at(-1);
        Object.assign(target, previous?.bodyFrames.at(-1).pose ?? sampledCue.bodyStart);
        Object.assign(target, previous?.faceFrames.at(-1).pose ?? sampledCue.faceStart);
      }
      const alpha = 1 - Math.exp(-stepDelta / (sampledGesture ? smoothing : Math.max(smoothing, 0.24)));
      for (const key of Object.keys(this.pose)) {
        // Only speech head/body movement receives the stronger gains.
        const gain = key.startsWith('head') ? SPEECH_HEAD_GAIN : key.startsWith('body') ? SPEECH_BODY_GAIN : 1;
        const value = target[key] * strength * gain;
        this.pose[key] += (value - this.pose[key]) * alpha;
      }
    }
    this.cues = this.cues.filter(item => item.endAt > time);
    return { ...this.pose, active: Boolean(cue), emotion: cue?.emotion ?? 'netral',
      gesture: gesture?.kind ?? null, energy: cue ? energyAt(cue.rhythm, time - cue.startAt) : 0 };
  }
}

const PARAMETER_IDS = {
  headX: ['ParamAngleX'], headY: ['ParamAngleY'], headZ: ['ParamAngleZ'],
  eyeX: ['ParamEyeBallX'], eyeY: ['ParamEyeBallY'],
  browL: ['ParamBrowLAngle', 'ParamBrowLY'], browR: ['ParamBrowRAngle', 'ParamBrowRY'],
  bodyX: ['ParamBodyAngleX', 'ParamBodyX'], bodyY: ['ParamBodyAngleY', 'ParamBodyY'],
  bodyZ: ['ParamBodyAngleZ'],
};

export function resolveMotionParameters(available, physicsOutputs = new Set()) {
  return Object.fromEntries(Object.entries(PARAMETER_IDS).map(([key, ids]) =>
    [key, ids.map(id => available.get(id)).find(param => param && !physicsOutputs.has(param.id)) ?? null]));
}

export function resolveModelCapabilities(available, { blinkIds = [], wingExpressionRegistered = false } = {}) {
  const declaredBlinkIds = [...new Set(blinkIds)].filter(id => available.has(id));
  return {
    // Physics-driven torso controls still provide a rig, even when gestures
    // must leave their values to physics. Only scanned controls count.
    hasBodyRig: ['bodyX', 'bodyY', 'bodyZ'].some(key => PARAMETER_IDS[key].some(id => available.has(id))),
    blinkIds: declaredBlinkIds.length ? declaredBlinkIds
      : ['ParamEyeLOpen', 'ParamEyeROpen'].filter(id => available.has(id)),
    wingParameterIndex: wingExpressionRegistered ? available.get('Param41')?.index ?? -1 : -1,
  };
}

export function applyMotionOffsets(model, parameters, pose, idle = {}) {
  for (const [key, param] of Object.entries(parameters)) {
    if (!param || param.index < 0 || param.index >= model.getParameterCount()) continue;
    const span = param.max - param.min;
    const divisor = key.startsWith('head') ? 60 : key.startsWith('body') ? 6 : 2;
    const offset = (finite(pose[key], 0) + finite(idle[key], 0)) * span / divisor;
    const current = model.getParameterValueByIndex(param.index);
    if (![current, offset, param.min, param.max].every(Number.isFinite)) continue;
    model.setParameterValueByIndex(param.index, clamp(current + offset, param.min, param.max));
  }
}

// Coordinates are model-local. The matrix is composed before projection, so
// aspect ratio, camera framing and native overlay window bounds remain separate.
export function bodyLeanTransform(bounds, pose, strength = 1) {
  const amount = clamp(finite(strength, 1), 0, 1);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const pivotX = (bounds.minX + bounds.maxX) / 2;
  const pivotY = bounds.minY + height * 0.12;
  const angle = clamp(finite(pose.bodyZ, 0), -1, 1) * amount * 1.5 * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = clamp(finite(pose.bodyX, 0), -1, 1) * amount * width * 0.01;
  const dy = clamp(finite(pose.bodyY, 0), -1, 1) * amount * height * 0.004;
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0,
    pivotX - c * pivotX + s * pivotY + dx, pivotY - s * pivotX - c * pivotY + dy, 0, 1]);
}

export function bodyLeanMargin(bounds) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const angle = 1.5 * Math.PI / 180;
  return { x: height * 0.88 * Math.sin(angle) + width * 0.01 + width * (1 - Math.cos(angle)),
    y: width * 0.5 * Math.sin(angle) + height * 0.004 + height * (1 - Math.cos(angle)) };
}
