# Status

Windows Python migration requested (2026-11-13): all Amika-authored application
code is to move to Python, including the GUI, backend, audio/vision/memory/PAP,
and Live2D animation controllers. Third-party SDKs and packages retain their
implementations. The target is one Windows installer with an install, native
setup, and start flow, requiring no separately installed Python or Node.js.
The [migration plan](windowsPythonMigration.md) proposes PySide6, native Cubism
bindings, a bundled Python runtime, and Inno Setup. This is planned work only;
native rendering compatibility and installer behavior remain unverified.

Current companion behavior is documented in the [continuous vision and conversation guide](continuous-vision-conversation.md), [conversation stages](conversation-behavior.md), [vision routing](vision-routing.md), [memory](memory.md), and [Live2D speech movement guide](live2d-speech-motion.md). Historical sections below retain the implementation and verification evidence recorded during their original work. Automated verification uses mocked providers, HTTP/WS, desktop IPC, speech, local-process fixtures, and memory/telemetry tests.

Docker/documentation refresh (2026-11-08): the container now builds the companion
and Vision Monitor, proxies both backends on loopback, persists settings/memory,
models, references and tuning in named volumes, and includes Python for explicit
BGE setup. The bundled PAP reference and README header now show the current
Witch model, captured from the real renderer with an isolated local preview.
Compose configuration, both frontend builds, 1,492 tests with two optional skips,
and the privacy scan passed. Docker build/runtime and nginx validation remain
unverified because the Docker engine is stopped and WSL access is unavailable.
No live AI/model downloads were run. See [Docker setup](docker.md).

Latest change-set verification (2026-11-08): the evidence-backed memory change
passed 1,492 tests with two optional local-asset skips, the root production build,
and the privacy scan (543 files; zero failing files). A production-build fixture
with real protected APIs and isolated memory storage verified hybrid retrieval,
settings persistence, manual insertion and deletion using mocked providers.
Original model and standalone lab hashes and Git HEAD remained unchanged. No
model was downloaded or loaded, and no live AI inference ran. Local browser UI
inspection was disabled in Work settings; native Electron verification failed
when its GPU child crashed with `-1073741515`. Native BGE timings and VRAM use
remain unmeasured. See the [memory guide](memory.md) for explicit setup.

## Done
- Evidence-backed memory archives completed, acknowledged speech, validates
  original speaker quotations, handles corrections, and shares one bounded
  keyword/BGE-M3 retrieval across surface/deep generation. Durable jobs, legacy
  migration, deletion fencing, optional cached-only local service startup, and
  the protected **Memori** panel are available. Installation requires explicit
  CLI setup and license acceptance; existing conversation providers remain in
  use. See the [memory guide](memory.md).
- Continuous vision uses independent screen/webcam sessions, scene filtering,
  capture-based freshness and source-labelled conversation context. Capture runs
  only while a Vision Monitor dashboard is connected; closing the last dashboard
  cancels analysis and clears visual context. Webcam monitoring is automatic.
- Chat streams tone segments with early first-sentence TTS and audio-clock pauses.
  Quiet conversation is enabled with a 30-second delay, SKIP/topic selection,
  a 30-second decision deadline, two-unanswered limit and voice/typing/PTT takeover.
  The monitor shows waiting, skipped, blocked and failed decisions. See the
  [operator guide](continuous-vision-conversation.md).
- Live2D head/body speech gestures follow audio emphasis and pauses, maintain
  coordinated poses across segments and fade on interruption. The active local
  魔女 rig and existing speech gains are preserved. See [speech movement](live2d-speech-motion.md).
- Diagnostic chat/vision/speech and monitor logs use Jakarta timestamps with
  milliseconds. User-facing conversation messages and captions keep plain text.
- Original project code has an MIT license; SDK, model and dependency terms are
  retained separately in the root third-party notices.
- Native Fish speech emotions: the existing chat, vision-comment and selfie-caption
  LLM requests choose from 49 speech emotions, separate from the avatar's twelve
  labels. Ordinary and proactive chat can choose a tone per segment; vision and
  selfie captions retain their single-object format. Header freezing, queue snapshots and mapped fallbacks
  preserve streaming and cancellation. Translated selection controls default to native.
- Fish emotion catalogue: all 24 Basic and 25 Advanced tags are available in
  translated grouped selectors and direct TTS/CLI emotion names.
- TTS expressiveness: twelve Indonesian emotion mappings, bracket prefixes,
  sentence merging, normalizer, optional safe inline cues, spoken-style prompt,
  debug redaction, local GUI controls and manual `tts:try` A/B audio files.
- Providers P3: local id/en settings GUI, first-run wizard, inherited-slot probes,
  models helper, stale-lock recovery and isolated dummy-key diagnostics. Audit below.
- Providers P2: versioned local settings, origin-bound credentials, Windows DPAPI
  and explicit plaintext backends, protected local settings API, import/migration,
  and registry reload with private in-flight credential snapshots.
- Providers P1.5: neutral unassigned public templates, preserved ignored local selection,
  isolated test runner, redirect refusal, TLS/address validation and dependency/STT audit.
- Providers P1: file-based slot contracts, OpenAI-compatible/Anthropic/Fish adapters,
  safe errors, streaming deadlines/retries, lazy registry, capability gating,
  migrated AI call sites and manual provider-test CLI. See the P1 record below.
- Live2D Cubism rendering, physics, blinking, breathing, synthetic tracking, and emotion controls.
- Witch-only Live2D assets, a persistent Witch framing preset, and configuration-based animation tuning.
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
- Desktop mute shortcut recovery: configurable preferred/fallback bindings, verified registration logs, active tray labels, visible failure notices, revisioned microphone IPC, capture/upload/STT shutdown, and first-instance focus on a second launch. Checklist and verification below.
- Desktop Phases 4-5: direct screen capture, content protection, and on-demand/continuous vision integration.
- Desktop Phase 6: Windows x64 NSIS packaging configuration.
- Selfie Phase D P1/P3 corrections: popup placement tries full-size then compact candidates; unavoidable overlap uses the minimum intersection with a warning. Shrinking preserves the configured full-card request; every resize/display change publishes actual layout and retries it when space returns. Ready content always scrolls on overflow with preserved action rows. Authoritative reconnect snapshots replace stale jobs or clear empty state while retaining one popup; reset revisions isolate stale timers and asynchronous callbacks for the same job.
- Selfie Phase D P2/P4 corrections: gallery actions resolve outputDir from main-process local configuration, with no HTTP/renderer path response. HTTP settings expose only capability/auto-close and reject cross-origin or missing-origin metadata, retaining Host, loopback-only, no-store/no-CORS checks. Only an existing configured directory opens; traversal, files, missing paths, and symlink/junction escapes are rejected. Every selfie IPC validates window identity, main-frame identity, and configured frontend origin or exact popup page. Overlay redirects are guarded and remote Google Fonts CSP permissions removed.
- Selfie Phase D P5 corrections: browser Cancel waits for server cancellation/completion; ready wins the race and remains visible. Backend ready/snapshot events carry shared autoCloseSeconds, including zero. Browser fallback is a dialog with aria-modal, background inertness, focus trapping, Escape dismissal, and focus restoration. Existing protected popup, tray toggle, Save As, clipboard, and terminal lifecycle behavior is retained.
- Selfie Phase E1: automatic ComfyUI/sd.cpp selection, cached readiness with missing node/file diagnostics, shared presets, real per-job sd-cli execution, and failover only before a confirmed generation start. Provider status reaches clients without filesystem paths; generation start owns quota and identifies the provider.
- Selfie Phase E1.5: GPU/DLL readiness, runtime CPU-fallback termination, config/preset args, `hemat`, heuristic memory refusal/override, nonblocking telemetry, private file logging, and bounded peak history for all started job outcomes.
- Selfie memory/argument correction: offload-aware resource estimates, available physical RAM, configurable hard-refusal ratio, GGUF vision projection checks, and effective config diagnostics.
- Selfie CLI quality experiments: ephemeral numeric/image/argument overrides, cached-help image-to-image flags, append-only run tables, shared GPU peaks, and metadata-only output comparison.

## Precommit security verification (2026-11-06)

Reviewed all 37 pending changed/added files with Codex Security before committing.
The review confirmed one low-severity availability issue: nested parentheses or
Markdown labels recursively sanitized speech text, allowing a spontaneous-comment
WebSocket message to exhaust the stack outside the listener's error handler.
The supported Vite LAN proxy can reach this path; actual firewall/browser
reachability was not probed.

The shared sanitizer now uses iterative source-range frames with precomputed
delimiter and whitespace positions. It retains words, streaming buffering,
Markdown-label behavior, Unicode custom tags and inline caps. The original
8 KB crash payload and extracted actual listener now succeed; nesting through
65,536 levels also succeeds. A fresh read-only review found no remaining concrete
bypass or regression after correcting shared trailing-whitespace scanning and
Unicode lowercase-expansion compatibility.

Final validation: **964/964 tests pass**, zero failures/cancellations/skips;
**nine security regressions** added after the 955-test native-emotion implementation
(**53 total additions from the 911-test baseline**). Build passes with **73 modules**;
privacy checks **399 files** with **zero failing files**; whitespace checks pass.
One earlier full run had a timing-dependent failure in the existing managed
ComfyUI idle-cleanup test; its focused suite passed 21/21 and the final full rerun
passed. That test and runtime were not changed. Differential checks covered
30,000 parent controls plus 125,000 reviewer inputs with varied streaming chunks.

No new dependencies, credential changes or live provider calls were used.
The persona and moderation SHA-256 hashes listed below remain unchanged.
Live audio quality and browser/Electron/provider integration remain unverified
by this security follow-up. The following 37 files are included in the authorized
commit:

```text
docs/STATUS.md
docs/prompts/providers-p2.md
docs/prompts/providers-p3.md
docs/providers.md
package.json
server/fishEmotionTags.js
server/index.js
server/llmChat.js
server/providers/adapters/fishAudio.js
server/providers/contracts.js
server/selfie/jobManager.js
server/selfie/planner.js
server/settings/schema.js
server/speechController.js
server/speechEmotionPrompt.js
server/speechStylePrompt.js
server/streamingVisionManager.js
server/tests/fishEmotionGui.test.js
server/tests/fishEmotionTags.test.js
server/tests/nativeSpeechChat.test.js
server/tests/nativeSpeechPlayback.test.js
server/tests/nativeVisualEmotion.test.js
server/tests/providersContract.test.js
server/tests/providersRegistry.test.js
server/tests/settingsGui.test.js
server/tests/speechStyle.test.js
server/tests/ttsExpression.test.js
server/tests/ttsSettings.test.js
server/tests/ttsTry.test.js
server/ttsExpression.js
server/ttsGenerate.js
server/ttsTry.js
src/i18n/en.json
src/i18n/id.json
src/settings/page.js
src/settings/settings.css
src/settings/viewModel.js
```

## Native Fish speech emotions (2026-11-06)

Implemented optional canonical `speechEmotion` in chat headers, vision comments
and selfie plans. A separate appended catalogue/schema prompt requests one of
the 49 names in the existing LLM call when TTS is available and native selection
is enabled, independently of the speech-style switch. Chat uses ordered JSON
`{emotion, speechEmotion, text}`; the avatar still uses its twelve existing labels.

The parser reads only top-level header metadata and freezes the selection when
text starts. Split headers work; missing, invalid, nested, quoted or late fields
cannot delay streaming or override the frozen choice. Sentences snapshot their
choice through the playback queue and cancellation/concurrent turns. Native
metadata stays out of frontend events, captions and history. Vision and selfie
captions strip tags for display while retaining allowed speech cues internally;
selfie metadata stays outside image slots, prompts and moderation decisions.

TTS expression selection defaults to `native`, with translated native/mapped
settings controls. The existing map is the native fallback and continues to serve
fixed system messages. Prefix precedence is manual tag, valid native selection,
then avatar mapping. Placement, merging, tag caps, inline allow-lists, normalizer
and secret-safe debug logging remain enforced. `play()` and TTS requests accept
the optional field; `say()` adds a fourth options argument and preserves its
third callback argument.

Validation: **911-test baseline; 955/955 pass**, with **44 new regressions** and
zero failures, cancellations or skips. Fake LLM/Fish transport covers all 49
choices; visual/planner tests verify unchanged image prompts and moderation.
Actual chat-handler and playback tests cover queue snapshots, cancellation,
concurrent clients, callback compatibility, fallback/override precedence,
placement/caps and secret-free debug logs. Build passes (73 modules), privacy
reports zero failing files, and whitespace checks pass. No live provider calls, dependencies,
credential changes or commits. Protected files retain these SHA-256 hashes:

- `server/personality.js`: `22A76160074880B22D1AA435437D740DDED1EA3AA2BCDC3BC4B43116164F2921`
- `config/selfieModeration.json`: `A0E67CBBFE0259F9A966A3725E352223419F2638715EE8EA9094FBD1FB5AA8FD`

Changed files in this native-selection follow-up (earlier uncommitted work is preserved):

```text
server/index.js
server/llmChat.js
server/speechEmotionPrompt.js
server/speechController.js
server/ttsExpression.js
server/ttsGenerate.js
server/providers/adapters/fishAudio.js
server/providers/contracts.js
server/streamingVisionManager.js
server/selfie/planner.js
server/selfie/jobManager.js
server/settings/schema.js
server/tests/nativeSpeechChat.test.js
server/tests/nativeSpeechPlayback.test.js
server/tests/nativeVisualEmotion.test.js
server/tests/ttsSettings.test.js
server/tests/settingsGui.test.js
src/settings/page.js
src/settings/viewModel.js
src/i18n/en.json
src/i18n/id.json
docs/providers.md
docs/STATUS.md
```

Manual verification: restart the backend and enable automatic Fish selection in
TTS settings. Try chat, a visual comment and a selfie caption; opt-in TTS debug
shows the native prefix while the avatar keeps its existing expression. Switch
to mapped mode to compare the saved mappings. Provider sound and actual browser/
Electron rendering remain manual verification.

## Local provider recovery (2026-11-06)

The machine's ignored provider override and backend environment file were missing.
Saved model assignments remained in local settings, but their provider references
had no definitions; the optional filter and TTS slots were unassigned. The manual
probe reported local configuration errors before any network request.

Restored four credential environment mappings and provider definitions in ignored
backend-only files. Endpoint/model metadata came from the pre-registry source at
`65e628c^` and the verified Groq preset. Existing saved chat, planner, vision and
STT choices were preserved; the missing filter and speech slots were restored.
All six slots pass offline availability checks. Backend restart is required after
manual configuration/environment edits. API-key validity and remote model support
remain unverified; no live provider calls were made.

Changed in this recovery: ignored `.env`, ignored `providers.config.local.json`,
and this status record. Credential values are not recorded in documentation or
public configuration. No dependencies or commits; protected files are unchanged.
Validation: **911/911** isolated tests pass, zero failures/skips; privacy and
whitespace checks pass. A credential scan finds zero public project files
containing the supplied keys. Both restored machine files are Git-ignored.

## Fish emotion catalogue (2026-11-06)

Added all 49 user-supplied Fish emotion tags as a shared catalogue: 24 Basic and
25 Advanced, with id/en labels. TTS settings provide two grouped selectors for
each of the existing twelve avatar emotions. The selectors synchronize with the
advanced JSON map, preserve custom tags and other entries, and support no tag.
Scoped fieldset styles keep the editor within narrow settings panels.

All catalogue names are accepted as TTS emotion/map keys, including manual
`tts:try -- --emotion nostalgic` or `compassionate`. Defaults, the avatar emotion
enum, tag caps, inline-tag behavior and protected files are preserved. The full
catalogue is selectable; tags are not all sent at once or chosen randomly.

Validation baseline: **898/898**; final **911/911**, with **13 added regressions**,
zero failures/skips. Focused catalogue transport/config tests pass **6/6**, and
GUI/schema tests pass **35/35**. Build passes (73 modules), privacy reports zero
failing files, all eight changed/new JavaScript files parse, and whitespace
checks pass. Protected-file hashes are unchanged. Tests use fake loopback providers and local DOM/config
fixtures. No live synthesis, dependencies or commits. Actual UI layout and sound
remain manual verification; choose preset tags in TTS settings and save the slot,
then use the manual CLI for listening.

Changed files in this follow-up:

```text
server/fishEmotionTags.js
server/ttsExpression.js
server/settings/schema.js
server/tests/fishEmotionTags.test.js
server/tests/fishEmotionGui.test.js
server/tests/settingsGui.test.js
src/settings/page.js
src/settings/viewModel.js
src/settings/settings.css
src/i18n/id.json
src/i18n/en.json
docs/providers.md
docs/STATUS.md
```

## TTS expressiveness (2026-11-06)

Original inspection found that Fish's five English emotion labels never matched
the twelve Indonesian chat emotions (`netral` included). Each sentence request
used MP3 and hardcoded latency low, omitted temperature/top_p/prosody, and had no
minimum sentence length or sanitizer. The TTS slot was unassigned during
inspection. Full original file/line evidence and parameter defaults are in
[Providers: TTS expressiveness](providers.md#tts-expressiveness).

Implemented configurable temperature 0.8, topP 0.7, balanced latency, speed/volume,
core emotion mappings (experimental netral calm/warm), per-sentence/first-only
prefixes, tag caps, short-sentence merging, and normalizing without word rewrites.
Inline performance cues default off, require an allow-list, and are removed
before display even across split/nested chunks. The speech-style module appends
instructions without editing the persona. Whole captions and streamed chat share
cumulative indexes and separate encoded audio request boundaries.

The local settings GUI has id/en controls. `TTS_DEBUG=1` or TTS params.debug logs
safe request metadata/final text without audio. `npm run tts:try` writes manual
audio trials and six sequential A/B variants with first-chunk/total timings;
temporary output is the default. No live provider calls were made.

Validation: baseline **834/834** passed; final **898/898** passed twice, with
**64 added regressions**, zero failures/skips. Build passes (72 modules), privacy
reports zero failing files, all 17 changed/new JavaScript files parse, whitespace
checks pass, and `tts:try -- --help` works without synthesis. New tests use fake
Fish WebSocket providers, injected registries and temporary outputs. Protected
persona/moderation hashes match the task baseline. No dependencies or commits.
Live listening, actual provider acceptance and GUI/browser/Electron rendering
remain manual verification.

Changed files (this task only; pre-existing prompt inputs are preserved):

```text
package.json
server/llmChat.js
server/providers/adapters/fishAudio.js
server/providers/contracts.js
server/settings/schema.js
server/speechController.js
server/speechStylePrompt.js
server/ttsExpression.js
server/ttsGenerate.js
server/ttsTry.js
server/tests/providersContract.test.js
server/tests/providersRegistry.test.js
server/tests/speechStyle.test.js
server/tests/ttsExpression.test.js
server/tests/ttsSettings.test.js
server/tests/ttsTry.test.js
src/i18n/en.json
src/i18n/id.json
src/settings/page.js
src/settings/viewModel.js
docs/providers.md
docs/STATUS.md
```

## Providers P3 (2026-11-01)

Resumed the interrupted working tree, preserving uncommitted P2 and existing P3.
Health check: all **40** changed/untracked JS/CJS files parsed; build and privacy
passed. The first full run was **825/826**: one existing ComfyUI fixture exceeded
its three-second startup deadline. Its focused retry passed **12/12** and the
final full run passed **834/834**, zero failures/skips. No syntax errors, truncated
files or dangling imports were found. The transient fixture needed no code change.
PowerShell's npm wrapper was blocked by execution policy; `npm.cmd` worked.

The inherited-slot override implementation was already present. New regressions
verify planner and visionFilter with implicit/explicit inheritance, profile-only,
model-only and combined overrides, separate probe deadlines, and unchanged saved
settings/LLM configuration. Diagnostics previously created its scratch directory
inside the configured local directory. It now uses OS temporary storage, never
creates or repairs the real local directory, and never opens its secret store.
CLI subprocess guards cover missing/corrupt settings and forbidden credential or
provider-config access. Dummy deletion and cleanup are checked on success/failure;
the GUI requests the same self-test with an empty body.

### P3 audit

DONE describes implementation and offline evidence. Live verification limits below
still apply. The handoff column records the resumed implementation, not an earlier
session's remembered TODO list. Evidence paths include one-based line numbers.

| Item | Handoff | Final | Evidence |
| --- | --- | --- | --- |
| A1 stale locks | DONE | DONE | server/settings/files.js:67; server/settings/files.js:79 |
| A2 bounded probe/progress | DONE | DONE | server/settings/routes.js:121; server/providers/registry.js:53; server/tests/settingsApi.test.js:310 |
| A3 models helper | DONE | DONE | server/settings/models.js:6; server/settings/routes.js:100 |
| A4 isolated doctor/API | PARTIAL | DONE | server/settings/doctor.js:9; server/settings/doctorCli.js:1; server/settings/routes.js:95; server/tests/settingsP3.test.js:93 |
| B1 local entry points/window | DONE | DONE | src/bootstrap.js:9; desktop-companion/src/main/settingsWindowManager.js:1 |
| B2 tabs/wizard/resume | DONE | DONE | src/settings/page.js:250; src/settings/page.js:276; src/settings/wizard.js:1 |
| B3 profiles/presets/credentials | DONE | DONE | src/settings/page.js:70; src/settings/presets.json:1 |
| B4 slot editors/inheritance/tests | DONE | DONE | src/settings/page.js:136; server/providers/registry.js:53 |
| B5 status/warnings | DONE | DONE | src/settings/page.js:201 |
| B6 privacy destinations/links | DONE | DONE | src/settings/page.js:219; src/settings/viewModel.js:58 |
| B7 id/en and parity | DONE | DONE | src/settings/i18n.js:4; src/i18n/id.json:1; src/i18n/en.json:1; server/tests/settingsGui.test.js:21 |
| B8 security/accessibility | DONE | DONE | src/settings/apiClient.js:4; src/settings/dom.js:2; src/settings/settings.css:1; desktop-companion/src/main/settingsWindowManager.js:13 |
| C tests/docs | PARTIAL | DONE | server/tests/settingsApi.test.js:444; server/tests/settingsGui.test.js:186; server/tests/settingsP3.test.js:124; docs/settings-gui.md:1; docs/settings.md:1; README.md:90 |

Validation: **798** before P3, **826** at interruption, **834/834** final (**8 new
regressions this continuation**, **36 total since P2**). Build, privacy and
whitespace checks pass. Proxy integration exercises real local HTTP fixtures for
profile/secret saves, models, streamed probes, deadline bounds, stale locks and
diagnostics through both Vite and Electron. The session token remains in memory;
provider strings use textContent; password inputs clear before transport.

Cannot verify offline: **live DPAPI, live providers, real Electron rendering and
browser layout**, including actual 360px usability. DPAPI and windows use fakes;
contrast ratios are calculated tests. Maintainers must verify preset URLs against
official docs before release. See the [GUI guide](settings-gui.md) for the checklist.
No dependencies or commits were added. Protected moderation/personality files are
unchanged. P3 is complete; stop before any subsequent phase.

Files edited in this continuation: README.md; docs/STATUS.md; docs/settings.md;
docs/settings-gui.md; server/settings/doctor.js;
server/tests/settingsApi.test.js; server/tests/settingsGui.test.js;
server/tests/settingsP3.test.js.

### Full uncommitted P2/P3 file list

This includes prior-session changes. The two untracked prompt documents are
preserved inputs, not edited outputs.

| Area | Modified or untracked files |
| --- | --- |
| Root | README.md, index.html, package.json, vite.config.js |
| Desktop main | desktop-companion/src/main/index.js, desktop-companion/src/main/staticServer.js, desktop-companion/src/main/trayManager.js, desktop-companion/src/main/settingsWindowManager.js |
| Desktop preload | desktop-companion/src/preload/preload.cjs |
| Docs | docs/STATUS.md, docs/providers.md, docs/settings.md, docs/settings-gui.md, docs/prompts/providers-p2.md, docs/prompts/providers-p3.md |
| Scripts/server entry | scripts/runTests.js, server/index.js |
| Providers | server/providers/baseUrl.js, server/providers/config.js, server/providers/registry.js, server/providers/testSlot.js |
| Adapters | server/providers/adapters/anthropicNative.js, server/providers/adapters/fishAudio.js, server/providers/adapters/openaiCompatible.js, server/providers/adapters/shared.js |
| Settings backend | server/settings/doctor.js, server/settings/doctorCli.js, server/settings/files.js, server/settings/models.js, server/settings/routes.js, server/settings/schema.js, server/settings/secretStore.js, server/settings/service.js, server/settings/store.js |
| Tests | server/tests/desktopShortcuts.test.js, server/tests/selfieRouting.test.js, server/tests/settingsApi.test.js, server/tests/settingsGui.test.js, server/tests/settingsP3.test.js, server/tests/settingsReload.test.js, server/tests/settingsService.test.js, server/tests/settingsStorage.test.js |
| Frontend bootstrap/language | src/bootstrap.js, src/i18n/en.json, src/i18n/id.json |
| Settings frontend | src/settings/apiClient.js, src/settings/dom.js, src/settings/i18n.js, src/settings/page.js, src/settings/presets.json, src/settings/settings.css, src/settings/viewModel.js, src/settings/wizard.js |

## Providers P2 (2026-11-01)

Implemented only P2. The runtime layers committed templates, developer overrides,
and strict non-secret user settings; environment values supply credentials only.
The API reports per-field sources and safe credential presence. Header values and
credential-like body extras stay in the separate origin-bound secret store.
Changing an origin requires replacement credentials or explicit deletion;
imports cannot bypass the rule. Legacy endpoint/model migration is explicit and
never copies environment keys. See [Settings](settings.md) for schema and API use.

The API checks loopback peers, allowed Hosts, every forwarded hop, same-origin
evidence and a backend-session token. Both frontend proxies preserve those checks
and no-store/no-CORS responses. Provider probes share the existing helper with
bounded input, a rolling rate limit, one active call and a five-second deadline.
Successful writes reload the registry and send only a value-free
`settings_changed` event; active calls keep their old provider and credentials.

Settings use bounded, versioned atomic writes and corrupt-file backups. Windows
uses DPAPI CurrentUser; non-Windows defaults to read-only environment credentials.
Plaintext persistence requires explicit opt-in and reports a persistent warning.
Native non-Windows keychains are not implemented. DPAPI is tested with an injected
runner, not the live OS backend. Atomicity is per file: ordinary write failures
attempt rollback, but no cross-file crash journal exists. Origin mismatches fail
closed; same-origin crashes can leave a new key with previous settings. Stale lock
files require local recovery after stopping all writers.

Validation: baseline **702/702**, final **798/798**, with **96 added tests** and
zero failures/skips. Tests use temporary directories, fake DPAPI, local HTTP/WS
providers and real Vite/Electron proxy fixtures. Coverage includes API access,
schema rejection, secret omission, origin binding, optimistic conflicts, corrupt
recovery, import/export/migration, probe limits and in-flight reloads. Privacy
reports zero failing files; frontend build and whitespace checks pass. Protected
moderation/personality hashes are unchanged. No dependencies, commits, generation,
live provider calls or GUI were added.

Changed files:

```text
server/settings/{schema,files,store,secretStore,service,routes}.js
server/providers/{config,registry}.js
server/providers/adapters/{shared,openaiCompatible,anthropicNative,fishAudio}.js
server/index.js
vite.config.js
desktop-companion/src/main/staticServer.js
server/tests/{settingsStorage,settingsService,settingsApi,settingsReload}.test.js
docs/{settings,providers,STATUS}.md
```

The user-supplied untracked `docs/prompts/providers-p2.md` is preserved unchanged.

## Source ZIP validation correction (2026-10-31)

The P1.5 verification used a Git clone, which missed extracted source ZIPs.
Both `npm test` and `check:privacy` previously required a `.git` directory and
failed before validation in an extraction. They now share file enumeration:
checkouts retain their tracked/untracked behavior, while archives use temporary
Git metadata outside the source to apply nested ignore rules and exceptions.
The archive and test snapshot remain `.git`-free. Git itself is still required;
an archive inside another checkout does not inherit its parent, and broken
metadata in an actual checkout remains an error.

Validation: **702/702** tests pass in both the working checkout and a temporary
source ZIP-style copy without `.git` (previous verified count **699/699**).
The copy passes `npm ci` and `npm run check:privacy`, and still has no `.git`
after both commands. Checkout privacy and whitespace checks pass. Three new
regressions cover archive ignore rules, unrelated parent repositories and broken
checkout metadata. Protected files are unchanged; no commits were made.

Changed: `scripts/{runTests,checkPrivacy}.js`,
`server/tests/{privacy,hermeticSetup}.test.js`, `docs/providers.md`, and this file.
Previously extracted ZIPs need these updated scripts before rerunning validation.

## Providers P1.5 (2026-10-31)

The shared provider file now contains only three adapter templates with explicit
endpoint/model placeholders; all six slots are null. Before replacement, the
effective provider selection was saved to ignored `providers.config.local.json`
without printing it. An actual-configuration check and a temporary-file reload
confirmed all existing profiles/slots remain identical. Synthetic migration
regressions cover environment resolution, nested overrides and unassigned roles.
Environment values cannot assign a public slot. Unavailable features give setup
hints and retain the existing text/planner fallbacks.

Every HTTP adapter request enforces the configured origin and refuses redirects;
Fish disables WebSocket redirects. The reusable URL validator rejects credentials,
queries, fragments, link-local and known cloud-metadata addresses, and requires
TLS except for loopback/private IP services. Status reports a plaintext warning
without exposing the endpoint. Local redirect fixtures verify that custom key
headers never reach the redirect destination. Address checks are lexical, without
DNS pinning.

`npm test` now runs a temporary public source snapshot with isolated local,
home/config, user-data and memory directories. Private configs, credentials,
references and model runtimes are excluded. A Node filesystem guard rejects
original-checkout/home access and immutable-source writes, including swallowed
errors; dependency reads required to execute tests are allowed. Native commands
are outside that JavaScript guard. Fixtures supply explicit temporary paths.
Normal memory storage retains its existing default, with optional `WAIFU_DATA_DIR`.

The removed SDKs are absent from both root manifests. All nine direct dependencies
are used. `whisper-large-v3` predates P1 (initial STT commit `c3e8671`) and was
preserved locally; the old turbo header comment was stale. No public STT model is
selected. See [Providers](providers.md) for configuration and transport policy.

Validation: baseline `npm test` ran **637 tests**, with **632 passing** and five
machine-runtime readiness failures. Final `npm test` passes **699/699** in this
checkout and **699/699** in a temporary `git clone`, with **62 added tests** and
zero failures/skips in both locations. Because P1/P1.5 are uncommitted, the clone
received only Git-eligible public working files, including deletions; it contained
no private config, `.env`, data or model runtimes. `npm ci` succeeded there
(116 packages). The frontend build passes (57 modules), privacy check reports
zero failing files, and syntax/whitespace checks pass. Sixteen regressions exercise
test isolation, including Node subprocesses, swallowed errors, hardlinks,
junctions and Windows extended-length paths. Protected-file hashes are unchanged.
No live provider calls, browser/Electron manual flows or commits were performed.

P1.5 changed files:

```text
.env.example
providers.config.json
providers.config.local.json (ignored)
package.json
scripts/runTests.js
server/providers/{baseUrl,config,registry,resilience}.js
server/providers/adapters/{shared,anthropicNative,fishAudio}.js
server/memoryManager.js
server/selfie/providers/comfyuiProvider.js
server/tests/{providersRegistry,providersSafety,hermeticSetup,localPaths}.test.js
server/tests/{providerResolver,sdcppProvider,selfieOutputDir,selfieTestCli,serverIntegration}.test.js
server/tests/testSetup.cjs
docs/providers.md
docs/STATUS.md
```

## Providers P1 (2026-10-30)

Implemented only P1. Public defaults preserve the existing provider endpoints,
models, environment names, prompts, Fish voice/protocol, emotion parser and
sentence splitter. The registry owns chat, planner, memory, both vision paths,
STT, TTS and optional warm-up. Configuration deep-merges an ignored machine
file; missing capabilities degrade through existing text/speech flows. ImageProvider,
selfie moderation and personality are unchanged. No GUI or credential store was added.

The [call-site map and provider guide](providers.md#call-site-audit) records the
migrated file/line locations, contracts, capability matrix, compatibility quirks,
configuration and CLI. All three SDK wrapper files and unused model constants
were removed, together with the OpenAI/Groq SDK dependencies. No legacy AI client
call sites remain. No new dependencies or commits were made.

Validation: initial in-place `npm test` ran **546 tests**, with **541 passing** and
five existing failures caused by local sd.cpp runtime state. A portable baseline
copy passes **546/546**; the final portable copy passes **637/637** (91 added,
zero failures/skips). Both complete copies used `node --test --test-concurrency=1`
on every test file, fixture credentials and no private config/runtime files.
The provider contract/config/flow suite passes **91/91** in the working checkout;
the migrated pre-existing planner/moderation/speech/shortcut tests pass **76/76**.
`npm run check:privacy` passes with zero failing files, `npm run build` passes with
57 modules, and syntax/whitespace checks pass. Tests use local fake HTTP/WebSocket
servers. Real provider probes and manual browser/Electron flows were not run.

Changed files:

```text
.env.example
.gitignore
package.json
package-lock.json
providers.config.json
server/providers/{contracts,errors,resilience,sse,config,registry,testSlot,cli}.js
server/providers/adapters/{shared,openaiCompatible,anthropicNative,fishAudio}.js
server/{index,llmChat,memoryManager,modelWarmup,streamingVisionManager,sttTranscribe,ttsGenerate,visionCapture}.js
server/selfie/planner.js
server/tests/{providerFixtures,providersContract.test,providersRegistry.test}.js
server/tests/{desktopShortcuts,moderationGuards,planner,speech}.test.js
docs/providers.md
docs/STATUS.md
Removed: server/{experientialClient,nineInferenceClient,groqClient,modelConfig}.js
```

The four untracked provider helper files present at task start were reused.
The pre-existing `docs/prompts/` files were left unchanged. Protected-file hashes
match the starting values. Work stops after P1.

## Shared download manifest (2026-10-26)

`setup/manifest.json` is now committed as public download metadata. It contains upstream
URLs, immutable pins, published checksums, byte counts, licenses and relative installation
destinations. Setup commands read it by default; custom or private metadata belongs in an
ignored `local/manifest.json` passed with `--manifest`. This supersedes the manifest
exclusion recorded in the 2026-10-25 commit preparation below.

The ComfyUI-GGUF source ZIP still needs a verified SHA-256 and byte count. ComfyUI runtime
installation refuses until those fields are filled; model downloads and sd.cpp variants
have complete metadata. Offline regressions check the committed manifest against shared
config/workflow filenames and exercise setup using its default path.

Validation: **546/546** tests, zero failures/skips; privacy check passes with **0** failing
files; frontend build passes with **57 modules**. An initial managed idle-cleanup timing
failure passed in isolation and in the final full suite.

## Privacy and portable commit preparation (2026-10-25)

`selfie.config.local.json` matches an ignore rule. The shared config uses `${LOCAL}`
model/output/log paths and resolver defaults for engine binaries. Canonical sd.cpp
destinations are `runtime/sdcpp/<variant>`; `runtime/sd-cli` remains a legacy fallback.
A temporary-file regression proves a copied local config preserves the previous effective
configuration after the shared config becomes portable. Nested objects merge; arrays,
scalars and null replace earlier values. No real machine config is read by that test.

Added `npm run check:privacy` and four privacy tests to the default suite. The guard scans
tracked and untracked non-ignored text case-insensitively, reports file/count pairs, reads
OS identities at runtime, and permits only neutral documentation path prefixes. Tests use
runtime-built paths; documentation and dependency contact metadata are sanitized.
Setup tests now use synthetic metadata rather than the excluded setup manifest.

Validation: **545/545** tests, zero failures/skips; frontend build passes with **57 modules**.
A separate temporary checkout containing only eligible files also passes **545/545**,
without the private config, manifest, runtime directories or reference assets. The fixtures
directory contains one **3,118-byte synthetic text script**, no files over 100 KB and no
binary fixtures. A read-only scan of six branch refs covers **76 commits** and finds
**242 commit/file pairs** across **63 commits and 10 files**; history is unchanged.

Commit preparation assigns all **70** eligible changed/untracked files to seven groups.
The machine config, local runtimes, references, old sd-cli directory, run table and setup
manifest remain excluded. `config/selfieModeration.json` and `server/personality.js`
are unchanged. The seven local Conventional Commit groups are approved, with descriptive
subjects and bodies; no push is authorized.

## Verified setup metadata (2026-10-25)

Filled nine of ten component entries with verified upstream artifacts, immutable pins,
published SHA-256, exact byte counts and license links. Diffusion is the user's
`abenzerps/Qwen-Image-2.1-Uncensored-Quantized` Q5_K_M, based on `Qwen/Qwen-Image-2.1`.
VAE and the ComfyUI INT8 ConvRot encoder come from Comfy-Org; the official Qwen3-VL
Q4_K_M GGUF encoder and F16 mmproj share one pinned revision. Every filename matches the
existing shared config/workflow; no tuning, model selection or machine settings changed.

ComfyUI portable is v0.42.1. Both sd-cli builds are pinned to `master-1010-bb6a0cc`;
CUDA12 includes its matching CUDA 12.8.1 cudart/cuBLAS bundle. The GGUF node uses the
publisher-recommended leejet fork, commit `373048b8403a7820620065210a691263d4da0a61`,
whose loader accepts `qwen_image21`. Its URL, commit and Apache-2.0 license are verified,
but its generated archive has no published hash/size: only `sha256` and `sizeBytes`
remain TODO/null. Full ComfyUI setup remains deliberately blocked by those two fields.

Hugging Face revision/tree APIs publish model fingerprints; GitHub release asset HTML
publishes runtime fingerprints. HTTP HEAD confirmed all ten artifact URLs and all nine
known exact byte counts without fetching artifact bodies. Qwen Image model cards specify
the Qwen Research License Agreement (non-commercial research/evaluation); the separate
official GGUF encoder/projector model card declares Apache-2.0. Provenance, pinned source
links and license inheritance are recorded in [Pinned sources](setup-sources.md).

Validation: baseline `npm.cmd test` **539/539**; final **540/540**, zero failures/skips.
All existing test cases remain; the shipped-placeholder case now checks populated metadata
and retains explicit all-component placeholder rejection coverage. One new regression
checks config/workflow filename parity, GGUF pair revision and both sd.cpp variant scopes.
Setup dry runs and manifest validation pass for both model engines and sd-cli variants;
full validation reports only the two unresolved node fields. Protected file hashes are
unchanged. No artifact downloads, installs, license acceptance, dependency changes or commits.

Changed: `setup/manifest.json`, `server/tests/setupManifestV2.test.js`, `docs/setup.md`,
`docs/setup-sources.md` and this file. Prior working changes are preserved.

## Manifest/setup refinements (2026-10-25)

Resumed the previous session's working files. Manifest v2 types every component with
engines, role and Windows/GPU conditions; v1 remains readable with an explicit migration
message. Engine filters select shared diffusion/VAE plus the engine's encoder; sd.cpp GGUF
requires mmproj. Plan reports each engine/variant's bytes, unknown sizes and missing roles.
At that stage, the portable/node, CUDA12/cudart, Vulkan and five model entries were
metadata TODOs. The verified metadata section above records their subsequent population.

NVIDIA selects CUDA12 with required matching cudart; other/unknown adapters select Vulkan,
with an explicit variant override. Canonical installs use `local/runtime/sdcpp/<variant>`;
the earlier `sd-cli` layout remains readable when the canonical root is absent. Variant
destinations are isolated and collision checks include physical junction targets and saved
provenance. `--force` and v1 compatibility cannot mix builds.

Local runtime precedence requires embedded Python plus `ComfyUI/main.py`, or a successful
sd-cli `--help`. Invalid local runtimes use configured legacy paths with prominent provider
status/doctor warnings; without a fallback, missing-file diagnostics include precise relative
filenames in public status. Doctor checks the GGUF node in the selected ComfyUI installation.

Optional pinned constraints reach pip with `-c`; the full argv is logged and `--skip-pip`
is recorded/reported. `local/installed.json` records component pins, source hashes and
installed file fingerprints, refreshed for bundled files changed by pip. Doctor reports
metadata, missing-file and runtime-size drift; `--verify-hashes` also detects same-size
replacement. `npm run setup:hash -- FILE` prints size/SHA-256 and a manifest snippet offline.

Validation: session baseline **525/525**; final `npm.cmd test` **539/539** (14 added,
all 525 baseline test names retained, zero failures/skips). `npm.cmd run build` passes
with 57 modules; all 19 relevant JS files pass `node --check`; `git diff --check` passes.
Tests use temporary directories, loopback fixtures, tiny archives and injected probes/pip.
Plan, engine-filtered setup dry runs and offline hash were smoke-tested. Offline doctor
reports the expected TODO metadata/missing local components; its native GPU probe was
unavailable and visibly selected the Vulkan default. Real installation/generation remains
unverified. Protected file hashes match the session baseline. No real downloads, installs,
dependency changes or commits; prior unrelated working changes are preserved.

Changed/resumed: `setup/*`, the existing `package.json` setup commands,
`server/selfie/{localPaths,runtimeValidity,comfyuiManagedProcess,providerResolver}.js`,
sd.cpp/managed-ComfyUI providers, setup/runtime tests, `docs/setup.md` and this file.

## Reproducible local setup (2026-10-25)

Added `server/selfie/localPaths.js` as the shared resolver for `WAIFU_LOCAL_DIR` or
`<repo>/local`, model kinds, engine runtimes, outputs and logs. `${LOCAL}` config values
expand after defaults, shared JSON, ignored machine JSON and explicit overrides deep-merge.
Valid local runtimes win over explicitly configured legacy engine paths; invalid local
runtimes now warn and retain the configured fallback. ComfyUI and sd.cpp resolve references
and outputs through the same module. Fresh ComfyUI readiness uploads a configured whitelisted
default reference before validating its input choices, without submitting a generation prompt.
Electron gallery/package snapshots use the same resolver and machine output overrides.

The shared selfie config now has portable paths and safe shared tuning. Previously verified
machine ComfyUI/sd.cpp paths and tuning were preserved in ignored `selfie.config.local.json`.
`local/`, machine config, personal references, old `sd-cli/`, run tables and defensive test
temporary-directory patterns are ignored. Test fixtures use `os.tmpdir()` and clean up their
directories; no `.test-move-*` or `.commit-test-move-*` directories were created in the repo.

`setup/manifest.json` and its schema define every engine, runtime library, custom node and
model download. URLs, hashes, versions, sizes and license metadata remain explicit TODOs;
the validator reports every incomplete field and real setup refuses them. Setup groups are
dry runs by default. Real runs require `--yes`, verified metadata and per-license acceptance
recorded by name/URL in the local root. HTTP Range resumes partial downloads; size/SHA-256
verification precedes exclusive publication. Staged ZIP/TAR/7z extraction rejects unsafe
entries, and installed files need `--force` to replace. Portable 7z needs an existing detected
7-Zip/bsdtar. The pinned node's requirements install through embedded Python only after consent.
Generated ComfyUI model YAML uses keys and aliases read from its installed example.

`npm run doctor` is offline: component/provider files and sizes, bounded sd-cli device and
ComfyUI help probes, workflow models, duplicate basename/size candidates, disk, RAM and
validated commit counters all have actionable diagnostics. Fix commands preserve a custom
manifest path. No server starts, HTTP health checks or downloads occur in doctor. Real model
generation and real archive/package installation remain unverified; TODO metadata deliberately
prevents an install until upstream pins, hashes, byte counts and licenses are supplied.

Validation: baseline `npm.cmd test` **436/436**; final **495/495** (all baseline tests retained,
59 added, zero failures/skips). `npm.cmd run build` passes with 57 modules. Local fake HTTP
and tiny archives cover interruption/resume, corrupt checksums, invalid metadata, consent,
dry-run defaults, overwrite races, archive safety, mocked pip/YAML, path/config precedence,
reference cancellation, packaged output parity and doctor diagnostics. All 16 affected JS
files pass `node --check`; `git diff --check` passes. All four setup commands were smoke-tested
as dry runs. Offline doctor found the configured legacy engines/models and a duplicate GGUF
candidate; unavailable Windows commit counters now report unavailable rather than zero.

Changed for this task: `.gitignore`, `package.json`, `selfie.config.json`, `setup/*`,
`server/selfie/{localPaths,config,comfyuiManagedProcess}.js`, all three local provider files,
`desktop-companion/{package.json,src/main/selfieOutputDir.js}`, five corresponding test files,
`docs/setup.md`, `docs/selfie.md` and this status file. Existing unrelated working changes were
preserved. Protected file hashes match the initial values. No external downloads, real installs,
generation or commits were made. See [Local setup](setup.md) for commands and layout.

## Managed ComfyUI (2026-10-25)

Added `comfyui-managed` by composing `ComfyUiProvider` with a local process owner. Workflow
templates, `_meta.title` mapping, random seeds, progress, owned-prompt cancellation and `/free`
retain the existing implementation. Automatic selection defaults to `comfyui`, `comfyui-managed`,
then `sdcpp`; explicit modes stay independent.

`selfie.config.json.comfyuiManaged` has empty configurable installation/interpreter/script paths,
loopback host, automatic port, array arguments, environment, profiles, 120000 ms startup timeout,
90-second idle stop and configurable health path. No ComfyUI Desktop layout is inferred. Readiness
names absent configured paths and runs cached interpreter/script `--help` with a 15-second bound;
unsupported configured flags warn and skip. It does not start the server. After starting its own
hidden child, the provider validates workflow nodes and loader files through `/object_info`.

Ports are selected by binding to zero and retrying excluded/occupied Windows ranges. Launch uses
no shell and the configured ComfyUI root as cwd. Only owned children are reused or stopped;
external ComfyUI stays with the existing provider. A persisted PID record checks process name,
executable, script and start time before stale cleanup. Each job releases models before arming
idle shutdown; new jobs cancel that timer. Backend shutdown and config replacement join owned
child cleanup. Public provider status includes profile and running state without local paths.

Shared telemetry samples cold start and generation, including VRAM, shared GPU memory, private
bytes, current working set and system commit. Warm jobs start fresh sampled peaks. CLI
`--profile NAME` selects an ephemeral profile and prints cold-start/generation times and peaks.
Backend jobs and CLI attempts append provider/profile rows to `docs/selfie-runs.md`; historical
bytes remain unchanged. Managed generation ETA excludes cold start.

Validation: baseline **382/382** passed; final `npm.cmd test` passes **436/436** (54 new
regressions, all baseline tests retained, zero failures/skips). `npm.cmd run build` passes with
57 modules; all 20 affected runtime/test JavaScript files pass `node --check`. Changed tracked
files pass `git diff --check`; the repository-wide check retains the pre-existing whitespace
issue at `.gitignore:52`. Spawned fake ComfyUI scripts cover paths with spaces, help filtering,
startup/health, port fallback, idle reuse/stop, admitted/abandoned and queued jobs (including
zero-second idle during asynchronous run logging), cancellation,
shutdown, missing nodes/models, and isolation from external instances. Startup cleanup also runs
when explicit external ComfyUI/sd.cpp is selected. Process identity, Windows termination and GPU
counters use injected probes. CLI smoke reports `installDir`, `pythonPath` and `mainScript` as
unconfigured, with cold-start/generation times of zero and no server process launched; two actual
unavailable-attempt rows were appended. Native ComfyUI/GPU generation remains unverified because
installation paths were not supplied.

Changed: `selfie.config.json`; `server/selfie/{config,providerResolver,jobManager,sdcppMemory,selfieTest,selfieExperiments}.js`;
`server/selfie/comfyuiManagedProcess.js`; `server/selfie/providers/{comfyuiManagedProvider,comfyuiProvider}.js`;
matching tests and fake-server fixture; `docs/selfie.md`, `docs/selfie-runs.md`, and this file.
Protected file hashes, existing tests and unrelated working changes are retained. No installs,
downloads or commits were made.

Local installation configured (2026-10-25): Desktop launcher logs identify the active root as
`<comfyui-install-dir>` and its interpreter as `.venv/Scripts/python.exe`.
These verified paths now populate `comfyuiManaged`; arguments retain Desktop's existing shared
input/output directories, including the workflow reference image. All three loader models exist
under that root. The interpreter package probe and `main.py --help` pass. No local server or
generation was started during this configuration check; no external installation files changed.

## Selfie CLI quality experiments (2026-10-24)

`selfie:test` accepts split or equals forms for `--steps`, `--cfg`, `--size WxH`, `--strength`,
`--init-image`, `--seed`, `--label`, and `--reference`, plus repeated `--arg`, `--drop-arg`,
and `--model-arg`. Overrides clone the config in memory and take precedence over provider preset
values. Dropped flags lose their associated values; dropping CPU offload disables its automatic
reinsertion. Extra `FLAG=VALUE` entries become separate argv tokens. Reference paths use a
temporary reference directory while retaining provider file validation.

sd.cpp maps optional base/preset `initImage` and `strength` to `-i` and `--strength` after checking
cached help. Missing flags warn and skip; `initImage: "reference"` uses exactly the `-r` path.
The cached local `sd-cli/sdcli-help.txt` confirms both flags. Width and height validate independently
as positive multiples of 32. The current ComfyUI workflow supports square resolution only and
rejects rectangles before submission; automatic selection can then try sd.cpp.

Every generation attempt appends one row to `docs/selfie-runs.md`, preserving existing bytes/rows,
including on readiness failures and failed generation. Rows include tuning, extra/dropped/model
args, seed, durations, peak VRAM/working set/system commit/shared GPU memory, output, status,
init image, and reference. Missing samples stay unavailable. Windows shared GPU counters are
scoped to the child PID and summed across adapter instances; shared peaks also persist in the
bounded telemetry history. `--compare a.png b.png` reads PNG/JPEG/WebP dimensions and file sizes
only, bypassing config loading, models, ETA updates, and run logging.

Validation: initial `npm.cmd test` ran **353 tests**, with 352 passing and one fixture depending on
the user's local `forceRun` setting. That fixture now specifies its CPU/memory override settings.
Final `npm.cmd test` passes **382/382** (29 new regressions, zero failures/skips). All seven changed
runtime JavaScript files pass `node --check`; `git diff --check` passes. Fake sd-cli processes cover
override parsing/precedence, flag drops and values, init/strength mapping and missing-flag skips,
and repeated append-only rows. Metadata comparison, shared counters, legacy history, and ComfyUI
square-workflow rejection have focused regressions. No native GPU probe or live generation ran.

Changed for this task: `server/selfie/{config,etaStore,sdcppMemory,selfieTest,selfieExperiments}.js`,
`server/selfie/providers/{sdcppProvider,comfyuiProvider}.js`,
`server/tests/{selfieConfig,selfieTestCli,selfieExperiments,sdcppProvider,sdcppMemory,etaMemoryPeaks,comfyuiReadiness}.test.js`,
`docs/selfie.md`, `docs/selfie-runs.md`, and this status file.
`config/selfieModeration.json` and `server/personality.js` retain their initial SHA-256 hashes.
No config changes, dependencies, downloads, or commits were made for this task. Work stops here.

## Selfie memory and argument correction (2026-10-24)

This correction supersedes the original E1.5 memory refusal and offload-key behavior described below. With CPU offload enabled, RAM estimates stage the combined distinct model-file sizes and VRAM estimates use the largest single component plus `sdcpp.memory.computeBufferGB` (default 2.5 GB). With offload disabled, VRAM estimates use the combined size and RAM retains its configured staging floor. Windows commit estimates use the combined size plus `marginGB` (default 2 GB). Existing minimum floors remain 4 GB RAM, 1 GB VRAM, and 8 GB commit.

RAM decisions use available physical memory, including standby cache, while diagnostics print both available and strictly free RAM. Each resource reports its requirement, available amount, ratio, and tier; diagnostics name every missed requirement and every hard failure. A known resource below `hardFailRatio * need` (default ratio 0.6) yields `insufficient` and refuses before generation/quota. Equality at that threshold or a value below need yields `tight`, which runs with a warning. Values meeting every requirement yield `ok`; missing probes remain `tight`. `forceRun` retains its existing override.

Windows commit headroom prefers the actual memory counters (`CommitLimit - CommittedBytes`), with a validated OS virtual-memory fallback. Early sanity failures clear prior memory diagnostics so the CLI cannot attribute an earlier preflight to the current job.

Explicit `sdcpp.offloadToCpu` survives config loading and maps to the base `--offload-to-cpu` flag; absent keys infer their value from base args. Preset arguments can enable offload. The preflight uses the flag actually supported in final argv. Backend logs and the test CLI report requested/effective offload values, base args, and preset args, including failed generation attempts.

Before generation spawn, a reference with a GGUF `--llm` and no `--llm_vision` fails with `LLM_VISION_MISSING`, explaining that it needs the Qwen3-VL mmproj file configured through `sdcpp.llmVision`. Safetensors LLMs do not trigger that check. `OFFLOAD_OFF_LOW_VRAM` is a warning when offload is disabled and estimated VRAM exceeds free VRAM; the independent hard memory threshold still applies.

Validation: the documented baseline is 328 tests. The initial working-tree run passed 327/328; one config path fixture assumed offload was enabled in the user's edited local config. The fixture now supplies its own offload setting. Final `npm.cmd test` passes **353/353** (25 added regressions, zero failures/skips). `npm.cmd run build` passes with 57 modules; all 10 changed JavaScript files pass `node --check`; `git diff --check` passes. Regression coverage includes tier boundaries, offload modes, available versus free RAM, commit-counter preference/fallback, sanity codes, and effective config logging, using only injected memory probes and fake sd-cli processes. No native GPU probe or live image generation was run for this correction.

Changed files for this correction: `server/selfie/config.js`, `server/selfie/sdcppMemory.js`, `server/selfie/providers/sdcppProvider.js`, `server/selfie/providerResolver.js`, `server/selfie/selfieTest.js`; matching config, memory, provider, resolver, and CLI tests under `server/tests/`; `docs/selfie.md` and `docs/STATUS.md`.

`config/selfieModeration.json` and `server/personality.js` are untouched. Configured model paths and unrelated working files are preserved; no dependencies, downloads, or commits were added. Work stops after this correction.

## Selfie Phase E1.5 (2026-10-24)

sd.cpp readiness caches help and probes `--list-devices` with a bounded injectable runner. It requires CUDA/Vulkan unless `allowCpu` is enabled, reports missing CUDA runtime DLLs beside the binary/on PATH, and lists build/release/driver causes. Runtime CPU fallback terminates the child tree with `NO_GPU_BACKEND`; component CPU offload remains allowed. Device parsing accepts native indexed/tabular output and rejects diagnostic lines that merely mention CUDA/Vulkan.

Sampling/offload options now come from `sdcpp.args`, with base/preset `modelArgs` passed as one comma-joined `--model-args` value. Unsupported optional flags are skipped with warnings; model argument keys are logged without semantic validation. `hemat` ships with 768 px, 12 steps, cfg 3, and empty preset additions. `logFile` records final argv and backend/device lines locally. Setup and tuning examples document matching CUDA/cudart releases, `--help`/`--list-devices`, and NVIDIA's per-program sysmem fallback policy.

Memory preflight is explicitly heuristic: configured model sizes, RAM, selected GPU VRAM, and Windows commit headroom determine `ok`, `tight`, or `insufficient`. Default floors are 4 GB RAM, 1 GB VRAM, and 8 GB commit headroom. Known insufficient memory refuses before generation/quota; `forceRun` overrides that refusal. Missing probes degrade gracefully. Telemetry defaults to 2-second samples with bounded commands, stops synchronously at child exit, and cannot delay/fail generation.

Status adds safe `sdcpp` readiness/device/memory/last-peak fields without argv or paths. Config revisions fence retired provider listeners. Available current-job peaks are stored under `_peaks.<preset>` beside ETA duration arrays, bounded by `etaHistorySize`, including failure/cancellation after start. ETA remains success-only. Missing samples never reuse prior job measurements; queued jobs use their actual provider's telemetry setting.

Validation: initial `npm.cmd test` passed **282/282**; final run passes **328/328** (46 added regressions, zero failures/skips). Provider tests pass 30/30, injected memory/telemetry tests 18/18, and focused root integration tests 42/42. `npm.cmd run build` passes with 57 modules; all 14 E1.5 JavaScript files pass `node --check`; `git diff --check` passes. Automated tests use fake sd-cli processes and injected NVIDIA/PowerShell/OS/timer probes; they perform no real GPU generation.

The diagnostic CLI smoke used the configured local binary for native readiness/preflight: CUDA detected an NVIDIA GeForce RTX 5050 Laptop GPU in 842 ms. The heuristic reported approximately 14.2 GB of model files, 3.2 GB free RAM, 6.5 GB free VRAM, and unavailable Windows commit data, then refused with `MEMORY_INSUFFICIENT` before image generation (exit 1). No image generation started. Live image output, memory tuning, and manual browser/Electron validation remain unverified.

Files changed in E1.5:

```text
docs/STATUS.md
docs/selfie.md
selfie.config.json
server/selfie/config.js
server/selfie/etaStore.js
server/selfie/jobManager.js
server/selfie/log.js
server/selfie/providerResolver.js
server/selfie/providers/sdcppProvider.js
server/selfie/sdcppMemory.js
server/selfie/selfieTest.js
server/tests/providerResolver.test.js
server/tests/sdcppMemory.test.js
server/tests/sdcppProvider.test.js
server/tests/selfieConfig.test.js
server/tests/selfieProviderIntegration.test.js
server/tests/selfieTestCli.test.js
```

`config/selfieModeration.json` and `server/personality.js` retain their initial SHA-256 hashes. No new npm dependencies, downloads, or commits were made. Existing unrelated working files remain in place. Work stops after E1.5.

## Selfie Phase E1 (2026-10-24)

Default `provider: "auto"` checks ComfyUI first, then sd.cpp; explicit provider modes never fall back. Readiness runs at startup, before requests/jobs with the 30000 ms cache, and after config changes. ComfyUI checks `/system_stats`, workflow classes, and listed UNet/VAE/CLIP/reference inputs through `/object_info` with the 1500 ms health timeout. The exported workflow's reference must already appear in ComfyUI's input list; selected references retain their upload flow.

sd.cpp verifies the binary's help flags and non-empty configured model files without loading models. Relative paths resolve beneath `userData/models/sdcpp`; Electron forwards its actual userData directory. Each job uses a hidden sd-cli process with array arguments, direct whitelisted references, shared preset resolution/steps/cfg, progress parsing, stderr diagnostics, and PNG validation before publishing output. Cancellation and timeout terminate the Windows child tree and delete partial files.

Only confirmed failures before generation may fail over. Accepted or uncertain submissions retain quota and fail the current job; generation failures invalidate readiness for the next request. `selfie_started` identifies the actual provider. Readiness accepts the turn signal, cancellation finishes preparation before the next queued job, and shutdown retains cleanup ownership across provider/config replacements. WebSocket status exposes safe diagnostics; full native errors and paths stay in backend logs and the CLI. Provider settings/presets reload while running; `outputDir` and `limitsStoreFile` require a backend restart to preserve existing tokens and counters.

Validation: baseline `npm.cmd test` passed 225/225; final run passes **282/282** (57 added regressions, zero failures/skips). The focused E1 review run passes 58/58. `npm.cmd run build` passes with 57 modules; all 19 changed JavaScript files pass `node --check`; `git diff --check` passes. Fake ComfyUI HTTP and Node sd-cli processes cover selection, missing nodes/models, disabled providers, cache expiry, safe prompts/paths, progress, invalid PNGs, process-tree cancellation/timeout, submission ownership, config races, private status, and quota persistence.

CLI smoke: `npm.cmd run selfie:test -- --provider=sdcpp --preset=cepat` printed provider reasons and an 8 ms readiness time, then correctly reported unavailable because `sdcpp.binaryPath` is empty (script exit 3). Live sd-cli/models, ComfyUI image generation, and manual browser/Electron flows remain unverified.

Changed files:

```text
desktop-companion/src/main/index.js
docs/STATUS.md
docs/selfie.md
selfie.config.json
selfie.mapping.json
server/index.js
server/selfie/backendLifecycle.js
server/selfie/config.js
server/selfie/featureControl.js
server/selfie/imageProvider.js
server/selfie/jobManager.js
server/selfie/providerResolver.js
server/selfie/providers/comfyuiProvider.js
server/selfie/providers/sdcppProvider.js
server/selfie/providers/workflowMapping.js
server/selfie/selfieTest.js
server/tests/comfyuiCancellation.test.js
server/tests/comfyuiReadiness.test.js
server/tests/featureControl.test.js
server/tests/providerResolver.test.js
server/tests/sdcppProvider.test.js
server/tests/selfieConfig.test.js
server/tests/selfieProviderIntegration.test.js
```

`config/selfieModeration.json` and `server/personality.js` retain their initial SHA-256 hashes. No downloads or commits were made. Work stops after Phase E1.

## Mute shortcut recovery (2026-10-23)

Resumed the interrupted working tree without resetting or committing. Initial `git status --short`: four modified files (`config.js`, `index.js`, `trayManager.js`, `preload.cjs` under `desktop-companion/src/`) and two untracked files (`shortcutManager.js`, `test-shortcut.cjs`). Initial `git diff --stat`: 4 files, 109 insertions, 74 deletions; untracked files are excluded from that stat.

Initial verification: `shortcutManager.js` exists; all 12 relative imports in the partial files resolve; all six changed JS/CJS files pass `node --check`. `npm.cmd test` passed 213/213 (15 above the previously documented 198 baseline), and `npm.cmd run build` passed with 57 modules.

| Item | Initial | Final | Evidence (file:line) |
| --- | --- | --- | --- |
| a. Configurable shortcuts; safe default mute | PARTIAL | DONE | `desktop-companion/src/main/config.js:125` defaults to `Control+Alt+Shift+M`; `desktop-companion/src/main/shortcutManager.js:10` loads JSON/environment overrides; `desktop-companion/src/main/shortcutManager.js:65` rejects reserved `Control+Shift+M` aliases; `desktop-companion/test-shortcut.cjs:3` uses only safe candidates. |
| b. Ready-time registration, return/verification logs, fallbacks and active combo | DONE | DONE | `desktop-companion/src/main/index.js:960` waits for readiness and `:977` registers; `desktop-companion/src/main/shortcutManager.js:89` logs `register()` results and `:97` checks `isRegistered()`; `:110` records the active combo. |
| c. Failure notification, usable tray mute, unavailable state | DONE | DONE | `desktop-companion/src/main/shortcutManager.js:74` starts unavailable and `:123` notifies on exhausted candidates; `desktop-companion/src/main/trayManager.js:230` shows a notification/balloon; `desktop-companion/src/main/index.js:916` retains tray mute. |
| d. Tray label shows active shortcut | DONE | DONE | `desktop-companion/src/main/trayManager.js:74` formats active/unavailable labels; `:165` applies the mute label. |
| e. Firing logs, capture/upload/STT stop, synchronized state | PARTIAL | DONE | `desktop-companion/src/main/shortcutManager.js:90` logs each firing; `desktop-companion/src/main/index.js:820` broadcasts revisioned state and `:455` validates acknowledgments; `src/companion.js:940` stops tracks/recorders and preserves the muted indicator; `:805` and `:1060` discard pending PTT/VAD uploads; `server/index.js:469` cancels current STT and `:543` rejects muted audio. |
| f. Second launch focuses first instance or exits clearly | DONE | DONE | `desktop-companion/src/main/index.js:39` locks/exits with a clear log; `:943` focuses/restores the first overlay; `:955` handles second launches, including pending startup focus. |
| g. Fake globalShortcut tests for fallback/failure/config/state sync | MISSING | DONE | `server/tests/desktopShortcuts.test.js:45` fallback/logs; `:77` overrides; `:158` failure notification/tray; `:172` state/IPC sync; `:257` capture/indicator/startup races; `:306` pending VAD upload; `:320` PTT; `:343` readiness/second launch; `:382` STT cancellation. |

Configuration: first launch creates `userData/shortcuts.json`. `DESKTOP_SHORTCUTS_PATH` selects another file; `SHORTCUT_MUTE_MIC`, `SHORTCUT_EDIT_MODE`, and `SHORTCUT_HIDE_AVATAR` override preferred bindings. Mute tries `Control+Alt+Shift+M`, then `Control+Alt+Shift+F9`, then `Control+Alt+Shift+F10`. The tray and `Active global shortcut` log identify the actual registered combo. Restart Electron after changing configuration.

Final automated validation: `npm.cmd test` passes 225/225 (12 new regressions, zero failures/skips); `npm.cmd run build` passes with 57 modules; every changed JS/CJS file passes `node --check`, all imports resolve, and `git diff --check` passes. Existing selfie reconnect fixtures now include microphone state synchronization. `config/selfieModeration.json` and `server/personality.js` retain their initial hashes; no commit was made.

Manual check: run `npm.cmd run dev:all`, then `npm.cmd --prefix desktop-companion run dev`; inspect the tray's active shortcut, alternate shortcut/tray mute while recording, confirm microphone capture ends and no new `audio_input`/STT occurs, verify unmute resumes capture, and launch Electron again to confirm focus. Set an invalid preferred binding with an empty fallback list in `shortcuts.json` to exercise the failure notice and usable tray action. Windows key delivery/notifications, real microphone capture and live Groq cancellation remain unverified; a microphone permission request already in progress is stopped as soon as its stream resolves.

## In progress / unverified
- Selfie Phase C: busy requests queue only within configured `maxQueue`; zero disables queuing.
- Selfie Phase D manual validation remains pending: run `npm.cmd run dev:all`, then `npm.cmd --prefix desktop-companion run dev`; exercise Pap toggle/gallery, Cancel, Save/Copy/Folder, consecutive jobs, result zoom/close, display unplug/DPI changes, application quit, and browser fallback. Windows screen capture must be checked with the popup visible; fake-window tests assert content protection and capture IPC exclusion, not OS pixels. Live ComfyUI/assets and installer checks remain unverified.
- sd.cpp: provider and hardening verified with fake sd-cli/memory probes. Configured native CUDA readiness was observed; memory preflight refused before generation. Live image output and preset/memory tuning remain unverified.
- Cloud image provider: unavailable stub returning NOT_IMPLEMENTED.
- Optional L3 remains unimplemented: forced termination does not persist/recover an in-flight ComfyUI prompt ID. Cooperative cancel/shutdown is covered.
- Verified P1-P5 corrections: 157/157 baseline increased to 189/189; the resize/settings follow-up passes 198/198 (9 more, zero failures/skips; existing coverage retained). New regressions cover shrink/display/full-layout restoration, compact action access, same-origin settings without filesystem paths, and development/packaged private config resolution. Headless Chrome confirmed all actions reachable with long captions at 320x120, 200x520, and 360x520. Commit preparation reran `npm.cmd test` (198/198), `npm.cmd run build` (57 modules), and `git diff --check`, all passing. Earlier changed JS/CJS and popup-script parsing checks also passed. `config/selfieModeration.json` and `server/personality.js` are untouched.
- UNKNOWN: live AI/ComfyUI generation, browser/Electron flows, capture behavior, and installer validation.

## Decisions
- Shared provider configuration contains templates only; all slots start unassigned.
- Existing provider selections remain in the ignored machine override. STT's prior `whisper-large-v3` selection is preserved.
- Selfies: default `auto`, external ComfyUI at `http://127.0.0.1:8188` first, managed ComfyUI second, sd.cpp third; explicit modes do not fall back. Managed installation paths must be configured. Default preset `cepat` (768 px, 12 steps, cfg 3); workflow model `qwen-image-2.1-UC-Q5_K_M.gguf`.
- sd.cpp: GPU required by default; CPU and insufficient-memory overrides are explicit. `hemat` starts with empty preset args/modelArgs; telemetry is enabled, and optional tuning flags must be verified against the installed binary's help.
- AI keys/provider access stay backend-only; image generation uses ImageProvider; selfie tuning lives in `selfie.config.json`.
- Speech: speech_start -> tagged audio -> speech_end (ok:false on failure); amika_replied logs only; playback acknowledgment gates subsequent speech even after partial failure. State and cancellable turn ownership are per socket; expired turnId events are ignored. stop_speech cancels playback on timeout; input_rejected restores the client's authoritative state.
- Backend binds to `127.0.0.1`; selfie images use tokenized `/api/selfies/:token` URLs. Forwarded headers are trusted only from a loopback peer. Mobile/LAN chat and vision access still use Vite `/api` and `/ws`; the local monitor bridge connects over loopback. No current feature requires a direct LAN backend listener. Opting into selfie LAN access retains the localhost/127.0.0.1 Host allowlist.
- Electron uses context isolation, sandboxing, disabled Node integration, narrow preload IPC, and overlay capture protection.
- Continuous capture requires a connected Vision Monitor dashboard; available webcam monitoring is automatic, and screen capture also requires screen sharing or the Electron tray toggle. Quiet conversation is enabled with a 60-second delay. Selfie generation runs independently of conversation turns.

## Next
Complete the manual browser/Electron capture, speech-playback and speaker-echo
checks in the operator guide. Native image quality and installer verification
still require the configured local hardware and assets.
