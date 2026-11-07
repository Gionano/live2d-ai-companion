import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSpeechRhythm, SpeechMotionController, MOTION_PROFILES, GESTURES,
  resolveMotionParameters, applyMotionOffsets, bodyLeanTransform, bodyLeanMargin } from '../../src/speechMotion.js';
import { EMOTION_MAP } from '../../src/expressionMap.js';

function audio(duration, amplitude = () => 0) {
  const sampleRate = 1000;
  const samples = Float32Array.from({ length: duration * sampleRate }, (_, i) =>
    Math.sin(i * Math.PI * 0.17) * amplitude(i / sampleRate));
  return { sampleRate, length: samples.length, numberOfChannels: 1, duration, getChannelData: () => samples };
}

const rhythm = (duration = 12) => ({ step: 0.02, envelope: Array(duration * 50).fill(0.7),
  events: Array.from({ length: duration }, (_, time) => ({ time, kind: 'emphasis', strength: 0.9 })) });
const cue = (speechId = 'speech', startAt = 5, emotion = 'netral') =>
  ({ speechId, startAt, endAt: startAt + 12, emotion, rhythm: rhythm() });
const controller = (options = {}) => new SpeechMotionController({ random: () => 0.1, ...options });
const bodyKeys = ['bodyX', 'bodyY', 'bodyZ'];
const zeroBody = { bodyX: 0, bodyY: 0, bodyZ: 0 };
const bodyOf = pose => Object.fromEntries(bodyKeys.map(key => [key, pose[key]]));
const bodyMagnitude = pose => Math.hypot(...bodyKeys.map(key => pose[key]));
const movementGain = key => key.startsWith('head') ? 3.5 : key.startsWith('body') ? 3 : 1;
const oneGestureCue = (speechId = 'speech', startAt = 0, emotion = 'netral') => ({
  speechId, startAt, endAt: startAt + 4, emotion,
  rhythm: { step: 0.02, envelope: Array(200).fill(0.1), events: [{ time: 0, kind: 'emphasis', strength: 1 }] },
});

function chosenGesture(kind, emotion = 'netral', options = {}) {
  const profile = MOTION_PROFILES[emotion];
  const index = GESTURES.indexOf(kind);
  const pick = (profile.weights.slice(0, index).reduce((sum, weight) => sum + weight, 0)
    + profile.weights[index] / 2) / profile.weights.reduce((sum, weight) => sum + weight, 0);
  const randomValues = [pick, 0.4, 0.75];
  let calls = 0;
  const motion = new SpeechMotionController({ random: () => randomValues[calls++ % 3], ...options });
  motion.queue(oneGestureCue('speech', 0, emotion));
  return { motion, randomCalls: () => calls };
}

test('PCM rhythm finds emphasis and internal pauses independently of mouth settings', () => {
  const input = audio(4, time => time < 0.4 || time > 1.3 && time < 1.8 ? 0
    : 0.1 + 0.4 * Math.sin(time * Math.PI * 4) ** 8);
  const result = analyzeSpeechRhythm(input);
  assert.ok(result.events.some(event => event.kind === 'onset' && event.time >= 0.4));
  assert.ok(result.events.some(event => event.kind === 'emphasis'));
  assert.ok(result.events.some(event => event.kind === 'pause' && event.time > 1.3 && event.time < 1.8));
  assert.ok(result.envelope.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  const louder = audio(4, time => (time < 0.4 || time > 1.3 && time < 1.8 ? 0
    : 0.1 + 0.4 * Math.sin(time * Math.PI * 4) ** 8) * 1.8);
  const amplified = analyzeSpeechRhythm(louder);
  assert.deepEqual(amplified.events.map(event => [event.kind, event.time]), result.events.map(event => [event.kind, event.time]));
});

test('silent audio stays still and empty buffers yield no gesture events', () => {
  for (const input of [audio(3), audio(0)]) {
    const result = analyzeSpeechRhythm(input);
    assert.equal(result.events.length, 0);
    const motion = controller();
    motion.queue({ ...cue(), rhythm: result });
    assert.equal(motion.cues[0]?.gestures.length ?? 0, 0);
  }
});

test('queued sentence emotion and gestures activate only at playback start', () => {
  const motion = controller();
  assert.equal(motion.queue(cue()), true);
  motion.queue(cue('later', 20, 'sedih'));
  assert.equal(motion.queue(cue()), false);
  assert.equal(motion.update(4.9, 1 / 60).active, false);
  const current = motion.update(5.5, 1 / 60);
  assert.equal(current.emotion, 'netral');
  assert.ok(current.gesture);
  assert.notEqual(current.headY, 0);
  assert.equal(motion.update(20.5, 1 / 60).emotion, 'sedih');
  assert.equal(motion.update(33, 1 / 60).active, false);
});

test('all existing emotions have banks; clips vary with no overlap or rapid starts', () => {
  assert.deepEqual(Object.keys(MOTION_PROFILES).sort(), Object.keys(EMOTION_MAP).sort());
  for (const emotion of Object.keys(MOTION_PROFILES)) {
    const motion = controller();
    motion.queue(cue('speech', 0, emotion));
    const gestures = motion.cues[0].gestures;
    assert.ok(gestures.length >= 3);
    gestures.forEach((gesture, i) => {
      assert.ok(GESTURES.includes(gesture.kind));
      assert.ok(gesture.duration >= 0.9 && gesture.duration <= 1.9);
      assert.deepEqual(gesture.bodyFrom, i ? gestures[i - 1].bodyFrames.at(-1).pose : motion.cues[0].bodyStart);
      if (!i) return;
      const previous = gestures[i - 1];
      assert.notEqual(gesture.kind, previous.kind);
      assert.ok(gesture.start - previous.start >= 0.75);
      assert.ok(gesture.start >= previous.start + previous.duration);
    });
  }
});

test('quiet delivery moves less than energetic delivery', () => {
  function peak(emotion) {
    const motion = new SpeechMotionController({ random: () => 0 });
    motion.queue(cue('speech', 0, emotion));
    let max = 0;
    for (let i = 0; i < 180; i++) max = Math.max(max, Math.abs(motion.update(i / 60, 1 / 60).headY));
    return max;
  }
  assert.ok(peak('kagum') > peak('sedih') * 1.5);
  function bodyPeak(emotion) {
    const { motion } = chosenGesture('singleNod', emotion);
    let max = 0;
    for (let i = 1; i <= 240; i++) max = Math.max(max, bodyMagnitude(motion.update(i / 60, 1 / 60)));
    return max;
  }
  assert.ok(bodyPeak('kagum') > bodyPeak('sedih') * 1.5);
});

test('all six gestures have distinct delayed body paths and authored settled postures', () => {
  const traces = [];
  for (const kind of GESTURES) {
    const { motion, randomCalls } = chosenGesture(kind);
    const gesture = motion.cues[0].gestures[0];
    assert.equal(gesture.kind, kind);
    assert.equal(randomCalls(), 3, 'body authoring must not consume extra gesture random draws');
    assert.equal(gesture.start, 0);
    assert.equal(gesture.duration, 0.95 + 0.4 * 0.6);
    assert.equal(gesture.side, 1);
    assert.deepEqual(gesture.bodyFrom, zeroBody);
    assert.ok(gesture.bodyFrames.length >= 4);
    assert.equal(gesture.bodyFrames[0].time, 0);
    assert.equal(gesture.bodyFrames.at(-1).time, 1);
    gesture.bodyFrames.forEach((frame, index) => {
      assert.ok(frame.time >= 0 && frame.time <= 1);
      assert.ok(bodyKeys.every(key => Number.isFinite(frame.pose[key]) && Math.abs(frame.pose[key]) <= 1.5));
      if (index) assert.ok(frame.time > gesture.bodyFrames[index - 1].time);
    });
    const early = motion.update(0.08, 1 / 60);
    assert.deepEqual(bodyOf(early), zeroBody);
    assert.ok(Math.abs(early.headY) + Math.abs(early.eyeX) + Math.abs(early.eyeY) > 0);
    const trace = [];
    for (let i = 6; i <= 120; i++) {
      const pose = motion.update(i / 60, 1 / 60);
      trace.push(bodyKeys.map(key => +pose[key].toFixed(4)));
    }
    assert.ok(trace.some(values => Math.hypot(...values) > 0.2), kind);
    traces.push(JSON.stringify(trace));
    if (kind === 'recenterLean') assert.deepEqual(gesture.bodyFrames.at(-1).pose, zeroBody);
    else assert.ok(bodyMagnitude(gesture.bodyFrames.at(-1).pose) > 0.05);
  }
  assert.equal(new Set(traces).size, GESTURES.length, 'single and double nods must also have different body paths');
});

test('active speech gaps hold coordinated head, gaze and torso postures', () => {
  const { motion } = chosenGesture('singleNod');
  const settled = motion.cues[0].gestures[0].bodyFrames.at(-1).pose;
  let earlier, pose;
  for (let i = 1; i <= 228; i++) {
    pose = motion.update(i / 60, 1 / 60);
    if (i === 168) earlier = pose;
  }
  assert.equal(pose.active, true);
  assert.equal(pose.gesture, null);
  assert.ok(bodyMagnitude(pose) > 0.05);
  for (const key of bodyKeys) {
    assert.ok(Math.abs(pose[key] - settled[key] * movementGain(key)) < 0.001);
    assert.ok(Math.abs(pose[key] - earlier[key]) < 0.02);
  }
  const faceSettled = motion.cues[0].gestures[0].faceFrames.at(-1).pose;
  assert.ok(Math.abs(pose.headX) + Math.abs(pose.headY) + Math.abs(pose.headZ) > 1);
  for (const key of ['headX', 'headY', 'headZ', 'eyeX', 'eyeY', 'browL', 'browR']) {
    assert.ok(Math.abs(pose[key] - faceSettled[key] * movementGain(key)) < 0.001, key);
  }
});

test('face trajectories carry between gestures and streamed segments without restarting at center', () => {
  const motion = controller();
  motion.queue(cue('speech', 0));
  const gestures = motion.cues[0].gestures;
  for (let i = 1; i < gestures.length; i++) {
    assert.deepEqual(gestures[i].faceFrom, gestures[i - 1].faceFrames.at(-1).pose);
    assert.deepEqual(gestures[i].faceFrames[0].pose, gestures[i].faceFrom);
  }
  const settled = gestures.at(-1).faceFrames.at(-1).pose;
  motion.queue(cue('speech', 12));
  assert.deepEqual(motion.cues[1].faceStart, settled);
  const firstNew = motion.cues[1].gestures.find(gesture => gesture.start >= 12);
  assert.deepEqual(firstNew.faceFrom, settled);
  if (motion.cues[1].gestures[0].start < 12) assert.equal(motion.cues[1].gestures[0], gestures.at(-1));
  motion.queue(cue('other', 24));
  assert.ok(Object.values(motion.cues[2].faceStart).every(value => value === 0));

  motion.cancel('other');
  assert.deepEqual(motion.lastFacePose, motion.cues[1].gestures.at(-1).faceFrames.at(-1).pose);
  motion.cancel();
  assert.ok(Object.values(motion.lastFacePose).every(value => value === 0));
});

test('short same-speech segments continue unfinished gestures even when queued after expiry', () => {
  const shortCue = startAt => ({ ...oneGestureCue('speech', startAt), endAt: startAt + 0.8 });
  for (const late of [false, true]) {
    const continuous = controller();
    continuous.queue(oneGestureCue());
    const segmented = controller();
    segmented.queue(shortCue(0));
    const original = segmented.cues[0].gestures[0];
    if (!late) segmented.queue(shortCue(0.8));
    for (let frame = 1; frame <= 47; frame++) {
      segmented.update(frame / 60, 1 / 60);
      continuous.update(frame / 60, 1 / 60);
    }
    if (late) {
      segmented.update(0.8, 0);
      continuous.update(0.8, 0);
      assert.equal(segmented.cues.length, 0);
      segmented.queue(shortCue(0.8));
    }
    assert.equal(segmented.cues.at(-1).gestures[0], original);
    for (let frame = 48; frame <= 70; frame++) {
      const actual = segmented.update(frame / 60, 1 / 60);
      const expected = continuous.update(frame / 60, 1 / 60);
      assert.equal(actual.gesture, expected.gesture);
      for (const key of ['headX', 'headY', 'headZ', 'eyeX', 'eyeY', ...bodyKeys]) {
        assert.ok(Math.abs(actual[key] - expected[key]) < 1e-8, `${key}, late=${late}`);
      }
    }
    segmented.cancel('speech');
    assert.equal(segmented.lastSpeechGesture, null);
    segmented.queue(shortCue(2));
    assert.equal(segmented.cues[0].gestures[0].start, 2);
    assert.ok(Object.values(segmented.cues[0].faceStart).every(value => value === 0));
  }
  const expired = controller();
  expired.queue(shortCue(0));
  expired.update(0.8, 1 / 60);
  expired.cancel('speech');
  assert.equal(expired.lastSpeechGesture, null);
  expired.queue(shortCue(0.8));
  assert.equal(expired.cues[0].gestures[0].start, 0.8);
});

test('each gesture has a distinct bounded face path and recentering releases the held pose', () => {
  const traces = [];
  for (const kind of GESTURES) {
    const { motion } = chosenGesture(kind);
    const frames = motion.cues[0].gestures[0].faceFrames;
    traces.push(JSON.stringify(frames.map(frame => frame.pose)));
    for (const frame of frames) {
      assert.ok(['headX', 'headY', 'headZ'].every(key => Math.abs(frame.pose[key]) <= 12));
      assert.ok(['eyeX', 'eyeY'].every(key => Math.abs(frame.pose[key]) <= 0.45));
    }
    let pose;
    for (let i = 1; i <= 228; i++) pose = motion.update(i / 60, 1 / 60);
    const magnitude = Math.hypot(pose.headX, pose.headY, pose.headZ);
    if (kind === 'recenterLean') assert.ok(magnitude < 0.01);
    else assert.ok(magnitude > 1, kind);
  }
  assert.equal(new Set(traces).size, GESTURES.length);
});

test('same-speech segments carry settled posture, including segments queued after expiry', () => {
  const { motion } = chosenGesture('singleNod');
  const settled = motion.cues[0].gestures[0].bodyFrames.at(-1).pose;
  const next = oneGestureCue('speech', 4);
  next.rhythm.events = [];
  motion.queue(next);
  assert.equal(motion.cues[1].gestures.length, 0);
  assert.deepEqual(motion.cues[1].bodyStart, settled);
  const faceSettled = motion.cues[0].gestures[0].faceFrames.at(-1).pose;
  assert.deepEqual(motion.cues[1].faceStart, faceSettled);
  for (let i = 1; i <= 390; i++) motion.update(i / 60, 1 / 60);
  const held = motion.update(6.52, 1 / 60);
  assert.equal(held.active, true);
  assert.equal(held.gesture, null);
  for (const key of bodyKeys) assert.ok(Math.abs(held[key] - settled[key] * movementGain(key)) < 0.001);
  for (const key of Object.keys(faceSettled)) assert.ok(Math.abs(held[key] - faceSettled[key] * movementGain(key)) < 0.001);
  motion.queue(oneGestureCue('other', 8));
  assert.deepEqual(motion.cues.at(-1).bodyStart, zeroBody);
  assert.deepEqual(motion.cues.at(-1).gestures[0].bodyFrom, zeroBody);

  const delayed = chosenGesture('singleNod').motion;
  for (let i = 1; i <= 240; i++) delayed.update(i / 60, 1 / 60);
  assert.equal(delayed.cues.length, 0);
  delayed.queue(next);
  assert.deepEqual(delayed.cues[0].bodyStart, settled);
  assert.deepEqual(delayed.cues[0].faceStart, faceSettled);
});

test('cancelling other pending speech preserves active body origins, paths and gesture timing', () => {
  const { motion, randomCalls } = chosenGesture('singleNod');
  motion.queue(oneGestureCue('speech', 4));
  motion.queue(oneGestureCue('other', 8));
  let pose;
  for (let i = 1; i <= 270; i++) pose = motion.update(i / 60, 1 / 60);
  const remaining = motion.cues.find(item => item.speechId === 'speech');
  assert.ok(bodyMagnitude(remaining.bodyStart) > 0.05);
  const before = structuredClone(remaining);
  const calls = randomCalls();
  motion.cancel('other');
  assert.deepEqual(motion.cues.map(item => item.speechId), ['speech']);
  assert.deepEqual(remaining.bodyStart, before.bodyStart);
  assert.deepEqual(remaining.gestures, before.gestures);
  assert.deepEqual(remaining, before);
  assert.deepEqual(motion.lastBodyPose, before.gestures.at(-1).bodyFrames.at(-1).pose);
  assert.equal(motion.lastSpeechId, 'speech');
  assert.equal(randomCalls(), calls);
  assert.deepEqual(motion.update(4.5, 0.1), pose);
  motion.reset();
  motion.queue(oneGestureCue('speech', 10));
  assert.deepEqual(motion.cues[0].bodyStart, zeroBody);
  assert.deepEqual(motion.cues[0].gestures[0].bodyFrom, zeroBody);
  assert.deepEqual(bodyOf(motion.update(10, 1 / 60)), zeroBody);
  const cancelled = chosenGesture('singleNod').motion;
  cancelled.cancel('speech');
  cancelled.queue(oneGestureCue('speech', 10));
  assert.deepEqual(cancelled.cues[0].bodyStart, zeroBody);
  assert.deepEqual(cancelled.cues[0].gestures[0].bodyFrom, zeroBody);
});

test('unknown cancellation preserves an active segment after its same-speech predecessor expires', () => {
  const { motion, randomCalls } = chosenGesture('singleNod');
  motion.queue(oneGestureCue('speech', 4));
  let pose;
  for (let i = 1; i <= 270; i++) pose = motion.update(i / 60, 1 / 60);
  assert.equal(motion.cues.length, 1);
  assert.equal(motion.cues[0].startAt, 4);
  assert.ok(bodyMagnitude(motion.cues[0].bodyStart) > 0.05);
  const before = structuredClone({
    cues: motion.cues, carry: motion.lastBodyPose, speechId: motion.lastSpeechId,
    kind: motion.lastKind, start: motion.lastGestureStart, end: motion.lastGestureEnd,
  });
  const calls = randomCalls();
  motion.cancel('unknown-speech');
  assert.deepEqual(motion.cues, before.cues);
  assert.deepEqual(motion.lastBodyPose, before.carry);
  assert.equal(motion.lastSpeechId, before.speechId);
  assert.equal(motion.lastKind, before.kind);
  assert.equal(motion.lastGestureStart, before.start);
  assert.equal(motion.lastGestureEnd, before.end);
  assert.equal(randomCalls(), calls);
  assert.deepEqual(motion.update(4.5, 0.1), pose);
  motion.queue(oneGestureCue('speech', 8));
  assert.deepEqual(motion.cues.at(-1).bodyStart, before.carry);
});

test('held face and body posture fade smoothly at playback end, cancellation and zero frequency', () => {
  for (const reason of ['end', 'cancel', 'frequency']) {
    const options = { frequency: 1 };
    const { motion } = chosenGesture('singleNod', 'netral', { getOptions: () => options });
    let pose;
    for (let i = 1; i <= 228; i++) pose = motion.update(i / 60, 1 / 60);
    const before = bodyMagnitude(pose);
    const faceMagnitude = pose => Math.hypot(pose.headX, pose.headY, pose.headZ, pose.eyeX, pose.eyeY);
    const faceBefore = faceMagnitude(pose);
    assert.ok(before > 0.05);
    const stopAt = reason === 'end' ? 4 : 3.82;
    if (reason === 'cancel') motion.cancel('speech');
    if (reason === 'frequency') options.frequency = 0;
    pose = motion.update(stopAt, 1 / 60);
    assert.ok(bodyMagnitude(pose) > 0 && bodyMagnitude(pose) < before, reason);
    assert.ok(faceMagnitude(pose) > 0 && faceMagnitude(pose) < faceBefore, reason);
    assert.equal(pose.gesture, null);
    let previous = bodyMagnitude(pose);
    let facePrevious = faceMagnitude(pose);
    for (let i = 1; i <= 120; i++) {
      pose = motion.update(stopAt + i / 60, 1 / 60);
      assert.ok(bodyMagnitude(pose) <= previous + 1e-10, reason);
      assert.ok(faceMagnitude(pose) <= facePrevious + 1e-10, reason);
      previous = bodyMagnitude(pose);
      facePrevious = faceMagnitude(pose);
    }
    assert.ok(bodyMagnitude(pose) < before * 0.001, reason);
    assert.ok(faceMagnitude(pose) < faceBefore * 0.001, reason);
  }
});

test('30 and 60 FPS preserve gesture timing and comparable smoothed poses', () => {
  function sample(fps) {
    const motion = controller();
    motion.queue(cue('speech', 0));
    const frames = [];
    for (let i = 1; i <= fps * 10; i++) {
      const pose = motion.update(i / fps, 1 / fps);
      if (i % (fps / 10) === 0) frames.push(pose);
    }
    return frames;
  }
  const low = sample(30), high = sample(60);
  low.forEach((pose, i) => {
    assert.equal(pose.gesture, high[i].gesture);
    for (const key of ['headX', 'headY', 'headZ', 'eyeX', ...bodyKeys]) {
      assert.ok(Number.isFinite(pose[key]) && Number.isFinite(high[i][key]));
      const tolerance = key.startsWith('body') ? 0.1 : 0.25;
      assert.ok(Math.abs(pose[key] - high[i][key]) < tolerance, `${key} at ${i / 10}`);
      if (key.startsWith('body')) assert.ok(Math.abs(pose[key]) <= 4.5 && Math.abs(high[i][key]) <= 4.5);
    }
  });
});

test('cue boundaries retain the preceding pose until its playback actually ends at either frame rate', () => {
  function sample(fps, queuedSilence) {
    const { motion } = chosenGesture('leftTilt');
    motion.cues[0].endAt = 2;
    if (queuedSilence) motion.queue({ ...oneGestureCue('other', 2),
      rhythm: { step: 0.02, envelope: Array(200).fill(0), events: [] } });
    let pose;
    for (let frame = 1; frame <= fps * 2; frame++) pose = motion.update(frame / fps, 1 / fps);
    return pose;
  }
  const low = sample(30, true);
  const high = sample(60, true);
  const noNext = sample(30, false);
  assert.ok(Math.abs(low.headZ) > 5, 'the held pose must not fade over a frame preceding the boundary');
  for (const key of ['headX', 'headY', 'headZ', 'eyeX', 'eyeY', ...bodyKeys]) {
    assert.ok(Math.abs(low[key] - high[key]) < 0.001, key);
    assert.ok(Math.abs(low[key] - noNext[key]) < 0.001, key);
  }
  assert.equal(low.active, true);
  assert.equal(noNext.active, false);
});

test('gaze leads the head and body follows; suspending audio freezes the speech pose', () => {
  const motion = controller();
  motion.queue(cue('speech', 0));
  const pose = motion.update(0.04, 1 / 60);
  assert.ok(Math.abs(pose.eyeY) > 0);
  assert.equal(pose.bodyY, 0);
  assert.deepEqual(motion.update(0.04, 0.1), pose);
});

test('cancellation fades the current pose and removes queued cues; reset clears a switched model', () => {
  const motion = controller();
  motion.queue(cue('first', 0));
  motion.queue(cue('second', 20));
  let pose;
  for (let i = 0; i <= 30; i++) pose = motion.update(i / 60, 1 / 60);
  motion.cancel('first');
  const next = motion.update(0.52, 1 / 60);
  assert.equal(next.active, false);
  assert.ok(Math.abs(next.headY) > 0 && Math.abs(next.headY) < Math.abs(pose.headY));
  assert.deepEqual(motion.cues.map(item => item.speechId), ['second']);
  for (let i = 1; i <= 120; i++) pose = motion.update(0.52 + i / 60, 1 / 60);
  assert.ok(Math.abs(pose.headY) < 0.01);
  motion.reset();
  assert.equal(motion.cues.length, 0);
  assert.equal(motion.update(20.5, 1 / 60).headY, 0);
});

test('live strength and frequency settings can disable speech gestures', () => {
  const motion = controller({ getOptions: () => ({ frequency: 0 }) });
  motion.queue(cue());
  assert.equal(motion.cues[0].gestures.length, 0);
  const muted = controller({ getOptions: () => ({ strength: 0 }) });
  muted.queue(cue());
  assert.equal(muted.update(5.5, 1 / 60).headY, 0);
  const options = { frequency: 1 };
  const live = controller({ getOptions: () => options });
  live.queue(cue());
  const active = live.update(5.5, 1 / 60);
  options.frequency = 0;
  const stopped = live.update(5.52, 1 / 60);
  assert.equal(stopped.gesture, null);
  assert.ok(Math.abs(stopped.headY) < Math.abs(active.headY));
});

test('only real rig controls are written, physics outputs and mouth are preserved, and offsets clamp', () => {
  const values = [29, 0.6, 1];
  const writes = [];
  const model = { getParameterCount: () => values.length,
    getParameterValueByIndex: i => values[i], setParameterValueByIndex: (i, value) => { values[i] = value; writes.push(i); } };
  const available = new Map([
    ['ParamAngleX', { id: 'ParamAngleX', index: 0, min: -30, max: 30 }],
    ['ParamMouthOpenY', { id: 'ParamMouthOpenY', index: 1, min: 0, max: 1 }],
    ['ParamBrowLAngle', { id: 'ParamBrowLAngle', index: 2, min: -1, max: 1 }],
  ]);
  const parameters = resolveMotionParameters(available, new Set(['ParamBrowLAngle']));
  assert.equal(parameters.bodyX, null);
  assert.equal(parameters.browL, null);
  applyMotionOffsets(model, parameters, { headX: 1000, bodyX: 20, browL: 1 });
  assert.deepEqual(values, [30, 0.6, 1]);
  assert.deepEqual(writes, [0]);
  applyMotionOffsets(model, { bodyX: { index: 50, min: -1, max: 1 } }, { bodyX: 1 });
  assert.deepEqual(writes, [0]);
  assert.ok(values.every(Number.isFinite));
});

test('torso aliases resolve to the actual rig and finite inputs cannot introduce NaN', () => {
  const available = new Map([['ParamBodyAngleZ', { id: 'ParamBodyAngleZ', index: 0, min: -10, max: 10 }]]);
  const parameters = resolveMotionParameters(available);
  let value = 0;
  const model = { getParameterCount: () => 1, getParameterValueByIndex: () => value,
    setParameterValueByIndex: (_, next) => { value = next; } };
  applyMotionOffsets(model, parameters, { bodyZ: Infinity });
  assert.equal(value, 0);
  applyMotionOffsets(model, parameters, { bodyZ: 1 });
  assert.ok(value > 0 && value <= 10);
});

test('bounded model lean stays inside fixed margins for portrait and wing presets', () => {
  for (const bounds of [{ minX: -0.5, maxX: 0.5, minY: -0.2, maxY: 0.65 },
    { minX: -0.25, maxX: 0.25, minY: -0.2, maxY: 0.65 }]) {
    const margin = bodyLeanMargin(bounds);
    for (const side of [-1, 1]) {
      const matrix = bodyLeanTransform(bounds, { bodyX: side * 100, bodyY: side * 100, bodyZ: side * 100 });
      assert.ok(Math.abs(Math.atan2(matrix[1], matrix[0])) <= 1.5 * Math.PI / 180 + 1e-7);
      for (const x of [bounds.minX, bounds.maxX]) for (const y of [bounds.minY, bounds.maxY]) {
        const px = matrix[0] * x + matrix[4] * y + matrix[12];
        const py = matrix[1] * x + matrix[5] * y + matrix[13];
        assert.ok(px >= bounds.minX - margin.x && px <= bounds.maxX + margin.x);
        assert.ok(py >= bounds.minY - margin.y && py <= bounds.maxY + margin.y);
      }
    }
    const disabled = bodyLeanTransform(bounds, { bodyZ: 1, bodyX: 1 }, 0);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    assert.ok(disabled.every((value, i) => Math.abs(value - identity[i]) < 1e-7));
  }
});
