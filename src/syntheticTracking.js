// ---------------------------------------------------------------------------
// syntheticTracking.js  (browser-side)
// Prosedural "face tracking" palsu yang selalu aktif — meniru gerakan
// natural kepala, mata, dan alis seperti VTube Studio face tracking, tapi
// sepenuhnya digenerate dari Simplex noise tanpa webcam.
//
// Didesain additive: semua output adalah OFFSET yang ditambahkan ke nilai
// parameter yang sudah ada dari controller lain (breath, emotion, talking).
// ---------------------------------------------------------------------------
import { createNoise2D } from 'simplex-noise';
import { tuning } from './tuningConfig.js';

// ===========================================================================
//  TUNING CONSTANTS — now read from tuningConfig.js (Live2D Tuning Panel)
//  Kept as local getters so the render loop always reads current values.
// ===========================================================================

// Helper: build a VTS config object from current tuning values per-frame.
function headConfig(axis) {
  const range = tuning.get(`tracking.headRange${axis}`) ?? 15;
  return { inMin: -1, inMax: 1, outMin: -range, outMax: range, limitMin: -30, limitMax: 30 };
}

// --- DEBUG LOGGING ----------------------------------------------------------
export const TRACKING_LOG_INTERVAL_MS = 5000; // log setiap 5 detik

// ===========================================================================

// Helper fungsi untuk mapping ala VTube Studio
function mapVTS(value, config) {
  const t = (value - config.inMin) / (config.inMax - config.inMin);
  const out = config.outMin + t * (config.outMax - config.outMin);
  return Math.max(config.limitMin, Math.min(config.limitMax, out));
}

// ===========================================================================
//  SyntheticTracker class
// ===========================================================================
export class SyntheticTracker {
  constructor() {
    // Buat noise 2D terpisah (simplex-noise v4 API: createNoise2D()).
    // Dimensi pertama = waktu, dimensi kedua = seed/offset.
    this.noise = createNoise2D();

    // Head noise uses different seed offsets per axis so they don't sync.
    this.headSeedX = 0;
    this.headSeedY = 100;
    this.headSeedZ = 200;

    // Brow noise seeds.
    this.browSeedL = 300;
    this.browSeedR = 400;

    // Running time accumulator.
    this.time = 0;

    // --- Eye saccade state ---
    this.eyeTargetX = 0;
    this.eyeTargetY = 0;
    this.eyeCurrentX = 0;
    this.eyeCurrentY = 0;
    this.eyeNextSaccadeIn = this._randomSaccadeInterval();

    // --- Parameter indices (resolved once after model loads) ---
    this.indices = null; // { angleX, angleY, angleZ, eyeBallX, eyeBallY, browLA, browRA }

    // --- Debug logging ---
    this.lastLogTime = 0;
    this.lastOutputs = {};
  }

  /**
   * Resolve parameter indices from the Cubism model. Call once after load.
   * @param {CubismModel} model
   * @param {CubismIdManager} idMgr - CubismFramework.getIdManager()
   */
  resolveIndices(model, idMgr) {
    const idx = (name) => model.getParameterIndex(idMgr.getId(name));
    this.indices = {
      angleX:   idx('ParamAngleX'),
      angleY:   idx('ParamAngleY'),
      angleZ:   idx('ParamAngleZ'),
      eyeBallX: idx('ParamEyeBallX'),
      eyeBallY: idx('ParamEyeBallY'),
      browLA:   idx('ParamBrowLAngle'),
      browRA:   idx('ParamBrowRAngle'),
    };

    const found = Object.entries(this.indices)
      .filter(([, v]) => v >= 0)
      .map(([k, v]) => `${k}=${v}`);
    console.log(`[SyntheticTracking] Resolved params: ${found.join(', ')}`);

    // Requirement 4: log peringatan sekali saat load kalau parameter tertentu tidak ada
    const featureMap = {
      angleX: 'ParamAngleX (Head Yaw)',
      angleY: 'ParamAngleY (Head Pitch)',
      angleZ: 'ParamAngleZ (Head Roll)',
      eyeBallX: 'ParamEyeBallX (Eye Gaze X)',
      eyeBallY: 'ParamEyeBallY (Eye Gaze Y)',
      browLA: 'ParamBrowLAngle (Alis Kiri)',
      browRA: 'ParamBrowRAngle (Alis Kanan)',
    };
    for (const [key, index] of Object.entries(this.indices)) {
      if (index < 0) {
        console.warn(`[SyntheticTracking] Model ini tidak punya ${featureMap[key] || key}, fitur terkait dinonaktifkan.`);
      }
    }
  }

  /**
   * Update and apply additive offsets to the model. Call every frame AFTER
   * breath/expression/talking layers, BEFORE physics.
   * @param {CubismModel} model
   * @param {number} delta - frame delta in seconds
   */
  update(model, delta) {
    if (!this.indices) return;
    this.time += delta;

    const outputs = {};

    // ----- HEAD MICRO-MOVEMENT (noise-based) -----
    // Noise value berkisar dari -1 sampai 1
    const speedX = tuning.get('tracking.headNoiseSpeedX') ?? 0.15;
    const speedY = tuning.get('tracking.headNoiseSpeedY') ?? 0.12;
    const speedZ = tuning.get('tracking.headNoiseSpeedZ') ?? 0.10;

    const noiseX = this.noise(this.time * speedX, this.headSeedX);
    const noiseY = this.noise(this.time * speedY, this.headSeedY);
    const noiseZ = this.noise(this.time * speedZ, this.headSeedZ);

    const headX = mapVTS(noiseX, headConfig('X'));
    const headY = mapVTS(noiseY, headConfig('Y'));
    const headZ = mapVTS(noiseZ, headConfig('Z'));

    this._addClamped(model, this.indices.angleX, headX);
    this._addClamped(model, this.indices.angleY, headY);
    this._addClamped(model, this.indices.angleZ, headZ);
    outputs.headX = headX;
    outputs.headY = headY;
    outputs.headZ = headZ;

    // ----- EYE GAZE SACCADE (target + fast lerp) -----
    this.eyeNextSaccadeIn -= delta;
    if (this.eyeNextSaccadeIn <= 0) {
      // Pick a new random fixation point.
      const rangeX = tuning.get('tracking.eyeGazeRangeX') ?? 0.7;
      const rangeY = tuning.get('tracking.eyeGazeRangeY') ?? 0.5;
      this.eyeTargetX = (Math.random() * 2 - 1) * rangeX;
      this.eyeTargetY = (Math.random() * 2 - 1) * rangeY;
      this.eyeNextSaccadeIn = this._randomSaccadeInterval();
    }
    // Fast lerp toward target (saccade snap, then hold = fixation).
    const lerpSpeed = tuning.get('tracking.eyeLerpSpeed') ?? 12.0;
    const eyeAlpha = 1 - Math.exp(-lerpSpeed * delta);
    this.eyeCurrentX += (this.eyeTargetX - this.eyeCurrentX) * eyeAlpha;
    this.eyeCurrentY += (this.eyeTargetY - this.eyeCurrentY) * eyeAlpha;

    this._addClamped(model, this.indices.eyeBallX, this.eyeCurrentX);
    this._addClamped(model, this.indices.eyeBallY, this.eyeCurrentY);
    outputs.eyeX = this.eyeCurrentX;
    outputs.eyeY = this.eyeCurrentY;

    // ----- EYEBROW SUBTLE MOVEMENT (noise-based) -----
    const browSpeed = tuning.get('tracking.browNoiseSpeed') ?? 0.08;
    const browAmp = tuning.get('tracking.browNoiseAmp') ?? 0.15;
    const browL = this.noise(this.time * browSpeed, this.browSeedL) * browAmp;
    const browR = this.noise(this.time * browSpeed, this.browSeedR) * browAmp;

    this._addClamped(model, this.indices.browLA, browL);
    this._addClamped(model, this.indices.browRA, browR);
    outputs.browL = browL;
    outputs.browR = browR;

    this.lastOutputs = outputs;

    // ----- THROTTLED DEBUG LOG -----
    const now = performance.now();
    if (now - this.lastLogTime > TRACKING_LOG_INTERVAL_MS) {
      this.lastLogTime = now;
      console.log(
        `[SyntheticTracking] head(X=${headX.toFixed(2)}, Y=${headY.toFixed(2)}, Z=${headZ.toFixed(2)})` +
        ` | eye(X=${this.eyeCurrentX.toFixed(3)}, Y=${this.eyeCurrentY.toFixed(3)})` +
        ` | brow(L=${browL.toFixed(3)}, R=${browR.toFixed(3)})` +
        ` | nextSaccade=${this.eyeNextSaccadeIn.toFixed(1)}s`,
      );
    }
  }

  // --- Internal helpers ---

  _randomSaccadeInterval() {
    const min = tuning.get('tracking.eyeSaccadeMin') ?? 2.0;
    const max = tuning.get('tracking.eyeSaccadeMax') ?? 5.0;
    return min + Math.random() * (max - min);
  }

  /**
   * Additively apply offset to a parameter, clamping to its valid range.
   * If index is invalid (<0), silently skip.
   */
  _addClamped(model, index, offset) {
    if (index < 0) return;
    const cur = model.getParameterValueByIndex(index);
    const min = model.getParameterMinimumValue(index);
    const max = model.getParameterMaximumValue(index);
    const clamped = Math.max(min, Math.min(max, cur + offset));
    model.setParameterValueByIndex(index, clamped);
  }
}
