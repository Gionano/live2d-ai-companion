/** Parse SSE across UTF-8, line and network chunk boundaries. */
export async function* parseSse(body, { signal, touch = () => {} } = {}) {
  if (!body) throw new SyntaxError('Missing event stream');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let event = '';
  let data = [];
  let lastWasCr = false;
  const line = (value) => {
    if (value === '') {
      if (data.length === 0) { event = ''; return null; }
      const item = { event: event || 'message', data: data.join('\n') };
      event = '';
      data = [];
      return item;
    }
    if (value.startsWith(':')) return null;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let valueText = colon < 0 ? '' : value.slice(colon + 1);
    if (valueText.startsWith(' ')) valueText = valueText.slice(1);
    if (field === 'event') event = valueText;
    if (field === 'data') data.push(valueText);
    return null;
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const { value, done } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (!done) touch();
      const text = decoder.decode(value, { stream: !done });
      for (const char of text) {
        if (lastWasCr && char === '\n') { lastWasCr = false; continue; }
        lastWasCr = char === '\r';
        if (char === '\r' || char === '\n') {
          const item = line(pending);
          pending = '';
          if (item) yield item;
        } else pending += char;
      }
      if (done) break;
    }
    // Tolerate a final event without an empty terminating line.
    if (pending) line(pending);
    const item = line('');
    if (item) yield item;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
