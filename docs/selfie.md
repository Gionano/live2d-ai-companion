# Modul Selfie (pap)

Avatar membuat foto dirinya sesuai permintaan user. LLM cloud (sama dengan chat) menyusun slot adegan,
generator gambar **lokal** (ComfyUI) membuat gambarnya. API key dan akses generator hanya dari backend.

## 1. Mengekspor workflow
1. Buka workflow selfie Anda di ComfyUI.
2. **Workflow > Export (API)** (bukan "Save"/"Export" biasa).
3. Simpan sebagai `workflows/selfie.api.json` di repo.

## 2. Mengisi `selfie.mapping.json`
Setiap peran dipetakan ke node lewat `_meta.title` **persis seperti di JSON** (judul terpotong tetap
dicocokkan awalan), dengan `classType` sebagai cadangan, plus nama field input:

| Peran | Node | Field |
|---|---|---|
| `prompt` | PROMPT + Referensi (Qwen Image 2.1) | `prompt`, `negative_prompt`, `resolution` |
| `reference` | LoadImage "GAMBAR REFERENSI" | `image` |
| `sampler` | KSampler | `seed`, `steps` |
| `save` | SaveImage "Simpan Gambar" | `filename_prefix` |

Saat start, daftar node dan field yang terdeteksi dicetak. Jika judul/field tidak ditemukan atau ambigu,
errornya menyebut persis bagian mana di `selfie.mapping.json` yang harus diisi.

## 3. Gambar referensi
Taruh gambar (png/jpg/webp) di `assets/references/`. Nama file di folder itu adalah whitelist.
Backend meng-upload otomatis ke ComfyUI bila belum ada. Isi `defaultReference` di `selfie.config.json`.
Folder ini tidak ikut git.

## 4. Konfigurasi
Semua konstanta di `selfie.config.json` (provider, `comfyUrl`, `outputDir`, timeout, cooldown, batas harian, preset).
`comfyUrl`: ComfyUI Desktop biasanya `http://127.0.0.1:8000`, standalone `http://127.0.0.1:8188`.

## 5. Uji
```
npm run selfie:test --provider=comfyui --preset=cepat
```
Mencetak durasi antre / generate / unduh dan lokasi file. Rata-rata 5 durasi terakhir per preset disimpan untuk ETA.

> Fitur nonaktif otomatis (dengan pesan jelas) bila provider tidak terjangkau.

# Selfie module — remaining phases
Rules: cloud LLM for chat/planner; local image provider only (ImageProvider interface); keys backend-only; don't change existing WS contract except selfie_* messages; tuning constants in selfie.config.json; stop after each phase and update docs/STATUS.md.

## PHASE C — job manager, events, avatar speech
1. Job manager: one active job, queue max = config.maxQueue, cooldown, daily limit. Persist cooldown/daily counters to a file (local date). If a request arrives during a job or cooldown, avatar replies in character (Indonesian, e.g. "masih fotoin yang tadi ya"); no new job.
2. Jobs run async. Never block the conversation or the turn-taking state machine. Chat keeps using the cloud LLM.
3. WS events: selfie_started {jobId, etaSeconds|null}, selfie_progress {jobId,value,max}, selfie_ready {jobId,imageUrl,caption}, selfie_failed {jobId,reason}, selfie_cancelled {jobId}. On client connect/reload, send a snapshot of the active job. etaSeconds = null if no duration history.
4. Avatar speech via the existing TTS path: one short line at job start, caption (with emotion) when ready. Queue speech until turn state is IDLE; keep the existing safety timeout so state never sticks.
5. Never send image base64 over WS. Serve images via local HTTP GET /selfies/:id: bind 127.0.0.1 only, random 128-bit crypto id, serve only files inside outputDir, no directory listing, unknown id -> 404.
6. On failure/timeout: avatar says so in character, clean up the job, call provider.release(). On backend shutdown: interrupt the running job and release.
7. Feature auto-disables with a clear message if the provider is unavailable.
Test: "pap dong" -> short line, async job, events in log; chat works during job; 2nd request refused politely; caption spoken only when avatar is idle; kill ComfyUI mid-job -> selfie_failed and state recovers; imageUrl works locally only, random id -> 404; no base64 in WS frames; page reload mid-job restores progress.

## PHASE D — popup UI (Electron)
1. Separate popup BrowserWindow: frameless, always-on-top, NOT click-through, setContentProtection(true), placed near the avatar without covering it, clamped to the active display work area.
2. States: (a) compact toast with progress bar, ETA, Cancel; (b) result: image with fade-in, click to enlarge (<=80% of screen), buttons Save As, Copy (nativeImage -> clipboard), Open folder, Close. Optional auto-close (config).
3. Tray: "Pap feature" on/off toggle; "Pap gallery" (open outputDir or simple gallery of last 20).
4. Security: local page, narrow preload (contextIsolation, no nodeIntegration), load images only from the localhost endpoint origin, no remote content.
5. Non-Electron browser: in-page modal fallback.