# Spec 10: Ingest fixes (GIF metadata and inferred references)

**Depends on:** 02. **Blocks:** 18, 25.

## Problem

1. `vectorStore.upsertMessages` writes `has_gif: m.hasGif`, but ingest passes the filter output, which has no `hasGif`. Live messages therefore never carry `has_gif` in Chroma and never match the GIF retrieval bucket.
2. `messageStore.insertFiltered` resolves a reference (explicit, else the previous message by another author within the window), but ingest passes the unresolved record to the vector store. Live messages only enter `message_reply_embeddings` when they are explicit Discord replies to a stored message, which starves persona selection and the reply bucket.
3. In a batch, `upsertMessages` maps each referencing message to its parent's embedding; when the parent is not in the collection the embedding is `undefined` and is sent to Chroma anyway.

## Required behaviour

- `ingestService.recordMessage` passes the **StoredMessage** returned by `insertFiltered` (resolved `reference`, `hasGif`) to `vectorStore.upsertMessages`.
- `vectorStore.upsertMessages(messages)`:
  - writes metadata `{ author, timestamp, has_gif }` with `has_gif` always a boolean (`Boolean(m.hasGif)`) in both collections;
  - writes a row to the replies collection for every message whose `reference` is non-null **and** whose parent embedding exists in the messages collection (after this batch's own upsert); messages whose parent is missing are skipped for the replies collection only, never sent with an undefined embedding;
  - makes no Chroma call for the replies collection when nothing qualifies.
- No schema change. Existing Chroma rows are not modified here (spec 25 adds a non-destructive sync for old rows).

## Interfaces

No signature changes. `ingestService.recordMessage(record)` still returns `{ filtered }`, where `filtered` is now the StoredMessage (a superset of MessageRecord).

## Edge cases

- Kept message with `<gif!` → `has_gif: true`; without → `false` (not absent).
- Inferred reference (no explicit reply): replies-collection row stored under the inferred parent's embedding.
- Explicit reference to a message not in `filtered_messages`: falls back to the heuristic as before; whichever reference is resolved is the one used for the replies collection.
- Resolved reference `null`: messages collection only.
- Batch of `[parent, child]` where the parent is new in the same batch: the child's reply row uses the parent's embedding.
- Batch where one child's parent is missing from Chroma and another's is present: only the second gets a reply row.

## Tests

- Flip both `KNOWN BUG (spec 10)` tests in `test/characterization/storage.test.js`: rename them (drop the prefix) and assert `has_gif` is `true`/`false`, and that an inferred reference produces a reply row with the parent's embedding.
- Unit (`vectorStore`, `ingestService`): every edge case above; assert no `undefined` embedding is ever passed to the fake collection.
- Scenario (`test/scenarios/ingest.test.js`): two messages by different authors within the window, the second not a Discord reply → `searchLikelyRepliers` for a message similar to the first returns the second's author; a seeded GIF message by the persona appears in the GIF bucket of a later retrieval.

## Docs

Remove the two corresponding entries from README "Known issues".

## Acceptance

`npm test` passes; no other characterization test changes.
