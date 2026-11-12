# Spec 32: Data, retrieval and re-import correctness

**Depends on:** 31. **Blocks:** 33. **Audit findings:** A1, A4, A9, A10, A17, A18, A26, A33, A35, A39, A44, A46, A52, A59, A60, A73, A79.

## Problem

- `RANDOM_STARTERS` is quadratic: its join condition (`f.id = g.id OR f.source_id = g.id`) makes SQLite rescan the windowed subquery for every row. Measured: 2,000 messages 0.4 s, 20,000 messages 52 s, on the synchronous database driver, which freezes the whole bot.
- A message that the filter first dropped and that entered the corpus only through an edit has no corpus row with its own id, so replies to it lose their reference.
- An edited reply to a bot message can be re-linked to an unrelated earlier message.
- Retrieval: candidates that are cut by a bucket's limit still suppress their duplicates in later buckets, so the best match can vanish from the prompt; the persona selector drops hidden hits without over-fetching.
- Conversation starters ignore the bot's own messages, so the first human reply to a revive counts as a starter.
- Re-import: when hard links are unavailable the backup is a copy; if the copy is interrupted, `--resume` swaps the fresh database over the original and only a truncated backup remains. The journal-file refusal advises moving the journal away, which would lose a half-written transaction.
- `test/unit/nonDestructive.test.js` is a deny-list that misses many destructive forms.

## Required behaviour

### Conversation starters (`src/storage/messageSql.js`)

The gap sequence is computed once, over the visible raw messages **and** the visible bot messages (so a message that follows a bot message within the gap is not a starter), and joined to the corpus by logical id without an `OR`:

```sql
WITH timeline AS (
  SELECT id, timestamp FROM messages WHERE deleted_at IS NULL
  UNION ALL
  SELECT id, timestamp FROM bot_messages WHERE deleted_at IS NULL
),
gaps AS (
  SELECT id, timestamp - LAG(timestamp) OVER (ORDER BY timestamp, id) AS gap FROM timeline
)
SELECT f.content
FROM filtered_messages f
JOIN gaps g ON g.id = COALESCE(f.source_id, f.id)
WHERE f.author = ? AND f.deleted_at IS NULL AND (g.gap IS NULL OR g.gap > ?)
ORDER BY RANDOM() LIMIT ?
```

Add `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp)` as a migration. The implementer verifies with `EXPLAIN QUERY PLAN` that the join uses an automatic or real index on `gaps.id` and adjusts the statement if not (for example by materialising `gaps`), keeping the semantics.

`burstStats` gets the same treatment if its plan is not linear; state the measured timings in the hand-back.

### Edits (`src/storage/messageStore.js`, `src/ingest/ingestService.js`)

- **Anchor row.** In `applyEdit`, when no corpus row with `id = <logical id>` exists (the original was dropped by the filter), the new corpus row is inserted with `id = <logical id>` and `source_id NULL`. Otherwise the row id is `<logical id>:<editedAt>` as before. Every logical message that has ever had a corpus row therefore has a row whose id is the logical id, which satisfies the foreign key on `reference` and makes reference lookups work.
- **An edit keeps its reference.** When the message already has a visible corpus row, the new row takes that row's `reference` unchanged (no re-resolution, no inference). Only when there is no previous corpus row is the reference resolved as for a new message (`repliesToBot` from the bot-parent check). The `messageUpdate` handler uses the same bot-parent finder as `messageCreate` for that case, without a Discord fetch.
- Reference resolution accepts an explicit reference when the logical message has a visible corpus row (any row with that logical id), as spec 24 states.

### Retrieval

- `dedupeBuckets(buckets, { …, limits })`: each bucket's limit is applied **during** the greedy pass. Once a bucket has kept `limits[i]` items, its remaining candidates are skipped without being merged anywhere, so they cannot suppress duplicates in later buckets. The retriever passes its four limits and no longer cuts afterwards.
- `personaSelector`: query `likelyRepliers × retrieval.overFetchFactor` hits, drop hidden ones, then cut to `likelyRepliers`.

### Re-import (`src/backfill/databaseSwitch.js`, `src/backfill/reimport.js`)

- **Backup by copy is atomic.** When hard links are unavailable: `copyFileSync(db, db.old.tmp, COPYFILE_EXCL)`, verify the copy (below), then `renameSync(db.old.tmp, db.old)`. A leftover `db.old.tmp` is a new blocked state whose message says the file is an incomplete backup that may be moved away.
- **Verification.** `verifyBackup(db, backupPath)`: the two paths are the same inode (`statSync` `dev` and `ino` equal), or they have the same size and the same SHA-256. Used after a copy and **before every swap, including on `--resume`**. A backup that fails verification makes the run refuse, naming the file; nothing is swapped.
- **Journal advice.** The refusal for a `-journal`, `-wal` or `-shm` file says: the database was not closed cleanly; start the bot and stop it cleanly (or open and close the database with `sqlite3`) so SQLite recovers it; do not move or delete that file.
- **Resume and Discord changes.** A resumed run imports from a fresh read of Discord, but rows imported by the interrupted run are not re-checked against it. Document this; the remedy is a second re-import.
- `webhooks.forChannel` and `ownedIds` throw `Error('bot user id is not known yet')` when `getBotUserId()` returns nothing, instead of matching ownerless webhooks.
- Unattributed bot messages are reported as one log line with the count and the first five ids, not one line each.

### Non-destructive guard (`test/unit/nonDestructive.test.js`)

Rewritten around allow-lists, with the checker functions exported from `test/support/nonDestructive.js` so they can be tested with known-bad samples:

- every SQL statement in `src/` and `scripts/` (string literals and templates) must start with one of: `SELECT`, `WITH` (ending in a `SELECT`), `INSERT INTO … ON CONFLICT … DO NOTHING` or plain `INSERT INTO`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN`, `PRAGMA`, `BEGIN`, `COMMIT`, `ROLLBACK`, or `UPDATE <table> SET deleted_at = ? WHERE … deleted_at IS NULL …`. Anything else fails, including `UPDATE OR REPLACE`, `ALTER … RENAME/DROP`, `VACUUM`, `DELETE`, `DROP`, `REPLACE`.
- `addColumn` migration descriptors: the definition must not contain `NOT NULL` without `DEFAULT`, `PRIMARY KEY`, `UNIQUE` or `REFERENCES`.
- Chroma: `.delete(`, `.update(`, `.modify(`, `deleteCollection(`, `.reset(` are forbidden everywhere in `src/` and `scripts/`; `.upsert(`/`.add(` only in `src/storage/` vector-store files.
- Files: `rm`, `rmSync`, `rmdir`, `unlink`, `truncate`, `writeFile`, `appendFile`, `cp`, `copyFile`, `rename`, `link` and their `Sync`/promise variants are forbidden in `src/` and `scripts/`, except `renameSync`, `linkSync`, `copyFileSync` in `src/backfill/databaseSwitch.js`.
- Self-tests: each forbidden form above is fed to the checker as a sample and must be reported.

## Edge cases

- Starters at scale: 20,000 raw messages → `randomStarters` returns in under one second (generous bound for slow machines; state the measured time).
- A human message 5 minutes after a revive, more than an hour after the previous human message → not a starter. A human message more than an hour after any message, bot or human → a starter.
- Original `https://example.com` (dropped), edited to `finally got it working` → one corpus row with `id = <discord id>`, `source_id NULL`; a later explicit reply to it keeps the reference and gets a reply row; a second edit creates `<id>:<editedAt>` with `source_id = <id>` and hides the first.
- An edited message keeps the reference it had, including `NULL` for a reply to a bot message.
- Dedup: a text at rank 15 of `replies` (limit 10) and rank 1 of `similar` → it appears in `similar`.
- Persona selection with many hidden hits near the query → still `likelyRepliers` visible hits when enough exist.
- Copy-path backup interrupted mid-copy (injected `fs` throws) → `db.old.tmp` remains, `db.old` does not; the next run is blocked with the message above; the database is untouched.
- `--resume` with a truncated `db.old` next to `db.new` → refused; `db` untouched.
- `--resume` with a hard-linked or identical `db.old` → proceeds.
- `forChannel` before the client is ready → throws; nothing is created.
- Each known-bad sample in the non-destructive self-tests is caught; the real source passes.

## Tests

- Unit: `randomStarters` semantics (all spec 20 and 24 cases still pass) plus the bot-message rule and the scale test; `EXPLAIN QUERY PLAN` assertion that no full rescan per row occurs (assert the plan text does not contain a correlated scan of the gaps subquery); `applyEdit` anchor row and reference carry-over; reference resolution through logical ids; `dedupeBuckets` with limits; persona over-fetch; `databaseSwitch` copy path, `verifyBackup` (same inode, equal copy, truncated copy, different content), new blocked state, journal message text; webhook provider guard; non-destructive checker self-tests.
- Scenario: extend `edits-deletes`, `dedup`, `revive-context` and `reimport` scenarios with the edge cases above.
- Existing tests: `dedupeBuckets` callers and tests take `limits`; the reimport unit test "resuming before the swap only swaps" now also verifies.

## Docs

README: re-import section (verification, incomplete backup, journal advice, the resume limitation); backfill dry run wording: "a dry run writes no rows; it may apply additive schema migrations and create empty collections".

## Acceptance

`npm test` passes, including the scale test and the hardened non-destructive test.
