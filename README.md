# deep-pa-text

A Discord bot that imitates the members of one group chat. It records every message in a single channel, and occasionally replies to a message (or revives a quiet channel) "as" one of the members, using retrieval over that member's past messages plus an LLM.

## How it works

```
Discord message ──► corpus filter ──► SQLite (messages, filtered_messages)
                                └► Chroma (message_embeddings, message_reply_embeddings)

trigger (random reply / revive timer / "reply" context menu)
  └► pick persona ──► retrieve persona's past messages ──► DeepSeek chat completion
       └► resolve <gif! ...> tokens to GIF URLs ──► post with an embed showing the persona's name + avatar
```

Code lives in `src/`, CLI entry points in `scripts/`, tests in `test/`, specs in `docs/specs/`. Development rules are in `CLAUDE.md`; behaviour and design changes start from a spec in `docs/specs/`.

| Path | Role |
| --- | --- |
| `src/main.js` | Entry point (`npm start`): loads `.env` if present, config, required variables and data files, builds the container, connects Chroma, starts the bot. |
| `src/container.js` | Wires every service together. `src/vendor.js` collects the real third-party constructors. |
| `src/config.js`, `src/config/` | Every tunable, ID, model name and limit, with strict environment parsing and range validation (`config.js` is the public entry; `config/` holds the parsers, section builders, validators, required-variable checks and the optional `.env` loader). |
| `src/bot/` | Triggers and orchestration: `handlers/` (message, message edit, message delete, `reply` command, revive tick), reply, chain and revive policies, the bot-parent finder, activity tracker, composer (generate, resolve GIFs, truncate, per burst part), responder (typing, compose, deliver the parts), `bot.js`. |
| `src/corpus/` | Content transformers and keep/drop predicates applied before a message enters the corpus. |
| `src/storage/` | SQLite schema, migrations and queries (including soft deletes and edit revisions); the Chroma vector store; the read-only, schema-tolerant inspector behind `inspectDb.js`. |
| `src/ingest/`, `src/retrieval/`, `src/llm/`, `src/gifs/`, `src/context/` | Recording a message, retrieval and persona choice, prompts (assembled from sections) and the chat client, GIF resolution, the conversation transcript for replies and the reply-thread chain builder. |
| `src/discord/` | Discord client construction, payloads and safe mentions, embeds, delivery (the one place replies, channel posts and interaction edits are sent), the reply modal and the command definition. |
| `src/userData/`, `src/logger.js` | Reading `data/*.json`; the logger (errors as text, secrets redacted) and timestamp formatting. |
| `src/backfill/` | History import: argument parsing, the paged history reader, message classification, the importers for human and own-bot messages, and the full re-import (database switch, archive reader, plan, comparison, report). Imported only by `scripts/backfill.js`, `scripts/reimport.js` and the container. |
| `src/ingest/` | Recording messages into SQLite and Chroma, the vector sync (reconciles Chroma with SQLite) and the vector health (automatic repair). |
| `scripts/` | `registerCommands.js`, `inspectDb.js`, `gifSmoke.js`, `backfill.js` and `reimport.js` (see the npm scripts below). |

## Setup

Requirements: Node 22.18+ (uses `node:sqlite` and `process.loadEnvFile`), a Chroma server, and a Discord application with the **Message Content** privileged intent.

All paths (`.env`, `data/`, `messages.db`) are relative to the working directory, so run everything from the repo root.

1. Install dependencies.

   ```bash
   npm install
   ```

2. Provide the variables below in `.env` or in the environment. `.env` is optional (variables already in the environment are not overridden); a `.env` that exists but cannot be loaded stops startup. A missing required variable stops startup with one message listing all of them.

   | Variable | Used for |
   | --- | --- |
   | `DISCORD_BOT_TOKEN` | Bot login and command registration. Required by `npm start`, `backfill`, `reimport` and `register` |
   | `DISCORD_CLIENT_ID` | Command registration. Required by `npm run register` only |
   | `OPENAI_API_KEY` | Embeddings (`text-embedding-3-small`, 512 dims, via Chroma's embedding function). Required by `npm start`, `backfill` and `reimport` |
   | `DEEPSEEK_API_KEY` | Chat completions (`deepseek-v4-flash`, thinking enabled). Required by `npm start` only; the chat client is never built without it, so `OPENAI_API_KEY` is never sent to DeepSeek |
   | `KLIPY_API_KEY`, `GIPHY_API_KEY`, `HUMOR_API_KEY` | GIF search, tried in that order. All optional: only engines with a key are used, and with none every GIF token stays as placeholder text (one startup warning). `npm run gif-smoke` needs at least one |

   A variable that is empty or only whitespace counts as not set.

3. Create the data files (git-ignored; `*.old` backups and `*.db.new` files from a re-import are git-ignored too).

   `data/users.json` lists the members the bot may imitate. Only their messages enter the corpus.

   ```json
   [{ "username": "discord_username", "name": "Real Name", "id": "optional Discord user id" }]
   ```

   Each entry needs a non-empty string `username` and `name`; usernames must be unique ignoring case; the file must be a non-empty array. `id`, when given, is 5 to 25 digits (a string or a number); other keys are ignored. The optional `id` makes member lookups exact from the first use (see [Member profiles](#member-profiles)); without it the id is learned from the first successful search.

   `data/ping_caches.json` maps Discord IDs to display text, used to rewrite mentions.

   ```json
   { "users": { "<id>": "name" }, "roles": { "<id>": "name" }, "channels": { "<id>": "name" } }
   ```

   The file must be an object; `users`, `roles` and `channels` default to `{}` when absent. A missing, unreadable or malformed file stops startup with a one-line error naming the file.

4. Start Chroma on port 7429 (override with `CHROMA_PORT`).

   ```bash
   npx chroma run --port 7429 --path ./data/chroma
   ```

5. Register the context-menu command (once, or whenever commands change).

   ```bash
   npm run register
   ```

6. Run the bot.

   ```bash
   npm start
   ```

Other npm scripts: `npm run backfill` (see [Backfill](#backfill)), `npm run reimport` (see [Re-importing from Discord](#re-importing-from-discord)), `npm test` (unit and scenario tests; no network, real clock or real data), `npm run inspect` (prints the latest rows of `messages.db`, including the latest bot messages, opened read-only, no Chroma needed; each section's query is built from the columns that exist, so a database from any earlier schema is read in place: nothing is copied, migrated or written, a missing table prints `(no <table> table yet)`, and a missing or unreadable database prints one line and exits 1) and `npm run gif-smoke` (resolves a sample text through the real GIF APIs; exits 1 when no GIF key is set or a token stays unresolved).

### Configuration overrides

Everything else is defined in `src/config.js`. These optional environment variables (in `.env` or the shell) override the defaults. Boolean variables accept `true` or `false` in any case (anything else, such as `0`, `yes` or `off`, stops startup with an error naming the variable); an unset, empty or whitespace-only value takes the default. `PATEXT_CHANNEL_ID` and `GUILD_ID` must be 5 to 25 digits.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PATEXT_CHANNEL_ID` | `704837777564500149` | The one channel the bot reads and posts in |
| `GUILD_ID` | `478743674826784769` | Guild for command registration and member lookups |
| `CHROMA_PORT` | `7429` | Chroma server port (digits only, 1 to 65535) |
| `REPLY_OVERRIDE` | off | `true` replies to every message, ignoring randomness and the rate limit (testing) |
| `REVIVE_OVERRIDE` | off | `true` checks every minute and revives regardless of idle time (testing) |
| `CHAIN_REPLIES` | on | `false` turns off chain replies (replies to a bot message). Such replies are then handled like any other message: content filter, rate limit, probability roll and persona selection |
| `BURSTS` | on | `false` turns off multi-message bursts: the model is not told it may split, and any `<split>` marker in its output becomes a newline in a single message |
| `PING_REPLIED_USER` | on | `false` stops auto replies from pinging the author of the message they reply to |
| `CATCH_UP` | on | `false` skips importing messages posted while the bot was down. See [Operations](#operations) |
| `PERSONA_DISPLAY` | `embed` | `embed` or `webhook`; any other value stops startup with an error naming it. See [Persona display](#persona-display) |

Reply-control tunables in `src/config.js` (all 0 or more unless stated): `reply.failureCooldownMs` (60000: no new auto reply attempt after a failed one), `revive.failureCooldownMs` (1800000: no new revive attempt after a failed one), `chain.userCooldownMs` (10000), `chain.maxPerWindow` (6, integer of 1 or more), `chain.windowMs` (600000, above 0), `command.userCooldownMs` (30000), `command.maxConcurrent` (2, integer of 1 or more), `discord.modalPreviewChars` (1000: the target preview in the reply modal), `gifs.maxPerMessage` (2, integer of 0 or more: GIF tokens kept per delivered message), `discord.maxEmbeds` (10, integer of 1 or more: embeds per payload) and `llm.postProcessRetries` (1: extra completions when the output is empty after cleaning). Values outside these ranges stop startup.

Lifecycle tunables in `src/config.js`: `lifecycle.graceMs` (10000, 0 or more: how long shutdown waits for in-flight handlers), `lifecycle.pollMs` (100, above 0) and `catchUp.maxMessages` (2000, integer of 1 or more). Values outside these ranges stop startup.

Vector-store tunables in `src/config.js`: `chroma.timeoutMs` (30000, above 0: every interactive Chroma or embedding call), `chroma.connectTimeoutMs` (10000, above 0: startup connection), `chroma.batchTimeoutMs` (120000, above 0: each call of a batch operation: backfill, re-import and sync writes and reads), `vector.repairIntervalMs` (600000, above 0: how often the automatic repair runs and how often the missing-vectors warning may repeat) and `vector.repairWindowMs` (604800000, 7 days, above 0: how far back the automatic repair looks). Values outside these ranges stop startup. A timeout abandons the request without cancelling it; Chroma may still finish it in the background.

Backfill tunables in `src/config.js`: `backfill.pageSize` (100, 1 to 100), `backfill.batchSize` (100, 1 or more), `backfill.pageRetries` (3, 0 or more), `backfill.retryDelayMs` (2000) and `backfill.pageTimeoutMs` (30000, above 0). Values outside these ranges stop startup.

Other tunables in `src/config.js` for this feature: `discord.webhookName` (`deep-pa-text`), `discord.webhookUsernameMax` (80), `discord.webhookReplyLink` (true), `profiles.refreshIntervalMs` (3600000, integer of 0 or more; `0` disables the refresh), `profiles.minCheckIntervalMs` (10000, 0 or more), `profiles.lookupTimeoutMs` (5000, above 0) and `profiles.searchLimit` (100, 1 to 1000). Values outside these ranges stop startup.

Numeric tunables are validated when the config loads (for example `gifs.candidates` an integer of 1 or more, `gifs.timeoutMs` and `llm.timeoutMs` above 0, `llm.maxRetries` and `llm.emptyRetries` integers of 0 or more, `reply.probability` 0 to 1, `reply.minIntervalMs` 0 or more, `filter.minLength` at most `filter.maxLength`, every `retrieval.*Results`, `reviveSamples` and `likelyRepliers` an integer of 1 or more). `storage.busyTimeoutMs` (5000, integer of 0 or more) is applied as the SQLite busy timeout on every connection, read-only ones included, so a brief overlap between the bot and a script waits instead of failing.

The corpus is filled by live messages and by the [backfill](#backfill) script.

### Backfill

`npm run backfill -- [options]` imports the channel history into the existing database and repairs Chroma. Everything is additive and idempotent, and a dry run (`--dry-run`) writes no rows; it may apply additive schema migrations and create empty collections.

| Option | Meaning |
| --- | --- |
| `--dry-run` | Report what would be written; writes no rows (it may apply additive schema migrations and create empty collections) |
| `--skip-history` | Do not import from Discord (requires `--sync-vectors`) |
| `--sync-vectors` | After importing, reconcile Chroma with SQLite |
| `--before <id>` | Import only messages older than this Discord message id |
| `--limit <n>` | Fetch at most n messages, newest first |

An unknown option or invalid value prints the usage and exits 2. Without options the whole channel history is imported, skipping what is already stored. The import logs in to Discord without starting the bot (no handlers, so it never replies), pages backwards 100 messages at a time (each page has a timeout and is retried), and writes nothing until every page was read. Human messages go through the usual corpus filter in batches of `backfill.batchSize`, oldest first, so inferred reply references work; each batch makes one embedding request. The bot's own past messages (its user, its own webhooks, or ids already in `bot_messages`) are imported into `bot_messages` with trigger `imported`: the persona comes from the embed author, or for webhook messages from the one member whose username or a past display name equals the webhook name, and the reply-link line of webhook messages is removed. Messages with no attributable persona or no text are skipped and counted. Other bots and other applications' webhooks are dropped. A human reply to a bot message is stored without a reference, like a live one.

`--sync-vectors` walks the visible corpus in pages and adds rows missing from Chroma, adds `has_gif` to Chroma rows that lack it (document and embedding are passed back unchanged, nothing is re-embedded) and adds missing reply rows for rows with a reference. Rows whose stored document or embedding is missing, and replies whose parent has no embedding, are skipped and counted. Nothing is removed. If a vector call fails during an import, the SQLite rows are already written; run `npm run backfill -- --skip-history --sync-vectors` to repair. In a dry run the sync cannot see rows the import would have added.

Limits: a backfill only adds messages that are not stored yet. It does not re-filter existing raw rows, apply edits or deletions made while the bot was offline, or change stored references (a full [re-import](#re-importing-from-discord) does). Stop the bot first: the script and the bot would write the same SQLite file concurrently. A channel with a few hundred thousand messages takes tens of minutes to fetch (Discord serves 100 per request) and a few hundred megabytes of memory, plus one embedding call per batch of kept messages.

### Re-importing from Discord

`npm run reimport -- [--yes] [--resume]` rebuilds the database from Discord so that every current rule applies uniformly to old rows: `has_gif` metadata, reply links (replies to bot messages are no longer linked to unrelated messages), today's corpus filter, edits and deletions made while the bot was offline, and the bot's own past messages. Do it once after upgrading across the changes above; it is not routine.

**Stop the bot first.** A running bot keeps the old file open and would write into the backup; the script cannot detect a running bot and says so before doing anything.

1. Run `npm run reimport` without flags (a dry run). It reads the whole channel and prints a plan (messages fetched, human, the bot's own, other bots', how many the filter would keep) and changes nothing on disk or in Chroma.
2. Run `npm run reimport -- --yes`. It checks the state, reads the history (a failure here changes nothing), then backs up `messages.db` as `messages.db.old` (a hard link, else a copy made as `messages.db.old.tmp`, verified and renamed into place; it refuses to overwrite an existing backup), puts a fresh database in its place and imports through the normal path: the bot's own messages first, then human messages oldest first, then a vector sync. Nothing is ever deleted.
3. Run `npm run backfill` once to pick up anything posted during the re-import, then start the bot.

The new database belongs to a new generation of Chroma collections (`message_embeddings_g<UTC timestamp>` and the matching reply collection), recorded in `meta`. The old collections are not touched. If the run stops midway (a crash, or Chroma rejecting a batch), run `npm run reimport -- --yes --resume`; the steps are idempotent and the vector sync repairs batches whose vectors were not written. A fresh run refuses to start while a `.new`, `.old` or `.old.tmp` file from an earlier run exists, and says which file to move away. A leftover `messages.db.old.tmp` is an incomplete backup (the copy was interrupted) and may be moved away; the database itself is untouched.

**Verification.** Before every swap, including on `--resume`, the backup must be the same file as the database (same inode) or have the same size and SHA-256, and must open read-only with a `messages` table. A backup that fails this makes the run refuse, naming the file and leaving the database untouched: move `messages.db.old` (and `messages.db.new`) away and run again without `--resume`. A `-journal`, `-wal` or `-shm` file next to the database means it was not closed cleanly: start the bot and stop it cleanly (or open and close the database with `sqlite3`) so SQLite recovers it; do not move or delete that file.

**Resume and Discord changes.** A resumed run reads Discord afresh, but rows imported by the interrupted run are not re-checked against it. Messages edited or deleted in between are not reconciled; run a second re-import if that matters.

| Data | In the new database |
| --- | --- |
| Human messages currently in the channel | Re-imported with their current content, filtered, referenced and embedded by the current rules |
| Messages deleted from Discord, edit history, soft-delete markers | Not carried over (they stay in the backup) |
| The bot's own messages still in the channel | Stored in `bot_messages`: persona, trigger, reference and GIF-token content from the backup's table; else the embed author (trigger `imported`); else the profile history of webhook names. Messages with no recognisable persona are not stored and the script warns |
| `user_profiles` history | Copied |
| Old Chroma collections and the backup | Left in place |
| Messages posted after the history was read | Not included; `npm run backfill` adds them |

After an applied run the script prints the backup path, the generation, a comparison of the old and new databases (counts, ids missing in the new one, ids whose content changed) and these steps again.

Rollback: stop the bot, move `messages.db` aside, rename `messages.db.old` to `messages.db`. The restored database automatically uses the old collections again. Anything recorded after the re-import stays in the file moved aside. The backup and the old Chroma collections stay until someone removes them by hand; a second re-import requires moving `messages.db.old` away first.

Cost: every kept message is embedded again (one embeddings request per batch of 100), and Discord serves 100 messages per request. A channel with a few hundred thousand messages takes tens of minutes, a small embeddings bill and a few hundred megabytes of memory.

## Triggers

All four only act on the configured channel (`PATEXT_CHANNEL_ID`), and bot-authored messages are ignored.

| Trigger | When | Persona | Posts as |
| --- | --- | --- | --- |
| Auto reply | A human message that passes the content filters, at least 5 min after the last bot reply, with probability 0.1. After 10 consecutive random misses the chance rises 0.05 per miss until a reply happens. An accepted roll claims the single in-flight slot until the whole reply, bursts included, is out or has failed, so a message arriving meanwhile is not answered (it consumes no roll and counts no miss). A reply that fails before anything was sent (retrieval, persona selection, model, context) also blocks new attempts for `reply.failureCooldownMs` (60 s) and hands the activity back to the human message that triggered it; a failed send keeps arming the normal rate limit. | Weighted pick from the authors of the 20 nearest entries in `message_reply_embeddings` (people who replied to similar messages, excluding the message's author). Each hit weighs `1 / (1 + distance)` times a recency factor that halves every `persona.recencyHalfLifeMs` (180 days) and never drops below `persona.minRecencyWeight` (0.25); an author's weight is the sum over their hits. With no usable hits it falls back to a random user other than the message's author. | Discord reply to the message |
| Revive | Checked every 10 min. Fires only when the last activity in the channel was a human message (not a naturally spawned bot message, meaning an auto reply or a revive, and not a fresh start; chain replies and `reply` command replies do not count as the bot speaking, so idle time keeps running from the last human message) and it is more than 3 h old during 10:00–22:59 Central, or more than 12 h old otherwise. The bot therefore never revives twice in a row. A failed revive gives the activity back and blocks new attempts for `revive.failureCooldownMs` (30 min, kept in memory only). | Random user | Plain channel message |
| Chain reply | A human replies to a bot message and the bot message's persona is still in `users.json`. The first 3 bot messages in a thread are always answered (the global rate limit and probability do not apply); later ones with chance 0.5, 0.25, 0.125 and 0.0625; a thread never holds more than 8 bot messages. One chain reply is generated at a time. The same user gets at most one chain reply per `chain.userCooldownMs` (10 s) and at most `chain.maxPerWindow` (6) chain replies are accepted per `chain.windowMs` (10 min) in total. With chains enabled a reply to a bot message never falls through to the random auto reply; with `CHAIN_REPLIES=false` it does. Controlled by `CHAIN_REPLIES`, `chain.fullDepth`, `chain.decay`, `chain.maxBotTurns`, `chain.maxContextTurns` (12) and `chain.maxWalkSteps` (50). | Same persona as the bot message replied to | Discord reply to the message |
| `reply` context menu | A user right-clicks a message, then **Apps → reply**, and picks a persona (or `random`, which uses the auto-reply selection) in a modal (at most 24 users plus `random`: with more users the list starts with the default persona and is cut to 24; the original message is previewed up to `discord.modalPreviewChars` characters). Skips the probability and rate limit. A user may start one every `command.userCooldownMs` (30 s) and at most `command.maxConcurrent` (2) run at once; a refused invocation gets an ephemeral message. The submission is acknowledged at once (`deferReply`), then the persona is chosen, the placeholder is shown and the reply generated, so slow lookups cannot miss Discord's 3 s limit. | Chosen in the modal | Interaction reply (not a Discord reply to the target). When the target is a bot message it is shown as its persona and that persona is the modal's default choice. |

`REPLY_OVERRIDE` and `REVIVE_OVERRIDE` remove the randomness and timers for testing.

### Typing and bursts

While the bot works on an auto reply, chain reply or revive it shows the typing indicator (sent immediately, refreshed every `typing.refreshMs`, 8 s, and stopped when the reply is out or fails; `typing.enabled: false` turns it off). The `reply` command does not type: its interaction shows its own placeholder.

A persona who often sends several short messages in a row may answer with a burst. `burst.minSamples` (20) of the persona's raw messages must exist and at least `burst.minRate` (0.2) of them must have been followed by another message from the same author within `burst.windowMs` (30 s); the rate is measured on the raw `messages` table and cached per author for `burst.cacheMs` (1 h). Such personas get a prompt section (just before avoid-repeats) saying the response may be split into up to `burst.maxMessages` (3) messages with `<split>` on its own line. A `<split>` from any persona is honoured; parts beyond the maximum are joined onto the last one, each part is cleaned on its own, and empty parts are dropped. The first part is sent as usual (a Discord reply, or the interaction reply for the command); later parts are plain channel messages (follow-ups for the command), each with its own author embed and GIFs, after a pause of `burst.msPerChar` (40 ms) per character clamped to `burst.minDelayMs` (800) and `burst.maxDelayMs` (4000), with a typing pulse before each. Only the first part can ping the replied user. Every part is recorded in `bot_messages`. The reply rate limit is armed as soon as the first part is delivered, so a message arriving mid-burst cannot trigger another reply; if a later part fails to send it is logged and the rest of the burst is skipped. When someone replies to any part of a burst, the parts count as one assistant turn (and one bot turn) in the chain.

## Storage

SQLite (`messages.db`):

- `messages`: every human message in the channel, raw (`id`, `author` username, `content`, `timestamp` ms, `reference`).
- `bot_messages`: every message the bot sent and Discord accepted (`id` Discord message id, `persona` username it imitated, `content` generated text in corpus form with GIF tokens kept, `timestamp` ms, `reference` id of the message it answered or null for a revive, `trigger` `auto`, `command`, `revive`, `chain` or `imported`). One row per delivered part of a burst, all sharing persona, trigger and reference. Written right after delivery; a failed send records nothing, and a failed insert is logged without affecting the reply. Bot messages sent before this table existed are attributed through their embed author instead.
- `user_profiles`: append-only observations of members' Discord profiles (`username`, `user_id`, `display_name`, `avatar_url`, `observed_at` ms; primary key `(username, observed_at)`). The newest row per user is their stored profile; every distinct display name ever seen stays available.
- `filtered_messages`: messages that passed `filter()`, with transformed content and `has_gif`. `reference` is the Discord reply target if that target is also in this table; otherwise the previous filtered message when it is from a different author and less than 1 h older; otherwise null. A human reply to a bot message is stored with a null `reference` (no inference) and gets no reply embedding. An index on `(author, content)` (`idx_filtered_messages_author_content`) serves the frequency counts below. The raw table has an index on `(timestamp, id)` (`idx_messages_timestamp_id`) that serves the newest-message lookups used at restart.

- `message_revisions`: append-only edit history (`message_id` logical id, `content`, `edited_at` ms; primary key `(message_id, edited_at)`).
- `meta`: installation facts, written once and never overwritten (`key`, `value`). `chroma_generation` names the generation of Chroma collections this database belongs to (absent in an installation that was never re-imported, which uses `message_embeddings` and `message_reply_embeddings`; otherwise `<name>_<generation>`). `reimport_started_at` and `reimport_completed_at` (ms) mark a [re-import](#re-importing-from-discord).

### Edits and deletes (soft)

Nothing is ever removed or overwritten. `messages`, `filtered_messages` and `bot_messages` have a nullable `deleted_at` (ms) marker; `filtered_messages` also has `source_id`. Every message has one logical id, its Discord message id; a corpus row's logical id is `COALESCE(source_id, id)`, and `reference` columns hold logical ids. A deleted message gets `deleted_at` on its raw row and on every corpus row of that logical id (and on its `bot_messages` row if the bot sent it). An edit appends a `message_revisions` row, marks the visible corpus row as superseded and, when the new text passes the filter, adds a corpus row `<id>:<editedAt>` with `source_id = <id>` and the original timestamp; the raw `messages` row keeps the original text. A logical message has at most one visible corpus row, and every read (retrieval, random and starter samples, frequency counts, burst statistics, reply parents, recent bot output, the inspect script) ignores rows that are not visible. Chroma is never modified for a delete: hits whose SQLite row is hidden are dropped after each vector query, and an edit's new row is simply added. A reply row in Chroma stays under the embedding its parent had when the reply was stored, even if the parent is later edited. In a reply chain, a deleted human turn is skipped, and a deleted bot message ends the walk (no chain at all when it is the direct parent). The bot listens to message delete, bulk delete and update events in the configured channel (partial messages are enabled, so uncached edits cost one REST fetch); these are not channel activity and never trigger a reply. Edits that change nothing in the text (link previews, pins) are ignored. The first corpus row of a logical message always takes the logical id (a message the filter first dropped, such as a bare link, and that is kept after an edit gets its corpus row with `id = <id>` and no `source_id`), so replies to it keep their reference. An edit never infers a reference: its new row keeps the reference of the message's newest corpus row, or, when the message never had one, its explicit reference if that resolves to a visible message. Corpus rows created by edits before this change (`<id>:<editedAt>` with no row under the plain id) are left as they are, so replies to those messages keep a `NULL` reference.

Limitations: edits and deletes that happen while the bot is offline are not seen (the full re-import reconciles them, spec 26). "Deleted" means the bot no longer uses the text, not that it is erased: it remains in the SQLite file and in Chroma, hidden and never used.

Chroma:

- `message_embeddings`: one entry per filtered message, embedded on its own content. Metadata: `author`, `timestamp`, `has_gif`.
- `message_reply_embeddings`: one entry per filtered message whose resolved reference (explicit Discord reply, else the inferred previous message) has an embedding in `message_embeddings`, stored under the embedding of the message it replies to. Querying it with a new message returns what people said in response to similar messages.

## Member profiles

A user's display name and avatar are read from Discord every time a message is about to be sent in that user's name, and every directory user is re-checked hourly (`profiles.refreshIntervalMs`, also once at startup without delaying it), so what the bot shows stays current. Lookups use REST only (by id with `force`, else a username search that accepts only an exact username match, so `bobby` or a nickname `bob` is never taken for `bob`); no privileged intent is needed. Sends and burst parts within `profiles.minCheckIntervalMs` (10 s) of a successful check share its result, and concurrent sends share one lookup.

**Guarantee:** the profile used at send time was read from Discord within the last 10 s. It can be older only when Discord could not be reached (error, `profiles.lookupTimeoutMs` of 5 s, or the member left): then the last stored profile is used, one warning is logged per user per refresh interval, and the message is still sent. With nothing stored the username and no avatar are used.

Each change of id, display name or avatar is appended to the `user_profiles` table (see Storage); nothing is overwritten. Messages already sent keep the name and avatar they were sent with.

## Persona display

`PERSONA_DISPLAY=embed` (default) posts as the bot with an author embed naming the persona (the persona's current avatar as its icon). `PERSONA_DISPLAY=webhook` posts through a channel webhook named `discord.webhookName` that the bot creates or reuses (it needs the Manage Webhooks permission; a channel holds at most 15 webhooks), with the member's current display name and avatar and only the GIF embeds. Webhook messages cannot be native replies, so an auto or chain reply starts with a small line `-# ↪ <jump link>` to the message being answered (`discord.webhookReplyLink`); the stored text has no such line. Display names are cut to 80 code points; Discord rejects names containing `clyde` or `discord`, so such a name is replaced by the username, and if that fails too the message goes out in embed form. If the webhook cannot be obtained or the send fails, the message is delivered in embed form (a failed webhook lookup is retried on the next send; a webhook deleted behind the bot's back is looked up again). Messages are never duplicated except when a send times out after Discord accepted it. For the `reply` command the acknowledgement is ephemeral, the placeholder reads `Replying as <persona>…` and is edited to `Sent as <persona>.`; the persona message itself goes to the channel. Old messages keep the name and avatar they were sent with.

## Retrieval and prompting

For a reply (`retrieveForReply`), four buckets are fetched, all restricted to the persona's messages older than the target message:

Each fetch asks for `limit x retrieval.overFetchFactor` (3) candidates so that deduplication does not leave a bucket short; each bucket's limit is applied during deduplication, so candidates cut by a full bucket do not suppress duplicates in later buckets. The persona selector over-fetches the same way before it drops hidden hits.

1. 10 nearest from `message_reply_embeddings` (their replies to similar messages), each paired with the message it answered: `messageStore.getParents` looks up the stored content of the reply's `reference`, giving `{ you, them }` (`them` is `null` when the row has no stored parent, including rows that exist only in Chroma)
2. 20 nearest from `message_embeddings` (their own similar messages)
3. 10 nearest from `message_embeddings` with `has_gif`
4. 10 random rows from `filtered_messages`

Candidates are deduplicated greedily in bucket order (replies, similar, gifs, other), so an earlier bucket keeps a text and suppresses its variants in later buckets (only texts it actually kept). Two texts are merged when their normalised keys are equal (NFKC, lowercase, whitespace collapsed, runs of three or more identical letters collapsed, leading and trailing punctuation stripped; GIF tokens are compared whole; digits are never collapsed), or when both keys are at least `retrieval.nearDuplicateMinChars` (12) characters and the cosine similarity of their embeddings is at least `retrieval.nearDuplicateThreshold` (0.95, a conservative tunable). Embeddings always come from `message_embeddings` (`vectorStore.getEmbeddings`), never from the reply collection, where rows carry their parent's embedding; if they cannot be loaded a warning is logged and only keys are compared. The reply bucket is rendered as JSON objects with `them` first (`{"them": ..., "you": ...}`, or `{"you": ...}` without a parent), and `them` is cut to `context.maxEntryChars` code points with `…` (never inside an emoji).

`buildReplyPrompt` assembles the user message from ordered sections: the persona's username and real name, the recent channel transcript (omitted when empty), the target message naming its sender (`The user has just received this message from "<sender>": "<message>"`), the four buckets, a frequent-phrases section and an avoid-repeats section. Sections are joined by a blank line.

### Frequent phrases and recent bot output

For every kept example the retriever sums `messageStore.countContents` (exact-content counts among the persona's earlier messages) over the spellings merged into it. Items sent at least `retrieval.frequentMinCount` (3) times, most frequent first and at most `retrieval.frequentLimit` (10), form the `frequent` list shown to the model as `{ text, times }`. Only spellings among the retrieved candidates are counted, so the number is a lower bound; the section is omitted when nothing qualifies.

For replies and revives the generator also loads the last `retrieval.recentBotMessages` (10) rows of `bot_messages` (the bot serves a single channel, so no channel filter) and ends the prompt with them, newest first, asking the model not to repeat them. A failed load is logged and the section is left out; it is also left out when the bot has said nothing yet.

### Conversation context

Before composing a reply, the bot fetches up to `context.transcriptLimit` (20) messages that precede the target message in the channel (for the `reply` command, those before the selected message, not before now) and renders them as `[HH:MM] speaker: text` lines, oldest first, with `(replying to <speaker>)` when a line answers another line in the window. Times use `context.timeZone` (`America/Chicago`). Bot messages appear under the persona they imitated, with their stored text (GIF tokens included); bot messages with no stored row or persona embed, and other bots, are left out. Text is cleaned like corpus content (mentions, URLs), newlines become spaces, mention-only and empty lines are dropped, lines longer than `context.maxEntryChars` (300) are cut with `…`, and messages more than `context.maxAgeMs` (6 h) older than the target are dropped.

**Privacy:** up to `context.transcriptLimit` recent channel messages, including those of people who are not listed in `users.json`, are now sent to the LLM provider as context (previously only the target message was). A failed history fetch is logged as a warning and the reply is sent without a transcript.

Retrieval for a short target (fewer than `retrieval.shortMessageChars`, 25, characters after cleaning) embeds the last `retrieval.queryContextMessages` (2) transcript lines followed by the target, so a message like "why" still matches something; longer targets are embedded alone. Persona selection still queries with the target only.

For a revive the prompt, under a revive variant of the system prompt (`REVIVE_SYSTEM_PROMPT`, derived from `SYSTEM_PROMPT` by two replacements: "the channel has gone quiet, write the next message to get conversation going" instead of "respond to this message", and GIF search terms based on what is being said), has these sections in order: identity; a situation line (`It is Thursday 3:10 PM.` in `context.timeZone`, plus `The channel has been quiet for about 3 hours.` when known); the end of the last conversation (the last `revive.transcriptLimit` (10) channel messages, with no age cut-off); up to `revive.starterSamples` (20) conversation starters; up to `retrieval.reviveSamples` (30) random example messages (over-fetched 3x and deduplicated by normalised key, minus anything already shown as a starter); and the avoid-repeats section. A starter is a message by the persona that came more than `revive.starterGapMs` (1 h) after the previous message in the channel from anyone, including messages the corpus filter dropped and the bot's own messages (so the first human reply to a revive is not a starter), or the first message ever. Sections with nothing to say are omitted. A failed history fetch or starter query is logged as a warning and the revive is sent without that section.

### Chain replies

When a message replies to a bot message, the bot walks up the reply references (at most `chain.maxWalkSteps` steps, through `bot_messages` and the raw `messages` table; a bot message from before `bot_messages` existed is fetched once through Discord and attributed by its embed) and sends the thread to the model as chat turns: the persona's own messages as `assistant` turns, everyone else's as `user` turns prefixed with their username, consecutive same-role turns merged. The last `chain.maxContextTurns` (12) turns are kept, but the bot-message cap counts the whole walk. No channel history is fetched for these replies. The system prompt is unchanged; the user preamble holds identity, reply examples, similar, GIF and other examples, frequent phrases, avoid-repeats and a thread note.

## Filtering

`messageFilter.filter(record)` returns a new record with transformed content, or `null`; the input is not modified. `filterAnyAuthor` is the same without the `approvedAuthors` predicate (excluded by name), and `filterForChain` additionally skips `minLength`, so short replies such as `why` can continue a chain.

Transformers, in order: resolve mentions through the ping cache (mention-only messages become empty), turn Tenor links into `<gif! search terms>`, strip URLs (markdown links keep their text), reduce custom emoji to `:name:`, drop Discord timestamps, soundboard tags and invite links, trim.

Predicates: approved author, non-empty, 5–200 characters, no bot-command prefix (`! $ # % & - + p!`), no Connections/Wordle/Strands shares.

## GIFs

`<gif! terms>` is the corpus representation of a GIF. When the LLM emits one, the GIF resolver searches Klipy, then Giphy, then Humor API with the first 50 code points of the terms. Each engine returns up to 5 results (`gifs.candidates`) and the first engine with any result wins; one of its results is picked at random, so the same terms do not always give the same GIF. Each lookup has a 5 s timeout (`gifs.timeoutMs`); an engine that throws, times out or answers with an HTTP error is logged as a warning and the next engine is tried. If every engine fails the token stays as a placeholder and the reply is still sent. Resolved GIFs are removed from the text and attached as image embeds; unresolved ones are left as `<INSERT GIF: terms>`.

## LLM calls and output cleaning

The chat client is built with `llm.timeoutMs` (120 s) and `llm.maxRetries` (1), so the SDK aborts a slow attempt and retries connection errors, timeouts, 408, 409, 429 and 5xx. A completion with no content is retried up to `llm.emptyRetries` (1) more times, then fails with `LLM returned an empty response`; a completion that is empty only after cleaning (for example just quotes or `<split>`) is requested again up to `llm.postProcessRetries` (1) times; the handler logs a final failure and nothing is sent. Every completion is cleaned before use: a whole answer wrapped in one pair of quotes is unwrapped once (a JSON string is decoded; `"yes" or "no"` is two quoted units and stays as written), the text is split on `<split>` without merging, and each part loses stray `\n`, `\t` and `\"` escapes (the cleaning repeats until nothing changes), a leftover quote that has no partner in its part, and every link: markdown links keep their text, bare URLs (any scheme, `www.` hosts) and Discord invites (`discord.gg`, `discord.com/invite`, `discordapp.com/invite`, `dsc.gg`) are removed, so a generated message can never post a link under a member's name. A part that is only a link is dropped. Only then are parts beyond `burst.maxMessages` merged onto the last one, and at most `gifs.maxPerMessage` (2) GIF tokens are kept in each delivered message (the rest are removed without a placeholder). A payload never carries more than `discord.maxEmbeds` (10) embeds, the author embed included. Delivered text is cut to `discord.maxMessageLength` (2000) characters, at whitespace within the last `discord.truncateLookbackChars` (200) characters when possible; the untruncated cleaned text is what is logged.

## Delivery and mentions

Every outbound message is awaited, so reply state (rate limit, miss counter, activity) only keeps a change after a send succeeded (the activity is claimed before generating and handed back when the attempt delivers nothing). The bot never pings anyone: every payload, including the thinking placeholder, the failure notice and the ephemeral refusals, carries `allowedMentions: { parse: [] }`, and the Discord client is constructed with the same default, so `@everyone`, `@here` or `<@id>` in model output stays plain text. Replies keep the reply ping unless `PING_REPLIED_USER=false`.

If an auto reply cannot be sent, the failure is logged and the rate limit is armed, so a persistent send failure costs at most one LLM call per window. Embed-mode replies are sent with `failIfNotExists: false`, so a target deleted while the reply was being generated no longer loses it: Discord posts it as a plain channel message. If a `reply` command fails after its acknowledgement, the placeholder (or the deferred "thinking" state) is edited to `Could not generate a reply.`

## Operations

**Signals and shutdown.** `SIGINT` and `SIGTERM` start a graceful shutdown: the revive and profile timers stop, new events are ignored, and the bot waits up to `lifecycle.graceMs` (10 s) for handlers already running (a reply being generated is finished, sent and recorded). Then the Discord client is destroyed, the database is closed and the process exits 0. If handlers are still running when the grace period ends, a warning names how many were abandoned. A second signal during shutdown exits immediately with code 1. An unhandled rejection or uncaught exception is logged and shuts down at once (no grace period) with code 1.

**Exit codes.** 0 after a signal; 1 after a fatal gateway close, a crash, or a failed start (an unfinished re-import, Chroma not reachable, invalid configuration).

**Logging.** All output goes through one logger per process (created in `main.js` and in each script). Errors are logged as text (stack, then `[code=... status=...]`, then up to three `caused by:` levels), never as objects, so request URLs and headers carried by library errors are not printed. Every logged string has the Discord token, the LLM key, the embedding key and the three GIF keys (and their URL-encoded forms; values shorter than 8 characters are ignored) replaced by `[redacted]`, and webhook URLs have their token replaced the same way. Handler error logs say which work failed, for example `Error processing message 123 (auto reply as bob, stage delivery):`; a failure while building the transcript is a warning and the reply is sent without it.

**Gateway failures.** Client errors and warnings and shard errors are logged; reconnects and resumes are logged at info level. discord.js reports a disconnect only when the gateway closed for good (for example close code 4004, a bad `DISCORD_BOT_TOKEN`, or 4014, the Message Content intent not enabled in the developer portal). The bot logs the code with a hint and exits 1 instead of idling as a silent zombie, so run it under a supervisor (systemd `Restart=on-failure`, pm2, a container restart policy) that restarts it. A supervisor will also restart a bot that exits because Chroma is down, so start Chroma first or accept the retries.

**Starting.** Startup refuses a database whose [re-import](#re-importing-from-discord) is unfinished (`npm run reimport -- --resume --yes`) and prints a one-line message with the port and the start command when Chroma cannot be reached (the connection attempt has its own timeout, `chroma.connectTimeoutMs`).

**When Chroma or the embedding API is down.** Every Chroma and embedding call has a timeout (see the vector-store tunables), and a lookup that hung is not cached, so the next call retries. A live message, edit or delete is always written to SQLite first. If its vector write then fails or times out, the handler does not abort: one warning per `vector.repairIntervalMs` says that vectors are missing and will be repaired automatically, and the bot carries on (a reply attempt that needs Chroma fails on its own, is logged and sends nothing). Every `vector.repairIntervalMs` (10 minutes) the bot re-checks the rows of the last `vector.repairWindowMs` (7 days) against Chroma and adds what is missing, reply rows included, but only after a failure was noted; a tick with nothing to repair makes no Chroma call. At ready, after catch-up, the same check runs once regardless, to pick up vectors that were missing when the process last stopped (it is not awaited and does not delay ready). A failed repair or a failed catch-up keeps the debt and is retried at the next tick. Rows older than the window, and batch writes of `backfill` and `reimport` (which still fail loudly), are repaired by hand: `npm run backfill -- --skip-history --sync-vectors`. A SQLite error during a sync is reported as such, not as a vector-store failure.

**Changing embedding settings.** `embedding.modelName` and `embedding.dimensions` must not change for an existing collection. Startup compares `embedding.dimensions` with the length of one stored embedding and refuses to start on a mismatch, without making an embedding request. A changed model with the same dimension cannot be detected: the new vectors would silently be incomparable with the old ones. Use a [re-import](#re-importing-from-discord), which starts a new collection generation.

**What a restart restores.** From the database: the reply rate limit (from the newest auto, chain or command reply, so a restart does not allow an extra reply) and who spoke last and when (from the newest human message, or a newer auto reply or revive), so a channel that was already quiet is revived at the first check. The miss counter starts again at 0. With an empty database the bot counts as the last speaker, as on a first run.

**Catch-up.** At ready the bot fetches the messages posted after the newest stored one (up to `catchUp.maxMessages`, 2000), imports them like a backfill (corpus, embeddings, own bot messages) and generates no replies for them. If more than the cap were missed, the oldest are imported, a warning says to run `npm run backfill`, and activity restarts as on a fresh start. A failed fetch is a warning. `CATCH_UP=false` turns it off. A bot message that was delivered but not recorded before a crash is imported as `imported` and so does not restore the rate limit.

## Known issues

These behaviours are pinned by the characterization tests in `test/characterization/` and are fixed by later specs.


None are open at the moment.
