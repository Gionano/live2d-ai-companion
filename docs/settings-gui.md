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
6. Images: inspect cached provider readiness and download the existing setup guide;
   this step does not configure or generate images.
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
