import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { analyzeSpeechRhythm, SpeechMotionController } from '../../src/speechMotion.js';
import { SpeechPlayback } from '../../src/speechPlayback.js';
import { scheduleAudioBuffer } from '../../src/audioClock.js';

const source = fs.readFileSync(new URL('../../src/companion.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('async function playSentenceAudio('), source.indexOf('// WebSocket:', source.indexOf('async function playSentenceAudio(')));

test('the real parameter scanner supports the installed Cubism string ID API', () => {
  const modelSource = fs.readFileSync(new URL('../../src/live2dCompanion.js', import.meta.url), 'utf8');
  const method = modelSource.slice(modelSource.indexOf('  scanParameters() {'), modelSource.indexOf('  hasParameter(id)'));
  const context = vm.createContext({ console: { log() {} } });
  vm.runInContext(`class Scanner { ${method} }; globalThis.Scanner = Scanner;`, context);
  const scanner = new context.Scanner();
  scanner.availableParams = new Map();
  const ids = ['ParamAngleX', 'ParamMouthOpenY', 'ParamBreath'];
  scanner._model = { getParameterCount: () => ids.length,
    getParameterId: i => ({ getString: () => ids[i] }),
    getParameterMinimumValue: () => -1, getParameterMaximumValue: () => 1,
    getParameterDefaultValue: () => 0 };
  scanner.scanParameters();
  assert.equal(scanner.availableParams.size, 3);
  assert.equal(scanner.availableParams.get('ParamAngleX').index, 0);
  assert.equal(scanner.availableParams.get('ParamMouthOpenY').index, 1);
});

function browser({ decode, startError = false } = {}) {
  const events = [], sources = [];
  const samples = Float32Array.from({ length: 2000 }, (_, i) => Math.sin(i) * 0.2);
  const buffer = { duration: 2, sampleRate: 1000, length: samples.length, numberOfChannels: 1, getChannelData: () => samples };
  const context = { currentTime: 10, state: 'running', sampleRate: 1000, decodeAudioData: decode ?? (async () => buffer),
    createBuffer(numberOfChannels, length, sampleRate) {
      const channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
      return { duration: length / sampleRate, sampleRate, length, numberOfChannels,
        getChannelData: channel => channels[channel] };
    },
    createBufferSource() {
      const node = { connect() {}, disconnect() {}, start(time) { if (startError) throw new Error('start failed'); this.startAt = time; },
        stop() { this.stopped = true; this.onended?.(); } };
      sources.push(node);
      return node;
    } };
  const motion = new SpeechMotionController({ random: () => 0.1 });
  const state = { audioCtx: context, analyser: {}, playCursor: 11, scheduledEmotionEnd: 0,
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
  vm.runInContext(functions, state);
  return { state, context, buffer, events, sources, motion };
}

test('decoded audio publishes scheduled rhythm with speech ID and its actual playback times', async () => {
  const h = browser();
  const played = h.state.playSentenceAudio([new Uint8Array([1, 2])], 'sedih', { speechId: 'a' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sources[0].startAt, 11);
  const event = h.events.find(item => item.type === 'waifu-speech-cue');
  assert.equal(event.detail.speechId, 'a');
  assert.equal(event.detail.startAt, 11);
  assert.equal(event.detail.endAt, 13);
  assert.equal(h.motion.update(10, 1 / 60).active, false);
  assert.equal(h.motion.update(11.5, 1 / 60).emotion, 'sedih');
  h.sources[0].onended();
  await played;
  assert.equal(h.state.activeAudioSources.size, 0);
});

test('abort stops the source, cancels motion and resolves playback immediately', async () => {
  const h = browser(), abort = new AbortController();
  const played = h.state.playSentenceAudio([new Uint8Array([1])], 'kagum', { speechId: 'a', signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.motion.cues.length, 1);
  abort.abort();
  await played;
  assert.equal(h.sources[0].stopped, true);
  assert.equal(h.motion.cues.length, 0);
  assert.equal(h.state.playCursor, h.context.currentTime);
});

test('sentence pauses share the audio clock while emotion cues stop at the voice boundary', async () => {
  const h = browser();
  let finished = false;
  const played = h.state.playSentenceAudio([new Uint8Array([1])], 'sayang', {
    speechId: 'stages', segmentId: 2, register: 'intimate', stage: 'deep', partId: 'stages:deep',
    pauseBeforeMs: 100, pauseAfterMs: 200,
  }).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sources.length, 2);
  assert.equal(h.sources[0].startAt, 11.1);
  assert.equal(h.sources[1].startAt, 13.1);
  assert.equal(h.sources[1].buffer.duration, 0.2);
  assert.ok(Math.abs(h.state.playCursor - 13.3) < 1e-9);
  const cue = h.events.find(event => event.type === 'waifu-speech-cue').detail;
  assert.equal(cue.startAt, 11.1);
  assert.equal(cue.endAt, 13.1);
  assert.equal(cue.register, 'intimate');
  assert.equal(cue.stage, 'deep');
  assert.equal(cue.partId, 'stages:deep');
  h.sources[0].onended?.();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'the final pause must finish before playback completion');
  h.context.currentTime = h.state.playCursor;
  h.sources[1].onended();
  await played;
  assert.equal(h.state.activeAudioSources.size, 0);
});

test('interruption removes pending silence together with audio and gesture cues', async () => {
  const h = browser(), abort = new AbortController();
  const played = h.state.playSentenceAudio([new Uint8Array([1])], 'jahil', {
    speechId: 'proactive', pauseAfterMs: 200, signal: abort.signal,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.activeAudioSources.size, 2);
  abort.abort();
  await played;
  assert.ok(h.sources.every(source => source.stopped));
  assert.equal(h.state.activeAudioSources.size, 0);
  assert.equal(h.motion.cues.length, 0);
  assert.equal(h.state.playCursor, h.context.currentTime);
});

test('abort during decode and decode failures never publish gesture cues', async () => {
  let finish;
  const h = browser({ decode: () => new Promise(resolve => { finish = resolve; }) });
  const abort = new AbortController();
  const played = h.state.playSentenceAudio([new Uint8Array([1])], 'netral', { speechId: 'a', signal: abort.signal });
  abort.abort();
  finish(h.buffer);
  await played;
  assert.equal(h.sources.length, 0);
  assert.equal(h.events.length, 0);
  const failed = browser({ decode: async () => { throw new Error('bad audio'); } });
  await failed.state.playSentenceAudio([new Uint8Array([1])], 'netral', { speechId: 'bad' });
  assert.equal(failed.events.some(event => event.type === 'waifu-speech-cue'), false);
  assert.equal(failed.motion.cues.length, 0);
});

test('source scheduling failures leave no gesture or source behind', async () => {
  const h = browser({ startError: true });
  await assert.rejects(h.state.playSentenceAudio([new Uint8Array([1])], 'netral', { speechId: 'bad' }), /start failed/);
  assert.equal(h.events.some(event => event.type === 'waifu-speech-cue'), false);
  assert.equal(h.state.activeAudioSources.size, 0);
});

test('SpeechPlayback passes IDs and cancels active and queued motion on disconnect reset', async () => {
  const h = browser();
  const cancelled = [];
  const playback = new SpeechPlayback({
    playAudio: (chunks, emotion, options) => h.state.playSentenceAudio(chunks, emotion, options),
    onFinished() {}, onCancelled: id => { cancelled.push(id); h.motion.cancel(id); },
  });
  for (const speechId of ['first', 'queued']) {
    playback.handle({ type: 'speech_start', speechId });
    playback.handle({ type: 'audio_output', speechId, data: new Uint8Array([1]) });
    playback.handle({ type: 'audio_end', speechId });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.motion.cues[0].speechId, 'first');
  playback.reset();
  await playback.chain;
  assert.deepEqual(cancelled, ['first', 'queued']);
  assert.equal(h.motion.cues.length, 0);
  assert.equal(h.sources.length, 1);
});
