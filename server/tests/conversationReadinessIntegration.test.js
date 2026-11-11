import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ConversationReadiness } from '../../src/conversationReadiness.js';

const source = fs.readFileSync(new URL('../../src/companion.js', import.meta.url), 'utf8');
const ensureStart = source.indexOf('function ensureAudio() {');
const ensureAudio = source.slice(ensureStart, source.indexOf('// Amplitudo audio', ensureStart));
const listeningStart = source.indexOf('async function startListening() {');
const startListening = source.slice(listeningStart, source.indexOf('// ---------------------------------------------------------------------------', listeningStart));

test('audio readiness is resent after reconnect without a user message', () => {
  const sent = [];
  const readiness = new ConversationReadiness(message => sent.push(message));
  readiness.connected();
  readiness.setAudioReady(true);
  readiness.disconnected();
  readiness.connected();
  assert.deepEqual(sent.at(-1), { type: 'conversation_ready', audioReady: true });
  assert.equal(sent.length, 3);

  readiness.disconnected();
  readiness.setAudioReady(false);
  assert.equal(sent.length, 3);
  readiness.connected();
  assert.deepEqual(sent.at(-1), { type: 'conversation_ready', audioReady: false });
  readiness.setAudioReady(true);
  readiness.setAudioReady(true);
  assert.deepEqual(sent.at(-1), { type: 'conversation_ready', audioReady: true });
  assert.equal(sent.length, 5);
});

for (const initialState of ['running', 'suspended']) {
  test(`actual muted startup publishes playback readiness with ${initialState} audio and no first message`, async () => {
    const sent = [];
    const readiness = new ConversationReadiness(message => sent.push(message));
    readiness.connected();
    let microphoneRequests = 0;
    let audioContexts = 0;
    let resumes = 0;
    let reports = 0;
    class AudioContext extends EventTarget {
      constructor() {
        super();
        audioContexts++;
        this.state = initialState;
        this.destination = {};
      }
      createAnalyser() { return { frequencyBinCount: 128, connect() {} }; }
      async resume() {
        resumes++;
        this.state = 'running';
        this.dispatchEvent(new Event('statechange'));
      }
    }
    const state = vm.createContext({
      window: { AudioContext }, Uint8Array,
      audioCtx: null, analyser: null, freqData: null,
      conversationReadiness: readiness, sampleMouth: () => 0,
      playCursor: 0, scheduledEmotionEnd: 0, tuning: { get() {} },
      listening: false, micStream: null, micStartPromise: null, isMicMutedByDesktop: true,
      navigator: { mediaDevices: { getUserMedia() { microphoneRequests++; throw new Error('Muted microphone must remain closed.'); } } },
      reportDesktopMicState() { reports++; },
      setMicStatus() {}, log() {},
    });
    vm.runInContext(ensureAudio + '\n' + startListening, state);
    await state.startListening();
    assert.equal(microphoneRequests, 0);
    assert.equal(audioContexts, 1);
    assert.equal(resumes, initialState === 'suspended' ? 1 : 0);
    assert.equal(reports, 1);
    assert.equal(state.audioCtx.state, 'running');
    assert.equal(state.micStream, null);
    assert.deepEqual(sent, [
      { type: 'conversation_ready', audioReady: false },
      { type: 'conversation_ready', audioReady: true },
    ]);
    await state.startListening();
    assert.equal(audioContexts, 1);
    assert.equal(sent.length, 2);
    assert.equal(microphoneRequests, 0);
  });
}
