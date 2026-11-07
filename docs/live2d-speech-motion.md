# Live2D speech movement

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

The scheduling approach is inspired by
[OpenAmika's emotion banks](https://github.com/zeekk0/OpenAmika/blob/5d5e0568aff2de9f200ed2da21d0412efcdf8f79/ui/live2d-engine.js#L521-L595).
The gesture curves are authored for this project; no external motion assets are needed.
OpenAmika plays recorded motion banks with many model-specific tracks. 魔女's
manifest has no such speech or idle bank. Its sibling `Scene1.motion3.json`
animates special effects and hands, so it is not used as neutral speech movement.
The screenshot's bracketed names are display labels; the scanned IDs still use
`ParamAngleX`, `ParamBodyAngleX`, and other standard `Param*` names. Its actual
`ParamBrowLY` height control now receives brow motion when no brow-angle control
exists; absent controls are not invented.

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
5. Run `npm.cmd --prefix desktop-companion run dev` to check the overlay. Try both
   wing presets and resize the window while speech is playing.

**Kekuatan gerak** controls gesture size. **Frekuensi gestur** controls scheduling
of new gestures; setting it to zero also fades an active gesture out.
**Kehalusan gerak (ms)** controls transitions. **Kekuatan gestur badan** separately
controls speech movement on real torso parameters. **Kemiringan seluruh model** controls
the render-only lean used by IceGirl, whose rig has no torso parameters.
Leans are capped at 1.5 degrees, horizontal shifts at 1% of visible width, and
vertical shifts at 0.4% of visible height. Fixed overlay margins reserve room for
the motion without changing window bounds or zooming on each pose.

## Validation

Run `npm.cmd test` and `npm.cmd run build`. To check the local 魔女 rig through
the actual Cubism Core and physics, run
`node --test server/tests/witchMotion.test.js`. This optional check skips when
ignored model assets are unavailable, including in the isolated test workspace.
The local rig check compares speech against the same deterministic idle tracking
and breathing through real physics, measuring both motion range and activity.
The speech-motion tests cover audio
timing, emphasis and pauses, emotion variation, 30/60 FPS consistency, cancellation,
decode failures, real parameter availability, bounds, and legacy tuning imports.
Only scanned rig parameters are driven. Mouth and secondary physics outputs
are excluded from the gesture layer. Real physics-controlled torso channels
receive a separate smoothed base pose before physics runs, so hair and chest
rigs that depend on the torso also receive its movement.

## Compare models

The active model is `/models/魔女/魔女.model3.json`. IceGirl remains available
in the model selector. Keep the existing tuning values when comparing them.

| Control | 魔女 | IceGirl |
| --- | --- | --- |
| Torso | Smoothed real torso tracking plus secondary physics | Bounded render lean |
| Wing preset | Does not write `Param41`, which controls an ear | Uses the registered wing expression and `Param41` |
| Blinking | Declared eye controls, or scanned eye-open controls if groups are absent | Same detection |

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
IceGirl continues to use its render lean and the existing gesture tuning.

For an identical gesture sequence as well as identical preview audio, run this
in the browser console for each model. It temporarily seeds gesture selection
for each emotion and restores the normal random selector afterward:

```js
async function compareSpeechMotion(modelPath) {
  const adapter = window.__live2dCompanion;
  await adapter.switchModel(modelPath);
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

await compareSpeechMotion('/models/live2d/IceGirl.model3.json');
await compareSpeechMotion('/models/魔女/魔女.model3.json');
```

Check torso follow-through, head and gaze coordination, transitions after
speech, held head poses between phrases, and hat/hair/wing clipping while resizing. Repeat in overlay mode with
both wing presets. The final call leaves 魔女 displayed; the saved active model
remains 魔女 because this local comparison does not change server settings.
