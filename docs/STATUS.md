# Status

Evidence: Phase D implementation committed through `ecef631`; P1-P5 audit corrections are included in the follow-up commits. Phases E1 and E1.5, the memory/argument correction, CLI quality experiments, and managed ComfyUI below are implemented in the working tree without a commit. Verification uses code inspection and mocked selfie/provider, HTTP/WS, desktop IPC, speech, spawned local-provider processes, and memory/telemetry tests.

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
- Chat/planner/memory: Experiential Labs; EXPLABS_MODEL overrides default `deepseek-v4.1-flash-uncensored`; TTS: Fish Audio `s2.1-pro-free`; avatar: IceGirl.
- STT/vision: Groq `whisper-large-v3` / `qwen/qwen3.8-27b`; vision filter: 9inference `deepseek-v4.1-flash`.
- Selfies: default `auto`, external ComfyUI at `http://127.0.0.1:8188` first, managed ComfyUI second, sd.cpp third; explicit modes do not fall back. Managed installation paths must be configured. Default preset `cepat` (768 px, 12 steps, cfg 3); workflow model `qwen-image-2.1-UC-Q5_K_M.gguf`.
- sd.cpp: GPU required by default; CPU and insufficient-memory overrides are explicit. `hemat` starts with empty preset args/modelArgs; telemetry is enabled, and optional tuning flags must be verified against the installed binary's help.
- AI keys/provider access stay backend-only; image generation uses ImageProvider; selfie tuning lives in `selfie.config.json`.
- Speech: speech_start -> tagged audio -> speech_end (ok:false on failure); amika_replied logs only; playback acknowledgment gates subsequent speech even after partial failure. State and cancellable turn ownership are per socket; expired turnId events are ignored. stop_speech cancels playback on timeout; input_rejected restores the client's authoritative state.
- Backend binds to `127.0.0.1`; selfie images use tokenized `/api/selfies/:token` URLs. Forwarded headers are trusted only from a loopback peer. Mobile/LAN chat and vision access still use Vite `/api` and `/ws`; the local monitor bridge connects over loopback. No current feature requires a direct LAN backend listener. Opting into selfie LAN access retains the localhost/127.0.0.1 Host allowlist.
- Electron uses context isolation, sandboxing, disabled Node integration, narrow preload IPC, and overlay capture protection.
- Continuous capture requires active screen sharing and a connected monitor; selfie generation runs independently of conversation turns.

## Next
