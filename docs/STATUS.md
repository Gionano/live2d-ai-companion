# Status

Evidence: git history through `24db330`, current code/config, mocked selfie/provider and speech tests; Phase D files remain uncommitted.

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

## In progress / unverified
- Selfie Phase C: busy requests queue only within configured `maxQueue`; zero disables queuing.
- Selfie Phase D: popup/preload/browser-modal code exists, but renderer event wiring, main initialization, and tray integration are absent.
- sd.cpp: provider scaffold explicitly untested end to end; CLI/model paths are empty in config.
- Cloud image provider: unavailable stub returning NOT_IMPLEMENTED.
- Optional L3 remains unimplemented: forced termination does not persist/recover an in-flight ComfyUI prompt ID. Cooperative cancel/shutdown is covered.
- Verified: `npm.cmd test` passes 115 tests, including fake ComfyUI HTTP preparation cancellation/timeout, shutdown release, unrelated-running-prompt protection, invalid-plan/setup refunds, scoped IPv6 rejection and image error-header parity. Speech tests cover partial-failure playback gating, the real input handler with late STT errors, two private-speech/input sockets, broadcast processing preservation, rejection UI recovery, cancellation signals and planner cancellation/refund. `serverIntegration.test.js` exercises real HTTP/WS with a fake provider, valid/unknown/expired tokens, traversal/sibling/junction containment, forwarded-client/Host guards, and real Vite dev/Electron production proxy URL resolution without CORS or caching. Test storage uses temporary directories; `npm.cmd run build`, changed backend/frontend syntax checks and `git diff --check` pass.
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
