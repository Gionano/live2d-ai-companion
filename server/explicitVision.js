import { describeFrame } from './visionCapture.js';

// Each requested source owns its cancellation and capture-session validation.
export async function inspectVision({ decision, socket, manager, input, image, screenImage,
  captureSnapshot, signal, isCurrent, send, captureScreen, describe = describeFrame, onSuccess = () => {} }) {
  const desktop = input.desktop === true;
  const completed = new Map();
  const contexts = await Promise.all(decision.sources.map(async source => {
    const label = source === 'screen' ? 'Layar' : 'Kamera';
    let frame = source === 'screen' ? screenImage : image;
    const desktopScreenOn = desktop && input.screenVisionOn === true;
    const available = Boolean(frame) || source === 'screen' && desktopScreenOn;
    if (!available) {
      const message = source === 'screen' ? desktop
        ? 'Screen Vision sedang off. Aktifkan lewat menu tray.'
        : 'Layar belum di-share. Aktifkan tombol Share Screen terlebih dahulu.'
        : 'Kamera belum aktif.';
      if (isCurrent()) send({ type: 'vision', text: message });
      return `[${label} unavailable] ${message} Do not claim to see this source or substitute another source.`;
    }
    const initial = captureSnapshot?.sources?.[source] ?? manager.getSourceSnapshot()[source];
    const captureSessionId = initial?.active ? initial.sessionId : null;
    const physical = captureSnapshot?.captureSessions?.[source];
    const tokens = input.captureSessions;
    const hasToken = tokens && typeof tokens === 'object' && !Array.isArray(tokens) && Object.hasOwn(tokens, source);
    const token = hasToken ? tokens[source] : null;
    const controller = new AbortController();
    socket.explicitVisionControllers.get(source)?.abort();
    socket.explicitVisionControllers.set(source, controller);
    const forward = () => controller.abort(signal.reason);
    signal.addEventListener('abort', forward, { once: true });
    if (signal.aborted) forward();
    const captureChanged = () => {
      const capture = socket.captureSessions[source];
      const current = captureSessionId ? manager.getSourceSnapshot()[source] : null;
      return hasToken && (typeof token !== 'string'
        || !capture?.active || capture.sessionId !== token)
        || physical?.active && (!capture?.active || capture.sessionId !== physical.sessionId)
        || !hasToken && captureSessionId && (!current?.active || current.sessionId !== captureSessionId);
    };
    const requireCurrentSource = () => {
      if (!isCurrent() || controller.signal.aborted || captureChanged()) {
        throw Object.assign(new Error('Capture source retired.'), { code: 'VISION_SOURCE_RETIRED' });
      }
    };
    try {
      requireCurrentSource();
      if (!frame && source === 'screen' && desktopScreenOn) {
        const capture = await captureScreen();
        requireCurrentSource();
        if (!capture.ok) {
          send({ type: 'vision', text: capture.spoken });
          return `LAYAR_GAGAL: Fresh screen capture failed. Do not use cached observations. ${capture.spoken}`;
        }
        frame = capture.dataUrl;
      }
      const description = await describe(frame, source, { signal: controller.signal, question: decision.question });
      requireCurrentSource();
      if (typeof description !== 'string' || !description.trim()) throw new Error('Empty observation.');
      send({ type: 'vision', text: `[${label}] ${description}` });
      completed.set(source, captureChanged);
      return `[${label} requested fresh inspection] ${description}`;
    } catch (error) {
      if (!isCurrent() || signal.aborted) return null;
      if (error.code === 'VISION_SOURCE_RETIRED' || controller.signal.aborted) {
        send({ type: 'vision', text: `${label} berubah saat sedang dilihat. Pengamatan tadi tidak berlaku.` });
        return `VISION_SOURCE_RETIRED: ${label} stopped or switched during inspection. Do not use its observation or cached descriptions as current context.`;
      }
      send({ type: 'error', message: `Vision ${label.toLowerCase()} gagal. Coba sekali lagi ya.` });
      return `VISION_FRESH_FAILED: Fresh inspection of ${label} failed. Do not use cached observations or claim a verified view.`;
    } finally {
      signal.removeEventListener('abort', forward);
      controller.abort();
      if (socket.explicitVisionControllers.get(source) === controller) socket.explicitVisionControllers.delete(source);
    }
  }));
  for (let index = 0; index < decision.sources.length; index++) {
    const source = decision.sources[index];
    const changed = completed.get(source);
    if (!changed) continue;
    if (!isCurrent() || signal.aborted) contexts[index] = null;
    else if (changed()) contexts[index] = `VISION_SOURCE_RETIRED: ${source} changed while another source was inspected. Do not use its previous observation.`;
    else onSuccess(source);
  }
  return '[Requested visual inspection; answer only from the successful fresh observations below]\n'
    + contexts.filter(Boolean).join('\n');
}
