# Amika — Live2D AI Companion (Unrestricted / Uncensored Edition)

> **[UNRESTRICTED / UNCENSORED EDITION]**
> Edisi ini menggunakan profil kepribadian **Unrestricted** dan ditenagai oleh model LLM **Uncensored (`Qwen3.8 Flash Next Uncensored`)** yang disediakan oleh **xplabs.ai (Experiential Labs)**, sehingga percakapan bersama Amika berjalan bebas tanpa batasan sensor standar.

Aplikasi AI companion interaktif berbasis browser yang menghadirkan karakter **Amika** dalam bentuk avatar **Live2D Cubism** resmi. Dilengkapi percakapan suara hands-free berlatensi rendah (*Voice-to-Voice*) maupun input teks desktop, animasi natural multi-layer (*synthetic face tracking*, *audio-reactive body sway*, *sentence-break clips*), 12 ekspresi emosi kontekstual, persepsi visual cerdas kamera/webcam & layar, serta pemantauan layar (*continuous screen vision*) dengan filter spontan berkala.

---

## 🌟 Fitur Utama

1. **Unrestricted Persona & Uncensored Brain LLM (via xplabs.ai)**:
   - Otak percakapan utama menggunakan model **`Qwen3.8 Flash Next Uncensored` (`qwen3.8-flash-next-uncensored`)** dari penyedia API **xplabs.ai (Experiential Labs)**.
   - Kepribadian Amika dikonfigurasi secara *unrestricted* & intim sebagai istri virtual yang ekspresif, manja, playful, dan responsif tanpa filter penolakan kaku.
   - Streaming JSON terurut (`{"emotion":"...","text":"..."}`) dengan `reasoning_effort: "none"` untuk mengirim emosi ke avatar sebelum kalimat pertama selesai di-generate.

2. **Avatar Live2D Cubism 5.0 (Model IceGirl)**:
   - Rendering WebGL resmi dengan physics controller dinamis (gerakan rambut, aksesoris, dan gaun).
   - Animasi pernapasan (*breathing*) dan kedipan mata (*auto-blink*) kontinu.
   - **Synthetic Face Tracking**: Simulasi gerakan kepala (*yaw/pitch/roll*), *eye gaze saccade & fixation*, dan mikro-gerakan alis menggunakan *Simplex Noise* prosedural ala VTube Studio.
   - **Multi-Layer Talking Animation**:
     - *Layer 1 (Audio-Reactive)*: Asymmetric EMA smoothing menggerakkan badan dan kepala mengikuti irama suara TTS secara organik.
     - *Layer 2 (Sentence-Break Clips)*: Memicu gerakan transisi halus di jeda kalimat berdasarkan intensitas emosi.

3. **Sistem Emosi Terstruktur (12 Emosi)**:
   - LLM secara terstruktur menentukan ekspresi emosi bahasa Indonesia: `terkejut`, `marah`, `bingung`, `jengkel`, `malu`, `kesal`, `sedih`, `kagum`, `sayang`, `jahil`, `penasaran`, dan `netral`.
   - Mengubah file ekspresi `.exp3.json` Live2D secara otomatis saat berbicara.

4. **Percakapan Real-Time Hands-Free (STT → LLM → TTS) & Input Ketik Desktop**:
   - **STT (Groq Whisper Large v3 Turbo)**: Deteksi suara otomatis via Web Audio VAD di browser (serta *Press-and-Hold* di mobile), dilengkapi prompt kontekstual dan penyaringan noise non-suara.
   - **Desktop Text Chat Input**: Kolom input teks khusus tampilan desktop di bawah log percakapan yang terhubung langsung ke pipeline LLM + Vision + TTS yang sama.
   - **LLM Streaming (`qwen3.8-flash-next-uncensored` via xplabs.ai)**: Menghasilkan respons uncensored secara streaming per kalimat.
   - **TTS Streaming (Fish Audio)**: Streaming chunk MP3 per kalimat langsung ke Web Audio API untuk meminimalkan delay ke audio pertama (*Time-to-First-Audio*).

5. **Persepsi Visual Cerdas (Smart Webcam vs Screen Routing)**:
   - Mendeteksi intent permintaan lihat visual dan otomatis memilih tepat satu sumber:
     - **Webcam**: Saat user meminta melihat kamera/wajah atau menunjukkan benda fisik (*"lihat di kamera"*, *"ini benda apa?"*).
     - **Screen/Layar**: Saat user membahas layar/game/monitor (*"coba lihat layar/game aku"*).
   - **Smart Routing dengan Vision Monitor**:
     - Jika **Vision Monitor menyala**, permintaan melihat layar langsung menggunakan buffer deskripsi terbaru (instan tanpa API call ganda).
     - Jika **Vision Monitor mati**, vision dieksekusi secara *one-shot* langsung di tempat menggunakan **Qwen 3.8 27B** (Groq).

6. **Conditional Streaming Vision & Spontaneous Commentary**:
   - Pemantauan layar kontinu (1 FPS) hanya aktif ketika *Share Screen* dan **Vision Monitor** sama-sama menyala (otomatis berhenti saat Vision Monitor ditutup untuk menghemat resource).
   - Buffer in-memory dievaluasi secara periodik oleh **DeepSeek V4 Flash**: jika ada momen menarik, Amika langsung berceletuk secara spontan (*spontaneous commentary*) lengkap dengan suara TTS dan animasi avatar.

7. **Mobile Responsive & Camera Toggle**:
   - Layout Picture-in-Picture (PiP) adaptif untuk tampilan mobile dengan video kamera full-screen sebagai background, interaksi *press-and-hold* di area UI, dan tombol toggle kamera depan/belakang (*user* vs *environment*).

8. **Vision Monitor (Standalone Observer Panel)**:
   - Aplikasi dashboard terpisah bergaya StreamingVLM untuk memantau feed layar, membaca log deskripsi visual secara live, melihat kartu evaluasi filter, memantau running cost, serta mengatur interval capture secara remote.

9. **Personalisasi Long-Term Memory & Episodic Conversation Recall**:
   - Sistem memori jangka panjang persisten (`data/memory.json`) yang mencatat fakta, kebiasaan, panggilan, dan topik obrolan sebelumnya secara otomatis di latar belakang tanpa menghambat latensi respons.

10. **Native Desktop Companion (Electron Floating Overlay)**:
    - Aplikasi desktop Windows pendamping dengan avatar Live2D transparan melayang tanpa border/kotak hitam.
    - Dilengkapi *System Tray*, dua preset tampilan (*Dengan Sayap* vs *Tanpa Sayap*), *Click-Through & Mode Edit* (`Ctrl+Alt+E`), *Mute Mic* (`Ctrl+Alt+M`), dan *Direct Screen Capture* tanpa popup izin browser dengan proteksi DWM `WDA_EXCLUDEFROMCAPTURE` (avatar tidak ikut terfoto).

---

## 🏛️ Arsitektur Sistem

<p align="center">
  <img src="docs/architecture-pipeline.svg" alt="Amika AI Companion Multimodal Pipeline" width="100%">
</p>

```
┌────────────────────────────────────────────────────────────┐
│         Browser / Desktop Companion (Electron)             │
│  - Live2D Canvas (IceGirl) & Web Audio Analyser            │
│  - Hands-Free VAD / Mobile PTT + Desktop Text Chat Input   │
│  - Camera & Direct Desktop Capture (WDA_EXCLUDEFROMCAPTURE)│
└─────────────────────────────▲──────────────────────────────┘
                              │ WebSocket (/ws)
┌─────────────────────────────▼──────────────────────────────┐
│                Node.js Server Orchestrator                 │
│  - Brain LLM: Qwen3.8 / DeepSeek Uncensored (xplabs.ai)    │
│  - STT Proxy: Whisper Large v3 (Groq)                      │
│  - Vision Perception: Qwen 3.8 27B (Groq)                  │
│  - Spontaneous Filter: DeepSeek V4 Flash (9inference)      │
│  - TTS Streamer: Fish Audio S2.1 Pro                       │
│  - Long-Term Memory & Episodic Recall (data/memory.json)   │
│  - [WIP] ComfyUI Workflow Integration (PAP / Photo Gen)    │
└─────────────────────────────▲──────────────────────────────┘
                              │ WebSocket (/ws?role=monitor)
┌─────────────────────────────▼──────────────────────────────┐
│            Vision Monitor App (Port 3001/5174)             │
│  - Live Stream Push Preview & Sync Countdown               │
│  - Realtime Vision Log Feed & Cost Tracker                 │
│  - Remote Config Slider (Interval Capture, Buffer, Tokens) │
└────────────────────────────────────────────────────────────┘
```

---

## 🛠️ Tech Stack & Powered By

- **Frontend Avatar**: Vanilla JavaScript, Vite, HTML5 Canvas, WebGL, Web Audio API, Official Live2D Cubism Core & Framework 5.0.
- **Backend Server**: Node.js, Express, `ws` (WebSocket Server).
- **AI Services & API Providers**:
  - **[xplabs.ai (Experiential Labs)](https://experientiallabs.ai)**: Penyedia API utama untuk **Brain LLM Uncensored** (`qwen3.8-flash-next-uncensored`).
  - **[Groq](https://groq.com)**: Speech-to-Text inference ultra-cepat (`whisper-large-v3-turbo`) dan Multimodal Vision (`qwen/qwen3.8-27b`).
  - **[Fish Audio](https://fish.audio)**: Neural Speech Synthesis & real-time streaming TTS.
  - **[9inference](https://9inference.cloud)**: Evaluasi filter berkala untuk komentar spontan (`deepseek-v4-flash-0731`).

---

## 📦 Struktur Folder

```
my waipu/
├── index.html                   # Halaman utama companion (Live2D avatar + chat panel + desktop text input)
├── package.json                 # Dependencies companion utama
├── vite.config.js               # Konfigurasi Vite (Port 5173)
├── .env.example                 # Template environment variables
├── server/                      # Backend Orchestrator
│   ├── index.js                 # Entry point Express & WebSocket server (/ws)
│   ├── experientialClient.js    # OpenAI-compatible client ke xplabs.ai (Experiential Labs)
│   ├── llmChat.js               # Streaming chat Uncensored & structured JSON parser
│   ├── personality.js           # System prompt Amika (Unrestricted Edition, 12 emosi)
│   ├── modelConfig.js           # Konfigurasi model ID (Qwen3.8 Flash Next Uncensored & Filter)
│   ├── streamingVisionManager.js# Pipeline vision kontinu & filter spontan
│   ├── visionCapture.js         # Smart routing intent vision (screen vs webcam)
│   ├── sttTranscribe.js         # STT Groq Whisper + noise filter
│   ├── ttsGenerate.js           # TTS Fish Audio streaming
│   ├── groqClient.js            # Groq SDK instance (STT & Vision)
│   ├── nineInferenceClient.js   # OpenAI client ke 9inference.cloud (Vision Filter)
│   └── voiceConfig.js           # Konfigurasi referensi suara TTS
├── src/                         # Frontend Avatar & Logika Browser
│   ├── main.js                  # Setup Live2D, resize canvas, lip-sync loop
│   ├── live2dCompanion.js       # Live2D model controller, layers, & motion manager
│   ├── syntheticTracking.js     # Simplex noise procedural face & eye tracking
│   ├── expressionMap.js         # Mapping 12 emosi ke file .exp3.json & intensitas
│   └── companion.js             # VAD/PTT audio, desktop text chat, screen share, & WS client
├── public/                      # Static Assets
│   └── models/live2d/           # Asset model Live2D IceGirl (.moc3, textures, .exp3, .motion3)
├── desktop-companion/           # [Native App] Windows Companion (Electron + Tray + Direct Capture)
│   ├── package.json             # Electron & electron-builder packaging config
│   ├── src/main/                # Main process (Tray, Window, Capture Service, Security)
│   └── src/preload/             # Context isolation preload bridge
├── docs/                        # Dokumentasi & Diagram Arsitektur SVG
│   └── architecture-pipeline.svg# Diagram alur visual multimodal & ecosystem
└── vision-monitor/              # [Standalone App] Observer & Remote Config Panel
    ├── index.html               # UI dashboard StreamingVLM
    ├── package.json             # Dependencies terpisah
    ├── vite.config.js           # Port 5174
    ├── src/                     # UI scripts & sinkronisasi state
    └── server/                  # WebSocket bridge (?role=monitor) ke companion utama
```

---

## 🚀 Panduan Setup & Menjalankan

### 1. Prasyarat
- **Node.js**: Versi 18 atau lebih baru.
- **API Keys**:
  - `EXPLABS_API_KEY`: API key dari **[xplabs.ai (Experiential Labs)](https://experientiallabs.ai)** untuk model `qwen3.8-flash-next-uncensored`.
  - `GROQ_API_KEY`: Dapatkan di [console.groq.com](https://console.groq.com/keys) untuk STT & Vision.
  - `FISH_API_KEY`: Dapatkan di [fish.audio](https://fish.audio) untuk TTS.
  - `NINEINFERENCE_API_KEY`: Dapatkan di [9inference.cloud](https://9inference.cloud) untuk filter komentar spontan.

### 2. Setup Project Utama

1. Clone repositori dan install dependencies:
   ```bash
   npm install
   ```

2. Buat file `.env` dari template:
   ```bash
   cp .env.example .env
   ```
   Pastikan konfigurasi `.env` Anda berisi:
   ```env
   EXPLABS_API_KEY=xpl_your_api_key_here

   GROQ_API_KEY=your_groq_key_here
   FISH_API_KEY=your_fish_key_here
   NINEINFERENCE_API_KEY=your_9inference_key_here
   ```

3. Jalankan server backend dan Vite frontend secara bersamaan:
   ```bash
   npm run dev:all
   ```
   Aplikasi utama akan berjalan di:
   - **Frontend Companion**: `http://localhost:5173`
   - **Backend Server**: `http://localhost:8787`

### 3. Menjalankan Vision Monitor (Opsional / Terpisah)

Jika ingin membuka panel observer & mengaktifkan fitur *Continuous Interval Capture* (1 FPS):
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
   - **[xplabs.ai (Experiential Labs)](https://experientiallabs.ai)** untuk penyediaan API model bahasa uncensored (`Qwen3.8 Flash Next Uncensored`).
   - **[Groq](https://groq.com)** untuk inferensi LPU Speech-to-Text & Vision berkecepatan tinggi.
   - **[Fish Audio](https://fish.audio)** untuk sintesis suara waifu yang ekspresif.
   - **[9inference](https://9inference.cloud)** untuk evaluasi filter momen spontan.

---

## 📌 Status & Roadmap

- [x] Official Live2D Cubism 5.0 integration dengan physics & expressions.
- [x] Synthetic procedural face tracking (Simplex noise).
- [x] Multi-layer talking animations (procedural sway + sentence break clips).
- [x] 12 Indonesian emotion classification system.
- [x] Ultra low-latency STT (Groq Whisper) dengan anti-hallucination filtering.
- [x] **Unrestricted / Uncensored LLM Chat** via **xplabs.ai** (`Qwen3.8 Flash Next Uncensored` / `DeepSeek V4.1 Flash Uncensored`).
- [x] Desktop text chat input box terintegrasi dengan pipeline suara & vision.
- [x] Streaming TTS audio playback & synchronized lip-sync (Fish Audio).
- [x] Smart vision routing (Webcam vs Screen Share + Vision Monitor buffer integration).
- [x] Conditional 1 FPS screen monitoring & periodic spontaneous commentary.
- [x] Standalone Vision Monitor observation panel with live remote configuration.
- [x] **Personalisasi long-term memory & episodic conversation recall** (`data/memory.json`, background auto-extract worker, time-aware greetings).
- [x] **Direct desktop capture integration via native tray companion** (Electron transparent floating overlay, click-through & mode edit, system tray controls, global shortcuts, DWM content protection `WDA_EXCLUDEFROMCAPTURE`, tanpa browser share screen prompt).
- [ ] *In Progress*: **Fitur PAP (Post A Picture / Request Foto)** — User dapat meminta AI waifu untuk membuat dan mengirim foto/gambar karakter dirinya secara on-demand via ComfyUI (Local/API workflow).
