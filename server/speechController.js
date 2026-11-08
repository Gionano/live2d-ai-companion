import { randomUUID } from 'node:crypto';
import { logger as console } from '../src/logging.js';
import { stripSpeechTags, spokenSentenceCount } from './ttsExpression.js';
import { normalizeSpeechEmotion, normalizeSpeechRegister } from './speechEmotionPrompt.js';

const NORMAL_PLAYBACK_BUDGET_MS = 30000;
const MAX_PLAYBACK_BUDGET_MS = 10 * 60 * 1000;
const ESTIMATED_SPOKEN_CHARACTER_MS = 110;

export class SpeechController {
  constructor({ generateSpeech, isVoiceConfigured, safetyTimeoutMs = 30000, onPlaybackReleased = () => {} }) {
    this.generateSpeech = generateSpeech;
    this.isVoiceConfigured = isVoiceConfigured;
    this.safetyTimeoutMs = safetyTimeoutMs;
    this.onPlaybackReleased = onPlaybackReleased;
    this.sessions = new Map();
    this.queue = [];
    this.activeSpeech = null;
  }

  register(socket, send) {
    this.sessions.set(socket, { send, timer: null, turn: null });
    socket.conversationState = 'idle';
    socket.turnId = null;
  }

  unregister(socket) {
    const session = this.sessions.get(socket);
    clearTimeout(session?.timer);
    session?.turn?.controller.abort();
    this.sessions.delete(socket);
    const speech = this.activeSpeech;
    if (speech) {
      speech.pending.delete(socket);
      speech.recipients.delete(socket);
      if (!speech.recipients.size) {
        speech.releaseReason = 'disconnected';
        if (speech.ended) this.releaseSpeech(speech, 'disconnected');
        else {
          this.finishSpeech(speech, false);
          this.releaseSpeech(speech);
        }
      }
      else if (speech.ended && !speech.pending.size) this.releaseSpeech(speech);
    }
    this.drain();
  }

  beginTurn(socket, { origin = 'conversation' } = {}) {
    if (origin !== 'proactive') this.cancelProactive(socket, { drain: false });
    if (this.isBusy(socket)) {
      this.rejectInput(socket, 'BUSY');
      return null;
    }
    const session = this.sessions.get(socket);
    if (!session) return null;
    const controller = new AbortController();
    const turn = { turnId: randomUUID(), controller, signal: controller.signal, origin };
    session.turn = turn;
    socket.turnId = turn.turnId;
    this.setState(socket, 'processing', false, turn.turnId);
    return turn;
  }

  isCurrentTurn(socket, turnId) {
    const turn = this.sessions.get(socket)?.turn;
    return Boolean(turn && turn.turnId === turnId && !turn.signal.aborted);
  }

  sendTurn(socket, turnId, event) {
    if (!this.isCurrentTurn(socket, turnId)) return false;
    this.sessions.get(socket).send({ ...event, turnId });
    return true;
  }

  completeTurn(socket, turnId) {
    if (!this.isCurrentTurn(socket, turnId)) return false;
    const session = this.sessions.get(socket);
    session.turn = null;
    socket.turnId = null;
    this.setState(socket, 'idle');
    return true;
  }

  cancelTurn(socket, turnId, reason = 'TIMEOUT') {
    if (!this.isCurrentTurn(socket, turnId)) return false;
    const session = this.sessions.get(socket);
    session.turn.controller.abort(new Error(reason));
    session.turn = null;
    socket.turnId = null;
    if (this.activeSpeech?.turnId === turnId) {
      this.stopSpeech(this.activeSpeech, reason === 'TIMEOUT' ? 'timeout' : 'cancelled');
    }
    session.send({ type: 'turn_cancelled', turnId, reason });
    this.setState(socket, 'idle');
    return true;
  }

  rejectInput(socket, reason) {
    const session = this.sessions.get(socket);
    if (!session) return;
    const speech = this.activeSpeech;
    const receiving = speech?.recipients.has(socket) && (!speech.ended || speech.pending.has(socket));
    session.send({ type: 'input_rejected', reason,
      state: receiving ? 'speaking' : socket.conversationState, turnId: socket.turnId });
  }

  setState(socket, state, drain = true, turnId = null) {
    const session = this.sessions.get(socket);
    if (!session || turnId && !this.isCurrentTurn(socket, turnId)) return false;
    clearTimeout(session.timer);
    session.timer = null;
    socket.conversationState = state;
    session.send({ type: 'conversation_state', state, turnId: socket.turnId });
    if (state === 'processing') {
      const currentId = session.turn?.turnId;
      session.timer = setTimeout(() => {
        if (currentId) this.cancelTurn(socket, currentId);
        else this.setState(socket, 'idle');
      }, this.safetyTimeoutMs);
    } else if (drain) {
      // Even idle -> idle must retry deferred captions.
      this.drain();
    }
    return true;
  }

  isBusy(socket) {
    const speech = this.activeSpeech;
    return Boolean(this.sessions.get(socket)?.turn) || socket.conversationState !== 'idle'
      || Boolean(speech?.recipients.has(socket) && (!speech.ended || speech.pending.has(socket)));
  }

  play({ text, emotion = 'sayang', speechEmotion, recipients = null, produce = null, deferred = false,
    turnId = null, origin = 'conversation', signal = null }) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve({ ok: false, speechId: null, turnId, reason: 'cancelled' });
        return;
      }
      const item = { text, emotion, speechEmotion: normalizeSpeechEmotion(speechEmotion),
        recipients, produce, deferred, turnId, origin, resolve };
      const onAbort = () => {
        const queuedIndex = this.queue.indexOf(item);
        if (queuedIndex >= 0) {
          this.queue.splice(queuedIndex, 1);
          item.dispose();
          resolve({ ok: false, speechId: null, turnId, reason: 'cancelled' });
        }
        const speech = this.activeSpeech;
        if (speech?.item === item) {
          speech.suppressDrain = true;
          this.stopSpeech(speech, 'cancelled');
          this.releaseSpeech(speech, 'cancelled', { drain: false });
        }
        if (origin !== 'proactive') this.drain();
      };
      item.dispose = () => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(item);
      this.drain();
    });
  }

  drain() {
    // Drop expired turns even while another socket is playing speech.
    this.queue = this.queue.filter(item => {
      if (!item.turnId || item.recipients?.every(socket => this.isCurrentTurn(socket, item.turnId))) return true;
      item.dispose();
      item.resolve({ ok: false, speechId: null, turnId: item.turnId });
      return false;
    });
    if (this.activeSpeech || !this.queue.length) return;
    const index = this.queue.findIndex(item => (item.recipients || [...this.sessions.keys()])
      .filter(socket => this.sessions.has(socket)).every(socket => !socket.userInputActive && (item.turnId
        ? this.isCurrentTurn(socket, item.turnId) : !this.isBusy(socket))));
    if (index < 0) return;
    const item = this.queue.splice(index, 1)[0];
    const recipients = new Set((item.recipients || [...this.sessions.keys()])
      .filter(socket => this.sessions.has(socket)));
    if (!recipients.size) {
      item.dispose();
      item.resolve({ ok: false, speechId: null });
      this.drain();
      return;
    }
    const speech = {
      speechId: randomUUID(), turnId: item.turnId, origin: item.origin, recipients, pending: new Set(recipients),
      ended: false, hasAudio: false, controller: new AbortController(),
      spokenCharacters: 0, pauseMs: 0, memorySentences: [],
      resolve: item.resolve, timer: null, item,
    };
    this.activeSpeech = speech;
    this.emit(speech, { type: 'speech_start', origin: speech.origin });
    for (const socket of recipients) this.setState(socket, 'speaking', false, item.turnId);
    this.armSpeechTimeout(speech);
    void this.run(speech, item);
  }

  emit(speech, event) {
    // Healthy stage text and audio can span several model calls. Expire only
    // stalled generation, without changing the provider's own request timeout.
    if (this.activeSpeech === speech && !speech.ended
      && !['speech_start', 'stop_speech'].includes(event.type)) this.armSpeechTimeout(speech);
    for (const socket of speech.recipients) {
      this.sessions.get(socket)?.send({ ...event, speechId: speech.speechId, turnId: speech.turnId });
    }
  }

  async run(speech, item) {
    let ok = true;
    let sentenceIndex = 0;
    const say = async (text, emotion = item.emotion, onChunk = () => {}, options = {}) => {
      if (speech.ended || !text) return;
      const index = sentenceIndex;
      sentenceIndex += spokenSentenceCount(text);
      let endedRequest = false;
      let pendingAudio = false;
      let countedAudio = false;
      let sentenceOk = true;
      const speechEmotion = Object.hasOwn(options, 'speechEmotion')
        ? normalizeSpeechEmotion(options.speechEmotion) : item.speechEmotion;
      const metadata = {
        segmentId: typeof options.segmentId === 'string' || Number.isSafeInteger(options.segmentId) && options.segmentId >= 0
          ? options.segmentId : `${speech.speechId}:${index}`,
        pauseBeforeMs: Math.max(0, Math.min(400, Number(options.pauseBeforeMs) || 0)),
        pauseAfterMs: Math.max(0, Math.min(400, Number(options.pauseAfterMs) || 0)),
        register: normalizeSpeechRegister(options.register),
        ...(options.stage && { stage: options.stage }),
        ...(options.partId && { partId: options.partId }),
      };
      this.emit(speech, { type: 'emotion', emotion });
      try {
        if (this.isVoiceConfigured()) {
          let format = 'mp3';
          for await (const chunk of this.generateSpeech(text, emotion, { signal: speech.controller.signal,
            speechEmotion,
            sentenceIndex: index, onAudioFormat: value => {
              format = value;
              pendingAudio = true;
              if (!speech.ended) this.armSpeechTimeout(speech);
            },
            onAudioEnd: () => {
              endedRequest = true; pendingAudio = false;
              if (!speech.ended) this.emit(speech, { type: 'audio_end', emotion, ...metadata });
              metadata.pauseBeforeMs = 0;
            } })) {
            if (speech.ended) break;
            if (!chunk.length) continue;
            speech.hasAudio = true;
            if (!countedAudio) {
              countedAudio = true;
              speech.spokenCharacters += stripSpeechTags(text).replace(/\s+/g, ' ').trim().length;
              speech.pauseMs += metadata.pauseBeforeMs + metadata.pauseAfterMs;
            }
            this.emit(speech, { type: 'audio_output', data: chunk.toString('base64'), format });
            onChunk();
          }
        }
      } catch (err) {
        ok = false;
        console.error('[tts:speech]', err.message);
      } finally {
        if (!speech.ended && (!endedRequest || pendingAudio)) this.emit(speech, { type: 'audio_end', emotion, ...metadata });
      }
    };
    try {
      if (item.produce) await item.produce({ say, signal: speech.controller.signal,
        speechId: speech.speechId, emit: event => { if (!speech.ended) this.emit(speech, event); },
        touch: () => { if (this.activeSpeech === speech && !speech.ended) this.armSpeechTimeout(speech); } });
      else {
        this.emit(speech, { type: 'amika_replied', text: stripSpeechTags(item.text), emotion: item.emotion });
        await say(item.text, item.emotion);
      }
    } catch (err) {
      ok = false;
      console.error('[speech]', err.message);
    } finally {
      this.finishSpeech(speech, ok);
    }
  }

  finishSpeech(speech, ok) {
    if (this.activeSpeech !== speech || speech.ended) return;
    speech.ended = true;
    speech.ok = ok;
    speech.controller.abort();
    this.emit(speech, { type: 'speech_end', ok });
    for (const socket of speech.recipients) this.setState(socket, 'idle', false);
    speech.resolve({ speechId: speech.speechId, ok });
    if (!speech.hasAudio) this.releaseSpeech(speech, speech.releaseReason || 'no_audio');
    else this.armSpeechTimeout(speech);
  }

  armSpeechTimeout(speech) {
    clearTimeout(speech.timer);
    // The browser acknowledges after all queued sentences and scheduled pauses.
    // Allow a conservative full-utterance duration beyond the normal 30s budget;
    // an absent acknowledgment still has a bounded cleanup deadline.
    const estimatedPlaybackMs = speech.spokenCharacters * ESTIMATED_SPOKEN_CHARACTER_MS + speech.pauseMs;
    const timeoutMs = speech.ended
      ? Math.max(this.safetyTimeoutMs, Math.min(MAX_PLAYBACK_BUDGET_MS,
        this.safetyTimeoutMs + Math.max(0, estimatedPlaybackMs - NORMAL_PLAYBACK_BUDGET_MS)))
      : this.safetyTimeoutMs;
    speech.timer = setTimeout(() => {
      if (speech.turnId && !speech.ended) {
        const socket = [...speech.recipients][0];
        this.cancelTurn(socket, speech.turnId);
      }
      this.stopSpeech(speech, 'timeout');
      this.releaseSpeech(speech, 'timeout');
    }, timeoutMs);
  }

  stopSpeech(speech, reason = 'cancelled') {
    if (this.activeSpeech !== speech) return;
    speech.releaseReason = reason;
    this.emit(speech, { type: 'stop_speech' });
    if (!speech.ended) this.finishSpeech(speech, false);
  }

  releaseSpeech(speech, reason = 'acknowledged', { drain = true } = {}) {
    if (this.activeSpeech !== speech) return;
    clearTimeout(speech.timer);
    speech.item.dispose();
    this.activeSpeech = null;
    for (const socket of speech.recipients) {
      this.sessions.get(socket)?.send({ type: 'conversation_state',
        state: socket.conversationState, turnId: socket.turnId });
    }
    try {
      this.onPlaybackReleased({ speechId: speech.speechId, turnId: speech.turnId, origin: speech.origin,
        reason: speech.releaseReason || reason, hasAudio: speech.hasAudio, ok: speech.ok,
        recipients: [...speech.recipients] });
    } catch (error) {
      console.error('[speech:release]', error.message);
    }
    if (drain && !speech.suppressDrain) this.drain();
  }

  cancelProactive(socket, { drain = true } = {}) {
    let cancelled = false;
    this.queue = this.queue.filter(item => {
      if (item.origin !== 'proactive' || item.recipients && !item.recipients.includes(socket)) return true;
      cancelled = true;
      item.dispose();
      item.resolve({ ok: false, speechId: null, turnId: item.turnId, reason: 'cancelled' });
      return false;
    });
    const session = this.sessions.get(socket);
    const turn = session?.turn;
    if (turn?.origin === 'proactive') {
      cancelled = true;
      turn.controller.abort(new Error('USER_ACTIVITY'));
      session.turn = null;
      socket.turnId = null;
      session.send({ type: 'turn_cancelled', turnId: turn.turnId, reason: 'USER_ACTIVITY' });
      this.setState(socket, 'idle', false);
    }
    const speech = this.activeSpeech;
    if (speech?.origin === 'proactive' && speech.recipients.has(socket)) {
      cancelled = true;
      speech.suppressDrain = true;
      // Generation can already be over while the client is still playing its audio.
      this.stopSpeech(speech, 'cancelled');
      this.releaseSpeech(speech, 'cancelled', { drain: false });
    }
    if (drain) this.drain();
    return cancelled;
  }

  acknowledge(socket, speechId) {
    const speech = this.activeSpeech;
    if (!speech || speech.speechId !== speechId || !speech.ended || !speech.pending.has(socket)) return false;
    speech.pending.delete(socket);
    this.setState(socket, 'idle');
    if (!speech.pending.size) this.releaseSpeech(speech);
    return true;
  }
}
