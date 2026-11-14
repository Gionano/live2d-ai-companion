# Live2D speech movement

The 魔女 companion also loads the [sidecar emotion banks](witch-emotion-banks.md):
18 expressions, 16 emotion clips, four additional idle clips, and seven comic
symbols. Its single idle scheduler now combines 19 variants. The audio-driven
gesture behavior and gains described below remain in effect.

Speech gestures follow the decoded audio's emphasis and pauses. Emotion banks
choose from six authored head, gaze, brow, and body gestures, with slower and
smaller movement for quiet emotions. Head and gaze curves now anticipate turns,
hold a pose, and settle into a smaller stance that carries with the torso between
gestures and segments of the same speech. Recentering gestures return to neutral;
completion, cancellation, or disabling gestures fades every speech offset out.
Short streamed segments continue an unfinished gesture at its original phase.
Cues start on the Web Audio playback clock,
so incoming audio packets cannot trigger gestures early. Mouth animation retains
its existing independent gain and smoothing.

At the normal strength setting of `1`, speech head offsets now use a 3.5× gain
and body offsets a 3× gain. Tilt and turn gestures also include deeper pitch
and forward/backward torso movement. These gains apply to speech only; idle,
breathing, gaze, and brow amplitudes keep their existing settings. Saved strength
values still scale the new movement, and `0` still disables speech gestures.
Gestures now last 0.9–1.9 seconds, with more frequent opportunities to start the
next one. Speech smoothing samples the curves at 120 Hz independently of the
render rate; stopping uses a smooth fade of at least 240 ms. Secondary hair/roll
physics settles on its own clock after the procedural speech pose has returned.

Emotion banks schedule gesture curves authored for this project using supported
model parameters. 魔女's manifest has no recorded speech or idle bank.
Its sibling `Scene1.motion3.json`
animates special effects and hands, so it is not used as neutral speech movement.
The screenshot's bracketed names are display labels; the scanned IDs still use
`ParamAngleX`, `ParamBodyAngleX`, and other standard `Param*` names. Its actual
`ParamBrowLY` height control now receives brow motion when no brow-angle control
exists; absent controls are not invented.

## Idle movement

Models without a recorded idle group, including 魔女, use fifteen locally authored
pose variants: glances, head tilts, turns, posture shifts, nods, and settling poses.
Weighted selection avoids the previous variant and checks for a finished motion
every 300 ms. Clips last 4.1–8.9 seconds at the default pace and blend from the
visible pose instead of restarting at neutral.

The bank combines supported head, eye, brow, and torso controls with the existing
breathing, blinking, and physics. Synthetic tracking is reduced while a bank motion
is present. Physics-controlled torso channels receive a separate bounded additive
base before physics evaluates; their speech gains remain independent. Models with
a recorded idle group retain that group.

Playback-timed speech cues suppress the idle bank. A 400 ms hold after the final
cue prevents a new motion from starting in a short sentence pause. Stopping speech
or cancelling it fades the old pose before idle restarts. This animation uses the
local frame clock and works before audio is unlocked, while disconnected, and
with vision monitoring off.

In `config/animationConfig.json`, **Kekuatan gerakan diam** (`idle.motionStrength`,
default `1`, range `0–2`) adjusts pose size; `0` fades the bank out. **Tempo gerakan
diam** (`idle.motionPace`, default `1`, range `0.5–2`) sets the speed of the next
selected motion. Neither setting alters mouth animation, speech gesture gains,
camera framing, or the authored physics.

## Try it

1. Run `npm.cmd run dev:all` on Windows.
2. Adjust speech-motion parameters in the `talking` group of
   `config/animationConfig.json`, then refresh the companion page. The root tuning
   button has been removed; existing motion gains remain in configuration.
3. In the browser console, call `window.__waifuTestSpeechMotion('netral')`,
   using `'kagum'` or `'sedih'` to compare other tones. This plays a five-second
   local test tone through the same scheduling path as TTS without an AI request.
4. Check head and gaze variation, then stop or interrupt a spoken response to
   verify that its gesture fades out.
5. Run `npm.cmd --prefix desktop-companion run dev` to check the overlay. Use the Witch framing preset and resize the window while speech is playing.

**Kekuatan gerak** controls gesture size. **Frekuensi gestur** controls scheduling
of new gestures; setting it to zero also fades an active gesture out.
**Kehalusan gerak (ms)** controls transitions. **Kekuatan gestur badan** separately
controls speech movement on real torso parameters. **Kemiringan seluruh model** controls
the render-only fallback for rigs without torso parameters.
Leans are capped at 1.5 degrees, horizontal shifts at 1% of visible width, and
vertical shifts at 0.4% of visible height. Fixed overlay margins reserve room for
the motion without changing window bounds or zooming on each pose.

## Validation

Run `npm.cmd test` and `npm.cmd run build`. For focused audio scheduling and
interruption checks, run
`npm.cmd test -- server/tests/speechMotionPlayback.test.js server/tests/playbackSegments.test.js`.
These suites cover playback timing, sentence pauses, cancellation, decode failures,
and real parameter scanning with injected audio and model dependencies.
Motion authoring, idle variation, emotion-bank behavior, and local Cubism physics
are now checked manually. Compare speech and idle playback on each available model,
including sentence gaps, tone changes, interruption, Witch reloads, and torso motion.
Only scanned rig parameters are driven. Mouth and secondary physics outputs
are excluded from the gesture layer. Real physics-controlled torso channels
receive a separate smoothed base pose before physics runs, so hair and chest
rigs that depend on the torso also receive its movement.

## Witch motion verification

The only supported model is `/models/魔女/魔女.model3.json`. Its torso uses
smoothed tracking plus secondary physics; blinking uses the declared eye controls.
The overlay uses the `witch` preset and leaves ear and accessory parameters alone.

For real physics-controlled torso axes, the base follows head rotation at one
third of its angle and adds a stronger authored body gesture. Each body variant
has anticipation, a distinct weight shift or forward dip, a short hold, and a
settled stance. That stance carries between gestures of the same speech, then
fades out on completion, cancellation, or disabling gestures. Head and gaze use
coordinated anticipation, hold, and settled poses. The base uses
180 ms smoothing and stays within the rig bounds and twenty units of its default
on X/Y, or ten on Z. The wider X/Y range remains available during the speech fade
so stopping cannot abruptly clip a large held pose.
Only those torso outputs use 35% of their original physics weight, preserving
the tracked base; other physics outputs retain their original weight. This is
the companion's blend, not an interpretation of VTube's physics-strength value.

For an identical gesture sequence as well as identical preview audio, run this
in the browser console. It temporarily seeds gesture selection
for each emotion and restores the normal random selector afterward:

```js
async function previewWitchSpeechMotion() {
  const adapter = window.__live2dCompanion;
  const controller = adapter.model.speechMotion;
  const originalRandom = controller.random;
  try {
    for (const emotion of ['netral', 'kagum', 'sedih']) {
      controller.reset();
      let seed = 314159;
      controller.random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      await window.__waifuTestSpeechMotion(emotion);
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  } finally {
    controller.random = originalRandom;
  }
}

await previewWitchSpeechMotion();
```

Check torso follow-through, head and gaze coordination, transitions after
speech, held head poses between phrases, and hat/hair clipping while resizing.
Repeat in overlay mode using the Witch framing preset.
