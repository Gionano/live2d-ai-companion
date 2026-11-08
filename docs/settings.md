# Provider settings (P2–P3)

P2 adds a local settings store, credential storage and a protected backend API.
P3 adds the local [settings GUI and first-run wizard](settings-gui.md), models
suggestions, progress probes, stale-lock recovery and isolated storage diagnostics.
Image generation has separate [Foto / PAP settings](settings-gui.md);
selfie moderation and personality remain outside the provider schema.

## Layers and stored data

The default runtime registry reads these layers in order:

1. Committed `providers.config.json` templates.
2. Ignored `providers.config.local.json` developer overrides.
3. `<local>/settings.json` user choices written through the API.
4. Environment credentials referenced by `apiKeyEnv`, which override stored keys.

`<local>` uses the existing local-directory resolver: `local/` by default, or
`WAIFU_LOCAL_DIR`. Environment endpoint/model variables do not change runtime
choices. Their migration requires an explicit request, described below.
Objects merge recursively; arrays, scalars and null replace earlier values.
Profile deletion writes a null tombstone to prevent lower layers restoring it.
An explicit null slot is unassigned. Planner, visionFilter, surface and reflection can instead save
`{ "followLlm": true }` to track the current LLM assignment. Omitted advanced slots
also inherit the LLM; an explicit null does not. The GUI offers inheritance by
default when configuring chat. The initial UI language is `id`; before a language
is saved, the GUI detects English from `navigator.language`, otherwise Indonesian.

The persisted document is versioned:

```json
{
  "schemaVersion": 1,
  "version": 0,
  "profiles": {},
  "slots": {},
  "ui": { "language": "id" }
}
```

Only these fields are accepted:

| Object | Fields |
| --- | --- |
| Profile | Optional matching `id`; required `adapter`, `baseUrl`; optional `apiKeyEnv`, `flags`, `headerNames`, `capabilities`, `bodyExtras`, `omitParams`, `anthropicVersion`, `defaultMaxTokens`, `models` |
| Slot | `profile`, `model`, optional `params`, `timeouts`; null to unassign; or `{followLlm:true}` for planner/visionFilter/surface/reflection |
| Params | `temperature`, `maxTokens`, `json`, `language`, `prompt`, `voice`, `format`, `bodyExtras`, `omitParams` |
| Timeouts | `firstByteMs`, `idleMs`, `totalMs`, each 0–300000 ms; zero disables that deadline outside API probes |
| UI | `language`: `id` or `en` |

Profile IDs contain letters, digits, underscores or hyphens and are at most
64 characters. At most 32 profiles are stored. Slots are `llm`, `surface`,
`reflection`, `router`, `planner`, `vision`, `visionFilter`, `stt` and `tts`. Adapters are `openaiCompatible`,
`anthropicNative` and `fishAudio`. A slot's model is a nonempty string of at most
256 characters; template placeholders cannot be selected.

Surface provides the quick reaction; `llm` supplies the deeper continuation.
The dedicated `router` defaults to Groq `openai/gpt-oss-20b` and does not follow
Chat. It uses the existing slot settings/test/status interfaces and a hard
five-second routing deadline. Missing router fields use the default; explicit
assignments and null are preserved. Older imports restore the default Groq
router when omitted, except when its profile is explicitly deleted. See
[vision routing](vision-routing.md).
Reflection supplies private hints, plans and follow-up decisions. Both new slots
inherit `llm` unless explicitly assigned or disabled. Importing older settings
without these two slots retains that inheritance. See
[Conversation and idle behavior](conversation-behavior.md).

TTS `params.expression.sentencePauseMs` defaults to 200 and
`segmentPauseMs` to 150, with integer values from 0 to 400. At tone/stage
boundaries playback uses the greater pause instead of stacking them. Registers
and Fish speech tones are selected per sentence; the GUI preserves other saved
TTS parameters when editing timing.

Flags are `supportsImages`, `supportsStt`, `supportsVerboseStt`,
`supportsJsonMode` and `supportsStreamUsage`. Capability overrides are booleans
for `llm`, `images`, `jsonMode`, `stt` and `tts`. Per-model `models` entries allow
only `flags`, `capabilities`, non-secret `bodyExtras`, `omitParams`,
`anthropicVersion` and `defaultMaxTokens`. They cannot change the endpoint,
adapter, environment mapping or headers.

Unknown structural fields are rejected, including safety, moderation and persona
controls. `bodyExtras` is a bounded extension map of nested objects and primitive
values, with reserved conversation, tool and safety fields blocked. Credential
names/values in profile or slot extras are separated into secret storage before
the settings file is written. Imports and per-model extras reject credentials.
Local filesystem paths and recognizable credential strings cannot be ordinary
settings text. Known credential values duplicated into public fields are also
rejected or redacted. Header values belong only in the secret store; the settings
document contains normalized header names.

`GET /api/settings` returns `{version, settings, sources, secrets}`. `sources`
maps field paths to `default`, `dev-file`, `settings` or `env`, including private
credential fields by name only. `secrets` contains presence flags, with an API
key's last four characters only when its length is at least 20. Full keys, header
values and private extras never appear in effective settings, status, exports,
errors or WebSocket messages.

## Secret backends and origin binding

`SecretStore` provides `get`, `set`, `delete`, `has` and `backendName`. Environment
keys remain read-only and take precedence when the named variable is nonempty.
Developer-file header values and credential-like extras remain a lower-priority,
read-only credential source; new API writes do not edit that developer file.

| Selected backend | Behavior |
| --- | --- |
| `windows-dpapi` | Windows default. Encrypts the credential records with DPAPI `ProtectedData` in `CurrentUser` scope, storing ciphertext in `<local>/secrets.dat`. |
| `env` | Non-Windows default. User choices remain writable; attempts to persist credentials return `READ_ONLY`. |
| `plaintext-file` | Explicit opt-in only, using `WAIFU_ALLOW_PLAINTEXT_SECRETS=1` before backend startup. Stores plaintext in `secrets.dat` and always reports a status warning. |

DPAPI uses a hidden, noninteractive PowerShell child with a fixed script, bounded
input/output and a five-second timeout. Credential bytes travel over stdin/stdout,
never command arguments. The runner is injectable for tests. Decryption errors,
tampered records and backend-format mismatches fail closed; they never trigger a
plaintext fallback. Changing the opt-in does not migrate an existing secret file.

Credential records are bound to the profile's normalized URL origin, including
scheme, hostname and port. A path-only URL edit preserves the binding. Changing
the origin of a profile with credentials requires either replacement `secrets`
in the same profile request or `confirmDeleteSecrets: true`. The change detaches
the old environment mapping and inherited header names; old credentials cannot
follow automatically. Replacements at a new origin replace the stored bundle.
Writes at the same origin merge the supplied credential fields.

`DELETE /secrets/:id` removes only the stored bundle. Environment/developer
credentials can remain effective; remove the environment mapping or developer
source to stop using those read-only values. Profile deletion also removes its
stored bundle. It refuses an in-use profile unless `force: true`, which unassigns
every slot using it. Import cannot silently change an origin or remove a profile
with bound credentials: resolve that change with explicit profile/secret actions
first.

## API

All paths below have the `/api/settings` prefix. Send JSON with
`Content-Type: application/json`. Every persisted mutation includes the version
last read from the API; success returns `{version: nextVersion}`. Concurrent or
stale writes return HTTP 409 `CONFLICT`; reread before retrying.

| Method and path | Request / result |
| --- | --- |
| `GET /bootstrap` | Returns the backend-session token. |
| `GET /` | Effective settings, per-field sources and credential presence. |
| `GET /status` | Version, selected secret backend, all slot statuses, warnings and `firstRun`. No provider request. |
| `PUT /profiles/:id` | `{version, profile, secrets?, confirmDeleteSecrets?}`; requires adapter and URL, merges supported profile fields. |
| `DELETE /profiles/:id` | `{version, force?}`. |
| `PUT /slots/:slot` | `{version, slot}`; use null to unassign. |
| `PUT /ui` | `{version, ui:{language}}`. |
| `PUT /secrets/:id` | `{version, values:{apiKey?, headers?, bodyExtras?, slotBodyExtras?}}`; write-only. |
| `DELETE /secrets/:id` | `{version}`; deletes stored credentials. |
| `POST /test` | `{slot, profile?, model?, timeoutMs?}`; ephemeral overrides using shared `testSlot`, including inherited slots. |
| `POST /models` | `{profile, apiKey?, timeoutMs?}`; model names only, with a safe `reason` on failure. The optional one-time key is never saved. |
| `POST /diagnostics` | `{}`; isolated dummy secret self-test and local metadata, with redacted file locations. |
| `GET /images` | Cached local image-provider readiness and provider name, without paths or a generation request. |
| `POST /export` | `{}`; returns a portable schema document without version or secrets. |
| `POST /import` | `{version, settings:<exported document>}`. |
| `GET /legacy` | Existing known environment names and developer profile/slot names only. |
| `POST /legacy/import` | `{version}`; explicitly imports supported non-secret legacy choices. |

Obtain `/bootstrap` from the same browser origin and put its `token` in the
`X-Settings-Token` header for every non-GET/HEAD request. Secret paths require the
token even when the method is unsupported. Restarting the backend invalidates it.
The GUI keeps the token in memory only, never DOM, storage, URLs or cookies.
A same-origin browser fetch supplies
the required Origin/Fetch Metadata evidence; a direct local HTTP client must also
supply its exact Origin.

`status.firstRun` is true while no slot has a profile assignment. Slot availability
checks configuration/capabilities/credentials without contacting the provider.
Warnings identify missing slots, allowed plaintext transport, plaintext secret
storage, decryption failures and recovered settings. API errors have fixed
`{error:{code,message}}` bodies: 400 for invalid input, 403 for access denial,
409 for conflicts/origin changes/in-use profiles/read-only storage, 413 for size
limits, 429 for probe limits and 504 for a probe deadline.

For example, after reading version 0, create a local text profile with this
`PUT /profiles/localText` body:

```json
{
  "version": 0,
  "profile": {
    "adapter": "openaiCompatible",
    "baseUrl": "http://127.0.0.1:1234/v1",
    "flags": { "supportsJsonMode": false }
  }
}
```

Use the returned version for `PUT /slots/llm`:

```json
{
  "version": 1,
  "slot": {
    "profile": "localText",
    "model": "YOUR_MODEL",
    "timeouts": { "firstByteMs": 10000, "idleMs": 10000, "totalMs": 30000 }
  }
}
```

For a profile requiring a stored key, `PUT /secrets/localText` accepts
`{"version":2,"values":{"apiKey":"YOUR_KEY"}}` with the latest version. Extra
header values use `values.headers`, keyed by header name. These are placeholders;
the API returns only the new version after a successful credential write.

API probes and model discovery are explicit provider calls and can consume quota.
They share five attempts per rolling minute and one active operation with
diagnostics. `timeoutMs` defaults to 20000 and accepts integer values from 1000
through 60000. The probe applies that deadline to the requested slot even when it
inherits the LLM; profile/model overrides never change saved choices or the LLM.
Timeouts/disconnections cancel the probe. Only numeric timing/token counts,
success and fixed error metadata are returned; generated text/audio is discarded.
Probes cannot supply arbitrary prompts, endpoints or credentials.

With `Accept: application/x-ndjson`, `/test` streams `connecting`, `first_byte`
(when received), and `done` phases, then a final `result`. After streaming starts,
failures are reported inside that result; ordinary JSON failures retain their
HTTP status. Without that Accept header the response remains one JSON result.

`/models` uses the configured profile origin and refuses redirects. It accepts
stored credentials or a one-time key in the JSON body, never the URL. It limits
responses to 256 KiB, examines at most 1000 entries and returns at most 200 unique
names of 128 characters or fewer, filtering markup, paths and recognizable or
known secrets. Unsupported adapters, empty lists and provider errors return an
empty list with a reason code; manual model entry remains available.

Export omits invalid/unconfigured templates and includes no credential values or
local filesystem paths. Import strictly validates the portable schema, replaces
the saved selection and tombstones omitted profiles so lower layers cannot revive
them. Omitted slots become unassigned except surface/reflection, which inherit
the LLM for older exports. Matching-origin secrets stay in their
separate store; importing on another installation never imports keys.

Legacy migration is never automatic. It recognizes declared `baseUrlEnv`,
`baseUrlEnvSuffix` and `modelEnv` mappings, plus supported legacy endpoint/model
variables for existing profiles. Developer-file choices and existing settings win
over those environment hints. Environment credentials keep working in place and
are never copied into the secret file.

Every successful mutation reloads the registry for subsequent requests. In-flight
adapters retain their original provider and private credential resolver. The
existing companion WebSocket broadcasts only
`{type:'settings_changed', slots:[...]}`. Clients reread settings to obtain values.

## Access boundary and recovery

Every settings request requires a loopback peer and an allowed Host:
`localhost`, `127.0.0.1` or `[::1]`, with an optional valid port. Every supplied
forwarded address must also be loopback and every forwarded Host must pass the
same allowlist. Forwarded headers are considered only after checking the actual
socket peer. Vite/Electron append the actual incoming address and Host, preventing
a caller from hiding a remote address or foreign Host behind a forged first hop.
The last forwarded Host/protocol identifies the browser-facing origin.

Origin must exactly match that origin. If Origin is absent, only
`Sec-Fetch-Site: same-origin` qualifies; `none` alone is insufficient. Cross-site
and same-site metadata are refused even with a valid token. The access policy runs
before JSON parsing. All settings responses, including denials, malformed requests
and proxy errors, carry `Cache-Control: no-store` and no CORS headers. Mobile/LAN
clients cannot use this API, even when other app features permit LAN access.

Provider URLs retain the existing validation: TLS for public services, explicit
plaintext warnings for allowed loopback/private-IP services, no URL credentials,
query, fragment or metadata/link-local destination. HTTP and WebSocket adapters
refuse redirects. DNS is not resolved or pinned by this lexical validator.

Settings/API JSON is limited to 64 KiB; compressed request bodies are rejected.
Secret records are bounded separately. Persistence uses exclusive lock files and
temporary-file/fsync/rename writes. Missing settings use defaults. Corrupt or
oversized settings are renamed to `settings.json.corrupt-<uuid>.bak`, reset to
version 0, and reported in status. Backups stay private in the local directory.

Atomicity is per file. Runtime failures after a secret write attempt a rollback;
there is no transaction journal spanning settings and secrets. A process crash
between writes can leave different revisions. Origin mismatch prevents credential
use at a different destination; a same-origin replacement can leave the new key
with the previous choices. After an interrupted write, stop the backend, preserve
the local files and inspect them before recovery. A leftover `settings.json.lock`
or `secrets.dat.lock` is recovered automatically only when its recorded owner PID
is dead and its age exceeds `WAIFU_SETTINGS_LOCK_STALE_MS` (default 30000; valid
range 1000–86400000). Live/young locks return `LOCK_BUSY`. Unverifiable legacy or
malformed locks return `LOCK_UNKNOWN`; an active or abandoned recovery guard
returns `LOCK_RECOVERY`. These require waiting or inspecting the lock locally
after stopping all writers, never blind deletion. Future timestamps are not stale.

## Storage diagnostics

Run `npm run settings:doctor` (PowerShell: `npm.cmd run settings:doctor`), or use
the GUI Diagnostics tab. The CLI does not initialize the settings service, load
provider configuration or open the real secret store. It reads only non-secret
settings/lock/backup metadata; it never creates, repairs or writes the configured
local directory. Missing/corrupt settings remain untouched.

The self-test creates a separate OS temporary directory and uses a random dummy
key with the selected backend: write, reopen, compare, delete, reopen to verify
absence, then remove the scratch directory, including on failure. No real keys
are copied. The GUI calls this same server-side self-test with an empty body;
the dummy never enters the renderer. Cleanup failure reports `CLEANUP_REQUIRED`.
Environment-only storage reports `READ_ONLY` instead of pretending a write passed.

Reports include backend name, settings version (null if unreadable), directory
writability, permission/ACL notes, lock states and corrupt-backup count. The CLI
shows configured paths; the API substitutes `<local>/...`. Windows ACLs are not
audited. A successful temporary-store test does not prove the actual local
directory is writable; check the separate writability field.

This boundary addresses remote-browser CSRF, DNS rebinding and accidental API
disclosure. It does not protect against malicious code already running as the
same OS user, a compromised trusted frontend, local file tampering or an
authorized operator deliberately selecting an endpoint. Keep the local directory
private. DPAPI protects at-rest data for the Windows user; plaintext opt-in does
not. Non-Windows native keychains are not implemented. Verification uses injected
DPAPI runners and fake HTTP/WS providers; actual DPAPI and live providers have not
been exercised by the automated suite.

Run `npm test`, `npm run check:privacy` and `npm run build` for offline validation.
Live DPAPI, live providers, real Electron rendering and browser layout require
manual verification; mocked tests do not establish those results.
See [Providers](providers.md) for adapter contracts and transport behavior.

## Evidence-backed memory

The optional `memoryWriter` follows Chat; `memoryEmbedding` defaults to the
embeddings-only local BGE service. The `memory` configuration adds managed
startup and `auto|cpu|cuda` device selection without changing existing saved
provider assignments. Missing fields gain defaults; explicit null slots remain
disabled. The first-run wizard does not require memory setup.

The **Memori** panel and protected `/api/settings/memory` endpoints expose
readiness, original dialogue, quote-backed facts, search, correction history,
manual records, job retry, index rebuild, and deletion impact. Data mutations
use `memoryRevision`; configuration saves retain Settings `version` protection.
Legacy `/api/memory` aliases receive the same origin/token checks. Memory text
is not included in Settings exports or browser storage. See the
[memory guide](memory.md) for explicit installation commands, API details,
retention, migration, and playback-based recording.
