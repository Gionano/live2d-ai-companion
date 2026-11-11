/**
 * Provider boundaries contain no vendor response objects or credentials.
 * ImageProvider remains in server/selfie/imageProvider.js.
 *
 * @typedef {{type: 'text', text: string} | {type: 'image', mime: string, base64: string}} Part
 * @typedef {{role: 'system'|'user'|'assistant', content: string|Part[]}} Message
 * @typedef {{firstByteMs?: number, idleMs?: number, totalMs?: number}} Timeouts
 * @typedef {{llm: boolean, images: boolean, jsonMode: boolean, stt: boolean, tts: boolean, embeddings?: boolean}} Capabilities
 * @typedef {{messages: Message[], temperature?: number, maxTokens?: number, json?: boolean, signal?: AbortSignal, timeouts?: Timeouts}} LlmRequest
 * @typedef {{type: 'text', delta: string}|{type: 'usage', inputTokens?: number, outputTokens?: number}|{type: 'done', finishReason?: string}} LlmEvent
 * @typedef {{text: string, inputTokens?: number, outputTokens?: number, finishReason?: string}} LlmResult
 * @typedef {{capabilities: Capabilities, stream: (request: LlmRequest) => AsyncIterable<LlmEvent>, complete: (request: LlmRequest) => Promise<LlmResult>, warmup?: (request?: {signal?: AbortSignal}) => Promise<LlmResult>}} LlmProvider
 * @typedef {{text: string, noSpeechProb?: number, avgLogprob?: number, compressionRatio?: number}} SttSegment
 * @typedef {{text: string, segments?: SttSegment[], durationMs?: number}} SttResult
 * @typedef {{capabilities: Capabilities, transcribe: (request: {audio: Buffer, mime: string, filename: string, language?: string, signal?: AbortSignal}) => Promise<SttResult>}} SttProvider
 * @typedef {{type: 'audio', data: Buffer, format: string}} TtsEvent
 * @typedef {{stability?: number, similarityBoost?: number, speed?: number, emotionTags?: boolean}} ElevenLabsVoiceParams
 * @typedef {{capabilities: Capabilities, stream: (request: {text: string, emotion?: string, speechEmotion?: string, voice?: string, format?: string, temperature?: number, topP?: number, latency?: string, prosody?: {speed?: number, volume?: number}, elevenLabs?: ElevenLabsVoiceParams, sentenceIndex?: number, tag?: string, signal?: AbortSignal}) => AsyncIterable<TtsEvent>}} TtsProvider
 * @typedef {{resolve: (apiKeyEnv: string) => string|undefined|Promise<string|undefined>}} SecretResolver
 * @typedef {{texts: string[], taskType?: 'query'|'document', signal?: AbortSignal, timeouts?: Timeouts}} EmbeddingRequest
 * @typedef {{model: string, dimensions: number, vectors: number[][]}} EmbeddingResult
 * @typedef {{capabilities: Capabilities, embed: (request: EmbeddingRequest) => Promise<EmbeddingResult>}} EmbeddingProvider
 */

/** Collect canonical events without changing their streamed text. */
export async function completeStream(stream) {
  const result = { text: '' };
  for await (const event of stream) {
    if (event.type === 'text') result.text += event.delta;
    if (event.type === 'usage') {
      if (Number.isFinite(event.inputTokens)) result.inputTokens = event.inputTokens;
      if (Number.isFinite(event.outputTokens)) result.outputTokens = event.outputTokens;
    }
    if (event.type === 'done' && event.finishReason != null) result.finishReason = event.finishReason;
  }
  return result;
}

export function providerCapabilities(defaults, profile = {}, model) {
  const flags = profile.flags ?? {};
  return {
    ...defaults,
    ...(flags.supportsImages === undefined ? {} : { images: flags.supportsImages }),
    ...(flags.supportsJsonMode === undefined ? {} : { jsonMode: flags.supportsJsonMode }),
    ...(flags.supportsStt === undefined ? {} : { stt: flags.supportsStt }),
    ...profile.capabilities,
    ...profile.models?.[model]?.capabilities,
  };
}
