# Spec 25: History backfill and vector sync

**Depends on:** 10, 24. **Blocks:** none.

## Problem

The corpus is only filled by live messages. A fresh clone starts empty, and there is no way in the repo to import channel history. Rows written before spec 10 lack `has_gif` metadata and inferred-reference reply rows in Chroma, with no way to repair them.

## Deliverable

`npm run backfill -- [options]` (`scripts/backfill.js`), a thin CLI over two services. Both are idempotent, additive, and honour `--dry-run`.

```
--dry-run          report what would be written; write nothing to SQLite or Chroma
--skip-history     do not import from Discord
--sync-vectors     after importing, reconcile Chroma with SQLite
--before <id>      import only messages older than this Discord message id
--limit <n>        import at most n messages (newest first)
```

With no options it imports the entire channel history. Arguments are parsed with `node:util` `parseArgs`; an unknown option or a non-numeric `--limit` exits with code 2 and a usage line.

## Services

### `src/ingest/ingestService.js`

`recordMessages(records) → { stored, kept }`: batch form of `recordMessage` for records in chronological order: `insertRaw` and filter each, `insertFiltered` each kept one in order (reference resolution sees the earlier ones), then **one** `vectorStore.upsertMessages(storedMessages)` for the batch. `recordMessage` becomes a call to it with one record. The bot-message reference rule from spec 21 applies.

`messageStore.hasRaw(id) → boolean`.

### `src/backfill/historyImporter.js`

`createHistoryImporter({ channelHistory, ingest, messageStore, logger, config })` → `run({ channel, before = null, limit = Infinity, dryRun = false }) → { fetched, skippedBots, alreadyStored, stored, kept }`:

1. Page backwards with `channelHistory.fetchBefore(channel, { before: cursor, limit: 100 })` (cursor = oldest id of the previous page) until a page is empty or `limit` records are collected. Bot-authored messages are counted in `skippedBots` and dropped. Only MessageRecords are retained in memory. Unlike the live path, a failed page fetch aborts the run with the error (`fetchBefore` gains `{ throwOnError: true }`).
2. Drop records for which `messageStore.hasRaw(id)` is true (`alreadyStored`).
3. Sort the rest oldest first and ingest in batches of `backfill.batchSize` with `ingest.recordMessages`, logging progress after each batch. With `dryRun`, run the filter only (to report `kept`) and write nothing.

### `src/backfill/vectorSync.js`

`createVectorSync({ messageStore, vectorStore, logger, config })` → `run({ dryRun = false }) → { checked, addedMessages, filledMetadata, addedReplies }`. For visible `filtered_messages` rows in `(timestamp, id)` order, in pages of `backfill.batchSize` (`messageStore.pageFiltered({ after, limit })`, keyset pagination):

1. `existing = vectorStore.getRecords('messages', ids)` → Map id → `{ document, metadata, embedding }`.
2. Rows missing from Chroma → `vectorStore.upsertMessages(rows)` (`addedMessages`).
3. Rows present whose metadata lacks `has_gif` → re-upsert the **same** id, document and embedding with metadata plus `has_gif` (`vectorStore.fillMetadata('messages', records)`; identical content and embedding, so this is the permitted idempotent upsert) (`filledMetadata`).
4. Rows with a non-null `reference` that are missing from the replies collection and whose parent embedding exists → add them under the parent's embedding (`vectorStore.addReplyRows(rows)`) (`addedReplies`).

Step 3 also applies to reply-collection rows lacking `has_gif`. Nothing is ever removed or re-embedded when present.

### Script (`scripts/backfill.js`)

Loads env and config, builds the container, connects Chroma, logs in the Discord client and waits for `ClientReady` (unless `--skip-history`), fetches the channel, runs the importer and/or the sync, prints the result objects, destroys the client and exits 0; any error prints the message and exits 1. No logic beyond wiring.

## Config

`backfill.batchSize: 100`.

## Edge cases

- Empty channel → all zeros.
- 250 messages → three pages fetched, ingested oldest first; a reply-inference pair split across two fetch pages is still linked (processing is chronological across pages).
- Second run → `alreadyStored` equals the first run's `stored`; nothing written (assert no new upserts).
- `--limit 120` → the 120 newest messages.
- `--before <id>` → only older messages.
- Dry run → SQLite row counts and the fake collections are unchanged; counts are still reported.
- A page fetch that rejects → run rejects; rows from earlier batches remain (ingest happens after all pages are fetched, so in fact nothing is written; assert that).
- History containing a reply to a bot message → stored with `NULL` reference.
- Sync: a row missing from Chroma is added; a row with `has_gif` absent gets it without its embedding changing (assert embedding equality and a single embedding-function call count unchanged); a reply row is added for an inferred reference; a hidden (soft-deleted) row is not synced; second sync run reports zeros.

## Tests

- Unit: `recordMessages` (ordering, single vector upsert, parity with `recordMessage`); `hasRaw`; `pageFiltered` (keyset order, visibility); `getRecords`, `fillMetadata`, `addReplyRows`; importer (each edge case, with a fake channel history); vector sync (each case); CLI argument parsing extracted as a pure `parseBackfillArgs(argv)`.
- Scenario (`test/scenarios/backfill.test.js`): through the world, pre-load fake channel history with `world.addHistory`, run the importer from the container, then assert a live message similar to an imported one retrieves it; run the sync after stripping `has_gif` from seeded fake rows.
- `nonDestructive.test.js` passes.

## Docs

README: setup section (how to backfill, cost note: one embedding call per batch of kept messages), remove "no backfill script" from the known issues.

## Acceptance

`npm test` passes. `node scripts/backfill.js --bogus` exits 2 without touching the network.
