// ---------------------------------------------------------------------------
// tuningPanel.js  (browser-side)
// Auto-generated Live2D Tuning Panel — reads config/animationConfig.json schema
// and generates collapsible groups with real-time sliders and dropdowns.
// Styled to match the existing dark companion UI.
// ---------------------------------------------------------------------------
import { tuning } from './tuningConfig.js';

const GROUP_LABELS = {
  idle:      '🫁 Idle & Breathing',
  tracking:  '👀 Synthetic Face Tracking',
  talking:   '🗣️ Talking Gesture & Audio-Reactive',
  vad:       '🎤 VAD & STT Threshold',
  vision:    '🖥️ Vision & Screen Monitor',
  models:    '🤖 Model & Voice Settings',
};

const GROUP_ORDER = ['idle', 'tracking', 'talking', 'vad', 'vision', 'models'];

let panelEl = null;
let isOpen = false;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Build panel DOM
// ---------------------------------------------------------------------------
export function initTuningPanel() {
  if (document.getElementById('tuning-panel')) return;

  panelEl = document.createElement('div');
  panelEl.id = 'tuning-panel';
  panelEl.innerHTML = `
    <div class="tp-header">
      <div class="tp-title">
        <h3>⚙️ Live2D Tuning Panel</h3>
        <span class="tp-subtitle">VTube Studio style runtime parameter tuning</span>
      </div>
      <div class="tp-header-btns">
        <button class="tp-btn tp-save" title="Simpan ke animationConfig.json">💾 Save</button>
        <button class="tp-btn tp-reset" title="Kembalikan semua ke default awal">🔄 Reset</button>
        <button class="tp-btn tp-close" title="Tutup panel">✕</button>
      </div>
    </div>
    <div class="tp-body"></div>
  `;

  injectStyles();
  document.body.appendChild(panelEl);

  const body = panelEl.querySelector('.tp-body');
  const schema = tuning.getSchema();

  for (const groupName of GROUP_ORDER) {
    const entries = schema[groupName];
    if (!entries) continue;
    const section = buildGroupSection(groupName, entries);
    body.appendChild(section);
  }

  // Wire buttons
  panelEl.querySelector('.tp-close').addEventListener('click', () => togglePanel(false));
  panelEl.querySelector('.tp-save').addEventListener('click', saveSettings);
  panelEl.querySelector('.tp-reset').addEventListener('click', resetSettings);

  // Load saved settings on init from server or localStorage
  loadSettings();

  // Start hidden
  panelEl.classList.add('tp-hidden');
}

// ---------------------------------------------------------------------------
// Build a collapsible group section
// ---------------------------------------------------------------------------
function buildGroupSection(groupName, entries) {
  const section = document.createElement('div');
  section.className = 'tp-group';

  const header = document.createElement('div');
  header.className = 'tp-group-header';
  header.innerHTML = `
    <span class="tp-group-arrow">▶</span>
    <span class="tp-group-label">${GROUP_LABELS[groupName] || groupName}</span>
    <span class="tp-group-count">${Object.keys(entries).length} params</span>
    <button class="tp-btn-mini tp-group-reset" title="Reset kategori ini ke default">↩</button>
  `;

  const content = document.createElement('div');
  content.className = 'tp-group-content tp-collapsed';

  for (const [key, param] of Object.entries(entries)) {
    content.appendChild(buildParamRow(groupName, key, param));
  }

  // Toggle collapse
  header.addEventListener('click', (e) => {
    if (e.target.classList.contains('tp-group-reset')) return;
    const collapsed = content.classList.toggle('tp-collapsed');
    header.querySelector('.tp-group-arrow').textContent = collapsed ? '▶' : '▼';
  });

  // Group reset
  header.querySelector('.tp-group-reset').addEventListener('click', (e) => {
    e.stopPropagation();
    tuning.resetGroup(groupName);
    // Update all controls in this group
    content.querySelectorAll('.tp-slider-row').forEach((row) => {
      const k = row.dataset.key;
      const p = tuning.getSchema()[groupName][k];
      if (!p) return;
      if (p.type === 'select') {
        const select = row.querySelector('.tp-select');
        if (select) select.value = p.value;
      } else {
        const slider = row.querySelector('input[type=range]');
        const valEl = row.querySelector('.tp-val');
        if (slider) slider.value = p.value;
        if (valEl) valEl.textContent = formatValue(p.value, p.step);
      }
    });
    showToast(`🔄 Kategori "${GROUP_LABELS[groupName] || groupName}" di-reset`);
  });

  section.appendChild(header);
  section.appendChild(content);
  return section;
}

// ---------------------------------------------------------------------------
// Build a single row (slider or select dropdown)
// ---------------------------------------------------------------------------
function buildParamRow(groupName, key, param) {
  const row = document.createElement('div');
  row.className = 'tp-slider-row';
  row.dataset.key = key;

  // Discrete select dropdown
  if (param.type === 'select') {
    const optionsHtml = (param.options || [])
      .map(
        (opt) =>
          `<option value="${escapeHtml(opt)}" ${opt === param.value ? 'selected' : ''}>${escapeHtml(opt)}</option>`
      )
      .join('');

    row.innerHTML = `
      <div class="tp-label-row">
        <label class="tp-label" title="${escapeHtml(param.desc)}">${escapeHtml(param.label)}</label>
      </div>
      <select class="tp-select">
        ${optionsHtml}
      </select>
      <div class="tp-desc">${escapeHtml(param.desc)}</div>
    `;

    const select = row.querySelector('.tp-select');
    select.addEventListener('change', () => {
      tuning.set(`${groupName}.${key}`, select.value);
    });
    return row;
  }

  // Numeric slider
  row.innerHTML = `
    <div class="tp-label-row">
      <label class="tp-label" title="${escapeHtml(param.desc)}">${escapeHtml(param.label)}</label>
      <span class="tp-val">${formatValue(param.value, param.step)}</span>
    </div>
    <input type="range"
      min="${param.min}" max="${param.max}" step="${param.step}"
      value="${param.value}"
      class="tp-slider" />
    <div class="tp-desc">${escapeHtml(param.desc)}</div>
  `;

  const slider = row.querySelector('.tp-slider');
  const valEl = row.querySelector('.tp-val');

  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    valEl.textContent = formatValue(v, param.step);
    tuning.set(`${groupName}.${key}`, v);
  });

  return row;
}

function formatValue(val, step) {
  if (typeof val !== 'number' || isNaN(val)) return String(val);
  if (step >= 1) return String(Math.round(val));
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return val.toFixed(decimals);
}

// ---------------------------------------------------------------------------
// Save / Load / Reset
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'amika-live2d-tuning-v1';

async function saveSettings() {
  const data = tuning.exportValues();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

  // Persist to server config/animationConfig.json
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      showToast('💾 Pengaturan tersimpan ke animationConfig.json!');
      return;
    }
  } catch (err) {
    console.warn('[TuningPanel] Server save failed, saved to localStorage only:', err);
  }
  showToast('💾 Tersimpan di browser (localStorage)!');
}

async function loadSettings() {
  // 1. Try loading from server first
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const serverConfig = await res.json();
      tuning.importValues(serverConfig);
      syncAllControls();
      return;
    }
  } catch (_) {}

  // 2. Fallback to localStorage
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const data = JSON.parse(raw);
      tuning.importValues(data);
      syncAllControls();
    } catch (e) {
      console.warn('[TuningPanel] Failed to load local settings:', e);
    }
  }
}

function resetSettings() {
  tuning.resetAll();
  syncAllControls();
  showToast('🔄 Semua parameter dikembalikan ke nilai default!');
}

function syncAllControls() {
  if (!panelEl) return;
  const schema = tuning.getSchema();
  for (const [groupName, entries] of Object.entries(schema)) {
    for (const [key, param] of Object.entries(entries)) {
      const row = panelEl.querySelector(`.tp-slider-row[data-key="${key}"]`);
      if (!row) continue;
      if (param.type === 'select') {
        const select = row.querySelector('.tp-select');
        if (select) select.value = param.value;
      } else {
        const slider = row.querySelector('input[type=range]');
        const valEl = row.querySelector('.tp-val');
        if (slider) slider.value = param.value;
        if (valEl) valEl.textContent = formatValue(param.value, param.step);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Toggle visibility
// ---------------------------------------------------------------------------
export function togglePanel(show) {
  if (show === undefined) show = !isOpen;
  isOpen = show;
  panelEl?.classList.toggle('tp-hidden', !isOpen);
}

// ---------------------------------------------------------------------------
// Toast notification
// ---------------------------------------------------------------------------
function showToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'tp-toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('tp-toast-show'));
  setTimeout(() => {
    toast.classList.remove('tp-toast-show');
    setTimeout(() => toast.remove(), 300);
  }, 2200);
}

// ---------------------------------------------------------------------------
// Styles (injected once)
// ---------------------------------------------------------------------------
function injectStyles() {
  if (document.getElementById('tp-styles')) return;
  const style = document.createElement('style');
  style.id = 'tp-styles';
  style.textContent = `
    #tuning-panel {
      position: fixed;
      top: 16px;
      left: 16px;
      width: 360px;
      max-height: calc(100vh - 32px);
      overflow-y: auto;
      background: rgba(16, 16, 28, 0.95);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 12px;
      font-family: system-ui, -apple-system, sans-serif;
      color: #e8e8f0;
      backdrop-filter: blur(10px);
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6);
      z-index: 100;
      display: flex;
      flex-direction: column;
      transition: opacity 0.2s ease, transform 0.2s ease;
    }
    #tuning-panel.tp-hidden {
      opacity: 0;
      pointer-events: none;
      transform: translateX(-24px);
    }
    #tuning-panel::-webkit-scrollbar { width: 5px; }
    #tuning-panel::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.2); border-radius: 3px; }

    .tp-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      position: sticky;
      top: 0;
      background: rgba(16, 16, 28, 0.98);
      z-index: 2;
      border-radius: 12px 12px 0 0;
    }
    .tp-title h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.3px;
      color: #fff;
    }
    .tp-subtitle {
      font-size: 10px;
      color: #888;
      display: block;
      margin-top: 1px;
    }
    .tp-header-btns { display: flex; gap: 6px; }

    .tp-btn {
      padding: 5px 10px;
      font-size: 11px;
      font-weight: 500;
      color: #fff;
      background: #333355;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .tp-btn:hover { background: #4a4a75; border-color: rgba(255, 255, 255, 0.25); }
    .tp-btn:active { background: #5f5f96; }
    .tp-btn.tp-save { background: #1f5042; border-color: #38a169; }
    .tp-btn.tp-save:hover { background: #286856; }
    .tp-btn.tp-reset { background: #4a2828; border-color: #e53e3e; }
    .tp-btn.tp-reset:hover { background: #683838; }

    .tp-btn-mini {
      padding: 2px 6px;
      font-size: 10px;
      color: #888;
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .tp-btn-mini:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }

    .tp-body { padding: 4px 0 12px; }

    .tp-group { border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
    .tp-group:last-child { border-bottom: none; }

    .tp-group-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      cursor: pointer;
      user-select: none;
      transition: background 0.15s;
    }
    .tp-group-header:hover { background: rgba(255, 255, 255, 0.04); }
    .tp-group-arrow { font-size: 10px; color: #888; width: 12px; transition: transform 0.15s; }
    .tp-group-label { flex: 1; font-size: 13px; font-weight: 600; color: #ddd; }
    .tp-group-count { font-size: 11px; color: #666; }

    .tp-group-content { padding: 4px 16px 10px; }
    .tp-group-content.tp-collapsed { display: none; }

    .tp-slider-row { margin-bottom: 12px; }
    .tp-slider-row:last-child { margin-bottom: 4px; }

    .tp-label-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 4px;
    }
    .tp-label {
      font-size: 11px;
      font-weight: 500;
      color: #c4c4d4;
      cursor: help;
    }
    .tp-val {
      font-size: 12px;
      font-family: 'Cascadia Code', 'Fira Code', monospace;
      color: #7df3e1;
      min-width: 48px;
      text-align: right;
    }

    .tp-slider {
      width: 100%;
      height: 4px;
      -webkit-appearance: none;
      appearance: none;
      background: rgba(255, 255, 255, 0.12);
      border-radius: 2px;
      outline: none;
      cursor: pointer;
    }
    .tp-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      background: #7df3e1;
      border-radius: 50%;
      border: 2px solid rgba(16, 16, 28, 0.9);
      cursor: grab;
      transition: transform 0.1s;
    }
    .tp-slider::-webkit-slider-thumb:hover { transform: scale(1.25); }
    .tp-slider:active::-webkit-slider-thumb { cursor: grabbing; }
    .tp-slider::-moz-range-thumb {
      width: 14px;
      height: 14px;
      background: #7df3e1;
      border-radius: 50%;
      border: 2px solid rgba(16, 16, 28, 0.9);
      cursor: grab;
    }

    .tp-select {
      width: 100%;
      padding: 6px 8px;
      background: #252538;
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      font-size: 12px;
      outline: none;
      cursor: pointer;
    }
    .tp-select:hover { border-color: rgba(255, 255, 255, 0.25); }

    .tp-desc {
      font-size: 10px;
      color: #777;
      margin-top: 3px;
      line-height: 1.35;
    }

    .tp-toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: rgba(16, 16, 28, 0.95);
      color: #7df3e1;
      padding: 8px 20px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      border: 1px solid rgba(125, 243, 225, 0.35);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
      z-index: 200;
      opacity: 0;
      transition: opacity 0.25s, transform 0.25s;
      pointer-events: none;
    }
    .tp-toast.tp-toast-show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    @media (max-width: 768px) {
      #tuning-panel {
        left: 0;
        top: 0;
        width: 100vw;
        max-height: 100vh;
        border-radius: 0;
      }
    }
  `;
  document.head.appendChild(style);
}
