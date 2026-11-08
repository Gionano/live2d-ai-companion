const WORDS = /[\p{L}\p{N}]+/gu;
const ENDERS = '.!?…\n';
const GREETINGS = new Set(['halo', 'hai', 'hei', 'hi', 'hello']);
const METADATA = new Set(['segment_start', 'segment_end', 'emotion', 'speechEmotion', 'register']);

const words = text => String(text ?? '').normalize('NFKC').toLowerCase().match(WORDS) ?? [];
const visibleSpeech = text => String(text ?? '').replace(/\[[^\]]*\]/g, '');

function sentenceEnd(text, final) {
  for (let index = 0; index < text.length; index++) {
    if (!ENDERS.includes(text[index])) continue;
    if (text[index] === '.' && /\d/.test(text[index - 1] ?? '') && /\d/.test(text[index + 1] ?? '')) continue;
    let end = index + 1;
    while (ENDERS.includes(text[end] ?? '\0')) end++;
    if (text[end] === undefined ? final : /\s/.test(text[end])) return end;
  }
  return final && text.trim() ? text.length : null;
}

// Sanitized speech differs from display only by supported inline tags and a
// possible display-only separator inserted between spoken segments.
function trimSpeechPrefix(speech, display, count) {
  const visible = visibleSpeech(speech);
  const separator = display.startsWith(' ') && !visible.startsWith(' ') && display.slice(1) === visible ? 1 : 0;
  const target = Math.max(0, count - separator);
  let index = 0;
  let consumed = 0;
  while (index < speech.length && consumed < target) {
    if (speech[index] === '[') {
      const end = speech.indexOf(']', index + 1);
      if (end >= 0) { index = end + 1; continue; }
    }
    index++;
    consumed++;
  }
  return speech.slice(index);
}

// Filter only a duplicated opening, before display and synthesis diverge. Once
// a distinct continuation appears, later repetition remains meaningful prose.
export class ReplyContinuationGuard {
  constructor({ spokenText = '', maxPendingChars = 4096 } = {}) {
    const reference = words(spokenText);
    this.targets = [reference.join(' ')];
    if (GREETINGS.has(reference[0]) && reference.length > 1) {
      this.targets.push([reference[0], 'juga', ...reference.slice(1)].join(' '));
    }
    this.active = reference.length > 0;
    this.maxPendingChars = Number.isSafeInteger(maxPendingChars) && maxPendingChars > 0 ? maxPendingChars : 4096;
    this.pending = [];
    this.text = '';
    this.currentSegment = null;
    this.endedSegments = new Set();
    this.removedSentences = 0;
  }

  push(event) {
    // Private control metadata must survive an entirely suppressed deep reply.
    if (!this.active || event.type === 'reply_metadata') return [event];
    if (event.type !== 'delta' && !METADATA.has(event.type)) return [event];
    this.pending.push({ ...event });
    if (event.type === 'segment_start') this.currentSegment = event.segmentId;
    if (event.type === 'segment_end') {
      this.endedSegments.add(event.segmentId);
      if (this.currentSegment === event.segmentId) this.currentSegment = null;
    }
    if (event.type === 'delta') this.text += event.text ?? '';
    const output = this.evaluate(event.type === 'segment_end');
    if (this.active && event.type === 'segment_end') this.pruneSegments();
    if (this.active && (this.pending.length > 512 || this.pendingCharacters() > this.maxPendingChars)) {
      return [...output, ...this.release()];
    }
    return output;
  }

  pendingCharacters() {
    return this.pending.reduce((total, event) => total + (event.text?.length ?? 0) + (event.speechText?.length ?? 0), 0);
  }

  evaluate(final = false) {
    while (this.text.trim()) {
      // An opening quotation can deliberately discuss the earlier response.
      if (/^\s*["'“‘«]/u.test(this.text)) return this.release();
      const end = sentenceEnd(this.text, final);
      if (end !== null) {
        const candidate = words(this.text.slice(0, end)).join(' ');
        if (!this.targets.includes(candidate)) return this.release();
        let cut = end;
        while (cut < this.text.length && /\s/.test(this.text[cut])) cut++;
        this.removePrefix(cut);
        this.removedSentences++;
        continue;
      }
      const candidate = words(this.text).join(' ');
      if (candidate && !this.targets.some(target => target.startsWith(candidate))) return this.release();
      break;
    }
    return [];
  }

  removePrefix(count) {
    this.text = this.text.slice(count);
    let remaining = count;
    const trimmed = [];
    for (const event of this.pending) {
      if (event.type !== 'delta') { trimmed.push(event); continue; }
      const display = event.text ?? '';
      const consumed = Math.min(remaining, display.length);
      remaining -= consumed;
      // Tag-only events before the removed words belong to the discarded opener.
      if (remaining > 0 && !display) continue;
      const next = { ...event, text: display.slice(consumed) };
      if (typeof event.speechText === 'string') {
        next.speechText = trimSpeechPrefix(event.speechText, display, consumed);
      }
      if (next.text || next.speechText) trimmed.push(next);
    }
    this.pending = trimmed;
    this.pruneSegments();
  }

  pruneSegments() {
    const keepSegments = new Set(this.pending.filter(event => event.type === 'delta'
      && (event.text?.trim() || visibleSpeech(event.speechText).trim())).map(event => event.segmentId));
    if (this.currentSegment !== null) keepSegments.add(this.currentSegment);
    this.pending = this.pending.filter(event => event.segmentId === undefined
      || !this.endedSegments.has(event.segmentId) || keepSegments.has(event.segmentId));
    const pendingIds = new Set(this.pending.map(event => event.segmentId));
    this.endedSegments = new Set([...this.endedSegments].filter(id => pendingIds.has(id)));
  }

  release() {
    this.active = false;
    const output = this.pending;
    this.pending = [];
    this.text = '';
    return output;
  }

  finish() {
    if (!this.active) return [];
    const output = this.evaluate(true);
    if (!this.active) return output;
    // Remaining metadata/inline tags have no accepted spoken text to accompany.
    this.pending = [];
    this.text = '';
    this.active = false;
    return output;
  }
}
