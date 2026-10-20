# Amika Desktop Companion (Electron)

Aplikasi desktop Windows pendamping (*desktop companion*) berbasis Electron untuk **Amika Live2D AI Waifu**. Aplikasi ini menghadirkan avatar Live2D transparan yang melayang di desktop Windows, kontrol lengkap via System Tray, mode edit posisi/ukuran per-monitor, pintasan keyboard global (*global shortcuts*), dan pengambilan tangkapan layar langsung (*direct screen capture*) tanpa popup browser "Share Screen".

---

## 🌟 Fitur Desktop Companion

1. **Overlay Avatar Transparan Melayang (`?mode=overlay`)**:
   - `transparent: true`, `frame: false`, `alwaysOnTop: true` (level `screen-saver`), `skipTaskbar: true`.
   - Latar belakang tembus pandang tanpa kotak hitam atau border sistem operasi.
   - Live2D Fit-to-Bounds adaptif yang menjaga proporsi model penuh dari mahkota hingga sepatu.
   - Pembatasan FPS rendering hemat daya (default 30 FPS).

2. **Dua Preset Tampilan**:
   - **Dengan Sayap (`with-wings`)**: Tampilan landscape mengikuti rasio sayap es (lebar ~1138 px, tinggi ~937 px).
   - **Tanpa Sayap (`without-wings`)**: Tampilan portrait ramping (~420×640 px) dengan sayap dinonaktifkan otomatis melalui parameter Live2D `Param41 = 1.0`.

3. **Click-Through & Mode Edit Fleksibel**:
   - **Mode Normal (Click-Through ON)**: Klik mouse tembus ke game, browser, atau aplikasi di balik avatar.
   - **Mode Edit (`Ctrl+Alt+E`)**: Mouse events aktif, muncul garis tepi lembut dan handle drag kustom yang memungkinkan jendela digeser melintasi tepi monitor maupun taskbar Windows, serta di-resize dengan rasio aspek terkunci.
   - Keluar dari Mode Edit otomatis mengaktifkan kembali click-through dan menyimpan posisi/ukuran ke `userData` (`window-state.json`).

4. **System Tray & Global Shortcuts**:
   - Ikon kristal es di system tray dengan menu lengkap:
     - Tampilkan / Sembunyikan Avatar (`Ctrl+Alt+H`)
     - Mode Edit Posisi / Ukuran (`Ctrl+Alt+E`)
     - Click-Through Toggle
     - Screen Vision (Capture Layar) ON/OFF
     - Submenu Pilih Monitor (pindah antar display)
     - Reset Posisi ke Default
     - Mute Mikrofon (`Ctrl+Alt+M`)
     - Mulai bersama Windows (*autostart*)
     - Keluar
   - Sinkronisasi status checked real-time antara tray, renderer, dan backend.

5. **Direct Screen Capture (Tanpa Popup Izin Browser)**:
   - Menggunakan `desktopCapturer` di main process (dengan fallback Win32 GDI khusus multi-GPU).
   - **Proteksi Avatar (`setContentProtection(true)`)**: Avatar Live2D otomatis disembunyikan dari hasil capture desktop (DWM `WDA_EXCLUDEFROMCAPTURE`), sehingga gambar yang dikirim ke LLM vision bersih tanpa avatar menutupi layar.
   - Rate limiting 500 ms dan deteksi frame hitam / konten DRM / game Exclusive Fullscreen.

---

## ⌨️ Daftar Global Shortcut

| Shortcut Default | Fungsi | Keterangan |
| :--- | :--- | :--- |
| **`Ctrl + Alt + E`** | Toggle Mode Edit Posisi & Ukuran | Aktifkan untuk menggeser/mengubah ukuran; matikan untuk kembali click-through. |
| **`Ctrl + Alt + M`** | Toggle Mute Mikrofon | Menghentikan pengiriman suara mic & VAD ke AI tanpa menutup aplikasi. |
| **`Ctrl + Alt + H`** | Tampilkan / Sembunyikan Avatar | Menyembunyikan avatar sementara dari desktop. |

> *Catatan:* Jika shortcut bentrok dengan aplikasi lain di Windows, Companion akan mencatatnya di log dan menampilkan notifikasi balon di system tray tanpa membuat aplikasi crash.

---

## 🖥️ Cara Memilih Monitor

1. Klik kanan ikon **Amika** di **System Tray** (pojok kanan bawah taskbar Windows).
2. Arahkan ke submenu **"Pilih Monitor"**.
3. Klik monitor target yang diinginkan (misal *Monitor 1 (Utama)* atau *Monitor 2*).
4. Avatar akan otomatis berpindah ke monitor tersebut dan memulihkan posisi/ukuran yang tersimpan khusus untuk monitor tersebut.

---

## ⚠️ Batasan Teknis & Troubleshooting

1. **Game Mode Exclusive Fullscreen**:
   - Game DirectX/Vulkan yang berjalan di mode *Exclusive Fullscreen* mengambil alih peranti keras layar secara eksklusif. Hal ini dapat membuat capture layar tampak hitam total atau overlay avatar tertutup.
   - **Solusi**: Ubah pengaturan tampilan game menjadi **Borderless Windowed** atau **Windowed Fullscreen**. Avatar akan otomatis menginstruksikan: *"layarnya tidak bisa kulihat, coba mode borderless"*.
2. **Konten Dilindungi DRM (Netflix, Spotify, browser dengan hardware acceleration tertentu)**:
   - Layanan streaming dengan proteksi DRM HDCP akan menghasilkan kotak hitam pada area video di hasil capture.
3. **Anti-Cheat Ring-0 / Kernel-Level**:
   - Beberapa game kompetitif dengan anti-cheat ketat memblokir overlay pihak ketiga yang memiliki level `screen-saver`. Companion dirancang pasif dan tidak menyuntikkan kode (*no DLL injection*) ke dalam proses game apa pun.
4. **Dukungan Windows OS**:
   - Fitur `setContentProtection(true)` yang bersih (avatar tidak tampak sebagai kotak hitam di hasil capture) membutuhkan minimal **Windows 10 versi 2004 (Build 19041)** atau **Windows 11**.

---

## 🚀 Panduan Pengembangan (Development)

### 1. Prasyarat
- Node.js versi 18+
- Backend server utama dan frontend Vite sudah terpasang di folder root.

### 2. Menjalankan Mode Dev
Pastikan server backend (`PORT 8787`) dan Vite dev server (`PORT 5173`) sudah berjalan di folder root:
```bash
# Terminal 1 (Root project): Jalankan backend
npm run server

# Terminal 2 (Root project): Jalankan Vite frontend
npm run dev
```

Lalu jalankan Desktop Companion dari folder `desktop-companion`:
```bash
cd desktop-companion
npm install
npm run dev
```
Mode dev akan memuat `http://localhost:5173/?mode=overlay`. Jika ingin membuka DevTools Electron untuk inspeksi:
```bash
npx electron . --devtools
```

---

## 📦 Panduan Build & Packaging (Produksi)

Untuk membuat paket installer Windows standalone (.exe installer NSIS):

1. **Build Frontend Statis**:
   ```bash
   cd desktop-companion
   npm run build:frontend
   ```
   Langkah ini menghasilkan aset web statis di folder `dist/` project root.

2. **Jalankan Electron Builder**:
   ```bash
   npm run dist
   ```
   Perintah ini akan membaca konfigurasi di `package.json` dan menghasilkan installer Windows x64 di dalam folder **`dist-electron/`**:
   - `Amika Desktop Companion Setup 0.1.0.exe` (Installer NSIS interaktif)

3. **Keamanan Build**:
   - File `.env`, kredensial API, source code backend, dan secret keys **TIDAK PERNAH** dimasukkan ke dalam paket installer Electron.
   - Pengaturan keamanan `contextIsolation: true`, `nodeIntegration: false`, dan `sandbox: true` aktif secara default.

---

## 🙏 Credits & Attribution

1. **Model Live2D — IceGirl**:
   - Dibuat oleh **tianyelulu** dan tersedia secara gratis di [BOOTH (IceGirl Model)](https://tianyelulu.booth.pm/items/5975192).
   - Seluruh hak cipta, desain karakter, dan hak kekayaan intelektual model Live2D tetap menjadi milik kreator aslinya (**tianyelulu**).

2. **Live2D Cubism SDK**:
   - Ditenagai oleh [Live2D Cubism SDK for Web](https://www.live2d.com/en/sdk/about/) dari **Live2D Inc.**
   - Tunduk pada [Live2D Open Software License Agreement](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html).
