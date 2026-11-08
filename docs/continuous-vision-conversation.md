# Continuous vision and expressive conversation

Continuous vision and expressive conversation retain the
configured vision provider, Fish Audio, active Live2D model and speech-motion
gains. Mouth-form animation and recorded sound effects remain deferred.

## Controls

- Webcam monitoring and quiet conversation are enabled in
  `config/animationConfig.json`, including their reset defaults. The root page
  has no **Animasi & Vision** button or on/off controls for these features.
- Continuous screen and webcam capture runs only while at least one Vision
  Monitor dashboard is connected. A running bridge without an open dashboard
  does not enable capture. Closing the last dashboard or stopping its bridge
  stops both capture loops, clears visual context and cancels pending analysis.
  Reopening the monitor resumes available sources with new capture sessions.
- Screen availability follows the browser screen-sharing button or Electron's
  Screen Vision tray toggle. Webcam monitoring starts automatically when the
  camera is ready and the monitor is open. Camera switching retires the old session.
- Every enabled source captures once per second using the existing JPEG
  resolution and quality. Continuous inference has a minimum two-second interval
  per source, with one request in flight and only the newest pending changed frame.
- TTS settings provide **Ucapkan kalimat lengkap pertama lebih cepat** (on by
  default), a 200 ms sentence pause, and **Jeda antarbagian ucapan (ms)** (150 ms).
  Both pauses are adjustable from 0 to 400 ms; boundaries use the greater pause.
- **Obrolan saat hening** is enabled by default with a 30-second quiet delay.
  Refreshing the root page reloads the enabled configuration without a save step.
  It can use conversation history while the monitor is closed; continuous visual
  context is supplied only while the monitor is open.

## Visual context

Tiled screen signatures detect localized changes; webcam signatures tolerate
small sensor noise. Comparison uses the frame represented by the accepted
description, so gradual changes accumulate. Unchanged successful captures
validate that description without another inference.

Capture freshness and inference age are separate. The default freshness limit is
five seconds. Without a fresh capture, that source is omitted from conversation.
During a changed scene, an older description is explicitly labelled as a recent
observation. Stopping, disconnecting or switching a source clears its current
context, cancels pending work and fences late results by capture session.

Ordinary replies receive both enabled sources automatically. Visual prompts
include the latest completed assistant reply. Explicit visual questions perform
new analysis outside the continuous inference throttle; capture failures produce
unavailable-source context. Modern input carries capture-session identities even
when the monitor is closed. Legacy screen messages remain accepted.
The commentary window remains separate from current-scene context.

The [hybrid conversation router](vision-routing.md) resolves visual intent from
context using local rules or Groq `openai/gpt-oss-20b`. Bare `ini` does not request
camera inspection. Source selection is automatic; explicit comparisons can
inspect both sources concurrently. Background context no longer implies that
the user is showing something. The existing commentary filter admits only
interesting events relevant to the discussion or an explicit invitation.

The monitor displays per-source freshness, capture/inference ages, changed-frame
requests, unchanged/rate-limit skips, pending work and inference latency. Its
analysis interval control does not change the one-second capture cadence.
**Durasi analisis** is the total duration of a completed AI request, including
provider/network waiting. **Tunggu respons** measures the wait until the first
response bytes. Neither metric is the configured minimum request interval.

## Speech and quiet conversation

Chat streams ordered `segments`, each containing `emotion`, optional
`speechEmotion`, `register`, and `text`. Legacy single objects and plain text become one
segment. Each synthesized sentence group snapshots its tone, segment identity and
pause. Avatar expressions and gestures start with actual audio playback; Fish
metadata remains private to synthesis. Sanitized segment text is concatenated
into one assistant history entry. New clients display surface and deep stages
as separate bubbles; legacy clients receive the combined final reply.

The quiet timer is armed once a connected client, configured chat/TTS providers
and audio playback are ready. Browser playback needs its existing activation
gesture; Electron starts audio automatically. No first message is required.
User activity and actual playback completion, including pauses, reset the timer.
The latest active conversation can speak only while conversation clients,
speech queues and visual commentary are idle. Passive visual analysis does not
block it. The `reflection` slot follows `llm` by default and returns SKIP, private
guidance or an instruction to speak. A SKIP consumes that quiet interval.
Reflection requested by a deep reply runs after playback and may initiate a
follow-up. Silence and reflection follow-ups share the two-unanswered-turn limit;
recent assistant speech and topics are checked to limit repetition.

The 30-second delay starts reflection; it does not guarantee audible speech
at exactly 30 seconds. A deliberate SKIP consumes that quiet interval. Decision
requests have a 30-second deadline in `conversation.proactiveDecisionTimeoutMs`.
A temporary overlap with commentary discards the proposed topic and evaluates
fresh context once the conversation is idle. Playback during a decision resets
the quiet delay. The monitor's **Obrolan saat hening** card shows its countdown,
decision/generation/playback stage, SKIP, provider readiness, timeout or the
two-unanswered limit. Diagnostics contain no conversation text or internal topics.

Terminal and browser-console diagnostics use Jakarta time in
`[HH:mm:ss.SSS WIB]` format, including proactive state changes. Chat messages,
captions and stored conversation history keep their original text without a
timestamp prefix. Restart the backend and monitor bridge after logging changes,
then refresh the WebUI.

Unsolicited speech uses an internal instruction and assistant-only history; it
does not create a user message or trigger user-memory extraction. Voice, typing
or PTT cancels its decision, generation, queued audio, pauses and gestures. Voice
interruption is enabled specifically during unsolicited speech with the existing
microphone echo cancellation. Ordinary reply interruption behavior is retained.

## Verification

Final change-set verification on 2026-11-07: all changed regression files passed
266 tests with one optional local-asset test skipped. Root and monitor builds
passed, and the privacy scan reported zero failing files. This run includes the
final diagnostic timestamps and plain-text conversation log behavior.

Validation on 2026-11-07 after the monitor-controlled capture and quiet-chat
diagnostics updates: the final full isolated suite passed 1,125 tests with one
optional local-asset test skipped. Main and monitor builds passed. An earlier run
hit the existing managed-ComfyUI idle-stop timing test; its focused rerun and the
final full rerun passed without changes to ComfyUI. The optional asset test had
passed separately against the local 魔女 model and Cubism runtime before this update. Live
browser/Electron and speaker-echo checks still require the hardware check below.

Run `npm test` and `npm run build` from the root. Build the monitor with
`npm --prefix vision-monitor run build`. Mocked tests cover scene filtering,
source/session races, freshness, combined context, streamed segments, immutable
tones, pauses, cancellation and quiet-conversation timing.

For the hardware check, start the root services and Vision Monitor,
then open the browser companion or Electron. Allow the camera and share the screen,
leave each scene unchanged, then change a small screen region or show a new object.
Check independent counters, close all monitor dashboards and confirm capture
stops even with the bridge running, then reopen the dashboard and check automatic
resumption. Stop the bridge and check that capture stops too. Ask an explicit
visual question with the monitor closed and during a source switch.

Request a reply with a meaningful tone change and listen for the first sentence
and sentence/segment pauses. Unlock browser audio without sending a message,
wait 30 seconds, and interrupt by typing, PTT and voice. Repeat after playback.
Check that
speaker echo alone does not interrupt and that two unanswered turns stop further
unsolicited speech. Live provider/audio quality and physical speaker echo require
this hardware check; mocked tests do not establish them.
