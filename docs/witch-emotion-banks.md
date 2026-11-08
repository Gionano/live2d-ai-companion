# Witch emotion banks

The 魔女 companion loads an optional sidecar bundle from
`/animationBanks/witch/`: 18 expressions, 16 emotion clips, four idle clips,
`banks.json`, `effects.json`, and seven local SVG symbols. It uses the active
model's existing rig, textures, and Moc. Its model manifest remains unchanged.
Other models keep their existing behavior. Missing or interrupted bundle loads
fall back to the model's standard expressions and motion controllers.

| Avatar emotion | Behavior |
|---|---|
| `netral` | Neutral face and relaxed poses |
| `malu` | Shy expressions and glances |
| `sayang` | Affectionate faces and leans; occasional heart eyes |
| `jahil` | Playful faces, peek/tilt; occasional brief tongue reaction |
| `senang` | Happy faces and lifted posture; occasional star eyes |
| `kagum` | Happy bank with admiration speech gestures and twinkles |
| `sedih` | Sad faces and lowered posture |
| `marah` | Angry faces and firm posture |
| `jengkel`, `kesal` | Furrowed brows and 55% bank movement |
| `terkejut` | Surprised faces and recoil/tilt; brief quiet gasp |
| `bingung`, `penasaran` | Neutral face and curious tilt; no symbol |

Avatar labels remain separate from Fish Audio's validated speech emotions.
Explicit `speechEmotion` metadata retains priority. The legacy `senang` fallback
is `[happy]`.

## Playback and movement

Ordinary replies, surface/deep stages, proactive speech, and visual commentary
use the existing decoded sentence audio events. Each cue carries speech,
segment, stage, part, and audio start/end metadata. A bank face is selected when
playback reaches `startAt`; receiving text or audio packets does not trigger it.
Repeated cue delivery does not restart animation. Adjacent sentences may select
different faces with the same emotion while preserving an unfinished motion.
Heart/star faces keep half the ordinary selection weight; ordinary faces can
repeat. Temporary eye effects fall back and mutually exclusive switches clear
before the next effect begins.

Authored pose targets become bounded rig-unit offsets applied once beneath
speech gestures. Existing speech gains, breathing, and secondary physics remain
active. Eye openness multiplies the automatic blink mask. Lip sync owns mouth
opening during audio. Tongue/gasp overlays use known gaps between decoded audio
intervals, at most 600 ms; gaps below 150 ms are skipped. A later arriving audio
cue cancels a reaction immediately when playback resumes, without delaying it.

One idle scheduler selects from the original 15 variants and four exported
clips. It checks availability every 300 ms, avoids consecutive motion repeats,
and uses existing strength/pace controls. Speech has priority, including the
400 ms speech-to-idle hold. A fading outgoing pose blends into the next owner.
Cancellation clears pending cues, reactions, symbols, and authored motion.
Late cancelled speech and late model-session asset loads cannot reanimate the
new model.

## Configuration

Use **Ekspresi & simbol emosi** in the existing tuning settings. No additional
conversation toolbar or bank preview controls are installed. Older saved tuning
files inherit the new defaults and retain their existing values.

| Key in `config/animationConfig.json` | Default |
|---|---|
| `banks.enabled` | `on` |
| `banks.poseStrength` | `1` |
| `banks.speechBlendWeight` | `0.35` |
| `banks.comicEnabled` | `on` |
| `banks.symbolSize` | `1` |
| `banks.symbolDurationMs` | `1500` |
| `banks.symbolCooldownMs` | `4000` |

Symbols fade over approximately 180 ms, with one visible symbol at a time.
A different emotion replaces the symbol; repeated emotions respect cooldown.
Neutral transitions and cancellation clear it. Short sentence gaps can retain
it until expiration. The calibrated head position is projected through the
final Cubism render matrix into CSS viewport coordinates. Resizing and display
scaling preserve attachment without changing avatar framing or Electron bounds.
The overlay and image both use `pointer-events: none`.

Comic symbols are renderer overlays. They are not part of the compiled model,
standard expression exports, or Cubism Viewer model rendering.

## Assets and testing

Vite copies `public/animationBanks/witch/` into `dist/animationBanks/witch/`.
Electron's existing frontend resources include that directory and serve it from
the same application origin. No production path references the standalone lab.
No extra IPC or preload permissions are required. The original model's license
continues to apply; authored sidecar data and symbols do not grant model rights.

Run `npm.cmd test` and `npm.cmd run build`. For focused regression checks:
`npm.cmd test -- server/tests/emotionBanks.test.js`. These tests mock audio and
model state and load only the published sidecar assets, without AI calls or
private model binaries. Review actual browser and Electron playback with local
test audio, sentence pauses, tone changes, cancellation, and model switching.
