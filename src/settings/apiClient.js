const codes = new Set(['CONFLICT', 'ORIGIN_CHANGE', 'IN_USE', 'FORBIDDEN', 'AUTH', 'RATE_LIMIT', 'TIMEOUT', 'LOCK_BUSY',
  'LOCK_UNKNOWN', 'LOCK_RECOVERY', 'READ_ONLY', 'INVALID_SETTINGS', 'NETWORK', 'STORAGE', 'SECRET_STORAGE', 'TOO_LARGE', 'UNSUPPORTED', 'BAD_RESPONSE', 'NOT_FOUND']);
const safeError = code => Object.assign(new Error(), { code: codes.has(code) ? code : 'BAD_RESPONSE' });
export function createSettingsClient(fetchImpl = fetch) {
  let token;
  let pendingToken;
  async function send(path, { method = 'GET', body, progress } = {}) {
    if (!/^\/(?:bootstrap|status|legacy(?:\/import)?|profiles\/[A-Za-z0-9_-]+|slots\/[A-Za-z]+|secrets\/[A-Za-z0-9_-]+|ui|export|import|test|models|diagnostics|images)?$/.test(path)) throw safeError('INVALID_SETTINGS');
    if (method !== 'GET' && !token) {
      pendingToken ||= send('/bootstrap').then(result => { token = result.token; }).finally(() => { pendingToken = null; });
      await pendingToken;
    }
    let response;
    try {
      response = await fetchImpl('/api/settings' + path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(method === 'GET' ? 5000 : Math.min(65000, (body?.timeoutMs || 20000) + 5000)),
        headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(method !== 'GET' && { 'X-Settings-Token': token }),
          ...(progress && { Accept: 'application/x-ndjson' }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    } catch { throw safeError('NETWORK'); }
    if (!response.ok) {
      let data;
      try { data = await response.json(); } catch {}
      if (response.status === 403) token = undefined;
      throw safeError(data?.error?.code);
    }
    if (progress && response.headers.get('content-type')?.includes('application/x-ndjson')) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let result;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          if (pending.length > 16384) throw safeError('BAD_RESPONSE');
          let index;
          while ((index = pending.indexOf('\n')) >= 0) {
            const data = JSON.parse(pending.slice(0, index)); pending = pending.slice(index + 1);
            if (['connecting', 'first_byte', 'done'].includes(data.phase)) progress(data.phase);
            if (data.result) result = data.result;
          }
        }
      } catch { throw safeError('BAD_RESPONSE'); }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!result) throw safeError('BAD_RESPONSE');
      return result;
    }
    try { return await response.json(); } catch { throw safeError('BAD_RESPONSE'); }
  }
  return { get: path => send(path), write: (path, body, method = 'PUT') => send(path, { method, body }),
    test: (body, progress) => send('/test', { method: 'POST', body, progress }) };
}
