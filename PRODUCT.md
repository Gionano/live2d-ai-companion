# Product Context

## Register
Product

## Product
A browser-based AI companion that presents Amika as an interactive Live2D Cubism avatar with hands-free voice conversation, vision, expressive animation, and low-latency streamed speech.

## Target Users
People who want a warm, playful virtual companion experience rather than a conventional assistant UI, primarily in Indonesian with automatic language matching.

## Core Experience
- Speak naturally without push-to-talk.
- Receive short, conversational replies through synchronized voice and avatar performance.
- Let Amika react to camera context when the user shows an object.
- Keep the avatar alive through restrained idle, facial, lip-sync, arm, and torso motion.

## Personality
Warm, cheerful, attentive, supportive, lightly playful, intimate without being excessive or cringe. The avatar should feel alive and responsive, not robotic or hyperactive.

## Design Principles
1. Performance serves conversation: facial expression, voice, and body movement should communicate the same emotional beat.
2. Motion stays subtle: transitions are smooth, bounded, and asymmetrical enough to avoid robotic repetition.
3. Conversation remains primary: debug UI and technical states should never distract from the companion.
4. Graceful degradation: missing VRM expressions, voice configuration, camera, or individual bones must not break chat.
5. Privacy by architecture: API keys remain server-side and camera/audio are used only for requested companion features.

## Anti-References
- Formal assistant dashboards or productivity-chat styling.
- Exaggerated anime reaction loops that overpower speech.
- Snapping expressions, perfectly synchronized limb motion, or constant high-energy movement.
- Long monologues that delay TTS or make the companion feel scripted.

## Accessibility and Comfort
Maintain readable controls and status text, restrained motion amplitudes, and clear microphone/error feedback. Avoid flashes, abrupt full-body movement, and excessive facial weights.
