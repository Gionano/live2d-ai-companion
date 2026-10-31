# Providers (P1 + P1.5)

The backend selects file-configured providers for chat, vision, speech recognition
and speech synthesis. P1 has no settings GUI or credential store. Image generation
continues to use the existing `server/selfie/imageProvider.js` and selfie gating.

## Call-site audit

All AI requests now go through `server/providers/registry.js`. Locations below are
the migrated call sites; the original SDK clients were `experientialClient.js`
(OpenAI SDK), `nineInferenceClient.js` (OpenAI SDK), and `groqClient.js` (Groq SDK).
Those wrappers, their unused `modelConfig.js`, and the two SDK dependencies were
removed. No runtime call sites remain on a legacy client.

| Flow | Call site | Slot and preserved behavior |
| --- | --- | --- |
| Streaming chat | `server/llmChat.js:194` | `llm`; structured emotion/text JSON, reasoning controlled by configured slot options |
| Emotion parser / sentences | `server/llmChat.js:73`, `:223` | Existing parser and sentence splitter retained |
| Selfie scene planner | `server/selfie/planner.js:178` | `planner`; whitelist, moderation, timeout and default-slot fallback retained |
| Memory extraction | `server/memoryManager.js:246` | `llm`; JSON, temperature 0.1, 250-token limit |
| One-shot vision | `server/visionCapture.js:27` | `vision`; canonical image part, existing Indonesian prompts |
| Continuous vision | `server/streamingVisionManager.js:215` | `vision`; existing monitor tuning and token/cost estimates |
| Monitor filter | `server/streamingVisionManager.js:355` | `visionFilter`; existing SKIP/COMMENT parsing |
| Speech recognition | `server/sttTranscribe.js:18` | `stt`; optional verbose metadata normalized before filtering at `:22` |
| Speech synthesis | `server/ttsGenerate.js:16` | `tts`; same Buffer chunks to the speech controller |
| Warm-up / keep-alive | `server/modelWarmup.js:38` | Optional `visionFilter.warmup()`, same idle schedule |
| HTTP and WS entry points | `server/index.js:172`, `:611`, `:740`, `:799` | Registry-backed vision, STT and chat; request/turn signals propagate |
| Timing diagnostics | `server/index.js:784`, `:808`, `:814` | Existing TTFT, first-sentence and TTS-first-chunk labels retained |

The monitor dashboard/bridge does not call AI services itself. CLI timing/history
probes still use the migrated chat, speech and warm-up functions.

## Configuration and defaults

`providers.config.json` contains three neutral templates: `openai-compatible`,
`anthropic-native`, and `fish-audio`. Their `baseUrl` and `model` fields are
`REPLACE_WITH_...` placeholders. Every slot (`llm`, `planner`, `vision`,
`visionFilter`, `stt`, `tts`) is explicitly **unassigned** (`null`). Installing
dependencies or setting old provider environment variables never assigns a slot.
The template's `model` field is a setup reminder; the actual model belongs in
`slots.<slot>.model`. A placeholder model cannot be used for a request.

The public file deep-merges with ignored
`providers.config.local.json`: objects merge recursively; arrays, scalars and null
replace. `${LOCAL}` expands through the existing local-path helper. Restart the
backend after edits, or call the backend-only registry `reload()` hook. Reload
invalidates lazy instances for subsequent calls; active requests retain their
original provider and cancellation signal.

P1.5 copied this installation's resolved selection into
`providers.config.local.json` before replacing the public file. Temporary-file
checks confirmed all existing profiles, models, parameters and timeouts survive
unchanged; only unused templates were added. The local snapshot contains key
environment names, not resolved key values, and stays ignored by Git.

Existing key variable names remain usable when explicitly named by a local
profile. Generic `baseUrlEnv`/`baseUrlEnvSuffix` and `modelEnv` seeding remains
available only on profiles/slots explicitly present in the shared configuration;
there are no such mappings in the shipped templates. Environment seeding happens
before local overrides, so a saved local value wins. Endpoint/model environment
variables alone cannot restore the former personal defaults. No key values belong
in shared JSON or `.env.example`.

STT provenance: `whisper-large-v3` was the executable default before P1, including
the initial STT commit `c3e8671`. P1 preserved it and P1.5 preserves the local
selection. The old `whisper-large-v3-turbo` header comment was already stale in
that initial commit. There is now no public STT selection.

The schema is `{profiles: {id: profile}, slots: {slot: settings}}`:

- A profile has `adapter`, optional `baseUrl`, `apiKeyEnv`, `extraHeaders`, `flags`,
  `capabilities`, `bodyExtras`, `omitParams`, and per-model `models` overrides.
  Omit `apiKeyEnv` for an unauthenticated local service. The P1 SecretResolver reads
  the named environment variable; it never exposes the key in status or errors.
- Slot settings have `profile`, `model`, `params`, and `timeouts`. Params include
  `temperature`, `maxTokens`, `json`, optional `bodyExtras`/`omitParams`, STT
  `language`/`prompt`, and TTS `voice`/`format`. Explicit call parameters take
  precedence, such as the existing monitor tuning and memory extraction limits.
- Timeouts are `firstByteMs`, `idleMs`, and `totalMs`. Zero disables a deadline.
  The first-byte deadline waits for response data; idle resets on received bytes;
  total spans all attempts and backoff. Defaults are explicit per slot.
- Omitted `planner` and `visionFilter` resolve to `llm` when constructing a config
  directly. Shipped null values survive a local deep merge, so assign those roles
  explicitly in the local file when needed. Null does not inherit.
- `getSlotStatus(slot)` returns `{available, reason, profile, model, adapter,
  insecureTransport, warnings}`.
  It checks configuration/capabilities/credentials without making a network call.
  Unknown profiles/adapters, missing key environments and incompatible models
  produce actionable reasons. Availability is not a remote health check.

Example machine override for a local text model (replace the model value with the
name served by your endpoint):

```json
{
  "profiles": {
    "localText": {
      "adapter": "openaiCompatible",
      "baseUrl": "http://127.0.0.1:1234/v1",
      "flags": { "supportsJsonMode": false, "supportsStreamUsage": false }
    }
  },
  "slots": {
    "llm": { "profile": "localText", "model": "YOUR_MODEL", "params": { "bodyExtras": null } },
    "planner": null,
    "vision": null
  }
}
```

Unconfigured chat and requested STT/vision features return Indonesian setup hints.
Slot status names `providers.config.local.json` and the missing profile/model.
TTS degrades to text replies through the existing speech controller;
continuous vision/filter calls are skipped. An unavailable planner retains the
existing deterministic slot fallback. Selfie image availability is still owned
by the selfie provider resolver.

## Endpoint and transport policy

`server/providers/baseUrl.js` exports the reusable `validateBaseUrl` and
`validateRequestUrl` helpers. HTTP adapters require an explicit HTTP(S) URL;
Fish requires WS(S). URLs cannot contain credentials, a query, a fragment,
whitespace, or backslashes. Validation returns a canonical URL and normalized
origin. There is no implicit Anthropic endpoint.

Public endpoints require HTTPS/WSS. HTTP/WS is allowed only for `localhost`,
loopback IPs, RFC1918 IPv4 addresses, or IPv6 unique-local addresses. Such slots
expose `insecureTransport: true` and a warning in status. Private DNS names are
not accepted for plaintext transport; use their private IP or TLS.
Link-local and known cloud-metadata addresses/hostnames are rejected even with
TLS, including alternative IPv4 spellings, mapped IPv6 forms, and the EC2 IPv6
metadata address. Validation is lexical; it does not resolve or pin DNS.

Every HTTP request passes through the resilience helper's `providerFetch`, which
validates the request against the configured origin and forces `redirect: 'error'`.
Fish explicitly disables WebSocket redirects. Both same-origin and cross-origin
redirects fail; authentication and custom key headers are never forwarded to a
redirect destination. Host-routing header overrides are rejected. The existing
safe provider errors omit response bodies and credentials.

## Contracts and adapters

`server/providers/contracts.js` defines the JSDoc boundaries:

- Messages have `role` and string content or parts: `{type:'text', text}` and
  `{type:'image', mime, base64}`. Vision uses the LLM interface with image parts.
- LLM `stream({messages, temperature?, maxTokens?, json?, signal?, timeouts?})`
  yields `text` deltas, optional `usage`, and `done`. `complete()` collects text
  and the latest cumulative token counts. `warmup()` is optional.
- STT `transcribe({audio: Buffer, mime, filename, language?, signal?})` returns
  text and optional segments/duration. Segment fields normalize to `noSpeechProb`,
  `avgLogprob`, and `compressionRatio`; absent fields stay absent. The existing
  average no-speech check runs only when every segment supplies its input. The
  phrase hallucination filter remains active without metadata.
- TTS `stream({text, emotion?, voice?, format?, signal?})` yields
  `{type:'audio', data: Buffer, format}`. Fish defaults to the dynamic voice ID in
  `voiceConfig.js`, MP3 and the existing emotion tags. MessagePack start, text,
  flush and stop frames preserve the previous protocol.

| Adapter | LLM | Images | Native JSON | STT | TTS |
| --- | --- | --- | --- | --- | --- |
| `openaiCompatible` | yes | profile flag | profile flag | profile flag | no |
| `anthropicNative` | yes | yes | prompt-only in P1 | no | no |
| `fishAudio` | no | no | no | no | yes |

OpenAI-compatible servers differ: use `supportsJsonMode`, `supportsStreamUsage`,
`supportsImages`, `supportsStt` and `supportsVerboseStt` flags to describe their
actual support. `bodyExtras` sends vendor options such as `reasoning_effort`;
`omitParams` removes rejected fields. JSON requests fall back to an instruction
when native JSON mode is disabled. Only content deltas become text; reasoning
and reasoning_content are ignored. Completions use streaming even when collected
by `complete()`. Non-streaming-only endpoints are not supported in P1.

Anthropic uses `/v1/messages`, top-level system text, base64 image source blocks,
`x-api-key`, and configurable `anthropicVersion` (default `2023-06-01`). A model
must be configured; none is hardcoded in the adapter. `max_tokens` uses the
request/slot value, then `defaultMaxTokens`, then 1024. Event names, text deltas,
cumulative usage and stop/error handling were checked against the official
[streaming documentation](https://platform.claude.com/docs/en/api/streaming) and
[Messages reference](https://platform.claude.com/docs/en/api/messages) on 2026-10-30.

ProviderError codes are AUTH, RATE_LIMIT, TIMEOUT, BAD_REQUEST, SERVER, NETWORK,
UNSUPPORTED, ABORTED and BAD_RESPONSE. Errors retain safe status/Retry-After
metadata and fixed messages; provider response bodies are never included.
Only RATE_LIMIT/SERVER/NETWORK may retry, at most twice, with exponential backoff
and jitter. Retry-After is a lower bound. Any yielded event, including usage,
disables replay. Caller abort and deadlines cancel fetch bodies or terminate the
Fish socket; consumer early return also closes the transport.

Adding an adapter requires one adapter file, registration in the registry and
capability table, and an entry in the shared contract suite. Use the shared
resilience/error helpers and canonical events. Do not add a second vendor
interface to business logic.

## Validation and manual probes

`npm test` runs the local HTTP/WS contract suite plus configuration, registry,
application and test-isolation regressions. `npm run check:privacy` and
`npm run build` are also required. The test runner uses a per-run temporary public
source snapshot, isolated local/home/user-data/config directories and synthetic
fixtures. It excludes `.env`, machine config, personal assets and installed model
runtimes, and clears provider credentials. A filesystem guard rejects access to
the original checkout or real home and writes to immutable snapshot source;
source/dependency reads needed to execute the tests remain allowed. The guard
checks Node filesystem APIs and is inherited by Node fixture subprocesses; it is
not an operating-system sandbox for arbitrary native commands. Selfie path
fixtures supply explicit temporary configuration instead of relying on machine
state. See `scripts/runTests.js` for the runner and isolation policy.
Memory storage accepts `WAIFU_DATA_DIR`; normal runs retain the existing `data/`
default while the runner uses a temporary directory.

Both `npm test` and `npm run check:privacy` support a Git checkout or extracted
source ZIP. Git must be installed. Checkouts include tracked and non-ignored
untracked files; ZIPs include files allowed by their `.gitignore` rules, including
nested rules and exceptions. ZIP enumeration uses temporary Git metadata outside
the source folder and never creates `.git` in the extraction. A ZIP nested inside
another checkout does not inherit the parent's index or ignore rules. Broken Git
metadata in an actual checkout still fails visibly.

Root `package.json` and `package-lock.json` no longer contain `openai` or
`groq-sdk`. All seven runtime and two development dependencies have active uses;
the direct-dependency audit found no unused packages.

P1.5 verification: baseline **632/637** passed; final **699/699** passed in both
the working checkout and a temporary Git clone with the uncommitted public patch
applied and private files absent. `npm ci` succeeded in that clone. Build and
privacy checks pass. Live provider probes remain separate from these offline tests.

Manual probes make real calls and may consume provider quota:

```text
npm run providers:test -- --slot llm
npm run providers:test -- --slot vision --profile PROFILE_ID --model MODEL_NAME
npm run providers:test
```

`testSlot(slot, {profile?, model?})` is shared by the CLI and future UI work. It
returns success, elapsed time, first text/audio timing, optional token counts,
safe errors and metadata. Overrides are ephemeral. A changed profile clears
inherited vendor body extras for the probe. Vision uses a generated 8x8 PNG;
STT uses a generated short WAV tone (endpoint validation, not speech accuracy);
TTS discards its first audio chunk and closes the socket. The CLI prints a table
and exits nonzero if any selected slot fails. Automated tests call the same
helper against local fixtures. Live providers and manual browser/Electron flows
remain unverified by P1's offline checks.
