import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SpeechPlayback } from '../../src/speechPlayback.js';
import { SpeechMotionController, analyzeSpeechRhythm } from '../../src/speechMotion.js';
import { SpeechController } from '../speechController.js';
import { generateReplyStream } from '../llmChat.js';
import { scheduleAudioBuffer } from '../../src/audioClock.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const companion = fs.readFileSync(new URL('../../src/companion.js', import.meta.url), 'utf8');
const audioFunctions = companion.slice(companion.indexOf('async function playSentenceAudio('),
  companion.indexOf('// WebSocket:', companion.indexOf('async function playSentenceAudio(')));

function browser(decode) {
  const sources = [], events = [];
  const samples = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 0.2);
  const buffer = { duration: 1, sampleRate: 1000, length: samples.length, numberOfChannels: 1,
    getChannelData: () => samples };
  const motion = new SpeechMotionController({ random: () => 0.1 });
  const context = { currentTime: 10, state: 'running', sampleRate: 1000, decodeAudioData: decode ?? (async () => buffer),
    createBuffer(numberOfChannels, length, sampleRate) {
      return { duration: length / sampleRate, sampleRate, length, numberOfChannels };
    },
    createBufferSource() {
      const node = { connect() {}, disconnect() {}, start(time) { this.startAt = time; },
        stop() { this.stopped = true; this.onended?.(); } };
      sources.push(node);
      return node;
    } };
  const state = { audioCtx: context, analyser: {}, playCursor: 10, scheduledEmotionEnd: 0,
    activeAudioSources: new Set(), Uint8Array, analyzeSpeechRhythm, scheduleAudioBuffer, ensureAudio() {}, log() {},
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    window: { dispatchEvent(event) {
      events.push(event);
      if (event.type === 'waifu-speech-cue') motion.queue(event.detail);
      if (event.type === 'waifu-speech-cancel') motion.cancel(event.detail.speechId);
    } },
    cancelSpeechMotion(speechId) { state.window.dispatchEvent({ type: 'waifu-speech-cancel', detail: { speechId } }); },
  };
  vm.createContext(state);
  vm.runInContext(audioFunctions, state);
  return { sources, events, context, buffer, state, motion,
    finish(node) { context.currentTime = node.startAt + node.buffer.duration; node.onended?.(); },
  };
}

function queueFile(playback, speechId, emotion, segmentId, pauseBeforeMs, data = new Uint8Array([1]), pauseAfterMs = 200) {
  playback.handle({ type: 'audio_output', speechId, data });
  const boundary = { type: 'audio_end', speechId, emotion, segmentId, pauseBeforeMs, pauseAfterMs };
  playback.handle(boundary);
  return boundary;
}

test('segment boundaries snapshot metadata and apply emotions at their scheduled audio times', async () => {
  const h = browser(), finished = [];
  const playback = new SpeechPlayback({ playAudio: (chunks, emotion, options) =>
    h.state.playSentenceAudio(chunks, emotion, options), onFinished: id => finished.push(id) });
  playback.handle({ type: 'speech_start', speechId: 'reply' });
  const first = queueFile(playback, 'reply', 'kagum', 0, 0);
  // A 300 ms segment transition needs only 100 ms beyond the preceding sentence tail.
  const second = queueFile(playback, 'reply', 'sayang', 1, 100);
  queueFile(playback, 'reply', 'sayang', 1, 0);
  first.emotion = second.emotion = 'marah';
  first.pauseAfterMs = 400;
  second.pauseBeforeMs = 400;
  playback.handle({ type: 'emotion', speechId: 'reply', emotion: 'sedih' });
  playback.handle({ type: 'speech_end', speechId: 'reply' });
  await tick();
  assert.equal(h.sources[0].startAt, 10);
  assert.equal(h.motion.update(10.1, 1 / 60).emotion, 'kagum');
  assert.deepEqual(finished, []);
  h.finish(h.sources[0]);
  await tick();
  assert.equal(h.sources.length, 2, 'the next voice waits for the first sentence tail');
  assert.equal(h.sources[1].buffer.duration, 0.2, 'queued metadata cannot change the existing tail');
  h.finish(h.sources[1]);
  await tick();
  assert.ok(Math.abs(h.sources[2].startAt - 11.3) < 1e-9);
  assert.equal(h.motion.update(11.35, 1 / 60).emotion, 'sayang');
  h.finish(h.sources[2]);
  h.finish(h.sources[3]);
  await tick();
  assert.ok(Math.abs(h.sources[4].startAt - 12.5) < 1e-9);
  const cues = h.events.filter(event => event.type === 'waifu-speech-cue');
  assert.deepEqual(cues.map(event => event.detail.segmentId), [0, 1, 1]);
  assert.deepEqual(cues.map(event => event.detail.emotion), ['kagum', 'sayang', 'sayang']);
  assert.deepEqual(finished, []);
  h.finish(h.sources[4]);
  await tick();
  assert.deepEqual(finished, [], 'final playback includes its sentence tail');
  h.finish(h.sources[5]);
  await playback.chain;
  assert.deepEqual(finished, ['reply']);
  assert.equal(playback.busy, false);
});

test('cancelling during a segment pause stops the scheduled source and discards following groups', async () => {
  const h = browser(), cancelled = [];
  const playback = new SpeechPlayback({ playAudio: (chunks, emotion, options) =>
    h.state.playSentenceAudio(chunks, emotion, options), onFinished() {}, onCancelled: id => cancelled.push(id) });
  playback.handle({ type: 'speech_start', speechId: 'reply' });
  queueFile(playback, 'reply', 'sayang', 1, 150);
  queueFile(playback, 'reply', 'kagum', 2, 150);
  await tick();
  assert.equal(h.sources[0].startAt, 10.15);
  assert.equal(h.motion.update(10, 1 / 60).active, false);
  playback.handle({ type: 'stop_speech', speechId: 'reply' });
  await playback.chain;
  assert.equal(h.sources[0].stopped, true);
  assert.equal(h.sources.length, 2);
  assert.ok(h.sources.every(source => source.stopped), 'voice and scheduled sentence tail are cancelled');
  assert.equal(h.motion.cues.length, 0);
  assert.deepEqual(cancelled, ['reply']);
  assert.equal(h.state.playCursor, h.context.currentTime);
});

test('an abandoned pending decoder cannot block a new reply after reset', async t => {
  let finishOldDecode;
  let decodeCalls = 0;
  const h = browser(() => ++decodeCalls === 1
    ? new Promise(resolve => { finishOldDecode = resolve; }) : Promise.resolve(h.buffer));
  const finished = [];
  const playback = new SpeechPlayback({ playAudio: (chunks, emotion, options) =>
    h.state.playSentenceAudio(chunks, emotion, options), onFinished: id => finished.push(id) });
  t.after(() => { finishOldDecode?.(h.buffer); playback.reset(); });
  playback.handle({ type: 'speech_start', speechId: 'old' });
  queueFile(playback, 'old', 'marah', 0, 0);
  await tick();
  playback.reset();
  playback.handle({ type: 'speech_start', speechId: 'new' });
  queueFile(playback, 'new', 'sayang', 0, 0);
  playback.handle({ type: 'speech_end', speechId: 'new' });
  await tick();
  assert.equal(h.sources.length, 2);
  assert.equal(h.events.find(event => event.type === 'waifu-speech-cue').detail.speechId, 'new');
  finishOldDecode(h.buffer);
  await tick();
  assert.equal(h.sources.length, 2);
  h.finish(h.sources[0]);
  h.finish(h.sources[1]);
  await playback.chain;
  assert.deepEqual(finished, ['new']);
});

test('the parser, speech controller and playback preserve one reply ID and shared numeric segment IDs', async t => {
  const calls = [], events = [], socket = {};
  const controller = new SpeechController({ isVoiceConfigured: () => true,
    generateSpeech: async function* (text, emotion, options) {
      calls.push({ text, emotion, speechEmotion: options.speechEmotion });
      options.onAudioFormat('mp3');
      yield Buffer.from([1]);
      options.onAudioEnd();
    } });
  const played = [];
  const playback = new SpeechPlayback({ playAudio: async (chunks, emotion, options) => {
    played.push({ emotion, segmentId: options.segmentId, pauseBeforeMs: options.pauseBeforeMs,
      pauseAfterMs: options.pauseAfterMs, speechId: options.speechId });
  }, onFinished: id => queueMicrotask(() => controller.acknowledge(socket, id)) });
  controller.register(socket, event => { events.push(event); playback.handle(event); });
  t.after(() => controller.unregister(socket));
  const registry = { getSlotStatus: () => ({ available: true }),
    getTts: () => ({ params: { expression: { mergeShortSentences: { enabled: false } } } }),
    getLlm: () => ({ async *stream() { yield { type: 'text', delta: JSON.stringify({ segments: [
      { emotion: 'kagum', speechEmotion: 'excited', text: 'Wah! Kamu berhasil.' },
      { emotion: 'sayang', speechEmotion: 'compassionate', text: 'Aku ikut senang. Cerita, ya.' },
    ] }) }; } }),
  };
  const result = await controller.play({ recipients: [socket], produce: async ({ say, signal }) => {
    for await (const event of generateReplyStream([], 'Halo', null, { registry, signal })) {
      if (event.type === 'sentence') await say(event.text, event.emotion, () => {}, event);
    }
  } });
  await playback.chain;
  assert.equal(result.ok, true);
  assert.deepEqual(played.map(item => item.segmentId), [0, 0, 1, 1]);
  assert.deepEqual(played.map(item => item.pauseBeforeMs), [0, 0, 0, 0], 'the 200 ms sentence pause already exceeds the 150 ms segment pause');
  assert.deepEqual(played.map(item => item.pauseAfterMs), [200, 200, 200, 200]);
  assert.deepEqual(calls.map(item => [item.emotion, item.speechEmotion]),
    [['kagum', 'excited'], ['kagum', 'excited'], ['sayang', 'compassionate'], ['sayang', 'compassionate']]);
  assert.ok(played.every(item => item.speechId === result.speechId));
  assert.equal(events.filter(event => event.type === 'speech_start').length, 1);
  assert.equal(events.filter(event => event.type === 'speech_end').length, 1);
});

test('controller bounds transition pauses before sending playback metadata', async t => {
  const events = [], socket = {};
  const controller = new SpeechController({ isVoiceConfigured: () => true,
    generateSpeech: async function* (_text, _emotion, options) {
      options.onAudioFormat('mp3'); yield Buffer.from([1]); options.onAudioEnd();
    } });
  controller.register(socket, event => events.push(event));
  t.after(() => controller.unregister(socket));
  await controller.play({ recipients: [socket], produce: async ({ say }) => {
    await say('Halo!', 'sayang', () => {}, { segmentId: 0, pauseBeforeMs: 900 });
  } });
  const boundary = events.find(event => event.type === 'audio_end');
  assert.equal(boundary.segmentId, 0);
  assert.equal(boundary.pauseBeforeMs, 400);
});
