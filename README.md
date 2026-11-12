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
| `src/main.js` | Entry point (`npm start`): loads `.env`, config and data files, builds the container, connects Chroma, starts the bot. |
| `src/container.js` | Wires every service together. `src/vendor.js` collects the real third-party constructors. |
| `src/config.js` | Every tunable, ID, model name and limit, with environment overrides. |
| `src/bot/` | Triggers and orchestration: `handlers/` (message, message edit, message delete, `reply` command, revive tick), reply, chain and revive policies, the bot-parent finder, activity tracker, composer (generate, resolve GIFs, truncate, per burst part), responder (typing, compose, deliver the parts), `bot.js`. |
| `src/corpus/` | Content transformers and keep/drop predicates applied before a message enters the corpus. |
| `src/storage/` | SQLite schema, migrations and queries (including soft deletes and edit revisions); the Chroma vector store; a migrated read-only snapshot for `inspectDb.js`. |
| `src/ingest/`, `src/retrieval/`, `src/llm/`, `src/gifs/`, `src/context/` | Recording a message, retrieval and persona choice, prompts (assembled from sections) and the chat client, GIF resolution, the conversation transcript for replies and the reply-thread chain builder. |
| `src/discord/` | Discord client construction, payloads and safe mentions, embeds, delivery (the one place replies, channel posts and interaction edits are sent), the reply modal and the command definition. |
| `src/userData/`, `src/logger.js` | Reading `data/*.json`; logging and timestamp formatting. |
| `src/backfill/` | History import and vector sync: argument parsing, the paged history reader, message classification, the importers for human and own-bot messages, the Chroma reconciliation, and the full re-import (database switch, archive reader, plan, comparison, report). Imported only by `scripts/backfill.js`, `scripts/reimport.js` and the container. |
| `scripts/` | `registerCommands.js`, `inspectDb.js`, `gifSmoke.js`, `backfill.js` and `reimport.js` (see the npm scripts below). |

## Setup

Requirements: Node 22.18+ (uses `node:sqlite` and `process.loadEnvFile`), a Chroma server, and a Discord application with the **Message Content** privileged intent.

All paths (`.env`, `data/`, `messages.db`) are relative to the working directory, so run everything from the repo root.

1. Install dependencies.

   ```bash
   npm install
   ```

2. Create `.env`. The file must exist; the entry points call `loadEnvFile('.env')`.

   | Variable | Used for |
   | --- | --- |
   | `DISCORD_BOT_TOKEN` | Bot login and command registration |
   | `DISCORD_CLIENT_ID` | Command registration (`npm run register`) |
   | `OPENAI_API_KEY` | Embeddings (`text-embedding-3-small`, 512 dims, via Chroma's embedding function) |
   | `DEEPSEEK_API_KEY` | Chat completions (`deepseek-v4-flash`, thinking enabled) |
   | `KLIPY_API_KEY`, `GIPHY_API_KEY`, `HUMOR_API_KEY` | GIF search, tried in that order |

3. Create the data files (git-ignored; `*.old` backups and `*.db.new` files from a re-import are git-ignored too).

   `data/users.json` lists the members the bot may imitate. Only their messages enter the corpus.

   ```json
   [{ "username": "discord_username", "name": "Real Name", "id": "optional Discord user id" }]
   ```

   The optional `id` makes member lookups exact from the first use (see [Member profiles](#member-profiles)); without it the id is learned from the first successful search.

   `data/ping_caches.json` maps Discord IDs to display text, used to rewrite mentions.

   ```json
   { "users": { "<id>": "name" }, "roles": { "<id>": "name" }, "channels": { "<id>": "name" } }
   ```

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

Other npm scripts: `npm run backfill` (see [Backfill](#backfill)), `npm run reimport` (see [Re-importing from Discord](#re-importing-from-discord)), `npm test` (unit and scenario tests; no network, real clock or real data), `npm run inspect` (prints the latest rows of `messages.db`, including the latest bot messages, opened read-only, no Chroma needed; a database from before the soft-delete columns is read through a migrated temporary copy and never written) and `npm run gif-smoke` (resolves a sample text through the real GIF APIs).

### Configuration overrides

Everything else is defined in `src/config.js`. These optional environment variables (in `.env` or the shell) override the defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PATEXT_CHANNEL_ID` | `704837777564500149` | The one channel the bot reads and posts in |
| `GUILD_ID` | `478743674826784769` | Guild for command registration and member lookups |
| `CHROMA_PORT` | `7429` | Chroma server port (must be a number) |
| `REPLY_OVERRIDE` | off | `true` replies to every message, ignoring randomness and the rate limit (testing) |
| `REVIVE_OVERRIDE` | off | `true` checks every minute and revives regardless of idle time (testing) |
| `CHAIN_REPLIES` | on | `false` turns off chain replies (replies to a bot message). Such replies then get no answer at all, not even a random one |
| `BURSTS` | on | `false` turns off multi-message bursts: the model is not told it may split, and any `<split>` marker in its output becomes a newline in a single message |
| `PING_REPLIED_USER` | on | `false` stops auto replies from pinging the author of the message they reply to |
| `PERSONA_DISPLAY` | `embed` | `embed` or `webhook`; any other value stops startup with an error naming it. See [Persona display](#persona-display) |

Backfill tunables in `src/config.js`: `backfill.pageSize` (100, 1 to 100), `backfill.batchSize` (100, 1 or more), `backfill.pageRetries` (3, 0 or more), `backfill.retryDelayMs` (2000) and `backfill.pageTimeoutMs` (30000, above 0). Values outside these ranges stop startup.

Other tunables in `src/config.js` for this feature: `discord.webhookName` (`deep-pa-text`), `discord.webhookUsernameMax` (80), `discord.webhookReplyLink` (true), `profiles.refreshIntervalMs` (3600000, integer of 0 or more; `0` disables the refresh), `profiles.minCheckIntervalMs` (10000, 0 or more), `profiles.lookupTimeoutMs` (5000, above 0) and `profiles.searchLimit` (100, 1 to 1000). Values outside these ranges stop startup.

The corpus is filled by live messages and by the [backfill](#backfill) script.

### Backfill

`npm run backfill -- [options]` imports the channel history into the existing database and repairs Chroma. Everything is additive and idempotent, and `--dry-run` writes nothing.

| Option | Meaning |
| --- | --- |
| `--dry-run` | Report what would be written; write nothing to SQLite or Chroma |
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
2. Run `npm run reimport -- --yes`. It checks the state, reads the history (a failure here changes nothing), then backs up `messages.db` as `messages.db.old` (a hard link, else a copy; it refuses to overwrite an existing backup), puts a fresh database in its place and imports through the normal path: the bot's own messages first, then human messages oldest first, then a vector sync. Nothing is ever deleted.
3. Run `npm run backfill` once to pick up anything posted during the re-import, then start the bot.

The new database belongs to a new generation of Chroma collections (`message_embeddings_g<UTC timestamp>` and the matching reply collection), recorded in `meta`. The old collections are not touched. If the run stops midway (a crash, or Chroma rejecting a batch), run `npm run reimport -- --yes --resume`; the steps are idempotent and the vector sync repairs batches whose vectors were not written. A fresh run refuses to start while a `.new` or `.old` file from an earlier run exists, and says which file to move away.

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
| Auto reply | A human message that passes the content filters, at least 5 min after the last bot reply, with probability 0.1. After 10 consecutive random misses the chance rises 0.05 per miss until a reply happens. | Weighted pick from the authors of the 20 nearest entries in `message_reply_embeddings` (people who replied to similar messages, excluding the message's author). Each hit weighs `1 / (1 + distance)` times a recency factor that halves every `persona.recencyHalfLifeMs` (180 days) and never drops below `persona.minRecencyWeight` (0.25); an author's weight is the sum over their hits. With no usable hits it falls back to a random user other than the message's author. | Discord reply to the message |
| Revive | Checked every 10 min. Fires only when the last activity in the channel was a human message (not a naturally spawned bot message, meaning an auto reply or a revive, and not a fresh start; chain replies and `reply` command replies do not count as the bot speaking, so idle time keeps running from the last human message) and it is more than 3 h old during 10:00–22:59 Central, or more than 12 h old otherwise. The bot therefore never revives twice in a row. | Random user | Plain channel message |
| Chain reply | A human replies to a bot message and the bot message's persona is still in `users.json`. The first 3 bot messages in a thread are always answered (the global rate limit and probability do not apply); later ones with chance 0.5, 0.25, 0.125 and 0.0625; a thread never holds more than 8 bot messages. One chain reply is generated at a time. A reply to a bot message never falls through to the random auto reply. Controlled by `CHAIN_REPLIES`, `chain.fullDepth`, `chain.decay`, `chain.maxBotTurns`, `chain.maxContextTurns` (12) and `chain.maxWalkSteps` (50). | Same persona as the bot message replied to | Discord reply to the message |
| `reply` context menu | A user right-clicks a message, then **Apps → reply**, and picks a persona (or `random`, which uses the auto-reply selection) in a modal. Skips the probability and rate limit. | Chosen in the modal | Interaction reply (not a Discord reply to the target). When the target is a bot message it is shown as its persona and that persona is the modal's default choice. |

`REPLY_OVERRIDE` and `REVIVE_OVERRIDE` remove the randomness and timers for testing.

### Typing and bursts

While the bot works on an auto reply, chain reply or revive it shows the typing indicator (sent immediately, refreshed every `typing.refreshMs`, 8 s, and stopped when the reply is out or fails; `typing.enabled: false` turns it off). The `reply` command does not type: its interaction shows its own placeholder.

A persona who often sends several short messages in a row may answer with a burst. `burst.minSamples` (20) of the persona's raw messages must exist and at least `burst.minRate` (0.2) of them must have been followed by another message from the same author within `burst.windowMs` (30 s); the rate is measured on the raw `messages` table and cached per author for `burst.cacheMs` (1 h). Such personas get a prompt section (just before avoid-repeats) saying the response may be split into up to `burst.maxMessages` (3) messages with `<split>` on its own line. A `<split>` from any persona is honoured; parts beyond the maximum are joined onto the last one, each part is cleaned on its own, and empty parts are dropped. The first part is sent as usual (a Discord reply, or the interaction reply for the command); later parts are plain channel messages (follow-ups for the command), each with its own author embed and GIFs, after a pause of `burst.msPerChar` (40 ms) per character clamped to `burst.minDelayMs` (800) and `burst.maxDelayMs` (4000), with a typing pulse before each. Only the first part can ping the replied user. Every part is recorded in `bot_messages`. The reply rate limit is armed as soon as the first part is delivered, so a message arriving mid-burst cannot trigger another reply; if a later part fails to send it is logged and the rest of the burst is skipped. When someone replies to any part of a burst, the parts count as one assistant turn (and one bot turn) in the chain.

## Storage

SQLite (`messages.db`):

- `messages`: every human message in the channel, raw (`id`, `author` username, `content`, `timestamp` ms, `reference`).
- `bot_messages`: every message the bot sent and Discord accepted (`id` Discord message id, `persona` username it imitated, `content` generated text in corpus form with GIF tokens kept, `timestamp` ms, `reference` id of the message it answered or null for a revive, `trigger` `auto`, `command`, `revive`, `chain` or `imported`). One row per delivered part of a burst, all sharing persona, trigger and reference. Written right after delivery; a failed send records nothing, and a failed insert is logged without affecting the reply. Bot messages sent before this table existed are attributed through their embed author instead.
- `user_profiles`: append-only observations of members' Discord profiles (`username`, `user_id`, `display_name`, `avatar_url`, `observed_at` ms; primary key `(username, observed_at)`). The newest row per user is their stored profile; every distinct display name ever seen stays available.
- `filtered_messages`: messages that passed `filter()`, with transformed content and `has_gif`. `reference` is the Discord reply target if that target is also in this table; otherwise the previous filtered message when it is from a different author and less than 1 h older; otherwise null. A human reply to a bot message is stored with a null `reference` (no inference) and gets no reply embedding. An index on `(author, content)` (`idx_filtered_messages_author_content`) serves the frequency counts below.

- `message_revisions`: append-only edit history (`message_id` logical id, `content`, `edited_at` ms; primary key `(message_id, edited_at)`).
- `meta`: installation facts, written once and never overwritten (`key`, `value`). `chroma_generation` names the generation of Chroma collections this database belongs to (absent in an installation that was never re-imported, which uses `message_embeddings` and `message_reply_embeddings`; otherwise `<name>_<generation>`). `reimport_started_at` and `reimport_completed_at` (ms) mark a [re-import](#re-importing-from-discord).

### Edits and deletes (soft)

Nothing is ever removed or overwritten. `messages`, `filtered_messages` and `bot_messages` have a nullable `deleted_at` (ms) marker; `filtered_messages` also has `source_id`. Every message has one logical id, its Discord message id; a corpus row's logical id is `COALESCE(source_id, id)`, and `reference` columns hold logical ids. A deleted message gets `deleted_at` on its raw row and on every corpus row of that logical id (and on its `bot_messages` row if the bot sent it). An edit appends a `message_revisions` row, marks the visible corpus row as superseded and, when the new text passes the filter, adds a corpus row `<id>:<editedAt>` with `source_id = <id>` and the original timestamp; the raw `messages` row keeps the original text. A logical message has at most one visible corpus row, and every read (retrieval, random and starter samples, frequency counts, burst statistics, reply parents, recent bot output, the inspect script) ignores rows that are not visible. Chroma is never modified for a delete: hits whose SQLite row is hidden are dropped after each vector query, and an edit's new row is simply added. A reply row in Chroma stays under the embedding its parent had when the reply was stored, even if the parent is later edited. In a reply chain, a deleted human turn is skipped, and a deleted bot message ends the walk (no chain at all when it is the direct parent). The bot listens to message delete, bulk delete and update events in the configured channel (partial messages are enabled, so uncached edits cost one REST fetch); these are not channel activity and never trigger a reply. Edits that change nothing in the text (link previews, pins) are ignored.

Limitations: edits and deletes that happen while the bot is offline are not seen (the full re-import reconciles them, spec 26). "Deleted" means the bot no longer uses the text, not that it is erased: it remains in the SQLite file and in Chroma, hidden and never used.

Chroma:

- `message_embeddings`: one entry per filtered message, embedded on its own content. Metadata: `author`, `timestamp`, `has_gif`.
- `message_reply_embeddings`: one entry per filtered message whose resolved reference (explicit Discord reply, else the inferred previous message) has an embedding in `message_embeddings`, stored under the embedding of the message it replies to. Querying it with a new message returns what people said in response to similar messages.

## Member profiles

A user's display name and avatar are read from Discord every time a message is about to be sent in that user's name, and every directory user is re-checked hourly (`profiles.refreshIntervalMs`, also once at startup without delaying it), so what the bot shows stays current. Lookups use REST only (by id with `force`, else a username search that accepts only an exact username match, so `bobby` or a nickname `bob` is never taken for `bob`); no privileged intent is needed. Sends and burst parts within `profiles.minCheckIntervalMs` (10 s) of a successful check share its result, and concurrent sends share one lookup.

**Guarantee:** the profile used at send time was read from Discord within the last 10 s. It can be older only when Discord could not be reached (error, `profiles.lookupTimeoutMs` of 5 s, or the member left): then the last stored profile is used, one warning is logged per user per refresh interval, and the message is still sent. With nothing stored the username and no avatar are used.

Each change of id, display name or avatar is appended to the `user_profiles` table (see Storage); nothing is overwritten. Messages already sent keep the name and avatar they were sent with.

## Persona display

`PERSONA_DISPLAY=embed` (default) posts as the bot with an author embed naming the persona (the persona's current avatar as its icon). `PERSONA_DISPLAY=webhook` posts through a channel webhook named `discord.webhookName` that the bot creates or reuses (it needs the Manage Webhooks permission; a channel holds at most 15 webhooks), with the member's current display name and avatar and only the GIF embeds. Webhook messages cannot be native replies, so an auto or chain reply starts with a small line `-# ↪ <jump link>` to the message being answered (`discord.webhookReplyLink`); the stored text has no such line. Display names are cut to 80 code points; Discord rejects names containing `clyde` or `discord`, so such a name is replaced by the username, and if that fails too the message goes out in embed form. If the webhook cannot be obtained or the send fails, the message is delivered in embed form (a failed webhook lookup is retried on the next send; a webhook deleted behind the bot's back is looked up again). Messages are never duplicated except when a send times out after Discord accepted it. For the `reply` command the ephemeral placeholder reads `Replying as <persona>…` and is edited to `Sent as <persona>.`; the persona message itself goes to the channel. Old messages keep the name and avatar they were sent with.

## Retrieval and prompting

For a reply (`retrieveForReply`), four buckets are fetched, all restricted to the persona's messages older than the target message:

Each fetch asks for `limit x retrieval.overFetchFactor` (3) candidates so that deduplication does not leave a bucket short; the buckets are cut back to these limits after deduplication.

1. 10 nearest from `message_reply_embeddings` (their replies to similar messages), each paired with the message it answered: `messageStore.getParents` looks up the stored content of the reply's `reference`, giving `{ you, them }` (`them` is `null` when the row has no stored parent, including rows that exist only in Chroma)
2. 20 nearest from `message_embeddings` (their own similar messages)
3. 10 nearest from `message_embeddings` with `has_gif`
4. 10 random rows from `filtered_messages`

Candidates are deduplicated greedily in bucket order (replies, similar, gifs, other), so an earlier bucket keeps a text and suppresses its variants in later buckets. Two texts are merged when their normalised keys are equal (NFKC, lowercase, whitespace collapsed, runs of three or more identical letters collapsed, leading and trailing punctuation stripped; GIF tokens are compared whole; digits are never collapsed), or when both keys are at least `retrieval.nearDuplicateMinChars` (12) characters and the cosine similarity of their embeddings is at least `retrieval.nearDuplicateThreshold` (0.95, a conservative tunable). Embeddings always come from `message_embeddings` (`vectorStore.getEmbeddings`), never from the reply collection, where rows carry their parent's embedding; if they cannot be loaded a warning is logged and only keys are compared. The reply bucket is rendered as JSON objects with `them` first (`{"them": ..., "you": ...}`, or `{"you": ...}` without a parent), and `them` is cut to `context.maxEntryChars` characters with `…`.

`buildReplyPrompt` assembles the user message from ordered sections: the persona's username and real name, the recent channel transcript (omitted when empty), the target message naming its sender (`The user has just received this message from "<sender>": "<message>"`), the four buckets, a frequent-phrases section and an avoid-repeats section. Sections are joined by a blank line.

### Frequent phrases and recent bot output

For every kept example the retriever sums `messageStore.countContents` (exact-content counts among the persona's earlier messages) over the spellings merged into it. Items sent at least `retrieval.frequentMinCount` (3) times, most frequent first and at most `retrieval.frequentLimit` (10), form the `frequent` list shown to the model as `{ text, times }`. Only spellings among the retrieved candidates are counted, so the number is a lower bound; the section is omitted when nothing qualifies.

For replies and revives the generator also loads the last `retrieval.recentBotMessages` (10) rows of `bot_messages` (the bot serves a single channel, so no channel filter) and ends the prompt with them, newest first, asking the model not to repeat them. A failed load is logged and the section is left out; it is also left out when the bot has said nothing yet.

### Conversation context

Before composing a reply, the bot fetches up to `context.transcriptLimit` (20) messages that precede the target message in the channel (for the `reply` command, those before the selected message, not before now) and renders them as `[HH:MM] speaker: text` lines, oldest first, with `(replying to <speaker>)` when a line answers another line in the window. Times use `context.timeZone` (`America/Chicago`). Bot messages appear under the persona they imitated, with their stored text (GIF tokens included); bot messages with no stored row or persona embed, and other bots, are left out. Text is cleaned like corpus content (mentions, URLs), newlines become spaces, mention-only and empty lines are dropped, lines longer than `context.maxEntryChars` (300) are cut with `…`, and messages more than `context.maxAgeMs` (6 h) older than the target are dropped.

**Privacy:** up to `context.transcriptLimit` recent channel messages, including those of people who are not listed in `users.json`, are now sent to the LLM provider as context (previously only the target message was). A failed history fetch is logged as a warning and the reply is sent without a transcript.

Retrieval for a short target (fewer than `retrieval.shortMessageChars`, 25, characters after cleaning) embeds the last `retrieval.queryContextMessages` (2) transcript lines followed by the target, so a message like "why" still matches something; longer targets are embedded alone. Persona selection still queries with the target only.

For a revive the prompt, under a revive variant of the system prompt (`REVIVE_SYSTEM_PROMPT`, derived from `SYSTEM_PROMPT` by two replacements: "the channel has gone quiet, write the next message to get conversation going" instead of "respond to this message", and GIF search terms based on what is being said), has these sections in order: identity; a situation line (`It is Thursday 3:10 PM.` in `context.timeZone`, plus `The channel has been quiet for about 3 hours.` when known); the end of the last conversation (the last `revive.transcriptLimit` (10) channel messages, with no age cut-off); up to `revive.starterSamples` (20) conversation starters; up to `retrieval.reviveSamples` (30) random example messages (over-fetched 3x and deduplicated by normalised key, minus anything already shown as a starter); and the avoid-repeats section. A starter is a message by the persona that came more than `revive.starterGapMs` (1 h) after the previous message in the channel from anyone, including messages the corpus filter dropped, or the first message ever. Sections with nothing to say are omitted. A failed history fetch or starter query is logged as a warning and the revive is sent without that section.

### Chain replies

When a message replies to a bot message, the bot walks up the reply references (at most `chain.maxWalkSteps` steps, through `bot_messages` and the raw `messages` table; a bot message from before `bot_messages` existed is fetched once through Discord and attributed by its embed) and sends the thread to the model as chat turns: the persona's own messages as `assistant` turns, everyone else's as `user` turns prefixed with their username, consecutive same-role turns merged. The last `chain.maxContextTurns` (12) turns are kept, but the bot-message cap counts the whole walk. No channel history is fetched for these replies. The system prompt is unchanged; the user preamble holds identity, reply examples, similar, GIF and other examples, frequent phrases, avoid-repeats and a thread note.

## Filtering

`messageFilter.filter(record)` returns a new record with transformed content, or `null`; the input is not modified. `filterAnyAuthor` is the same without the `approvedAuthors` predicate (excluded by name), and `filterForChain` additionally skips `minLength`, so short replies such as `why` can continue a chain.

Transformers, in order: resolve mentions through the ping cache (mention-only messages become empty), turn Tenor links into `<gif! search terms>`, strip URLs (markdown links keep their text), reduce custom emoji to `:name:`, drop Discord timestamps, soundboard tags and invite links, trim.

Predicates: approved author, non-empty, 5–200 characters, no bot-command prefix (`! $ # % & - + p!`), no Connections/Wordle/Strands shares.

## GIFs

`<gif! terms>` is the corpus representation of a GIF. When the LLM emits one, the GIF resolver searches Klipy, then Giphy, then Humor API with the first 50 characters of the terms. Each engine returns up to 5 results (`gifs.candidates`) and the first engine with any result wins; one of its results is picked at random, so the same terms do not always give the same GIF. Each lookup has a 5 s timeout (`gifs.timeoutMs`); an engine that throws, times out or answers with an HTTP error is logged as a warning and the next engine is tried. If every engine fails the token stays as a placeholder and the reply is still sent. Resolved GIFs are removed from the text and attached as image embeds; unresolved ones are left as `<INSERT GIF: terms>`.

## LLM calls and output cleaning

The chat client is built with `llm.timeoutMs` (120 s) and `llm.maxRetries` (1), so the SDK aborts a slow attempt and retries connection errors, timeouts, 408, 409, 429 and 5xx. A completion with no content is retried up to `llm.emptyRetries` (1) more times, then fails with `LLM returned an empty response`; the handler logs it and nothing is sent. Every completion is cleaned before use: surrounding quotes are removed (a JSON string is decoded) and stray `\n`, `\t` and `\"` escapes become the real characters. Delivered text is cut to `discord.maxMessageLength` (2000) characters, at whitespace within the last `discord.truncateLookbackChars` (200) characters when possible; the untruncated cleaned text is what is logged.

## Delivery and mentions

Every outbound message is awaited, so reply state (rate limit, miss counter, activity) only changes after a send succeeded. The bot never pings anyone: every payload, including the thinking placeholder, the failure notice and the ephemeral refusals, carries `allowedMentions: { parse: [] }`, and the Discord client is constructed with the same default, so `@everyone`, `@here` or `<@id>` in model output stays plain text. Replies keep the reply ping unless `PING_REPLIED_USER=false`.

If an auto reply cannot be sent (for example the message was deleted), the failure is logged and the rate limit is armed, so a persistent send failure costs at most one LLM call per window. If a `reply` command fails after its "thinking..." placeholder, the placeholder is edited to `Could not generate a reply.`

## Known issues

These behaviours are pinned by the characterization tests in `test/characterization/` and are fixed by later specs.


None are open at the moment.
