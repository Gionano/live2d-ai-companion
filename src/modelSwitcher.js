// ---------------------------------------------------------------------------
// modelSwitcher.js  (browser-side)
// Manages the Model Selector UI, Model Upload, and Auto-Detect Capabilities Panel.
// ---------------------------------------------------------------------------

let activeModelPath = '';
let modelsList = [];

/**
 * Fetch available models from backend API.
 */
export async function fetchAvailableModels() {
  try {
    const res = await fetch('/api/models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    modelsList = data.models || [];
    activeModelPath = data.activeModelPath || '';
    return { models: modelsList, activeModelPath };
  } catch (err) {
    console.error('[ModelSwitcher] Gagal mengambil daftar model:', err);
    return { models: [], activeModelPath: '' };
  }
}

/**
 * Persist active model to backend.
 */
export async function saveActiveModel(modelPath) {
  try {
    await fetch('/api/models/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelPath }),
    });
    activeModelPath = modelPath;
  } catch (err) {
    console.warn('[ModelSwitcher] Gagal menyimpan active model ke server:', err);
  }
}

/**
 * Render model cards into the selector grid.
 */
export function renderModelsList(companion) {
  const container = document.getElementById('models-list');
  if (!container) return;

  container.innerHTML = '';

  if (modelsList.length === 0) {
    container.innerHTML = '<div class="empty-hint">Tidak ada model ditemukan di public/models/</div>';
    return;
  }

  for (const item of modelsList) {
    const card = document.createElement('div');
    const isCurrentActive = item.modelPath === activeModelPath;
    card.className = `model-card ${isCurrentActive ? 'active' : ''}`;

    const thumbHtml = item.thumbnail
      ? `<img src="${item.thumbnail}" class="model-thumb" alt="${item.name}" onerror="this.src='/vite.svg'" />`
      : `<div class="model-thumb-placeholder">🎭</div>`;

    card.innerHTML = `
      <div class="model-card-left">
        ${thumbHtml}
        <div class="model-card-info">
          <div class="model-name">${escapeHtml(item.name)}</div>
          <div class="model-meta">
            <span class="meta-tag">${item.folder}</span>
            ${item.hasPhysics ? '<span class="meta-badge physics">Physics</span>' : ''}
            ${item.expressionCount > 0 ? `<span class="meta-badge">${item.expressionCount} exp</span>` : ''}
          </div>
        </div>
      </div>
      <div class="model-card-actions">
        ${
          isCurrentActive
            ? '<span class="badge-active">Aktif</span>'
            : `<button class="btn-load-model" data-path="${item.modelPath}">Load</button>`
        }
      </div>
    `;

    const loadBtn = card.querySelector('.btn-load-model');
    if (loadBtn) {
      loadBtn.addEventListener('click', async () => {
        loadBtn.disabled = true;
        loadBtn.textContent = 'Memuat...';
        try {
          await companion.switchModel(item.modelPath);
          await saveActiveModel(item.modelPath);
          activeModelPath = item.modelPath;
          renderModelsList(companion);
        } catch (err) {
          console.error('[ModelSwitcher] Gagal load model:', err);
          alert(`Gagal memuat model: ${err.message}`);
          loadBtn.disabled = false;
          loadBtn.textContent = 'Load';
        }
      });
    }

    container.appendChild(card);
  }
}

/**
 * Render the read-only auto-detect capabilities panel (Requirement 3).
 */
export function updateCapabilitiesPanel(modelInfo) {
  if (!modelInfo) return;

  const nameEl = document.getElementById('cap-model-name');
  const paramCountEl = document.getElementById('cap-param-count');
  const exprCountEl = document.getElementById('cap-expr-count');
  const motionCountEl = document.getElementById('cap-motion-count');
  const physicsEl = document.getElementById('cap-physics-status');

  if (nameEl) nameEl.textContent = `${modelInfo.modelName}`;
  if (paramCountEl) paramCountEl.textContent = `${modelInfo.parameterCount}`;
  if (exprCountEl) exprCountEl.textContent = `${modelInfo.expressionCount}`;

  // Motions
  if (motionCountEl) {
    const groupNames = Object.keys(modelInfo.motionGroups || {});
    motionCountEl.textContent = `${modelInfo.motionCount} (${groupNames.length} grup)`;
  }

  // Physics
  if (physicsEl) {
    if (modelInfo.hasPhysics) {
      const p = modelInfo.physicsStats;
      physicsEl.innerHTML = p
        ? `<span class="text-success">Aktif</span> (${p.rigs} rigs, ${p.outputs} outputs)`
        : `<span class="text-success">Aktif</span>`;
    } else {
      physicsEl.innerHTML = '<span class="text-muted">Tidak Ada</span>';
    }
  }

  // Parameter tags
  const paramSummary = document.getElementById('cap-param-summary');
  const paramList = document.getElementById('cap-param-list');
  if (paramSummary) paramSummary.textContent = `${modelInfo.parameterCount}`;
  if (paramList && modelInfo.parameters) {
    paramList.innerHTML = modelInfo.parameters
      .map(
        (p) =>
          `<span class="cap-tag" title="Min: ${p.min}, Max: ${p.max}, Default: ${p.defaultValue}">${escapeHtml(p.id)}</span>`,
      )
      .join('');
  }

  // Expression tags
  const exprSummary = document.getElementById('cap-expr-summary');
  const exprList = document.getElementById('cap-expr-list');
  if (exprSummary) exprSummary.textContent = `${modelInfo.expressionCount}`;
  if (exprList) {
    if (modelInfo.expressions && modelInfo.expressions.length > 0) {
      exprList.innerHTML = modelInfo.expressions
        .map((e) => `<span class="cap-tag expr">${escapeHtml(e)}</span>`)
        .join('');
    } else {
      exprList.innerHTML = '<span class="empty-hint">(Tidak ada file .exp3.json)</span>';
    }
  }

  // Motion groups & files
  const motionSummary = document.getElementById('cap-motion-summary');
  const motionList = document.getElementById('cap-motion-list');
  if (motionSummary) motionSummary.textContent = `${modelInfo.motionCount}`;
  if (motionList) {
    const groups = modelInfo.motionGroups || {};
    const groupEntries = Object.entries(groups);
    if (groupEntries.length > 0) {
      motionList.innerHTML = groupEntries
        .map(([grp, cnt]) => `<span class="cap-tag motion">${escapeHtml(grp)}: ${cnt} file</span>`)
        .join('');
    } else {
      motionList.innerHTML = '<span class="empty-hint">(Tidak ada motion)</span>';
    }
  }
}

/**
 * Handle model file upload (.zip).
 */
export function setupUploadHandler(companion) {
  const fileInput = document.getElementById('model-file-input');
  const uploadBtn = document.getElementById('upload-model-btn');
  const statusEl = document.getElementById('upload-status');

  if (!fileInput || !uploadBtn) return;

  uploadBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.zip')) {
      alert('Pilih file arsip .zip yang berisi model Live2D.');
      fileInput.value = '';
      return;
    }

    uploadBtn.disabled = true;
    uploadBtn.textContent = '⏳ Mengunggah & Mengekstrak...';
    if (statusEl) statusEl.textContent = 'Sedang mengekstrak file model...';

    const formData = new FormData();
    formData.append('modelFile', file);

    try {
      const res = await fetch('/api/models/upload', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || data.error || 'Upload gagal.');
      }

      if (statusEl) statusEl.textContent = `✅ Berhasil mengekstrak ${file.name}!`;

      // Refresh model list
      await fetchAvailableModels();
      renderModelsList(companion);

      // Automatically load the newly uploaded model
      if (data.modelPath) {
        await companion.switchModel(data.modelPath);
        await saveActiveModel(data.modelPath);
        activeModelPath = data.modelPath;
        renderModelsList(companion);
      }
    } catch (err) {
      console.error('[ModelSwitcher] Upload error:', err);
      alert(`Gagal upload model: ${err.message}`);
      if (statusEl) statusEl.textContent = `❌ ${err.message}`;
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = '📤 Upload Model (.zip)';
      fileInput.value = '';
    }
  });
}

/**
 * Setup Tab Navigation for the Control Panel.
 */
export function setupTabs() {
  const tabButtons = document.querySelectorAll('.panel-tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.tab;
      tabButtons.forEach((b) => b.classList.remove('active'));
      tabContents.forEach((c) => c.classList.remove('active'));

      btn.classList.add('active');
      const targetContent = document.getElementById(targetId);
      if (targetContent) targetContent.classList.add('active');
    });
  });
}

/**
 * Main initialization of Model Switcher.
 */
export async function initModelSwitcher(companion) {
  setupTabs();
  setupUploadHandler(companion);

  const { models, activeModelPath: active } = await fetchAvailableModels();
  activeModelPath = active;
  renderModelsList(companion);

  // Listen to model switched event from companion
  window.addEventListener('waifu-model-switched', (event) => {
    const { modelPath, modelInfo } = event.detail || {};
    if (modelPath) {
      activeModelPath = modelPath;
      renderModelsList(companion);
    }
    if (modelInfo) {
      updateCapabilitiesPanel(modelInfo);
    }
  });

  // If companion model is already loaded, update panel immediately
  const initialInfo = companion.getModelInfo();
  if (initialInfo) {
    updateCapabilitiesPanel(initialInfo);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
