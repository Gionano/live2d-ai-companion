// Render streamed stages once while leaving the legacy full-reply event usable.
export class ReplyParts {
  constructor({ create, update, onText = () => {} }) {
    Object.assign(this, { create, update, onText });
    this.turns = new Map();
  }

  handle(event) {
    if (event.type !== 'reply_part' || !event.turnId || !event.partId
      || !['surface', 'deep'].includes(event.stage) || !['start', 'delta', 'done'].includes(event.status)) return false;
    let turn = this.turns.get(event.turnId);
    if (!turn) {
      turn = { parts: new Map(), cancelled: false, displayed: false };
      this.turns.set(event.turnId, turn);
      if (this.turns.size > 100) this.turns.delete(this.turns.keys().next().value);
    }
    if (turn.cancelled) return true;
    let part = turn.parts.get(event.partId);
    if (!part) {
      part = { text: '', node: null, done: false };
      turn.parts.set(event.partId, part);
    }
    if (part.done) return true;
    if (event.status === 'delta' && typeof event.text === 'string') part.text += event.text;
    if (event.status === 'done') {
      if (typeof event.text === 'string') part.text = event.text;
      part.done = true;
    }
    if (part.text.trim()) {
      if (!part.node) part.node = this.create(event.stage);
      this.update(part.node, part.text);
      turn.displayed = true;
      this.onText(part.text, event);
    }
    return true;
  }

  hasDisplayed(turnId) { return this.turns.get(turnId)?.displayed === true; }
  cancel(turnId) {
    const turn = this.turns.get(turnId);
    if (turn) turn.cancelled = true;
  }
  reset() { this.turns.clear(); }
}
