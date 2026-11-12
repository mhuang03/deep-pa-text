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

**Limits of a backfill.** It only adds messages that are not stored yet. It does not re-filter raw rows that already exist, apply edits or deletions made while the bot was offline, or change stored references. A full re-import (spec 26) does all of that. Run the backfill with the bot stopped: the script and the bot would otherwise write the same SQLite file concurrently.

## Layer

`src/backfill/` is a new layer between `bot/` and the use-case services (it may import `ingest/`, `storage/`, `context/`, `profiles/`, `discord/` adapters and pure modules; nothing imports it except scripts and the container). Add it to the layering list in `CLAUDE.md`.

## Services

### Storage and ingest

- `messageStore.insertRaw(record) → boolean` (`Number(changes) > 0`); `messageStore.hasRaw(id) → boolean` (true for soft-deleted rows too).
- `messageStore.transaction(fn)`: runs `fn` between `BEGIN IMMEDIATE` and `COMMIT`, rolling back and rethrowing on error.
- `ingestService.recordMessages(entries) → Promise<{ results, insertedRaw, kept }>` where `entries = [{ record, repliesToBot = false }]` in chronological order and `results[i] = { filtered, stored }`. Inside one `messageStore.transaction`: for each entry in order, `insertRaw`, filter, and `insertFiltered` when kept (so reference resolution sees the earlier entries; it uses the same private helper as `recordMessage`/`recordEdit` for filtering and reference options). After the transaction: **one** `vectorStore.upsertMessages(storedMessages)` for the batch, and **no** vector call when nothing was stored (Chroma rejects empty id lists). `insertedRaw` counts new raw rows; `kept` counts stored corpus rows.
- `recordMessage(record, options)` becomes `recordMessages([{ record, ...options }])` and returns `results[0]`; its behaviour is unchanged.

If the vector call fails, the SQLite rows of that batch already exist and a later run skips them; the vector sync below restores their vectors.

### History messages (`src/discord/historyMessage.js`, pure)

`toHistoryMessage(discordMessage) → HistoryMessage`: a small plain object, so that hundreds of thousands of messages fit in memory:

```
{ id, content, createdTimestamp, editedTimestamp,
  author: { id, username, bot },
  webhookId,                                  // string | null
  reference: { messageId } | null,
  embeds: [{ author: { name } | null }],
  url }
```

The shape is compatible with `toMessageRecord` and `readPersonaFromEmbeds`, which accept it unchanged.

### Reading history (`src/backfill/historyReader.js`)

`createHistoryReader({ channelHistory, config, clock, logger })` → `readAll(channel, { before = null, limit = Infinity }) → Promise<HistoryMessage[]>`, oldest first:

- page backwards with `channelHistory.fetchBefore(channel, { before: cursor, limit: Math.min(config.backfill.pageSize, remaining), throwOnError: true, cache: false })` (cursor = id of the oldest message of the previous page) until a page is empty or `limit` messages were fetched; convert each page with `toHistoryMessage` as it arrives; log progress after each page;
- `limit` counts every fetched message, of any author;
- each page request is wrapped in `withTimeout` (`backfill.pageTimeoutMs`) and retried up to `backfill.pageRetries` times after a failure, waiting `backfill.retryDelayMs` (`clock.sleep`) between attempts; only then does the read reject, and nothing has been written at that point.

`fetchBefore` gains two options: `throwOnError` (default `false` keeps the spec 17 behaviour) and `cache` (passed to `channel.messages.fetch`; `false` keeps discord.js from retaining the fetched messages).

For a channel with a few hundred thousand messages expect tens of minutes of fetching (Discord serves 100 messages per request) and a few hundred megabytes of memory.

### Classifying (`src/backfill/classify.js`, pure)

`classifyMessages(messages, { botUserId, ownWebhookIds, isKnownBotMessage }) → { humans, ownBot, otherBots: number }`:

- **own bot message:** `author.id === botUserId`; or a webhook message whose `webhookId` is in `ownWebhookIds`; or any message for which `isKnownBotMessage(id)` is true;
- other messages with `author.bot` → counted in `otherBots`, dropped (this includes other applications' webhooks, such as proxy bots);
- everything else → `humans`.

`ownWebhookIds` comes from `webhooks.ownedIds(channel)` (spec 23). If that fails (no Manage Webhooks permission) a warning is logged and the set is empty, so only webhook messages already known by id are recognised.

### Importing the bot's own messages (`src/backfill/botMessageImporter.js`)

`createBotMessageImporter({ botMessageStore, profileStore, userDirectory, config, logger })` → `run(ownBot, { lookup = () => null, dryRun = false }) → { imported, alreadyStored, unattributed, skippedEmpty }`. For each message not already in `bot_messages`:

1. `known = lookup(message.id)` (spec 26 supplies rows from a previous database; default none).
2. Text and reference from Discord: if the content starts with `REPLY_LINK_PREFIX` (spec 23), remove that first line and take the reference from the last path segment of its URL; otherwise the reference is `message.reference?.messageId ?? null`.
3. Persona: `known?.persona`; else `readPersonaFromEmbeds(message, userDirectory)`; else, for a webhook message, the **single** directory user for whom `message.author.username` equals the username or one of `profileStore.namesOf(username)` cut to `discord.webhookUsernameMax`. No match, or more than one user matching → count in `unattributed`, log at debug, skip.
4. Content: `known?.content ?? <text from step 2>`. Empty content (a leftover "thinking" placeholder, or a GIF-only message whose token is not recoverable) → count in `skippedEmpty`, skip.
5. Insert `{ id, persona, content, timestamp: message.createdTimestamp, reference: known?.reference ?? <reference from step 2>, trigger: known?.trigger ?? TRIGGERS.IMPORTED }` (`TRIGGERS` gains `IMPORTED: 'imported'`).

Content taken from Discord has had resolved GIF tokens removed; content from `lookup` keeps them. Burst grouping is not reconstructed for rows imported without a lookup.

### Importing (`src/backfill/historyImporter.js`)

`createHistoryImporter({ historyReader, botMessageImporter, ingest, messageStore, botMessageStore, messageFilter, webhooks, getBotUserId, config, logger })` →

- `importMessages(messages, { channel, dryRun = false, botMessageLookup = null }) → { otherBots, botMessages: { imported, alreadyStored, unattributed, skippedEmpty }, alreadyStored, insertedRaw, kept }`:
  1. Classify, with `ownWebhookIds` as above and `isKnownBotMessage = (id) => Boolean(botMessageStore.getById(id) ?? botMessageLookup?.(id))`.
  2. Import own bot messages first (`lookup: botMessageLookup ?? (() => null)`).
  3. `botIds` = ids of all own bot messages in `messages`. For each human message: `record = toMessageRecord(message)`; skip when `messageStore.hasRaw(record.id)` (`alreadyStored`); `repliesToBot = record.reference !== null && (botIds.has(record.reference) || Boolean(botMessageStore.getById(record.reference)))`.
  4. Ingest the entries oldest first in batches of `backfill.batchSize` with `ingest.recordMessages`, logging progress per batch. With `dryRun`, run only the filter to report `kept`, and write nothing anywhere (bot messages included).
- `run({ channel, before, limit, dryRun, botMessageLookup })`: `messages = await historyReader.readAll(channel, { before, limit })`, then `importMessages`; the result also carries `fetched: messages.length`.

A reply to a bot message that lies outside the fetched window and is not in `bot_messages` is not recognised as such; accepted.

### Vector sync (`src/backfill/vectorSync.js`, `vectorStore`, `messageStore`)

New store methods:

- `messageStore.pageFiltered({ after = null, limit }) → StoredMessage[]`: **visible** corpus rows ordered by `(timestamp, id)`, strictly after the cursor `after = { timestamp, id }`; `hasGif` is a boolean.
- `vectorStore.getRecords(collection, ids) → Promise<Map<id, { document, metadata, embedding }>>` (`[]` → empty map, no Chroma call).
- `vectorStore.fillMetadata(collection, records)`: `records = [{ id, document, embedding, metadata }]`; one upsert with exactly those values (no-op for `[]`). It exists only to add a missing metadata key: callers pass the row's existing document, embedding and metadata plus the new key.
- `vectorStore.addReplyRows(rows)`: `rows = [{ message: StoredMessage, embedding }]`; one upsert into the replies collection with the standard metadata (no-op for `[]`).

`createVectorSync({ messageStore, vectorStore, logger, config })` → `run({ dryRun = false }) → { checked, addedMessages, filledMetadata, addedReplies, skipped }`. For each page of `backfill.batchSize` rows:

1. `existing = getRecords('messages', ids)`.
2. Rows missing from Chroma → `vectorStore.upsertMessages(rows)` (`addedMessages`); this also writes their reply rows.
3. Rows present whose metadata has no `has_gif` key → `fillMetadata('messages', …)` with their existing document, embedding and metadata plus `has_gif: row.hasGif` (`filledMetadata`). A row whose stored document or embedding is missing or empty is **not** touched and is counted in `skipped` (upserting it would re-embed or blank it).
4. Reply rows: `existingReplies = getRecords('replies', ids of rows with a reference)` (read after step 2). For rows with a reference that are still missing there: look up the parents' embeddings with `getRecords('messages', distinct references)`; rows whose parent embedding exists → `addReplyRows` (`addedReplies`); the rest are counted in `skipped`. Existing reply rows lacking `has_gif` → `fillMetadata('replies', …)` under the same rule as step 3.

With `dryRun` nothing is written and the counts report what would be. Nothing is ever removed, and no existing row is re-embedded.

`CLAUDE.md` Data safety, allowed list: add "a metadata-only fill of a missing key on an existing Chroma row, with its document and embedding passed back unchanged".

### Script (`scripts/backfill.js`)

Loads env and config, builds the container, connects Chroma. Unless `--skip-history`: logs the Discord client in (`client.login`, wait for `ClientReady`) **without** calling `bot.start()` (no handlers are registered, so the script never replies to anything), fetches `config.discord.channelId`, runs the importer. Then, with `--sync-vectors`, runs the sync (in a dry run the sync cannot see rows the importer would have added; the report says so). Prints the result objects, destroys the client, exits 0; any error prints the message and exits 1, adding the hint to re-run with `--sync-vectors` when the failure came from the vector store. No logic beyond wiring.

`createDiscordClient(Client, { cacheMessages = true } = {})`: with `cacheMessages: false` the client is built with `makeCache: Options.cacheWithLimits({ MessageManager: 0 })`; the scripts use that.

## Config

`backfill.pageSize: 100` (1 to 100), `backfill.batchSize: 100` (≥ 1), `backfill.pageRetries: 3` (≥ 0), `backfill.retryDelayMs: 2000`, `backfill.pageTimeoutMs: 30000`.

## Harness change

- The fake embedding function counts `generate` calls (`state.embeddingCalls`).
- Fake messages gain `webhookId` (default `null`); the fake `channel.messages.fetch` records the `cache` option and supports `failNext(error, { times })` for retry tests.
- The container returns `historyReader`, `historyImporter`, `botMessageImporter` and `vectorSync`.

## Edge cases

- Empty channel → all zeros.
- 250 messages → three pages (100, 100, 50) and an empty fourth; ingested oldest first; a reply-inference pair split across two pages is still linked.
- Second run → `alreadyStored` equals the first run's `insertedRaw`; no new SQLite rows and no Chroma upserts.
- `--limit 120` → pages of 100 and 20; only the 120 newest messages are considered.
- `--before <id>` → only older messages.
- Dry run → SQLite row counts and the fake collections are unchanged; counts are still reported.
- A page fails twice and then succeeds → the read completes (two sleeps recorded). A page that fails four times → the run rejects and nothing was written.
- A page request that hangs → times out and is retried.
- A batch in which the filter drops every message → raw rows written, no vector call.
- A batch whose vector call rejects → the run rejects; its SQLite rows exist; a following vector sync adds exactly those vectors.
- History containing the bot's own embed-mode messages → `bot_messages` rows with the persona from the embed, trigger `imported`, reference from the Discord reply.
- A webhook message from the bot's own webhook with a reply-link line → the link line is not in the stored content and the reference is the linked message id; display name matching exactly one user (current or a past display name) → attributed; matching two users, or nobody → `unattributed`.
- A webhook message from someone else's webhook that happens to carry a member's display name → `otherBots`, never attributed.
- A leftover "thinking" placeholder (no content) → `skippedEmpty`.
- A human reply to an imported bot message → stored with `NULL` reference and no reply row.
- Sync: a corpus row missing from Chroma is added; a row with `has_gif` absent gets it with its document and embedding identical and no new embedding-function call; a row with a missing embedding is skipped; a reply row is added for an inferred reference; a row whose parent has no embedding is skipped; a hidden (soft-deleted) row is not synced; a second sync run reports zeros.

## Tests

- Unit: `transaction` (commit, rollback); `recordMessages` (ordering, single vector upsert, none when nothing kept, atomic SQLite batch, parity with `recordMessage`, `repliesToBot` per entry); `insertRaw` return; `hasRaw`; `pageFiltered` (keyset order, visibility, cursor); `getRecords`, `fillMetadata`, `addReplyRows` (including empty input); `toHistoryMessage`; `historyReader` (paging, limit, before, retries, timeout, `cache: false`); `classifyMessages`; `botMessageImporter` (each persona source, lookup precedence, link-line stripping, ambiguity, empty content, already stored, dry run); `importMessages` and `run` (each edge case); `vectorSync` (each case, including the skip rule); `parseBackfillArgs` (each option, `--limit 0`, `--before abc`, `--skip-history` alone, unknown option); `createDiscordClient` cache option.
- Scenario (`test/scenarios/backfill.test.js`): pre-load fake channel history (humans, bot embed messages, an own-webhook message, a reply to a bot message) with `world.addHistory`, run the importer from the container, then assert a live message similar to an imported one retrieves it and that a reply to an imported bot message starts a chain with the right persona; run the sync after stripping `has_gif` from seeded fake rows.
- `nonDestructive.test.js` passes.

## Docs

README: setup section (how to backfill, its limits and the pointer to re-import, cost of one embedding call per batch of kept messages, memory and time for large channels, stop the bot first), and remove "no backfill script" from the known issues.

## Acceptance

`npm test` passes. `node scripts/backfill.js --bogus` exits 2 without touching the network.
