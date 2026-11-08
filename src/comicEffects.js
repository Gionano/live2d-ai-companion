import { BANK_DEFAULTS } from './emotionBanks.js';
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export function projectHeadAnchor(matrix, bounds, values, rect, scale = 1) {
  const height = bounds.maxY - bounds.minY;
  const x = (bounds.minX + bounds.maxX) / 2 + 0.12 + (values.ParamAngleX || 0) * 0.002 + (values.ParamBodyAngleX || 0) * 0.001;
  const y = bounds.maxY - height * 0.21 + 0.08 + (values.ParamAngleY || 0) * 0.001;
  const ndcX = matrix[0] * x + matrix[4] * y + matrix[12];
  const ndcY = matrix[1] * x + matrix[5] * y + matrix[13];
  const size = clamp(Math.abs(matrix[5]) * rect.height * 0.04 * scale, 20, Math.min(140, rect.width, rect.height));
  return { x: rect.left + clamp((ndcX + 1) * rect.width / 2, size / 2, rect.width - size / 2),
    y: rect.top + clamp((1 - ndcY) * rect.height / 2, size / 2, rect.height - size / 2), size };
}

export class ComicTimeline {
  constructor(getOptions = () => ({})) { this.getOptions = getOptions; this.last = new Map(); this.current = null; this.alpha = 0; }
  trigger(cue, time) {
    const options = { ...BANK_DEFAULTS, ...this.getOptions() };
    const symbol = cue.emotion === 'kagum' ? 'playful' : cue.bankId;
    if (options.comicEnabled === 'off' || ['netral', 'bingung', 'penasaran'].includes(cue.emotion)) { this.clear(); return false; }
    if (time - (this.last.get(cue.emotion) ?? -Infinity) < options.symbolCooldownMs / 1000) return false;
    this.last.set(cue.emotion, time);
    this.current = { emotion: cue.emotion, symbol, end: time + options.symbolDurationMs / 1000 };
    this.alpha = 0;
    return true;
  }
  clear() { this.current = null; }
  reset() { this.clear(); this.last.clear(); this.alpha = 0; }
  update(time, delta) {
    const options = { ...BANK_DEFAULTS, ...this.getOptions() };
    if (options.comicEnabled === 'off' || time >= (this.current?.end ?? Infinity)) this.clear();
    this.alpha = clamp(this.alpha + (this.current ? 1 : -1) * delta / 0.18, 0, 1);
    return { current: this.current, alpha: this.alpha };
  }
}

export class ComicEffects {
  constructor(bundle, getOptions, doc = document) {
    this.bundle = bundle; this.timeline = new ComicTimeline(getOptions); this.getOptions = getOptions;
    this.layer = doc.createElement('div'); this.layer.setAttribute('aria-hidden', 'true');
    this.layer.className = 'witch-comic-effects';
    Object.assign(this.layer.style, { position: 'fixed', inset: '0', zIndex: '3', pointerEvents: 'none', overflow: 'hidden' });
    this.image = doc.createElement('img'); this.image.draggable = false;
    Object.assign(this.image.style, { position: 'absolute', pointerEvents: 'none', userSelect: 'none',
      transform: 'translate(-50%, -50%)', objectFit: 'contain', opacity: '0' });
    this.layer.append(this.image); doc.body.append(this.layer);
  }
  trigger(cue, time) {
    if (this.timeline.trigger(cue, time)) {
      const effect = this.bundle.effects.effects[this.timeline.current.symbol];
      if (!effect) { this.timeline.clear(); return; }
      this.image.src = this.bundle.base + effect.file; this.image.alt = '';
    }
  }
  clear() { this.timeline.clear(); }
  update(time, delta, matrix, bounds, values, rect) {
    const state = this.timeline.update(time, delta);
    const effect = this.bundle.effects.effects[state.current?.symbol];
    const sizeScale = (this.getOptions().symbolSize ?? 1) * (effect?.sizeScale ?? 1);
    const anchor = projectHeadAnchor(matrix, bounds, values, rect, sizeScale);
    Object.assign(this.image.style, { opacity: String(state.alpha), left: `${anchor.x}px`, top: `${anchor.y}px`,
      width: `${anchor.size}px`, height: `${anchor.size}px`, visibility: state.alpha > 0 ? 'visible' : 'hidden' });
  }
  dispose() { this.timeline.reset(); this.layer.remove(); }
}
