import { getProviderRegistry } from './providers/registry.js';
import { generateReplyStream, takeSentence, trimConversationHistory } from './llmChat.js';
import { memoryManager } from './memoryManager.js';
import { recallConversation } from './conversationMemory.js';
import { SURFACE_SYSTEM_PROMPT } from './personality.js';
import { normalizeSpeechRegister } from './speechEmotionPrompt.js';
import { resolveTtsParams } from './ttsExpression.js';

export const SURFACE_PROMPT = `This is the surface stage: a quick, natural first reaction, not the substantive answer.
Choose mode before writing speech:
- say: only a greeting, acknowledgement, very brief agreement, or reflexive joke that needs no explanation, memory, real opinion, or meaningful emotional development.
- say+think: briefly acknowledge the actual point, then let the deeper stage answer. Do not close the topic or throw the user's question back at them.
- think: let the deeper stage answer directly. An optional short thinking filler is allowed when natural; it is not required.
Most substantive conversation belongs to say+think or think. Your reaction must be at most one short natural sentence. No stock 'let me think' in every reply.
Use the current conversation language. Do not invent facts, actions, or an answer you have not considered.
Return only one JSON object in this exact member order: {"status":"ok","mode":"say+think","segments":[{"register":"casual","emotion":"netral","speechEmotion":"calm","text":"one short spoken reaction"}]}.
status is ok, unfinished, or not-for-me. Empty segments are allowed when quietly waiting or thinking. Keep the existing avatar emotion and supported Fish vocabulary; omit speechEmotion when mapped speech mode is requested.
Do not output private analysis, reflection instructions, or stage directions. Put all metadata before text.`;

const DEEP_PROMPT = `This is the deeper spoken stage. Respond to the actual conversation with a considered, natural answer.
The surface reaction in the following context is completed assistant speech in this same turn. The user message is its original trigger, not a new message after that reaction.
Return only the remaining new continuation. Never include that reaction again in segments, greet again, or paraphrase it as another opening.
For example, after 'Halo, sayang.' start directly with the new thought, not 'Halo juga, sayang.' After 'Ya gitu doang?' continue with the next thought instead of repeating that question.
Do not invent a new user message or imply the user answered during the pause. The private guidance is conversation direction, never user memory.
Use one natural spoken sentence per segment where possible. Vary tone with meaning, without forcing changes.
If useful guidance is needed after this reply finishes, append reflectionRequest as a concise practical goal, at most 500 characters. Do not write an inner monologue or private analysis.`;

function deepGuidance(value) {
  if (typeof value === 'string') return { hint: value.slice(0, 1600) };
  if (!value || typeof value !== 'object') return {};
  return {
    ...(typeof value.hint === 'string' && { hint: value.hint.slice(0, 1600) }),
    ...(typeof value.plan === 'string' && { plan: value.plan.slice(0, 2400) }),
    ...(Array.isArray(value.plan) && { plan: value.plan.filter(item => typeof item === 'string')
      .slice(0, 8).map(item => item.slice(0, 300)) }),
  };
}

function stageFailure(stage, error) {
  return { type: 'stage_error', stage, code: error?.code ?? 'STAGE_FAILED' };
}

// All stages stay in the caller's existing turn and speech. This generator owns
// no history or playback: only spoken text and immutable sentence metadata leave it.
export async function* generateConversationReply(history, userMessage, visionDescription,
  { registry = getProviderRegistry(), signal, guidance, partIdPrefix = '', skipSurface = false,
    internalInstruction, onDeepStart, memory = memoryManager, memoryBundle } = {}) {
  signal?.throwIfAborted();
  const recall = await recallConversation(memory, userMessage, trimConversationHistory(history),
    { signal, bundle: memoryBundle });
  const params = resolveTtsParams(registry.getTts?.()?.params);
  const state = { full: '', emotion: 'netral', hasSpeech: false, lastPauseAfterMs: 0,
    surfaceText: '', surfaceMode: null, surfaceStatus: 'ok', reflectionRequest: undefined };

  const runStage = async function* (stage, options) {
    const partId = `${partIdPrefix}${stage}`;
    let text = '';
    let started = false;
    let sentenceIndex = 0;
    let surfaceClosed = false;
    let firstDelta = true;
    let openingSuppressed = false;
    let emotion = state.emotion;
    const pending = [];

    const publish = function* (event) {
      if (event.type === 'emotion') {
        emotion = event.emotion;
        if (!surfaceClosed) yield event;
        return;
      }
      if (event.type === 'delta') {
        if (surfaceClosed || !event.text) return;
        let delta = event.text;
        if (stage === 'surface') {
          const first = takeSentence(text + delta);
          if (first) delta = (text + delta).slice(text.length, first.sentence.length);
        }
        if (!delta) return;
        if (!started) {
          started = true;
          yield { type: 'reply_part', stage, partId, status: 'start', text: '' };
        }
        text += delta;
        yield { type: 'reply_part', stage, partId, status: 'delta', text: delta };
        const spacer = firstDelta && state.full && !/\s$/.test(state.full) && !/^\s/.test(delta) ? ' ' : '';
        firstDelta = false;
        state.full += spacer + delta;
        yield { ...event, text: spacer + delta, stage, partId };
        return;
      }
      if (event.type !== 'sentence' || surfaceClosed) return;
      // Legacy merging may group sentences when the configured pause is zero.
      // The surface stage still speaks only its first natural sentence.
      const sentenceText = stage === 'surface'
        ? takeSentence(event.text + ' ')?.sentence ?? event.text : event.text;
      const pauseAfterMs = event.pauseAfterMs ?? params.expression.sentencePauseMs;
      const phaseGap = sentenceIndex === 0 && state.hasSpeech
        ? Math.max(0, params.expression.segmentPauseMs - state.lastPauseAfterMs) : 0;
      const sentence = Object.freeze({ ...event, text: sentenceText, stage, partId, emotion: event.emotion ?? emotion,
        register: normalizeSpeechRegister(event.register),
        segmentId: `${partId}:${event.segmentId ?? sentenceIndex}`,
        pauseBeforeMs: Math.max(event.pauseBeforeMs || 0, phaseGap), pauseAfterMs });
      sentenceIndex++;
      state.hasSpeech = true;
      state.lastPauseAfterMs = pauseAfterMs;
      state.emotion = sentence.emotion;
      if (stage === 'surface') surfaceClosed = true;
      yield sentence;
    };

    let failure;
    try {
      for await (const event of generateReplyStream(history, userMessage, visionDescription,
        { registry, signal, memory, memoryBundle: recall, ...options })) {
        signal?.throwIfAborted();
        if (event.type === 'reply_metadata') {
          if (stage === 'surface' && event.mode) state.surfaceMode = event.mode;
          if (stage === 'surface' && event.status) state.surfaceStatus = event.status;
          if (stage === 'deep' && event.reflectionRequest) state.reflectionRequest = event.reflectionRequest;
          if (stage === 'surface' && state.surfaceMode) {
            for (const buffered of pending.splice(0)) yield* publish(buffered);
          }
          continue;
        }
        if (event.type === 'opening_suppressed') {
          openingSuppressed = true;
          continue;
        }
        if (event.type === 'generation_progress') {
          yield { ...event, stage };
          continue;
        }
        if (stage === 'surface' && !state.surfaceMode) pending.push(event);
        else yield* publish(event);
      }
      if (stage === 'surface' && !state.surfaceMode) {
        const error = new Error('Surface response has no valid mode');
        error.code = 'INVALID_SURFACE';
        throw error;
      }
      if (stage === 'deep' && !text.trim() && !(openingSuppressed && state.surfaceText)) {
        const error = new Error('Deep response has no spoken text');
        error.code = 'EMPTY_REPLY';
        throw error;
      }
    } catch (error) {
      signal?.throwIfAborted();
      failure = error;
    }
    if (stage === 'surface') state.surfaceText = text.trim();
    if (started) yield { type: 'reply_part', stage, partId, status: 'done', text: text.trim(),
      ...(failure && { partial: true }) };
    if (failure) throw failure;
  };

  if (!skipSurface && userMessage !== undefined && userMessage !== null
    && registry.getSlotStatus('surface').available) {
    try {
      yield* runStage('surface', { role: 'surface', maxTokens: 256,
        systemPrompt: SURFACE_SYSTEM_PROMPT, internalInstruction: SURFACE_PROMPT });
    } catch (error) {
      signal?.throwIfAborted();
      state.surfaceMode = null;
      yield stageFailure('surface', error);
    }
  }

  if (state.surfaceMode !== 'say' || !state.surfaceText && state.surfaceStatus === 'ok') {
    signal?.throwIfAborted();
    await onDeepStart?.();
    const selectedGuidance = typeof guidance === 'function' ? await guidance() : guidance;
    signal?.throwIfAborted();
    const instruction = [DEEP_PROMPT,
      `Already-spoken reaction and private direction (context): ${JSON.stringify({
        surfaceReply: state.surfaceText, guidance: deepGuidance(selectedGuidance),
      })}`,
      typeof internalInstruction === 'string' ? internalInstruction : '',
    ].filter(Boolean).join('\n\n');
    try {
      yield* runStage('deep', { role: 'llm', internalInstruction: instruction, continuationText: state.surfaceText });
    } catch (error) {
      signal?.throwIfAborted();
      if (!state.surfaceText) throw error;
      yield stageFailure('deep', error);
    }
  }
  signal?.throwIfAborted();
  yield { type: 'conversation_done', text: state.full.trim(), emotion: state.emotion,
    ...(!state.full.trim() && { silent: true }),
    ...(state.reflectionRequest && { reflectionRequest: state.reflectionRequest }) };
}
