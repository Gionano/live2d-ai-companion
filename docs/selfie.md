# Selfie module (pap)

The avatar takes a photo on request. The configured LLM plans the scene; a local
image provider or Cloudflare Workers AI generates it. API keys and provider access
stay in the backend.

See [Local setup](setup.md) for the ignored `local/` layout, verified download manifest,
dry-run setup commands, license consent, offline doctor, and reuse of existing models.

## 1. Export the workflow
1. Open the selfie workflow in ComfyUI.
2. Select **Workflow > Export (API)**.
3. Save it as `workflows/selfie.api.json`.

## 2. Configure `selfie.mapping.json`
Map each role to a node using its `_meta.title` (prefix matching supports truncated titles),
with `classType` as a fallback, and name its input fields:

| Role | Node | Fields |
|---|---|---|
| `prompt` | PROMPT + Referensi (Qwen Image 2.1) | `prompt`, `negative_prompt`, `resolution` |
| `reference` | LoadImage "GAMBAR REFERENSI" | `image` |
| `sampler` | KSampler | `seed`, `steps`, `cfg` |
| `save` | SaveImage "Simpan Gambar" | `filename_prefix` |

Preparation logs detected nodes and fields. Mapping errors identify the missing or ambiguous role.

## 3. Reference images
`assets/references/default.jpg` is included in Git and selected by the shared
`defaultReference` setting, so fresh clones have a character reference ready to use.
Put custom PNG/JPG/WebP images in `assets/references/`; filenames form the shared whitelist.
Set `defaultReference` in `selfie.config.local.json` to choose a custom filename.
ComfyUI uploads the selected reference when needed; sd.cpp receives its local file path
directly. Custom references are excluded from Git.

## 4. Configuration
Tuning lives in `selfie.config.json`; ignored `selfie.config.local.json` deep-merges over it
for machine settings. Saved **Foto / PAP** settings override these files, and explicit
CLI overrides take precedence. `${LOCAL}` expands to
`WAIFU_LOCAL_DIR` or `<repo>/local`. Output defaults to `local/outputs`, logs to `local/logs`.
Shared settings include provider order, availability cache, timeouts,
presets, output folder, cooldown, and daily quota. ComfyUI Desktop commonly uses
`http://127.0.0.1:8000`; standalone ComfyUI commonly uses `http://127.0.0.1:8188`.

## 5. Test
```
npm run selfie:test -- --provider=auto --preset=cepat
```
Use `auto`, `comfyui`, `comfyui-managed`, `sdcpp`, or `cloud`. The command prints provider reasons,
readiness time, the provider used, generation timings, seed, and output file. Managed runs also
print the profile, cold-start time separately from generation, and available memory peaks.
Successful timings update ETA history.

## Provider availability (Phase E1)

`provider: "auto"` selects the first ready provider in
`autoOrder: ["comfyui", "comfyui-managed", "sdcpp"]`.
Explicit `comfyui`, `comfyui-managed`, `sdcpp`, or `cloud` checks only that provider. Cloud selection does not initialize local engines. Readiness is checked at backend startup,
before requests/jobs, and after changes to either selfie config file. `availabilityCacheMs` defaults to
30000; config changes invalidate the cache. No provider or model is downloaded automatically.
Provider settings and presets reload while the backend runs. Changes to `outputDir` and
`limitsStoreFile` require a backend restart so existing image tokens and quota persistence remain valid.

### Guided setup and Cloudflare

Open **Foto / PAP** in host settings or its first-run wizard step to save a provider.
The selection persists across refreshes. Local setup first shows missing components,
sizes, licenses, and blockers; **Unduh & siapkan** is the explicit download action.
CLI installations and shared models are reused. Installation status survives page
refresh, cancellation retains resumable downloads, and interrupted work requires
an explicit retry after backend restart. See [Settings GUI](settings-gui.md#foto--pap).

Cloud generation uses the user's own Cloudflare account and token with
`@cf/black-forest-labs/flux-2-klein-9b`. The backend resizes one whitelisted reference
to at most 480 pixels, strips metadata, and sends it alongside an identity-preserving
scene prompt. The original reference is not changed. Output is one 1024×1024 image;
the model uses four fixed steps and ignores local negative-prompt, CFG, and step
settings. Captions, Fish Audio, popup/gallery, and PAP quotas use the existing flow.

For dashboard locations, token creation, required **Workers AI Read/Edit** permissions,
and the app's save/check sequence, follow
[Cloudflare Account ID and API token](settings-gui.md#cloudflare-account-id-and-api-token).

Cloudflare credentials never appear in public settings, exports, or browser storage.
The settings connection check performs no generation. Charges and free allocation
depend on the user's account; see [Cloudflare pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
Cancelling stops local waiting and discards late results, but remote work may still
complete. An uncertain submitted request is never automatically retried or failed
over, avoiding duplicate generation and charges.

ComfyUI checks `/system_stats` and `/object_info` with `healthTimeoutMs` (1500 by default).
Every workflow node and its configured UNet/VAE/CLIP/reference filename must be listed by ComfyUI.
When `defaultReference` names a whitelisted local file, readiness uploads it if necessary and
validates that reference in memory before generation. Without a configured default, the reference
named by the exported workflow must already exist in ComfyUI's input list. Errors name missing
nodes and file assignments exactly.

sd.cpp checks a configured `binaryPath`, non-empty `diffusionModel`, `vae`, and `llm` files,
and optional `llmVision` (null when unused). It caches `sd-cli --help` and probes `--list-devices`,
with 5000 ms default timeouts. Readiness requires a CUDA or Vulkan device without loading models.
Paths may be absolute or use `${LOCAL}`. Relative model paths normally resolve beneath
`local/models/<kind>`; explicit `userDataDir` retains legacy `userData/models/sdcpp` resolution.
An existing `local/runtime/sd-cli` supplies the binary before any configured legacy path.

Each sd.cpp job spawns one hidden process with array arguments and the binary directory as cwd.
It uses `--diffusion-model`, `--vae`, `--llm`, optional `--llm_vision`, `-r`, `-p`, `-n`,
`--steps`, `--cfg-scale`, `-W`, `-H`, `-s`, and `-o`. Sampling/offload options come from
`sdcpp.args`; optional preset arguments append to the base. A prompt beginning with `-` receives a leading
space so it remains a value. Stdout/stderr progress updates fall back to indeterminate progress;
`jobTimeoutMs` covers preparation and generation. Windows cancellation uses `taskkill /T /F`.
Failed/cancelled partial files are deleted; successful output requires a non-empty PNG signature
before it is renamed into `outputDir`. Failure messages retain `sdcpp.stderrTailBytes` (8192 by default).
Process exit releases sd.cpp VRAM; there is no persistent sd.cpp server.

`cepat`, `kualitas`, and `hemat` specify `resolution` (a multiple of 32), `steps`, and `cfg`.
Optional overrides use this shape:

```json
{
  "cepat": {
    "resolution": 768,
    "steps": 12,
    "cfg": 3,
    "providers": { "sdcpp": { "resolution": 512, "steps": 8, "cfg": 3 } }
  }
}
```

Automatic failover is allowed only after a confirmed health/preparation/submission failure before
generation starts. Accepted submissions, unknown/lost submission responses, and generation failures
fail the current job and invalidate readiness for the next request. `selfie_started` includes
`provider`; preparing/queued snapshots use `provider: null` until the actual start. Quota is consumed
once at provider start. Cancellation waits for preparation cleanup before the next queued job starts.

The existing `selfie_feature` WebSocket event carries `status: { active, reasons }`, with reasons
for `comfyui`, `comfyui-managed`, and `sdcpp`, plus `status.comfyuiManaged` profile/running state
at connection, on feature acknowledgments, and on availability changes. Availability broadcasts
omit the per-socket `enabled` toggle. `active: null` disables generation; the avatar replies in
Indonesian that it cannot take photos, and logs include the provider reasons.
Client reasons use codes, missing node names, and file basenames. Full filesystem paths and native
error details remain in backend logs and the test CLI.

## Managed local ComfyUI

`comfyui-managed` starts the user's existing local ComfyUI installation headlessly when a job
needs it. An existing `local/runtime/comfyui` supplies the portable's interpreter/script.
Otherwise fill in all three paths in `selfie.config.local.json`; they are empty below because standalone
and Desktop installations have different layouts. `installDir` is the ComfyUI repository root
used as the child working directory, `pythonPath` is the executable, and `mainScript` is its
entry script. Absolute paths are retained; a relative `installDir` resolves from this app's
repository root, while relative Python/script paths resolve from `installDir`. Readiness names
exactly which configured path is missing. Normal startup does not download files. Explicit setup
with verified metadata and license consent is documented in [Local setup](setup.md).

Example configuration; **verify each profile flag with `<python> <main> --help`**:

```json
{
  "provider": "comfyui-managed",
  "comfyuiManaged": {
    "installDir": "",
    "pythonPath": "",
    "mainScript": "",
    "host": "127.0.0.1",
    "port": "auto",
    "args": [],
    "env": {},
    "startTimeoutMs": 120000,
    "idleStopSeconds": 90,
    "healthPath": "/system_stats",
    "profiles": {
      "default": { "args": [] },
      "lowvram": { "args": ["--lowvram"] },
      "reserve-vram": { "args": ["--reserve-vram", "1"] }
    },
    "profile": "default"
  }
}
```

Readiness runs the configured Python and main script with `--help` once, with a 15-second
timeout and cached output. Configured flags missing from that output, together with their
values, are skipped with warnings. These example profiles are version-dependent; **verify
with `--help`** before tuning them. Core launch arguments include `--listen`, the selected
`--port`, and `--disable-auto-launch`. Arguments are an array, with no shell, hidden Windows
windows, and the configured working directory, so paths containing spaces are supported.

The app binds an ephemeral local port to select an available port. Binding failures, including
Windows excluded-port-range `EACCES` and occupied-port `EADDRINUSE`, cause another selection.
It waits for `healthPath` within `startTimeoutMs`, then checks `/object_info` against every
workflow `class_type` and every model filename configured in loader inputs. Missing custom
nodes and model filenames are named in the not-ready reason. Stdout/stderr tails remain in
backend diagnostics for startup failures.

Workflow preparation, `_meta.title` mapping, reference upload, random seeds, progress,
cancellation, and `/free` reuse the existing ComfyUI provider through composition. An owned
running child is reused. A new job cancels its idle timer; after each job, `release()` posts
`/free` and arms `idleStopSeconds`. When the timer expires with no job, or the backend shuts
down, the app stops its child. Windows shutdown attempts graceful exit, then uses
`taskkill /T /F` for the process tree. The owned PID is recorded; the next backend startup
checks a stale record's process name before cleaning it up. An unrelated ComfyUI process is
never stopped or reused by this provider. Use `comfyui` for an externally running server.

```text
npm run selfie:test -- --provider=comfyui-managed --preset=cepat --profile lowvram
npm run selfie:test -- --provider=comfyui-managed --preset=hemat --profile=reserve-vram
```

`--profile` selects a configured managed profile for one run in memory. The CLI releases and
shuts down its provider before exiting, including on failure or cancellation. Managed telemetry
uses the existing memory sampler: VRAM, Windows shared GPU memory, the child's private bytes
and working set, and system commit. Missing measurements remain unavailable. Cold start is
reported as `coldStartMs`, separately from `generateMs`; warm reuse reports zero cold-start
time. Backend generation and CLI attempts append provider/profile and timings with available
peaks to `docs/selfie-runs.md`.

## sd.cpp hardening (Phase E1.5)

For Windows CUDA, extract the `sd-...-cuda12.zip` package and
`cudart-sd-bin-win-cu12-x64.zip` from the **same release into the same folder**.
`sd-cli.exe`, `stable-diffusion.dll`, `ggml-cuda.dll`, and the CUDA runtime DLLs must match.
Do not leave the cudart archive compressed. Set the local paths in `selfie.config.json`, then verify:

```powershell
& 'C:/Path/To/sd-cli.exe' --help
& 'C:/Path/To/sd-cli.exe' --list-devices
```

An available CUDA/Vulkan device is required by default. `NO_GPU_BACKEND` explains common causes:
a CPU-only build, missing backend/runtime DLLs, mismatched releases, or an old driver.
`CUDA_RUNTIME_MISSING` specifically means `ggml-cuda.dll` exists but cudart/cublas runtime DLLs
are absent beside the executable and on PATH. `sdcpp.allowCpu: true` permits CPU execution for
controlled testing. Runtime CPU fallback stops the process tree with `NO_GPU_BACKEND`; ordinary
VAE/encoder offload messages are allowed.

In NVIDIA Control Panel, use the program settings for `sd-cli.exe` and set
**CUDA - Sysmem Fallback Policy** to **Prefer No Sysmem Fallback** when diagnosing VRAM spill.
This makes memory pressure easier to identify during manual tuning.

`sdcpp.args` is a string array. `sdcpp.modelArgs` is a string array of `key=value` entries,
joined into one `--model-args` value. Preset `sdcpp.args`/`modelArgs` append to those base arrays.
An explicit `sdcpp.offloadToCpu: true` adds `--offload-to-cpu`; `false` removes it from the
base arguments. A preset can enable offload by appending the flag. When the config key is absent,
the base args determine its value. The memory estimate uses the supported flag in the final argv.
Required input/output flags must exist in the cached help. Unsupported configured optional flags
and their values are skipped with a logged warning. Model argument keys are logged without
semantic validation.

Example tuning options below must be **verified with your binary's `--help`**:

```json
{
  "sdcpp": {
    "offloadToCpu": true,
    "args": ["--sampling-method", "euler"],
    "modelArgs": []
  },
  "presets": {
    "hemat": {
      "resolution": 768,
      "steps": 12,
      "cfg": 3,
      "sdcpp": {
        "args": ["--diffusion-fa", "--vae-tiling"],
        "modelArgs": ["qwen_image_2_1_prefix_cache=false"]
      }
    }
  }
}
```

The shipped `hemat` profile uses 768 px, 12 steps, cfg 3, and empty preset additions; it inherits
the base options. Tune it after manual comparisons rather than assuming those dimensions alone
save memory. Compare output and measured peaks when changing one option at a time.

Each job runs a **heuristic** memory preflight using the effective CPU offload setting, model
file sizes, available physical RAM, free VRAM, and Windows commit headroom. Available RAM includes
reclaimable standby cache; Windows memory counters provide available and strictly free RAM,
and the log prints both. Missing probes degrade gracefully. File sizes do not predict exact
runtime allocation, and passing preflight does not guarantee that a model fits.

Let `sum` be the combined size of distinct configured model files, and `largest` their largest
single component. The estimates retain the configured minimum floors:

| Effective mode | RAM requirement | VRAM requirement | Commit requirement |
| --- | --- | --- | --- |
| CPU offload on | `max(minFreeRamGB, sum)` | `max(minFreeVramGB, largest + computeBufferGB)` | `max(commitHeadroomGB, sum + marginGB)` |
| CPU offload off | `minFreeRamGB` staging floor | `max(minFreeVramGB, sum)` | `max(commitHeadroomGB, sum + marginGB)` |
| CPU backend | `max(minFreeRamGB, sum)` | No GPU check | `max(commitHeadroomGB, sum + marginGB)` |

Defaults in `sdcpp.memory` are `minFreeRamGB: 4`, `minFreeVramGB: 1`, `commitHeadroomGB: 8`,
`computeBufferGB: 2.5`, `marginGB: 2`, and `hardFailRatio: 0.6`. Commit is checked on Windows.
Windows commit headroom uses memory counters (`CommitLimit - CommittedBytes`), with OS virtual-memory
values as a fallback when counters are unavailable.
Each check reports the available amount, requirement, ratio, and tier; the diagnostic names
all missed requirements and those that caused a hard refusal.

| Tier | Result |
| --- | --- |
| `insufficient` | A known resource is below `hardFailRatio * requirement`; refuse with `MEMORY_INSUFFICIENT` before generation/quota. |
| `tight` | A resource meets the hard threshold but is below its requirement, or a probe is unavailable; run with a warning. |
| `ok` | Every applicable requirement is met. |

Equality at the hard threshold is `tight`; equality at the requirement is `ok`.
`sdcpp.forceRun` still overrides memory refusal while retaining the reported tier.

Argument sanity checks run before the generation process is spawned. `LLM_VISION_MISSING`
means a reference (`-r`) was supplied with a GGUF `--llm` without `--llm_vision`: configure
`sdcpp.llmVision` with the matching **Qwen3-VL mmproj file**. The check does not require mmproj
for a safetensors LLM. `OFFLOAD_OFF_LOW_VRAM` warns when offload is off and the estimated VRAM
requirement exceeds free VRAM; that warning does not block generation. An independent hard
memory deficit can still refuse it.

`telemetry.enabled` defaults to true, with `intervalMs: 2000` and `probeTimeoutMs: 1500`.
Telemetry samples NVIDIA VRAM, the child process's private bytes/peak working set, and Windows
system commit. Missing NVIDIA/PowerShell probes yield unavailable values; sampling never delays
or fails a job and stops at process exit. Reported GB values use 1024-based units.
Successful, failed, and cancelled started jobs store available peaks under `_peaks.<preset>`
beside the existing duration arrays in `etaStoreFile`, bounded by `etaHistorySize`. ETA durations
remain success-only. Historical peaks are never attributed to a later job with missing samples.

The existing status event adds `status.sdcpp` with `ready`, `code`, `backend`, `deviceName`,
`memoryTier`, `memoryMessage`, and `lastPeaks`. Raw output and argv stay backend-only.
`logFile` defaults to `data/selfie.log`; it records the final argv array, initial device/backend
lines, heuristic checks, sanity warnings, and peaks. It also records the effective config used
to build argv: requested `offloadToCpu`, base `args`, `presetArgs`, and the actual
`effectiveOffloadToCpu`. The CLI prints these config values on successful and failed jobs,
along with readiness/device, memory tier, argv, timings, and peak VRAM/commit/working set:

```text
npm run selfie:test -- --provider=sdcpp --preset=hemat
```

### Quality experiments from the CLI

Overrides apply to one run in memory. They never write `selfie.config.json`; explicit steps,
CFG, and size also override the selected preset's provider-specific values.
Both `--option value` and `--option=value` forms work. Quote paths and labels containing spaces.

```text
npm run selfie:test -- --provider=sdcpp --preset=hemat --label "reference init 24 steps" --steps 24 --cfg 4.5 --size 768x1024 --strength 0.4 --init-image reference --seed 123 --arg=--diffusion-fa --arg=--batch-count=1 --drop-arg=--vae-tiling --model-arg=qwen_image_2_1_prefix_cache=false --reference "assets/references/character.png"
```

| Option | Behavior |
| --- | --- |
| `--profile NAME` | Selects `comfyuiManaged.profiles.NAME` for this run; an unknown name fails before provider creation. |
| `--steps N` | Positive integer sampling steps. |
| `--cfg X` | Positive finite CFG scale. |
| `--size WxH` | Width and height must be positive multiples of 32. sd.cpp supports rectangles; the current ComfyUI workflow exposes only square resolution and rejects rectangles before submission. |
| `--strength X` | sd.cpp image-to-image strength from 0 to 1, inclusive. |
| `--init-image PATH` | sd.cpp initial image, resolved from the CLI working directory. `reference` uses exactly the same file passed to `-r`. |
| `--seed N` | Nonnegative safe integer; `-1` requests native random seeding. Omission retains provider random seeds. |
| `--arg FLAG[=VALUE]` | Repeatable sd.cpp arguments appended after base/preset args; `=VALUE` becomes a separate argv value. Unsupported flags warn and skip. |
| `--drop-arg FLAG` | Repeatable; removes matching base/preset flags and their associated values before appending CLI args. Dropping `--offload-to-cpu` disables automatic reinsertion; it can still be explicitly added again with `--arg`. |
| `--model-arg key=value` | Repeatable; appends model entries to the comma-joined `--model-args` value. |
| `--label TEXT` | Experiment label recorded with the result. |
| `--reference PATH` | Uses that local image as the reference for this run, retaining the provider's file validation. |

The provider also accepts optional `sdcpp.initImage` / `sdcpp.strength` in config and
`presets.<name>.sdcpp`; preset values override base values. Config image paths resolve from the
repository root. These map to `-i` and `--strength` only when cached `sd-cli --help` lists each
flag; older binaries skip missing flags with `SDCPP_FLAG_UNSUPPORTED` warnings. The cached local
help in `sd-cli/sdcli-help.txt` lists `-i, --init-img <string>` and `--strength <float>`.

Every generation attempt, including an unavailable provider or failed generation, appends one
row to `docs/selfie-runs.md`. Existing bytes and rows are preserved; a schema change appends a
new table header. The table records the label, provider, managed profile,
effective size/steps/CFG/strength, extra/dropped/model args, seed, timings, peak VRAM/working
set/private bytes/system commit/shared GPU memory, output path, status, init image, and reference. Unsupported
init/strength flags and unavailable measurements appear as `-`. Durations use milliseconds;
memory uses 1024-based GB. Shared GPU telemetry uses Windows per-process counters and remains
unavailable when those counters are absent. Failure to append the row returns exit code 1.
Successful runs still update ETA history; started sd.cpp and managed ComfyUI failures retain
available telemetry.

Compare two local outputs without loading models, reading config, updating history, or appending
a run row:

```text
npm run selfie:test -- --compare "a.png" "b.png"
```

It prints each image's dimensions and exact file size in bytes using PNG/JPEG/WebP container
metadata. It performs no image analysis. Missing or unsupported files return exit code 1.

Automated tests inject sd-cli, nvidia-smi, PowerShell, OS memory, and timers. They perform no real
GPU generation. Live image output and memory tuning require separate manual validation.

Automated verification uses fake HTTP ComfyUI, spawned managed ComfyUI scripts, and Node sd-cli processes:

```
npm test
npm run build
```

Live local generation requires an installed compatible sd-cli/ComfyUI and model/reference files.
Cloud generation requires a configured Cloudflare account/token and a whitelisted reference instead.

# Selfie module — remaining phases
Rules: configured LLM for chat/planner; local or Cloudflare image providers use the ImageProvider interface; keys stay backend-only; preserve existing WS contracts except compatible selfie_* additions; tuning lives in selfie.config.json with local/UI overrides; update docs/STATUS.md with implementation evidence.

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

### Cancellation and reconnect behavior

Cancel delivery acknowledges the request, not completion. The browser keeps the job visible as
`Membatalkan...` until `selfie_cancelled` or `selfie_failed` arrives. If generation finishes first,
`selfie_ready` still displays the image; a late cancellation acknowledgment cannot dismiss it.
Escape closes the browser dialog in every state and restores focus to the previous control.

`selfie_snapshot` is authoritative: `{ activeJobId: string | null, events: [...] }` carries the
active job's started/latest-progress events or ready result. Clients reset stale state and timers
before replaying these events. Completed results have `activeJobId: null` and one ready event;
an empty event list hides an existing dialog without creating a new one.
Ready results use `autoCloseSeconds` from the backend, defaulting to 30; zero keeps the result open.

Placement retries a compact card when normal candidates overlap the avatar. If every compact
candidate still overlaps, it uses the smallest intersection and logs a warning. Display changes
retry the requested size, including after zoom/shrink. Every resize publishes the actual layout.
Result cards scroll whenever content overflows; captions wrap and action rows remain reachable.
Gallery actions read local configuration in the desktop main process and open only an existing
configured directory; files, missing paths, traversal, and symlink/junction escapes are rejected.
See [Desktop selfie packaging](desktopSelfiePackaging.md) for installed gallery configuration.
HTTP `/api/selfies/settings` exposes only server capability (`enabled`) and `autoCloseSeconds`.
It requires matching Origin or same-origin/none Fetch-Site metadata, retains the localhost Host and
loopback-only checks, and sends no-store responses without CORS headers.
