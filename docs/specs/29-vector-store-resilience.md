# Spec 29: Vector-store resilience

**Depends on:** 28. **Blocks:** 30. **Audit findings:** A3, A15, A31, A42, A45, A47, A53.

## Problem

- Chroma and embedding calls have no timeout. A stalled connection blocks every message handler in ingest for as long as it lasts, and a hung collection lookup is cached forever.
- When Chroma or the embedding API fails during live ingest, the handler aborts, the message is in SQLite but not in Chroma, nothing says so, and nothing repairs it until someone runs the sync by hand.
- An empty or duplicate-id batch is passed straight to Chroma, which rejects it.
- Errors from SQLite during a vector sync are reported as vector-store errors.

## Required behaviour

### Timeouts and tagging (`src/storage/vectorStore.js`)

`createVectorStore({ client, embeddingFunction, config, generation, clock })`:

- Every method (`connect`, `embed`, `upsertMessages`, `query`, `getEmbeddings`, `getRecords`, `fillMetadata`, `addReplyRows`) runs its Chroma and embedding work inside `withTimeout` with `chroma.timeoutMs` (`connect` uses `chroma.connectTimeoutMs`), label `chroma <method>`. The embedding call happens inside Chroma's client, so the same timeout bounds it.
- The memoised collections promise is evicted when it rejects **or times out**, so the next call retries instead of awaiting a hung promise.
- Every error leaving the vector store, including timeouts, is a new `Error` with `cause` set to the original and `isVectorError: true` (`src/util/vectorError.js` returns a new error; it no longer mutates its argument). Tagging happens only here. Callers stop tagging; in particular SQLite errors raised by the vector sync are not tagged.
- `upsertMessages([])` is a no-op. A batch with repeated ids keeps the last occurrence of each id. The same holds for `fillMetadata` and `addReplyRows`.

The file is split if it would exceed 200 lines (for example `vectorCollections.js` for the memoised lookup and `vectorRecords.js` for record mapping).

### Live ingest tolerates vector failures (`src/ingest/ingestService.js`)

`recordMessage(record, { repliesToBot, tolerateVectorErrors = false })`, and likewise `recordEdit`: when the SQLite work succeeded and the vector write failed with a vector error and `tolerateVectorErrors` is true, the error is not thrown: `onVectorError(error)` (an injected callback) is called and the result is returned with `vectorFailed: true`. The message, edit and delete handlers pass `tolerateVectorErrors: true`; the backfill and re-import paths do not, so their errors still propagate.

The message handler continues normally after a tolerated failure (the reply attempt may then fail at retrieval and is handled by the failure cooldown from spec 30).

### Automatic repair (`src/backfill/vectorHealth.js`)

`createVectorHealth({ vectorSync, clock, config, logger })` →

- `noteFailure(error)`: marks the store as in debt and logs one warning per `vector.repairIntervalMs` saying that vectors are missing and will be repaired automatically.
- `repair() → Promise<void>` (never throws): when in debt, `vectorSync.run({ sinceMs: clock.now() - config.vector.repairWindowMs })`; on success clear the debt and log the counts; on failure keep the debt and log a warning.
- `startupRepair()`: the same sync once, regardless of debt, to pick up vectors that were missing when the process last stopped.

Wiring: the container passes `vectorHealth.noteFailure` to ingest as `onVectorError`; `createBot` starts `startupRepair()` at `ClientReady` after catch-up and state restore, **without awaiting it**, and schedules `repair` with `lifecycle.every(…, config.vector.repairIntervalMs)`.

`vectorSync.run({ dryRun, sinceMs = null })`: with `sinceMs`, paging starts at the cursor `{ timestamp: sinceMs, id: '' }`, so only rows at or after that time are checked.

### Startup

The connection failure message is the one defined in spec 28. A model or dimension mismatch between the configuration and an existing collection is not detected at startup (Chroma reports it on the first write); the README says which settings must not change for an existing collection.

## Config

`chroma.timeoutMs: 30000` (> 0), `chroma.connectTimeoutMs: 10000` (> 0), `vector.repairIntervalMs: 600000` (> 0), `vector.repairWindowMs: 604800000` (7 days, > 0).

## Harness change

Fake Chroma: `state.hang(true | false)` makes every collection operation and `heartbeat` never settle; the existing per-collection `setFailing` stays. The fake embedding function gains `hang`/`setFailing`.

## Edge cases

- Chroma hangs during ingest of a live message → after `timeoutMs` (advance mocked time) the handler continues; the message is in `messages` and `filtered_messages`; nothing is thrown; one warning.
- Chroma rejects during ingest → same, without waiting.
- Hung `getOrCreateCollection` → the first call times out; after `hang(false)` the next call succeeds (the hung promise was not cached).
- Embedding function rejects (429) during ingest → tolerated as above.
- After Chroma recovers, the next `repair` tick adds exactly the missing vectors (and their reply rows) and clears the debt; a tick with no debt makes no Chroma call.
- Repair fails → debt kept, retried at the next tick.
- Process restarted with vectors missing from the last 7 days → `startupRepair` adds them; rows older than the window are left for `npm run backfill -- --skip-history --sync-vectors`.
- Retrieval times out mid-reply → the reply fails closed: nothing is sent, the error is logged, later messages work.
- Backfill batch whose vector write fails → still rejects with a vector error (not tolerated), as before.
- SQLite throws inside the vector sync → the error is not tagged `isVectorError`, and the backfill script does not print the "vector store failed" hint.
- `upsertMessages` with the same id twice → one row, last content; with `[]` → no Chroma call.
- Shutdown during a repair → the repair is abandoned with the other in-flight work (it is tracked by the lifecycle).

## Tests

- Unit: each vector-store method times out and tags (fake that hangs), eviction of the collections promise, error wrapping keeps `cause`, empty and duplicate batches; `recordMessage`/`recordEdit` with `tolerateVectorErrors` on and off; `vectorHealth` (debt, warning rate limit, repair success and failure, startup repair, never throws); `vectorSync.run({ sinceMs })`.
- Scenario (`test/scenarios/vector-resilience.test.js`): each edge case above through the world, including the full outage → recovery → repair sequence.
- Existing tests: assertions on error identity where callers used to tag errors; nothing else.

## Docs

README: operations section (what happens when Chroma or the embedding API is down, automatic repair and its window, manual full sync), configuration table, and the note on model and dimension changes.

## Acceptance

`npm test` passes. No call to a Chroma collection or the embedding function exists outside `withTimeout`.
