const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const BODY_IDS = {
  bodyX: { body: ['ParamBodyAngleX', 'ParamBodyX'], head: 'ParamAngleX' },
  bodyY: { body: ['ParamBodyAngleY', 'ParamBodyY'], head: 'ParamAngleY' },
  bodyZ: { body: ['ParamBodyAngleZ'], head: 'ParamAngleZ' },
};

export function resolvePhysicsBodyParameters(available, physicsOutputs = new Set()) {
  const real = param => param && Number.isInteger(param.index) && param.index >= 0 && param.index < available.size;
  return Object.fromEntries(Object.entries(BODY_IDS).map(([key, ids]) => {
    const body = ids.body.map(id => available.get(id)).find(param => real(param) && physicsOutputs.has(param.id));
    const head = available.get(ids.head);
    return [key, body && real(head) ? { body, head } : null];
  }));
}

export function prepareBodyPhysics(json, parameters) {
  const trackedIds = new Set(Object.values(parameters).filter(Boolean).map(param => param.body.id));
  const prepared = structuredClone(json);
  for (const setting of prepared.PhysicsSettings ?? []) {
    for (const output of setting.Output ?? []) {
      if (trackedIds.has(output.Destination?.Id)) {
        // These channels have a tracked base pose as well as secondary physics.
        // Keep the base in the physics caches so downstream hair/chest rigs see
        // torso movement too. This is our blend, not VTube's strength setting.
        output.Weight = clamp(finite(output.Weight, 100), 0, 100) * 0.35;
      }
    }
  }
  return prepared;
}

export class BodyMotionController {
  constructor(parameters, { getOptions = () => ({}) } = {}) {
    this.parameters = parameters;
    this.getOptions = getOptions;
    this.offsets = {};
  }

  reset() {
    this.offsets = {};
  }

  update(model, pose = {}, delta = 0) {
    const alpha = 1 - Math.exp(-clamp(finite(delta), 0, 0.1) / 0.18);
    const strength = clamp(finite(this.getOptions().strength, 1), 0, 2);
    for (const [key, controls] of Object.entries(this.parameters)) {
      if (!controls) continue;
      const { body, head } = controls;
      if ([body.index, head.index].some(index => index < 0 || index >= model.getParameterCount())) continue;
      if (![body.min, body.max].every(Number.isFinite) || body.min >= body.max) continue;
      const baseline = model.getParameterValueByIndex(body.index);
      if (!Number.isFinite(baseline)) continue;
      const center = clamp(finite(body.defaultValue), body.min, body.max);
      // Use more of the torso rig for speech while keeping the roll/hair axis
      // bounded. Retain this range during the fade to avoid clipping at stop.
      const range = key === 'bodyZ' ? 10 : 20;
      const min = Math.max(body.min, center - range);
      const max = Math.min(body.max, center + range);
      const headValue = model.getParameterValueByIndex(head.index);
      const follow = Number.isFinite(headValue) ? (headValue - finite(head.defaultValue)) / 3 : 0;
      // The creator maps head +/-30 to torso +/-10 in VTube. The existing
      // authored body gesture adds a delayed posture change to that base.
      const target = clamp(baseline + follow + finite(pose[key]) * 5 * strength, min, max) - baseline;
      const offset = finite(this.offsets[key]);
      this.offsets[key] = offset + (target - offset) * alpha;
      model.setParameterValueByIndex(body.index, clamp(baseline + this.offsets[key], min, max));
    }
  }
}
