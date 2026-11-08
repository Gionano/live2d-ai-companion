import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MemoryStore, MemoryError, atomicWrite, readFile, lease, digest, safeId, alive, validateEvent, newState } from './memory/store.js';
import { WRITER_PROMPT, parseWriterResult, validateFact, publishFact } from './memory/evidence.js';
import { resolveQuery, documents, embeddingDocuments, bm25, normalizedVector, cosine, fuse,
  duplicateEvent, renderBundle } from './memory/retrieval.js';

export { MemoryError, WRITER_PROMPT };
const DEFAULT_DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const RETRY_DELAYS = [60000, 300000, 1200000];
const TRANSIENT = new Set(['NETWORK', 'SERVER', 'RATE_LIMIT', 'TIMEOUT', 'MEMORY_STORAGE', 'LOCK_BUSY']);
const clone = value => structuredClone(value);
const errorCode = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'MEMORY_OPERATION_FAILED';

function projectProfile(state) {
  for (const [field, predicates] of [['userName', ['name', 'user_name']], ['nickname', ['nickname']]]) {
    const candidates = state.facts.filter(fact => fact.subject?.toLocaleLowerCase() === 'user'
      && predicates.includes(fact.predicate?.toLocaleLowerCase().replace(/[ -]+/g, '_'))
      && ['active', 'legacy'].includes(fact.status)).sort((a, b) =>
      Number(b.status === 'active') - Number(a.status === 'active') || b.timestamp - a.timestamp);
    state.profile[field] = candidates[0]?.value || (field === 'nickname' ? 'sayang' : '');
  }
  state.profile.legacy = state.facts.some(fact => fact.origin === 'legacy' && fact.category === 'profile');
}

function embeddingIdentity(provider) {
  if (!provider || typeof provider.embed !== 'function') return null;
  return digest(JSON.stringify({ model: provider.model || null, configuredDimensions: provider.configuredDimensions || null,
    provider: provider.providerId || null, url: provider.profile?.baseUrl || null,
    configuredRevision: provider.configuredRevision || null }));
}

async function bounded(operation, { signal, timeoutMs }) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timer;
  let onAbort;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new MemoryError('TIMEOUT', 504);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    onAbort = () => { controller.abort(signal.reason); reject(signal.reason || new MemoryError('ABORTED', 499)); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), deadline]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

function paginate(items, { cursor, limit = 25 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MemoryError('INVALID_MEMORY', 400);
  if (cursor !== undefined && cursor !== null && (!/^\d+$/.test(String(cursor)) || Number(cursor) > Number.MAX_SAFE_INTEGER)) {
    throw new MemoryError('INVALID_MEMORY', 400);
  }
  const offset = Number(cursor || 0);
  return { items: clone(items.slice(offset, offset + limit)), nextCursor: offset + limit < items.length ? String(offset + limit) : null };
}

export class MemoryManager {
  constructor({ dataDir = process.env.WAIFU_DATA_DIR || DEFAULT_DATA_DIR, now = Date.now,
    getWriter = () => null, getEmbedding = () => null, extractDelayMs = 120000,
    queryTimeoutMs = 300, jobTimeoutMs = 30000, pollMs = 1000, minimumSimilarity = 0.5 } = {}) {
    Object.assign(this, { dataDir, now, getWriter, getEmbedding, extractDelayMs, queryTimeoutMs,
      jobTimeoutMs, pollMs, minimumSimilarity });
    this.queryCache = new Map();
    this.lastRetrieval = null;
    this.running = false;
    this.disposed = false;
    this.storageError = null;
  }

  configure(options = {}) {
    for (const key of ['getWriter', 'getEmbedding', 'extractDelayMs', 'queryTimeoutMs', 'jobTimeoutMs', 'pollMs', 'minimumSimilarity']) {
      if (options[key] !== undefined) this[key] = options[key];
    }
    this.queryCache.clear();
    return this;
  }

  ensure() {
    if (!this.store) {
      const store = new MemoryStore(this.dataDir, { now: this.now });
      store.open();
      this.store = store;
    } else this.store.refresh();
    this.storageError = null;
    return this.store.state;
  }

  get generation() { return this.ensure().generation; }
  get revision() { return this.ensure().revision; }
  get memory() {
    let state;
    try { state = this.ensure(); } catch { state = newState(this.now()); }
    return clone({ version: 2, lastSeen: state.lastSeen,
      profile: { ...state.profile, facts: state.facts }, episodes: state.episodes });
  }

  formatTimeElapsed(lastTimestamp) {
    if (!lastTimestamp) return 'Belum ada percakapan selesai yang tersimpan.';
    const minutes = Math.max(0, Math.floor((this.now() - Number(lastTimestamp)) / 60000));
    if (minutes < 2) return 'Baru saja mengobrol.';
    if (minutes < 60) return `Terakhir mengobrol ${minutes} menit lalu.`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Terakhir mengobrol ${hours} jam lalu.`;
    return `Terakhir mengobrol ${Math.floor(hours / 24)} hari lalu.`;
  }

  // Legacy preview never injects unrelated recent facts or initializes storage on import.
  getMemoryPrompt() {
    const lastSeen = this.store?.state?.lastSeen;
    return lastSeen ? 'Conversation timing: ' + this.formatTimeElapsed(lastSeen)
      + '\nUse topic-relevant attributed evidence for recall; do not guess from an unrelated recent-facts list.' : '';
  }

  archiveCompleted(input, options = {}) {
    const state = this.ensure();
    const origin = typeof input.origin === 'string' ? input.origin : 'conversation';
    const id = input.eventId || 'event_' + digest(`${input.sessionId || ''}:${input.speechId || randomUUID()}`).slice(0, 40);
    const timestamp = Number.isFinite(input.timestamp) ? input.timestamp : this.now();
    const event = validateEvent({ id, sessionId: String(input.sessionId || ''), turnId: String(input.turnId || ''),
      speechId: String(input.speechId || ''), timestamp, origin,
      userText: origin === 'conversation' ? String(input.userText || '').trim() : '',
      assistantText: String(input.assistantText || '').trim() });
    return this.store.transact(current => {
      if (current.tombstones.includes(id)) throw new MemoryError('MEMORY_STALE', 409);
      const existing = this.store.event(id);
      if (existing) {
        if (existing.userText !== event.userText || existing.assistantText !== event.assistantText || existing.origin !== event.origin) {
          throw new MemoryError('DUPLICATE_MEMORY_EVENT', 409);
        }
        if (!current.eventIds.includes(id)) {
          current.eventIds.push(id);
          current.jobs.push(this.store.eventJob(id, 'extract', this.now() + this.extractDelayMs, current.generation),
            this.store.eventJob(id, 'embed', this.now(), current.generation));
        }
        return clone(existing);
      }
      // The immutable event precedes its extraction/index jobs for crash recovery.
      current.sequence = (current.sequence || 0) + 1;
      event.sequence = current.sequence;
      this.store.writeEvent(event);
      current.eventIds.push(id);
      current.lastSeen = Math.max(current.lastSeen || 0, timestamp);
      current.jobs.push(this.store.eventJob(id, 'extract', this.now() + this.extractDelayMs, current.generation),
        this.store.eventJob(id, 'embed', this.now(), current.generation));
      return clone(event);
    }, { generation: options.generation ?? state.generation, expectedRevision: options.expectedRevision });
  }

  recordTurnAndExtract(userText, assistantText, { completed = false, ...options } = {}) {
    if (!completed) return { skipped: true, reason: 'playback_required' };
    return this.archiveCompleted({ userText, assistantText, origin: 'conversation', ...options }, options);
  }

  corpus(state = this.ensure()) {
    return documents(state, state.eventIds.map(id => this.store.event(id)).filter(Boolean));
  }

  readVectors(marker) {
    if (!marker) return [];
    if (!/^vectors-[a-f0-9-]+\.f32$/.test(marker.file || '') || !Number.isSafeInteger(marker.dimensions)
      || marker.dimensions <= 0 || marker.dimensions > 8192 || !Array.isArray(marker.items)) throw new MemoryError('MEMORY_CORRUPT');
    const bytes = readFile(path.join(this.store.root, marker.file));
    if (!bytes || bytes.length !== marker.items.length * marker.dimensions * 4 || digest(bytes) !== marker.sha256) {
      throw new MemoryError('MEMORY_CORRUPT');
    }
    return marker.items.map((item, row) => ({ ...item, vector: normalizedVector(
      Array.from({ length: marker.dimensions }, (_, column) => bytes.readFloatLE((row * marker.dimensions + column) * 4)), marker.dimensions) }));
  }

  publishVectors(state, rows, metadata) {
    if (!rows.length) { state.vectors = null; return; }
    const file = 'vectors-' + randomUUID() + '.f32';
    const bytes = Buffer.alloc(rows.length * metadata.dimensions * 4);
    rows.forEach((row, index) => normalizedVector(row.vector, metadata.dimensions).forEach((value, column) => {
      bytes.writeFloatLE(value, (index * metadata.dimensions + column) * 4);
    }));
    atomicWrite(path.join(this.store.root, file), bytes);
    state.vectors = { ...metadata, file, sha256: digest(bytes), items: rows.map(({ vector, ...item }) => item) };
  }

  async retrieve(userMessage, { history = [], signal } = {}) {
    signal?.throwIfAborted();
    const started = performance.now();
    let state;
    try { state = clone(this.ensure()); }
    catch (error) {
      const diagnostics = { method: 'unavailable', fallbackReason: errorCode(error), durationMs: Math.round(performance.now() - started) };
      this.lastRetrieval = diagnostics;
      return { generation: null, revision: null, events: [], facts: [], episodes: [], diagnostics };
    }
    const query = resolveQuery(userMessage, history);
    const corpus = this.corpus(state);
    const keyword = bm25(corpus, query);
    let semantic = [];
    let fallbackReason = null;
    const provider = this.getEmbedding();
    const fingerprint = embeddingIdentity(provider);
    if (!query.trim()) fallbackReason = 'empty_query';
    else if (!fingerprint) fallbackReason = 'embedding_unavailable';
    else if (!state.vectors) fallbackReason = 'index_pending';
    else if (state.vectors.providerFingerprint !== fingerprint
      || provider.revision && provider.revision !== state.vectors.embeddingRevision) fallbackReason = 'reindex_required';
    else {
      try {
        const marker = state.vectors;
        const indexedVectors = this.readVectors(marker);
        const key = digest(fingerprint + ':' + (marker.embeddingRevision || '') + ':' + query.normalize('NFKC').toLocaleLowerCase());
        let result = this.queryCache.get(key);
        if (!result || this.now() - result.cachedAt > 30 * 60000) {
          result = await bounded(operationSignal => provider.embed({ texts: [query], taskType: 'query', signal: operationSignal }),
            { signal, timeoutMs: Math.max(1, this.queryTimeoutMs - (performance.now() - started)) });
          if (!result || result.model !== marker.model || result.dimensions !== marker.dimensions
            || (result.revision ?? null) !== (marker.embeddingRevision ?? null) || result.vectors?.length !== 1) {
            throw new MemoryError('REINDEX_REQUIRED', 409);
          }
          result = { ...result, cachedAt: this.now(), vector: normalizedVector(result.vectors[0], result.dimensions) };
          if (this.ensure().generation !== state.generation || fingerprint !== embeddingIdentity(this.getEmbedding())) {
            throw new MemoryError('MEMORY_STALE', 409);
          }
          this.queryCache.set(key, result);
          if (this.queryCache.size > 128) this.queryCache.delete(this.queryCache.keys().next().value);
        }
        signal?.throwIfAborted();
        if (fingerprint !== embeddingIdentity(this.getEmbedding())) throw new MemoryError('REINDEX_REQUIRED', 409);
        const byId = new Map(corpus.map(document => [document.id, document]));
        const scores = new Map();
        const expected = new Map(embeddingDocuments(corpus).map(document => [document.id, document.hash]));
        for (const row of indexedVectors) {
          if (!byId.has(row.parentId) || expected.get(row.id) !== row.hash) continue;
          const similarity = cosine(result.vector, row.vector);
          if (similarity >= this.minimumSimilarity && similarity > (scores.get(row.parentId)?.score ?? -1)) {
            scores.set(row.parentId, { id: row.parentId, score: similarity, timestamp: byId.get(row.parentId).timestamp });
          }
        }
        semantic = [...scores.values()].sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);
      } catch (error) {
        signal?.throwIfAborted();
        fallbackReason = errorCode(error) === 'REINDEX_REQUIRED' ? 'reindex_required' : errorCode(error).toLocaleLowerCase();
      }
    }
    signal?.throwIfAborted();
    if (this.ensure().generation !== state.generation) throw new MemoryError('MEMORY_STALE', 409);
    const ranking = fuse(keyword, semantic);
    const byId = new Map(corpus.map(row => [row.id, row]));
    const selectedFacts = [];
    const selectedEvents = [];
    const episodes = [];
    const addEvent = id => {
      const event = this.store.event(id);
      if (event && !selectedEvents.some(row => row.id === id) && selectedEvents.length < 5 && !duplicateEvent(event, history)) {
        selectedEvents.push(clone(event));
      }
    };
    const addFact = original => {
      let fact = original;
      const visited = new Set();
      while (fact?.status === 'superseded' && fact.supersededBy && !visited.has(fact.id)) {
        visited.add(fact.id);
        fact = state.facts.find(row => row.id === fact.supersededBy);
      }
      if (!fact || fact.status === 'superseded' || selectedFacts.some(row => row.id === fact.id) || selectedFacts.length >= 4) return;
      selectedFacts.push(clone(fact));
      for (const id of [...fact.sourceIds].reverse()) addEvent(id);
    };
    for (const ranked of ranking) {
      const document = byId.get(ranked.id);
      if (document.kind === 'fact') addFact(state.facts.find(row => row.id === document.recordId));
      else if (document.kind === 'event') {
        // A query matching an old statement must carry its later correction too.
        for (const fact of state.facts.filter(row => row.status === 'superseded' && row.sourceIds.includes(document.recordId))) addFact(fact);
        addEvent(document.recordId);
      }
      else if (document.kind === 'episode' && episodes.length < 4) episodes.push(clone(state.episodes.find(row => row.id === document.recordId)));
    }
    const diagnostics = { method: semantic.length ? 'hybrid' : 'keyword', fallbackReason,
      durationMs: Math.round(performance.now() - started), keywordCandidates: keyword.length,
      semanticCandidates: semantic.length, factCount: selectedFacts.length, eventCount: selectedEvents.length };
    this.lastRetrieval = diagnostics;
    return { generation: state.generation, revision: state.revision, events: selectedEvents, facts: selectedFacts,
      episodes: episodes.slice(0, Math.max(0, 4 - selectedFacts.length)), diagnostics };
  }

  render(bundle, budgetChars = 3600) {
    if (!bundle) return '';
    let state;
    try { state = this.ensure(); } catch { return ''; }
    if (bundle.generation !== state.generation) return '';
    const currentFacts = new Map(state.facts.map(row => [row.id, row]));
    const facts = (bundle.facts || []).map(row => currentFacts.get(row.id)).filter(row => row && row.status !== 'superseded');
    return renderBundle({ ...bundle, facts }, budgetChars);
  }

  search(query, options = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 65536) throw new MemoryError('INVALID_MEMORY', 400);
    return this.retrieve(query, options);
  }

  listEvents(options) {
    const state = this.ensure();
    return paginate(state.eventIds.map(id => this.store.event(id)).filter(Boolean).sort((a, b) => b.timestamp - a.timestamp), options);
  }
  listFacts(options) { return paginate([...this.ensure().facts].sort((a, b) => b.timestamp - a.timestamp), options); }

  status() {
    let state;
    try { state = this.ensure(); }
    catch (error) { return { ready: false, version: 2, errorCode: errorCode(error), counts: { events: 0, facts: 0, episodes: 0 }, jobs: [] }; }
    const fingerprint = embeddingIdentity(this.getEmbedding());
    return { ready: true, version: 2, revision: state.revision, generation: state.generation, lastSeen: state.lastSeen,
      retention: 'until_deleted', counts: { events: state.eventIds.length, facts: state.facts.length,
        episodes: state.episodes.length, vectors: state.vectors?.items.length || 0 },
      writerReady: Boolean(this.getWriter()), embeddingReady: Boolean(fingerprint),
      indexState: !fingerprint ? 'unavailable' : !state.vectors ? 'pending'
        : state.vectors.providerFingerprint === fingerprint
          && (!this.getEmbedding()?.revision || this.getEmbedding().revision === state.vectors.embeddingRevision)
          && this.lastRetrieval?.fallbackReason !== 'memory_corrupt' ? 'ready' : 'reindex_required',
      embedding: state.vectors ? { model: state.vectors.model, dimensions: state.vectors.dimensions,
        revision: state.vectors.embeddingRevision } : null,
      jobs: state.jobs.map(job => ({ id: job.id, type: job.type, state: job.state, attempt: job.attempt,
        dueAt: job.dueAt, errorCode: job.errorCode || null, sourceCount: job.sourceIds?.length || 0 })),
      retrieval: this.lastRetrieval ? { ...this.lastRetrieval } : null };
  }

  addFact(text, category = 'manual', options = {}) {
    if (typeof text !== 'string' || text.trim().length < 3 || text.length > 4096 || typeof category !== 'string' || category.length > 80) {
      throw new MemoryError('INVALID_MEMORY', 400);
    }
    this.ensure();
    return this.store.transact(state => {
      const existing = state.facts.find(row => row.origin === 'manual' && row.text.toLocaleLowerCase() === text.trim().toLocaleLowerCase());
      if (existing) return clone(existing);
      const timestamp = this.now();
      const fact = { id: 'manual_' + randomUUID(), subject: 'user', predicate: category || 'manual', value: text.trim(),
        text: text.trim(), category: category || 'manual', origin: 'manual', status: 'manual',
        sourceIds: [], quotes: [], timestamp, createdAt: new Date(timestamp).toISOString() };
      state.facts.push(fact);
      state.jobs.push({ id: 'job_' + randomUUID(), type: 'embed', sourceIds: [], documentIds: ['fact:' + fact.id],
        state: 'queued', attempt: 0, dueAt: timestamp, createdAt: timestamp, generation: state.generation });
      return clone(fact);
    }, options);
  }

  deletionImpact(kind, id) {
    const state = this.ensure();
    if (!safeId(id) || !['fact', 'event', 'facts', 'events'].includes(kind)) throw new MemoryError('INVALID_MEMORY', 400);
    const fact = ['fact', 'facts'].includes(kind) ? state.facts.find(row => row.id === id) : null;
    if (['fact', 'facts'].includes(kind) ? !fact : !state.eventIds.includes(id)) throw new MemoryError('NOT_FOUND', 404);
    const eventIds = fact ? [...fact.sourceIds] : [id];
    const factIds = state.facts.filter(row => row.id === fact?.id || row.sourceIds.some(source => eventIds.includes(source))).map(row => row.id);
    const episodeIds = state.episodes.filter(row => row.sourceIds?.some(source => eventIds.includes(source))).map(row => row.id);
    return { kind: fact ? 'fact' : 'event', id, revision: state.revision, eventIds, factIds, episodeIds,
      eventCount: eventIds.length, factCount: factIds.length, episodeCount: episodeIds.length };
  }

  deleteFact(id, options) { return this.deleteRecords('fact', id, options); }
  deleteEvent(id, options) { return this.deleteRecords('event', id, options); }
  deleteRecords(kind, id, options = {}) {
    this.ensure();
    let impact;
    this.store.transact(state => {
      impact = this.deletionImpact(kind, id);
      if (impact.revision !== state.revision) throw new MemoryError('CONFLICT', 409);
      const deleted = new Set([...impact.eventIds.map(value => 'event:' + value),
        ...impact.factIds.map(value => 'fact:' + value), ...impact.episodeIds.map(value => 'episode:' + value)]);
      let rows = [];
      try { rows = state.vectors ? this.readVectors(state.vectors).filter(row => !deleted.has(row.parentId)) : []; }
      catch { /* A broken rebuildable index must never prevent forgetting source dialogue. */ }
      state.generation = randomUUID();
      state.purgeLegacy = true;
      state.tombstones = [...new Set([...state.tombstones, ...impact.eventIds])];
      state.eventIds = state.eventIds.filter(value => !impact.eventIds.includes(value));
      state.facts = state.facts.filter(row => !impact.factIds.includes(row.id));
      state.episodes = state.episodes.filter(row => !impact.episodeIds.includes(row.id));
      state.jobs = state.jobs.filter(job => !job.sourceIds?.some(value => impact.eventIds.includes(value))
        && !job.documentIds?.some(value => deleted.has(value)) && job.type !== 'reindex');
      for (const job of state.jobs) {
        job.generation = state.generation;
        if (job.state === 'running') { job.state = 'queued'; delete job.ownerPid; }
      }
      this.publishVectors(state, rows, state.vectors || {});
      for (const fact of state.facts) {
        fact.supersedes = fact.supersedes?.filter(value => !impact.factIds.includes(value));
        fact.supersedesSourceIds = fact.supersedesSourceIds?.filter(value => !impact.eventIds.includes(value));
        fact.conflictsWith = fact.conflictsWith?.filter(value => !impact.factIds.includes(value));
        if (fact.supersededBy && impact.factIds.includes(fact.supersededBy)) {
          delete fact.supersededBy;
          fact.status = fact.conflictsWith?.length ? 'uncertain' : fact.origin === 'legacy' ? 'legacy'
            : fact.origin === 'manual' ? 'manual' : fact.subject === 'assistant' ? 'assistant_claim' : 'active';
        }
        if (fact.status === 'uncertain' && !fact.conflictsWith?.length) fact.status = fact.origin === 'manual' ? 'manual' : 'active';
      }
      projectProfile(state);
    }, options);
    this.jobController?.abort(new MemoryError('MEMORY_STALE', 409));
    this.queryCache.clear();
    for (const eventId of impact.eventIds) this.store.removeEvent(eventId);
    this.store.purgeLegacy();
    this.store.purgeVectors(this.store.state.vectors?.file);
    return { ...impact, revision: this.store.state.revision, generation: this.store.state.generation };
  }

  clearMemory(options = {}) {
    this.ensure();
    let eventIds;
    this.store.transact(state => {
      eventIds = [...state.eventIds];
      const previous = { revision: state.revision, createdAt: state.createdAt, legacyHash: state.legacyHash,
        tombstones: [...new Set([...state.tombstones, ...state.eventIds])] };
      Object.assign(state, newState(this.now()), previous, { migrationComplete: true, purgeLegacy: true });
    }, options);
    this.jobController?.abort(new MemoryError('MEMORY_STALE', 409));
    this.queryCache.clear(); this.lastRetrieval = null;
    for (const id of eventIds) this.store.removeEvent(id);
    this.store.purgeVectors(); this.store.purgeLegacy();
    return { success: true, revision: this.store.state.revision, generation: this.store.state.generation };
  }

  retryJob(id, options = {}) {
    this.ensure();
    return this.store.transact(state => {
      const job = state.jobs.find(row => row.id === id);
      if (!job) throw new MemoryError('NOT_FOUND', 404);
      if (job.state === 'running') throw new MemoryError('LOCK_BUSY', 409);
      job.state = 'queued'; job.attempt = 0; job.dueAt = this.now(); job.generation = state.generation;
      delete job.errorCode;
      return { id: job.id, state: job.state };
    }, options);
  }

  reindex(options = {}) {
    this.ensure();
    return this.store.transact(state => {
      if (state.jobs.some(job => job.type === 'reindex' && !['complete', 'failed'].includes(job.state))) throw new MemoryError('LOCK_BUSY', 409);
      const job = { id: 'job_' + randomUUID(), type: 'reindex', sourceIds: [], state: 'queued', attempt: 0,
        dueAt: this.now(), createdAt: this.now(), generation: state.generation };
      state.jobs.push(job);
      return { id: job.id, state: job.state };
    }, options);
  }

  start() {
    this.disposed = false;
    try {
      this.ensure();
      if (!this.workerLease) this.workerLease = lease(path.join(this.store.root, 'worker.lock'));
      this.recoverJobs();
      if (!this.timer) { this.timer = setInterval(() => void this.processJobs(), this.pollMs); this.timer.unref?.(); }
    } catch (error) { this.storageError = errorCode(error); }
    return this;
  }

  recoverJobs() {
    if (this.running) return;
    const state = this.ensure();
    if (!state.jobs.some(job => job.state === 'running' && (!alive(job.ownerPid) || job.ownerPid === process.pid))) return;
    this.store.transact(current => {
      for (const job of current.jobs) if (job.state === 'running' && (!alive(job.ownerPid) || job.ownerPid === process.pid)) {
        job.state = 'queued'; job.dueAt = this.now(); job.generation = current.generation; delete job.ownerPid;
      }
    });
  }

  async processJobs() {
    if (this.running || this.disposed) return;
    let temporaryLease;
    let jobs;
    try {
      this.ensure();
      if (!this.workerLease) temporaryLease = lease(path.join(this.store.root, 'worker.lock'));
      this.recoverJobs();
      const state = this.ensure();
      const eligible = state.jobs.filter(job => ['queued', 'retry'].includes(job.state) && job.dueAt <= this.now()
        && (job.type === 'extract' ? this.getWriter() : this.getEmbedding()));
      if (!eligible.length) return;
      const first = eligible.find(job => job.type === 'reindex') || eligible[0];
      jobs = first.type === 'extract' ? eligible.filter(job => job.type === 'extract').slice(0, 8) : [first];
      const generation = state.generation;
      this.store.transact(current => {
        for (const claimed of jobs) {
          const job = current.jobs.find(row => row.id === claimed.id);
          if (!job || !['queued', 'retry'].includes(job.state)) throw new MemoryError('LOCK_BUSY', 409);
          job.state = 'running'; job.ownerPid = process.pid; job.attempt++; job.generation = generation;
        }
      }, { generation });
      this.running = true;
      this.jobController = new AbortController();
      if (first.type === 'extract') await this.extractJobs(jobs, generation, this.jobController.signal);
      else await this.embedJob(first, generation, this.jobController.signal);
      if (first.type === 'reindex') this.lastRetrieval = null;
      this.store.transact(current => {
        for (const claimed of jobs) {
          const job = current.jobs.find(row => row.id === claimed.id);
          if (job) { job.state = 'complete'; delete job.ownerPid; delete job.errorCode; job.completedAt = this.now(); }
        }
      }, { generation });
    } catch (error) {
      this.storageError = errorCode(error);
      if (jobs?.length && this.store) {
        try { this.store.transact(current => {
          for (const claimed of jobs) {
            const job = current.jobs.find(row => row.id === claimed.id);
            if (!job || job.state !== 'running' || job.generation !== claimed.generation) continue;
            const code = errorCode(error);
            delete job.ownerPid; job.errorCode = code;
            if (this.disposed || code === 'ABORTED') { job.state = 'queued'; job.dueAt = this.now(); }
            else if (TRANSIENT.has(code) && job.attempt <= RETRY_DELAYS.length) {
              job.state = 'retry'; job.dueAt = this.now() + RETRY_DELAYS[job.attempt - 1];
            } else job.state = 'failed';
          }
        }); } catch { /* Durable running jobs recover on restart. */ }
      }
    } finally {
      this.running = false; this.jobController = null;
      temporaryLease?.();
    }
  }

  async extractJobs(jobs, generation, signal) {
    const state = clone(this.ensure());
    const sourceIds = [...new Set(jobs.flatMap(job => job.sourceIds))].filter(id => state.eventIds.includes(id));
    const events = sourceIds.map(id => this.store.event(id)).filter(Boolean);
    if (!events.length || events.every(event => !event.userText)) return;
    const writer = this.getWriter();
    const response = await bounded(operationSignal => writer.complete({ signal: operationSignal, json: true,
      temperature: 0, maxTokens: 4096,
      messages: [{ role: 'system', content: WRITER_PROMPT }, { role: 'user', content: JSON.stringify({
        events: events.map(event => ({ id: event.id, date: new Date(event.timestamp).toISOString(), origin: event.origin,
          speakers: { user: event.userText, assistant: event.assistantText } })),
        existingFacts: state.facts.filter(fact => !['superseded', 'assistant_claim'].includes(fact.status))
          .map(fact => ({ id: fact.id, subject: fact.subject, predicate: fact.predicate, value: fact.value, status: fact.status })) }) }] }),
    { signal, timeoutMs: this.jobTimeoutMs });
    signal.throwIfAborted();
    const rows = parseWriterResult(response?.text);
    const accepted = [];
    let rejected = false;
    for (const row of rows) {
      try { accepted.push(validateFact(row, events, state.facts)); } catch { rejected = true; }
    }
    this.store.transact(current => {
      for (const fact of accepted.sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence)) {
        if (fact.sourceIds.some(id => !current.eventIds.includes(id))) throw new MemoryError('MEMORY_STALE', 409);
        const published = publishFact(current, fact);
        if (!current.jobs.some(job => job.type === 'embed' && job.documentIds?.includes('fact:' + published.id)
          && !['complete', 'failed'].includes(job.state))) {
          current.jobs.push({ id: 'job_' + randomUUID(), type: 'embed', sourceIds: [...published.sourceIds],
            documentIds: ['fact:' + published.id], state: 'queued', attempt: 0, dueAt: this.now(), createdAt: this.now(), generation });
        }
      }
      projectProfile(current);
    }, { generation });
    if (rejected) throw new MemoryError('INVALID_EVIDENCE', 400);
  }

  async embedJob(job, generation, signal) {
    const provider = this.getEmbedding();
    const fingerprint = embeddingIdentity(provider);
    if (!fingerprint) throw new MemoryError('NETWORK', 503);
    const state = clone(this.ensure());
    if (state.vectors && state.vectors.providerFingerprint !== fingerprint && job.type !== 'reindex') throw new MemoryError('REINDEX_REQUIRED', 409);
    const corpus = this.corpus(state);
    const selected = job.type === 'reindex' ? corpus : corpus.filter(document => job.documentIds?.includes(document.id)
      || !job.documentIds && document.kind === 'event' && job.sourceIds.includes(document.recordId));
    const chunks = embeddingDocuments(selected);
    for (let index = 0; index < chunks.length; index += 8) {
      const batch = chunks.slice(index, index + 8);
      const result = await bounded(operationSignal => provider.embed({ texts: batch.map(row => row.text),
        taskType: 'document', signal: operationSignal }), { signal, timeoutMs: this.jobTimeoutMs });
      signal.throwIfAborted();
      if (fingerprint !== embeddingIdentity(this.getEmbedding())) throw new MemoryError('REINDEX_REQUIRED', 409);
      if (!result || typeof result.model !== 'string' || !result.model || result.vectors?.length !== batch.length) throw new MemoryError('INVALID_EMBEDDING', 400);
      const vectorRows = batch.map((row, rowIndex) => ({ id: row.id, parentId: row.parentId, hash: row.hash,
        vector: normalizedVector(result.vectors[rowIndex], result.dimensions) }));
      this.store.transact(current => {
        const marker = current.vectors;
        const compatible = marker && marker.providerFingerprint === fingerprint && marker.model === result.model
          && marker.dimensions === result.dimensions && (marker.embeddingRevision ?? null) === (result.revision ?? null);
        if (marker && !compatible && job.type !== 'reindex') throw new MemoryError('REINDEX_REQUIRED', 409);
        const expected = new Map(embeddingDocuments(this.corpus(current)).map(row => [row.id, row.hash]));
        if (batch.some(row => expected.get(row.id) !== row.hash)) throw new MemoryError('MEMORY_STALE', 409);
        const incoming = new Set(batch.map(row => row.id));
        const previous = compatible && !(job.type === 'reindex' && index === 0)
          ? this.readVectors(marker).filter(row => expected.get(row.id) === row.hash && !incoming.has(row.id)) : [];
        this.publishVectors(current, [...previous, ...vectorRows], { model: result.model, dimensions: result.dimensions,
          embeddingRevision: result.revision ?? null, providerFingerprint: fingerprint });
      }, { generation });
      this.store.purgeVectors(this.store.state.vectors?.file);
    }
    if (!chunks.length && job.type === 'reindex') this.store.transact(current => { current.vectors = null; }, { generation });
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer); this.timer = null;
    this.jobController?.abort(new MemoryError('ABORTED', 499));
    try { this.workerLease?.(); } catch { /* A crashed process lease is recoverable. */ }
    this.workerLease = null; this.queryCache.clear();
  }
}

// Construction does not touch files, spawn processes, or resolve providers.
export const memoryManager = new MemoryManager();
