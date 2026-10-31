import { getProviderRegistry } from './providers/registry.js';
import { isVoiceConfigured } from './voiceConfig.js';
import { withFishEmotion } from './providers/adapters/fishAudio.js';
import { throwIfAborted } from './providers/errors.js';

export { withFishEmotion };

export function isSpeechConfigured() {
  return isVoiceConfigured() && getProviderRegistry().getSlotStatus('tts').available;
}

// The speech controller consumes the same MP3 buffers as before the migration.
export async function* generateSpeech(text, emotion = 'neutral', { signal, registry = getProviderRegistry() } = {}) {
  throwIfAborted(signal, { slot: 'tts' });
  if (!registry.getSlotStatus('tts').available) return;
  for await (const event of registry.getTts().stream({ text, emotion, signal })) {
    yield event.data;
  }
}

if (process.argv[1] && process.argv[1].endsWith('ttsGenerate.js')) {
  if (withFishEmotion('Halo', 'happy') !== '[happy] Halo') throw new Error('emotion tag failed');
  if (withFishEmotion('Halo', 'neutral') !== 'Halo') throw new Error('neutral tag failed');
  if (withFishEmotion('Halo', 'unknown') !== 'Halo') throw new Error('emotion fallback failed');
  console.log('ttsGenerate self-check OK');
}
