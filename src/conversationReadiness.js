// Audio readiness is independent of microphone permission and user messages.
export class ConversationReadiness {
  constructor(send) {
    this.send = send;
    this.audioReady = false;
    this.online = false;
    this.lastSent = null;
  }

  connected() { this.online = true; this.lastSent = null; this.publish(); }
  disconnected() { this.online = false; this.lastSent = null; }
  setAudioReady(ready) { this.audioReady = ready === true; this.publish(); }

  publish() {
    if (!this.online || this.lastSent === this.audioReady) return;
    if (this.send({ type: 'conversation_ready', audioReady: this.audioReady }) !== false) {
      this.lastSent = this.audioReady;
    }
  }
}
