// ---------------------------------------------------------------------------
// live2dCompanion.js  (browser-side)
// Official Live2D Cubism Web Framework adapter for this companion.
// Supports emotion expressions, speech-timed gesture banks and subtle idle movement.
// ---------------------------------------------------------------------------
import { CubismFramework, LogLevel, Option } from '@framework/live2dcubismframework';
import { CubismModelSettingJson } from '@framework/cubismmodelsettingjson';
import { CubismUserModel } from '@framework/model/cubismusermodel';
import { CubismEyeBlink } from '@framework/effect/cubismeyeblink';
import { BreathParameterData, CubismBreath } from '@framework/effect/cubismbreath';
import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { CubismMotionManager } from '@framework/motion/cubismmotionmanager';
import { EMOTION_MAP } from './expressionMap.js';
import { SpeechMotionController, resolveMotionParameters, resolveModelCapabilities, applyMotionOffsets, bodyLeanTransform, bodyLeanMargin } from './speechMotion.js';
import { BodyMotionController, resolvePhysicsBodyParameters, prepareBodyPhysics } from './bodyMotion.js';
import { SyntheticTracker } from './syntheticTracking.js';
import { tuning } from './tuningConfig.js';

// Konfigurasi Framing Half Body (Langsung & Permanen)
export const HALF_BODY_FRAMING = {
  desktop: { scale: 1.45, x: 0.0, y: -0.50 },
  mobile: { scale: 1.45, x: 0.0, y: -0.40 },
};

// Batas FPS saat berjalan di mode overlay (?mode=overlay) — mudah diubah
export const OVERLAY_FPS_LIMIT = 30;

export function isOverlayMode() {
  return new URLSearchParams(window.location.search).get('mode') === 'overlay';
}

export function getHalfBodyConfig() {
  if (isOverlayMode()) return HALF_BODY_FRAMING.desktop;
  return window.innerWidth <= 768 ? HALF_BODY_FRAMING.mobile : HALF_BODY_FRAMING.desktop;
}

const MODEL_URL = '/models/live2d/IceGirl.model3.json';
const SHADER_PATH = '/vendor/live2d/shaders/';
const PRIORITY_IDLE = 1;
const PRIORITY_TALKING = 3;

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
    this.textures = [];

    // --- Camera / Viewport framing ---
    this.currentFraming = { scale: 1.0, x: 0.0, y: 0.0 };
    this.targetFraming = { scale: 1.0, x: 0.0, y: 0.0 };

    // --- Parameter Availability Map (Requirement 4) ---
    this.availableParams = new Map();
    this.parametersList = [];

    // --- Emotion state ---
    this.currentEmotion = 'netral';
    this.currentIntensity = 'sedang';

    this.motionParameters = {};
    this.physicsOutputs = new Set();
    this.bodyMotion = null;
    this.speechPose = {};
    this.speechBounds = { minX: -0.5, maxX: 0.5, minY: -0.2, maxY: 0.65 };
    this.speechMotion = new SpeechMotionController({ getOptions: () => ({
      strength: tuning.get('talking.gestureStrength'),
      frequency: tuning.get('talking.gestureFrequency'),
      smoothingMs: tuning.get('talking.gestureSmoothingMs'),
    }) });
    this._unsubscribeTuning = tuning.onChange((group) => {
      if (group === 'idle' && this.ready) this.setupBreath();
    });

    // --- Synthetic face tracking (always-on) ---
    this.syntheticTracker = new SyntheticTracker();

    // --- Overlay Fit-to-Bounds & Preset state (?mode=overlay only) ---
    this.isOverlay = isOverlayMode();
    this.wingParamIndex = -1;
    this.wingExpressionName = '翅膀';
    this.hiddenHalfBodyPartIds = [];
    this.hiddenHalfBodyPartIndices = [];
    this.overlayPresetId = 'with-wings';
    this.overlayShowWings = true;
    this.overlayPresetConfig = null;
    this.measuredPresetBounds = new Map();
    this.lastOverlayFitSummary = null;
    this._pendingDiagReason = 'initial-load';
    this._pendingDiagFrames = 0;
  }

  scanParameters() {
    this.availableParams.clear();
    this.parametersList = [];
    const count = this._model.getParameterCount();
    for (let i = 0; i < count; i++) {
      const idHandle = this._model.getParameterId(i);
      const idStr = idHandle.getString();
      const min = this._model.getParameterMinimumValue(i);
      const max = this._model.getParameterMaximumValue(i);
      const def = this._model.getParameterDefaultValue(i);
      const info = { id: idStr, index: i, min, max, defaultValue: def };
      this.availableParams.set(idStr, info);
      this.parametersList.push(info);
    }
    console.log(`[Live2D] Auto-detected ${this.parametersList.length} parameters from core model.`);
  }

  hasParameter(id) {
    return this.availableParams.has(id);
  }

  async load(modelFile) {
    const settingBuffer = await fetchBuffer(`${this.homeDir}${modelFile}`);
    this.setting = new CubismModelSettingJson(settingBuffer, settingBuffer.byteLength);

    const mocName = this.setting.getModelFileName();
    const moc = await fetchBuffer(`${this.homeDir}${mocName}`);
    this.loadModel(moc);

    // Auto-detect all parameters from core model (Requirement 3 & 4)
    this.scanParameters();

    await Promise.all([
      this.loadExpressions(),
      this.loadPhysicsFile(),
      this.loadMotionGroups(),
    ]);

    const declaredBlinkIds = [];
    for (let i = 0; i < this.setting.getEyeBlinkParameterCount(); i++) {
      declaredBlinkIds.push(this.setting.getEyeBlinkParameterId(i).getString());
    }
    const capabilities = resolveModelCapabilities(this.availableParams, {
      blinkIds: declaredBlinkIds,
      wingExpressionRegistered: this.expressions.has(this.wingExpressionName),
    });
    const idMgr = CubismFramework.getIdManager();
    const blinkIds = capabilities.blinkIds.map(id => idMgr.getId(id));
    if (blinkIds.length) {
      this.eyeBlink = CubismEyeBlink.create(this.setting);
      this.eyeBlink.setParameterIds(blinkIds);
      console.log(`[Live2D] Eye blink controller active: ${blinkIds.length} params`);
    } else {
      console.warn('[Live2D] Model ini tidak punya parameter EyeBlink, fitur auto-blink dinonaktifkan.');
    }

    this.setupBreath();

    this.mouthParameterIndex = this.availableParams.get('ParamMouthOpenY')?.index ?? -1;
    if (this.mouthParameterIndex >= 0) {
      console.log('[Live2D] Mouth parameter: ParamMouthOpenY aktif.');
    } else {
      console.warn('[Live2D] Model ini tidak punya ParamMouthOpenY, fitur lip-sync mulut dinonaktifkan.');
    }

    this.motionParameters = resolveMotionParameters(this.availableParams, this.physicsOutputs);
    this.hasRiggedBody = capabilities.hasBodyRig;
    console.log('[Live2D] Speech motion controls:', Object.fromEntries(
      Object.entries(this.motionParameters).map(([key, param]) => [key, param?.id ?? null]),
    ));

    // Resolve wing parameter (Param41 / 翅膀.exp3.json) & half-body hidden leg parts for overlay mode
    this.wingParamIndex = capabilities.wingParameterIndex;
    this.hiddenHalfBodyPartIndices = [];
    for (const partIdStr of this.hiddenHalfBodyPartIds) {
      const pIdx = this._model.getPartIndex(idMgr.getId(partIdStr));
      if (pIdx >= 0) {
        this.hiddenHalfBodyPartIndices.push(pIdx);
      }
    }

    this._model.saveParameters();

    if (this.isOverlay) {
      this.measureRestPoseOverlayBounds();
    }

    this._model.update();
    this.speechBounds = this.measureVisibleBounds();
    this.createRenderer(this.canvas.width, this.canvas.height);
    this.getRenderer().startUp(this.gl);
    this.getRenderer().setIsPremultipliedAlpha(true);
    await this.loadTextures();
    this.getRenderer().loadShaders(SHADER_PATH);
    this.ready = true;
    this.startIdleMotion();
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
      this.physicsOutputs = new Set(settings.flatMap(item => (item.Output ?? []).map(output => output.Destination?.Id)));
      const bodyParameters = resolvePhysicsBodyParameters(this.availableParams, this.physicsOutputs);
      this.bodyMotion = new BodyMotionController(bodyParameters, { getOptions: () => ({
        strength: tuning.get('talking.bodyGestureStrength'),
      }) });
      this.physicsStats = {
        file,
        rigs: settings.length,
        inputs: settings.reduce((sum, item) => sum + (item.Input?.length ?? 0), 0),
        outputs: settings.reduce((sum, item) => sum + (item.Output?.length ?? 0), 0),
        particles: settings.reduce((sum, item) => sum + (item.Vertices?.length ?? 0), 0),
      };
      const prepared = new TextEncoder().encode(JSON.stringify(prepareBodyPhysics(json, bodyParameters)));
      this.loadPhysics(prepared.buffer, prepared.byteLength);
      if (!this._physics) throw new Error('CubismPhysics.create() returned null');
      console.log(
        `[Live2D] Physics loaded: ${file} | ${this.physicsStats.rigs} rigs,` +
          ` ${this.physicsStats.inputs} inputs, ${this.physicsStats.outputs} output params,` +
          ` ${this.physicsStats.particles} particles`,
      );
    } catch (error) {
      this.physicsOutputs.clear();
      this.bodyMotion = null;
      console.error(`[Live2D] Physics load failed: ${file}`, error);
    }
  }

  setupBreath() {
    const id = (name) => CubismFramework.getIdManager().getId(name);
    const value = (key, fallback) => tuning.get(`idle.${key}`) ?? fallback;
    const breathParams = [];
    if (this.hasParameter('ParamAngleX')) {
      breathParams.push(new BreathParameterData(id('ParamAngleX'), 0, value('angleXPeak', 8), value('angleXCycle', 6.5345), value('angleXWeight', 0.35)));
    }
    if (this.hasParameter('ParamAngleY')) {
      breathParams.push(new BreathParameterData(id('ParamAngleY'), 0, value('angleYPeak', 5), value('angleYCycle', 3.5345), value('angleYWeight', 0.3)));
    }
    if (this.hasParameter('ParamAngleZ')) {
      breathParams.push(new BreathParameterData(id('ParamAngleZ'), 0, value('angleZPeak', 6), value('angleZCycle', 5.5345), value('angleZWeight', 0.3)));
    }
    if (this.hasParameter('ParamBreath')) {
      breathParams.push(new BreathParameterData(id('ParamBreath'), value('chestOffset', 0.5), value('chestPeak', 0.5), value('chestCycle', 3.2345), value('chestWeight', 1)));
    }

    if (breathParams.length > 0) {
      this.breath = CubismBreath.create();
      this.breath.setParameters(breathParams);
      console.log(`[Live2D] Breath controller active with ${breathParams.length} parameters`);
    } else {
      console.warn('[Live2D] Model ini tidak punya parameter napas (ParamBreath / ParamAngleX/Y/Z), fitur breath dinonaktifkan.');
    }
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

  }

  async loadTextures() {
    const renderer = this.getRenderer();
    this.textures = [];
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
      this.textures.push(texture);
    }
  }

  /**
   * Return complete auto-detection scan results (Requirement 3).
   */
  getModelInfo() {
    const motionDetails = {};
    for (const [grp, keys] of this.motionGroups.entries()) {
      motionDetails[grp] = keys.length;
    }
    return {
      modelName: this.setting?.getModelFileName()?.replace(/\.moc3$/i, '') || 'Model',
      homeDir: this.homeDir,
      parameterCount: this.availableParams.size,
      parameters: this.parametersList,
      expressionCount: this.expressions.size,
      expressions: [...this.expressions.keys()],
      motionCount: this.motions.size,
      motionGroups: motionDetails,
      hasPhysics: Boolean(this._physics),
      physicsStats: this.physicsStats,
      hasEyeBlink: Boolean(this.eyeBlink),
      hasBreath: Boolean(this.breath),
      hasLipSync: this.mouthParameterIndex >= 0,
      hasBodySway: this.hasRiggedBody,
      hasBodyLean: !this.hasRiggedBody,
      hasBodyFollow: Boolean(this.bodyMotion && Object.values(this.bodyMotion.parameters).some(Boolean)),
      speechMotion: { emotion: this.speechPose.emotion, gesture: this.speechPose.gesture,
        active: this.speechPose.active, energy: this.speechPose.energy },
    };
  }

  /**
   * Cleanup and dispose WebGL & Cubism resources without memory leak (Requirement 6).
   */
  dispose() {
    this.ready = false;
    this.speechMotion.reset();
    this.bodyMotion?.reset();
    this._unsubscribeTuning?.();

    // 1. Stop and release all motion managers
    try {
      this._motionManager?.stopAllMotions();
      this.actionMotionManager?.stopAllMotions();
      this._expressionManager?.stopAllMotions();
      this.actionMotionManager?.release();
    } catch (err) {
      console.warn('[Live2D] Error stopping motion managers on dispose:', err);
    }

    // 2. Clean up WebGL textures
    if (this.gl && this.textures) {
      for (const tex of this.textures) {
        try {
          this.gl.deleteTexture(tex);
        } catch {}
      }
      this.textures = [];
    }

    // 3. Clear data collections
    this.expressions.clear();
    this.motions.clear();
    this.motionGroups.clear();
    this.availableParams?.clear();
    this.parametersList = [];

    // 4. Release CubismUserModel base resources (moc, renderer, physics, breath, eyeblink, drag)
    try {
      this.release();
    } catch (err) {
      console.warn('[Live2D] Error in CubismUserModel.release():', err);
    }

    console.log('[Live2D] Model instance disposed and WebGL resources cleaned.');
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
  // Main update loop
  // ---------------------------------------------------------------------------
  update(delta, mouthLevel, speaking, audioTime) {
    if (!this.ready) return;
    this.talking = speaking;
    this.speechPose = this.speechMotion.update(audioTime, delta);
    if (this.speechPose.active || this._speechWasActive) {
      if (this.currentEmotion !== this.speechPose.emotion) this.setEmotion(this.speechPose.emotion);
    }
    this._speechWasActive = this.speechPose.active;

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

    // Di mode overlay, pastikan arah ekspresi sayap (翅膀.exp3.json / Param41)
    // tetap konsisten meskipun emosi netral memanggil stopAllMotions():
    // Param41 = 0.0 -> MENAMPILKAN sayap (preset "Dengan sayap")
    // Param41 = 1.0 -> MENYEMBUNYIKAN sayap (preset "Tanpa sayap")
    if (this.isOverlay && this.wingParamIndex >= 0) {
      this._model.setParameterValueByIndex(
        this.wingParamIndex,
        this.overlayShowWings ? 0.0 : 1.0,
      );
    }

    if (this.breath) this.breath.updateParameters(this._model, delta);

    // Lip sync smoothing.
    const lipSmoothing = tuning.get('talking.lipSyncSmoothing') ?? 14;
    this.smoothedMouth +=
      (Math.max(0, Math.min(1, mouthLevel)) - this.smoothedMouth) *
      (1 - Math.exp(-lipSmoothing * delta));
    if (this.mouthParameterIndex >= 0) {
      this._model.setParameterValueByIndex(this.mouthParameterIndex, this.smoothedMouth);
    }

    // Compose head, gaze and brows once, after expressions and before physics.
    const idle = this.syntheticTracker.sample(delta, this.speechPose.active);
    applyMotionOffsets(this._model, this.motionParameters, this.speechPose, idle);
    this.bodyMotion?.update(this._model, this.speechPose, delta);

    if (this._physics) {
      this._physics.evaluate(this._model, delta);
      this.physicsFrameCount++;
      if (this.physicsFrameCount === 1) {
        console.log(
          `[Live2D] Physics evaluating every frame: ${this.physicsStats?.outputs ?? '?'} output params`,
        );
      }
    }

    // Di mode overlay half-body, sembunyikan part kaki bawah rok (Part29, Part30, Part74)
    // supaya batas bawah model adalah ujung rok (ArtMesh79) tanpa potongan paha.
    if (this.isOverlay && this.hiddenHalfBodyPartIndices.length > 0) {
      for (const partIdx of this.hiddenHalfBodyPartIndices) {
        this._model.setPartOpacityByIndex(partIdx, 0.0);
      }
    }

    this._model.update();
  }

  /**
   * Mengukur bounding box mesh visible pada pose diam (rest pose) untuk kedua preset overlay:
   * - 'with-wings' (Param41 = 0.0, sayap tampil)
   * - 'without-wings' (Param41 = 1.0, sayap disembunyikan via arah 翅膀.exp3.json)
   */
  measureRestPoseOverlayBounds() {
    const coreModel = this._model?._model;
    if (!coreModel) return;

    this.measuredPresetBounds.clear();

    for (const partIdx of this.hiddenHalfBodyPartIndices) {
      this._model.setPartOpacityByIndex(partIdx, 0.0);
    }

    const measureCurrentVisibleMesh = () => {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let minXMesh = '';
      let maxXMesh = '';
      let minYMesh = '';
      let maxYMesh = '';

      const dCount = coreModel.drawables?.count || 0;
      for (let i = 0; i < dCount; i++) {
        const op = coreModel.drawables.opacities[i];
        const vis = Live2DCubismCore.Utils.hasIsVisibleBit(coreModel.drawables.dynamicFlags[i]);
        if (op <= 0.01 || !vis) continue;
        const pos = coreModel.drawables.vertexPositions[i];
        const meshId = coreModel.drawables.ids[i];
        for (let j = 0; j < pos.length; j += 2) {
          const vx = pos[j];
          const vy = pos[j + 1];
          if (vx < minX) {
            minX = vx;
            minXMesh = meshId;
          }
          if (vx > maxX) {
            maxX = vx;
            maxXMesh = meshId;
          }
          if (vy < minY) {
            minY = vy;
            minYMesh = meshId;
          }
          if (vy > maxY) {
            maxY = vy;
            maxYMesh = meshId;
          }
        }
      }

      if (!Number.isFinite(minX)) {
        return {
          minX: -0.5,
          maxX: 0.5,
          minY: -0.2,
          maxY: 0.65,
          width: 1.0,
          height: 0.85,
          aspectRatio: 1.1765,
          extremes: {},
        };
      }

      const width = maxX - minX;
      const height = maxY - minY;
      return {
        minX: +minX.toFixed(4),
        maxX: +maxX.toFixed(4),
        minY: +minY.toFixed(4),
        maxY: +maxY.toFixed(4),
        width: +width.toFixed(4),
        height: +height.toFixed(4),
        aspectRatio: +(width / height).toFixed(4),
        extremes: { minXMesh, maxXMesh, minYMesh, maxYMesh },
      };
    };

    // 1. Ukur preset 'with-wings' (Param41 = 0.0 -> sayap tampil)
    if (this.wingParamIndex >= 0) {
      this._model.setParameterValueByIndex(this.wingParamIndex, 0.0);
    }
    this._model.update();
    this.measuredPresetBounds.set('with-wings', measureCurrentVisibleMesh());

    // 2. Ukur preset 'without-wings' (Param41 = 1.0 -> sayap disembunyikan)
    if (this.wingParamIndex >= 0) {
      this._model.setParameterValueByIndex(this.wingParamIndex, 1.0);
    }
    this._model.update();
    this.measuredPresetBounds.set('without-wings', measureCurrentVisibleMesh());

    // Kembalikan parameter ke kondisi awal
    this._model.loadParameters();
    for (const partIdx of this.hiddenHalfBodyPartIndices) {
      this._model.setPartOpacityByIndex(partIdx, 0.0);
    }
    if (this.wingParamIndex >= 0) {
      this._model.setParameterValueByIndex(
        this.wingParamIndex,
        this.overlayShowWings ? 0.0 : 1.0,
      );
    }
    this._model.update();
  }

  /**
   * Menerapkan konfigurasi preset overlay ('with-wings' | 'without-wings') dan toggle sayap.
   */
  applyOverlayState(overlayState) {
    if (!overlayState) return;
    if (overlayState.wingExpressionName) {
      this.wingExpressionName = overlayState.wingExpressionName;
    }
    if (Array.isArray(overlayState.hiddenHalfBodyPartIds) && this._model) {
      const idMgr = CubismFramework.getIdManager();
      this.hiddenHalfBodyPartIds = overlayState.hiddenHalfBodyPartIds;
      this.hiddenHalfBodyPartIndices = [];
      for (const partIdStr of this.hiddenHalfBodyPartIds) {
        const pIdx = this._model.getPartIndex(idMgr.getId(partIdStr));
        if (pIdx >= 0) this.hiddenHalfBodyPartIndices.push(pIdx);
      }
    }

    const presetId = overlayState.activePreset || 'with-wings';
    const presetConfig = overlayState.presetConfig || null;
    const showWings = presetConfig ? Boolean(presetConfig.showWings) : presetId !== 'without-wings';

    this.overlayPresetId = presetId;
    this.overlayPresetConfig = presetConfig;
    this.overlayShowWings = showWings;

    // Terapkan ekspresi 翅膀.exp3.json ketika sayap dimatikan (Param41 = 1.0 menyembunyikan sayap)
    if (this.ready && this._model) {
      if (!showWings) {
        if (this.currentEmotion === 'netral' && this.expressions.has(this.wingExpressionName)) {
          this.setExpression(this.wingExpressionName);
        }
      } else if (this.currentEmotion === 'netral') {
        this._expressionManager?.stopAllMotions();
      }

      if (this.wingParamIndex >= 0) {
        this._model.setParameterValueByIndex(this.wingParamIndex, showWings ? 0.0 : 1.0);
      }
    }

    this.invalidateOverlayFit(overlayState.reason || `preset:${presetId}`);
  }

  invalidateOverlayFit(reason = 'recalculate') {
    this._pendingDiagReason = reason;
    this._pendingDiagFrames = 0;
  }

  /**
   * Menghitung matriks MVP Fit-to-Bounds untuk mode overlay (?mode=overlay):
   * - Menggunakan rasio aspek canvas sebenarnya (width / height)
   * - Memastikan seluruh bagian model (sayap, mahkota, ujung rok) muat penuh
   *   di dalam canvas dengan padding ~4% di setiap sisi tanpa distorsi rasio.
   */
  computeOverlayFitProjection(width, height) {
    const projection = new CubismMatrix44();
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    const canvasAspect = safeWidth / safeHeight;

    const restBounds =
      this.measuredPresetBounds.get(this.overlayPresetId) ||
      this.measuredPresetBounds.get('with-wings') || {
        minX: -0.5025,
        maxX: 0.5014,
        minY: -0.1851,
        maxY: 0.6358,
      };

    const framingCfg = this.overlayPresetConfig?.framing || {};
    const padding = typeof framingCfg.padding === 'number' ? framingCfg.padding : 0.04;
    const scaleMultiplier =
      typeof framingCfg.scaleMultiplier === 'number' ? framingCfg.scaleMultiplier : 1.0;
    const offsetX = typeof framingCfg.offsetX === 'number' ? framingCfg.offsetX : 0.0;
    const offsetY = typeof framingCfg.offsetY === 'number' ? framingCfg.offsetY : 0.0;
    const margin = framingCfg.motionMargin || {
      left: 0.016,
      right: 0.016,
      top: 0.022,
      bottom: 0.010,
    };

    const leanMargin = this.hasRiggedBody ? { x: 0, y: 0 } : bodyLeanMargin(restBounds);
    const fitMinX = restBounds.minX - (margin.left || 0) - leanMargin.x;
    const fitMaxX = restBounds.maxX + (margin.right || 0) + leanMargin.x;
    const fitMinY = restBounds.minY - (margin.bottom || 0) - leanMargin.y;
    const fitMaxY = restBounds.maxY + (margin.top || 0) + leanMargin.y;

    const boundsWidth = Math.max(0.01, fitMaxX - fitMinX);
    const boundsHeight = Math.max(0.01, fitMaxY - fitMinY);
    const centerX = (fitMinX + fitMaxX) * 0.5;
    const centerY = (fitMinY + fitMaxY) * 0.5;

    // Rentang NDC [-1, +1] punya panjang 2.0. Dengan padding 4% di tiap tepi, usableNdc = 2 * (1 - 2*0.04) = 1.84 ([-0.92, +0.92])
    const usableNdc = 2.0 * Math.max(0.1, 1.0 - 2.0 * padding);

    // Jaga rasio aspek proporsional 1:1 di layar: scaleX * width = scaleY * height => scaleX = scaleY / canvasAspect
    const maxScaleYByHeight = usableNdc / boundsHeight;
    const maxScaleYByWidth = (usableNdc / boundsWidth) * canvasAspect;
    const uniformScaleY = Math.min(maxScaleYByHeight, maxScaleYByWidth) * scaleMultiplier;

    const scaleY = uniformScaleY;
    const scaleX = uniformScaleY / canvasAspect;
    const translateX = -scaleX * centerX + offsetX;
    const translateY = -scaleY * centerY + offsetY;

    projection.loadIdentity();
    projection.scale(scaleX, scaleY);
    projection.translate(translateX, translateY);

    this.lastOverlayFitSummary = {
      presetId: this.overlayPresetId,
      showWings: this.overlayShowWings,
      wingExpressionName: this.wingExpressionName,
      wingParamValue: this.overlayShowWings ? 0.0 : 1.0,
      padding,
      usableNdcSpan: +usableNdc.toFixed(4),
      canvasAspect: +canvasAspect.toFixed(4),
      restBounds,
      fitBoundsWithMotionMargin: {
        minX: +fitMinX.toFixed(4),
        maxX: +fitMaxX.toFixed(4),
        minY: +fitMinY.toFixed(4),
        maxY: +fitMaxY.toFixed(4),
        width: +boundsWidth.toFixed(4),
        height: +boundsHeight.toFixed(4),
        aspectRatio: +(boundsWidth / boundsHeight).toFixed(4),
        centerX: +centerX.toFixed(4),
        centerY: +centerY.toFixed(4),
      },
      scaleX: +scaleX.toFixed(4),
      scaleY: +scaleY.toFixed(4),
      translateX: +translateX.toFixed(4),
      translateY: +translateY.toFixed(4),
    };

    return projection;
  }

  measureVisibleBounds() {
    const drawables = this._model?._model?.drawables;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < (drawables?.count ?? 0); i++) {
      if (drawables.opacities[i] <= 0.01 || !Live2DCubismCore.Utils.hasIsVisibleBit(drawables.dynamicFlags[i])) continue;
      const vertices = drawables.vertexPositions[i];
      for (let j = 0; j < vertices.length; j += 2) {
        minX = Math.min(minX, vertices[j]); maxX = Math.max(maxX, vertices[j]);
        minY = Math.min(minY, vertices[j + 1]); maxY = Math.max(maxY, vertices[j + 1]);
      }
    }
    return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : this.speechBounds;
  }

  setFraming(scale = 1.0, x = 0.0, y = 0.0, immediate = false) {
    this.targetFraming = { scale, x, y };
    if (immediate || !this.currentFraming) {
      this.currentFraming = { scale, x, y };
    }
  }

  draw() {
    if (!this.ready) return;
    const { width, height } = this.canvas;
    let projection;

    if (this.isOverlay) {
      // Mode Overlay (?mode=overlay): gunakan Fit-to-Bounds berbasis rasio aspek canvas sebenarnya
      projection = this.computeOverlayFitProjection(width, height);
    } else {
      // Mode Non-Overlay: JANGAN diubah perilakunya
      projection = new CubismMatrix44();
      if (this._model.getCanvasWidth() > 1 && width < height) {
        this.getModelMatrix().setWidth(2);
        projection.scale(1, width / height);
      } else {
        projection.scale(height / width, 1);
      }

      // Camera / Viewport framing transform (scale & offset Y)
      if (this.targetFraming) {
        if (!this.currentFraming) {
          this.currentFraming = { ...this.targetFraming };
        } else {
          const factor = 0.15; // Smooth camera interpolation
          this.currentFraming.scale += (this.targetFraming.scale - this.currentFraming.scale) * factor;
          this.currentFraming.x += (this.targetFraming.x - this.currentFraming.x) * factor;
          this.currentFraming.y += (this.targetFraming.y - this.currentFraming.y) * factor;
        }
        const { scale, x, y } = this.currentFraming;
        if (scale !== 1.0) {
          projection.scaleRelative(scale, scale);
        }
        if (x !== 0.0 || y !== 0.0) {
          projection.translateRelative(x, y);
        }
      }

      projection.multiplyByMatrix(this.getModelMatrix());
    }

    if (!this.hasRiggedBody) {
      const bounds = this.isOverlay ? this.measuredPresetBounds.get(this.overlayPresetId) ?? this.speechBounds : this.speechBounds;
      const lean = new CubismMatrix44();
      lean.setMatrix(bodyLeanTransform(bounds, this.speechPose, tuning.get('talking.bodyLeanStrength')));
      projection.multiplyByMatrix(lean);
    }
    const renderer = this.getRenderer();
    renderer.setMvpMatrix(projection);
    renderer.setRenderState(null, [0, 0, width, height]);
    renderer.drawModel(SHADER_PATH);

    if (this.isOverlay && this._pendingDiagReason) {
      this._pendingDiagFrames = (this._pendingDiagFrames || 0) + 1;
      if (this._pendingDiagFrames >= 12) {
        const reason = this._pendingDiagReason;
        this._pendingDiagReason = null;
        this._pendingDiagFrames = 0;
        this.emitOverlayDiagnostics(projection, width, height, reason);
      }
    }
  }

  emitOverlayDiagnostics(projection, width, height, reason) {
    const coreModel = this._model?._model;
    const canvasInfo = coreModel?.canvasinfo || {};
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minXMesh = '';
    let maxXMesh = '';
    let minYMesh = '';
    let maxYMesh = '';

    const dCount = coreModel?.drawables?.count || 0;
    for (let i = 0; i < dCount; i++) {
      const op = coreModel.drawables.opacities[i];
      const vis = Live2DCubismCore.Utils.hasIsVisibleBit(coreModel.drawables.dynamicFlags[i]);
      if (op <= 0.01 || !vis) continue;
      const pos = coreModel.drawables.vertexPositions[i];
      const meshId = coreModel.drawables.ids[i];
      for (let j = 0; j < pos.length; j += 2) {
        const vx = pos[j];
        const vy = pos[j + 1];
        if (vx < minX) {
          minX = vx;
          minXMesh = meshId;
        }
        if (vx > maxX) {
          maxX = vx;
          maxXMesh = meshId;
        }
        if (vy < minY) {
          minY = vy;
          minYMesh = meshId;
        }
        if (vy > maxY) {
          maxY = vy;
          maxYMesh = meshId;
        }
      }
    }

    const matrix = projection.getArray();
    const corners = [[minX, minY], [minX, maxY], [maxX, minY], [maxX, maxY]];
    const xs = corners.map(([x, y]) => matrix[0] * x + matrix[4] * y + matrix[12]);
    const ys = corners.map(([x, y]) => matrix[1] * x + matrix[5] * y + matrix[13]);
    const leftNdc = +Math.min(...xs).toFixed(4);
    const rightNdc = +Math.max(...xs).toFixed(4);
    const bottomNdc = +Math.min(...ys).toFixed(4);
    const topNdc = +Math.max(...ys).toFixed(4);

    const diagPayload = {
      phase: 'AFTER_FIX_FIT_TO_BOUNDS',
      reason,
      presetId: this.overlayPresetId,
      showWings: this.overlayShowWings,
      wingExpression: {
        file: `${this.wingExpressionName}.exp3.json`,
        parameterId: 'Param41',
        directionExplanation:
          'File 翅膀.exp3.json mengatur Param41 = 1.0 (MENYEMBUNYIKAN sayap); Param41 = 0.0 MENAMPILKAN sayap.',
        appliedParam41Value:
          this.wingParamIndex >= 0
            ? +this._model.getParameterValueByIndex(this.wingParamIndex).toFixed(4)
            : null,
      },
      windowInner: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      canvas: {
        cssWidth: this.canvas.clientWidth,
        cssHeight: this.canvas.clientHeight,
        internalWidth: width,
        internalHeight: height,
        aspectRatio: +(width / height).toFixed(4),
      },
      cubismCanvas: {
        canvasWidthPx: canvasInfo.CanvasWidth,
        canvasHeightPx: canvasInfo.CanvasHeight,
        pixelsPerUnit: canvasInfo.PixelsPerUnit,
        canvasWidthUnits: +this._model.getCanvasWidth().toFixed(4),
        canvasHeightUnits: +this._model.getCanvasHeight().toFixed(4),
      },
      liveVisibleMeshBoundsUnits: {
        minX: +minX.toFixed(4),
        maxX: +maxX.toFixed(4),
        minY: +minY.toFixed(4),
        maxY: +maxY.toFixed(4),
        width: +(maxX - minX).toFixed(4),
        height: +(maxY - minY).toFixed(4),
        aspectRatio: +((maxX - minX) / (maxY - minY)).toFixed(4),
        extremes: { minXMesh, maxXMesh, minYMesh, maxYMesh },
      },
      fitToBoundsConfig: this.lastOverlayFitSummary,
      finalMvp: {
        scaleX: +projection.getScaleX().toFixed(4),
        scaleY: +projection.getScaleY().toFixed(4),
        translateX: +projection.getTranslateX().toFixed(4),
        translateY: +projection.getTranslateY().toFixed(4),
      },
      projectedNdcBounds: {
        left: leftNdc,
        right: rightNdc,
        bottom: bottomNdc,
        top: topNdc,
        clipped:
          leftNdc < -1.0 || rightNdc > 1.0 || bottomNdc < -1.0 || topNdc > 1.0,
      },
    };

    console.log('[OverlayDiag]', diagPayload);
    window.desktopBridge?.reportOverlayDiagnostics?.(diagPayload);
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
    this.isOverlay = isOverlayMode();
    this.overlayFpsLimit = OVERLAY_FPS_LIMIT;
    this.currentFramingConfig = getHalfBodyConfig();
    this.overlayState = null;
    this._lastDpr = 0;
    this._resizeObserver = null;
    this._unsubscribeOverlayState = null;
  }

  async initialize() {
    initializeCubism();
    this.gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true });
    if (!this.gl) throw new Error('Browser tidak mendukung WebGL2 yang dibutuhkan Cubism SDK ini.');
    this.resize();

    // Pantau perubahan ukuran jendela dan perubahan monitor/DPI secara reaktif (Requirement 3)
    window.addEventListener('resize', () => this.resize());
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(this.canvas);
    }

    if (this.isOverlay && window.desktopBridge) {
      this.setupOverlayEditControls();

      if (window.desktopBridge.getAppInfo) {
        window.desktopBridge
          .getAppInfo()
          .then((info) => {
            if (info && typeof info.overlayFpsLimit === 'number' && info.overlayFpsLimit > 0) {
              this.overlayFpsLimit = info.overlayFpsLimit;
            }
          })
          .catch(() => {});
      }

      if (window.desktopBridge.getOverlayState) {
        try {
          const initialState = await window.desktopBridge.getOverlayState();
          this.applyOverlayState(initialState);
        } catch (err) {
          console.warn('[Live2D] Gagal membaca initial overlay state:', err);
        }
      }

      if (window.desktopBridge.onOverlayStateChanged) {
        this._unsubscribeOverlayState = window.desktopBridge.onOverlayStateChanged((state) => {
          this.applyOverlayState(state);
        });
      }
    }

    window.__live2dCompanion = this;

    requestAnimationFrame((time) => this.frame(time));

    // Fetch active model from server config (Requirement 5)
    let targetModelPath = MODEL_URL;
    try {
      const res = await fetch('/api/models/active');
      if (res.ok) {
        const data = await res.json();
        if (data.activeModelPath) targetModelPath = data.activeModelPath;
      }
    } catch (e) {
      console.warn('[Live2D] Gagal fetch active model, menggunakan default:', e);
    }

    await this.switchModel(targetModelPath);
  }

  setupOverlayEditControls() {
    const dragZone = document.getElementById('overlay-drag-zone');
    const doneBtn = document.getElementById('overlay-done-btn');
    const resetBtn = document.getElementById('overlay-reset-btn');

    if (doneBtn) {
      doneBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.desktopBridge?.setEditMode?.(false);
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.desktopBridge?.resetOverlayBounds?.();
      });
    }

    if (dragZone) {
      let dragState = null;

      dragZone.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !this.overlayState?.editMode) return;
        if (e.target && typeof e.target.closest === 'function' && e.target.closest('.overlay-edit-btn')) {
          return;
        }
        e.preventDefault();
        dragState = {
          pointerId: e.pointerId,
          startScreenX: e.screenX,
          startScreenY: e.screenY,
          startWinX: window.screenX,
          startWinY: window.screenY,
        };
        dragZone.classList.add('dragging');
        try {
          dragZone.setPointerCapture(e.pointerId);
        } catch {}
      });

      dragZone.addEventListener('pointermove', (e) => {
        if (!dragState || e.pointerId !== dragState.pointerId) return;
        const nextX = Math.round(dragState.startWinX + (e.screenX - dragState.startScreenX));
        const nextY = Math.round(dragState.startWinY + (e.screenY - dragState.startScreenY));
        window.desktopBridge?.moveOverlayWindow?.(nextX, nextY);
        this.updateOverlayEditFooter(nextX, nextY);
      });

      const endDrag = (e) => {
        if (!dragState || (e && e.pointerId !== dragState.pointerId)) return;
        try {
          if (dragZone.hasPointerCapture(dragState.pointerId)) {
            dragZone.releasePointerCapture(dragState.pointerId);
          }
        } catch {}
        dragZone.classList.remove('dragging');
        dragState = null;
        this.updateOverlayEditFooter();
      };

      dragZone.addEventListener('pointerup', endDrag);
      dragZone.addEventListener('pointercancel', endDrag);
    }

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.overlayState?.editMode) {
        e.preventDefault();
        window.desktopBridge?.setEditMode?.(false);
      }
    });
  }

  updateOverlayEditFooter(overrideWinX = null, overrideWinY = null) {
    if (!this.isOverlay) return;
    const footerEl = document.getElementById('overlay-edit-footer');
    const handleEl = document.getElementById('overlay-drag-handle');
    const w = Math.round(window.innerWidth || this.canvas.clientWidth || 0);
    const h = Math.round(window.innerHeight || this.canvas.clientHeight || 0);

    if (footerEl) {
      const presetLabel =
        this.overlayState?.presetConfig?.label ||
        (this.overlayState?.activePreset === 'without-wings' ? 'Tanpa sayap' : 'Dengan sayap');
      footerEl.textContent = `${presetLabel} • ${w}×${h} px • Bebas tembus tepi layar • Esc / Ctrl+Alt+E selesai`;
    }

    // Jaga agar badge kontrol atas & footer bawah tetap terlihat di dalam layar meskipun
    // garis tepi atas/bawah/kiri/kanan overlay digeser menembus keluar border Windows
    const winX =
      typeof overrideWinX === 'number'
        ? overrideWinX
        : this.overlayState?.windowBounds?.x ?? window.screenX ?? 0;
    const winY =
      typeof overrideWinY === 'number'
        ? overrideWinY
        : this.overlayState?.windowBounds?.y ?? window.screenY ?? 0;
    const scrLeft = window.screen?.availLeft ?? 0;
    const scrTop = window.screen?.availTop ?? 0;
    const scrW = window.screen?.width || 1920;
    const scrH = window.screen?.height || 1080;

    let shiftX = 0;
    const centerX = winX + w * 0.5;
    if (centerX < scrLeft + 170) {
      shiftX = Math.min(w * 0.38, scrLeft + 170 - centerX);
    } else if (centerX > scrLeft + scrW - 170) {
      shiftX = -Math.min(w * 0.38, centerX - (scrLeft + scrW - 170));
    }

    if (handleEl) {
      const shiftTopY = winY < scrTop ? Math.min(Math.max(0, h - 80), scrTop - winY + 8) : 0;
      handleEl.style.transform = `translate(${Math.round(shiftX)}px, ${Math.round(shiftTopY)}px)`;
    }

    if (footerEl) {
      const shiftBottomY =
        winY + h > scrTop + scrH
          ? -Math.min(Math.max(0, h - 80), winY + h - (scrTop + scrH) + 8)
          : 0;
      footerEl.style.transform = `translate(${Math.round(shiftX)}px, ${Math.round(shiftBottomY)}px)`;
    }
  }

  applyOverlayState(state) {
    if (!state) return;
    this.overlayState = state;
    if (this.isOverlay) {
      document.documentElement.classList.toggle('overlay-edit-mode', Boolean(state.editMode));
      this.updateOverlayEditFooter();
    }
    this.resize();
    if (this.model) {
      this.model.applyOverlayState(state);
    }
  }

  async switchModel(modelPath) {
    if (this.status) this.status.textContent = 'Memuat model...';
    console.log(`[Live2D] Switching model to: ${modelPath}`);

    // Clean up previous model instance (Requirement 6)
    if (this.model) {
      this.model.dispose();
      this.model = null;
    }

    if (this.gl) {
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.gl.clearColor(0, 0, 0, 0);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }

    const url = new URL(modelPath, location.href);
    const file = url.pathname.split('/').pop();
    const homeDir = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);

    this.model = new CompanionCubismModel(this.gl, this.canvas, homeDir);
    await this.model.load(file);

    // Langsung terapkan framing Half Body saat model di-load
    this.currentFramingConfig = getHalfBodyConfig();
    this.model.setFraming(
      this.currentFramingConfig.scale,
      this.currentFramingConfig.x,
      this.currentFramingConfig.y,
      true
    );

    if (this.isOverlay && this.overlayState) {
      this.model.applyOverlayState(this.overlayState);
    }

    this.currentModelPath = modelPath;
    const modelInfo = this.model.getModelInfo();

    if (this.status) {
      this.status.textContent = `Model aktif: ${modelInfo.modelName} (${modelInfo.parameterCount} param, ${modelInfo.expressionCount} exp)`;
    }

    // Broadcast model switched event (Requirement 3: triggers UI update)
    window.dispatchEvent(
      new CustomEvent('waifu-model-switched', {
        detail: {
          modelPath,
          modelInfo,
        },
      }),
    );

    return modelInfo;
  }

  getModelInfo() {
    return this.model?.getModelInfo() ?? null;
  }

  setFraming(scale, x, y, immediate = false) {
    this.currentFramingConfig = { scale, x, y };
    if (this.model) {
      this.model.setFraming(scale, x, y, immediate);
    }
  }

  resize() {
    // Di mode overlay, gunakan devicePixelRatio sebenarnya supaya presisi di skala DPI 100%, 125%, 150%+
    const dpr = this.isOverlay
      ? window.devicePixelRatio || 1
      : Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (
      this.canvas.width !== width ||
      this.canvas.height !== height ||
      this._lastDpr !== dpr
    ) {
      this.canvas.width = width;
      this.canvas.height = height;
      this._lastDpr = dpr;
      this.gl?.viewport(0, 0, width, height);
      this.model?.setRenderTargetSize(width, height);
      if (this.isOverlay) {
        this.updateOverlayEditFooter();
        this.model?.invalidateOverlayFit('resize-or-dpi-changed');
      }
    }
  }

  frame(time) {
    if (this.isOverlay && this.overlayFpsLimit > 0) {
      const minIntervalMs = 1000 / this.overlayFpsLimit;
      if (time - this.lastFrame < minIntervalMs - 0.5) {
        requestAnimationFrame((next) => this.frame(next));
        return;
      }
    }

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
    this.model?.update(delta, mouth, speaking, audioTime);
    this.model?.draw();
    requestAnimationFrame((next) => this.frame(next));
  }

  setEmotion(emotion) {
    this.emotionEndsAt = 0;
    this.model?.setEmotion(emotion);
  }

  setEmotionCue(emotion, endAt) {
    if (this.model?.speechMotion.cues.length) return;
    this.emotionEndsAt = endAt || 0;
    this.model?.setEmotion(emotion);
  }

  queueSpeechCue(cue) {
    this.emotionEndsAt = 0;
    this.model?.speechMotion.queue(cue);
  }

  cancelSpeechCue(speechId) {
    this.model?.speechMotion.cancel(speechId);
  }

  setExpression(name) {
    this.model?.setExpression(name);
  }

  getExpressionNames() {
    return [...(this.model?.expressions.keys() ?? [])];
  }
}
