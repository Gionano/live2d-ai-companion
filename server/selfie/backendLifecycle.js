import { WebSocket } from 'ws';

function providerUnavailable(manager, failed = false) {
  return {
    ok: false,
    reason: 'PROVIDER_UNAVAILABLE',
    text: manager.pickPhrase('providerUnavailable') || (failed
      ? 'Generator gambar lokal belum aktif nih sayang.'
      : 'Aduh sayang, generator gambar lokal sedang mati. Coba nyalakan ComfyUI dulu yaa.'),
    emotion: 'malu',
  };
}

function cancelled(manager) {
  return {
    ok: false,
    reason: 'CANCELLED',
    text: manager.pickPhrase('cancelled') || 'Pengambilan fotonya sudah aku batalkan ya sayang.',
    emotion: 'netral',
  };
}

export async function prepareSelfieJob({ manager, planner, userText, history, signal }) {
  signal?.throwIfAborted();
  // Reserve before either provider availability or cloud planning can yield.
  const admission = manager.tryAdmit();
  if (!admission.allowed) return { ...admission, ok: false };

  let submitted = false;
  const onAbort = () => {
    if (!submitted) void manager.cancelJob(admission.jobId);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    try {
      const provider = await manager.getProvider();
      signal?.throwIfAborted();
      if (!manager.isAdmitted(admission.jobId)) return cancelled(manager);
      const available = await provider.isAvailable();
      signal?.throwIfAborted();
      if (!manager.isAdmitted(admission.jobId)) return cancelled(manager);
      if (!available) return providerUnavailable(manager);
    } catch {
      signal?.throwIfAborted();
      if (!manager.isAdmitted(admission.jobId)) return cancelled(manager);
      return providerUnavailable(manager, true);
    }

    const planned = await planner({ userText, history, signal });
    signal?.throwIfAborted();
    if (!manager.isAdmitted(admission.jobId)) return cancelled(manager);
    if (!planned.ok) {
      return {
        ok: false,
        reason: planned.reason || 'PLANNING_FAILED',
        text: planned.blocked ? planned.refusalText
          : manager.pickPhrase('failed') || 'Maaf sayang, fotonya belum bisa diproses sekarang.',
        emotion: planned.blocked ? planned.emotion : 'malu',
      };
    }

    const result = await manager.submitJob({
      plan: planned.plan,
      admission,
      skipInitialSpeech: true,
    });
    submitted = result.ok;
    return {
      ...result,
      plan: submitted ? planned.plan : null,
      text: result.text || (!submitted
        ? manager.pickPhrase('failed') || 'Maaf sayang, fotonya belum bisa diproses sekarang.'
        : undefined),
      emotion: result.emotion || 'malu',
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!submitted) await manager.cancelJob(admission.jobId);
  }
}

export function installSelfieLifecycle({
  manager,
  server,
  wss,
  signals = process,
  exit = code => process.exit(code),
  warn = message => console.warn(message),
}) {
  let shutdownPromise = null;
  let signalled = false;
  const shutdown = () => {
    if (!shutdownPromise) shutdownPromise = Promise.resolve().then(() => manager.shutdown());
    return shutdownPromise;
  };
  const onConnection = (socket) => {
    if (socket.isMonitor) return;
    manager.sendSnapshot((event) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
    });
  };
  const onClose = () => {
    void shutdown().catch(err => warn(`[selfie] Shutdown failed: ${err.message}`));
  };
  const onSignal = () => {
    if (signalled) return;
    signalled = true;
    server.close();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    void shutdown().then(() => exit(0), (err) => {
      warn(`[selfie] Shutdown failed: ${err.message}`);
      exit(1);
    });
  };

  wss.on('connection', onConnection);
  server.on('close', onClose);
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);
  return {
    shutdown,
    dispose() {
      wss.off('connection', onConnection);
      server.off('close', onClose);
      signals.off('SIGINT', onSignal);
      signals.off('SIGTERM', onSignal);
    },
  };
}
