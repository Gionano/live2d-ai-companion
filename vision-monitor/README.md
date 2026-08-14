# Vision Monitor — Standalone Streaming VLM & Perception Feed

Aplikasi pemantau visual real-time terpisah untuk sistem companion Amika. Menangkap layar (screen capture) atau webcam dengan frekuensi 1 frame/detik secara kontinu, mendeskripsikan setiap frame dengan **MiniMax M3** via 9inference, menampung deskripsi ke buffer in-memory, dan memfilter buffer secara periodik dengan **DeepSeek V4 Flash** untuk mengirim komentar spontan ke Companion Utama melalui WebSocket.

---

## 🏗️ Arsitektur Sistem

```
[Screen / Webcam]
       │
       ▼ (1 frame / detik base64 via WebSocket lokal)
[Vision Monitor Frontend (Vite :5174)]
       │
       ▼
[Vision Monitor Backend Server (Express/WS :3001)]
       │
       ├──► 1. MiniMax M3 (minimax-m3) -> Deskripsi 1 kalimat
       │    └── Ditampung ke in-memory buffer (default window: 30s)
       │
       ├──► 2. DeepSeek V4 Flash (deepseek-v4-flash) -> Filter Periodik
       │    ├── [SKIP] -> Kosongkan buffer, tidak kirim apapun
       │    └── [COMMENT] -> Hasilkan komentar spontan + emosi
       │
       └──► 3. WebSocket Client -> Kirim pesan ke Companion Utama
            └── ws://localhost:8787/ws ({ type: "spontaneous_vision_comment", text, emotion })
```

---

## 🚀 Cara Menjalankan

### 1. Masuk ke folder `vision-monitor`
```bash
cd vision-monitor
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Konfigurasi `.env`
Pastikan file `.env` sudah terisi `NINEINFERENCE_API_KEY`:
```env
NINEINFERENCE_API_KEY=your_9inference_key_here
PORT=3001
MAIN_COMPANION_WS_URL=ws://localhost:8787/ws
```

### 4. Jalankan Server & Frontend Sekaligus
```bash
npm run start
```
Atau jalankan secara terpisah di 2 terminal:
```bash
# Terminal 1: Backend Server (Port 3001)
npm run server

# Terminal 2: Frontend UI (Port 5174)
npm run dev
```

Buka UI di browser: **`http://localhost:5174`**

---

## 🎛️ Fitur UI Vision Monitor
1. **Source Selection**: Pilihan Screen Capture atau Webcam.
2. **Visual Feedback Flash**: Border hijau berkedip setiap 1 detik saat frame berhasil di-capture.
3. **Konfigurasi Dynamic**:
   - Resolusi (640x480, 800x600, 1280x720, 1920x1080)
   - Buffer Window Slider (5s - 120s)
   - Max Tokens
4. **Real-time Cost & Token Counter**: Menghitung estimasi pengeluaran MiniMax M3 + DeepSeek V4 Flash dalam USD dan Rupiah.
5. **Live Feed & Filter Logs**: Feed deskripsi mentah + kartu highlight momen yang terpilih dikirim ke companion.
