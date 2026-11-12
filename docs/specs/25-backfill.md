# Spec 25: History import machinery, backfill and vector sync

**Depends on:** 10, 15, 17, 21, 23, 24. **Blocks:** 26.

## Problem

The corpus is only filled by live messages. A fresh clone starts empty and nothing in the repo can import channel history, including the bot's own past messages. Rows written before spec 10 lack `has_gif` metadata and inferred-reference reply rows in Chroma, and a Chroma failure during ingest leaves SQLite ahead of the vector store, with no way to repair either.

## Deliverable

`npm run backfill -- [options]` (`scripts/backfill.js`), a thin CLI over the services below. Everything is idempotent and additive and honours `--dry-run`. Spec 26 reuses the same services for a full re-import.

```
--dry-run          report what would be written; write nothing to SQLite or Chroma
--skip-history     do not import from Discord (requires --sync-vectors)
--sync-vectors     after importing, reconcile Chroma with SQLite
--before <id>      import only messages older than this Discord message id (digits only)
--limit <n>        fetch at most n messages from Discord, newest first (integer ≥ 1)
```

With no options it imports the entire channel history into the existing database, skipping what is already stored. `parseBackfillArgs(argv)` (pure, `src/backfill/args.js`, built on `node:util` `parseArgs`) returns the options or throws a usage error; the script prints usage and exits 2 for an unknown option, an invalid value, or `--skip-history` without `--sync-vectors`.

Run it with the bot stopped: the script and the bot would otherwise write the same SQLite file concurrently.

## Layer

`src/backfill/` is a new layer between `bot/` and the use-case services (it may import `ingest/`, `storage/`, `context/`, `discord/` adapters and pure modules; nothing imports it except scripts). Add it to the layering list in `CLAUDE.md`.

## Services

### Ingest (`src/ingest/ingestService.js`, `messageStore`)

- `messageStore.insertRaw(record) → boolean` (whether a row was inserted); `messageStore.hasRaw(id) → boolean`.
- `recordMessages(entries) → Promise<{ results, insertedRaw, kept }>` where `entries = [{ record, repliesToBot = false }]` in chronological order and `results[i] = { filtered, stored }`:
  for each entry in order: `insertRaw`, filter, and `insertFiltered` when kept (so reference resolution sees the earlier entries); then **one** `vectorStore.upsertMessages(storedMessages)` for the batch, and **no** vector call when nothing was stored (Chroma rejects empty id lists). `insertedRaw` counts new raw rows; `kept` counts stored corpus rows.
- `recordMessage(record, options)` becomes `recordMessages([{ record, ...options }])` and returns `results[0]`; its behaviour is unchanged.

### Reading history (`src/backfill/historyReader.js`)

`createHistoryReader({ channelHistory, config, logger })` → `readAll(channel, { before = null, limit = Infinity }) → Promise<DiscordMessage[]>`, oldest first: page backwards with `channelHistory.fetchBefore(channel, { before: cursor, limit: Math.min(config.backfill.pageSize, remaining), throwOnError: true })` (cursor = id of the oldest message of the previous page) until a page is empty or `limit` messages were fetched; log progress after each page. `limit` counts every fetched message, of any author. `fetchBefore` gains the `throwOnError` option (default `false` keeps the spec 17 behaviour); a failed page rejects the whole read.

All messages are held in memory until ingest, because reference inference needs chronological order across pages. For a channel with a few hundred thousand messages this is a few hundred megabytes and tens of minutes of fetching; document it.

### Classifying (`src/backfill/classify.js`, pure)

`classifyMessages(messages, { botUserId, isKnownBotMessage }) → { humans: DiscordMessage[], ownBot: DiscordMessage[], otherBots: number }`:

- **own bot message:** `author.id === botUserId`, or a webhook message (`webhookId` set) whose `applicationId === botUserId` or for which `isKnownBotMessage(id)` is true;
- other messages with `author.bot` → counted in `otherBots`, dropped;
- everything else → `humans`.

### Importing the bot's own messages (`src/backfill/botMessageImporter.js`)

`createBotMessageImporter({ botMessageStore, profileStore, userDirectory, logger })` → `run(ownBot, { lookup = () => null, dryRun = false }) → { imported, alreadyStored, unattributed }`. For each message not already in `bot_messages`:

1. `known = lookup(message.id)` (spec 26 supplies rows from a previous database; default none).
2. Persona: `known?.persona`, else `readPersonaFromEmbeds(message, userDirectory)`, else for a webhook message the directory username whose stored profile display name (`profileStore.all()`) or username equals `message.author.username`; none → count in `unattributed`, log at debug, skip.
3. Insert `{ id, persona, content: known?.content ?? message.content, timestamp: message.createdTimestamp, reference: known?.reference ?? message.reference?.messageId ?? null, trigger: known?.trigger ?? TRIGGERS.IMPORTED }` (`TRIGGERS` gains `IMPORTED: 'imported'`).

Content taken from Discord has had resolved GIF tokens removed; content from `lookup` keeps them.

### Importing human messages (`src/backfill/historyImporter.js`)

`createHistoryImporter({ historyReader, botMessageImporter, ingest, messageStore, botMessageStore, messageFilter, getBotUserId, config, logger })` → `run({ channel, before, limit, dryRun = false, botMessageLookup })` → `{ fetched, otherBots, botMessages: { imported, alreadyStored, unattributed }, alreadyStored, insertedRaw, kept }`:

1. `messages = await historyReader.readAll(channel, { before, limit })`; `fetched = messages.length`.
2. Classify, with `isKnownBotMessage = (id) => Boolean(botMessageStore.getById(id) ?? botMessageLookup?.(id))`.
3. Import own bot messages first.
4. `botIds` = ids of all own bot messages in this read. For each human message: `record = toMessageRecord(message)`; skip when `messageStore.hasRaw(record.id)` (`alreadyStored`); `repliesToBot = record.reference !== null && (botIds.has(record.reference) || Boolean(botMessageStore.getById(record.reference)))`.
5. Ingest the entries oldest first in batches of `backfill.batchSize` with `ingest.recordMessages`, logging progress per batch. With `dryRun`, run only the filter to report `kept`, and write nothing anywhere (bot messages included).

A reply to a bot message that lies outside the fetched window and is not in `bot_messages` is not recognised as such; accepted.

### Vector sync (`src/backfill/vectorSync.js`, `vectorStore`, `messageStore`)

New store methods:

- `messageStore.pageFiltered({ after = null, limit }) → StoredMessage[]`: **visible** corpus rows ordered by `(timestamp, id)`, strictly after the cursor `after = { timestamp, id }`; `hasGif` is a boolean.
- `vectorStore.getRecords(collection, ids) → Promise<Map<id, { document, metadata, embedding }>>` (`[]` → empty map, no Chroma call).
- `vectorStore.fillMetadata(collection, records)`: `records = [{ id, document, embedding, metadata }]`; one upsert with exactly those values (no-op for `[]`). Callers pass the row's existing document, embedding and metadata plus the missing key, so content and embedding are unchanged.
- `vectorStore.addReplyRows(rows)`: `rows = [{ message: StoredMessage, embedding }]`; one upsert into the replies collection with the standard metadata (no-op for `[]`).

`createVectorSync({ messageStore, vectorStore, logger, config })` → `run({ dryRun = false }) → { checked, addedMessages, filledMetadata, addedReplies }`. For each page of `backfill.batchSize` rows:

1. `existing = getRecords('messages', ids)`.
2. Rows missing from Chroma → `vectorStore.upsertMessages(rows)` (`addedMessages`); this also writes their reply rows.
3. Rows present whose metadata has no `has_gif` key → `fillMetadata('messages', …)` with their existing metadata plus `has_gif: row.hasGif` (`filledMetadata`).
4. Reply rows: `existingReplies = getRecords('replies', ids of rows with a reference)` (read after step 2). For rows with a reference that are still missing there: look up the parents' embeddings with `getRecords('messages', distinct references)`; rows whose parent embedding exists → `addReplyRows` (`addedReplies`); others are skipped. Existing reply rows lacking `has_gif` → `fillMetadata('replies', …)` (counted in `filledMetadata`).

With `dryRun` nothing is written and the counts report what would be. Nothing is ever removed, and no existing row is re-embedded.

### Script (`scripts/backfill.js`)

Loads env and config, builds the container, connects Chroma. Unless `--skip-history`: logs the Discord client in (`client.login`, wait for `ClientReady`) **without** calling `bot.start()` (no handlers are registered, so the script never replies to anything), fetches `config.discord.channelId`, runs the importer. Then, with `--sync-vectors`, runs the sync (in a dry run the sync cannot see rows the importer would have added; the report says so). Prints the result objects, destroys the client, exits 0; any error prints the message and exits 1. No logic beyond wiring.

## Config

`backfill.pageSize: 100` (1 to 100), `backfill.batchSize: 100`.

## Harness change

- The fake embedding function counts `generate` calls (`state.embeddingCalls`).
- Fake messages gain `webhookId` and `applicationId` fields (default `null`).
- The container returns `historyImporter`, `vectorSync`, `botMessageImporter` and `historyReader`.

## Edge cases

- Empty channel → all zeros.
- 250 messages → three pages (100, 100, 50) and an empty fourth; ingested oldest first; a reply-inference pair split across two pages is still linked.
- Second run → `alreadyStored` equals the first run's `insertedRaw`; no new SQLite rows and no Chroma upserts.
- `--limit 120` → pages of 100 and 20; only the 120 newest messages are considered.
- `--before <id>` → only older messages.
- Dry run → SQLite row counts and the fake collections are unchanged; counts are still reported.
- A page fetch that rejects → the run rejects and nothing was written (ingest starts only after all pages are read).
- A batch in which the filter drops every message → raw rows written, no vector call.
- History containing the bot's own embed-mode messages → `bot_messages` rows with the persona from the embed, trigger `imported`, reference from the Discord reply.
- A webhook message whose display name matches a stored profile → attributed to that user; one that matches nobody → `unattributed`, not stored.
- A human reply to an imported bot message → stored with `NULL` reference and no reply row.
- Another bot's messages → ignored, counted.
- Sync: a corpus row missing from Chroma is added; a row with `has_gif` absent gets it with its embedding unchanged and no new embedding-function call; a reply row is added for an inferred reference; a row whose parent has no embedding is skipped; a hidden (soft-deleted) row is not synced; a second sync run reports zeros.

## Tests

- Unit: `recordMessages` (ordering, single vector upsert, none when nothing kept, parity with `recordMessage`, `repliesToBot` per entry); `insertRaw` return; `hasRaw`; `pageFiltered` (keyset order, visibility, cursor); `getRecords`, `fillMetadata`, `addReplyRows` (including empty input); `historyReader` (paging, limit, before, failure); `classifyMessages`; `botMessageImporter` (each persona source, lookup precedence, already stored, dry run); `historyImporter` (each edge case); `vectorSync` (each case); `parseBackfillArgs` (each option, `--limit 0`, `--before abc`, `--skip-history` alone, unknown option).
- Scenario (`test/scenarios/backfill.test.js`): pre-load fake channel history (humans, bot embed messages, a reply to a bot message) with `world.addHistory`, run the importer from the container, then assert a live message similar to an imported one retrieves it and that a reply to an imported bot message starts a chain with the right persona; run the sync after stripping `has_gif` from seeded fake rows.
- `nonDestructive.test.js` passes.

## Docs

README: setup section (how to backfill; cost: one embedding call per batch of kept messages; memory and time for large channels; stop the bot first), and remove "no backfill script" from the known issues.

## Acceptance

`npm test` passes. `node scripts/backfill.js --bogus` exits 2 without touching the network.
