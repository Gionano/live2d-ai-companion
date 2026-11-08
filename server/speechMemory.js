const MEMORY_ORIGINS = new Set(['conversation', 'proactive', 'vision']);

// Playback proof stays in the backend. Neither client-supplied history nor
// generated text is sufficient to establish a completed dialogue event.
export class SpeechMemoryRecorder {
  constructor({ manager, onError = () => {} } = {}) {
    this.manager = manager;
    this.onError = onError;
  }

  context({ sessionId, turnId = null, userText = '', origin = 'conversation' } = {}) {
    if (!MEMORY_ORIGINS.has(origin) || typeof sessionId !== 'string' || !sessionId) return null;
    try {
      return Object.freeze({ sessionId, turnId, origin, generation: this.manager.generation,
        userText: origin === 'conversation' && typeof userText === 'string' ? userText.trim() : '' });
    } catch (error) {
      this.onError(error?.code ?? 'MEMORY_STORAGE');
      return null;
    }
  }

  released({ speechId, turnId, origin, reason, hasAudio, ok, memoryContext, spokenText } = {}) {
    if (reason !== 'acknowledged' || hasAudio !== true || ok !== true
      || !MEMORY_ORIGINS.has(origin) || memoryContext?.origin !== origin
      || memoryContext.turnId !== (turnId ?? null)
      || typeof speechId !== 'string' || typeof spokenText !== 'string' || !spokenText.trim()) return false;
    try {
      const event = this.manager.archiveCompleted({
        eventId: `speech-${speechId}`, sessionId: memoryContext.sessionId,
        turnId: turnId ?? null, speechId, origin,
        userText: origin === 'conversation' ? memoryContext.userText : '', assistantText: spokenText.trim(),
      }, { generation: memoryContext.generation });
      // A storage failure must never break audio release or proactive timing.
      if (event?.then) event.catch(error => this.onError(error?.code ?? 'MEMORY_STORAGE'));
      return true;
    } catch (error) {
      if (error?.code !== 'MEMORY_STALE') this.onError(error?.code ?? 'MEMORY_STORAGE');
      return false;
    }
  }
}
