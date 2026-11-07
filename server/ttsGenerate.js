import { getProviderRegistry } from './providers/registry.js';
import { logger as console } from '../src/logging.js';
import { getVoiceId } from './voiceConfig.js';
import { withFishEmotion } from './providers/adapters/fishAudio.js';
import { throwIfAborted } from './providers/errors.js';
import { SentenceMerger, splitSpeechSentences, spokenSentenceCount } from './ttsExpression.js';

export { withFishEmotion };

export function isSpeechConfigured() {
  const registry = getProviderRegistry();
  if (!registry.getSlotStatus('tts').available) return false;
  const voice = registry.getTts().params.voice ?? getVoiceId();
  return Boolean(voice) && !voice.includes('<') && !voice.includes('ISI_DENGAN');
}

// The speech controller consumes the same MP3 buffers as before the migration.
export async function* generateSpeech(text, emotion = 'netral', { signal, registry = getProviderRegistry(),
  speechEmotion, sentenceIndex = 0, onSentence, onAudioFormat, onAudioEnd, ...overrides } = {}) {
  throwIfAborted(signal, { slot: 'tts' });
  if (!registry.getSlotStatus('tts').available) return;
  const provider = registry.getTts();
  const merger = new SentenceMerger(provider.params);
  const sentences = splitSpeechSentences(text).flatMap(sentence => merger.push(sentence));
  sentences.push(...merger.finish());
  for (const sentence of sentences) {
    const count = spokenSentenceCount(sentence);
    if (!count) continue;
    onSentence?.(sentenceIndex);
    try {
      for await (const event of provider.stream({ ...overrides, text: sentence, emotion,
        ...(speechEmotion !== undefined && { speechEmotion }), signal, sentenceIndex })) {
        onAudioFormat?.(event.format);
        yield event.data;
      }
    } finally {
      onAudioEnd?.();
    }
    sentenceIndex += count;
  }
}

if (process.argv[1] && process.argv[1].endsWith('ttsGenerate.js')) {
  if (withFishEmotion('Halo', 'happy') !== '[happy] Halo') throw new Error('emotion tag failed');
  if (withFishEmotion('Halo', 'netral') !== '[calm] [warm] Halo') throw new Error('neutral tag failed');
  if (withFishEmotion('Halo', 'unknown') !== 'Halo') throw new Error('emotion fallback failed');
  console.log('ttsGenerate self-check OK');
}
