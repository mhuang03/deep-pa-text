# Spec 24: Message edits and deletes (soft, non-destructive)

**Depends on:** 15, 18, 19, 20, 21, 22 (implemented after 23, which touches the same wiring files). **Blocks:** 25, 26.

## Problem

When someone deletes or edits a message, the corpus keeps the original forever and the bot can keep imitating text its author removed. `CLAUDE.md` forbids deleting or overwriting stored data, so removal must be a soft delete and an edit an appended revision.

## Design

SQLite is the source of truth for visibility. Rows are marked, never removed; Chroma is never modified for a delete (hidden rows are filtered out of query results in application code); an edit adds a new corpus row under a new row id.

**Logical id.** Every message has one logical id, its Discord message id. A corpus row's logical id is `COALESCE(source_id, id)`: the original row has `id = <discord id>` and `source_id NULL`; a row created by an edit has `id = '<discord id>:<editedAt>'` and `source_id = <discord id>`. `reference` columns always hold logical ids. A logical message has at most one **visible** corpus row (`deleted_at IS NULL`); that row carries its current text.

## Schema (additive migrations, appended)

```
addColumn messages.deleted_at            INTEGER
addColumn filtered_messages.deleted_at   INTEGER
addColumn filtered_messages.source_id    TEXT
addColumn bot_messages.deleted_at        INTEGER
CREATE INDEX IF NOT EXISTS idx_filtered_messages_source_id ON filtered_messages (source_id)
CREATE TABLE IF NOT EXISTS message_revisions (
  message_id TEXT NOT NULL,
  content    TEXT NOT NULL,
  edited_at  INTEGER NOT NULL,
  PRIMARY KEY (message_id, edited_at)
)
```

## Store changes

`messageStore`:

- `softDelete(id, at) → boolean`: sets `deleted_at = at` on the `messages` row and on every `filtered_messages` row whose logical id is `id`, only where `deleted_at IS NULL`. Returns whether anything was marked.
- `applyEdit({ id, content, editedAt, filtered, inferReference }) → StoredMessage | null`, in **one transaction** (`BEGIN IMMEDIATE` … `COMMIT`, `ROLLBACK` on error): insert the revision row; mark the visible corpus rows of logical id `id` as superseded (`deleted_at = editedAt`); when `filtered` is non-null, insert it as a corpus row with `id = '<id>:<editedAt>'`, `source_id = id`, the original timestamp, and a reference resolved like a new message's. Returns the new StoredMessage or `null`. A revision that already exists (same `message_id` and `edited_at`) makes the whole call a no-op returning `null`.
- `getRaw(id)` (extends spec 21) returns `{ id, author, content, timestamp, reference, deleted }` with `content` = the newest revision's content when one exists, else the original, and `deleted = deleted_at IS NOT NULL`.
- `hiddenIds(rowIds) → Set<string>`: the given corpus **row** ids whose row exists and is not visible (chunks of 500). Row ids unknown to SQLite are not hidden.
- Reference resolution on insert:
  - an explicit reference is accepted when the logical message it names has a visible corpus row; otherwise fall back to inference;
  - inference uses the previous **visible** corpus row and stores its logical id.
- `getParents(rowIds)` (extends spec 18) returns, for each row, the content of the **visible** row of the logical message its `reference` names; a parent with no visible row counts as no parent.
- Every corpus read excludes invisible rows: `randomMessages`, `countContents`, and the `latest*` queries of the inspect script. `randomStarters` (spec 20) and `burstStats` (spec 22) read the raw `messages` table: they exclude rows with `deleted_at` **inside** the windowed subquery, so a deleted message neither counts nor acts as a neighbour.

`botMessageStore`: `softDelete(id, at)`; `recent` and `siblings` exclude invisible rows; `getById` returns invisible rows with `deleted: true`.

## Retrieval

- After every vector query, the retriever and the persona selector drop hits whose id is in `messageStore.hiddenIds(hit ids)`. Over-fetching (spec 19) keeps buckets full.
- `getEmbeddings` is asked only for surviving candidates.
- A reply row in Chroma stays under the embedding its parent had when the reply was stored, even if the parent is later edited. Accepted.

## Chains (amends spec 21, `src/context/chainBuilder.js`)

A deleted human turn (`getRaw(...).deleted`) is skipped and the walk continues through its reference; a deleted bot message as the direct parent means no chain; a deleted bot message further up ends the walk.

## Ingest

`ingestService.recordEdit({ id, author, content, timestamp, reference, editedAt }, { repliesToBot = false } = {}) → Promise<{ changed: boolean }>`:

1. `raw = messageStore.getRaw(id)`. Not found (the message predates the bot's records) → `recordMessage({ id, author, content, timestamp, reference }, { repliesToBot })`, return `{ changed: true }`.
2. `raw.deleted`, or `content === raw.content` (Discord also emits updates for link previews and pins) → `{ changed: false }`.
3. `filtered = messageFilter.filter({ id, author, content, timestamp, reference })` (may be `null`).
4. `stored = messageStore.applyEdit({ id, content, editedAt, filtered, inferReference: !repliesToBot })`.
5. When `stored` is non-null, `await vectorStore.upsertMessages([stored])`. A Chroma failure here is logged by the caller; SQLite is already consistent and spec 25's vector sync adds the missing vector.
6. Return `{ changed: true }`.

`ingestService.recordDelete(id, at)`: `messageStore.softDelete(id, at)` and `botMessageStore.softDelete(id, at)`.

`recordMessage` and `recordEdit` share one private helper for filtering and reference options.

## Discord

- `createDiscordClient` adds `partials: [Partials.Message]` so events arrive for uncached messages. Intents are unchanged. (Bulk-delete events are delivered for cached channels, which the `Guilds` intent provides.)
- `src/bot/handlers/messageDelete.js`: `createMessageDeleteHandler({ config, ingest, clock, logger })` → `{ onDelete(message), onBulkDelete(messages) }`: ignore other channels (`message.channelId`); `recordDelete(message.id, now())` for each (for bulk, each value of the collection). Only `id` and `channelId` are read, so partial messages work.
- `src/bot/handlers/messageUpdate.js`: `createMessageUpdateHandler({ config, ingest, botMessageStore, clock, logger })` → `onUpdate(oldMessage, newMessage)`: ignore other channels; if `newMessage.partial`, `await newMessage.fetch()` (one extra REST call for edits of uncached messages; accepted); ignore bot authors; `recordEdit({ ...toMessageRecord(fetched), editedAt: fetched.editedTimestamp ?? now() }, { repliesToBot: Boolean(reference && botMessageStore.getById(reference)) })`.
- `createBot` registers `MessageDelete`, `MessageBulkDelete` and `MessageUpdate`; the container builds both handlers.
- Edits and deletes are not channel activity: they do not touch the activity tracker or the reply policy and never trigger a reply.
- Both handlers catch and log their errors.

## Known limitations (document in README)

- Edits and deletes that happen while the bot is offline are not seen; the full re-import (spec 26) reconciles them.
- The text of a deleted message remains in the SQLite file and in Chroma (hidden, never used). "Deleted" means the bot no longer uses it, not that it is erased.

## Harness change

- Fake messages gain `channelId`, `partial` (default `false`), `editedTimestamp` and `fetch()` (resolving to the full message).
- `world.emitDelete(messageOrId)`, `world.emitBulkDelete(ids)` (emits a `Map` of partial messages and the channel), `world.emitEdit(message, { content, editedTimestamp, partial = false })` (updates the fake channel history, then emits `MessageUpdate(old, new)`); each settles.
- Subject surface gains `recordEdit` and `recordDelete`.

## Edge cases

- Delete a message → its text no longer appears in any bucket, in `randomStarters`, as a `them` parent, or in `frequent` counts; the `messages`, `filtered_messages` and Chroma rows all still exist (assert row counts and the fake collection's `rows`).
- Delete an unknown id, or the same id twice → no error; `deleted_at` keeps its first value.
- Delete the message before a would-be starter → the next message by another author becomes a starter (the deleted row is not a neighbour).
- Delete a bot message → absent from `avoidRepeats`; a reply to it starts no chain.
- Bulk delete of three ids → all three hidden.
- Edit `see you at 5` → `see you at 6`: one `message_revisions` row; the old corpus row hidden; a new corpus row `<id>:<editedAt>` with `source_id = id` and the original timestamp; Chroma has both ids; retrieval returns only the new text; `getRaw(id).content` is the new text; the `messages` row still holds the original text.
- A reply stored before its parent was edited still shows its parent in reply examples, now with the parent's new text.
- A new explicit reply to an edited message keeps that message as its reference (no inference).
- Edit to content the filter drops (a bare URL) → old row hidden, no new corpus row.
- Edit a second time → second revision row; the first revision's corpus row hidden too.
- Two update events with the same `editedTimestamp` → the second is a no-op.
- Update event with unchanged content → nothing written.
- `applyEdit` fails midway (force the corpus insert to throw) → nothing changed: no revision row, old row still visible.
- Edit then delete → every corpus row for the message hidden.
- Edit of a message by a non-approved author → revision stored, no corpus row.
- A reply whose parent was deleted keeps appearing as `{ you }` without `them`.
- A reply sent after its parent was deleted infers its reference from the previous visible message.
- Messages from another channel → ignored by both handlers.
- Existing databases: migrations add the columns and index; all existing rows are visible.

## Tests

- Unit: migrations on a legacy-schema database with rows (columns added once, rows intact, second run a no-op); each new store method, including the `applyEdit` transaction rollback; every read excludes invisible rows; reference resolution through logical ids; `recordEdit` (each numbered step and edge case); `recordDelete`; handlers (channel filter, partial fetch, bulk, bot author, errors logged); `createBot` registers the three events; retriever and persona selector hidden-id filtering; chain builder with deleted turns.
- `test/unit/nonDestructive.test.js` gains a rule: every SQL `UPDATE` in `src/` must have the form `UPDATE <table> SET deleted_at = ? WHERE … deleted_at IS NULL …` (soft-delete markers only).
- Scenario (`test/scenarios/edits-deletes.test.js`): each edge case above through the world.
- Existing tests: the client-options test additionally sees `Partials.Message`; nothing else changes.

## Docs

README: storage section (soft deletes, revisions, logical ids), known limitations above.

## Acceptance

`npm test` passes; `src/` contains no `DELETE FROM` and no Chroma delete call.
