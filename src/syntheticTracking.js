// Subtle idle movement. The model adapter combines this pose with speech once.
import { createNoise2D } from 'simplex-noise';
import { tuning } from './tuningConfig.js';

const value = (key, fallback, max) => {
  const number = tuning.get('tracking.' + key);
  return Math.max(0, Math.min(max, Number.isFinite(number) ? number : fallback));
};

export class SyntheticTracker {
  constructor() {
    this.noise = createNoise2D();
    this.time = 0;
    this.eyeX = this.eyeY = this.targetX = this.targetY = 0;
    this.nextGlance = 2;
    this.lastOutputs = {};
  }

  sample(delta, speaking = false) {
    this.time += delta;
    this.nextGlance -= delta;
    if (this.nextGlance <= 0) {
      // Mostly maintain contact with the listener; occasional glances add life.
      const glance = Math.random() < 0.3;
      this.targetX = glance ? (Math.random() * 2 - 1) * value('eyeGazeRangeX', 0.25, 0.4) : 0;
      this.targetY = glance ? (Math.random() * 2 - 1) * value('eyeGazeRangeY', 0.15, 0.3) : 0;
      const min = value('eyeSaccadeMin', 2, 10);
      const max = Math.max(min, value('eyeSaccadeMax', 5, 20));
      this.nextGlance = min + Math.random() * (max - min);
    }
    const alpha = 1 - Math.exp(-value('eyeLerpSpeed', 5, 20) * delta);
    this.eyeX += (this.targetX - this.eyeX) * alpha;
    this.eyeY += (this.targetY - this.eyeY) * alpha;
    const idleWeight = speaking ? 0.3 : 1;
    // Correlated axes produce a small posture shift instead of independent wobble.
    const x = this.noise(this.time * value('headNoiseSpeedX', 0.15, 1), 0);
    const y = this.noise(this.time * value('headNoiseSpeedY', 0.12, 1), 100);
    const z = this.noise(this.time * value('headNoiseSpeedZ', 0.1, 1), 200);
    const brow = this.noise(this.time * value('browNoiseSpeed', 0.08, 1), 300)
      * value('browNoiseAmp', 0.06, 0.15) * idleWeight;
    this.lastOutputs = {
      headX: x * value('headRangeX', 3, 6) * idleWeight,
      headY: y * value('headRangeY', 2, 6) * idleWeight,
      headZ: (x * 0.6 + z * 0.4) * value('headRangeZ', 2, 6) * idleWeight,
      eyeX: this.eyeX * idleWeight, eyeY: this.eyeY * idleWeight,
      browL: brow, browR: brow,
    };
    return this.lastOutputs;
  }
}
