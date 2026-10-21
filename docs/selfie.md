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
