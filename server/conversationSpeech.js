import { generateConversationReply } from './conversationCoordinator.js';

// Both ordinary and proactive turns share one ordered text/audio pipeline.
export async function playConversationReply({ controller, socket, turnId, history, userMessage,
  vision, origin = 'conversation', guidance, internalInstruction, registry,
  memory, memoryBundle, memoryContext = null,
  generate = generateConversationReply, onEvent = () => {} }) {
  let text = '';
  let emotion = 'netral';
  let reflectionRequest = null;
  const result = await controller.play({ recipients: [socket], turnId, origin, memoryContext,
    produce: async ({ say, emit, touch, signal }) => {
      let chain = Promise.resolve();
      try {
        for await (const event of generate(history, userMessage, vision, { signal, registry, guidance,
          internalInstruction, memory, memoryBundle,
          skipSurface: origin === 'proactive', partIdPrefix: `${turnId}:` })) {
          if (signal.aborted || !controller.isCurrentTurn(socket, turnId)) break;
          onEvent(event);
          if (event.type === 'generation_progress') touch?.();
          else if (event.type === 'reply_part') emit(event);
          else if (event.type === 'delta') text += event.text;
          else if (event.type === 'emotion') emotion = event.emotion;
          else if (event.type === 'sentence') {
            const snapshot = Object.freeze({ ...event });
            const selectedEmotion = snapshot.emotion ?? emotion;
            chain = chain.then(() => {
              if (!signal.aborted && controller.isCurrentTurn(socket, turnId)) {
                onEvent({ type: 'tts_start', stage: snapshot.stage });
                return say(snapshot.text, selectedEmotion, () => onEvent({ type: 'tts_chunk', stage: snapshot.stage }), snapshot);
              }
            });
          } else if (event.type === 'conversation_done') {
            text = event.text;
            emotion = event.emotion ?? emotion;
            reflectionRequest = event.reflectionRequest ?? null;
          }
        }
      } finally {
        await chain;
        if (!signal.aborted && controller.isCurrentTurn(socket, turnId) && text.trim()) {
          emit({ type: 'amika_replied', text, emotion });
        }
      }
    },
  });
  return { ...result, text, emotion, reflectionRequest };
}
