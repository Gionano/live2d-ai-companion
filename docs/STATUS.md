# Status

Evidence: Phase D implementation committed through `ecef631`; P1-P5 audit corrections are included in the follow-up commits. Verification uses code inspection and mocked selfie/provider, HTTP/WS, desktop IPC, and speech tests.

## Done
- Live2D Cubism rendering, physics, blinking, breathing, synthetic tracking, and emotion controls.
- Live2D model discovery/upload/switching, persistent framing presets, and animation tuning.
- WebSocket voice/text chat, VAD, mobile push-to-talk, STT, streaming chat/TTS, and turn-taking.
- Webcam/screen vision routing, continuous capture, and a monitor bridge/dashboard with remote settings.
- Persistent JSON memory extraction, user facts, and episodic recall.
- Selfie Phase A: ImageProvider, ComfyUI workflow/reference mapping, random seeds, progress, cancellation, VRAM release, and ETA history.
- Selfie Phase B: intent detection, cloud planner, slot whitelist, prompt builder, moderation, and fallbacks.
- Selfie Phase C (implemented portion): async jobs/queue, limits, selfie_* events, token HTTP images, and deferred caption TTS.
- Selfie findings already committed (`24db330`): singleton ETA history/units and token expiry/eviction; preserved without reimplementation.
- Selfie F3: abort listener installed before the aborted check; accepted prompts are dequeued/interrupted, including lost submission responses.
- Selfie F4/F5: synchronous `tryAdmit()` reserves capacity and daily quota before provider/planner awaits; queue caps include zero, queued starts recheck limits/cooldown, and cancellation before start refunds quota. Started jobs consume daily quota even on failure/cancellation. Local-date daily counters and completion cooldown persist in `data/selfie-limits.json`; missing/corrupt state resets with a warning.
- Selfie F6: every companion WS connection receives started/latest-progress or ready snapshots; shutdown aborts pending/running jobs and joins one provider release. The job manager owns provider cleanup; ETA is null without history.
- Selfie F7-F9: `allowLan: false` by default; Vite/Electron proxies forward original client addresses and hosts. Images reject non-loopback clients/forwarded hops and hosts outside localhost/127.0.0.1, use `Cache-Control: no-store`, and expose no CORS headers (including Vite preflight). Existing 24-hour token TTL remains enforced. Realpath plus `path.relative` blocks traversal, sibling-prefix paths, and junction escapes. Events/snapshots publish `/api/selfies/:token`, served through both frontend proxies.
- Speech F1/F2: shared chat/selfie/vision speech controller, speech IDs, completion after audio playback, timeout recovery, and reliable caption queue drain.
- Speech M1-M3: partial TTS failures retain the speech playback lock until acknowledgment or timeout; timeout sends a tagged stop request so old audio cannot overlap the next speech. Each socket owns a turnId and abort signal; expiry/disconnection cancels STT, chat/planner LLM and TTS, and stale results/errors cannot update a newer turn. Private replies reserve only their recipients, broadcasts wait for recipients' processing to finish, and busy input receives input_rejected with authoritative UI state.
- Selfie M4-M6: the ComfyUI abort listener and job timeout cover health checks, workflow/mapping reads, reference checks/uploads and generation. Preparation cancellation reaches shutdown release promptly. Remote cancellation skips unsubmitted work, deletes only owned pending prompts and verifies the running prompt through `/queue` before `/interrupt`; unrelated manual jobs remain untouched. `submitJob` validates plan/caption/slots before reserving, and setup errors refund only their own unstarted reservation.
- Image L1/L2: scoped or unparsable IPv6 addresses return 403; image policy runs before JSON parsing. Malformed JSON and unavailable-backend proxy errors retain `Cache-Control: no-store` in direct, Vite and Electron paths.
- Desktop Phases 0-2: transparent overlay, click-through/edit mode, persisted bounds, and display presets.
- Desktop Phase 3: system tray controls, global shortcuts, and microphone mute IPC.
- Desktop Phases 4-5: direct screen capture, content protection, and on-demand/continuous vision integration.
- Desktop Phase 6: Windows x64 NSIS packaging configuration.
- Selfie Phase D P1/P3 corrections: popup placement tries full-size then compact candidates; unavoidable overlap uses the minimum intersection with a warning. Shrinking preserves the configured full-card request; every resize/display change publishes actual layout and retries it when space returns. Ready content always scrolls on overflow with preserved action rows. Authoritative reconnect snapshots replace stale jobs or clear empty state while retaining one popup; reset revisions isolate stale timers and asynchronous callbacks for the same job.
- Selfie Phase D P2/P4 corrections: gallery actions resolve outputDir from main-process local configuration, with no HTTP/renderer path response. HTTP settings expose only capability/auto-close and reject cross-origin or missing-origin metadata, retaining Host, loopback-only, no-store/no-CORS checks. Only an existing configured directory opens; traversal, files, missing paths, and symlink/junction escapes are rejected. Every selfie IPC validates window identity, main-frame identity, and configured frontend origin or exact popup page. Overlay redirects are guarded and remote Google Fonts CSP permissions removed.
- Selfie Phase D P5 corrections: browser Cancel waits for server cancellation/completion; ready wins the race and remains visible. Backend ready/snapshot events carry shared autoCloseSeconds, including zero. Browser fallback is a dialog with aria-modal, background inertness, focus trapping, Escape dismissal, and focus restoration. Existing protected popup, tray toggle, Save As, clipboard, and terminal lifecycle behavior is retained.

## In progress / unverified
- Selfie Phase C: busy requests queue only within configured `maxQueue`; zero disables queuing.
- Selfie Phase D manual validation remains pending: run `npm.cmd run dev:all`, then `npm.cmd --prefix desktop-companion run dev`; exercise Pap toggle/gallery, Cancel, Save/Copy/Folder, consecutive jobs, result zoom/close, display unplug/DPI changes, application quit, and browser fallback. Windows screen capture must be checked with the popup visible; fake-window tests assert content protection and capture IPC exclusion, not OS pixels. Live ComfyUI/assets and installer checks remain unverified.
- sd.cpp: provider scaffold explicitly untested end to end; CLI/model paths are empty in config.
- Cloud image provider: unavailable stub returning NOT_IMPLEMENTED.
- Optional L3 remains unimplemented: forced termination does not persist/recover an in-flight ComfyUI prompt ID. Cooperative cancel/shutdown is covered.
- Verified P1-P5 corrections: 157/157 baseline increased to 189/189; the resize/settings follow-up passes 198/198 (9 more, zero failures/skips; existing coverage retained). New regressions cover shrink/display/full-layout restoration, compact action access, same-origin settings without filesystem paths, and development/packaged private config resolution. Headless Chrome confirmed all actions reachable with long captions at 320x120, 200x520, and 360x520. Commit preparation reran `npm.cmd test` (198/198), `npm.cmd run build` (57 modules), and `git diff --check`, all passing. Earlier changed JS/CJS and popup-script parsing checks also passed. `config/selfieModeration.json` and `server/personality.js` are untouched.
- UNKNOWN: live AI/ComfyUI generation, browser/Electron flows, capture behavior, and installer validation.

## Decisions
- Chat/planner/memory: Experiential Labs; EXPLABS_MODEL overrides default `deepseek-v4.1-flash-uncensored`; TTS: Fish Audio `s2.1-pro-free`; avatar: IceGirl.
- STT/vision: Groq `whisper-large-v3` / `qwen/qwen3.8-27b`; vision filter: 9inference `deepseek-v4.1-flash`.
- Selfies: local ComfyUI at `http://127.0.0.1:8188`; default preset `cepat` (768 px, 12 steps); workflow model `qwen-image-2.1-UC-Q5_K_M.gguf`.
- AI keys/provider access stay backend-only; image generation uses ImageProvider; selfie tuning lives in `selfie.config.json`.
- Speech: speech_start -> tagged audio -> speech_end (ok:false on failure); amika_replied logs only; playback acknowledgment gates subsequent speech even after partial failure. State and cancellable turn ownership are per socket; expired turnId events are ignored. stop_speech cancels playback on timeout; input_rejected restores the client's authoritative state.
- Backend binds to `127.0.0.1`; selfie images use tokenized `/api/selfies/:token` URLs. Forwarded headers are trusted only from a loopback peer. Mobile/LAN chat and vision access still use Vite `/api` and `/ws`; the local monitor bridge connects over loopback. No current feature requires a direct LAN backend listener. Opting into selfie LAN access retains the localhost/127.0.0.1 Host allowlist.
- Electron uses context isolation, sandboxing, disabled Node integration, narrow preload IPC, and overlay capture protection.
- Continuous capture requires active screen sharing and a connected monitor; selfie generation runs independently of conversation turns.

## Next
