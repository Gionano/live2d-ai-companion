# Vision Monitor

Dashboard observer untuk backend companion (`my waipu`). Menampilkan frame, deskripsi vision, hasil filter, dan statistik secara real-time. Tidak memanggil API AI sendiri: semua vision (Qwen 3.8 27B via Groq) dan filter (DeepSeek V4 Flash via 9inference) dijalankan di backend utama.

## Arsitektur

```
[Companion browser :5173] --continuous_frame--> [Backend utama :8787 /ws]
                                                    |  (streamingVisionManager)
                                                    | monitor_frame, vision_entry, filter_*, stats_update, config_updated
                                                    v
                          [Bridge vision-monitor :3001 /ws-monitor]  (konek ke /ws?role=monitor)
                                                    |
                                                    v
                                      [UI Vision Monitor :5174]
```

- Bridge terhubung ke backend sebagai `role=monitor`: bukan sesi percakapan, tidak mengubah turn-taking maupun history, dan tidak menerima audio TTS.
- UI mengirim `update_vision_config` dan `reset_stats` ke bridge, lalu diteruskan ke backend utama.

## Menjalankan

1. Jalankan backend utama (`node server/index.js` di root project).
2. Di folder ini:
   ```bash
   npm install
   npm run start     # bridge :3001 + UI :5174
   ```
3. Buka `http://localhost:5174`.

## .env

```env
PORT=3001
MAIN_COMPANION_WS_URL=ws://localhost:8787/ws
```

Tidak butuh API key di sini.
