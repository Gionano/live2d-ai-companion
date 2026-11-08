# Evidence-backed memory

Amika keeps original completed dialogue and retrieves memories relevant to the
current conversation. Facts carry exact quotations, event IDs, speakers, and
correction links. An assistant assertion or question cannot establish a user
fact. Ambiguous conflicting claims remain uncertain.

Independent preferences can coexist; different likes are not automatically
contradictions. Conflicting singleton attributes, such as a current name or
favorite character, need explicit correction evidence or remain uncertain.

Memory stays on the host computer. BGE-M3 produces local embedding vectors;
the separately selected **Penulis memori** provider receives completed dialogue
for fact extraction. It follows the main chat provider by default. Selecting
local embeddings does not change the chat or extraction provider.

## Install local embeddings

Use Python 3.11 or newer. Installation creates an isolated Python environment
inside the application's resolved local runtime directory; it does not modify
your system Python environment. The official BGE-M3 weights are approximately
2.3 GB on disk, with additional space needed for Python packages and setup
caches. The offline planning command lists disk requirements, missing
components, and license links before installation.

From the repository root:

```powershell
npm.cmd run memory:plan
npm.cmd run setup:memory -- --accept-license=bge-m3 --accept-license=pytorch --accept-license=transformers --accept-license=huggingface-hub
npm.cmd run memory:doctor -- --verify-hashes
```

Only `setup:memory` downloads packages or model files. It resolves the official
model to an immutable revision, verifies installed files, reuses valid caches,
and shares the existing installation lock. Cancellation or failure retains
download caches for an explicit retry. It never force-overwrites a valid
installation or installs an image-generation engine.

Optional setup arguments are `--python <executable>` and
`--device auto|cpu|cuda`. For a CPU-only installation:

```powershell
npm.cmd run memory:plan -- --device=cpu
npm.cmd run setup:memory -- --device=cpu --accept-license=bge-m3 --accept-license=pytorch --accept-license=transformers --accept-license=huggingface-hub
```

The runtime device is separately saved in **Memori** settings. Set it to **CPU**
when using a CPU-only installation. The default **Otomatis** selects CUDA when
available and otherwise CPU. A failed CUDA initialization permits one CPU
fallback. CUDA uses FP16; CPU uses FP32. For short texts and small batches,
budget roughly 1.5–2.5 GB VRAM, reserving about 3 GB initially. These are
estimates; longer batches and device-specific implementations can use more.
CPU mode uses system RAM instead. Outputting 768-dimensional vectors reduces
index size, not the model's GPU weight allocation.

After successful setup, normal backend startup launches the cached service in
the background without downloading anything. The service binds to loopback
port 8011. A compatible existing service is reused; only application-owned
processes are stopped. Missing setup, incompatible occupied ports, or failed
startup leave keyword memory retrieval available. **Coba lagi** in the memory
panel explicitly retries startup after fixing the cause.

Official resources: [BGE-M3](https://huggingface.co/BAAI/bge-m3),
[Python](https://www.python.org/downloads/), and
[PyTorch](https://pytorch.org/get-started/locally/).

## Configuration and retrieval

For containers, follow [Docker memory setup](docker.md#optional-bge-memory-search).
Install inside Linux with the app stopped; host Windows virtual environments
cannot be reused. Docker keeps memory data and installed BGE files in separate
persistent volumes and includes Python without downloading a model during build.

Open `/#settings`, then **Memori**. Under advanced **Connections**, configure:

| Role | Default | Behavior |
| --- | --- | --- |
| Penulis memori (`memoryWriter`) | Follows `llm` | Extracts quoted facts and corrections through persistent background jobs. |
| Pencarian memori (`memoryEmbedding`) | `localBge`, `bge-m3-d768` | Uses the embeddings-only loopback adapter at `http://127.0.0.1:8011`. |

Explicit `null` assignments remain disabled. Memory setup is optional and does
not become a first-run requirement for chat. Existing settings retain their
provider assignments and gain defaults for missing memory settings:

```json
{
  "memory": { "managedEmbedding": true, "embeddingDevice": "auto" },
  "slots": {
    "memoryWriter": { "followLlm": true },
    "memoryEmbedding": { "profile": "localBge", "model": "bge-m3-d768" }
  }
}
```

This excerpt is configuration, not a memory archive. Store overrides through
the existing versioned Settings interface or ignored local configuration.
Configuration export never includes stored dialogue or facts. The existing
Groq vision router remains independent of both memory roles.

Each reply retrieves once and shares the result between surface and deep
generation. Keyword BM25 and normalized-vector cosine rankings are combined by
Reciprocal Rank Fusion. Semantic matches must reach 0.5 similarity. Short recall
follow-ups can anchor on recent substantive user messages. Assistant guesses
cannot supply that anchor, and dialogue already present in the trimmed history
is excluded from duplicate recall.

The surface stage has a 2,000-character memory budget; the deeper stage has
3,600 characters. Roughly half is reserved for original dialogue. Complete
evidence packets are included or skipped; quotes are not shortened to fit.
Existing short-term conversation limits remain unchanged.

Query embedding has a 300 ms deadline and no reply-path retries. Retrieval
overlaps routing or fresh vision inspection when possible. Offline, busy,
invalid, or incompatible embeddings fall back to keyword search. Cached query
vectors reduce repeated requests. This bounds embedding wait, not total reply
latency: the chat provider, context size, TTS, and playback still affect response
time. Diagnostics report retrieval method, duration, counts, and fallback code
outside conversation text, without the query or private directives.

## Recording, recovery, and deletion

The backend finalizes a dialogue event after successful audio playback
acknowledgment, including scheduled sentence pauses. It records the sentences
actually delivered to TTS, rather than incomplete streamed display text.
Interrupted speech, failed synthesis, playback timeouts, and unconfirmed or
text-only playback do not become original speech evidence. A completed surface
response surviving a deep-stage failure remains eligible.

Proactive and spoken visual commentary are stored as assistant-only events.
Private reflection plans, router decisions, passive frame descriptions, raw
images/audio, and PAP generation assets are not memory evidence. Dialogue from
different connections shares the current single-user installation's memory,
with session and turn identities preserved for provenance.

Finalized events become keyword-searchable immediately. Extraction waits
120 seconds and batches up to eight events. Document embeddings also run in the
background. Persistent jobs survive refresh and restart; interrupted jobs are
recovered. Transient failures get three retries after 60, 300, and 1,200 seconds.
Invalid evidence remains failed until explicitly retried. Atomic publication
and a single-writer lease prevent concurrent processes from publishing
conflicting state.

The data directory is `WAIFU_DATA_DIR`, defaulting to ignored `data/`:

```text
<data>/memory-v2/
  state.json          Version, facts, jobs, migration and vector metadata
  events/             Original attributed dialogue events
  *.f32               Rebuildable float32 vector sidecars
  legacy-backup.json  Preserved migration source, when present
```

Old `memory.json` facts, profile fields, and episode summaries are preserved as
unverified legacy records. Migration never invents original quotations and
does not impose the old 40-fact/20-episode caps. Retention is until deletion.
Model, dimension, or immutable weight-revision changes cannot mix vector
indexes. **Bangun ulang indeks** explicitly rebuilds them while keyword search
remains available.

Review original speech and supporting quotes in **Memori**. Deleting a fact also
deletes its supporting dialogue events and dependent facts, jobs, and vectors;
the confirmation shows that impact. Clearing memory removes the owned legacy
backup/source as well and prevents automatic remigration. Pending old speech,
extraction, retrieval caches, and late embedding results cannot resurrect
deleted records. Manual entries carry a separate manual origin.

## Protected API

All following paths are relative to `/api/settings`. They retain loopback,
same-origin, bounded-body, no-cache, and `X-Settings-Token` protections.
Configuration saves use the Settings `version`; data mutations use the
separate `memoryRevision` returned by memory status.

| Endpoint | Purpose |
| --- | --- |
| `GET /memory` | Configuration, memory status/revision, and embedding readiness. |
| `PUT /memory/config` | Save managed startup/device settings with Settings version protection. |
| `GET /memory/events`, `GET /memory/facts` | Paginated records (`cursor`, `limit`). |
| `POST /memory/search` | Relevant retrieval for a supplied `query`. |
| `POST /memory/fact` | Add a manual `text` and optional `category`. |
| `GET /memory/facts/:id/impact`, `GET /memory/events/:id/impact` | Review deletion dependencies. |
| `DELETE /memory/facts/:id`, `DELETE /memory/events/:id` | Delete reviewed records and their dependencies. |
| `POST /memory/clear` | Clear memory and prevent remigration/resurrection. |
| `POST /memory/jobs/:id/retry` | Explicitly retry a failed processing job. |
| `POST /memory/reindex` | Queue a vector rebuild. |
| `POST /memory/embedding/retry` | Retry cached embedding-service startup. |

Legacy `GET /api/memory`, `POST /api/memory/fact`, and
`POST /api/memory/clear` retain their response shapes behind the same
protections. Legacy mutations can omit a data revision but still require the
Settings token. They cannot bypass the protected memory service.

## Validation

Run `npm.cmd test` and `npm.cmd run build`. Mocked regressions exercise evidence,
corrections, migration, deletion fencing, retrieval, query deadlines, persisted
jobs, provider settings, setup locks, process ownership, and Python encoding
without loading model weights. Install the model explicitly before native
CPU/GPU validation; automated fixture timings are not device benchmarks.

For a manual check, use an isolated `WAIFU_DATA_DIR` and configured conversation
providers. Complete a spoken statement such as "Karakter favoritku Hikari."
Verify its original quotation, ask about that preference after unrelated
messages, then explicitly correct it and inspect the supersession. Restart the
backend, test interrupted playback, and delete the record while other work is
pending. Check browser and Electron Settings and confirm that dialogue and
credentials never enter browser storage or configuration exports.
