// ---------------------------------------------------------------------------
// Browser fallback for selfie progress and image previews.
// ---------------------------------------------------------------------------

let modalContainer = null;
let currentJobId = null;
let autoCloseTimer = null;
let currentState = null;
let cancelCallback = null;
const retiredJobs = new Set();

function ensureModalContainer() {
  if (modalContainer) return modalContainer;

  modalContainer = document.createElement('div');
  modalContainer.id = 'browser-selfie-modal-root';
  modalContainer.innerHTML = `
    <style>
      #browser-selfie-modal-root {
        position: fixed;
        bottom: 24px;
        right: 24px;
        max-width: calc(100vw - 24px);
        z-index: 10000;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #f0f6fc;
      }
      .b-selfie-card {
        background: rgba(18, 22, 32, 0.92);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(110, 190, 255, 0.35);
        border-radius: 12px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.6);
        padding: 12px 14px;
        width: 320px;
        box-sizing: border-box;
        max-width: 100%;
        max-height: calc(100dvh - 48px);
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
        animation: bSlideUp 0.3s ease;
      }
      .b-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 13px;
        font-weight: 600;
      }
      .b-progress-bar {
        width: 100%;
        height: 6px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
        overflow: hidden;
      }
      .b-progress-fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #4facfe, #00f2fe);
        transition: width 0.3s ease;
      }
      .b-meta {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: #8b9bb4;
      }
      .b-img-wrapper {
        width: 100%;
        max-height: 260px;
        overflow: hidden;
        border-radius: 8px;
        cursor: pointer;
        display: flex;
        justify-content: center;
        background: #000;
        padding: 0;
        border: 0;
      }
      .b-img {
        max-width: 100%;
        max-height: 260px;
        object-fit: cover;
        opacity: 0;
        transition: opacity 0.5s ease;
      }
      .b-img.loaded {
        opacity: 1;
      }
      .b-caption {
        font-size: 12px;
        line-height: 1.4;
        background: rgba(255, 255, 255, 0.05);
        padding: 6px 8px;
        border-radius: 6px;
        border-left: 3px solid #5ab2ff;
        font-style: italic;
        overflow-wrap: anywhere;
      }
      .b-actions {
        display: flex;
        gap: 6px;
        margin-top: 4px;
      }
      .b-btn {
        flex: 1;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: #f0f6fc;
        padding: 6px;
        font-size: 11px;
        border-radius: 6px;
        cursor: pointer;
        text-align: center;
        text-decoration: none;
      }
      .b-btn:hover {
        background: rgba(255, 255, 255, 0.18);
        border-color: #5ab2ff;
      }
      .b-btn:focus-visible, .b-img-wrapper:focus-visible {
        outline: 2px solid #5ab2ff;
        outline-offset: 3px;
      }
      .b-btn:disabled { opacity: 0.6; cursor: wait; }
      .b-btn-cancel {
        color: #ff5a79;
        border-color: rgba(255, 90, 121, 0.4);
      }
      .b-btn-cancel:hover {
        background: #ff5a79;
        color: white;
      }
      @keyframes bSlideUp {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      @media (max-width: 380px) {
        #browser-selfie-modal-root { right: 12px; bottom: 12px; }
      }
      @media (prefers-reduced-motion: reduce) {
        .b-selfie-card { animation: none; }
        .b-img, .b-progress-fill { transition: none; }
      }
    </style>
    <div class="b-selfie-card" id="b-card" role="region" aria-label="Foto Amika"></div>
  `;

  document.body.appendChild(modalContainer);
  modalContainer.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && currentState === 'ready') hideBrowserModal();
  });
  return modalContainer;
}

function retireJob(jobId) {
  if (!jobId) return;
  retiredJobs.add(jobId);
  if (retiredJobs.size > 32) retiredJobs.delete(retiredJobs.values().next().value);
}

function clearAutoClose() {
  if (autoCloseTimer !== null) clearTimeout(autoCloseTimer);
  autoCloseTimer = null;
}

function resolveImageUrl(value) {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || url.username || url.password ||
        url.search || url.hash || !/^\/api\/selfies\/[a-f0-9]{32}$/.test(url.pathname)) return null;
    return url.href;
  } catch (_) {
    return null;
  }
}

function updateEta(value) {
  const eta = document.getElementById('b-eta');
  if (eta) eta.textContent = typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `Estimasi ~${Math.round(value)}s`
    : 'Estimasi belum tersedia';
}

export function handleBrowserSelfieModal(msg, onCancel = null) {
  if (!msg || !['selfie_started', 'selfie_progress', 'selfie_ready', 'selfie_failed', 'selfie_cancelled'].includes(msg.type) ||
      typeof msg.jobId !== 'string' || !msg.jobId || retiredJobs.has(msg.jobId)) return;
  if (msg.type === 'selfie_started' && msg.status === 'queued') return;
  if (msg.type === 'selfie_progress' || msg.type === 'selfie_failed' || msg.type === 'selfie_cancelled') {
    if (msg.jobId !== currentJobId || currentState !== 'progress') return;
  }
  if (msg.type === 'selfie_started' && msg.jobId === currentJobId) {
    if (currentState === 'progress') {
      cancelCallback = onCancel;
      updateEta(msg.etaSeconds);
    }
    return;
  }
  if (msg.type === 'selfie_ready' && msg.jobId === currentJobId && currentState === 'ready') return;
  const readyImageUrl = msg.type === 'selfie_ready' ? resolveImageUrl(msg.imageUrl) : null;
  if (msg.type === 'selfie_ready' && (!readyImageUrl || currentState === 'progress' && msg.jobId !== currentJobId)) return;
  ensureModalContainer();
  const card = document.getElementById('b-card');
  if (!card) return;

  switch (msg.type) {
    case 'selfie_started': {
      retireJob(currentJobId);
      clearAutoClose();
      currentJobId = msg.jobId;
      currentState = 'progress';
      cancelCallback = onCancel;
      modalContainer.style.display = 'block';
      card.innerHTML = `
        <div class="b-header">
          <span>Amika lagi berfoto...</span>
          <button class="b-btn b-btn-cancel" id="b-btn-cancel-job" style="flex:none; padding: 2px 8px;">Batal</button>
        </div>
        <div class="b-progress-bar" role="progressbar" aria-label="Progres foto" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="b-progress">
          <div class="b-progress-fill" id="b-fill"></div>
        </div>
        <div class="b-meta">
          <span id="b-step" role="status">Menyiapkan pose...</span>
          <span id="b-eta"></span>
        </div>
      `;
      updateEta(msg.etaSeconds);
      const button = document.getElementById('b-btn-cancel-job');
      button?.addEventListener('click', async () => {
        const jobId = currentJobId;
        button.disabled = true;
        try {
          if (typeof cancelCallback !== 'function' || await cancelCallback(jobId) === false) {
            throw new Error('Cancellation unavailable');
          }
          if (currentJobId === jobId && currentState === 'progress') hideBrowserModal();
        } catch (_) {
          if (currentJobId === jobId && currentState === 'progress') {
            button.disabled = false;
            document.getElementById('b-step').textContent = 'Belum terhubung. Coba batal lagi.';
          }
        }
      });
      break;
    }

    case 'selfie_progress': {
      const fill = document.getElementById('b-fill');
      const step = document.getElementById('b-step');
      if (fill && step) {
        const percentage = typeof msg.percentage === 'number' ? msg.percentage
          : typeof msg.value === 'number' && typeof msg.max === 'number' && msg.max > 0 ? msg.value / msg.max * 100 : 0;
        const pct = Number.isFinite(percentage) ? Math.round(Math.min(100, Math.max(0, percentage))) : 0;
        fill.style.width = `${pct}%`;
        document.getElementById('b-progress')?.setAttribute('aria-valuenow', String(pct));
        step.textContent = `Men-generate... (${pct}%)`;
      }
      break;
    }

    case 'selfie_ready': {
      const imageUrl = readyImageUrl;
      if (msg.jobId !== currentJobId) retireJob(currentJobId);
      clearAutoClose();
      currentJobId = msg.jobId;
      currentState = 'ready';
      modalContainer.style.display = 'block';
      const caption = typeof msg.caption === 'string' && msg.caption ? msg.caption : 'Ini fotonya buat kamu sayang~';

      card.innerHTML = `
        <div class="b-header">
          <span>Foto Baru Amika</span>
          <button class="b-btn" id="b-btn-close-card" aria-label="Tutup foto" style="flex:none; padding: 2px 6px;">×</button>
        </div>
        <button class="b-img-wrapper" id="b-img-wrap" title="Klik untuk membuka tab baru" aria-label="Perbesar foto di tab baru">
          <img class="b-img" id="b-preview-img" alt="Foto Amika">
        </button>
        <div class="b-caption" id="b-caption"></div>
        <div class="b-actions">
          <a class="b-btn" id="b-btn-save" target="_blank" rel="noopener noreferrer">Simpan</a>
          <button class="b-btn" id="b-btn-copy-url">Salin Link</button>
          <button class="b-btn" id="b-btn-dismiss">Tutup</button>
        </div>
      `;
      document.getElementById('b-caption').textContent = `"${caption}"`;
      const save = document.getElementById('b-btn-save');
      save.href = imageUrl;
      save.download = `amika_selfie_${Date.now()}.png`;

      const img = document.getElementById('b-preview-img');
      if (img) {
        img.onload = () => img.classList.add('loaded');
        img.onerror = () => {
          if (currentJobId === msg.jobId && currentState === 'ready') {
            img.alt = 'Foto gagal dimuat';
            img.classList.add('loaded');
            document.getElementById('b-caption').textContent = 'Foto gagal dimuat. Coba buka lagi nanti.';
          }
        };
        img.src = imageUrl;
      }

      document.getElementById('b-img-wrap')?.addEventListener('click', () => {
        window.open(imageUrl, '_blank', 'noopener,noreferrer');
      });

      document.getElementById('b-btn-close-card')?.addEventListener('click', hideBrowserModal);
      document.getElementById('b-btn-dismiss')?.addEventListener('click', hideBrowserModal);

      document.getElementById('b-btn-copy-url')?.addEventListener('click', async (e) => {
        const button = e.currentTarget;
        try {
          await navigator.clipboard.writeText(imageUrl);
          button.textContent = 'Disalin';
          setTimeout(() => { button.textContent = 'Salin Link'; }, 2000);
        } catch (_) {
          button.textContent = 'Gagal menyalin';
        }
      });

      const autoCloseSeconds = typeof msg.autoCloseSeconds === 'number' && Number.isFinite(msg.autoCloseSeconds) && msg.autoCloseSeconds >= 0
        ? msg.autoCloseSeconds : 30;
      if (autoCloseSeconds > 0) autoCloseTimer = setTimeout(hideBrowserModal, Math.min(autoCloseSeconds * 1000, 2147483647));
      break;
    }

    case 'selfie_failed':
    case 'selfie_cancelled': {
      hideBrowserModal();
      break;
    }
  }
}

function hideBrowserModal() {
  clearAutoClose();
  retireJob(currentJobId);
  currentState = 'closed';
  if (modalContainer) {
    modalContainer.style.display = 'none';
  }
}
