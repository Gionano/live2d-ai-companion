export class SpeechPlayback {
  constructor({ playAudio, onFinished, onChange = () => {} }) {
    this.playAudio = playAudio;
    this.onFinished = onFinished;
    this.onChange = onChange;
    this.speeches = new Map();
    this.chain = Promise.resolve();
  }

  get busy() {
    return this.speeches.size > 0;
  }

  handle(message) {
    const { speechId } = message;
    if (typeof speechId !== 'string' || !speechId) return;
    if (message.type === 'speech_start') {
      if (!this.speeches.has(speechId)) {
        this.speeches.set(speechId, { speechId, chunks: [], pending: 0, ended: false,
          controller: new AbortController(), emotion: 'netral' });
        this.onChange();
      }
      return;
    }
    const speech = this.speeches.get(speechId);
    if (speech && message.type === 'stop_speech') {
      speech.ended = true;
      speech.chunks = [];
      speech.controller.abort();
      this.checkFinished(speech);
      return;
    }
    if (!speech || speech.ended) return;
    if (message.type === 'audio_output') speech.chunks.push(message.data);
    else if (message.type === 'emotion') speech.emotion = message.emotion;
    else if (message.type === 'audio_end') {
      this.flush(speech, message.emotion);
    } else if (message.type === 'speech_end') {
      speech.ended = true;
      this.flush(speech);
      this.checkFinished(speech);
    }
  }

  flush(speech, emotion = speech.emotion) {
    if (!speech.chunks.length) return;
    const chunks = speech.chunks;
    speech.chunks = [];
    speech.pending++;
    this.chain = this.chain.then(async () => {
      if (this.speeches.get(speech.speechId) !== speech) return;
      try {
        if (!speech.controller.signal.aborted) {
          await this.playAudio(chunks, emotion, { signal: speech.controller.signal });
        }
      } catch (err) {
        console.error('[playback]', err.message);
      } finally {
        speech.pending--;
        this.checkFinished(speech);
      }
    });
  }

  checkFinished(speech) {
    if (!speech.ended || speech.pending || this.speeches.get(speech.speechId) !== speech) return;
    this.speeches.delete(speech.speechId);
    this.onFinished(speech.speechId);
    this.onChange();
  }

  reset() {
    for (const speech of this.speeches.values()) speech.controller.abort();
    this.speeches.clear();
    this.onChange();
  }
}

export class TurnState {
  constructor() {
    this.state = 'idle';
    this.turnId = null;
  }

  handle(message) {
    if (message.type === 'conversation_state' || message.type === 'input_rejected') {
      this.state = message.state || 'idle';
      this.turnId = message.turnId || null;
      return true;
    }
    if (message.type === 'turn_cancelled' && message.turnId === this.turnId) {
      this.state = 'idle';
      this.turnId = null;
      return true;
    }
    return !message.turnId || message.turnId === this.turnId;
  }

  playbackState(playback) {
    return playback.busy ? 'speaking' : this.state;
  }
}
