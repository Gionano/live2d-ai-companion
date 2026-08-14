# Amika — Live2D AI Companion & Streaming Vision Perception

Aplikasi AI companion interaktif berbasis browser yang menghadirkan karakter **Amika** dalam bentuk avatar **Live2D Cubism** resmi. Dilengkapi percakapan suara hands-free berlatensi rendah (*Voice-to-Voice*), animasi natural multi-layer (*synthetic face tracking*, *audio-reactive body sway*, *sentence-break clips*), 12 ekspresi emosi kontekstual, persepsi visual kamera/webcam, serta pemantauan layar (*continuous screen vision*) dengan filter spontan berkala.

---

## 🌟 Fitur Utama

1. **Avatar Live2D Cubism 5.0 (Model IceGirl)**:
   - Rendering WebGL resmi dengan physics controller dinamis (gerakan rambut, aksesoris, dan gaun).
   - Animasi pernapasan (*breathing*) dan kedipan mata (*auto-blink*) kontinu.
   - **Synthetic Face Tracking**: Simulasi gerakan kepala (*yaw/pitch/roll*), *eye gaze saccade & fixation*, dan mikro-gerakan alis menggunakan *Simplex Noise* prosedural ala VTube Studio.
   - **Multi-Layer Talking Animation**:
     - *Layer 1 (Audio-Reactive)*: Asymmetric EMA smoothing menggerakkan badan dan kepala mengikuti irama suara TTS secara organik.
     - *Layer 2 (Sentence-Break Clips)*: Memicu gerakan transisi halus di jeda kalimat berdasarkan intensitas emosi.

2. **Sistem Emosi Terstruktur (12 Emosi)**:
   - LLM secara terstruktur menentukan ekspresi emosi bahasa Indonesia: `terkejut`, `marah`, `bingung`, `jengkel`, `malu`, `kesal`, `sedih`, `kagum`, `sayang`, `jahil`, `penasaran`, dan `netral`.
   - Mengubah file ekspresi `.exp3.json` Live2D secara otomatis saat berbicara.

3. **Percakapan Hands-Free Real-Time (STT → LLM → TTS)**:
   - **STT (Groq Whisper Large v3 Turbo)**: Deteksi suara otomatis via Web Audio VAD di browser, dilengkapi prompt kontekstual dan penyaringan halusinasi/noise non-suara (`no_speech_prob`).
   - **LLM Streaming (DeepSeek V4 Flash via 9inference)**: Parsing JSON streaming terurut untuk mengirim emosi sebelum kalimat pertama selesai di-generate.
   - **TTS Streaming (Fish Audio)**: Streaming chunk MP3 per kalimat langsung ke Web Audio API untuk meminimalkan delay ke audio pertama (*Time-to-First-Audio*).

4. **Persepsi Visual Cerdas (Webcam vs Screen Routing)**:
   - Mendeteksi intent permintaan lihat visual dan otomatis membedakan sumber:
     - **Webcam**: Saat user menunjukkan benda fisik (*"ini benda apa?"*).
     - **Screen/Layar**: Saat user membahas layar/game (*"coba lihat layar/game aku"*). Jika screen belum di-share, Amika secara natural mengingatkan user untuk klik *Share Screen*.
   - Menggunakan model **MiniMax M3** via 9inference untuk deskripsi visual padat 1 kalimat.

5. **Streaming Vision & Spontaneous Commentary**:
   - Pemantauan layar kontinu (1 FPS) saat screen share aktif.
   - Buffer in-memory dievaluasi secara periodik oleh DeepSeek V4 Flash: jika ada momen menarik, Amika langsung berceletuk secara spontan (*spontaneous commentary*) lengkap dengan suara TTS dan animasi avatar.

6. **Mobile Responsive & Camera Toggle**:
   - Layout Picture-in-Picture (PiP) adaptif untuk tampilan mobile dengan video kamera full-screen sebagai background dan tombol toggle kamera depan/belakang (*user* vs *environment*).

7. **Vision Monitor (Standalone Observer Panel)**:
   - Aplikasi dashboard terpisah bergaya StreamingVLM untuk memantau feed layar, membaca log deskripsi MiniMax M3 secara live, melihat kartu evaluasi filter, memantau running cost ($ & Rp), serta mengatur interval capture secara remote.

---

## 🏛️ Arsitektur Sistem

```
┌────────────────────────────────────────────────────────┐
│               Browser (Companion Client)               │
│  - Live2D Canvas (IceGirl) & Web Audio Analyser        │
│  - Hands-Free VAD Recorder + Camera/Screen Capture     │
└───────────────────────────▲────────────────────────────┘
                            │ WebSocket (/ws)
┌───────────────────────────▼────────────────────────────┐
│              Node.js Server Orchestrator               │
│  - STT Proxy (Groq Whisper Large v3 Turbo)             │
│  - LLM Chat Streamer (DeepSeek V4 Flash via 9inference)│
│  - Vision Router & Continuous Manager (MiniMax M3)     │
│  - TTS Streamer (Fish Audio)                           │
└───────────────────────────▲────────────────────────────┘
                            │ WebSocket Telemetry & Config
┌───────────────────────────▼────────────────────────────┐
│          Vision Monitor App (Port 3001/5174)           │
│  - Live Stream Push Preview                            │
│  - Realtime MiniMax M3 Log Feed & Cost Tracker         │
│  - Remote Config Slider (Interval Capture, Tokens)     │
└────────────────────────────────────────────────────────┘
```

---

## 🛠️ Tech Stack & Powered By

- **Frontend Avatar**: Vanilla JavaScript, Vite, HTML5 Canvas, WebGL, Web Audio API, Official Live2D Cubism Core & Framework 5.0.
- **Backend Server**: Node.js, Express, `ws` (WebSocket Server).
- **AI Services & APIs**:
  - **[9inference](https://9inference.cloud)**: LLM Chat & Buffer Filtering (`deepseek-v4-flash`), Visual Perception (`minimax-m3`).
  - **[Groq](https://groq.com)**: Speech-to-Text inference ultra-cepat (`whisper-large-v3-turbo`).
  - **[Fish Audio](https://fish.audio)**: Neural Speech Synthesis & real-time streaming TTS.

---

## 📦 Struktur Folder

```
my waipu/
├── index.html                   # Halaman utama companion (Live2D avatar + chat panel)
├── package.json                 # Dependencies companion utama
├── vite.config.js               # Konfigurasi Vite (Port 5173)
├── .env.example                 # Template environment variables
├── server/                      # Backend Orchestrator
│   ├── index.js                 # Entry point Express & WebSocket server (/ws)
│   ├── streamingVisionManager.js# Pipeline vision kontinu & filter spontan
│   ├── visionCapture.js         # Routing intent vision (screen vs webcam)
│   ├── llmChat.js               # Streaming chat & structured JSON parser
│   ├── sttTranscribe.js         # STT Groq Whisper + noise filter
│   ├── ttsGenerate.js           # TTS Fish Audio streaming
│   ├── personality.js           # System prompt Amika (12 emosi)
│   ├── modelConfig.js           # Konfigurasi model ID 9inference
│   ├── nineInferenceClient.js   # OpenAI client ke 9inference.cloud
│   ├── groqClient.js            # Groq SDK instance
│   └── voiceConfig.js           # Konfigurasi TTS
├── src/                         # Frontend Avatar & Logika Browser
│   ├── main.js                  # Setup Live2D, resize canvas, lip-sync loop
│   ├── live2dCompanion.js       # Live2D model controller, layers, & motion manager
│   ├── syntheticTracking.js     # Simplex noise procedural face & eye tracking
│   ├── expressionMap.js         # Mapping 12 emosi ke file .exp3.json & intensitas
│   └── companion.js             # VAD audio recording, screen share, & WS connection
├── public/                      # Static Assets
│   └── models/live2d/           # Asset model Live2D IceGirl (.moc3, textures, .exp3, .motion3)
└── vision-monitor/              # [Standalone App] Observer & Remote Config Panel
    ├── index.html               # UI dashboard StreamingVLM
    ├── package.json             # Dependencies terpisah
    ├── vite.config.js           # Port 5174
    ├── src/                     # UI scripts & styling
    └── server/                  # WebSocket bridge ke companion utama
```

---

## 🚀 Panduan Setup & Menjalankan

### 1. Prasyarat
- **Node.js**: Versi 18 atau lebih baru.
- **API Keys**:
  - `NINEINFERENCE_API_KEY`: Dapatkan di [9inference.cloud](https://9inference.cloud).
  - `GROQ_API_KEY`: Dapatkan di [console.groq.com](https://console.groq.com/keys).
  - `FISH_API_KEY`: Dapatkan di [fish.audio](https://fish.audio).

### 2. Setup Project Utama

1. Clone repositori dan install dependencies:
   ```bash
   npm install
   ```

2. Buat file `.env` dari template:
   ```bash
   cp .env.example .env
   ```
   Lalu buka `.env` dan masukkan API key Anda.

3. Jalankan server backend dan Vite frontend secara bersamaan:
   ```bash
   npm run dev:all
   ```
   Aplikasi utama akan berjalan di:
   - **Frontend Companion**: `http://localhost:5173`
   - **Backend Server**: `http://localhost:8787`

### 3. Menjalankan Vision Monitor (Opsional / Terpisah)

Jika ingin membuka panel observer & remote configuration untuk memantau layar:
```bash
cd vision-monitor
npm install
npm run start
```
Buka Vision Monitor di: **`http://localhost:5174`**

---

## 🙏 Credits & Attribution

1. **Model Live2D — IceGirl**:
   - Dibuat oleh **tianyelulu** dan tersedia secara gratis di [BOOTH (IceGirl Model)](https://tianyelulu.booth.pm/items/5975192).
   - Model ini digunakan sebagai aset visual avatar dalam proyek companion ini sesuai dengan lisensi penggunaan yang diberikan oleh kreator di halaman BOOTH tersebut. Seluruh hak cipta, desain karakter, dan hak kekayaan intelektual model Live2D tetap menjadi milik kreator aslinya (**tianyelulu**). Proyek ini tidak mengklaim kepemilikan atas model tersebut.

2. **Live2D Cubism SDK for Web**:
   - Teknologi rendering Live2D ditenagai oleh [Live2D Cubism SDK for Web](https://www.live2d.com/en/sdk/about/) resmi dari **Live2D Inc.**
   - Penggunaan Live2D Cubism Core dan Framework tunduk pada [Live2D Open Software License Agreement](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html) dan Live2D Proprietary License.
   - *Catatan bagi pengembang yang meng-clone proyek ini:* Pastikan untuk mengunduh pustaka Live2D Cubism Core resmi secara langsung dari situs [Live2D Cubism SDK for Web](https://www.live2d.com/en/sdk/download/web/) untuk kepatuhan lisensi.

3. **Layanan Pihak Ketiga & Infrastruktur**:
   - **[9inference](https://9inference.cloud)** untuk API model bahasa & inferensi multimodal.
   - **[Groq](https://groq.com)** untuk inferensi LPU Speech-to-Text berkecepatan tinggi.
   - **[Fish Audio](https://fish.audio)** untuk sintesis suara waifu yang ekspresif.

---

## 📌 Status & Roadmap

- [x] Official Live2D Cubism 5.0 integration dengan physics & expressions.
- [x] Synthetic procedural face tracking (Simplex noise).
- [x] Multi-layer talking animations (procedural sway + sentence break clips).
- [x] 12 Indonesian emotion classification system.
- [x] Ultra low-latency STT (Groq Whisper) dengan anti-hallucination filtering.
- [x] Streaming LLM chat with structured emotion extraction (DeepSeek V4 Flash).
- [x] Streaming TTS audio playback & synchronized lip-sync (Fish Audio).
- [x] Dual-source vision perception (Webcam vs Screen Share).
- [x] Continuous 1 FPS screen monitoring & periodic spontaneous commentary.
- [x] Standalone Vision Monitor observation panel with live remote configuration.
- [ ] *In Progress*: Personalisasi long-term memory & episodic conversation recall.
- [ ] *Planned*: Direct desktop capture integration via native tray companion.
