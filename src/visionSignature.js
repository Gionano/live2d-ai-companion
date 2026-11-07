export const VISION_SIGNATURE_SIZES = Object.freeze({
  screen: Object.freeze({ width: 128, height: 72 }),
  webcam: Object.freeze({ width: 64, height: 48 }),
});

export function normalizeVisionSignature(value) {
  if (!value || value.version !== 1 || !Object.values(VISION_SIGNATURE_SIZES)
    .some(size => size.width === value.width && size.height === value.height)) return null;
  const pixels = value.luma;
  if (!(Array.isArray(pixels) || ArrayBuffer.isView(pixels))
    || pixels.length !== value.width * value.height) return null;
  if (!Array.from(pixels).every(pixel => Number.isInteger(pixel) && pixel >= 0 && pixel <= 255)) return null;
  return { version: 1, width: value.width, height: value.height, luma: Array.from(pixels) };
}

// Call with ImageData from a canvas resized to the source's signature dimensions.
export function createVisionSignature(rgba, width, height) {
  if (!Object.values(VISION_SIGNATURE_SIZES).some(size => size.width === width && size.height === height)
    || !ArrayBuffer.isView(rgba) || rgba.length !== width * height * 4) {
    throw new TypeError('Vision signature requires source-sized RGBA pixels.');
  }
  const luma = new Array(width * height);
  for (let index = 0; index < luma.length; index++) {
    const offset = index * 4;
    luma[index] = Math.round((rgba[offset] * 77 + rgba[offset + 1] * 150 + rgba[offset + 2] * 29) / 256);
  }
  return { version: 1, width, height, luma };
}

export function compareVisionSignatures(previous, current, source = 'screen', threshold) {
  const before = normalizeVisionSignature(previous);
  const after = normalizeVisionSignature(current);
  if (!before || !after || before.width !== after.width || before.height !== after.height) {
    return { changed: true, score: null, globalScore: null, tileScore: null, exposureDelta: 0 };
  }
  const length = after.luma.length;
  const exposureDelta = source === 'webcam'
    ? after.luma.reduce((sum, pixel, index) => sum + pixel - before.luma[index], 0) / length : 0;
  const compensatedExposure = Math.max(-25, Math.min(25, exposureDelta));
  const tiles = new Float64Array(48);
  const counts = new Uint16Array(48);
  let total = 0;
  for (let index = 0; index < length; index++) {
    // Centering removes uniform autoexposure; the noise floor tolerates sensor flicker.
    const difference = Math.max(0, Math.abs(after.luma[index] - before.luma[index] - compensatedExposure)
      - (source === 'webcam' ? 2 : 0));
    const x = index % after.width;
    const y = Math.floor(index / after.width);
    const tile = Math.floor(y * 6 / after.height) * 8 + Math.floor(x * 8 / after.width);
    tiles[tile] += difference;
    counts[tile]++;
    total += difference;
  }
  const globalScore = total / length;
  const tileScore = Math.max(...Array.from(tiles, (sum, index) => sum / counts[index]));
  const score = source === 'webcam' ? globalScore : tileScore;
  const limit = Number.isFinite(threshold) && threshold > 0 ? threshold : source === 'webcam' ? 5 : 3;
  return { changed: score >= limit, score, globalScore, tileScore, exposureDelta };
}
