import { randomUUID } from 'node:crypto';

export class SpeechController {
  constructor({ generateSpeech, isVoiceConfigured, safetyTimeoutMs = 30000 }) {
    this.generateSpeech = generateSpeech;
    this.isVoiceConfigured = isVoiceConfigured;
    this.safetyTimeoutMs = safetyTimeoutMs;
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
        if (speech.ended) this.releaseSpeech(speech);
        else {
          this.finishSpeech(speech, false);
          this.releaseSpeech(speech);
        }
      }
      else if (speech.ended && !speech.pending.size) this.releaseSpeech(speech);
    }
    this.drain();
  }

  beginTurn(socket) {
    if (this.isBusy(socket)) {
      this.rejectInput(socket, 'BUSY');
      return null;
    }
    const session = this.sessions.get(socket);
    if (!session) return null;
    const controller = new AbortController();
    const turn = { turnId: randomUUID(), controller, signal: controller.signal };
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
    if (this.activeSpeech?.turnId === turnId) this.stopSpeech(this.activeSpeech);
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

  play({ text, emotion = 'sayang', recipients = null, produce = null, deferred = false, turnId = null }) {
    return new Promise((resolve) => {
      this.queue.push({ text, emotion, recipients, produce, deferred, turnId, resolve });
      this.drain();
    });
  }

  drain() {
    // Drop expired turns even while another socket is playing speech.
    this.queue = this.queue.filter(item => {
      if (!item.turnId || item.recipients?.every(socket => this.isCurrentTurn(socket, item.turnId))) return true;
      item.resolve({ ok: false, speechId: null, turnId: item.turnId });
      return false;
    });
    if (this.activeSpeech || !this.queue.length) return;
    const index = this.queue.findIndex(item => (item.recipients || [...this.sessions.keys()])
      .filter(socket => this.sessions.has(socket)).every(socket => item.turnId
        ? this.isCurrentTurn(socket, item.turnId) : !this.isBusy(socket)));
    if (index < 0) return;
    const item = this.queue.splice(index, 1)[0];
    const recipients = new Set((item.recipients || [...this.sessions.keys()])
      .filter(socket => this.sessions.has(socket)));
    if (!recipients.size) {
      item.resolve({ ok: false, speechId: null });
      this.drain();
      return;
    }
    const speech = {
      speechId: randomUUID(), turnId: item.turnId, recipients, pending: new Set(recipients),
      ended: false, hasAudio: false, controller: new AbortController(),
      resolve: item.resolve, timer: null,
    };
    this.activeSpeech = speech;
    this.emit(speech, { type: 'speech_start' });
    for (const socket of recipients) this.setState(socket, 'speaking', false, item.turnId);
    this.armSpeechTimeout(speech);
    void this.run(speech, item);
  }

  emit(speech, event) {
    for (const socket of speech.recipients) {
      this.sessions.get(socket)?.send({ ...event, speechId: speech.speechId, turnId: speech.turnId });
    }
  }

  async run(speech, item) {
    let ok = true;
    const say = async (text, emotion = item.emotion, onChunk = () => {}) => {
      if (speech.ended || !text) return;
      this.emit(speech, { type: 'emotion', emotion });
      try {
        if (this.isVoiceConfigured()) {
          for await (const chunk of this.generateSpeech(text, emotion, { signal: speech.controller.signal })) {
            if (speech.ended) break;
            speech.hasAudio = true;
            this.emit(speech, { type: 'audio_output', data: chunk.toString('base64'), format: 'mp3' });
            onChunk();
          }
        }
      } catch (err) {
        ok = false;
        console.error('[tts:speech]', err.message);
      } finally {
        if (!speech.ended) this.emit(speech, { type: 'audio_end', emotion });
      }
    };
    try {
      if (item.produce) await item.produce({ say, signal: speech.controller.signal });
      else {
        this.emit(speech, { type: 'amika_replied', text: item.text, emotion: item.emotion });
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
    speech.controller.abort();
    this.emit(speech, { type: 'speech_end', ok });
    for (const socket of speech.recipients) this.setState(socket, 'idle', false);
    speech.resolve({ speechId: speech.speechId, ok });
    if (!speech.hasAudio) this.releaseSpeech(speech);
    else this.armSpeechTimeout(speech);
  }

  armSpeechTimeout(speech) {
    clearTimeout(speech.timer);
    speech.timer = setTimeout(() => {
      if (speech.turnId && !speech.ended) {
        const socket = [...speech.recipients][0];
        this.cancelTurn(socket, speech.turnId);
      }
      this.stopSpeech(speech);
      this.releaseSpeech(speech);
    }, this.safetyTimeoutMs);
  }

  stopSpeech(speech) {
    if (this.activeSpeech !== speech) return;
    this.emit(speech, { type: 'stop_speech' });
    if (!speech.ended) this.finishSpeech(speech, false);
  }

  releaseSpeech(speech) {
    if (this.activeSpeech !== speech) return;
    clearTimeout(speech.timer);
    this.activeSpeech = null;
    for (const socket of speech.recipients) {
      this.sessions.get(socket)?.send({ type: 'conversation_state',
        state: socket.conversationState, turnId: socket.turnId });
    }
    this.drain();
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
