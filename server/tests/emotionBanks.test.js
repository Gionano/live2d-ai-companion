import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { BANK_MAPPING, BANK_DEFAULTS, EmotionBankController, loadEmotionBundle,
  cueIdentity, isWitchModel, authoredIdleClips } from '../../src/emotionBanks.js';
import { ComicTimeline, ComicEffects, projectHeadAnchor } from '../../src/comicEffects.js';
import { IdleMotionController, IDLE_MOTION_BANK } from '../../src/idleMotion.js';
import { sampleMotion, weightedChoice } from '../../src/bankMotion.js';
import { VALID_EMOTIONS } from '../../src/expressionMap.js';
import { DEFAULT_EMOTION_TAG_MAP } from '../ttsExpression.js';

const base = new URL('../../public/animationBanks/witch/', import.meta.url);
const fetched = [];
const bundle = await loadEmotionBundle({ fetcher: async (url, options) => {
  fetched.push({ url, signal: options.signal });
  return { ok: true, json: async () => JSON.parse(await fs.readFile(new URL(url.replace('/animationBanks/witch/', ''), base), 'utf8')) };
} });
const ids = new Set([...bundle.expressions.values()].flatMap(doc => doc.Parameters.map(p => p.Id)));
for (const doc of bundle.motions.values()) for (const curve of doc.curves) ids.add(curve.id);
ids.add('ParamMouthOpenY'); ids.add('Param46');
const parameters = new Map([...ids].map((id, index) => [id, { id, index,
  min: id.includes('Angle') ? -30 : id.endsWith('Open') || /^Param(59|60|46)$/.test(id) ? 0 : -1,
  max: /^Param(59|60)$/.test(id) || id.includes('Angle') ? 30 : id.endsWith('Open') ? 2 : 1,
  defaultValue: id === 'ParamEyeLOpen' || id === 'ParamEyeROpen' ? 1 : 0 }]));
const cue = (emotion = 'sayang', startAt = 1, endAt = 2, extra = {}) =>
  ({ speechId: 'reply', segmentId: 0, stage: 'surface', partId: 'p1', emotion, startAt, endAt, ...extra });
const controller = (random = () => 0, getOptions) => new EmotionBankController(bundle, { parameters, random, getOptions });
function model() {
  const values = [...parameters.values()].map(p => p.defaultValue);
  return { values, getParameterValueByIndex: i => values[i], setParameterValueByIndex: (i, value) => { values[i] = value; } };
}

test('all avatar labels map to banks, including happy without expanding Fish vocabulary', () => {
  assert.deepEqual(Object.keys(BANK_MAPPING).sort(), VALID_EMOTIONS.slice().sort());
  assert.equal(DEFAULT_EMOTION_TAG_MAP.senang, '[happy]');
  assert.equal(BANK_MAPPING.kagum, 'happy');
  assert.equal(BANK_MAPPING.bingung, 'neutral');
  assert.equal(BANK_MAPPING.penasaran, 'neutral');
  for (const emotion of VALID_EMOTIONS) {
    const c = controller(); c.queue(cue(emotion)); c.update(1, 0.05);
    assert.equal(c.emotion, emotion);
    assert.ok(bundle.expressions.has(c.expression.id));
  }
});

test('published bundle contains only application expression/motion/symbol references', () => {
  assert.equal(bundle.expressions.size, 18); assert.equal(bundle.motions.size, 20);
  assert.equal(Object.keys(bundle.effects.effects).length, 7);
  assert.ok(fetched.every(r => r.url.startsWith('/animationBanks/witch/')));
  assert.equal(bundle.config.model, undefined);
  for (const doc of bundle.expressions.values()) {
    assert.ok(doc.Parameters.every(p => p.Id !== 'ParamMouthOpenY' && p.Id !== 'Param46'));
  }
  for (const motion of bundle.motions.values()) {
    for (const t of [0, motion.duration / 2, motion.duration]) assert.ok(Object.values(sampleMotion(motion, t)).every(Number.isFinite));
  }
  assert.ok(isWitchModel('/models/%E9%AD%94%E5%A5%B3/witch.model3.json'));
  assert.equal(isWitchModel('/models/live2d/IceGirl.model3.json'), false);
});

test('missing and aborted bundle loads reject before publishing an incomplete controller', async () => {
  await assert.rejects(loadEmotionBundle({ fetcher: async () => ({ ok: false, status: 404 }) }), /unavailable/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(loadEmotionBundle({ signal: abort.signal, fetcher: async (_, { signal }) => {
    signal.throwIfAborted();
  } }), { name: 'AbortError' });
});

test('a late model session cannot publish banks or replace the newer active model', async () => {
  const source = await fs.readFile(new URL('../../src/live2dCompanion.js', import.meta.url), 'utf8');
  const start = source.indexOf('  async switchModel(modelPath) {');
  const method = source.slice(start, source.indexOf('\n  getModelInfo()', start));
  const pending = [], created = [];
  class Model {
    constructor() { this.bankAbort = new AbortController(); created.push(this); }
    load() { return new Promise(resolve => pending.push(resolve)); }
    async loadBanks() { this.banksLoaded = true; }
    dispose() { this.disposed = true; }
    setFraming() {}
    getModelInfo() { return { modelName: 'fixture', parameterCount: 0, expressionCount: 0 }; }
  }
  const ctx = vm.createContext({ CompanionCubismModel: Model, getHalfBodyConfig: () => ({ scale: 1, x: 0, y: 0 }),
    URL, location: { href: 'http://localhost/' }, console: { log() {} },
    window: { dispatchEvent() {} }, CustomEvent: class {} });
  vm.runInContext(`class Companion { ${method} }; globalThis.Companion = Companion;`, ctx);
  const companion = new ctx.Companion(); companion.canvas = {};
  const first = companion.switchModel('/models/witch/old.model3.json');
  const second = companion.switchModel('/models/witch/new.model3.json');
  assert.equal(created[0].bankAbort.signal.aborted, true);
  pending[1](); await second;
  pending[0](); assert.equal(await first, null);
  assert.equal(companion.model, created[1]);
  assert.equal(created[0].banksLoaded, undefined); assert.equal(created[0].disposed, true);
});

test('audio cue identity is independent per sentence/stage; duplicate delivery does not restart motion', () => {
  const c = controller(); const first = cue(); c.queue(first);
  assert.equal(c.expression, null); c.update(0.9, 0.05); assert.equal(c.expression, null);
  assert.ok(c.update(1, 0.05).event); const motion = c.motion;
  assert.equal(c.queue({ ...first }), false); assert.equal(c.update(1.1, 0.05).event, null);
  const next = cue('sayang', 2, 3, { segmentId: 1, stage: 'deep', partId: 'p2' });
  assert.notEqual(cueIdentity(first), cueIdentity(next));
  c.queue(next); assert.ok(c.update(2, 0.05).event); assert.equal(c.motion, motion);
  c.queue(cue('marah', 3, 4, { segmentId: 2 })); c.update(3, 0.05); assert.notEqual(c.motion, motion);
});

test('weighted faces can repeat ordinary variants and preserve half-weight rare eyes', () => {
  const faces = bundle.config.banks.affectionate.expressions;
  assert.equal(faces.find(e => e.id === 'heart-eyes').weight, 0.5);
  assert.equal(bundle.config.banks.happy.expressions.find(e => e.id === 'star-eyes').weight, 0.5);
  const counts = new Map();
  for (let i = 0; i < 10000; i++) {
    const item = weightedChoice(faces, null, () => i / 10000);
    counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  }
  assert.ok(Math.abs(counts.get('heart-eyes') / counts.get('soft-smile') - 0.5) < 0.01);
  const c = controller(); c.queue(cue()); c.update(1, 0.1);
  c.queue(cue('sayang', 2, 3)); c.update(2, 0.1); assert.equal(c.expression.id, 'soft-smile');
});

test('bank faces retain blink masks, mouth ownership, mutually exclusive effects, and rig limits', () => {
  const c = controller(() => 0.99), m = model();
  c.queue(cue('sayang')); c.update(1, 0.1); c.applyFace(m, { ParamEyeLOpen: 0, ParamEyeROpen: 0.5 });
  assert.equal(m.values[parameters.get('ParamEyeLOpen').index], 0);
  const mouth = parameters.get('ParamMouthOpenY'); m.values[mouth.index] = 0.8;
  c.applyReaction(m, 1.1); assert.equal(m.values[mouth.index], 0.8);
  assert.ok(c.face.Param60 > 0);
  c.queue(cue('senang', 2, 3)); c.update(2, 0.1);
  assert.equal(c.face.Param60, 0); assert.ok(c.face.Param59 > 0);
  c.offsets.ParamAngleX = 1000; c.applyOffsets(m);
  assert.equal(m.values[parameters.get('ParamAngleX').index], 30);
  assert.doesNotThrow(() => new EmotionBankController(bundle).applyOffsets(m));
});

test('bank pose applies rig-unit offsets once at the configured voiced weight', () => {
  const full = controller(() => 0, () => ({ speechBlendWeight: 1 }));
  const blended = controller();
  full.queue(cue('marah', 0, 4)); blended.queue(cue('marah', 0, 4));
  for (let i = 0; i <= 60; i++) { full.update(i / 60, 1 / 60); blended.update(i / 60, 1 / 60); }
  for (const [id, value] of Object.entries(full.offsets)) if (Math.abs(value) > 0.001) {
    assert.ok(Math.abs(blended.offsets[id] / value - 0.35) < 1e-9);
  }
  const before = { ...full.offsets }; full.update(1, 1 / 60); assert.deepEqual(full.offsets, before, 'suspended audio freezes authored pose');
});

test('tongue/gasp use bounded quiet gaps, skip short gaps, and yield immediately to audio', () => {
  for (const emotion of ['jahil', 'terkejut']) {
    const c = controller(() => 0.99); c.queue(cue(emotion)); c.queue(cue('netral', 2.1, 3));
    c.update(1, 0.1); c.update(2, 0.1); assert.equal(c.reaction, null, '100 ms gap skipped');
    const long = controller(() => 0.99); long.queue(cue(emotion)); long.queue(cue('sayang', 2.4, 3));
    long.update(1, 0.1); long.update(2, 0.1); assert.ok(Math.abs(long.reaction.end - 2.4) < 1e-9);
    const m = model(); long.applyReaction(m, 2.2);
    assert.ok(m.values[parameters.get('ParamMouthOpenY').index] > 0);
    long.update(2.4, 0.1); assert.equal(long.reaction, null);
  }
});

test('cancel rejects pending playback and fades face/offsets back to neutral', () => {
  const c = controller(() => 0.99); let clears = 0; c.onClear = () => clears++;
  c.queue(cue('sayang')); c.queue(cue('marah', 3, 4)); c.update(1, 0.1);
  c.cancel('reply'); assert.equal(c.cues.length, 0); assert.equal(c.motion, null); assert.equal(c.reaction, null);
  for (let i = 0; i < 120; i++) c.update(2 + i / 60, 1 / 60);
  assert.equal(c.emotion, 'netral'); assert.ok(c.face.Param60 < 0.0001); assert.ok(clears > 0);
  assert.equal(c.update(3, 0.05).event, null);
  assert.equal(c.queue(cue('marah', 4, 5, { segmentId: 9 })), false, 'late cancelled audio cannot reanimate the model');
});

test('natural playback completion clears temporary expressions and permits the single idle scheduler', () => {
  const c = controller(); c.queue(cue('marah')); c.update(1, 0.1); c.update(2.7, 0.1);
  assert.equal(c.emotion, 'netral'); assert.equal(c.motion, null);
  const clips = [...IDLE_MOTION_BANK, ...authoredIdleClips(bundle, parameters)]; assert.equal(clips.length, 19);
  for (const clip of clips) {
    const idle = new IdleMotionController({ bank: [clip], random: () => 0 });
    for (let i = 0; i < 120; i++) idle.update(1 / 60);
    assert.equal(idle.current.name, clip.name);
    assert.ok(Object.values(idle.pose).every(Number.isFinite));
    idle.update(0.05, { speaking: true }); assert.equal(idle.current, null);
    for (let i = 0; i < 6; i++) idle.update(0.05);
    assert.equal(idle.current, null);
  }
});

test('authored bank/idle playback remains consistent at 30 and 60 FPS', () => {
  function run(fps) {
    const c = controller(); c.queue(cue('sayang', 0, 3));
    const idle = new IdleMotionController({ bank: authoredIdleClips(bundle, parameters), random: () => 0 });
    for (let i = 0; i < fps * 2; i++) { c.update((i + 1) / fps, 1 / fps); idle.update(1 / fps); }
    return { offsets: c.offsets, idle: idle.pose };
  }
  const a = run(30), b = run(60);
  for (const id of Object.keys(a.offsets)) assert.ok(Math.abs(a.offsets[id] - b.offsets[id]) < 0.06, id);
  for (const key of Object.keys(a.idle)) assert.ok(Math.abs(a.idle[key] - b.idle[key]) < 0.001, key);
});

test('comic timeline handles duration, cooldown, replacement, neutral/cancellation, and disabled configuration', () => {
  const t = new ComicTimeline();
  assert.ok(t.trigger({ emotion: 'marah', bankId: 'angry' }, 1));
  assert.equal(t.update(1.2, 0.2).alpha, 1);
  assert.equal(t.trigger({ emotion: 'marah', bankId: 'angry' }, 2), false);
  assert.ok(t.trigger({ emotion: 'kagum', bankId: 'happy' }, 2)); assert.equal(t.current.symbol, 'playful');
  t.update(3.6, 0.2); assert.equal(t.current, null);
  assert.ok(t.trigger({ emotion: 'marah', bankId: 'angry' }, 5));
  t.trigger({ emotion: 'penasaran', bankId: 'neutral' }, 5.1); assert.equal(t.current, null);
  t.clear(); assert.equal(t.update(5.3, 0.2).alpha, 0);
  assert.equal(new ComicTimeline(() => ({ comicEnabled: 'off' })).trigger({ emotion: 'marah' }, 0), false);
  assert.equal(BANK_DEFAULTS.symbolDurationMs, 1500);
});

test('comic projection uses final matrix and CSS dimensions without changing native bounds', () => {
  const matrix = [2, 0.2, 0, 0, 0.1, 2, 0, 0, 0, 0, 1, 0, -0.1, -0.2, 0, 1];
  const bounds = { minX: -0.5, maxX: 0.5, minY: -1, maxY: 1 };
  const rect = { left: 10, top: 20, width: 500, height: 600 };
  const a = projectHeadAnchor(matrix, bounds, {}, rect);
  const b = projectHeadAnchor(matrix, bounds, { ParamAngleX: 20 }, rect);
  assert.notEqual(a.x, b.x);
  assert.ok(a.x >= rect.left && a.x <= rect.left + rect.width);
  assert.ok(a.y >= rect.top && a.y <= rect.top + rect.height);
  assert.deepEqual(projectHeadAnchor(matrix, bounds, {}, { ...rect }), a, 'backing-pixel DPI does not affect CSS position');
  const dom = new JSDOM('<body></body>');
  const effects = new ComicEffects(bundle, () => ({}), dom.window.document);
  assert.equal(effects.layer.style.pointerEvents, 'none'); assert.equal(effects.image.style.pointerEvents, 'none');
  effects.trigger({ emotion: 'marah', bankId: 'angry' }, 1);
  effects.update(1.1, 0.1, matrix, bounds, {}, rect);
  assert.ok(effects.image.src.endsWith('/animationBanks/witch/effects/anger.svg'));
  effects.dispose(); assert.equal(dom.window.document.querySelector('.witch-comic-effects'), null);
  dom.window.close();
});
