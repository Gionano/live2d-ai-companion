# Vision Monitor

Dashboard observer untuk backend companion (`amika-live2d-companion`). Menampilkan frame, deskripsi vision, hasil filter, dan statistik secara real-time. Tidak memanggil API AI sendiri: semua vision (Qwen 3.8 27B via Groq) dan filter (DeepSeek V4 Flash via 9inference) dijalankan di backend utama.

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
MAIN_COMPANION_WS_URL=ws://127.0.0.1:8787/ws
```

Tidak butuh API key di sini.

## Connection troubleshooting

Run the main backend on port 8787 and use `npm run start` here to launch both
the monitor bridge and frontend. `npm run dev` starts only the frontend, so its
WebSocket needs the bridge running separately. The frontend proxies `/ws-monitor`
through its own origin to the bridge's `PORT` (default 3001), including in preview.
The bridge uses IPv4 loopback for the main backend; legacy `localhost` URLs are
normalized because the main backend binds `127.0.0.1`.

Opening this dashboard starts continuous monitoring of available sources.
Closing the last dashboard tab or stopping the bridge stops both screen and
webcam capture, clears current visual context and cancels pending AI analysis.
A running bridge with no connected dashboard does not capture. Reopening the
dashboard resumes monitoring automatically with new capture sessions.

Screen sharing or the Electron Screen Vision tray toggle determines whether
the screen is available. Webcam monitoring and **Obrolan saat hening** are enabled
in the root `config/animationConfig.json`; they require no UI toggle or save step.
Quiet conversation waits 60 seconds after user activity or actual speech playback
completion and does not require this dashboard to stay open.

The **Obrolan saat hening** card shows the quiet countdown and the reason speech
has not started, including SKIP, another reply/commentary, unavailable providers
and decision timeouts. Sixty seconds starts topic selection; generating and
playing speech takes additional time. A SKIP waits for another user interaction.
**Durasi analisis** is a completed vision request's total duration, while
**Tunggu respons** measures the wait for its first response. The two-second
minimum request interval remains independent of these measurements.

Bridge diagnostics and vision/filter log timestamps use Jakarta time with
milliseconds (`HH:mm:ss.SSS WIB`). The companion's conversation messages and
captions have no timestamp prefix. Restart the root backend and monitor bridge
after code changes, then refresh both pages.
