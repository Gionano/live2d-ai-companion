// ---------------------------------------------------------------------------
// browserSelfieModal.js  (frontend fallback, Point 21)
// Modal selfie di halaman web ketika aplikasi dibuka lewat browser biasa (non-Electron).
// Menampilkan progress bar saat generate dan preview foto dengan tombol aksi saat selesai.
// ---------------------------------------------------------------------------

let modalContainer = null;
let currentJobId = null;
let autoCloseTimer = null;

function ensureModalContainer(onCancel) {
  if (modalContainer) return modalContainer;

  modalContainer = document.createElement('div');
  modalContainer.id = 'browser-selfie-modal-root';
  modalContainer.innerHTML = `
    <style>
      #browser-selfie-modal-root {
        position: fixed;
        bottom: 24px;
        right: 24px;
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
    </style>
    <div class="b-selfie-card" id="b-card"></div>
  `;

  document.body.appendChild(modalContainer);
  return modalContainer;
}

export function handleBrowserSelfieModal(msg, onCancel = null) {
  ensureModalContainer(onCancel);
  const card = document.getElementById('b-card');
  if (!card) return;

  if (autoCloseTimer) {
    clearInterval(autoCloseTimer);
    autoCloseTimer = null;
  }

  switch (msg.type) {
    case 'selfie_started': {
      currentJobId = msg.jobId;
      modalContainer.style.display = 'block';
      const eta = msg.etaSeconds || 90;
      card.innerHTML = `
        <div class="b-header">
          <span>📸 Amika lagi berfoto...</span>
          <button class="b-btn b-btn-cancel" id="b-btn-cancel-job" style="flex:none; padding: 2px 8px;">Batal</button>
        </div>
        <div class="b-progress-bar">
          <div class="b-progress-fill" id="b-fill"></div>
        </div>
        <div class="b-meta">
          <span id="b-step">Menyiapkan pose...</span>
          <span id="b-eta">Estimasi ~${eta}s</span>
        </div>
      `;

      document.getElementById('b-btn-cancel-job')?.addEventListener('click', () => {
        if (onCancel && currentJobId) onCancel(currentJobId);
        hideBrowserModal();
      });
      break;
    }

    case 'selfie_progress': {
      const fill = document.getElementById('b-fill');
      const step = document.getElementById('b-step');
      if (fill && step) {
        const pct = msg.percentage !== undefined ? msg.percentage : Math.round((msg.value / msg.max) * 100);
        fill.style.width = `${pct}%`;
        step.textContent = `Men-generate... (${pct}%)`;
      }
      break;
    }

    case 'selfie_ready': {
      currentJobId = msg.jobId;
      modalContainer.style.display = 'block';
      const imageUrl = msg.imageUrl;
      const caption = msg.caption || 'Ini fotonya buat kamu sayang~';

      card.innerHTML = `
        <div class="b-header">
          <span>✨ Foto Baru Amika</span>
          <button class="b-btn" id="b-btn-close-card" style="flex:none; padding: 2px 6px;">✕</button>
        </div>
        <div class="b-img-wrapper" id="b-img-wrap" title="Klik untuk membuka tab baru">
          <img class="b-img" id="b-preview-img" src="${imageUrl}" alt="Amika Selfie">
        </div>
        <div class="b-caption">"${caption}"</div>
        <div class="b-actions">
          <a class="b-btn" href="${imageUrl}" download="amika_selfie_${Date.now()}.png" target="_blank">💾 Simpan</a>
          <button class="b-btn" id="b-btn-copy-url">🔗 Salin Link</button>
          <button class="b-btn" id="b-btn-dismiss">Tutup</button>
        </div>
      `;

      const img = document.getElementById('b-preview-img');
      if (img) {
        img.onload = () => img.classList.add('loaded');
      }

      document.getElementById('b-img-wrap')?.addEventListener('click', () => {
        window.open(imageUrl, '_blank');
      });

      document.getElementById('b-btn-close-card')?.addEventListener('click', hideBrowserModal);
      document.getElementById('b-btn-dismiss')?.addEventListener('click', hideBrowserModal);

      document.getElementById('b-btn-copy-url')?.addEventListener('click', async (e) => {
        try {
          const fullUrl = new URL(imageUrl, window.location.origin).href;
          await navigator.clipboard.writeText(fullUrl);
          e.target.textContent = '✓ Disalin';
          setTimeout(() => { e.target.textContent = '🔗 Salin Link'; }, 2000);
        } catch (_) {}
      });

      // Auto close setelah 30 detik
      autoCloseTimer = setTimeout(() => {
        hideBrowserModal();
      }, 30000);
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
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  }
  if (modalContainer) {
    modalContainer.style.display = 'none';
  }
}
