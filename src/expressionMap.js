// Indonesian speech emotions map to the Witch sidecar expressions.
// The emotion banks provide variants; these are used when banks are disabled.
export const EMOTION_MAP = {
  senang: { expression: 'bright-smile', intensity: 'tinggi' },
  terkejut: { expression: 'wide-eyes', intensity: 'tinggi' },
  marah: { expression: 'furrowed-brows', intensity: 'tinggi' },
  bingung: { expression: 'small-frown', intensity: 'sedang' },
  jengkel: { expression: 'cheek-puff', intensity: 'sedang' },
  malu: { expression: 'shy-glance', intensity: 'rendah' },
  kesal: { expression: 'small-frown', intensity: 'rendah' },
  sedih: { expression: 'sad-eyes', intensity: 'rendah' },
  kagum: { expression: 'star-eyes', intensity: 'tinggi' },
  sayang: { expression: 'heart-eyes', intensity: 'sedang' },
  jahil: { expression: 'tongue-tease', intensity: 'tinggi' },
  penasaran: { expression: 'side-smile', intensity: 'sedang' },
  netral: { expression: null, intensity: 'sedang' },
};

export const VALID_EMOTIONS = Object.keys(EMOTION_MAP);

export const INTENSITY_MULTIPLIER = {
  tinggi: 1.6,
  sedang: 1.0,
  rendah: 0.5,
};
