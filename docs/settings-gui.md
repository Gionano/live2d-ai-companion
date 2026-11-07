# Settings GUI (P3)

Open the companion on the host at `http://localhost:5173/#settings`, use the gear
in the debug panel, or choose **Settings…** in Electron's tray. The Electron
window loads the same frontend origin. Mobile and non-loopback clients show a
host-computer notice instead of an entry point; the API independently refuses
remote access.

## Screens

| Screen | Contents |
| --- | --- |
| Connections | Provider list, add/edit/delete form, presets, write-only credentials and capability flags. LLM, Vision, STT and TTS editors; planner/visionFilter appear under Advanced. |
| Foto / PAP | Persistent image-provider selection, connection checks, Cloudflare credentials, and reviewed local setup with licenses, progress, and cancellation. |
| Status | Per-slot availability with an icon and text, storage backend/version and transport/storage warnings. |
| Privacy | Current origin-only destinations for microphone audio, chat/memory text, camera/screen frames and spoken text; local image-provider disclosure and links back to existing feature controls. |
| Diagnostics | Backend name, safe file-location labels, writability, permission notes, locks, backup count and a dummy-key self-test. |
| Language | Indonesian or English. The saved choice takes precedence over browser language detection. |

The existing desktop tray contains **Mute Mikrofon**, **Screen Vision** and
**Pap feature** controls. The companion also has **Share Screen**. Privacy links
return to the companion; they do not toggle capture. There are no new safety,
moderation or persona controls.

## First-run flow

The wizard starts when no slot is assigned or Chat is unassigned. Its order is:

1. Language: choose and save Indonesian or English.
2. Chat: add/save a provider, then save its model assignment. Chat is required.
3. Voice: configure TTS voice ID/format or skip for text-only replies.
4. Hearing: configure STT, initially Indonesian, or skip and type messages.
5. Vision: optionally assign an image-capable model, or skip.
6. Images: use the same **Foto / PAP** controls as the settings tab. Choose and save
   a provider, check its connection, or review missing local components before setup.
7. Privacy: review which configured hosts receive each kind of data.
8. Finish: close the wizard and return to Connections or the companion.

Each Save writes immediately. Only the step and completion flag are kept in
localStorage; provider form values and secrets are not. Reload resumes progress.
The wizard can be restarted from Settings. An unassigned Chat requires setup
again on the next load. The Electron settings partition is temporary, so wizard
progress survives page reloads but not necessarily a full application restart;
saved provider choices and language remain in backend settings.

## Providers and slots

Choose a generic/custom template or a named example, enter a unique profile ID,
adapter and base URL, then Save. Public endpoints require TLS; permitted local
HTTP endpoints show a plaintext warning. Enable only capabilities supported by
the chosen service/model. Saving a provider does not assign it to a slot.

API-key inputs are password fields with autocomplete disabled. They clear before
transport and stay empty after success or failure. Only presence and the API's
permitted last-four suffix are displayed. A credential-bearing profile changing
origin requires a replacement key or the explicit delete-old-credentials option
and confirmation. Deleting a provider confirms that its slots will be unassigned.

Each slot has a provider dropdown, manually editable model, temperature and token
limit. STT adds language; TTS adds voice ID and format. Advanced includes request
timeouts and a validated JSON editor for bodyExtras/omitParams. Credential-like
entries trigger a warning and clear on submission; the backend separates private
values. Planner and visionFilter can follow LLM or use independent assignments.
Unassign requires confirmation.

**Load models** requests names from the selected saved profile. A one-time key in
the slot's Advanced section is sent only in the request body and is not saved.
Discovery can be unsupported; typing the model always remains available.

**Test** probes the selected profile/model without saving those edits, including
when the slot follows LLM. Progress shows connecting, first byte when received,
and done. Results show TTFT, total time, token counts when available and a friendly
error with its code. Probe timeout defaults to 20 seconds, adjustable from 1 to
60 seconds. The slow-TTFT warning threshold defaults to 5 seconds and is adjustable
in the form; these two test controls reset on rerender. Tests and discovery may
consume provider quota and share the API's rate limit with diagnostics.

## Foto / PAP

Choose **ComfyUI**, **ComfyUI Managed**, **sd.cpp**, or **Cloud**, then use
**Simpan & gunakan** to persist the selection in backend settings. Changing the
dropdown only updates the form; it does not start an installation or generation.
Existing automatic configurations keep their local-only provider order until a
new selection is saved. Changes wait for admitted photo jobs and cleanup to finish.

ComfyUI connects to a server the user already runs. Managed ComfyUI bundles a
Windows/NVIDIA runtime; sd.cpp recommends CUDA12 for NVIDIA and Vulkan otherwise.
**Tinjau penyiapan** shows missing components, download and disk sizes, license
links, and any blockers. Accept the displayed licenses and press **Unduh & siapkan**
to start. Valid CLI installations, model files, and resumable downloads are reused.
An existing archive extractor is reused; otherwise managed setup includes a pinned
portable extractor in the app's local runtime folder.

Installation progress survives page refresh. **Batalkan penyiapan** retains partial
downloads. After a backend restart, interrupted work stays stopped until the user
reviews setup and explicitly starts again. Selecting a different provider does not
allow a finishing installation to overwrite that choice.

Cloud uses the user's own Cloudflare Account ID and API token. The backend sends
the planned prompt and one resized character reference to Cloudflare Workers AI
using `@cf/black-forest-labs/flux-2-klein-9b`. Output is one 1024×1024 image with
four fixed steps; local sampling presets do not change cloud parameters. The
original reference remains unchanged. Review the linked Cloudflare pricing for
account-specific charges and free allocation.

Cloud tokens are write-only in the form and clear before transport. They are
stored separately from public settings and never included in exports. Connection
checks do not generate images or prove that a paid generation will succeed.

### Cloudflare Account ID and API token

Create or sign in to your own [Cloudflare account](https://dash.cloudflare.com/).
Select the account you want to use for PAP; the Account ID and token must refer
to that same account. A domain and a deployed Worker are not required.

1. Open [Workers AI](https://dash.cloudflare.com/?to=/:account/ai/workers-ai)
   in the Cloudflare dashboard and select **Use REST API**.
2. Under **Get Account ID**, copy **Account ID**. This is the 32-character account
   identifier. You can also press **Ctrl+K** in the dashboard, search for
   **Copy account ID**, and select that command.
3. Select **Create a Workers AI API Token**, review the prefilled permissions and
   account scope, then select **Create API Token** and **Copy API Token**.
   Copy the token secret when it is shown; it cannot be retrieved later.
4. Ensure the token grants **Workers AI - Read** and **Workers AI - Edit** for the
   selected account. Read permits the app's model/connection check; Edit permits
   image generation. The token is used as a Bearer API token.
5. In Amika, open **Settings > Foto / PAP**, choose **Cloud**, paste the Account ID
   and token into their respective fields, then press **Simpan & gunakan**.
   Wait for any pending photo job/configuration update to finish, then press
   **Periksa penyedia tersimpan**. This check does not generate an image.

If the Workers AI shortcut is unavailable, open
[My Profile > API Tokens](https://dash.cloudflare.com/profile/api-tokens/), select
**Create Token**, and create a custom token named for Amika PAP. Use an **Account**
policy with **Workers AI / Read** and **Workers AI / Edit** permissions, scope it
to the specific account whose ID you copied, review the summary, and create it.
Use this API token in the form; the Global API Key is a different credential.

An `AUTH` result usually means the token is invalid/expired, its account scope
does not match the Account ID, or the required permissions are missing. A ready
connection confirms access to the model listing; generation still depends on
Workers AI access, account quota, and any applicable billing requirements.
When environment credentials are configured, `CLOUDFLARE_API_TOKEN` takes
precedence over the saved token. Store the secret only in the app's token field
or backend environment, and keep it out of chat, screenshots, and shared files.
If replacing the saved token does not fix authentication, update or remove the
environment token and restart the backend so the new credentials take effect.

Official instructions: [Workers AI REST API setup](https://developers.cloudflare.com/workers-ai/get-started/rest-api/),
[find your Account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/),
and [create an API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/).

## Diagnostics and security

Diagnostics sends an empty request to the backend. The backend creates a random
dummy key only in a separate OS temporary directory, reopens it to verify storage,
deletes it, verifies absence and removes the directory even on failure. It never
opens or modifies the real secret store. No dummy or real key is returned to the
GUI. The CLI also avoids initializing SettingsService and only reads non-secret
local metadata. A missing local directory is never created by diagnostics.

The session token stays in the API client's memory and is fetched from the same
origin. Provider strings use textContent. Settings loads external module scripts
under CSP; the Electron window has context isolation, sandboxing, no Node
integration or preload, blocked popups, restricted navigation and no capture
permissions. The API continues to enforce loopback, Host, origin and token checks.

## Adding a language

For a translation correction, edit the matching entries in `src/i18n/id.json`
and `src/i18n/en.json`; their key sets must remain identical. UI text goes through
the translator, including keys selected by maps/arrays. Fallback is English, then
the key itself; interpolation replaces named placeholders without HTML parsing.

To add a third language, create its dictionary, import/register it in
`src/bootstrap.js` and `src/settings/page.js`, extend detection/choices and the
language allowlist in `server/settings/schema.js`, and extend parity/reference
tests in `server/tests/settingsGui.test.js` plus schema/API coverage. A dictionary
alone does not expand the backend's accepted language values.

## Adding a preset

Add a unique ID, translated labelKey, supported adapter and baseUrl to
`src/settings/presets.json`. Keep Custom available, put labels in both dictionaries
and validate the URL through the existing validator. Never include a key, model
selection or credential-bearing URL in a preset. Extend preset tests.

These bundled example endpoints are **not release-verified**. The maintainer must
check each against its official documentation before release and record the date:

| Example | Preset URL | Official reference to verify |
| --- | --- | --- |
| OpenAI | https://api.openai.com/v1 | https://platform.openai.com/docs/api-reference/introduction |
| Groq | https://api.groq.com/openai/v1 | https://console.groq.com/docs/openai |
| Anthropic | https://api.anthropic.com | https://docs.anthropic.com/en/api/overview |

Generic OpenAI-compatible, Anthropic-native and Fish Audio adapters remain
selectable with manually supplied URLs. The flags mark verification work, not a
claim that a service or model is reachable.

## Validation

Run `npm test`, `npm run build` and `npm run check:privacy` (`npm.cmd` in restricted
PowerShell). Tests cover pure view models, wizard state, token handling, error
mapping, malicious model text, secret clearing, translation parity/references,
contrast calculations and fake Electron windows. Real local HTTP fixtures exercise
the API through Vite and Electron proxies, including secrets, probes, models,
deadline bounds, stale-lock recovery and diagnostics isolation.

Offline checks **cannot verify live DPAPI, live providers, real Electron
rendering or browser layout**. Before release, verify the live Windows dummy-key
test, official preset URLs, provider-specific model/voice behavior, keyboard/focus
navigation, first-run reloads, origin-change confirmations and a 360px-wide browser
layout. Compare actual screens with the descriptions above; no screenshots or
live rendering claims are supplied by the mocked suite.

See [Settings API/storage](settings.md) and the [P3 audit](STATUS.md#providers-p3-2026-11-01).
