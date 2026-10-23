Run the pap job
 ├─ provider = “auto”
 │   ├─ Is ComfyUI ready? (running + node available + model available) ── yes ──▶ use ComfyUI
 │   ├─ Is sd.cpp ready? (binary + model file available) ───────── yes ──▶ use sd.cpp
 │   └─ nothing is ready ──▶ feature disabled + clear message (+ “Get Ready” prompt)
 └─ provider = “comfyui” / “sdcpp” ──▶ that's it, no fallback

 # Selfie image provider: auto (ComfyUI -> sd.cpp) — Phase E1
Rules: do NOT touch config/selfieModeration.json or server/personality.js. Do NOT commit; list changed files. All existing tests must still pass (report count before/after). Add tests per item. No network downloads in this phase. Tuning constants in selfie.config.json. Stop after the phase.

1. Config: provider "auto" | "comfyui" | "sdcpp" (default "auto"); autoOrder ["comfyui","sdcpp"]; availabilityCacheMs 30000; healthTimeoutMs 1500; sdcpp { binaryPath, diffusionModel, vae, llm, llmVision|null, offloadToCpu: true, extraArgs: [] }. Paths: absolute, or relative to userData/models/sdcpp.
2. ImageProvider.checkReady() -> { ready, code, message }.
   - comfyui: GET /system_stats within healthTimeoutMs; then GET /object_info and verify every class_type in workflows/selfie.api.json exists and the loader inputs (unet/vae/clip/reference image) name model files ComfyUI actually lists. Reachable but missing nodes/models = NOT ready; message names exactly what is missing.
   - sdcpp: binary exists and runs (--help, 5s timeout); every configured model file exists and is non-empty. Do not load models.
3. resolveProvider(): explicit provider -> use only that (no fallback; not ready = feature disabled with reason). "auto": first ready in autoOrder; cache for availabilityCacheMs; re-check at startup, before each job (cache respected), and on config change. Publish status {active, reasons:{comfyui, sdcpp}} through the existing selfie settings/status event. None ready -> feature disabled; avatar says in character (Indonesian) it can't take photos now; log reasons. NEVER auto-download anything.
4. Failover only when failure happens BEFORE generation starts (health/preparation/submit rejected, connection refused). Never mid-generation: fail the job (selfie_failed) and re-resolve for the next job. Include the provider used in selfie_started and logs.
5. sdcpp provider (real): spawn sd-cli per job (no persistent server), args as an array (no shell string), windowsHide, cwd = binary dir. Args: --diffusion-model, --vae, --llm, optional --llm_vision, -r <reference>, -p, -n, --steps, --cfg-scale, --sampling-method euler, -W/-H, -s <seed>, --offload-to-cpu (config), -o <tmp.png>. Verify flag names against `sd-cli --help`; on mismatch fail with a clear message. Make sure prompt text starting with "-" cannot be parsed as a flag (test it). Parse progress from real stdout/stderr output; fall back to indeterminate progress. Timeout from config. Cancel: kill the whole process tree (Windows: taskkill /T /F) and delete partial output. On exit: validate output (exists, >0 bytes, PNG signature), move to outputDir. release() is a no-op (VRAM frees on process exit). Keep the stderr tail for failure messages.
6. Presets "cepat"/"kualitas" provider-agnostic (resolution multiple of 32, steps, cfg) with optional per-provider overrides; both providers apply them.
7. References: sdcpp uses the file path directly; ComfyUI keeps its upload flow; same whitelist.
8. npm run selfie:test --provider=auto|comfyui|sdcpp prints provider reasons and timings.
9. Tests with a fake ComfyUI server and a fake sd-cli (small Node script mimicking progress lines and writing a PNG): auto picks ComfyUI when ready; ComfyUI up but missing a node -> sdcpp; both down -> disabled; failover only before generation; cancel kills the child tree; invalid output rejected; prompt with quotes/&&/newlines/leading "-" is safe; paths with spaces ("All Projects"); cache expiry.
10. Update docs/selfie.md and docs/STATUS.md. Terse report. STOP.