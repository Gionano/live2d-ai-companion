const pauseSeconds = value => Math.max(0, Math.min(400, Number(value) || 0)) / 1000;

// Silent audio follows the same clock as speech, including its final pause.
export function scheduleAudioBuffer(context, buffer, { destination, earliestStart = 0,
  pauseBeforeMs = 0, pauseAfterMs = 0, signal, onCancel = () => {} } = {}) {
  const startAt = Math.max(context.currentTime, earliestStart) + pauseSeconds(pauseBeforeMs);
  const endAt = startAt + buffer.duration;
  const after = pauseSeconds(pauseAfterMs);
  const finishedAt = endAt + after;
  const sources = [];
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener('abort', cancel);
    for (const source of sources) source.disconnect();
    resolveDone();
  };
  const cancel = () => {
    if (finished) return;
    for (const source of sources) { try { source.stop(); } catch {} }
    try { onCancel(); } finally { finish(); }
  };
  if (signal?.aborted) { finish(); return { startAt, endAt, finishedAt, sources, done }; }
  try {
    const voice = context.createBufferSource();
    voice.buffer = buffer;
    voice.connect(destination);
    sources.push(voice);
    let tail = voice;
    if (after > 0) {
      tail = context.createBufferSource();
      tail.buffer = context.createBuffer(1, Math.max(1, Math.round(after * context.sampleRate)), context.sampleRate);
      tail.connect(destination);
      sources.push(tail);
    }
    tail.onended = finish;
    signal?.addEventListener('abort', cancel, { once: true });
    voice.start(startAt);
    if (tail !== voice) tail.start(endAt);
  } catch (error) {
    cancel();
    throw error;
  }
  return { startAt, endAt, finishedAt, sources, done };
}
