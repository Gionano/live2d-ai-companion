// ---------------------------------------------------------------------------
// live2dCompanion.js  (browser-side)
// Official Live2D Cubism Web Framework adapter for this companion.
// Supports: emotion-driven expressions, hybrid talking animation
// (Layer 1: procedural audio-reactive, Layer 2: discrete motion clips),
// and synthetic face tracking (Simplex noise head/eye/brow).
// ---------------------------------------------------------------------------
import { CubismFramework, LogLevel, Option } from '@framework/live2dcubismframework';
import { CubismModelSettingJson } from '@framework/cubismmodelsettingjson';
import { CubismUserModel } from '@framework/model/cubismusermodel';
import { CubismEyeBlink } from '@framework/effect/cubismeyeblink';
import { BreathParameterData, CubismBreath } from '@framework/effect/cubismbreath';
import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { CubismMotionManager } from '@framework/motion/cubismmotionmanager';
import { EMOTION_MAP } from './expressionMap.js';
import { SyntheticTracker } from './syntheticTracking.js';
import { tuning } from './tuningConfig.js';

const MODEL_URL = '/models/live2d/IceGirl.model3.json';
const SHADER_PATH = '/vendor/live2d/shaders/';
const PRIORITY_IDLE = 1;
const PRIORITY_TALKING = 3;

// Helper fungsi untuk mapping ala VTube Studio
function mapVTS(value, config, multiplier = 1.0) {
  const t = (value - config.inMin) / (config.inMax - config.inMin);
  const out = config.outMin + t * (config.outMax - config.outMin);
  const finalValue = out * multiplier;
  return Math.max(config.limitMin, Math.min(config.limitMax, finalValue));
}

// Debug logging throttle for Layer 1 magnitude.
let lastL1LogTime = 0;
const L1_LOG_INTERVAL_MS = 2000;

// Combined layer debug log (all layers together).
let lastCombinedLogTime = 0;
const COMBINED_LOG_INTERVAL_MS = 5000;

function fetchBuffer(url) {
  return fetch(url).then((response) => {
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
    return response.arrayBuffer();
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Texture gagal dimuat: ${url}`));
    image.src = url;
  });
}

function initializeCubism() {
  if (!globalThis.Live2DCubismCore) {
    throw new Error('Cubism Core belum dimuat. Periksa /vendor/live2d/live2dcubismcore.min.js');
  }
  const option = new Option();
  option.logFunction = (message) => console.log(`[CubismCore] ${message}`);
  option.loggingLevel = LogLevel.LogLevel_Warning;
  CubismFramework.startUp(option);
  CubismFramework.initialize();
}

// EMA helper: compute alpha from target time constant and frame delta.
function emaAlpha(timeConstantMs, deltaSec) {
  return 1 - Math.exp((-deltaSec * 1000) / timeConstantMs);
}

class CompanionCubismModel extends CubismUserModel {
  constructor(gl, canvas, homeDir) {
    super();
    this.gl = gl;
    this.canvas = canvas;
    this.homeDir = homeDir;
    this.setting = null;
    this.expressions = new Map();
    this.motions = new Map();
    this.motionGroups = new Map();
    this.eyeBlink = null;
    this.breath = null;
    this.actionMotionManager = new CubismMotionManager();
    this.mouthParameterIndex = -1;
    this.smoothedMouth = 0;
    this.talking = false;
    this.actionStopping = false;
    this.physicsStats = null;
    this.physicsFrameCount = 0;
    this.ready = false;

    // --- Emotion state ---
    this.currentEmotion = 'netral';
    this.currentIntensity = 'sedang';

    // --- Layer 1: procedural audio-reactive ---
    this.l1Envelope = 0;       // smoothed audio level 0..1
    this.l1BodyX = 0;
    this.l1BodyY = 0;
    this.l1AngleY = 0;
    this.l1Time = 0;           // running timer for slight phase variation
    this.bodyXIndex = -1;
    this.bodyYIndex = -1;
    this.angleYIndex = -1;

    // --- Layer 2: discrete motion pool ---
    this.talkMotionPool = [];  // filled after motions load
    this.lastL2MotionKey = null;

    // --- Synthetic face tracking (always-on) ---
    this.syntheticTracker = new SyntheticTracker();
  }

  async load(modelFile) {
    const settingBuffer = await fetchBuffer(`${this.homeDir}${modelFile}`);
    this.setting = new CubismModelSettingJson(settingBuffer, settingBuffer.byteLength);

    const mocName = this.setting.getModelFileName();
    const moc = await fetchBuffer(`${this.homeDir}${mocName}`);
    this.loadModel(moc);

    await Promise.all([
      this.loadExpressions(),
      this.loadPhysicsFile(),
      this.loadMotionGroups(),
    ]);

    const blinkIds = [];
    for (let i = 0; i < this.setting.getEyeBlinkParameterCount(); i++) {
      blinkIds.push(this.setting.getEyeBlinkParameterId(i));
    }
    if (blinkIds.length) {
      this.eyeBlink = CubismEyeBlink.create(this.setting);
      this.eyeBlink.setParameterIds(blinkIds);
      console.log(`[Live2D] Eye blink controller active: ${blinkIds.length} params`);
    } else {
      console.warn('[Live2D] Eye blink controller inactive: no EyeBlink IDs in model3.json');
    }

    this.setupBreath();

    const idMgr = CubismFramework.getIdManager();
    const mouthId = idMgr.getId('ParamMouthOpenY');
    this.mouthParameterIndex = this._model.getParameterIndex(mouthId);
    console.log('[Live2D] Mouth parameter:', this.mouthParameterIndex >= 0 ? 'ParamMouthOpenY' : '(tidak ditemukan)');

    // Resolve Layer 1 parameter indices.
    this.bodyXIndex = this._model.getParameterIndex(idMgr.getId('ParamBodyX'));
    this.bodyYIndex = this._model.getParameterIndex(idMgr.getId('ParamBodyY'));
    this.angleYIndex = this._model.getParameterIndex(idMgr.getId('ParamAngleY'));
    console.log(`[Live2D] Layer 1 params: BodyX=${this.bodyXIndex}, BodyY=${this.bodyYIndex}, AngleY=${this.angleYIndex}`);

    // Resolve synthetic tracking parameter indices.
    this.syntheticTracker.resolveIndices(this._model, idMgr);

    this._model.saveParameters();
    this.createRenderer(this.canvas.width, this.canvas.height);
    this.getRenderer().startUp(this.gl);
    this.getRenderer().setIsPremultipliedAlpha(true);
    await this.loadTextures();
    this.getRenderer().loadShaders(SHADER_PATH);
    this.ready = true;
    this.startIdleMotion();

    // Re-setup breath in real-time when breathing parameters change
    tuning.onChange((group) => {
      if (group === 'idle') {
        this.setupBreath();
      }
    });
  }

  async loadExpressions() {
    const count = this.setting.getExpressionCount();
    const jobs = [];
    for (let i = 0; i < count; i++) {
      const name = this.setting.getExpressionName(i);
      const file = this.setting.getExpressionFileName(i);
      jobs.push(fetchBuffer(`${this.homeDir}${file}`).then((buffer) => {
        this.expressions.set(name, this.loadExpression(buffer, buffer.byteLength, name));
      }));
    }
    await Promise.all(jobs);
    console.log('[Live2D] Expression .exp3.json terdeteksi:', [...this.expressions.keys()]);
  }

  async loadPhysicsFile() {
    const file = this.setting.getPhysicsFileName();
    if (!file) {
      console.warn('[Live2D] Physics controller inactive: no Physics reference in model3.json');
      return;
    }
    try {
      const buffer = await fetchBuffer(`${this.homeDir}${file}`);
      const json = JSON.parse(new TextDecoder().decode(buffer));
      const settings = json.PhysicsSettings ?? [];
      this.physicsStats = {
        file,
        rigs: settings.length,
        inputs: settings.reduce((sum, item) => sum + (item.Input?.length ?? 0), 0),
        outputs: settings.reduce((sum, item) => sum + (item.Output?.length ?? 0), 0),
        particles: settings.reduce((sum, item) => sum + (item.Vertices?.length ?? 0), 0),
      };
      this.loadPhysics(buffer, buffer.byteLength);
      if (!this._physics) throw new Error('CubismPhysics.create() returned null');
      console.log(
        `[Live2D] Physics loaded: ${file} | ${this.physicsStats.rigs} rigs,` +
          ` ${this.physicsStats.inputs} inputs, ${this.physicsStats.outputs} output params,` +
          ` ${this.physicsStats.particles} particles`,
      );
    } catch (error) {
      console.error(`[Live2D] Physics load failed: ${file}`, error);
      throw error;
    }
  }

  setupBreath() {
    const id = (name) => CubismFramework.getIdManager().getId(name);
    this.breath = CubismBreath.create();
    const b = tuning.group('idle');
    this.breath.setParameters([
      new BreathParameterData(id('ParamAngleX'), 0, b.angleXPeak ?? 8, b.angleXCycle ?? 6.5345, b.angleXWeight ?? 0.35),
      new BreathParameterData(id('ParamAngleY'), 0, b.angleYPeak ?? 5, b.angleYCycle ?? 3.5345, b.angleYWeight ?? 0.3),
      new BreathParameterData(id('ParamAngleZ'), 0, b.angleZPeak ?? 6, b.angleZCycle ?? 5.5345, b.angleZWeight ?? 0.3),
      new BreathParameterData(id('ParamBreath'), b.chestOffset ?? 0.5, b.chestPeak ?? 0.5, b.chestCycle ?? 3.2345, b.chestWeight ?? 1),
    ]);
    console.log('[Live2D] Breath controller active: ParamBreath + ParamAngleX/Y/Z');
  }

  async loadMotionGroups() {
    const jobs = [];
    for (let g = 0; g < this.setting.getMotionGroupCount(); g++) {
      const group = this.setting.getMotionGroupName(g);
      const names = [];
      for (let i = 0; i < this.setting.getMotionCount(group); i++) {
        const file = this.setting.getMotionFileName(group, i);
        const key = `${group}_${i}`;
        names.push(key);
        jobs.push(fetchBuffer(`${this.homeDir}${file}`).then((buffer) => {
          const motion = this.loadMotion(buffer, buffer.byteLength, key, null, null, this.setting, group, i);
          if (motion) {
            motion.setEffectIds([], [CubismFramework.getIdManager().getId('ParamMouthOpenY')]);
            this.motions.set(key, motion);
          }
        }));
      }
      this.motionGroups.set(group.toLowerCase(), names);
    }
    await Promise.all(jobs);
    console.log('[Live2D] Motion groups:', Object.fromEntries(this.motionGroups));

    // Build Layer 2 talk motion pool from Special group only (to avoid hand movements).
    for (const group of ['special']) {
      const keys = this.motionGroups.get(group) ?? [];
      for (const key of keys) {
        if (this.motions.has(key)) this.talkMotionPool.push(key);
      }
    }
    console.log('[Live2D] Layer 2 talk motion pool:', this.talkMotionPool);
  }

  async loadTextures() {
    const renderer = this.getRenderer();
    for (let i = 0; i < this.setting.getTextureCount(); i++) {
      const image = await loadImage(`${this.homeDir}${this.setting.getTextureFileName(i)}`);
      const texture = this.gl.createTexture();
      this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR_MIPMAP_LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
      this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, image);
      this.gl.generateMipmap(this.gl.TEXTURE_2D);
      this.gl.bindTexture(this.gl.TEXTURE_2D, null);
      renderer.bindTexture(i, texture);
    }
  }

  // ---------------------------------------------------------------------------
  // Expression control
  // ---------------------------------------------------------------------------
  setExpression(name) {
    if (name === 'netral' || name === 'neutral' || name === null) {
      this._expressionManager.stopAllMotions();
      return;
    }
    const motion = this.expressions.get(name);
    if (motion) this._expressionManager.startMotion(motion, false);
  }

  /** Set emotion from LLM (Indonesian key) → maps to Live2D expression. */
  setEmotion(emotion) {
    const entry = EMOTION_MAP[emotion];
    if (!entry) {
      console.warn(`[Live2D] Emotion tidak dikenal: "${emotion}", fallback ke netral`);
      this.currentEmotion = 'netral';
      this.currentIntensity = 'sedang';
      this.setExpression(null);
      return;
    }

    this.currentEmotion = emotion;
    this.currentIntensity = entry.intensity;

    if (entry.expression === null) {
      this.setExpression(null);
    } else if (this.expressions.has(entry.expression)) {
      this.setExpression(entry.expression);
      console.log(`[Live2D] Emotion "${emotion}" → expression "${entry.expression}" (intensity: ${entry.intensity})`);
    } else {
      console.warn(`[Live2D] Expression "${entry.expression}" tidak ada di model, fallback ke netral`);
      this.setExpression(null);
    }
  }

  getCurrentIntensityMultiplier() {
    const key = `talking.intensity${this.currentIntensity.charAt(0).toUpperCase() + this.currentIntensity.slice(1)}`;
    return tuning.get(key) ?? 1.0;
  }

  // ---------------------------------------------------------------------------
  // Motion control
  // ---------------------------------------------------------------------------
  motionFor(kind) {
    const group = kind === 'talking' ? 'talking' : 'idle';
    const key = this.motionGroups.get(group)?.find((name) => this.motions.has(name));
    return key ? { key, motion: this.motions.get(key) } : null;
  }

  startIdleMotion() {
    const found = this.motionFor('idle');
    if (!found) {
      console.warn('[Live2D] Idle motion unavailable');
      return;
    }
    found.motion.setLoop(true);
    found.motion.setLoopFadeIn(false);
    found.motion.setFadeInTime(0.45);
    this._motionManager.stopAllMotions();
    this._motionManager.startMotionPriority(found.motion, false, PRIORITY_IDLE);
    console.log(`[Live2D] Idle motion looping: ${found.key}`);
  }

  startTalkingMotion() {
    const found = this.motionFor('talking');
    if (!found) {
      console.warn('[Live2D] Talking motion unavailable; idle remains active');
      return;
    }
    found.motion.setLoop(true);
    found.motion.setLoopFadeIn(false);
    found.motion.setFadeInTime(0.3);
    found.motion.setFadeOutTime(0.4);
    this.actionMotionManager.stopAllMotions();
    this.actionMotionManager.startMotionPriority(found.motion, false, PRIORITY_TALKING);
    this.actionStopping = false;
    console.log(`[Live2D] Talking motion layered over idle: ${found.key}`);
  }

  stopTalkingMotion() {
    if (this.actionMotionManager.isFinished()) return;
    this.actionMotionManager.stopAllMotions();
    this.actionStopping = true;
    console.log('[Live2D] Talking motion fading out; idle/physics/breath continue');
  }

  // ---------------------------------------------------------------------------
  // Layer 2: trigger a discrete motion clip at sentence breaks.
  // ---------------------------------------------------------------------------
  triggerTalkMotion() {
    if (this.talkMotionPool.length === 0) return;

    // Bias: intensity rendah → sering skip; tinggi → hampir selalu trigger.
    const probKey = `talking.l2Prob${this.currentIntensity.charAt(0).toUpperCase() + this.currentIntensity.slice(1)}`;
    const prob = tuning.get(probKey) ?? 0.55;
    if (Math.random() > prob) {
      console.log(`[Live2D L2] Skip motion (prob ${prob.toFixed(2)}, intensity: ${this.currentIntensity})`);
      return;
    }

    // Pick random, avoid repeating the last one.
    let candidates = this.talkMotionPool.filter((k) => k !== this.lastL2MotionKey);
    if (candidates.length === 0) candidates = this.talkMotionPool;
    const key = candidates[Math.floor(Math.random() * candidates.length)];
    const motion = this.motions.get(key);
    if (!motion) return;

    motion.setLoop(false);
    motion.setFadeInTime(0.25);
    motion.setFadeOutTime(0.35);
    this.actionMotionManager.startMotionPriority(motion, false, PRIORITY_TALKING);
    this.lastL2MotionKey = key;
    console.log(`[Live2D L2] Triggered sentence-break motion: ${key} (intensity: ${this.currentIntensity})`);
  }

  // ---------------------------------------------------------------------------
  // Layer 1: procedural audio-reactive body movement.
  // Smooths the mouth level with asymmetric EMA (fast attack, slow release),
  // then drives ParamBodyX/Y and ParamAngleY with small, natural offsets.
  // ---------------------------------------------------------------------------
  updateLayer1(delta, mouthLevel) {
    // Asymmetric EMA: use fast alpha when level is rising, slow when falling.
    const target = Math.max(0, Math.min(1, mouthLevel));
    const rising = target > this.l1Envelope;
    const alpha = emaAlpha(rising ? tuning.get('talking.l1AttackMs') : tuning.get('talking.l1ReleaseMs'), delta);
    this.l1Envelope += (target - this.l1Envelope) * alpha;

    this.l1Time += delta;
    const env = this.l1Envelope;
    const mult = this.getCurrentIntensityMultiplier();

    // Read sine frequencies and phases from tuning config
    const sineX = Math.sin(this.l1Time * tuning.get('talking.l1SineFreqX') + tuning.get('talking.l1PhaseX'));
    const sineY = Math.sin(this.l1Time * tuning.get('talking.l1SineFreqY') + tuning.get('talking.l1PhaseY'));
    const sineAngle = Math.sin(this.l1Time * tuning.get('talking.l1SineFreqAngle') + tuning.get('talking.l1PhaseAngle'));

    // Build VTS configs from tuning
    const bodyXRange = tuning.get('talking.l1BodyXRange');
    const bodyYRange = tuning.get('talking.l1BodyYRange');
    const angleYOutRange = tuning.get('talking.l1AngleYOutRange');
    const L1_BODY_X_CONFIG = { inMin: -1, inMax: 1, outMin: -bodyXRange, outMax: bodyXRange, limitMin: -bodyXRange, limitMax: bodyXRange };
    const L1_BODY_Y_CONFIG = { inMin: -1, inMax: 1, outMin: -bodyYRange, outMax: bodyYRange, limitMin: -10, limitMax: 10 };
    const L1_ANGLE_Y_CONFIG = { inMin: -1, inMax: 1, outMin: -angleYOutRange, outMax: angleYOutRange, limitMin: tuning.get('talking.l1AngleYLimitMin'), limitMax: tuning.get('talking.l1AngleYLimitMax') };

    const bodyX = mapVTS(env * sineX, L1_BODY_X_CONFIG, mult);
    const bodyY = mapVTS(env * sineY, L1_BODY_Y_CONFIG, mult);
    const angleY = mapVTS(env * sineAngle, L1_ANGLE_Y_CONFIG, mult);

    this.l1BodyX = bodyX;
    this.l1BodyY = bodyY;
    this.l1AngleY = angleY;

    // Apply additively AFTER breath (which also touches AngleY).
    if (this.bodyXIndex >= 0) {
      const cur = this._model.getParameterValueByIndex(this.bodyXIndex);
      this._model.setParameterValueByIndex(this.bodyXIndex, cur + bodyX);
    }
    if (this.bodyYIndex >= 0) {
      const cur = this._model.getParameterValueByIndex(this.bodyYIndex);
      this._model.setParameterValueByIndex(this.bodyYIndex, cur + bodyY);
    }
    if (this.angleYIndex >= 0) {
      const cur = this._model.getParameterValueByIndex(this.angleYIndex);
      this._model.setParameterValueByIndex(this.angleYIndex, cur + angleY);
    }

    // Throttled debug log.
    const now = performance.now();
    if (now - lastL1LogTime > L1_LOG_INTERVAL_MS && env > 0.01) {
      lastL1LogTime = now;
      console.log(
        `[Live2D L1] env=${env.toFixed(3)} mult=${mult.toFixed(1)}` +
        ` | bodyX=${bodyX.toFixed(2)} bodyY=${bodyY.toFixed(2)} angleY=${angleY.toFixed(2)}` +
        ` | emotion=${this.currentEmotion} (${this.currentIntensity})`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Main update loop
  // ---------------------------------------------------------------------------
  update(delta, mouthLevel, speaking) {
    if (!this.ready) return;
    if (speaking !== this.talking) {
      this.talking = speaking;
      // We no longer trigger looping talking motions (which cause hand waving)
      // because we rely purely on Layer 1 (procedural sway) and Layer 2 (sentence-break clips).
    }

    this._model.loadParameters();

    if (this._motionManager.isFinished()) this.startIdleMotion();
    this._motionManager.updateMotion(this._model, delta);
    this._model.saveParameters();

    if (!this.actionMotionManager.isFinished()) {
      this.actionMotionManager.updateMotion(this._model, delta);
    } else if (this.actionStopping) {
      this.actionStopping = false;
      console.log('[Live2D] Talking motion stopped; idle motion still looping');
    }

    if (this.eyeBlink) this.eyeBlink.updateParameters(this._model, delta);
    this._expressionManager.updateMotion(this._model, delta);
    if (this.breath) this.breath.updateParameters(this._model, delta);

    // Lip sync smoothing.
    this.smoothedMouth +=
      (Math.max(0, Math.min(1, mouthLevel)) - this.smoothedMouth) *
      (1 - Math.exp(-tuning.get('talking.lipSyncSmoothing') * delta));
    if (this.mouthParameterIndex >= 0) {
      this._model.setParameterValueByIndex(this.mouthParameterIndex, this.smoothedMouth);
    }

    // Layer 1: procedural audio-reactive body sway (only while speaking).
    if (speaking) {
      this.updateLayer1(delta, mouthLevel);
    } else if (this.l1Envelope > 0.001) {
      // Decay to zero when not speaking.
      this.updateLayer1(delta, 0);
    }

    // Synthetic face tracking: always active (idle + talking), additive.
    this.syntheticTracker.update(this._model, delta);

    // Combined layer debug log (throttled).
    const now = performance.now();
    if (now - lastCombinedLogTime > COMBINED_LOG_INTERVAL_MS) {
      lastCombinedLogTime = now;
      const st = this.syntheticTracker.lastOutputs;
      const l1Active = this.l1Envelope > 0.01;
      console.log(
        `[Live2D Layers] emotion=${this.currentEmotion}(${this.currentIntensity})` +
        ` | breath=active` +
        ` | tracking: head(${st.headX?.toFixed(1) ?? '-'},${st.headY?.toFixed(1) ?? '-'},${st.headZ?.toFixed(1) ?? '-'})` +
        ` eye(${st.eyeX?.toFixed(2) ?? '-'},${st.eyeY?.toFixed(2) ?? '-'})` +
        ` brow(${st.browL?.toFixed(3) ?? '-'},${st.browR?.toFixed(3) ?? '-'})` +
        ` | talking-L1=${l1Active ? `env=${this.l1Envelope.toFixed(3)}` : 'off'}`,
      );
    }

    if (this._physics) {
      this._physics.evaluate(this._model, delta);
      this.physicsFrameCount++;
      if (this.physicsFrameCount === 1) {
        console.log(
          `[Live2D] Physics evaluating every frame: ${this.physicsStats?.outputs ?? '?'} output params`,
        );
      }
    }
    this._model.update();
  }

  draw() {
    if (!this.ready) return;
    const projection = new CubismMatrix44();
    const { width, height } = this.canvas;
    if (this._model.getCanvasWidth() > 1 && width < height) {
      this.getModelMatrix().setWidth(2);
      projection.scale(1, width / height);
    } else {
      projection.scale(height / width, 1);
    }
    projection.multiplyByMatrix(this.getModelMatrix());
    const renderer = this.getRenderer();
    renderer.setMvpMatrix(projection);
    renderer.setRenderState(null, [0, 0, width, height]);
    renderer.drawModel(SHADER_PATH);
  }
}

// ---------------------------------------------------------------------------
// Public companion class
// ---------------------------------------------------------------------------
export class Live2DCompanion {
  constructor(canvas, statusElement) {
    this.canvas = canvas;
    this.status = statusElement;
    this.model = null;
    this.gl = null;
    this.lastFrame = performance.now();
    this.emotionEndsAt = 0;
  }

  async initialize() {
    initializeCubism();
    this.gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true });
    if (!this.gl) throw new Error('Browser tidak mendukung WebGL2 yang dibutuhkan Cubism SDK ini.');
    this.resize();
    const url = new URL(MODEL_URL, location.href);
    const file = url.pathname.split('/').pop();
    const homeDir = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
    this.model = new CompanionCubismModel(this.gl, this.canvas, homeDir);
    await this.model.load(file);
    this.status.textContent = 'Live2D siap — uji expression atau lip-sync.';
    window.__live2dCompanion = this;

    // Listen for sentence break events from companion.js (Layer 2 trigger).
    window.addEventListener('waifu-sentence-break', () => {
      if (this.model?.talking) {
        this.model.triggerTalkMotion();
      }
    });

    requestAnimationFrame((time) => this.frame(time));
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.model?.setRenderTargetSize(width, height);
    }
  }

  frame(time) {
    const delta = Math.min(0.05, Math.max(0, (time - this.lastFrame) / 1000));
    this.lastFrame = time;
    this.resize();
    const mouth = window.__waifuLipSync?.() ?? window.__live2dTestLevel?.() ?? 0;
    const speaking = window.__waifuIsSpeaking?.() ?? Boolean(window.__live2dTestSpeaking);
    const audioTime = window.__waifuAudioTime?.() ?? 0;
    if (this.emotionEndsAt && audioTime >= this.emotionEndsAt) {
      this.model?.setEmotion('netral');
      this.emotionEndsAt = 0;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.model?.update(delta, mouth, speaking);
    this.model?.draw();
    requestAnimationFrame((next) => this.frame(next));
  }

  setEmotion(emotion) {
    this.emotionEndsAt = 0;
    this.model?.setEmotion(emotion);
  }

  setEmotionCue(emotion, endAt) {
    this.emotionEndsAt = endAt || 0;
    this.model?.setEmotion(emotion);
  }

  setExpression(name) {
    this.model?.setExpression(name);
  }

  getExpressionNames() {
    return [...(this.model?.expressions.keys() ?? [])];
  }
}
