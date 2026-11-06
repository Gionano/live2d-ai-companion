# Providers (P1–P3)

The backend selects providers for chat, vision, speech recognition and speech
synthesis through a shared registry. P2 adds a local settings store, credential
backends and a protected settings API; P3 adds the local settings GUI. See
[Settings](settings.md) for the schema, layering, secret storage and API. Image
generation continues to use `server/selfie/imageProvider.js` and selfie gating.

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

The default runtime registry layers the public file, ignored
`providers.config.local.json`, then `<local>/settings.json`. Objects merge
recursively; arrays, scalars and null replace. Only supported non-secret fields
enter runtime settings; API writes validate the strict [P2 schema](settings.md).
Settings API mutations reload the registry automatically. Restart after manual
file edits, or call the backend-only exported `reload()` hook. Subsequent calls
use new adapters; active calls retain their original provider, credentials and
cancellation signal. Settings do not accept local filesystem paths.

P1.5 copied this installation's resolved selection into
`providers.config.local.json` before replacing the public file. Temporary-file
checks confirmed all existing profiles, models, parameters and timeouts survive
unchanged; only unused templates were added. The local snapshot contains key
environment names, not resolved key values, and stays ignored by Git.

Existing key variable names remain usable when explicitly named by a profile's
`apiKeyEnv`; a nonempty environment key wins over the stored key. Runtime
environment overrides supply secrets only. Endpoint/model migration requires
`POST /api/settings/legacy/import`; it never copies environment keys. The
low-level P1 `loadProvidersConfig()` helper retains generic `baseUrlEnv`,
`baseUrlEnvSuffix`, `modelEnv` seeding and `${LOCAL}` expansion for explicit
backend callers/tests. The default runtime registry uses the P2 settings service
instead. No key values belong in shared JSON or `.env.example`.

STT provenance: `whisper-large-v3` was the executable default before P1, including
the initial STT commit `c3e8671`. P1 preserved it and P1.5 preserves the local
selection. The old `whisper-large-v3-turbo` header comment was already stale in
that initial commit. There is now no public STT selection.

The developer provider file is `{profiles: {id: profile}, slots: {slot: settings}}`;
the settings document adds schema/version and UI fields:

- A configured profile needs `adapter` and `baseUrl`; it can also set `apiKeyEnv`,
  `flags`, `capabilities`, `bodyExtras`, `omitParams` and safe per-model `models`
  options. Developer `extraHeaders` values become private credentials; the settings
  API accepts only `headerNames` plus separate write-only secret values. Per-model
  options cannot change the endpoint, adapter, headers or environment mapping.
  Omit `apiKeyEnv` for an unauthenticated local service. Credential resolution
  stays private and bound to the profile origin; see [Settings](settings.md).
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
- TTS `stream({text, emotion?, speechEmotion?, voice?, format?, signal?})` yields
  `{type:'audio', data: Buffer, format}`. Fish defaults to the dynamic voice ID in
  `voiceConfig.js`, MP3 and the expressive settings below. MessagePack start, text,
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

## TTS expressiveness

Inspection before this change (2026-11-06, original line numbers):
`server/providers/adapters/fishAudio.js:9–15` recognized only the English labels
happy/sad/excited/surprised/shy. It prepended one square-bracket tag per request;
`server/index.js:821–823` made a request for every completed chat sentence.
All twelve Indonesian reply emotions, including `netral`, therefore received no
tag. The final text for `netral` was the original sentence, unchanged. No text
normalizer, legacy-tag removal or inline cue sanitization existed.

`fishAudio.js:63–67` sent MessagePack start (empty text, selected reference ID,
format default MP3, hardcoded latency `low`), text, flush, stop. Temperature,
`top_p`, and prosody were omitted. The model came from the TTS slot
(`server/providers/registry.js:43`) and was sent in a WebSocket header
(`fishAudio.js:36`); this checkout's resolved TTS slot was unassigned during the
inspection, so no model was selected and no live call was made.
`server/llmChat.js:223–244` split on `. ! ? …` followed by whitespace or newline,
kept decimal dots, and waited when punctuation ended a streaming buffer.
The final remainder flushed at `:277–279`. No minimum existed: `Ya.` or even `!`
could become a request.

Configure the following fields under `slots.tts.params`, through the local
settings GUI/API or the ignored developer override. Existing slot assignments,
models and credentials are preserved. These are runtime defaults, rather than a
public provider selection:

```json
{
  "temperature": 0.8,
  "topP": 0.7,
  "latency": "balanced",
  "prosody": { "speed": 1, "volume": 0 },
  "expression": {
    "selection": "native",
    "emotionTagMap": {
      "terkejut": "[surprised]", "marah": "[angry]", "bingung": "[confused]",
      "jengkel": "[frustrated]", "malu": "[embarrassed]", "kesal": "[upset]",
      "sedih": "[sad]", "kagum": "[excited]", "sayang": "[empathetic]",
      "jahil": "[sarcastic]", "penasaran": "[curious]", "netral": "[calm] [warm]"
    },
    "tagPlacement": "every-sentence",
    "maxTagsPerSentence": 2,
    "mergeShortSentences": { "enabled": true, "minChars": 25, "maxChars": 180 }
  },
  "inlineTags": {
    "enabled": false,
    "allowList": ["laughs", "sigh", "pause", "whisper", "chuckle", "emphasis", "break"],
    "maxPerSentence": 2
  },
  "speechStyle": { "enabled": true },
  "debug": false
}
```

`balanced` intentionally replaces the former hardcoded `low` to give expressive
synthesis a less aggressive latency setting. `normal` and `low` remain available
for manual comparison; audible improvement and provider/model support require
live listening. Temperature accepts 0–2, topP is greater than 0 through 1,
speed is 0.5–2, and volume is -20–20 dB. The Fish start frame now receives
temperature, `top_p`, latency and prosody explicitly. Voice and model resolution
retain their existing precedence. MP3 is the default; WAV/Opus can be selected.
PCM is raw audio intended for manual trials with a suitable player, not the
browser's encoded-audio decoder.

The map uses the supplied Fish core emotions first. **Experimental:** `netral`
uses the core `[calm]` plus free-form `[warm]` to request gentle neutral warmth;
`[warm]` is not a documented core emotion and model support may vary. Replace it
with `[calm]` alone if needed. Map entries accept a bracket-tag string or an array
of bracket-tag strings; an empty array disables that emotion's prefix. Every
Basic/Advanced emotion name is accepted directly by TTS, including the CLI;
shy maps to embarrassed and neutral uses the same experimental mapping as netral.

The local GUI's Fish tag presets include **all 49 supplied emotions**, grouped
into **24 Basic Emotions** and **25 Advanced Emotions**, with Indonesian/English
labels and exact bracket tags. Open TTS settings, expand emotion controls and
the preset editor, then choose a first and optional second tag for each of the
twelve avatar emotions. Save the slot to apply changes. For example, sayang may
use `[compassionate]`, or kagum may use `[delighted] [excited]`.

Selectors and the advanced JSON editor stay synchronized. Selecting None can
disable an emotion prefix; custom/free-form tags such as experimental `[warm]`
remain editable, and changing one row preserves the other mappings. The shared
catalogue is `server/fishEmotionTags.js`; the avatar keeps its twelve emotion
labels. Native selection chooses one catalogue emotion per AI reply. The existing two-tag cap and display
stripping remain enforced. The settings schema also accepts all 49 catalogue
names as explicit map keys for manual/backend use.

To listen to one of the new presets with the configured slot:

```text
npm run tts:try -- --text "Aku teringat waktu itu..." --emotion nostalgic
npm run tts:try -- --text "Aku di sini, kok." --emotion compassionate
```

Short complete sentences wait for the next sentence until their combined spoken
text reaches minChars, would exceed maxChars, or the reply ends. One indivisible
sentence may exceed maxChars; words are never truncated. Disabling merging
restores immediate sentence requests. Each lexical sentence starts with its
own bracket tags even inside a merged request. `first-only` uses a cumulative
sentence index within each speech, reset for the next reply. Emotion prefixes
take priority over inline cues; their combined count never exceeds the configured
cap (0–2). Each encoded audio request has a separate playback boundary.

Before TTS, the normalizer removes emoji, markdown markers, URLs and control
characters, preserves link-label words and Indonesian spelling, keeps expressive
punctuation, and caps punctuation runs at three characters. Tags are separate
from displayed text. Unknown square-bracket content and recognized legacy
parenthesis emotion tags (including configured tags) are removed; ordinary
parenthetical prose remains. Inline cues are optional and default off. Enabled
cues must be in allowList and are relocated to the sentence start, with a maximum
of two per sentence. `(break)` becomes `[break]` only when explicitly allowed.
Streaming sanitization buffers split/nested tag delimiters before emitting chat
text; captions and log/lip-sync text never receive TTS tags.
Nested parentheses and Markdown labels use an explicit work stack and shared
delimiter positions. Deep text cannot exhaust the JavaScript call stack; words,
incomplete-delimiter buffering, label stripping and inline limits are preserved.

### Native Fish emotion selection

`slots.tts.params.expression.selection` defaults to `native`. Chat, spontaneous
vision comments and selfie captions choose one of the 49 catalogue emotions in
their existing LLM request. The avatar still receives its twelve Indonesian
emotion labels. For example, `emotion: "sayang"` controls the avatar while
`speechEmotion: "compassionate"` produces `[compassionate]` at sentence starts.
The translated TTS settings selector switches between automatic selection and
`mapped`, which uses the existing avatar emotion maps. In native mode those maps
are fallbacks; fixed system messages always retain their mappings.

`server/speechEmotionPrompt.js` appends the catalogue and metadata instructions
when TTS is available and native mode is selected. This works independently of
`speechStyle.enabled` and adds no generation call. Chat requests ordered JSON
`{"emotion":"sayang","speechEmotion":"compassionate","text":"Aku di sini."}`.
Vision comments and selfie plans add the same optional top-level field alongside
their existing fields. Selfie speech metadata never becomes an image slot or
changes the image whitelist, prompt builder, or moderation rules.

Only exact canonical catalogue names without brackets are accepted. Chat reads
top-level metadata from the header before `text`, then freezes the choice.
Missing, unknown, malformed or late metadata falls back to the avatar map without
waiting for more tokens. Nested members and metadata-looking quoted reply text
cannot change the choice. Each queued sentence snapshots the reply's choice;
cancellation and concurrent turns cannot carry it into another reply.

Speech playback accepts optional `speechEmotion` in `play()` and TTS requests.
`say(text, emotion, onChunk, {speechEmotion})` preserves the third callback
argument. Tag precedence is explicit manual `tag` (including an empty string to
disable prefixes), then a valid native choice, then the avatar map. Existing
every-sentence/first-only placement, cumulative indexes, short-sentence merging,
normalization, inline allow-lists and the combined two-tag cap remain enforced.
Displayed captions, chat, history and avatar events contain no performance tags
or native speech metadata. Opt-in TTS debug includes the validated speech emotion
alongside the avatar emotion; credential redaction and audio exclusion remain in
place. The persona and moderation configuration remain unchanged.

`server/speechStylePrompt.js` appends spoken-Indonesian writing instructions to
the chat system prompt only when TTS is available and speechStyle.enabled is true.
It asks for varied short sentences, natural interjections and expressive
punctuation, without emoji/markdown. Allowed inline cues are mentioned only when
enabled. The persona and moderation files are unchanged and hash-tested.

Set `TTS_DEBUG=1` (also accepts true/on) or `slots.tts.params.debug=true` to log
each request's final tagged text, emotion, sentence index, model and transmitted
parameters. Audio is never logged. Credential/header values and recognizable key
patterns are redacted. Debug is opt-in because it exposes spoken conversation
text to backend logs; ordinary displayed conversation text remains tag-free.

Manual trials use the configured TTS slot and may consume provider quota:

```text
npm run tts:try -- --text "Wah, aku senang! Kamu sudah kembali." --emotion kagum --variants
npm run tts:try -- --text "Halo, sayang!" --tag "[excited]" --temperature 0.8 --latency normal --top-p 0.7 --speed 1.05 --voice YOUR_REFERENCE_ID --out YOUR_OUTPUT_DIR
npm run tts:try -- --help
```

Every result is written to a unique audio file; default output is a new OS-temp
directory, and printed results contain paths, first-chunk timing and total time.
Variants are sequential: plain (all tags off), emotion tag, expressive punctuation,
temperature 0.8, latency normal, latency balanced. Omitted overrides use the saved
slot settings. Partial files are removed on failure/cancellation; saved settings
are not changed and underlying provider errors/secrets are not printed. Automated
tests use fake loopback Fish WebSocket servers and never invoke live synthesis.
Use the GUI to save controls and compare the generated files by listening; real
provider sound and browser/Electron rendering remain manual verification.

Offline verification for the initial expressiveness change: baseline 834/834, final 898/898 tests
(64 added, zero failures/skips), frontend build (72 modules), privacy (zero failing
files), syntax/whitespace, and CLI help all pass. The persona/moderation hash
regressions pass. No live synthesis, dependencies or commits were added.
The full catalogue extension passes **911/911** tests (13 more), build (73 modules),
privacy, syntax and whitespace. Fake Fish transport checks exercise all 49 names;
GUI regressions cover grouping, selection/save, custom tags and JSON synchronization.
Native selection passes **955/955** tests from the 911-test baseline (44 new,
zero failures/skips), build (73 modules), privacy and whitespace. Fake LLM/Fish,
vision/planner and playback tests cover all 49 choices, header freezing, mapped
fallbacks, cancellation, independent avatar cues and unchanged image/moderation
behavior. Protected-file hashes remain unchanged; no live calls, dependencies,
credential changes or commits were made.

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

`testSlot(slot, {profile?, model?})` is shared by the CLI and settings API. It
returns success, elapsed time, first text/audio timing, optional token counts,
safe errors and metadata. Overrides are ephemeral. A changed profile clears
inherited vendor body extras for the probe. Vision uses a generated 8x8 PNG;
STT uses a generated short WAV tone (endpoint validation, not speech accuracy);
TTS discards its first audio chunk and closes the socket. The CLI prints a table
and exits nonzero if any selected slot fails. Automated tests call the same
helper against local fixtures. Live providers and manual browser/Electron flows
remain unverified by P1's offline checks.
