import { node } from './dom.js';

const STATE_KEYS = { ready: 'memory.ready', running: 'memory.ready', external: 'memory.external', starting: 'memory.starting',
  disabled: 'memory.disabled', stopped: 'memory.offline', offline: 'memory.offline', not_installed: 'memory.notInstalled',
  unavailable: 'memory.offline', error: 'memory.failed', blocked: 'memory.failed', failed: 'memory.failed',
  not_started: 'memory.offline', checking: 'memory.starting', verifying: 'memory.starting',
  setup_required: 'memory.notInstalled', disposed: 'memory.offline' };
const JOB_STATE_KEYS = { pending: 'memory.jobQueued', queued: 'memory.jobQueued', running: 'memory.jobRunning',
  done: 'memory.jobDone', completed: 'memory.jobDone', failed: 'memory.jobFailed', blocked: 'memory.jobFailed' };
const JOB_TYPE_KEYS = { extract: 'memory.jobExtract', write: 'memory.jobExtract', enrich: 'memory.jobExtract',
  embed: 'memory.jobEmbed', embedding: 'memory.jobEmbed', reindex: 'memory.jobReindex' };

// Memory is fetched only for this settings panel and is never put in browser storage.
export function mountMemorySettings(parent, { document = globalThis.document, api, t, fail = () => {},
  confirm = message => globalThis.confirm(message), onVersion = () => {}, pollMs = 2000,
  onDirtyChange = () => {}, setTimer = globalThis.setInterval, clearTimer = globalThis.clearInterval } = {}) {
  let disposed = false;
  let busy = false;
  let loading = false;
  let snapshot;
  let configured = false;
  let savedConfiguration;
  let dirty = false;
  let configCancel;
  let manualCancel;
  let fieldId = 0;
  let facts = { items: [], nextCursor: null };
  let events = { items: [], nextCursor: null };
  const el = (tag, text, attributes) => node(document, tag, text, attributes);
  const section = title => {
    const box = el('section', undefined, { class: 'settings-card' });
    box.append(el('h3', t(title))); parent.append(box); return box;
  };
  const button = (label, action, box, attributes = {}) => {
    const item = el('button', t(label), { type: 'button', ...attributes }); box.append(item);
    item.addEventListener('click', () => {
      if (!disposed && !busy) Promise.resolve().then(action).catch(error => { if (!disposed) fail(error); });
    });
    return item;
  };
  const field = (box, key, { type = 'text', options, ...attributes } = {}) => {
    const label = el('label', t(key), { class: 'settings-field' });
    const input = el(options ? 'select' : type === 'textarea' ? 'textarea' : 'input', undefined,
      { id: 'memory-field-' + ++fieldId, ...attributes });
    label.setAttribute('for', input.id);
    if (options) for (const [value, key] of options) input.append(el('option', t(key), { value }));
    else if (type !== 'textarea') input.type = type;
    label.append(input); box.append(label); return input;
  };
  const date = value => {
    const result = new Date(value);
    return Number.isFinite(result.getTime()) ? result.toLocaleString(document.documentElement.lang || 'id') : '';
  };
  const count = (status, key) => Number.isFinite(status.counts?.[key]) ? status.counts[key]
    : Number.isFinite(status[key]) ? status[key] : 0;
  parent.append(el('h2', t('tab.memory')), el('p', t('memory.intro')));
  const statusBox = section('memory.status');
  const summary = el('div', undefined, { role: 'status', 'aria-live': 'polite', 'data-memory-status': '' });
  statusBox.append(summary);
  button('action.refresh', () => refresh(true), statusBox, { 'data-memory-refresh': '' });

  const configForm = el('form', undefined, { class: 'settings-card' }); parent.append(configForm);
  configForm.append(el('h3', t('memory.configuration')), el('p', t('memory.retention')));
  const managed = field(configForm, 'memory.managed', { type: 'checkbox' });
  const device = field(configForm, 'memory.device', { options: [['auto', 'memory.deviceAuto'], ['cuda', 'memory.deviceCuda'], ['cpu', 'memory.deviceCpu']] });
  for (const input of [managed, device]) for (const event of ['input', 'change']) input.addEventListener(event, updateDirty);
  const setupDetails = el('details'); setupDetails.append(el('summary', t('slot.advanced'))); configForm.append(setupDetails);
  setupDetails.append(el('p', t('memory.setupHelp')), el('pre', 'npm.cmd run memory:plan\nnpm.cmd run setup:memory -- --accept-license=bge-m3 --accept-license=pytorch --accept-license=transformers --accept-license=huggingface-hub\nnpm.cmd run memory:doctor'),
    el('p', t('memory.setupNoDownload')), el('a', t('memory.modelLink'), { href: 'https://huggingface.co/BAAI/bge-m3', target: '_blank', rel: 'noopener noreferrer' }));
  configForm.append(el('button', t('action.save'), { type: 'submit' }));
  configCancel = button('action.cancelChanges', () => { resetConfiguration(); updateDirty(); }, configForm);
  configCancel.disabled = true;
  configForm.addEventListener('submit', event => {
    event.preventDefault();
    if (disposed || busy || !snapshot) return;
    const locked = [managed, device].map(input => [input, input.disabled]);
    for (const [input] of locked) input.disabled = true;
    void change(async () => {
      const result = await api.write('/memory/config', { version: snapshot.version,
        memory: { managedEmbedding: managed.checked, embeddingDevice: device.value } });
      applySnapshot(result);
    }).catch(error => { if (!disposed) fail(error); }).finally(() => {
      for (const [input, disabled] of locked) input.disabled = disabled;
    });
  });
  button('memory.retryEmbedding', () => mutate('/memory/embedding/retry', {}, 'POST'), configForm);

  const searchForm = el('form', undefined, { class: 'settings-card' }); parent.append(searchForm);
  searchForm.append(el('h3', t('memory.search')));
  const query = field(searchForm, 'memory.query', { maxlength: 4096, required: '' });
  searchForm.append(el('button', t('memory.search'), { type: 'submit' }));
  const searchResults = el('div', undefined, { 'aria-live': 'polite', 'data-memory-search-results': '' }); searchForm.append(searchResults);
  searchForm.addEventListener('submit', event => {
    event.preventDefault();
    if (disposed || busy || !query.value.trim()) return;
    void change(async () => {
      const result = await api.write('/memory/search', { query: query.value.trim() }, 'POST');
      if (disposed) return;
      searchResults.replaceChildren();
      const diagnostics = result.diagnostics || {};
      searchResults.append(el('p', t('memory.searchTiming', { method: diagnostics.method || 'keyword',
        duration: Math.round(diagnostics.durationMs || 0) })));
      for (const fact of result.facts || []) renderFact(searchResults, fact);
      for (const event of result.events || []) renderEvent(searchResults, event);
      if (!(result.facts?.length || result.events?.length)) searchResults.append(el('p', t('memory.empty')));
    }, false).catch(error => { if (!disposed) fail(error); });
  });

  const manualForm = el('form', undefined, { class: 'settings-card' }); parent.append(manualForm);
  manualForm.append(el('h3', t('memory.manual')), el('p', t('memory.manualHelp')));
  const manual = field(manualForm, 'memory.factText', { type: 'textarea', rows: 3, maxlength: 4096, required: '' });
  for (const event of ['input', 'change']) manual.addEventListener(event, updateDirty);
  manualForm.append(el('button', t('memory.saveFact'), { type: 'submit' }));
  manualCancel = button('action.cancelChanges', () => { manual.value = ''; updateDirty(); }, manualForm);
  manualCancel.disabled = true;
  manualForm.addEventListener('submit', event => {
    event.preventDefault();
    if (disposed || busy || !snapshot || !manual.value.trim()) return;
    const submittedText = manual.value;
    void mutate('/memory/fact', { text: submittedText.trim(), category: 'manual', memoryRevision: snapshot.status.revision }, 'POST')
      .then(() => { if (!disposed) { if (manual.value === submittedText) manual.value = ''; updateDirty(); } })
      .catch(error => { if (!disposed) fail(error); });
  });

  function configurationDirty() {
    return Boolean(configured && savedConfiguration && (managed.checked !== savedConfiguration.managedEmbedding
      || device.value !== savedConfiguration.embeddingDevice));
  }
  function isDirty() { return configurationDirty() || Boolean(manual.value); }
  function updateDirty() {
    const next = isDirty();
    if (configCancel) configCancel.disabled = !configurationDirty();
    if (manualCancel) manualCancel.disabled = !manual.value;
    if (next !== dirty) { dirty = next; onDirtyChange(next); }
  }
  function resetConfiguration() {
    if (!savedConfiguration) return;
    managed.checked = savedConfiguration.managedEmbedding; device.value = savedConfiguration.embeddingDevice;
  }
  function discardChanges() {
    if (disposed || busy) return;
    resetConfiguration(); manual.value = ''; updateDirty();
  }

  const factsBox = section('memory.facts');
  const factRecords = el('div', undefined, { 'data-memory-facts': '' }); factsBox.append(factRecords);
  const moreFacts = button('memory.more', () => loadPage('facts'), factsBox);
  const eventsBox = section('memory.dialogue');
  const eventRecords = el('div', undefined, { 'data-memory-events': '' }); eventsBox.append(eventRecords);
  const moreEvents = button('memory.more', () => loadPage('events'), eventsBox);
  const jobsBox = section('memory.jobs');
  const jobs = el('div', undefined, { 'aria-live': 'polite', 'data-memory-jobs': '' }); jobsBox.append(jobs);
  button('memory.reindex', async () => {
    if (snapshot && confirm(t('memory.confirmReindex'))) await mutate('/memory/reindex', { memoryRevision: snapshot.status.revision }, 'POST');
  }, jobsBox);
  const removal = section('memory.deletion');
  removal.append(el('p', t('memory.deleteHelp')));
  button('memory.clear', async () => {
    await refresh(false);
    if (!snapshot || disposed || !confirm(t('memory.confirmClear'))) return;
    await mutate('/memory/clear', { memoryRevision: snapshot.status.revision }, 'POST');
    searchResults.replaceChildren();
  }, removal);

  function renderFact(box, fact) {
    const item = el('article', undefined, { class: 'settings-record', 'data-memory-fact': fact.id || '' });
    item.append(el('p', fact.text || [fact.subject, fact.predicate, fact.value].filter(Boolean).join(' — ')));
    const origin = fact.origin === 'legacy' || fact.legacy ? 'memory.legacy' : fact.origin === 'manual' ? 'memory.manualOrigin' : 'memory.verified';
    item.append(el('p', t(origin)));
    if (fact.status === 'uncertain') item.append(el('p', t('memory.uncertain')));
    if (fact.status === 'superseded') item.append(el('p', t('memory.superseded')));
    if (fact.createdAt || fact.timestamp) item.append(el('p', date(fact.createdAt || fact.timestamp)));
    for (const quote of fact.quotes || []) {
      const evidence = el('blockquote', quote.text || quote.quote || '');
      evidence.append(el('footer', t(quote.speaker === 'user' ? 'memory.userQuote' : 'memory.assistantQuote') + ' · ' + (quote.eventId || '')));
      item.append(evidence);
    }
    if (fact.id) button('action.delete', () => remove('facts', fact.id), item);
    box.append(item);
  }
  function renderEvent(box, event) {
    const item = el('article', undefined, { class: 'settings-record', 'data-memory-event': event.id || event.eventId || '' });
    item.append(el('p', date(event.timestamp || event.createdAt) + ' · ' + t(event.origin === 'proactive' ? 'memory.proactive'
      : event.origin === 'vision' ? 'memory.visualCommentary' : 'memory.conversation')));
    if (event.userText) item.append(el('p', t('memory.user') + ': ' + event.userText));
    if (event.assistantText) item.append(el('p', t('memory.assistant') + ': ' + event.assistantText));
    const id = event.id || event.eventId;
    if (id) button('action.delete', () => remove('events', id), item);
    box.append(item);
  }
  async function remove(kind, id) {
    const impact = await api.get('/memory/' + kind + '/' + encodeURIComponent(id) + '/impact');
    if (disposed || !confirm(t('memory.confirmDelete', { events: impact.eventCount, facts: impact.factCount, episodes: impact.episodeCount }))) return;
    await mutate('/memory/' + kind + '/' + encodeURIComponent(id), { memoryRevision: impact.revision }, 'DELETE');
    searchResults.replaceChildren();
  }
  function renderPages() {
    factRecords.replaceChildren(); eventRecords.replaceChildren();
    for (const fact of facts.items) renderFact(factRecords, fact);
    for (const event of events.items) renderEvent(eventRecords, event);
    if (!facts.items.length) factRecords.append(el('p', t('memory.empty')));
    if (!events.items.length) eventRecords.append(el('p', t('memory.empty')));
    moreFacts.disabled = !facts.nextCursor; moreEvents.disabled = !events.nextCursor;
  }
  function applySnapshot(value) {
    if (disposed) return;
    const preserveConfiguration = configurationDirty();
    snapshot = value; onVersion(value.version);
    const status = value.status || {};
    summary.replaceChildren(el('p', t(STATE_KEYS[value.embedding?.state] || 'memory.offline')),
      el('p', t('memory.counts', { events: count(status, 'events'), facts: count(status, 'facts'), episodes: count(status, 'episodes') })),
      el('p', t('memory.keywordFallback')));
    summary.append(el('p', t(status.writerReady ? 'memory.writerReady' : 'memory.writerUnavailable')));
    if (status.ready === false) summary.append(el('p', t('memory.storageUnavailable')));
    if (status.indexState === 'pending') summary.append(el('p', t('memory.indexPending')));
    if (status.indexState === 'reindex_required') summary.append(el('p', t('memory.reindexRequired')));
    if (status.retrieval) summary.append(el('p', t('memory.searchTiming', { method: status.retrieval.method || 'keyword',
      duration: Math.round(status.retrieval.durationMs || 0) })));
    if (value.embedding?.reason || value.embedding?.errorCode) summary.append(el('p', t('memory.actionableFailure')));
    savedConfiguration = { managedEmbedding: value.configuration?.managedEmbedding !== false,
      embeddingDevice: value.configuration?.embeddingDevice || 'auto' };
    if (!configured || !preserveConfiguration) resetConfiguration();
    configured = true; updateDirty();
    jobs.replaceChildren();
    for (const job of status.jobs || []) {
      const item = el('article', undefined, { class: 'settings-record' });
      item.append(el('p', t('memory.job', { type: t(JOB_TYPE_KEYS[job.type] || 'memory.jobOther'),
        state: t(JOB_STATE_KEYS[job.state] || 'memory.jobQueued'), attempt: job.attempt || 0 })));
      if (job.errorCode) item.append(el('p', t('memory.jobError', { code: job.errorCode })));
      if (job.state === 'failed' || job.state === 'blocked') button('memory.retryJob',
        () => mutate('/memory/jobs/' + encodeURIComponent(job.id) + '/retry', { memoryRevision: snapshot.status.revision }, 'POST'), item);
      jobs.append(item);
    }
    if (!status.jobs?.length) jobs.append(el('p', t('memory.noJobs')));
  }
  async function refresh(includeLists = true) {
    if (disposed || loading) return;
    loading = true;
    try {
      const results = await Promise.all([api.get('/memory'), ...(includeLists
        ? [api.get('/memory/facts?limit=20'), api.get('/memory/events?limit=20')] : [])]);
      if (disposed) return;
      applySnapshot(results[0]);
      if (includeLists) { facts = results[1]; events = results[2]; renderPages(); }
    } finally { loading = false; }
  }
  async function change(operation, reload = true) {
    if (disposed || busy) return;
    busy = true; parent.setAttribute('aria-busy', 'true');
    try { await operation(); if (reload && !disposed) await refresh(true); }
    catch (error) { if (!disposed && ['CONFLICT', 'MEMORY_STALE'].includes(error.code)) await refresh(true).catch(() => {}); throw error; }
    finally { busy = false; if (!disposed) parent.removeAttribute('aria-busy'); }
  }
  async function mutate(path, body, method) {
    return change(async () => { const result = await api.write(path, body, method); applySnapshot(result); });
  }
  async function loadPage(kind) {
    const current = kind === 'facts' ? facts : events;
    if (!current.nextCursor) return;
    return change(async () => {
      const next = await api.get('/memory/' + kind + '?limit=20&cursor=' + encodeURIComponent(current.nextCursor));
      if (disposed) return;
      const combined = { items: [...current.items, ...next.items], nextCursor: next.nextCursor };
      if (kind === 'facts') facts = combined; else events = combined;
      renderPages();
    }, false);
  }
  const ready = refresh(true).catch(error => { if (!disposed) fail(error); });
  const timer = setTimer(() => { if (!disposed && !busy) void refresh(false).catch(error => { if (!disposed) fail(error); }); }, pollMs);
  timer?.unref?.();
  return { ready, refresh, isDirty, discardChanges, dispose() { disposed = true; clearTimer(timer); } };
}
