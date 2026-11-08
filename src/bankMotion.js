// Authored motion sampling from the standalone emotion lab.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function weightedChoice(items, previous, random = Math.random) {
  const available = items.filter(item => Number.isFinite(item.weight) && item.weight > 0);
  const candidates = available.length > 1 ? available.filter(item => item.id !== previous) : available;
  if (!candidates.length) return null;
  const total = candidates.reduce((sum, item) => sum + item.weight, 0);
  let ticket = clamp(Number(random()) || 0, 0, 1 - Number.EPSILON) * total;
  for (const item of candidates) {
    ticket -= item.weight;
    if (ticket < 0) return item;
  }
  return candidates.at(-1);
}

function cubic(p0, p1, p2, p3, fraction) {
  const opposite = 1 - fraction;
  return opposite ** 3 * p0 + 3 * opposite ** 2 * fraction * p1
    + 3 * opposite * fraction ** 2 * p2 + fraction ** 3 * p3;
}

function parseCurve(curve) {
  const data = curve.Segments;
  if (!Array.isArray(data) || data.length < 2) throw new Error(`Invalid motion curve: ${curve.Id}`);
  let previous = { time: data[0], value: data[1] };
  const segments = [];
  for (let index = 2; index < data.length;) {
    const type = data[index++];
    const points = [];
    const count = type === 1 ? 3 : 1;
    if (![0, 1, 2, 3].includes(type) || index + count * 2 > data.length) {
      throw new Error(`Invalid motion segment: ${curve.Id}`);
    }
    for (let point = 0; point < count; point++) {
      points.push({ time: data[index++], value: data[index++] });
    }
    const end = points.at(-1);
    if (![previous, ...points].every(point => Number.isFinite(point.time) && Number.isFinite(point.value))
      || end.time <= previous.time) throw new Error(`Invalid motion timing: ${curve.Id}`);
    segments.push({ type, start: previous, points, end });
    previous = end;
  }
  return { id: curve.Id, initial: data[1], segments, end: previous };
}

function sampleCurve(curve, time) {
  const segment = curve.segments.find(item => time < item.end.time);
  if (!segment) return curve.end.value;
  if (time <= segment.start.time) return segment.start.value;
  if (segment.type === 2) return segment.start.value;
  if (segment.type === 3) return segment.end.value;
  const normalized = clamp((time - segment.start.time) / (segment.end.time - segment.start.time), 0, 1);
  if (segment.type === 0) return segment.start.value + (segment.end.value - segment.start.value) * normalized;
  let low = 0;
  let high = 1;
  for (let attempt = 0; attempt < 24; attempt++) {
    const fraction = (low + high) / 2;
    const sampledTime = cubic(segment.start.time, segment.points[0].time,
      segment.points[1].time, segment.end.time, fraction);
    if (sampledTime < time) low = fraction;
    else high = fraction;
  }
  return cubic(segment.start.value, segment.points[0].value,
    segment.points[1].value, segment.end.value, (low + high) / 2);
}

export function compileMotion(document) {
  if (!Number.isFinite(document?.Meta?.Duration) || document.Meta.Duration <= 0) {
    throw new Error('Motion must declare a positive duration.');
  }
  return {
    duration: document.Meta.Duration,
    curves: (document.Curves ?? []).filter(curve => curve.Target === 'Parameter').map(parseCurve),
  };
}

export function sampleMotion(document, time) {
  const motion = document.curves ? document : compileMotion(document);
  return Object.fromEntries(motion.curves.map(curve => [curve.id,
    sampleCurve(curve, clamp(time, 0, motion.duration))]));
}
