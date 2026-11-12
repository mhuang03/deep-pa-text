# Spec 26: Full re-import from Discord

**Depends on:** 23, 24, 25 (and through them every earlier spec). **Blocks:** none. This is the final step after all features are merged.

## Why

The existing database and vector collections were filled by earlier code. Even after the fixes, old rows carry the old behaviour: no `has_gif` metadata, reply links only for explicit replies, replies to bot messages linked to unrelated messages, edits and deletions made while the bot was offline never applied, and none of the bot's own past messages recorded. The vector sync in spec 25 repairs some of this, but only a clean import from Discord applies **all** current rules uniformly. Discord is the source of truth; the old data is kept as a backup, never modified.

## What it does

`npm run reimport -- [--yes] [--resume]` (`scripts/reimport.js`):

1. Moves the current database aside as a backup (`<databasePath>.old`).
2. Creates a fresh database and a fresh generation of Chroma collections.
3. Imports the whole channel history from Discord through the normal ingest path, including the bot's own messages.

Without `--yes` it only reads and reports (a dry run). The bot must be stopped while it runs.

## Design

### Vector generations (`src/storage/metaStore.js`, `src/storage/vectorStore.js`)

Re-importing into the existing collections would overwrite existing ids with different content and embeddings, which `CLAUDE.md` forbids. Instead each database names the generation of collections it belongs to.

- Additive migration: `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`.
- `createMetaStore({ db })` → `get(key) → string | null`, `setIfAbsent(key, value) → boolean` (`INSERT … ON CONFLICT DO NOTHING`; never overwrites).
- `collectionNames(config, generation)` (pure, in `vectorStore.js`): `generation` falsy → the configured names unchanged; otherwise `<name>_<generation>` for both collections.
- `buildContainer` reads `metaStore.get('chroma_generation')` once, right after opening the database, and builds the vector store with those names. An existing database has no such key, so it keeps using today's collections. A re-imported database always uses its own.
- A generation is `g` followed by the UTC timestamp `YYYYMMDDHHMMSS` of the run (collection names stay within Chroma's 63-character limit).

Restoring a backup (renaming `messages.db.old` back) therefore automatically points the bot at the old collections again, which were never touched.

### Backup (`src/backfill/databaseBackup.js`)

`backupDatabase({ databasePath, fs }) → backupPath`:

- backup path is `<databasePath>.old`;
- refuses (throws, changing nothing) when: the database file does not exist; the backup path already exists (a backup is never overwritten; the message tells the user to move it away first); or a `-journal`, `-wal` or `-shm` sibling of the database exists (the database is open or was not closed cleanly);
- otherwise `fs.renameSync(databasePath, backupPath)`.

This is the only place in the codebase allowed to rename a database file. Nothing is ever deleted. Add `*.old` to `.gitignore`.

### Re-import service (`src/backfill/reimport.js`)

`createReimporter({ fs, config, vendor, data, clock, logger, openDatabase, buildContainer, createDiscordClient })` → `run({ yes = false, resume = false }) → Promise<Report>`. Steps, in this order, so that nothing is changed until everything that can fail early has succeeded:

1. **Preconditions** (read-only): validate that the backup can be made (same checks as `backupDatabase`, without renaming); for `--resume` instead require that `<databasePath>.old` exists and the current database has `reimport_started_at` but no `reimport_completed_at` in `meta`.
2. **Connect:** construct a Discord client (`createDiscordClient`), log in, wait for ready, fetch `config.discord.channelId`. No handlers are registered; the script never replies.
3. **Read** the entire history with `historyReader.readAll(channel)` (spec 25). A failure here aborts with nothing changed.
4. **Plan:** classify the messages and compute counts: fetched, human messages, own bot messages, other bots' messages, and how many human messages the corpus filter would keep. Without `yes`, return the report with `applied: false` and stop here.
5. **Switch** (not when resuming): `backupDatabase`; open the fresh database (migrations run); `metaStore.setIfAbsent('chroma_generation', generation)`, `setIfAbsent('reimport_started_at', String(now()))`; close it.
6. **Build** the normal container on the new database (it picks up the generation) and `await vectorStore.connect()` (creates the new collections).
7. **Carry over** from the backup, opened **read-only**: every `user_profiles` row (the append-only profile history and known user ids), inserted with `profileStore.record`. Nothing else is copied.
8. **Import** with `historyImporter` logic on the already-read messages (no second fetch): the bot's own messages first, then human messages oldest first in batches. `botMessageLookup(id)` reads the backup's `bot_messages` table (when it has one), so a bot message keeps its recorded persona, trigger, reference and its content with GIF tokens; bot messages that predate that table fall back to the embed or profile match (spec 25).
9. **Complete:** `metaStore.setIfAbsent('reimport_completed_at', String(now()))`.
10. **Report** (below), destroy the client.

When resuming, steps 5 and 7 are skipped where already done (`setIfAbsent` and the stores' idempotent inserts make repeating them harmless) and step 8 skips ids already stored, so an interrupted run continues where it stopped.

`historyImporter` gains `importMessages(messages, { dryRun, botMessageLookup })` (the part of `run` after reading), which `run` now calls.

### What is and is not carried over

| Data | In the new database |
| --- | --- |
| Human messages currently in the channel | Re-imported with their **current** content; filtered, referenced and embedded by the current rules |
| Messages deleted from Discord | Absent (they remain in the backup) |
| Edit history (`message_revisions`), soft-delete markers | Not carried over; the import reflects Discord's current state |
| The bot's own messages still in the channel | Stored in `bot_messages` (persona from the backup's table, else embed, else profile match) |
| Bot messages deleted from Discord | Absent |
| `user_profiles` history | Copied |
| Old Chroma collections | Left untouched under their old names; the new database uses a new generation |

### Report

`Report = { applied, generation, backupPath, fetched, humans, ownBot, otherBots, wouldKeep, imported: { insertedRaw, kept, botMessages, unattributedBotMessages }, comparison }` where `comparison` (only when applied, computed with read-only queries on the backup and the new database) is `{ old: { raw, corpus, botMessages }, new: { raw, corpus, botMessages }, missingInNew, changedContent }`: `missingInNew` counts raw ids present in the backup but not in the new database (deleted since), `changedContent` counts ids whose raw content differs (edited since). A backup created by an older schema may lack some tables; missing tables count as zero.

### Script (`scripts/reimport.js`)

Parses `--yes` and `--resume` (`parseReimportArgs`, pure; unknown options exit 2), loads env, config and data, runs the reimporter, prints the report as readable lines, and exits 0 (1 on error, with the message). After an applied run it prints: where the backup is, the generation name, that the old Chroma collections were left in place, and the rollback steps (stop the bot; rename `messages.db` to something else; rename `messages.db.old` back to `messages.db`). Without `--yes` it prints the plan and the line `Nothing was changed. Re-run with --yes to apply.`

## Safety rules

- Nothing is modified before step 5; a failure in steps 1 to 4 leaves the system exactly as it was.
- The backup file is opened read-only and never written.
- No file is deleted and no Chroma collection is deleted or modified; old collections stay until someone removes them by hand.
- `test/unit/nonDestructive.test.js` gains: no `unlink`, `rm`, `rmSync`, `rmdir` or `truncate` call anywhere in `src/` or `scripts/`; `renameSync`/`rename` appears only in `src/backfill/databaseBackup.js`.

## Cost and duration (document in README)

Every kept message is embedded again (one OpenAI embeddings request per batch of 100). Fetching history is limited by Discord to 100 messages per request. For a channel with a few hundred thousand messages expect tens of minutes and a small embeddings bill; memory use is a few hundred megabytes while the history is held.

## Edge cases

- No `--yes` → report with `applied: false`; the database file, its modification time, and the Chroma fake are untouched; no backup file exists.
- `messages.db.old` already exists → refuses before connecting to Discord.
- A `messages.db-journal` file exists → refuses.
- Database file missing → refuses (use `npm run backfill` for a first import).
- History fetch fails on the third page → error; no backup made; database untouched.
- Applied run: `messages.db.old` is byte-identical to the previous `messages.db`; the new database contains only messages present in the fake channel history; new collections named `message_embeddings_<generation>` and `message_reply_embeddings_<generation>` hold the vectors; the old collections' rows are unchanged.
- A message that was deleted from Discord but is in the old database → not in the new one; counted in `missingInNew`.
- A message edited on Discord since it was stored → new content in the new database; counted in `changedContent`.
- Old rows lacked `has_gif` / inferred reply rows → present for every new row.
- A human reply to a bot message → `NULL` reference in the new corpus.
- Bot message recorded in the backup's `bot_messages` → same persona, trigger and token-bearing content in the new table; bot message that predates the table → persona from its embed, trigger `imported`; bot message with no recognisable persona → not stored, counted.
- Backup created before `bot_messages` or `user_profiles` existed → those lookups are skipped without error.
- Import fails midway (Chroma rejects a batch) → error reported; `--resume` afterwards completes the import without a second backup and without duplicating rows; a second `--resume` after completion refuses.
- After the run, building the normal container on the new database uses the new generation; building it on the backup (renamed back) uses the original collection names.
- A database that was never re-imported → `collectionNames` returns the configured names (existing installations are unaffected by this spec until the script is run).

## Tests

- Unit: `metaStore` (`setIfAbsent` never overwrites; migration idempotent); `collectionNames`; container uses the generation from `meta`; `backupDatabase` (each refusal, successful rename, with a real temp directory); `parseReimportArgs`; `importMessages` equivalence with `run`; reimporter steps with fakes (order of operations: nothing renamed before the read completes; lookup precedence; carry-over; report counts; resume preconditions).
- Scenario (`test/scenarios/reimport.test.js`), using a real temp directory for the database files and the standard fakes for Discord, Chroma and OpenAI: seed an "old" database through the normal stores (including rows with the pre-fix shape, a deleted-on-Discord message, an edited message, recorded bot messages), put the current channel state into the fake channel history, then exercise every edge case above.
- `nonDestructive.test.js` with the new rules passes.

## Docs

README: a "Re-importing from Discord" section (when to do it, stop the bot first, dry run then `--yes`, what is and is not carried over, cost, the backup and generation, rollback, `--resume`), and `*.old` in the list of git-ignored local files. `CLAUDE.md` Data safety: add that database files are replaced only by `backupDatabase` (rename to `*.old`, never overwrite) and that re-imports use a new vector generation.

## Acceptance

`npm test` passes. On a temp copy, `node scripts/reimport.js` (no flags) changes nothing on disk; `node scripts/reimport.js --bogus` exits 2.
