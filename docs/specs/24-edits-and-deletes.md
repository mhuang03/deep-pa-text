# Spec 24: Message edits and deletes (soft, non-destructive)

**Depends on:** 15, 19, 21. **Blocks:** 25.

## Problem

When someone deletes or edits a message, the corpus keeps the original forever and the bot can keep imitating text its author removed. `CLAUDE.md` forbids deleting or overwriting stored data, so removal must be a soft delete and an edit an appended revision.

## Design principle

SQLite is the source of truth for visibility. Rows are marked, never removed; Chroma is never modified for a delete (hidden rows are filtered out of query results in application code); an edit adds new rows under a new corpus id.

## Schema (additive migrations)

```
addColumn messages.deleted_at            INTEGER
addColumn filtered_messages.deleted_at   INTEGER
addColumn filtered_messages.source_id    TEXT      -- Discord id when this row is an edited revision
addColumn bot_messages.deleted_at        INTEGER
CREATE TABLE IF NOT EXISTS message_revisions (
  message_id TEXT NOT NULL,
  content    TEXT NOT NULL,
  edited_at  INTEGER NOT NULL,
  PRIMARY KEY (message_id, edited_at)
)
```

A row is **visible** when `deleted_at IS NULL`.

## Store changes

`messageStore`:
- `softDelete(id, at) → boolean`: sets `deleted_at = at` on the `messages` row and on every `filtered_messages` row with `id = ?` or `source_id = ?`, only where it is currently `NULL`. Returns whether anything was marked.
- `supersede(id, at)`: marks the `filtered_messages` rows only (same match), leaving `messages` visible.
- `addRevision({ messageId, content, editedAt })`: `INSERT ... ON CONFLICT DO NOTHING`.
- `getRaw(id)` returns `{ id, author, content, timestamp, reference, deleted }` with `content` = the latest revision's content when one exists, else the original.
- `hiddenIds(ids) → Set<string>`: the given ids whose `filtered_messages` row exists and is not visible (chunks of 500).
- `insertFiltered(record, { sourceId = null, inferReference = true })` stores `source_id`.
- Every corpus read excludes invisible rows: `randomMessages`, `randomStarters`, `burstRate`, `countContents`, `getParents` (an invisible parent counts as no parent), the previous-message lookup used for reference inference, and the existence check for an explicit reference (an invisible target falls back to inference).

`botMessageStore`: `softDelete(id, at)`; `recent` excludes invisible rows; `getById` returns invisible rows with `deleted: true`.

## Retrieval

- After every vector query, the retriever and the persona selector drop hits whose id is in `messageStore.hiddenIds(hit ids)`. Ids unknown to SQLite stay (older data may exist only in Chroma). Over-fetching (spec 19) keeps buckets full.
- `getEmbeddings` results for hidden ids are ignored.
- Chain building (spec 21): a deleted human turn is skipped and the walk continues; a deleted bot message as the direct parent means no chain; a deleted bot message further up ends the walk.

## Ingest

`ingestService.recordEdit({ id, author, content, timestamp, reference, editedAt }) → { changed: boolean }`:

1. `raw = messageStore.getRaw(id)`. Not found (the message predates the bot's records) → treat it as a new message: `recordMessage({ id, author, content, timestamp, reference })`, return `{ changed: true }`.
2. `raw.deleted`, or `content === raw.content` (Discord also emits updates for embed resolution and pins) → `{ changed: false }`.
3. `addRevision`.
4. `supersede(id, editedAt)`.
5. Filter `{ id: '<id>:<editedAt>', author, content, timestamp, reference }`. When kept: `insertFiltered(filtered, { sourceId: id, inferReference: <as for a new message> })` and `vectorStore.upsertMessages([stored])`. The revision keeps the original `timestamp`.

`ingestService.recordDelete(id, at)`: `messageStore.softDelete(id, at)` and `botMessageStore.softDelete(id, at)`.

## Discord

- `createDiscordClient` adds `partials: [Partials.Message]` so events arrive for uncached messages. Intents are unchanged.
- `src/bot/handlers/messageDelete.js`: for `MessageDelete` (one message) and `MessageBulkDelete` (a collection): ignore other channels (`message.channelId`); call `recordDelete(message.id, now())` for each. Partial messages are fine (only `id` and `channelId` are used).
- `src/bot/handlers/messageUpdate.js`: for `MessageUpdate(oldMessage, newMessage)`: ignore other channels; if `newMessage.partial`, `await newMessage.fetch()`; ignore bot authors; `recordEdit({ ...toMessageRecord(newMessage), editedAt: newMessage.editedTimestamp ?? now() })`.
- Edits and deletes are not channel activity: they do not touch the activity tracker or the reply policy and never trigger a reply.
- Both handlers catch and log their errors.

## Edge cases

- Delete a message → its text no longer appears in any bucket, in `randomStarters`, as a `them` parent, or in `frequent` counts; the `messages`, `filtered_messages` and Chroma rows all still exist (assert row counts and the fake collection's `rows`).
- Delete an unknown id, or the same id twice → no error, second call changes nothing (`deleted_at` keeps the first value).
- Delete a bot message → absent from `avoidRepeats`; a reply to it starts no chain.
- Bulk delete of three ids → all three hidden.
- Edit `see you at 5` → `see you at 6`: one `message_revisions` row; old corpus row hidden; new corpus row `<id>:<editedAt>` with `source_id = id` and the original timestamp; Chroma has both ids; retrieval returns only the new text; `getRaw(id).content` is the new text; the `messages` row still holds the original text.
- Edit to content the filter drops (for example a bare URL) → old row hidden, no new corpus row.
- Edit a second time → second revision row; first revision corpus row hidden too (matched by `source_id`).
- Update event with unchanged content → nothing written.
- Edit then delete → every corpus row for the message hidden.
- Edit of a message by a non-approved author → revision stored, no corpus row (as for new messages).
- A reply whose parent was deleted keeps appearing as `{ you }` without `them`.
- A reply sent after its parent was deleted infers its reference from the previous **visible** message.
- Messages from another channel → ignored by both handlers.
- Existing databases: migrations add the columns; all existing rows are visible.

## Tests

- Unit: migrations on a legacy-schema database with rows (columns added once, rows intact, second run a no-op); each new store method; every read excludes invisible rows; `recordEdit` (each numbered step and edge case); `recordDelete`; handlers (channel filter, partial fetch, bulk, bot author, errors logged); retriever and persona selector hidden-id filtering; chain builder with deleted turns.
- Harness: `world.emitDelete(messageOrId)`, `world.emitBulkDelete(ids)`, `world.emitEdit(message, { content, editedTimestamp })` (emit `Events.MessageDelete`/`MessageBulkDelete`/`MessageUpdate` and settle; an edit also updates the fake channel history).
- Scenario (`test/scenarios/edits-deletes.test.js`): each edge case above through the world.
- Characterization: the wiring test additionally expects `Partials.Message`; nothing else changes. `nonDestructive.test.js` passes (the new SQL uses only `UPDATE ... SET deleted_at` on `NULL` values and inserts).

## Docs

README: storage section (soft deletes, revisions, what "deleted" means for stored data), known limitations.

## Acceptance

`npm test` passes; a grep of `src/` shows no `DELETE FROM` and no Chroma delete call.
