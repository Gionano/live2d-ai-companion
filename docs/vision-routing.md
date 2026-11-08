# Conversation and vision routing

The backend routes each admitted message after typing or STT and PAP detection,
before explicit visual analysis and the surface/deep spoken stages. Ordinary
conversation stays in conversation: saying **ini**, mentioning a camera, or
having a camera enabled does not request an inspection.

## Groq configuration

The dedicated `router` slot defaults to the existing Groq profile:

```json
"router": {
  "profile": "groq",
  "model": "openai/gpt-oss-20b",
  "params": {
    "temperature": 0,
    "maxTokens": 512,
    "json": true,
    "bodyExtras": { "reasoning_effort": "low" }
  },
  "timeouts": { "firstByteMs": 5000, "idleMs": 5000, "totalMs": 5000 }
}
```

The Groq profile uses `https://api.groq.com/openai/v1`. Create a key at
[Groq API Keys](https://console.groq.com/keys), then save it in the existing
Groq provider's credential field or set backend `GROQ_API_KEY`. Under Settings
→ Connections → Advanced, **Pengarah percakapan** selects its provider/model and
offers the existing connection test. The model check validates connectivity and
text output; it does not certify routing accuracy. No local model download is
needed. Existing chat, vision, reflection, and Fish assignments are retained.

Older settings without a router use this default. Explicit assignments and
`null` remain respected. Older imports add the default Groq profile/slot when
they are omitted; deliberately deleted Groq profiles remain deleted. Saved
tokens use the existing backend secret accessor and never appear in exports.

## Decisions and fallback

| Message and context | Action |
| --- | --- |
| `Tapi ini kan genre love polygon` | Conversation |
| `Kenapa Manaka ini suka Tsumugu?` during an anime discussion | Conversation |
| `Kamu pernah lihat anime ini?` | Conversation |
| `Lihat error ini di layar` | Fresh screen inspection |
| `Yang aku pegang ini apa?` | Fresh webcam inspection |
| `Lihat ini` after discussing a screen error | Resolve to screen |
| `Bandingkan yang di kamera dengan layar` | Inspect both concurrently |

Clear ordinary messages and positive source-specific requests use local rules.
Ambiguous messages use one routing completion operation with recent trimmed
conversation, valid visual descriptions, source availability, and per-connection
visual focus. The router receives text descriptions, not raw frames. These
descriptions and conversation text are sent to the configured router provider.

The private decision is `conversation`, `screen`, `webcam`, or `both`, with an
optional resolved visual question. It is never displayed, spoken, recorded as
user history, or extracted as user memory. Amika resolves the source without
asking the user to choose camera or screen.

The complete routing operation has a five-second maximum, including transport
retries. Invalid output, missing credentials, timeouts, and provider failures
use local fallback. Ambiguous ordinary wording stays conversational. An actual
look request uses valid recent visual focus or the available source(s); both
are inspected when neither can be selected from context. A named unavailable
source is reported unavailable rather than silently replaced. Insufficient
visible detail is reported honestly.

Requested inspections pass the resolved question to the vision provider and
require fresh results. Capture-session checks apply before inference, after
inference, and again before combining two results. Stopped/switched sources and
cancelled turns cannot supply a late current observation. Passive descriptions
remain labelled background context, never an assumption that the user is
showing something.

## Commentary and diagnostics

The existing `visionFilter` checks both interest and relevance in one request.
Spontaneous comments require relevance to recent conversation or an invitation
to comment. With neither, it skips. External commentary proposals pass the same
gate before chat/history insertion and speech admission. User activity, changed
sources, and competing speech discard obsolete decisions instead of postponing
them. This adds no router request to continuous capture.

Vision Monitor's **Pengarah percakapan** card reports rules/AI/fallback, chosen
sources, readiness, elapsed time, and a safe failure reason. Routing diagnostics
contain no transcript, resolved question, reasoning, or credentials. Console
timestamps remain outside conversation text.

Continuous capture still runs only while a Vision Monitor dashboard is open;
screen sharing, camera controls, capture freshness, and inference rate limits
are unchanged. Quiet conversation and sentence playback keep their existing
timing. Repeated-question prevention is a separate concern.

Run `npm.cmd test` and `npm.cmd run build`. Replay the table in browser/Electron
and inspect the routing card: ordinary anime discussion must generate no explicit
camera inference; a direct screen request must select screen; closing the last
monitor must stop continuous capture. Test credentials only when intentionally
performing live provider checks.
