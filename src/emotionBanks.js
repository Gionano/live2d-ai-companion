import { compileMotion, sampleMotion, weightedChoice } from './bankMotion.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
export const BANK_MAPPING = Object.freeze({
  netral: 'neutral', malu: 'shy', sayang: 'affectionate', jahil: 'playful',
  senang: 'happy', kagum: 'happy', sedih: 'sad', marah: 'angry',
  jengkel: 'angry', kesal: 'angry', terkejut: 'surprised',
  bingung: 'neutral', penasaran: 'neutral',
});
export const BANK_DEFAULTS = Object.freeze({ enabled: 'on', poseStrength: 1,
  speechBlendWeight: 0.35, comicEnabled: 'on', symbolSize: 1,
  symbolDurationMs: 1500, symbolCooldownMs: 4000 });
const MOTION_CHANNELS = new Set(['ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamEyeBallX',
  'ParamEyeBallY', 'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLAngle', 'ParamBrowRAngle']);
const POSE_CHANNELS = { ParamAngleX: 'headX', ParamAngleY: 'headY', ParamAngleZ: 'headZ',
  ParamEyeBallX: 'eyeX', ParamEyeBallY: 'eyeY', ParamBrowLY: 'browL', ParamBrowRY: 'browR',
  ParamBodyAngleX: 'bodyX', ParamBodyAngleY: 'bodyY', ParamBodyAngleZ: 'bodyZ' };
export function cueIdentity(cue) {
  return JSON.stringify([cue.speechId, cue.segmentId, cue.stage, cue.partId, cue.startAt, cue.endAt]);
}

// All paths are application assets. This loader never touches the standalone lab.
export async function loadEmotionBundle({ base = '/animationBanks/witch/', fetcher = fetch, signal } = {}) {
  const read = async file => {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file) || file.includes('..')) throw new Error('Invalid bank asset path');
    const response = await fetcher(base + file, { signal });
    if (!response.ok) throw new Error(`Bank asset unavailable: ${file} (${response.status})`);
    return response.json();
  };
  const [config, effects] = await Promise.all([read('banks.json'), read('effects.json')]);
  if (config.version !== 1 || effects.version !== 1 || !config.banks) throw new Error('Unsupported bank version');
  const expressions = new Map(), motions = new Map();
  await Promise.all(Object.values(config.banks).flatMap(bank => [
    ...bank.expressions.map(async item => {
      const doc = await read(item.file);
      if (doc.Type !== 'Live2D Expression' || !Array.isArray(doc.Parameters)
        || doc.Parameters.some(p => !Number.isFinite(p.Value) || p.Blend !== 'Overwrite')) throw new Error('Invalid expression');
      expressions.set(item.id, doc);
    }),
    ...bank.motions.map(async item => motions.set(item.id, compileMotion(await read(item.file)))),
  ]));
  for (const effect of Object.values(effects.effects)) {
    if (!/^effects\/[a-z-]+\.svg$/.test(effect.file)) throw new Error('Invalid symbol path');
  }
  return { config, effects, expressions, motions, base };
}

export function authoredIdleClips(bundle, parameters) {
  return bundle.config.banks.__idle__.motions.map(item => ({ name: item.id,
    duration: item.duration, weight: item.weight,
    sample(time) {
      const pose = {};
      for (const [id, value] of Object.entries(sampleMotion(bundle.motions.get(item.id), time))) {
        const key = POSE_CHANNELS[id], param = parameters.get(id);
        if (!key || !param) continue;
        const divisor = key.startsWith('head') ? 60 : key.startsWith('body') ? 5 : 2;
        // Idle face offsets use span/divisor, while torso offsets use *5.
        pose[key] = (value - param.defaultValue) * (key.startsWith('body') ? 1 / 5 : divisor / (param.max - param.min));
      }
      return pose;
    },
  }));
}

export class EmotionBankController {
  constructor(bundle, { parameters = new Map(), random = Math.random, getOptions = () => ({}) } = {}) {
    Object.assign(this, { bundle, parameters, random, getOptions });
    this.cues = []; this.seen = new Set(); this.lastMotions = new Map();
    this.cancelled = new Set();
    this.face = {}; this.offsets = {}; this.clock = 0; this.lastAudioTime = null;
    this.emotion = 'netral'; this.expression = null; this.motion = null; this.lastEnd = -Infinity;
  }
  queue(cue) {
    if (!cue?.speechId || this.cancelled.has(cue.speechId) || !Number.isFinite(cue.startAt) || !Number.isFinite(cue.endAt) || cue.endAt <= cue.startAt) return false;
    const id = cueIdentity(cue);
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value);
    this.cues.push({ ...cue, id }); this.cues.sort((a, b) => a.startAt - b.startAt);
    return true;
  }
  select(emotion, time) {
    const previous = this.emotion;
    this.emotion = BANK_MAPPING[emotion] ? emotion : 'netral';
    const bankId = BANK_MAPPING[this.emotion], bank = this.bundle.config.banks[bankId];
    let expressions = bank.expressions;
    if (['jengkel', 'kesal'].includes(emotion)) expressions = expressions.filter(e => e.id === 'furrowed-brows');
    // Expressions may repeat: excluding the last ordinary face would inflate rare effects.
    const selected = weightedChoice(expressions, null, this.random) ?? bank.expressions[0];
    this.expression = selected;
    this.expressionUntil = selected.holdMs ? time + selected.holdMs / 1000 : Infinity;
    this.pendingReaction = selected.cue ? { ...selected.cue } : null;
    if (emotion !== previous || !this.motion || this.clock >= this.motion.end) {
      let candidates = bank.motions;
      if (['bingung', 'penasaran'].includes(emotion)) {
        candidates = [this.bundle.config.banks.surprised.motions.find(m => m.id === 'curious-tilt')].filter(Boolean);
      }
      const item = weightedChoice(candidates, this.lastMotions.get(bankId), this.random);
      if (item) {
        this.motion = { item, start: this.clock, end: this.clock + item.duration,
          origin: { ...this.offsets } };
        this.lastMotions.set(bankId, item.id);
      }
    }
  }
  cancel(speechId) {
    for (const id of speechId ? [speechId] : this.cues.map(c => c.speechId)) this.cancelled.add(id);
    if (this.cancelled.size > 512) this.cancelled.delete(this.cancelled.values().next().value);
    this.cues = speechId ? this.cues.filter(c => c.speechId !== speechId) : [];
    if (speechId && this.activeCue?.speechId !== speechId) return;
    this.activeCue = null; this.pendingReaction = null; this.reaction = null;
    this.motion = null; this.expression = null; this.emotion = 'netral'; this.lastEnd = -Infinity;
    this.onClear?.();
  }
  update(time, delta) {
    const options = { ...BANK_DEFAULTS, ...this.getOptions() };
    if (options.enabled === 'off') { this.cancel(); return { voiced: false, event: null, motionActive: false }; }
    const cue = this.cues.find(c => c.startAt <= time && time < c.endAt);
    const voiced = Boolean(cue);
    const dt = voiced && time === this.lastAudioTime ? 0 : clamp(finite(delta), 0, 0.1);
    this.lastAudioTime = time; this.clock += dt;
    let event = null;
    if (cue && cue.id !== this.activeCue?.id) {
      this.select(cue.emotion, time); this.activeCue = cue;
      event = { ...cue, emotion: this.emotion, bankId: BANK_MAPPING[this.emotion] };
    }
    if (cue) { this.lastEnd = cue.endAt; this.reaction = null; }
    const nextStart = Math.min(Infinity, ...this.cues.filter(c => c.startAt > time).map(c => c.startAt));
    if (!voiced && this.pendingReaction && time >= this.lastEnd) {
      const duration = Math.min(0.6, finite(this.pendingReaction.duration, 0.6), nextStart - time);
      if (duration >= 0.15) this.reaction = { ...this.pendingReaction, start: time, end: time + duration };
      this.pendingReaction = null;
    }
    if (this.reaction && time >= this.reaction.end) this.reaction = null;
    if (this.expression && time >= this.expressionUntil) {
      const fallback = this.bundle.config.banks[BANK_MAPPING[this.emotion]].expressions.find(e => e.id === this.expression.fallback);
      this.expression = fallback ?? this.bundle.config.banks.neutral.expressions[0];
      this.expressionUntil = Infinity;
    }
    if (!voiced && nextStart - time > 0.4 && time >= this.lastEnd + 0.4) this.motion = null;
    if (!voiced && nextStart === Infinity && time >= this.lastEnd + 0.6 && this.activeCue) {
      this.activeCue = null; this.expression = null; this.motion = null; this.emotion = 'netral'; this.onClear?.();
    }
    // Only one authored motion owns the pose. Tone changes blend from its visible offsets.
    const targets = this.motion ? sampleMotion(this.bundle.motions.get(this.motion.item.id), this.clock - this.motion.start) : {};
    const weight = clamp(finite(options.poseStrength, 1), 0, 2) * (voiced ? clamp(finite(options.speechBlendWeight, 0.35), 0, 1) : 1)
      * (['jengkel', 'kesal'].includes(this.emotion) ? 0.55 : 1);
    const alpha = 1 - Math.exp(-dt / 0.12);
    for (const id of MOTION_CHANNELS) {
      const param = this.parameters.get(id);
      const value = param && Number.isFinite(targets[id]) ? (targets[id] - param.defaultValue) * weight : 0;
      this.offsets[id] = finite(this.offsets[id]) + (value - finite(this.offsets[id])) * alpha;
    }
    const neutral = this.bundle.expressions.get('neutral').Parameters;
    const doc = this.bundle.expressions.get(this.expression?.id)?.Parameters ?? neutral;
    const values = new Map(doc.map(p => [p.Id, p.Value]));
    for (const p of neutral) {
      const target = finite(values.get(p.Id), p.Value);
      const current = finite(this.face[p.Id], finite(this.parameters.get(p.Id)?.defaultValue));
      // Mutually exclusive eye switches must clear before another switch fades in.
      this.face[p.Id] = ['Param59', 'Param60'].includes(p.Id) && target === 0 ? 0 : current + (target - current) * alpha;
    }
    this.cues = this.cues.filter(c => c.endAt > time);
    return { voiced, event, motionActive: Boolean(this.motion && this.clock < this.motion.end) };
  }
  applyFace(model, blink = {}) {
    for (const [id, value] of Object.entries(this.face)) {
      if (id === 'ParamMouthOpenY' || id === 'Param46') continue;
      const param = this.parameters.get(id); if (!param) continue;
      const target = id.endsWith('Open') ? value * finite(blink[id], 1) : value;
      model.setParameterValueByIndex(param.index, clamp(target, param.min, param.max));
    }
  }
  applyOffsets(model) {
    for (const [id, offset] of Object.entries(this.offsets)) {
      const param = this.parameters.get(id); if (!param) continue;
      model.setParameterValueByIndex(param.index, clamp(model.getParameterValueByIndex(param.index) + offset, param.min, param.max));
    }
  }
  applyReaction(model, time) {
    const tongue = this.parameters.get('Param46');
    if (tongue) model.setParameterValueByIndex(tongue.index, tongue.defaultValue);
    if (!this.reaction || time < this.reaction.start || time >= this.reaction.end) return;
    const amount = Math.sin(Math.PI * (time - this.reaction.start) / (this.reaction.end - this.reaction.start));
    for (const [id, peak] of Object.entries({ [this.reaction.parameter]: this.reaction.peak, ...this.reaction.companions })) {
      const p = this.parameters.get(id); if (p) model.setParameterValueByIndex(p.index, clamp(p.defaultValue + (peak - p.defaultValue) * amount, p.min, p.max));
    }
  }
}
