import { Live2DCompanion } from './live2dCompanion.js';
import { COSTUME_TOGGLES } from './expressionMap.js';
import { initModelSwitcher } from './modelSwitcher.js';
import { initTuningPanel, togglePanel } from './tuningPanel.js';

const canvas = document.getElementById('app');
const status = document.getElementById('status');
const companion = new Live2DCompanion(canvas, status);

// Inisialisasi Live2D Tuning Panel
initTuningPanel();

// Tombol buka Tuning Panel
document.querySelector('#open-tuning-btn')?.addEventListener('click', () => {
  togglePanel();
});

// Shortcut keyboard 'T' untuk toggle Tuning Panel
window.addEventListener('keydown', (e) => {
  if (e.key === 't' || e.key === 'T') {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    togglePanel();
  }
});

// Emotion cue dari companion.js (via CustomEvent).
window.addEventListener('waifu-emotion-cue', (event) => {
  companion.setEmotionCue(event.detail?.emotion ?? 'netral', event.detail?.endAt ?? 0);
});

// Rebuild costume toggles whenever model switches.
window.addEventListener('waifu-model-switched', () => {
  buildCostumeToggles();
});

// Debug panel: test lip-sync.
document.querySelector('#live2d-test-lipsync')?.addEventListener('click', async () => {
  if (window.__waifuTestLipSync) {
    await window.__waifuTestLipSync();
    return;
  }
  if (window.__live2dTestSpeaking) return;
  const started = performance.now();
  window.__live2dTestSpeaking = true;
  window.__live2dTestLevel = () => {
    const elapsed = (performance.now() - started) / 1000;
    if (elapsed > 3) {
      window.__live2dTestSpeaking = false;
      window.__live2dTestLevel = null;
      return 0;
    }
    return Math.max(0, Math.sin(elapsed * 13) * 0.55 + Math.sin(elapsed * 29) * 0.2);
  };
});

// ---------------------------------------------------------------------------
// Costume toggles: manual on/off untuk aksesoris, independen dari emosi LLM.
// Dinamis sesuai ekspresi yang tersedia pada model aktif.
// ---------------------------------------------------------------------------
function buildCostumeToggles() {
  const container = document.getElementById('costume-toggles');
  if (!container) return;
  container.innerHTML = '';

  const activeCostumes = new Set();
  const availableExpressions = companion.getExpressionNames();

  if (availableExpressions.length === 0) {
    container.innerHTML = '<span style="font-size:12px;color:#888;">(Model ini tidak memiliki file ekspresi/kostum tambahan)</span>';
    return;
  }

  // Filter COSTUME_TOGGLES to only ones present in this model
  const matchingCostumes = COSTUME_TOGGLES.filter((c) => availableExpressions.includes(c.name));

  if (matchingCostumes.length > 0) {
    for (const costume of matchingCostumes) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#c4c4d4;';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.style.cssText = 'accent-color:#5f5f96;';
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          companion.setExpression(costume.name);
          activeCostumes.add(costume.name);
        } else {
          companion.setExpression('netral');
          activeCostumes.delete(costume.name);
          for (const active of activeCostumes) {
            companion.setExpression(active);
          }
        }
      });
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(costume.label));
      container.appendChild(label);
    }
  } else {
    // List generic available expressions for custom/other models
    for (const exprName of availableExpressions) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#c4c4d4;';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.style.cssText = 'accent-color:#5f5f96;';
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          companion.setExpression(exprName);
          activeCostumes.add(exprName);
        } else {
          companion.setExpression('netral');
          activeCostumes.delete(exprName);
          for (const active of activeCostumes) {
            companion.setExpression(active);
          }
        }
      });
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(exprName));
      container.appendChild(label);
    }
  }
}

// ---------------------------------------------------------------------------
// Initialize Companion & Model Switcher
// ---------------------------------------------------------------------------
companion.initialize().then(() => {
  buildCostumeToggles();
  initModelSwitcher(companion);
}).catch((error) => {
  console.error('[Live2D] Gagal load:', error);
  status.textContent = `Live2D gagal: ${error.message}`;
});
