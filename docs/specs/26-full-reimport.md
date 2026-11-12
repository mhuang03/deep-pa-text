# Spec 26: Full re-import from Discord

**Depends on:** 23, 24, 25 (and through them every earlier spec). **Blocks:** none. This is the final step after all features are merged.

## Why

The existing database and vector collections were filled by earlier code. Even after the fixes, old rows carry the old behaviour: no `has_gif` metadata, reply links only for explicit replies, replies to bot messages linked to unrelated messages, raw rows that today's filter would treat differently, edits and deletions made while the bot was offline never applied, and none of the bot's own past messages recorded. The vector sync in spec 25 repairs some of this, but only a clean import from Discord applies **all** current rules uniformly. Discord is the source of truth; the old data is kept as a backup and never modified.

## What it does

`npm run reimport -- [--yes] [--resume]` (`scripts/reimport.js`):

1. Backs up the current database as `<databasePath>.old`.
2. Puts a fresh database in its place, tied to a fresh generation of Chroma collections.
3. Imports the whole channel history from Discord through the normal ingest path, including the bot's own messages, then verifies the vectors.

Without `--yes` it only reads and reports (a dry run). **The bot must be stopped while it runs** (a running bot keeps its handle on the old file and would write into the backup); the script cannot detect a running bot, so it says so prominently before doing anything.

## Design

### Vector generations (`src/storage/metaStore.js`, `src/storage/vectorStore.js`)

Re-importing into the existing collections would overwrite existing ids with different content and embeddings, which `CLAUDE.md` forbids. Instead each database names the generation of collections it belongs to.

- Additive migration: `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`.
- `createMetaStore({ db })` → `get(key) → string | null`, `setIfAbsent(key, value) → boolean` (`INSERT … ON CONFLICT DO NOTHING`; never overwrites).
- `collectionNames(config, generation)` (pure): `generation` falsy → the configured names unchanged; otherwise `<name>_<generation>` for both collections.
- `createVectorStore({ client, embeddingFunction, config, generation = null })` uses those names. `buildContainer` reads `metaStore.get('chroma_generation')` once, right after opening the database, and passes it. An existing database has no such key, so it keeps using today's collections; this spec changes nothing for an installation until the script is run.
- A generation is `g` followed by the UTC timestamp `YYYYMMDDHHMMSS` of the run (from `clock.now()`); collection names stay within Chroma's 63-character limit. A resumed run reads the generation back from `meta`.

Restoring a backup (putting `messages.db.old` back as `messages.db`) therefore automatically points the bot at the old collections again, which were never touched.

### Container

`buildContainer({ …, client })` accepts an optional, already constructed Discord client and uses it instead of creating one (`getBotUserId` then reads that client). The re-import builds its container this way so there is exactly one client, and never calls `bot.start()`.

### Switching databases safely (`src/backfill/databaseSwitch.js`)

Paths: `db` = `config.storage.databasePath`, `db.new`, `db.old`. `createDatabaseSwitch({ fs, openDatabase, createMetaStore, logger })` →

- `inspect(db) → state`, one of:
  - `'ready'`: `db` exists; neither `db.new` nor `db.old` exists; no `db-journal`, `db-wal` or `db-shm` file exists.
  - `'interrupted-before-backup'`: `db.new` exists and `db.old` does not.
  - `'interrupted-before-swap'`: `db.new` and `db.old` both exist.
  - `'in-progress'`: no `db.new`; `db.old` exists; `db` has `reimport_started_at` and no `reimport_completed_at` in `meta`.
  - `'blocked'`: anything else (no database; a backup already exists next to a finished or ordinary database; journal files present). Carries a human-readable reason that names the offending file and what to do. The advice is always to move a file away or stop the bot, never to delete anything.
  All inspection opens databases read-only and tolerates a missing `meta` table.
- `prepare(db, { generation, startedAt })`: creates `db.new` with `openDatabase` (migrations run), `setIfAbsent('chroma_generation', generation)` and `setIfAbsent('reimport_started_at', String(startedAt))`, and closes it.
- `backup(db) → backupPath`: `fs.linkSync(db, db.old)` (a hard link: instant, and it fails rather than overwrites when `db.old` exists); if linking is not supported (`EPERM`, `ENOTSUP`, `EXDEV`), `fs.copyFileSync(db, db.old, fs.constants.COPYFILE_EXCL)`. Then verify the backup opens read-only and has a `messages` table.
- `swap(db)`: `fs.renameSync(db.new, db)`, an atomic replacement. The old content stays reachable as `db.old`.

At every instant `db` exists and is a complete database, and after `backup` the old data is safe under `db.old`. `renameSync`, `linkSync` and `copyFileSync` on database files appear nowhere else in the codebase. Nothing is ever deleted. Add `*.old` and `*.db.new` to `.gitignore`.

### Reading a previous database (`src/backfill/archiveReader.js`)

`createArchiveReader({ db })` over a **read-only** handle (no migrations are run on it), tolerant of tables that an older schema lacks (checked through `sqlite_master`):

- `botMessage(id) → { persona, content, reference, trigger } | null`;
- `profiles() → rows of user_profiles` (empty when the table is missing);
- `counts() → { raw, corpus, botMessages }` (missing tables count as 0);
- `rawPage({ afterId, limit }) → [{ id, content }]` for the comparison.

### Re-import service (`src/backfill/reimport.js`)

`createReimporter({ config, vendor, data, clock, logger, fs, buildContainer, createDiscordClient, databaseSwitch, openDatabase })` → `run({ yes = false, resume = false }) → Promise<Report>`. Steps, ordered so that nothing is changed until everything that can fail early has succeeded:

1. **Inspect.** `state = databaseSwitch.inspect(db)`.
   - Fresh run (`resume` false): requires `'ready'`; any other state throws with its reason (for the three interrupted states the message says to run with `--resume`, or, for `'interrupted-before-backup'`, to move `db.new` away).
   - `resume` true: requires `'interrupted-before-swap'` or `'in-progress'`; `'ready'` throws ("nothing to resume").
2. **Connect.** Construct the Discord client (`createDiscordClient(vendor.Client, { cacheMessages: false })`), log in, wait for ready, fetch `config.discord.channelId`.
3. **Read** the entire history with the spec 25 history reader (retries and timeouts included). A failure here aborts with nothing changed.
4. **Plan.** Open the current source of old data read-only as an archive (`db` on a fresh run; `db.old` when resuming). Classify the messages (`isKnownBotMessage` and the bot-message lookup come from the archive) and compute: fetched, human messages, own bot messages, other bots' messages, and how many human messages the corpus filter would keep. Without `yes`, return the report with `applied: false` and stop.
5. **Switch.** Fresh run: `prepare` (generation computed once here), `backup`, `swap`. Resuming from `'interrupted-before-swap'`: `swap` only. Resuming from `'in-progress'`: nothing.
6. **Build** the normal container on `db` with the step 2 client, and `await vectorStore.connect()` (creates the generation's collections on first use).
7. **Carry over** from the archive of `db.old`: every `user_profiles` row, through `profileStore.record`. Nothing else is copied.
8. **Import** the already-read messages with `historyImporter.importMessages(messages, { channel, botMessageLookup: archive.botMessage })`: the bot's own messages first, then human messages oldest first in batches. A bot message keeps the persona, trigger, reference and token-bearing content recorded in the backup; one that predates that table falls back to its embed or profile match (spec 25).
9. **Verify vectors.** `vectorSync.run()` (spec 25), so that any batch whose vector write failed earlier, in this run or a previous interrupted one, is repaired.
10. **Complete.** `metaStore.setIfAbsent('reimport_completed_at', String(clock.now()))`, only after step 9 succeeded.
11. **Report**, destroy the client.

Steps 7 to 9 are idempotent (existing ids are skipped), so a resumed run continues where the interrupted one stopped.

### What is and is not carried over

| Data | In the new database |
| --- | --- |
| Human messages currently in the channel | Re-imported with their **current** content; filtered, referenced and embedded by the current rules |
| Messages deleted from Discord | Absent (they remain in the backup) |
| Edit history (`message_revisions`), soft-delete markers | Not carried over; the import reflects Discord's current state |
| The bot's own messages still in the channel | Stored in `bot_messages` (persona from the backup's table, else embed, else profile match) |
| Bot messages deleted from Discord, empty placeholders | Absent |
| `user_profiles` history | Copied |
| Old Chroma collections | Left untouched under their old names; the new database uses a new generation |
| Messages posted after the read finished | Not included; see "After the run" |

### Report

`Report = { applied, state, generation, backupPath, fetched, humans, ownBot, otherBots, wouldKeep, imported: { insertedRaw, kept, botMessages, unattributedBotMessages, skippedEmptyBotMessages }, sync, comparison }`. `sync` is the vector-sync result. `comparison` (only when applied; read-only queries on the backup and the new database) is `{ old: { raw, corpus, botMessages }, new: { raw, corpus, botMessages }, missingInNew, changedContent }`: `missingInNew` counts raw ids in the backup that are not in the new database (deleted since, or outside the channel), `changedContent` counts ids whose raw content differs (edited since).

### Script (`scripts/reimport.js`)

Parses `--yes` and `--resume` (`parseReimportArgs`, pure; unknown options exit 2), prints the stop-the-bot warning, loads env, config and data, runs the reimporter, prints the report as readable lines, and exits 0 (1 on error, with the message).

- Without `--yes`: prints the plan and `Nothing was changed. Re-run with --yes to apply.`
- After an applied run it prints: the backup path; the generation; that the old Chroma collections were left in place; a warning when any bot messages were unattributed; and the next steps under "After the run".

### After the run (script output and README)

- Run `npm run backfill` once before starting the bot: it picks up anything posted while the re-import was running.
- Then start the bot. It uses the new generation automatically.
- Rollback: stop the bot; move `messages.db` aside; rename `messages.db.old` to `messages.db`. Anything recorded after the re-import stays in the file moved aside and is not in the restored database.
- The old Chroma collections and the backup stay until someone removes them by hand. A second re-import requires moving `messages.db.old` away first.

## Safety rules

- Nothing is modified before step 5; a failure in steps 1 to 4 leaves everything exactly as it was.
- The backup file is opened read-only and never written.
- No file is deleted and no Chroma collection is deleted or modified.
- `test/unit/nonDestructive.test.js` gains: no `unlink`, `rm`, `rmSync`, `rmdir` or `truncate` call anywhere in `src/` or `scripts/`; `renameSync`, `linkSync` and `copyFileSync` appear only in `src/backfill/databaseSwitch.js`.
- `CLAUDE.md` Data safety: add that a database file is replaced only through `databaseSwitch` (backup to `*.old`, never overwritten) and that a re-import always uses a new vector generation.

## Cost and duration (document in README)

Every kept message is embedded again (one OpenAI embeddings request per batch of 100). Fetching history is limited by Discord to 100 messages per request. For a channel with a few hundred thousand messages expect tens of minutes, a small embeddings bill, and a few hundred megabytes of memory.

## Harness

The scenario test needs real database files and several containers, so it does not use `createWorld`. It creates one set of standalone fakes (`createFakeDiscord`, `createFakeChroma`, `createFakeOpenAI`, `createFakeGifs`), passes the same `vendor` to everything it builds (the fakes' state is shared across instances from one factory; add that guarantee to the fakes if missing), uses a temp directory for the database paths, and a controllable `clock`. The fake channel history needs controls to remove and edit a message (present from spec 24).

## Edge cases

- No `--yes` → report with `applied: false`; the database file's bytes and the Chroma fake are unchanged; no `.old` or `.new` file exists.
- `messages.db.old` already exists next to an ordinary database → blocked before connecting to Discord, with a message naming the file.
- A `messages.db-journal` file exists → blocked.
- Database file missing → blocked (use `npm run backfill` for a first import).
- History fetch fails beyond its retries → error; no backup made; database untouched.
- Applied run: `messages.db.old` is byte-identical to the previous `messages.db`; the new database contains only messages present in the fake channel history; collections named `message_embeddings_<generation>` and `message_reply_embeddings_<generation>` hold the vectors; the old collections' rows are unchanged; `meta` has the generation and both timestamps.
- Crash simulations (make the injected `fs` throw at a chosen call): after `prepare` → state `'interrupted-before-backup'`, `db` untouched, a fresh run refuses with instructions; after `backup` → `'interrupted-before-swap'`, `--resume` swaps and completes; after `swap` → `'in-progress'`, `--resume` completes. In every case `db` opens as a valid database and no data is lost.
- Hard links unsupported (`linkSync` throws `EXDEV`) → the copy path is used; an existing `db.old` still refuses.
- A message deleted from Discord but present in the old database → not in the new one; counted in `missingInNew`.
- A message edited on Discord since it was stored → new content in the new database; counted in `changedContent`.
- A raw row the old code stored but never put in the corpus, which today's filter keeps → has a corpus row in the new database.
- Old rows lacked `has_gif` / inferred reply rows → present for every new row.
- A human reply to a bot message → `NULL` reference in the new corpus.
- Bot message recorded in the backup's `bot_messages` → same persona, trigger and token-bearing content in the new table; bot message that predates the table → persona from its embed, trigger `imported`; an own-webhook message attributed through the copied profile history; bot message with no recognisable persona → not stored, counted, and the script warns.
- Backup created before `bot_messages`, `user_profiles` or `meta` existed → those reads return nothing, without error.
- Import fails midway because Chroma rejects a batch → error reported, state `'in-progress'`; `--resume` completes the import, the sync restores the missing vectors (assert they exist), and only then is `reimport_completed_at` set; a further `--resume` reports nothing to resume.
- After the run, building the normal container on the new database uses the new generation; building it on the backup uses the original collection names.
- A database that was never re-imported → `collectionNames` returns the configured names.

## Tests

- Unit: `metaStore` (`setIfAbsent` never overwrites; migration idempotent); `collectionNames`; `createVectorStore` with a generation; container reads the generation and accepts a client; `databaseSwitch` (`inspect` for every state with real temp files, `prepare`, `backup` by link and by copy and its refusals, `swap`); `archiveReader` (present and missing tables, read-only); `parseReimportArgs`; reimporter with fakes (order of operations: nothing changed before the read completes; each state transition; lookup from the archive; carry-over; sync before completion; report and comparison counts).
- Scenario (`test/scenarios/reimport.test.js`): seed an "old" database through the normal stores (including rows with the pre-fix shape, a since-deleted message, a since-edited message, recorded bot messages, profile history), put the current channel state into the fake channel history, then exercise every edge case above.
- `nonDestructive.test.js` with the new rules passes.

## Docs

README: a "Re-importing from Discord" section (when to do it, stop the bot first, dry run then `--yes`, what is and is not carried over, cost, the backup and generation, `--resume`, the steps after the run, rollback), and `*.old` among the git-ignored local files.

## Acceptance

`npm test` passes. On a temp copy, `node scripts/reimport.js` without flags changes nothing on disk; `node scripts/reimport.js --bogus` exits 2.
