const controllers = new WeakMap();

export function getBrowserChat(document) {
  return controllers.get(document) || null;
}

export function browserChatEnabled({ desktopBridge, overlay = false } = {}) {
  return !desktopBridge && !overlay;
}

function icon(document, kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', kind === 'crystal'
    ? 'M12 2 20 9 12 22 4 9 12 2ZM4 9h16M12 2 9 9l3 13 3-13-3-7'
    : 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z');
  svg.append(path);
  if (kind !== 'crystal') {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '3');
    svg.append(circle);
  }
  return svg;
}

// Owns presentation only; conversation, capture, and speech stay in companion.js.
export function mountBrowserChat({ document = globalThis.document, canOpenSettings = false,
  openSettings = () => { document.defaultView.location.hash = 'settings'; } } = {}) {
  if (!browserChatEnabled({ desktopBridge: document.defaultView?.desktopBridge,
    overlay: new URLSearchParams(document.defaultView?.location.search || '').get('mode') === 'overlay' })) return null;
  if (controllers.has(document)) return controllers.get(document);
  const panel = document.getElementById('companion-panel');
  const log = document.getElementById('chat-log');
  const form = document.getElementById('chat-form');
  const originalInput = document.getElementById('chat-input');
  const send = document.getElementById('chat-send');
  if (!panel || !log || !form || !originalInput || !send) return null;
  const el = (tag, text, className) => {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  };
  document.documentElement.classList.add('browser-workspace');
  panel.setAttribute('aria-label', 'Obrolan dengan Amika');
  const head = panel.querySelector('.panel-head');
  const name = head.querySelector('h3');
  const mic = document.getElementById('mic-status');
  const share = document.getElementById('screen-share-btn');
  const brand = el('div', undefined, 'browser-chat-brand');
  brand.append(icon(document, 'crystal'), name);
  head.replaceChildren(brand, mic);
  const actions = el('div', undefined, 'browser-chat-actions');
  if (share) {
    share.textContent = 'Bagikan layar';
    share.title = 'Bagikan layar agar Amika bisa melihatnya';
    share.setAttribute('aria-pressed', 'false');
    actions.append(share);
  }
  if (canOpenSettings) {
    const settings = el('button', undefined, 'browser-settings-button');
    settings.type = 'button';
    settings.title = 'Pengaturan';
    settings.setAttribute('aria-label', 'Pengaturan');
    settings.append(icon(document, 'settings'));
    settings.addEventListener('click', openSettings);
    actions.append(settings);
  }
  head.after(actions);
  const connection = el('p', 'Menghubungkan ke server…', 'browser-connection-status');
  connection.setAttribute('role', 'status');
  connection.setAttribute('aria-live', 'polite');
  actions.after(connection);
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', 'Percakapan');
  // Completed replies have a separate announcer so deltas are not read aloud.
  log.setAttribute('aria-live', 'off');
  const empty = el('div', undefined, 'browser-chat-empty');
  empty.append(el('p', 'Sapa Amika.'), el('p', 'Bicara atau ketik untuk memulai.', 'browser-desktop-hint'),
    el('p', 'Sentuh layar, lalu mulai bicara.', 'browser-mobile-hint'));
  log.append(empty);
  const unread = el('button', 'Pesan baru', 'browser-chat-unread');
  unread.type = 'button'; unread.hidden = true;
  log.after(unread);
  const activity = el('details', undefined, 'browser-chat-activity');
  const activitySummary = el('summary', 'Aktivitas');
  const activityLog = el('div', undefined, 'browser-activity-log');
  activity.append(activitySummary, activityLog);
  form.before(activity);
  const input = el('textarea');
  input.id = 'chat-input'; input.rows = 2; input.maxLength = 1000;
  input.placeholder = 'Ketik pesan…'; input.value = originalInput.value;
  input.setAttribute('aria-label', 'Pesan untuk Amika');
  input.setAttribute('aria-describedby', 'browser-chat-input-help');
  originalInput.replaceWith(input);
  send.disabled = true;
  const help = el('p', 'Enter untuk kirim · Shift+Enter untuk baris baru', 'browser-chat-input-help');
  help.id = 'browser-chat-input-help'; form.after(help);
  const announcer = el('p', '', 'browser-chat-announcer');
  announcer.setAttribute('role', 'status');
  announcer.setAttribute('aria-live', 'polite');
  announcer.setAttribute('aria-atomic', 'true');
  panel.append(announcer);
  const messages = new WeakMap();
  let connected = false;
  let busy = false;
  let activityCount = 0;
  const nearBottom = () => log.scrollHeight - log.clientHeight - log.scrollTop <= 48;
  const bottom = () => { log.scrollTop = log.scrollHeight; unread.hidden = true; };
  const afterMessage = pinned => { if (pinned) bottom(); else unread.hidden = false; };
  const syncSend = () => { send.disabled = !connected || busy || !input.value.trim(); };
  const resizeInput = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(140, Math.max(64, input.scrollHeight)) + 'px';
    syncSend();
  };
  const onScroll = () => { if (nearBottom()) unread.hidden = true; };
  const onKey = event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!send.disabled) form.requestSubmit(send);
  };
  input.addEventListener('input', resizeInput);
  input.addEventListener('keydown', onKey);
  log.addEventListener('scroll', onScroll);
  unread.addEventListener('click', bottom);
  const controller = {
    log(text, type = '', { streaming = false } = {}) {
      if (!['user', 'assistant', 'error'].includes(type)) {
        const item = el('p', String(text), 'browser-activity-line');
        activityLog.append(item);
        activitySummary.textContent = 'Aktivitas (' + ++activityCount + ')';
        return item;
      }
      const pinned = nearBottom();
      empty.remove();
      const item = el(type === 'error' ? 'div' : 'article', undefined, 'log-line ' + type);
      const body = el('p', String(text), 'browser-message-text');
      if (type === 'error') item.setAttribute('role', 'alert');
      else item.append(el('span', type === 'user' ? 'Kamu' : 'Amika', 'browser-message-author'));
      item.append(body);
      log.append(item);
      messages.set(item, { body, type, announced: false });
      afterMessage(pinned);
      if (type === 'assistant' && !streaming) controller.complete(item);
      return item;
    },
    update(item, text) {
      const message = messages.get(item);
      if (!message) return;
      const pinned = nearBottom();
      message.body.textContent = String(text);
      afterMessage(pinned);
    },
    complete(item) {
      const message = messages.get(item);
      if (!message || message.type !== 'assistant' || message.announced || !message.body.textContent.trim()) return;
      message.announced = true;
      announcer.textContent = 'Amika: ' + message.body.textContent;
    },
    setConnection(value) {
      connected = value === true;
      connection.hidden = connected;
      connection.textContent = connected ? '' : 'Terputus. Mencoba menyambung kembali…';
      syncSend();
    },
    setBusy(value) {
      busy = value === true;
      input.disabled = busy;
      input.placeholder = busy ? 'Amika sedang merespons…' : 'Ketik pesan…';
      form.setAttribute('aria-busy', String(busy));
      syncSend();
    },
    resetComposer() { input.value = ''; resizeInput(); },
    dispose() {
      input.removeEventListener('input', resizeInput);
      input.removeEventListener('keydown', onKey);
      log.removeEventListener('scroll', onScroll);
      unread.removeEventListener('click', bottom);
      controllers.delete(document);
    },
  };
  controllers.set(document, controller);
  return controller;
}
