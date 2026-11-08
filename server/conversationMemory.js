// Share one retrieval between the surface and deeper generators. Failure of
// this optional context must not turn an otherwise healthy reply into an error.
export async function recallConversation(memory, userMessage, history, { signal, bundle } = {}) {
  signal?.throwIfAborted();
  let onAbort;
  try {
    const operation = Promise.resolve().then(() => bundle === undefined
      ? memory.retrieve(userMessage, { history, signal }) : bundle);
    const aborted = signal && new Promise((_, reject) => {
      onAbort = () => reject(signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const result = await (aborted ? Promise.race([operation, aborted]) : operation);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    return null;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function renderConversationMemory(memory, bundle, role = 'llm') {
  if (!bundle) return '';
  try { return memory.render(bundle, role === 'surface' ? 2000 : 3600); }
  catch { return ''; }
}
