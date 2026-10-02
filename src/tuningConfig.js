// ---------------------------------------------------------------------------
// tuningConfig.js  (browser-side)
// Centralized tuning store initialized from config/animationConfig.json.
// Exposes runtime getters/setters, change listeners, save/load, and reset.
// ---------------------------------------------------------------------------
import rawConfig from '../config/animationConfig.json';

class TuningStore {
  constructor() {
    // Deep clone raw config as default schema
    this.schema = JSON.parse(JSON.stringify(rawConfig));
    this.listeners = new Set();
    this.isLoaded = false;
  }

  /**
   * Get a parameter value by dotted key (e.g. "idle.angleXPeak", "vad.vadStart")
   */
  get(dottedKey) {
    const [group, key] = dottedKey.split('.');
    return this.schema[group]?.[key]?.value;
  }

  /**
   * Set a parameter value and notify listeners
   */
  set(dottedKey, value) {
    const [group, key] = dottedKey.split('.');
    const param = this.schema[group]?.[key];
    if (!param) return;
    param.value = param.type === 'select' ? String(value) : Number(value);
    this._notify(group, key, param.value);
  }

  /**
   * Subscribe to parameter changes
   */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify(group, key, value) {
    for (const fn of this.listeners) {
      try {
        fn(group, key, value);
      } catch (err) {
        console.error('[Tuning] Error in change listener:', err);
      }
    }
  }

  /**
   * Get entire group as { key: value } map
   */
  group(groupName) {
    const grp = this.schema[groupName];
    if (!grp) return {};
    const out = {};
    for (const [k, v] of Object.entries(grp)) out[k] = v.value;
    return out;
  }

  /**
   * Reset all parameters to initial defaults
   */
  resetAll() {
    for (const [group, entries] of Object.entries(this.schema)) {
      for (const [key, param] of Object.entries(entries)) {
        param.value = param.default;
        this._notify(group, key, param.value);
      }
    }
  }

  /**
   * Reset a single group to defaults
   */
  resetGroup(groupName) {
    const grp = this.schema[groupName];
    if (!grp) return;
    for (const [key, param] of Object.entries(grp)) {
      param.value = param.default;
      this._notify(groupName, key, param.value);
    }
  }

  /**
   * Export all current values
   */
  exportValues() {
    const out = {};
    for (const [group, entries] of Object.entries(this.schema)) {
      out[group] = {};
      for (const [key, param] of Object.entries(entries)) {
        out[group][key] = param.value;
      }
    }
    return out;
  }

  /**
   * Import updated values
   */
  importValues(data) {
    if (!data || typeof data !== 'object') return;
    for (const [group, entries] of Object.entries(data)) {
      if (!this.schema[group]) continue;
      for (const [key, val] of Object.entries(entries)) {
        const param = this.schema[group][key];
        if (param) {
          param.value = param.type === 'select' ? String(val) : Number(val);
          this._notify(group, key, param.value);
        }
      }
    }
  }

  getSchema() {
    return this.schema;
  }
}

export const tuning = new TuningStore();
