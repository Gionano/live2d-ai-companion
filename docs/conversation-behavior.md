# Conversation and idle behavior

The companion combines quick reactions, deeper replies, private reflection and
varied idle movement using this project's adult Amika personality, 魔女 model
and Fish Audio.

## Spoken stages

`surface` produces a short reaction and selects `say`, `say+think`, or `think`.
Only greetings, acknowledgements and brief reflexive reactions finish with `say`.
Substantive answers use `llm` for a deeper continuation, with the actual surface
text supplied as context to avoid repeating it. Surface failure falls back to
one deeper request; a deeper failure preserves a surface response already sent.

A streaming continuation guard removes repeated leading sentences before text
splits into chat and TTS. Matching ignores case, whitespace and punctuation,
with a narrow greeting exception for 'Halo juga, sayang.' following 'Halo,
sayang.' It stops filtering at the first distinct sentence, so later intentional
repetition remains. If deep output only repeats the surface, the turn keeps that
surface response without another request or an empty second bubble. The original
user message remains unchanged; the guard does not require assistant prefill.

The two stages stream into separate chat bubbles. They share one turn ID, speech
ID and sanitized assistant history entry. HTTP chat retains its existing
single-generation interface; companion WebSocket conversations use the coordinator.
Legacy WebSocket consumers can continue reading the final `amika_replied` event.
New `reply_part` events contain `stage`, `partId`, `status` (`start`, `delta`, `done`)
and display text. New clients render these parts and suppress duplicate final text.

In **Connections → Advanced**, **Respons cepat** selects `surface` and
**Refleksi percakapan** selects `reflection`. Both follow Chat by default; their
provider, model and credentials can be configured through the existing protected
settings interface. A fast surface model improves responsiveness. Assigning the
same large model to both stages can add latency and another model call.

## Sentence tone and timing

Each spoken segment preferably contains one natural sentence. Its metadata is
`{register, emotion, speechEmotion, text}`. Register is `polite`, `casual`, `serious`,
`intimate` or `whisper`; avatar emotion remains one of the existing twelve labels,
and Fish speech emotion must be in its supported catalogue. Register shapes the
wording and tone choice; it is not sent as an unsupported Fish tag. Voice delivery
uses Fish's supported emotion tags and the configured voice.

Tone is captured before synthesis and travels with the audio boundary. Avatar
emotion and movement activate when playback starts, including for queued stages.
Text, tags and private instructions are kept separate; tags do not appear in chat.

**Jeda setelah setiap kalimat (ms)** controls `tts.params.expression.sentencePauseMs`.
The default is 200 ms, range 0–400. At segment and stage boundaries, the gap is the
greater of the sentence and segment pause. Pauses use scheduled silent audio and
the same clock as speech; final playback acknowledgment includes the final pause.
Cancellation stops both voice and scheduled silence. Existing short-sentence
merging remains available when sentence pause is zero.

## Private reflection and quiet conversation

Reflection runs when a deeper reply requests guidance, after its playback has
been acknowledged, or after 30 quiet seconds. It can select SKIP, provide a
temporary hint, replace/clear an ongoing conversation plan, or supply a speaking
cue. Hints are consumed only by the next deeper reply. Plans remain per conversation
until replaced, cleared, or disconnected. Neither enters the visible transcript
or user-memory extraction. Reflection returns concise practical guidance, not a
spoken analysis or inner monologue.

The trigger selects the speaking style at both reflection and reply generation.
After silence, Amika invites a response with one short, natural question about
a relevant preference, a new angle, or valid current visual context. She avoids
recapping the previous answer and routine food/work/voice-check filler. A
requested post-reply reflection speaks only when it identifies a new, useful
contribution to an unfinished point; otherwise it selects SKIP or private GUIDE.
Answered questions and resolved points stay settled. When a topic is complete,
she may choose a related new angle or an appropriate new topic rather than
restating the old discussion. These are model instructions, so wording still
depends on the configured models. No extra model requests are introduced.

Readiness requires a connected client, configured chat/reflection/TTS providers
and running audio. A browser needs its normal click/typing activation gesture;
it does not need a first submitted message or microphone permission to report
audio readiness. Electron starts audio through its existing companion startup.
Suspended audio cancels pending proactive work, which is never deferred for a later
unlock. Older clients without the handshake retain interaction-based arming.

Quiet time starts from actual playback completion, including pauses, or the latest
user activity. The old schema's 60-second default migrates to 30; other custom
values remain. A requested reflection can initiate an earlier follow-up once its
parent speech has finished. Only the most recently ready/active conversation may
speak proactively. Passive vision inference does not block reflection; queued or
active speech, input and actual visual commentary do. Visual context must remain valid.

Both quiet and reflection follow-ups use `origin: proactive` and the deeper
generator directly. At most two successfully played unanswered proactive turns
are allowed, followed by a wait for user input. SKIP ends that quiet interval's
attempt. Repeated topics and obsolete decisions are discarded. Voice, typing or
PTT cancels decisions, generation, queued audio, pauses and gestures immediately.
Microphone interruption uses the existing proactive-only echo-cancellation gate.

## Idle movement

Models without recorded idle groups use fifteen authored procedural motion
variants: glances, head tilts, turns, posture shifts and settling poses. Selection
is weighted, avoids immediate repeats, checks at a 300 ms cadence and waits for
the previous clip to finish. Normal clip lengths are 4–9 seconds. Existing recorded
idle groups retain their own behavior.

The fallback bank combines bounded head, gaze, brows and torso poses with breathing,
blinking and secondary physics. Synthetic tracking is reduced while a clip plays.
Actual speech gestures take priority; idle resumes about 400 ms after speech ends.
No vision request drives this animation, so it works with Vision Monitor closed.
`idle.motionStrength` defaults to 1 (0–2); `idle.motionPace` defaults to 1 (0.5–2).
Pace changes apply to the next clip. Speech gains, framing and wing controls remain
independent. See [Live2D movement](live2d-speech-motion.md).

## Verification

Validation on 2026-11-08: `npm.cmd test` passed 1,282 tests with two optional
asset tests skipped in the isolated runner. Both optional tests passed separately
against the local witch rig and Cubism physics. Root and Vision Monitor builds,
the privacy scan and whitespace checks passed. Mocked settings-page tests cover
independent model selection and timing persistence; startup tests cover muted
audio readiness without a first message. Continuation regressions cover the
repeated-opening examples, stream splits, private generation progress, tags,
tone boundaries and entirely repeated deeper replies. Browser automation could not open the
local page because automatic approval review failed, so browser/Electron UI,
live Fish voice quality and physical speaker-echo checks remain manual.

Run `npm.cmd test` and `npm.cmd run build`, then start `npm.cmd run dev:all`.
Open the browser companion, unlock audio without submitting a message and wait
30 seconds. Check a greeting, a substantive reply with separate bubbles, multiple
sentence tones, 200 ms pauses and a reflection follow-up. Interrupt proactive
speech using typing, PTT and voice; confirm silence alone stops after two turns.
Repeat in Electron, checking speaker echo, microphone mute and queued pauses.

Watch 魔女 for varied idle poses before speaking and after playback, including
with Vision Monitor closed. Inspect the monitor/console for readiness, reflection
and first-audio timing; diagnostics never add timestamps or private guidance to
conversation messages. Automated tests use mocked AI/audio services and do not
establish live provider quality or physical speaker-echo behavior.
