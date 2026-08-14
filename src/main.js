import { Live2DCompanion } from './live2dCompanion.js';
import { COSTUME_TOGGLES } from './expressionMap.js';

const canvas = document.getElementById('app');
const status = document.getElementById('status');
const companion = new Live2DCompanion(canvas, status);

// Emotion cue dari companion.js (via CustomEvent).
window.addEventListener('waifu-emotion-cue', (event) => {
  companion.setEmotionCue(event.detail?.emotion ?? 'netral', event.detail?.endAt ?? 0);
});

// Debug panel: tombol emosi.
document.querySelectorAll('#debug-panel button[data-emotion]').forEach((button) => {
  button.addEventListener('click', () => companion.setEmotion(button.dataset.emotion));
});

// Debug panel: raw expression dropdown.
document.querySelector('#live2d-expression-select')?.addEventListener('change', (event) => {
  companion.setExpression(event.target.value);
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
// ---------------------------------------------------------------------------
function buildCostumeToggles() {
  const container = document.getElementById('costume-toggles');
  if (!container) return;

  // Track active costumes so we can toggle them.
  const activeCostumes = new Set();

  for (const costume of COSTUME_TOGGLES) {
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
        // To "remove" a costume, we stop it. But since expressions are additive
        // in Cubism, we need to clear all and re-apply actives.
        companion.setExpression('netral'); // clear all
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
}

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------
companion.initialize().then(() => {
  // Populate raw expression dropdown.
  const select = document.querySelector('#live2d-expression-select');
  if (select) {
    for (const name of companion.getExpressionNames()) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.append(option);
    }
  }
  // Build costume toggle checkboxes.
  buildCostumeToggles();
}).catch((error) => {
  console.error('[Live2D] Gagal load:', error);
  status.textContent = `Live2D gagal: ${error.message}`;
});
