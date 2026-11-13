# deep-pa-text

A Discord bot that imitates the members of one group chat. It records every human message in a single channel. It occasionally replies to a message, revives a quiet channel, or plays out a short conversation between several members, "as" those members. Each reply uses retrieval over that member's past messages plus an LLM.

## How it works

```
Discord message (configured channel, humans only)
  -> ingest: raw row -> corpus filter -> corpus row -> Chroma vectors
  -> triggers: auto reply | reply chain | reply command | revive | scripted conversation
  -> persona: weighted pick, the command's choice, random (revive) or planned (conversation)
  -> context (channel transcript or reply thread) + retrieval (examples, dedup, frequent phrases)
  -> LLM chat completion (DeepSeek)
  -> post-processing: unwrap quotes, split bursts, strip links, cap GIFs, resolve GIFs, truncate
  -> delivery: embed or webhook, one message per burst part, recorded in bot_messages
```

Code lives in `src/`, CLI entry points in `scripts/`, tests in `test/`, specs in `docs/specs/`. Contributor rules are in [CLAUDE.md](CLAUDE.md).

## Setup

Requirements: Node 22.18+ (it uses `node:sqlite` and `process.loadEnvFile`), a Chroma server, and a Discord application with the **Message Content** privileged intent. All paths (`.env`, `data/`, `messages.db`) are relative to the working directory, so run everything from the repo root.

1. Install dependencies with `npm install`.
2. Provide the credentials below in `.env` or the environment. `.env` is optional and never overrides variables already set. A `.env` that exists but cannot be loaded stops startup. A missing required variable stops startup with one message listing all of them. An empty or whitespace-only value counts as not set.

   | Variable | Needed by | Purpose |
   | --- | --- | --- |
   | `DISCORD_BOT_TOKEN` | `start`, `backfill`, `reimport`, `register` | Bot login and command registration |
   | `DISCORD_CLIENT_ID` | `register` | Command registration |
   | `OPENAI_API_KEY` | `start`, `backfill`, `reimport` | Embeddings (`text-embedding-3-small`, 512 dimensions, via Chroma's embedding function) |
   | `DEEPSEEK_API_KEY` | `start` | Chat completions (`deepseek-v4-flash`, thinking enabled). The chat client is never built without it, so `OPENAI_API_KEY` is never sent to DeepSeek |
   | `KLIPY_API_KEY`, `GIPHY_API_KEY`, `HUMOR_API_KEY` | optional; `gif-smoke` needs at least one | GIF search, tried in that order. Only engines with a key are used. With none, GIF tokens stay as placeholder text and startup logs one warning |

   `inspect` needs no variables. Optional overrides (channel, ports, switches) are in the [configuration reference](#configuration-reference).

3. Create the data files. Both are git-ignored, as are `.env`, `*.db`, `*.old` and `*.db.new`.

   `data/users.json` lists the members the bot may imitate. Only their messages enter the corpus.

   ```json
   [{ "username": "discord_username", "name": "Real Name", "id": "optional Discord user id" }]
   ```

   The file must be a non-empty array. Each entry needs a non-empty string `username` and `name`. Usernames must be unique ignoring case. `id`, when given, is 5 to 25 digits (a string or a number). Other keys are ignored. With an `id`, member lookups are exact from the first use. Without it, the id is learned from the first successful username search.

   `data/ping_caches.json` maps Discord ids to display text, used to rewrite mentions.

   ```json
   { "users": { "<id>": "name" }, "roles": { "<id>": "name" }, "channels": { "<id>": "name" } }
   ```

   The file must be an object. `users`, `roles` and `channels` default to `{}`. A missing, unreadable or malformed data file stops startup with a one-line error naming the file.

4. Start Chroma (port 7429 unless `CHROMA_PORT` is set): `npx chroma run --port 7429 --path ./data/chroma`.
5. Register the context-menu command once, and again whenever the command definition changes: `npm run register`.
6. Run the bot: `npm start`.

## Upgrading an existing installation

For an installation that ran the old flat layout (`node bot.js`, a `messages.db` and Chroma data). The credential variable names are unchanged. Do these in order.

1. Stop the bot. Nothing else may write to `messages.db` during the upgrade.
2. Back up `messages.db` and the Chroma data directory (the `--path` you gave `chroma run`). The re-import also keeps `messages.db.old`, but that is not a substitute for your own backup.
3. Pull the new code and run `npm install`. Node must be 22.18 or newer.
4. Change the process manager or service definition to run `npm start` (it runs `node src/main.js`) from the repo root. A supervisor should restart the bot on exit code 1 (see [Operations](#operations)).
5. Check `.env`. The variable names are unchanged, but `.env` is now optional, GIF keys are optional, and boolean switches accept only `true` or `false`. Anything else (`0`, `yes`) stops startup. Missing required variables stop startup.
6. Check `data/users.json` and `data/ping_caches.json` against the rules in [Setup](#setup). Duplicate usernames (ignoring case), a missing `name` or a malformed `id` now stop startup.
7. Start Chroma as before. The default port, `message_embeddings` and `message_reply_embeddings` are unchanged.
8. Decide about the re-import.
   - **Without it,** `npm start` works on the old files. The first start applies additive migrations (new tables, columns and indexes) and keeps every existing row. Old rows keep their old filtering and reply links. `npm run backfill -- --skip-history --sync-vectors` adds the `has_gif` metadata that old Chroma rows lack.
   - **With it (recommended once),** every current rule is applied uniformly to the history. Starting the bot first is not needed: the re-import reads the old database read-only and works on the old schema. Follow the steps below.
9. Re-import:
   1. `npm run reimport` (a dry run). It needs Discord and the variables above, not Chroma. It prints how many messages it would handle and changes nothing.
   2. `npm run reimport -- --yes`. Chroma must be running; the script checks Chroma and the embedding API before it starts fetching. It backs up `messages.db` to `messages.db.old` (a hard link, else a verified copy), puts a freshly built database in its place and re-imports the whole channel. Vectors go into a new Chroma generation (`message_embeddings_g<UTC timestamp>` and the matching reply collection). The old collections are not touched.
   3. `npm run backfill` once, to pick up anything posted during the re-import.
   4. `npm start`.

Cost: every kept message is embedded again, and Discord serves 100 messages per request. A channel with a few hundred thousand messages takes tens of minutes, a small embeddings bill and a few hundred megabytes of memory.

Rollback: stop the bot, move `messages.db` aside and rename `messages.db.old` to `messages.db`. The restored database uses the old collections again. Rows recorded after the re-import stay in the file you moved aside. If a re-import stops midway, run `npm run reimport -- --yes --resume`. Details are under [Reimport](#reimport).

## Triggers

Every trigger acts only in the configured channel (`PATEXT_CHANNEL_ID`). Bot-authored messages are ignored.

| Trigger | When it fires | Persona | Posts as |
| --- | --- | --- | --- |
| Auto reply | A human message that passes the content filter and the checks below | Weighted pick (see [Retrieval and prompting](#retrieval-and-prompting)) | Discord reply to the message |
| Reply chain | A human replies to a bot message whose persona is still in `users.json` | The persona of that bot message | Discord reply to the message |
| `reply` command | A user picks **Apps -> reply** on a message and chooses a persona in a modal | The modal choice, or the auto-reply pick for `random` | Interaction reply (not a Discord reply to the target) |
| Revive | A timer finds the channel idle after a human message | Random member | Plain channel message |
| Scripted conversation | A due revive that wins a roll (see below) | 2 to 5 members whose history fits the topic | Plain channel messages, one persona after another |

The author of an auto-reply or command target need not be a listed member (the content filter skips only the approved-author rule). A chain reply also skips the minimum length, so a short reply such as `why` can continue a thread.

**Auto reply checks.** They run in this order and stop at the first refusal.
1. Rate limit: at least `reply.minIntervalMs` (5 min) since the last auto, chain or command reply.
2. In-flight guard: only one auto reply is generated at a time. A message that arrives meanwhile is not answered, uses no roll and counts no miss. The slot is held until the whole reply, bursts included, is out or has failed.
3. Failure cooldown: after a reply failed before anything was sent, no new attempt for `reply.failureCooldownMs`.
4. Roll: chance `reply.probability` (0.1). After `reply.escalateAfterMisses` (10) misses the chance grows by `reply.escalationStep` (0.05) per further miss. Only a delivered auto reply resets the miss count.

A failure before delivery also hands the channel activity back to the human message. A failed send arms the rate limit, so a persistent send failure costs at most one LLM call per window.

**Reply chain.**
- With `CHAIN_REPLIES` on, a reply to a bot message continues the thread when the thread can be built. Otherwise (persona no longer listed, bot message deleted, message dropped by the chain filter) it is treated as any other message.
- Rate limit and probability do not apply. The first `chain.fullDepth` (3) bot messages in a thread are always answered. Later ones are answered with chance `chain.decay` raised to the number of bot turns beyond that (0.5, 0.25, 0.125, 0.0625). A thread never holds more than `chain.maxBotTurns` (8) bot messages.
- One chain reply is generated at a time. One user gets at most one per `chain.userCooldownMs`, and at most `chain.maxPerWindow` are accepted per `chain.windowMs`.
- With `CHAIN_REPLIES=false` such a message goes through the auto-reply path.

**`reply` command.** It skips the probability, the rate limit and the in-flight guard. A user may start one per `command.userCooldownMs`, and at most `command.maxConcurrent` run at once. A refused invocation gets an ephemeral message. The modal lists at most 24 members plus `random`. With more members the list starts with the default persona and is cut to 24. When the target is a bot message, its persona is the default choice. The submission is acknowledged at once (`deferReply`) before anything slow happens. If the reply fails afterwards, the placeholder is edited to `Could not generate a reply.`

**Revive.** Checked every `revive.checkIntervalMs` (10 min).
- It fires only when the last activity was a human message, not a fresh start and not a naturally spawned bot message. That message is more than `revive.dayIdleMs` (3 h) old between 10:00 and 22:59 in `revive.timeZone`, or more than `revive.nightIdleMs` (12 h) old otherwise.
- Only auto replies, revives and conversation turns count as the bot speaking last. Chain and command replies do not, so idle time keeps running from the last human message. The bot never revives twice in a row.
- A failed revive hands the activity back and blocks new attempts for `revive.failureCooldownMs` (kept in memory, cleared by a restart).

**Scripted conversation.** When a revive is due, there is a `conversation.chance` (10%) that the bot plays out a short conversation instead, provided no conversation turn was sent in the last `conversation.minIntervalMs` (24 h; read from `bot_messages`, so it survives restarts). `CONVERSATIONS=false` turns it off.
- **Planning.** The topic candidates come from the [topic bank](#topic-bank), or from a neighbourhood search of the corpus while the bank is empty. One LLM call picks and sharpens one of up to `conversation.topicCandidates` candidates, given the time, the end of the last real conversation, the topics of the last `conversation.avoidRecentTopics` conversations (not offered again) and messages that restarted the chat in the past. An invalid answer is asked for again `conversation.planRetries` times. The personas (`conversation.minPersonas` to `maxPersonas`) are drawn from the people who wrote about the topic, weighted by their share and how recently they did, and topped up from a search of the history when the topic has too few authors. The number of messages is drawn from `minMessages` to `maxMessages`. Every persona speaks at least once and nobody speaks twice in a row. A burst counts as one message.
- **If planning fails** (no topic, an unusable topic answer, too few personas) the reason is logged and a normal revive is sent in the same check.
- **Playing.** Each turn is generated on its own, with retrieval for its speaker and the messages so far in the prompt, and sent `conversation.minDelayMs` to `maxDelayMs` (5 to 30 s) after the previous one, or as soon as it is ready if generation took longer. Every turn after the first references the previous turn, so replies and chains work on it. The typing indicator shows during the wait.
- **Talking over people.** A human posting mid-conversation does not stop or change it: the message is recorded as usual and the remaining turns go out as planned. While a conversation is planned or played, no auto reply starts, so the bot does not answer bystanders in the middle of its own conversation. A direct reply to one of its turns still gets a chain reply from that turn's persona, who sees the turns up to that point.
- **Failure and shutdown.** If the first turn fails it is a failed revive (activity handed back, `revive.failureCooldownMs`) and no fallback revive is sent. If a later turn fails, the error is logged and the conversation ends there. A shutdown ends it quietly. A conversation is never resumed after a restart; its last turn restores the rate limit and counts as the bot speaking last.
- Webhook display (`PERSONA_DISPLAY=webhook`) suits conversations better than embeds, because each turn then reads as a message by that person. Run `npm run topics` first: with an empty bank the conversations fall back to a plain neighbourhood search and are noticeably worse.

**All reply types** arm the 5 minute rate limit after delivery, except revive. Edits and deletes never trigger anything.

**Overrides.** `REPLY_OVERRIDE` replies to every message, ignoring randomness, rate limit and the in-flight guard. `REVIVE_OVERRIDE` checks every `revive.overrideCheckIntervalMs` (1 min) and revives regardless of idle time or who spoke last. Both are for testing.

**Typing and bursts.** While an auto reply, chain reply, revive or conversation turn is worked on, the bot shows the typing indicator (`typing.*`). The `reply` command does not type.
- A persona who often sends several short messages in a row may answer with a burst. At least `burst.minSamples` of their raw messages must exist, and at least `burst.minRate` of them must have been followed by another message from the same author within `burst.windowMs`. The rate is cached per author for `burst.cacheMs`.
- Such personas get a prompt section saying the answer may be split into up to `burst.maxMessages` messages with `<split>` on its own line. A `<split>` from any persona is honoured. With `BURSTS=false` it becomes a newline in one message.
- The first part is sent as usual. Later parts are plain channel messages (follow-ups for the command), each with its own author embed and GIFs. Each follows a pause of `burst.msPerChar` per character, clamped to `burst.minDelayMs` and `burst.maxDelayMs`, with a typing pulse. Only the first part can ping the replied user.
- Every part is recorded in `bot_messages`. The rate limit is armed when the first part is delivered. If a later part fails, it is logged and the rest is skipped. Replies to any part of a burst count as one assistant turn in a chain.

## Retrieval and prompting

**Persona selection.** For an auto reply or a `random` command choice, the bot queries `message_reply_embeddings` for the `retrieval.likelyRepliers` (20) nearest entries by people other than the message's author, older than the message. Each hit weighs `1 / (1 + distance)` times a recency factor. The factor halves every `persona.recencyHalfLifeMs` (180 days) and never drops below `persona.minRecencyWeight`. An author's weight is the sum over their hits, and only members in `users.json` count. With no usable hits it falls back to a random member other than the author. Hits hidden in SQLite are dropped first.

**Examples for a reply.** Four buckets are fetched, restricted to the persona's messages older than the target. Each fetch asks for `limit * retrieval.overFetchFactor` candidates.
1. `retrieval.replyResults` (10) from `message_reply_embeddings`: their replies to similar messages. Each is paired with the stored text of the message it answered, if any.
2. `retrieval.similarResults` (20) from `message_embeddings`: their own similar messages.
3. `retrieval.gifResults` (10) from `message_embeddings` with `has_gif`.
4. `retrieval.otherResults` (10) random corpus rows.

Candidates are deduplicated greedily in that order, so an earlier bucket keeps a text and suppresses its variants later. A bucket's limit applies during the pass. Two texts merge when their normalised keys are equal (NFKC, lowercase, collapsed whitespace and letter runs, trimmed punctuation). They also merge when both keys are at least `retrieval.nearDuplicateMinChars` long and the cosine similarity of their embeddings is at least `retrieval.nearDuplicateThreshold`. If embeddings cannot be loaded, a warning is logged and only keys are compared.

**Query text.** A target shorter than `retrieval.shortMessageChars` after cleaning is embedded together with the last `retrieval.queryContextMessages` transcript (or thread) lines, so a message like `why` still matches something. Persona selection always queries with the target only.

**Frequent phrases.** Items the persona sent at least `retrieval.frequentMinCount` times among their earlier messages are listed, most frequent first, up to `retrieval.frequentLimit`. Only spellings found among the retrieved candidates are counted, so the number is a lower bound. The section is omitted when nothing qualifies.

**Recent bot output.** Replies, chains and revives end with the last `retrieval.recentBotMessages` rows of `bot_messages`, newest first, with a request not to repeat them. A failed load is logged and the section is left out.

**Reply prompt.** The user message holds these sections in order, omitting empty ones: identity (username and real name), the channel transcript, the target message with its sender, the four buckets (reply examples as `{"them", "you"}` objects), frequent phrases, the burst note, recent bot output.

**Channel transcript.** Before a reply, the bot fetches up to `context.transcriptLimit` messages that precede the target (for the command, those before the selected message). They render as `[HH:MM] speaker: text` in `context.timeZone`, oldest first, with `(replying to <speaker>)` where applicable. Bot messages appear under the persona they imitated. Other bots and bot messages with no stored row or persona embed are left out. Text is cleaned like corpus content, newlines become spaces and empty lines are dropped. Lines are cut to `context.maxEntryChars`, and messages more than `context.maxAgeMs` older than the target are dropped. A failed fetch is a warning and the reply goes out without a transcript. Privacy: recent messages from people not listed in `users.json` are sent to the LLM provider as context.

**Reply thread (chain).** The bot walks up the reply references (at most `chain.maxWalkSteps`) through `bot_messages` and the raw `messages` table. A bot message from before `bot_messages` existed is fetched once through Discord and attributed by its embed. The thread goes to the model as chat turns: the persona's own messages as `assistant` turns, everyone else's as `user` turns prefixed with their username. The last `chain.maxContextTurns` turns are kept. A deleted human turn is skipped. A deleted bot message ends the walk. No channel history is fetched for chain replies, and the system prompt is unchanged.

**Revive prompt.** It uses `REVIVE_SYSTEM_PROMPT`, in this section order: identity, a situation line (local weekday and time, and how long the channel has been quiet), the end of the last conversation (`revive.transcriptLimit` messages, no age cut-off), up to `revive.starterSamples` conversation starters, up to `retrieval.reviveSamples` random examples, the burst note and recent bot output. A starter is a message by the persona that came more than `revive.starterGapMs` after the previous channel message from anyone, or the first message ever. A failed history or starter lookup is a warning and the section is left out.

**Filtering.** `filter(record)` returns a transformed copy or `null`. Transformers, in order: resolve mentions through the ping cache (mention-only messages become empty), turn Tenor links into `<gif! search terms>`, strip URLs (markdown links keep their text), reduce custom emoji to `:name:`, drop Discord timestamps, soundboard tags and `discord.gg` links, trim. Predicates: approved author, non-empty, `filter.minLength` to `filter.maxLength`, no command prefix (`filter.commandPrefixes`), and no Connections, Wordle or Strands shares.

**GIFs.** `<gif! terms>` is the corpus form of a GIF. For each token the resolver searches Klipy, then Giphy, then Humor API with the first `gifs.maxQueryLength` code points. The first engine with any result wins, and one of its results is chosen at random. An engine that throws, times out (`gifs.timeoutMs`) or answers with an HTTP error is logged and the next is tried. Resolved GIFs are removed from the text and attached as image embeds. Unresolved tokens become `<INSERT GIF: terms>` and the reply is still sent.

**LLM calls and cleaning.** The chat client uses `llm.timeoutMs` and `llm.maxRetries`, so the SDK retries connection errors, timeouts, 408, 409, 429 and 5xx. A completion with no content is retried up to `llm.emptyRetries` times, then fails. A completion that is empty only after cleaning is requested again up to `llm.postProcessRetries` times. A final failure is logged and nothing is sent. Cleaning does the following.
- Unwraps one pair of surrounding quotes (a JSON string is decoded).
- Splits on `<split>`.
- Removes stray `\n`, `\t` and `\"` escapes and a dangling quote.
- Removes every link, so a generated message cannot post a link under a member's name: markdown links keep their text, and bare URLs, `www.` hosts and Discord invites are removed.
- Drops parts that become empty, merges parts beyond `burst.maxMessages` into the last, and keeps at most `gifs.maxPerMessage` GIF tokens per message.

Delivered text is cut to `discord.maxMessageLength`, at whitespace within the last `discord.truncateLookbackChars` characters when possible. A payload carries at most `discord.maxEmbeds` embeds, the author embed included.

**Mentions.** The bot never pings anyone. Every payload, including placeholders and refusals, carries `allowedMentions: { parse: [] }`, and the client is constructed with the same default. Replies keep the reply ping unless `PING_REPLIED_USER=false`. Embed-mode replies use `failIfNotExists: false`, so a target deleted during generation still gets the reply as a plain message.

## Storage

SQLite file `messages.db` (source of truth):

| Table | Contents |
| --- | --- |
| `messages` | Every human message, raw: `id`, `author` (username), `content`, `timestamp` (ms), `reference`, `deleted_at` |
| `filtered_messages` | Messages that passed the filter, with transformed content, `has_gif`, `source_id` and `deleted_at`. `reference` is the Discord reply target if that is also in the table, else the previous filtered message when it is from a different author and less than `storage.inferredReferenceWindowMs` (1 h) older, else null. A human reply to a bot message gets a null reference and no reply embedding |
| `bot_messages` | Every message the bot sent and Discord accepted: `id`, `persona`, `content` (corpus form, GIF tokens kept), `timestamp`, `reference` (the message it answered, null for a revive or a conversation opener, the previous turn's first message for a conversation turn), `trigger` (`auto`, `command`, `revive`, `chain`, `conversation` or `imported`), `deleted_at`, `conversation_id` and `turn_index` (conversation turns only; a burst's parts share the turn index). One row per burst part. A failed insert is logged and does not affect the reply |
| `conversations` | One row per planned scripted conversation: `id`, `started_at`, `topic_id` (null for a neighbourhood topic), `topic`, `premise`, `personas` and `turns` (JSON lists of usernames; the planned speaker of each turn). A row can exist without delivered turns (the opener failed). Timing never reads it, only `bot_messages` |
| `user_profiles` | Append-only observations of members' Discord profiles: `username`, `user_id`, `display_name`, `avatar_url`, `observed_at`. The newest row per user is current |
| `message_revisions` | Append-only edit history: `message_id`, `content`, `edited_at` |
| `topic_builds`, `topics`, `topic_authors`, `topic_messages` | The topic bank (see [Topic bank](#topic-bank)): one `topic_builds` row per completed build, and per topic its label, summary, size, cohesion, median timestamp, authors with their share, and the corpus ids of its representative messages. Append-only: a build adds rows, and only `topics.deleted_at` (set by `--hide`) is ever updated |
| `meta` | Installation facts, written once and never overwritten. `chroma_generation` names the Chroma generation. `reimport_started_at` and `reimport_completed_at` mark a re-import |

Indexes cover corpus timestamp, author and content (frequency counts), `source_id`, bot message timestamp and conversation id, raw `(timestamp, id)` and the topics of a build. Migrations are additive and idempotent, run on every non-read-only open, and work on a database from any earlier version.

**Soft deletes and edits.** Nothing is removed or overwritten. A message has one logical id, its Discord id. A corpus row's logical id is `COALESCE(source_id, id)`, and `reference` columns hold logical ids.
- A delete sets `deleted_at` on the raw row, on every corpus row of that logical id, and on the `bot_messages` row if the bot sent it.
- An edit appends a `message_revisions` row, marks the visible corpus row as superseded and, if the new text passes the filter, adds a corpus row `<id>:<editedAt>` with `source_id = <id>`. The raw row keeps the original text. An edit never infers a reference. Edits that change no text (link previews, pins) are ignored.
- Every read (retrieval, samples, frequency counts, burst statistics, reply parents, recent bot output, `inspect`) ignores rows that are not visible.
- Chroma is never modified for a delete. Hits whose SQLite row is hidden are dropped after each vector query, and an edit's new row is simply added.
- The bot listens to message update, delete and bulk delete events in the channel (partial messages are enabled, so an uncached edit costs one REST fetch). Edits and deletes made while the bot is offline are not seen. A full re-import reconciles them.
- "Deleted" means the bot no longer uses the text. It stays in the SQLite file and in Chroma.

**Chroma** collections:
- `message_embeddings`: one entry per corpus row, embedded on its own content. Metadata: `author`, `timestamp`, `has_gif`.
- `message_reply_embeddings`: one entry per corpus row whose resolved reference has an embedding, stored under the embedding of the message it replies to. Querying it with a new message returns what people said in response to similar messages.
- A database created by a re-import records `chroma_generation` in `meta` and uses `<name>_<generation>` collections. A database without it uses the two plain names.

**Non-destructive rule.** Code may add to the database and to Chroma. It never deletes, truncates, drops or overwrites existing data. The only way a database file is replaced is `src/backfill/databaseSwitch.js`, which keeps the old file as `*.old`. The full rule and its enforcement are in [CLAUDE.md](CLAUDE.md).

## Member profiles and persona display

**Profiles.** Before a message is sent in a member's name, and every `profiles.refreshIntervalMs` for every member (also once at startup, without delaying it), the bot reads the member's display name and avatar from Discord. Lookups use REST only: by id with `force`, else a username search that accepts only an exact username match, so a prefix or nickname is never taken for the member. No extra privileged intent is needed. The guild is the channel's guild. Sends within `profiles.minCheckIntervalMs` of a successful check share its result, and concurrent sends share one lookup.

The profile used at send time was read within the last `profiles.minCheckIntervalMs`, unless Discord could not be reached (error, `profiles.lookupTimeoutMs`, or the member left). Then the last stored profile is used, one warning is logged per member per refresh interval, and the message is still sent. With nothing stored, the username and no avatar are used. Each change of id, display name or avatar is appended to `user_profiles`.

**Display modes.** `PERSONA_DISPLAY=embed` (default) posts as the bot, with an author embed naming the persona and showing their avatar. `PERSONA_DISPLAY=webhook` posts through a channel webhook named `discord.webhookName`, which the bot creates or reuses (it needs the Manage Webhooks permission). The message carries the member's display name and avatar, and only the GIF embeds.
- Webhook messages cannot be native replies. An auto or chain reply therefore starts with `-# ↪ <jump link>` (`discord.webhookReplyLink`). The stored text has no such line.
- Names are cut to `discord.webhookUsernameMax` code points. Discord rejects names containing `clyde` or `discord`, so such a name is replaced by the username. If that fails too, the message goes out in embed form.
- If the webhook cannot be obtained or the send fails, the message is delivered in embed form. A failed lookup is retried on the next send.
- For the `reply` command the acknowledgement is ephemeral, the placeholder reads `Replying as <persona>...` and becomes `Sent as <persona>.`, and the persona message goes to the channel.
- Messages already sent keep the name and avatar they were sent with.

## Operations

**Startup.** Startup refuses a database with an unfinished re-import (`npm run reimport -- --resume --yes`). It stops with a one-line message when Chroma cannot be reached (limit `chroma.connectTimeoutMs`). It compares `embedding.dimensions` with the length of one stored embedding and refuses on a mismatch. Invalid configuration, missing variables and bad data files also stop it. A changed embedding model with the same dimension cannot be detected, so do not change `embedding.*` for an existing collection. Use a re-import, which starts a new generation.

**Shutdown and exit codes.** `SIGINT` and `SIGTERM` stop the revive, profile and repair timers, ignore new events, and wait up to `lifecycle.graceMs` for running handlers. Then the Discord client is destroyed, the database is closed and the process exits 0. A warning names handlers still running at the end of the grace period. A second signal exits at once with code 1. An unhandled rejection or uncaught exception is logged and shuts down with code 1 and no grace period. A failed start (invalid configuration, unfinished re-import, Chroma unreachable, login failure) also exits 1.

**Gateway failures.** discord.js reports a disconnect only when the gateway closed for good, for example close code 4004 (bad `DISCORD_BOT_TOKEN`) or 4014 (Message Content intent not enabled). The bot logs the code with a hint and exits 1 instead of idling. Run it under a supervisor (systemd `Restart=on-failure`, pm2, a container restart policy). A supervisor will also restart a bot that exits because Chroma is down, so start Chroma first. Reconnects and resumes are logged at info level.

**Restart continuity.** From the database the bot restores the reply rate limit (newest auto, chain, command or conversation reply, so a restart allows no extra reply) and who spoke last and when (newest human message, or a newer auto reply, revive or conversation turn). A channel that was already quiet is revived at the first check. The miss counter restarts at 0. With an empty database the bot counts as the last speaker.

**Catch-up.** At ready the bot fetches messages posted after the newest stored one, up to `catchUp.maxMessages`. It imports them like a backfill (corpus, embeddings, own bot messages) and generates no replies. It does nothing on an empty database (use `npm run backfill`). If more than the cap were missed, the oldest are imported, a warning says to run `npm run backfill`, and activity restarts as on a fresh start. A failed fetch is a warning. `CATCH_UP=false` turns it off. A bot message delivered but not recorded before a crash is imported as `imported`, so it does not restore the rate limit.

**Vector outage and repair.** Every Chroma and embedding call has a timeout, and a lookup that hung is not cached. A live message, edit or delete is always written to SQLite first. If its vector write then fails, the handler carries on and logs one warning per `vector.repairIntervalMs`. A reply attempt that needs Chroma fails on its own and sends nothing. Every `vector.repairIntervalMs`, if a failure was noted, the bot re-checks rows of the last `vector.repairWindowMs` against Chroma and adds what is missing, reply rows included. At ready, after catch-up, the same check runs once regardless and does not delay ready. A failed repair keeps the debt and retries at the next tick. Older rows, and failed batch writes of `backfill` and `reimport`, are repaired by hand with `npm run backfill -- --skip-history --sync-vectors`.

**Logging.** All output goes through one logger per process. Errors are logged as text (stack, `[code=... status=...]`, up to three `caused by:` levels), never as objects, so request URLs and headers are not printed. Every logged string has the Discord token, the LLM key, the embedding key and the GIF keys (and their URL-encoded forms; values under 8 characters are ignored) replaced by `[redacted]`. Webhook URL tokens are redacted too. Handler errors name the work that failed, for example `Error processing message 123 (auto reply as bob, stage delivery):`.

## Scripts

Run from the repo root with `.env` present. Stop the bot before `backfill` and `reimport`: the script and the bot would write the same SQLite file. `topics` only reads Chroma and inserts into its own tables, so it may run while the bot is up.

| Command | What it does |
| --- | --- |
| `npm start` | Runs the bot |
| `npm test` | Unit and scenario tests: no network, real clock or real data |
| `npm run register` | Registers the `reply` context-menu command for `GUILD_ID` |
| `npm run inspect` | Prints the latest rows of `messages.db` per table, opened read-only. It needs no Chroma, copies, migrates and writes nothing, and reads a database from any earlier schema. A missing table prints `(no <table> table yet)`. A missing database exits 1 |
| `npm run gif-smoke` | Resolves a sample text through the real GIF APIs. Exits 1 when no GIF key is set or a token stays unresolved |
| `npm run backfill -- [options]` | Imports channel history and repairs Chroma (below) |
| `npm run reimport -- [options]` | Rebuilds the database from Discord (below) |
| `npm run topics -- [options]` | Builds, lists and hides the topic bank (below) |

### Backfill

Everything is additive and idempotent. The script logs in without starting the bot, so it never replies. An unknown option or invalid value prints the usage and exits 2.

| Option | Meaning |
| --- | --- |
| `--dry-run` | Report what would be written. Writes no rows, but may apply additive migrations and create empty collections |
| `--skip-history` | Do not import from Discord (requires `--sync-vectors`) |
| `--sync-vectors` | After importing, reconcile Chroma with SQLite |
| `--before <id>` | Import only messages older than this Discord message id |
| `--limit <n>` | Fetch at most n messages, newest first |

- The import pages backwards `backfill.pageSize` messages at a time (each page has a timeout and is retried) and writes nothing until every page was read. Human messages go through the corpus filter in batches of `backfill.batchSize`, oldest first, so inferred references work. Each batch makes one embedding request.
- The bot's own past messages (its user, its own webhooks, or ids already in `bot_messages`) go into `bot_messages` with trigger `imported`. The persona comes from the embed author or, for webhook messages, from the one member whose username or past display name equals the webhook name. Messages with no attributable persona or no text are skipped and counted. Other bots and other applications' webhooks are dropped.
- `--sync-vectors` walks the corpus in pages and adds rows missing from Chroma, adds `has_gif` to Chroma rows that lack it (document and embedding unchanged) and adds missing reply rows. Rows with a missing stored document or embedding are skipped and counted. Nothing is removed. In a dry run the sync cannot see rows the import would have added.
- If a vector call fails during an import, the SQLite rows are already written. Repair with `npm run backfill -- --skip-history --sync-vectors`.
- A backfill only adds messages that are not stored yet. It does not re-filter old rows, apply offline edits or deletes, or change stored references.

### Topic bank

`npm run topics` builds a list of the subjects this group talks about, for conversations that need something to start from. It clusters message embeddings that are already stored in Chroma (nothing is embedded again), asks the LLM to name each cluster, and appends the result to SQLite. Clustering runs in this script, never in the bot, because k-means on 10,000 messages takes seconds of CPU. Run it once in a while, and again after a large import. Scripted conversations (see [Triggers](#triggers)) choose their topic from it. At ready the bot logs one line when the bank is empty or older than `topics.maxAgeMs` (90 days). With an empty bank the bot falls back to a neighbourhood search at conversation time.

```
npm run topics -- [--dry-run] [--max-messages <n>] [--list] [--hide <id>]
```

| Option | Effect |
| --- | --- |
| none | Samples up to `topics.maxMessages` eligible messages, reads their stored embeddings, clusters them, labels each kept cluster with one LLM call and stores the topics. Prints the report |
| `--dry-run` | Clusters and prints a preview (size, authors, cohesion and five representatives per kept cluster) to tune the thresholds. No LLM call, nothing written. Needs only the embedding key |
| `--max-messages <n>` | Integer, 1 or more. Overrides `topics.maxMessages` |
| `--list` | Prints the current bank (newest completed build, visible topics). Needs neither Chroma nor the LLM |
| `--hide <id>` | Hides one topic and says whether it was found. The row stays, and a later build skips a cluster with the same label |

A build needs `DEEPSEEK_API_KEY` and the embedding key and a running Chroma. It reads Chroma and only inserts into SQLite, so it can run while the bot is up. It costs one LLM call per kept cluster, at most `topics.maxLabelled` (80). With thinking enabled the calls run one after another and can take tens of minutes.

How a build decides what is a topic:
- **Eligibility.** A message must have at least `minWords` (5) words, `minDistinctWords` (4) distinct words and `minChars` (25) characters, counted on the text without GIF tokens, emoji names, mentions and punctuation, lower-cased, with stretched letters collapsed. Authors not in `data/users.json` are dropped. A phrase that occurs more than `maxPhraseRepeats` (2) times is dropped. A five-word reaction such as `lol yeah that is so true` is still eligible and is left to the cluster rules and the LLM. Text with no spaces between words (Chinese, Japanese) counts as one word and is never eligible.
- **Clusters.** `round(sqrt(n / clusterDivisor))` clusters, between `minClusters` and `maxClusters`. A cluster is kept with at least `minClusterSize` messages, `minAuthors` distinct authors (at most the number of people in `users.json`), a median length of `minMedianChars`, no author above `maxAuthorShare` of it, and no three-word opening above `maxPrefixShare` of it. The largest `maxLabelled` are labelled.
- **Labels.** The LLM sees up to `representatives` messages per cluster and may reject a cluster (reactions, logistics, bot commands, private matters, harassment). A duplicate or hidden label is skipped.
- **A bad run never replaces a good bank.** The new build becomes current only if at least `topics.minTopics` (3) topics were accepted. After `maxConsecutiveFailures` (3) failed LLM calls in a row the run stops with `reason: llm-failing`. Topics already written by such a run stay in the table but are ignored.

### Reimport

`npm run reimport -- [--yes] [--resume]` rebuilds the database from Discord so every current rule applies to old rows: `has_gif` metadata, reply links, the corpus filter, offline edits and deletes, and the bot's own messages. It is not routine. The script cannot detect a running bot and says so before doing anything.

1. Without flags it is a dry run: it reads the whole channel and prints a plan (fetched, human, own, other bots', how many the filter would keep). Nothing changes on disk or in Chroma.
2. With `--yes` it checks the state, then runs a preflight before reading anything: Chroma must answer, one test embedding request must succeed with the configured size, and the database directory must be writable. All failures are listed in one message and nothing is fetched or changed. It then reads the history (a failure here changes nothing), and backs up `messages.db` as `messages.db.old`. The backup is a hard link, else a copy made as `messages.db.old.tmp`, verified and renamed. It never overwrites an existing backup. A fresh database (built as `messages.db.new`) replaces the original by rename. The bot's own messages are imported first, then human messages oldest first, then a vector sync. Nothing is deleted.
3. It prints the backup path, the generation, a comparison with the old database (counts, ids missing in the new one, ids whose content changed) and the next steps.

| Data | In the new database |
| --- | --- |
| Human messages currently in the channel | Re-imported with current content, filter, references and embeddings |
| Messages deleted from Discord, edit history, soft-delete markers | Not carried over (they stay in the backup) |
| The bot's own messages still in the channel | Stored in `bot_messages`: persona, trigger, reference and text from the backup's table, else the embed author (trigger `imported`), else the webhook name history. Messages with no recognisable persona are not stored, and the script warns |
| `user_profiles` history | Copied |
| Old Chroma collections and the backup | Left in place |
| Messages posted after the history was read | Not included. `npm run backfill` adds them |

**Interrupted runs.** If the run stops midway, run `npm run reimport -- --yes --resume`. The steps are idempotent, and the vector sync repairs batches whose vectors were not written. A fresh run refuses to start while a `.new`, `.old` or `.old.tmp` file from an earlier run exists, and names the file to move away. A `.old.tmp` is an incomplete backup and may be moved away.

**Verification.** Before every swap, including on `--resume`, the backup must be the same file as the database (same inode) or have the same size and SHA-256, and must open read-only with a `messages` table. Otherwise the run refuses, naming the file and leaving the database untouched. Move `messages.db.old` and `messages.db.new` away and run again without `--resume`. A `-journal`, `-wal` or `-shm` file next to the database means it was not closed cleanly. Start the bot and stop it cleanly (or open and close the database with `sqlite3`) so SQLite recovers it. Do not move or delete that file.

**Resume and Discord changes.** A resumed run reads Discord afresh. Rows imported by the interrupted run are not re-checked, so edits or deletes made in between are not reconciled. Run a second re-import if that matters. A second re-import also needs `messages.db.old` moved away first. The backup and old collections stay until someone removes them by hand.

## Configuration reference

Everything tunable is in `src/config.js` and `src/config/`, validated when the config loads. A value outside its range stops startup with a message naming the key. Ranges are noted where they exist. Keys without a range are not checked. Only the environment variables below can change a value at run time. Everything else is a source edit.

### Environment variables

Credentials are listed under [Setup](#setup). Boolean variables accept `true` or `false` in any case. Anything else stops startup with an error naming the variable. An unset, empty or whitespace-only value takes the default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PATEXT_CHANNEL_ID` | `704837777564500149` | The one channel the bot reads and posts in. 5 to 25 digits |
| `GUILD_ID` | `478743674826784769` | Guild for `npm run register` only. 5 to 25 digits |
| `CHROMA_PORT` | `7429` | Chroma server port, 1 to 65535 |
| `REPLY_OVERRIDE` | `false` | `true` replies to every message (testing) |
| `REVIVE_OVERRIDE` | `false` | `true` checks every minute and revives regardless of idle time (testing) |
| `CHAIN_REPLIES` | `true` | `false` turns off reply chains |
| `CONVERSATIONS` | `true` | `false` turns off scripted conversations |
| `BURSTS` | `true` | `false` turns off multi-message bursts |
| `PING_REPLIED_USER` | `true` | `false` stops replies from pinging the author of the message they answer |
| `CATCH_UP` | `true` | `false` skips importing messages posted while the bot was down |
| `PERSONA_DISPLAY` | `embed` | `embed` or `webhook`, lowercase. Anything else stops startup |

### Tunables in `src/config.js`

Times are in milliseconds unless the key says otherwise.

**`reply`**

| Key | Default | Meaning |
| --- | --- | --- |
| `probability` | 0.1 | Chance of an auto reply per eligible message. 0 to 1 |
| `minIntervalMs` | 300000 | Rate limit between replies. 0 or more |
| `escalateAfterMisses` | 10 | Misses before the chance starts to grow |
| `escalationStep` | 0.05 | Chance added per further miss |
| `failureCooldownMs` | 60000 | No new attempt after a failed one. 0 or more |

**`revive`**

| Key | Default | Meaning |
| --- | --- | --- |
| `checkIntervalMs` | 600000 | Revive check period |
| `overrideCheckIntervalMs` | 60000 | Period with `REVIVE_OVERRIDE` |
| `dayIdleMs`, `nightIdleMs` | 10800000, 43200000 | Idle time needed by day and by night |
| `dayStartHour`, `dayEndHour` | 10, 22 | Daytime hours in `timeZone`, both inclusive |
| `timeZone` | `America/Chicago` | Zone for the day and night rule |
| `transcriptLimit` | 10 | Channel messages shown as the last conversation |
| `starterGapMs` | 3600000 | Gap that makes a message a conversation starter |
| `starterSamples` | 20 | Starters shown |
| `failureCooldownMs` | 1800000 | No new revive after a failed one. 0 or more |

**`chain`, `command`, `typing`**

| Key | Default | Meaning |
| --- | --- | --- |
| `chain.fullDepth` | 3 | Bot messages in a thread that are always answered |
| `chain.decay` | 0.5 | Answer chance factor per bot turn beyond `fullDepth`. Above 0, below 1 |
| `chain.maxBotTurns` | 8 | Bot messages a thread may hold |
| `chain.maxContextTurns` | 12 | Turns sent to the model. Integer, 2 or more |
| `chain.maxWalkSteps` | 50 | Reply references followed |
| `chain.userCooldownMs` | 10000 | Per-user spacing of chain replies. 0 or more |
| `chain.maxPerWindow`, `chain.windowMs` | 6, 600000 | Chain replies accepted per window. Integer 1 or more; above 0 |
| `command.userCooldownMs` | 30000 | Per-user spacing of `reply` commands. 0 or more |
| `command.maxConcurrent` | 2 | Commands running at once. Integer, 1 or more |
| `typing.enabled`, `typing.refreshMs` | true, 8000 | Typing indicator and its refresh |

**`burst`**

| Key | Default | Meaning |
| --- | --- | --- |
| `maxMessages` | 3 | Parts per reply. Integer, 1 or more |
| `windowMs` | 30000 | Follow-up window when measuring a persona's burst rate |
| `minRate`, `minSamples` | 0.2, 20 | Rate and raw messages needed to offer bursts |
| `cacheMs` | 3600000 | Rate cache per author |
| `msPerChar`, `minDelayMs`, `maxDelayMs` | 40, 800, 4000 | Pause before a later part |
| `siblingWindowMs` | 60000 | Window for treating bot rows with the same persona, trigger and reference as one burst |

**`filter`, `retrieval`, `persona`**

| Key | Default | Meaning |
| --- | --- | --- |
| `filter.minLength`, `filter.maxLength` | 5, 200 | Corpus length bounds in characters. 0 or more, minimum not above maximum |
| `filter.commandPrefixes` | `! $ # % & - + p!` | Messages starting with these are dropped |
| `retrieval.replyResults`, `similarResults`, `gifResults`, `otherResults` | 10, 20, 10, 10 | Examples per bucket. Integers, 1 or more |
| `retrieval.reviveSamples`, `likelyRepliers` | 30, 20 | Revive examples; hits used for persona choice. Integers, 1 or more |
| `retrieval.overFetchFactor` | 3 | Candidates fetched per example kept. Integer, 1 or more |
| `retrieval.shortMessageChars`, `queryContextMessages` | 25, 2 | Short-target rule: length and context lines added |
| `retrieval.nearDuplicateThreshold` | 0.95 | Cosine similarity that merges texts. Above 0, at most 1 |
| `retrieval.nearDuplicateMinChars` | 12 | Minimum key length for the similarity check |
| `retrieval.frequentMinCount`, `frequentLimit` | 3, 10 | Frequent-phrase threshold and cap |
| `retrieval.recentBotMessages` | 10 | Recent bot rows shown to avoid repeats |
| `persona.recencyHalfLifeMs` | 15552000000 | Recency half-life (180 days). Above 0 |
| `persona.minRecencyWeight` | 0.25 | Recency floor. Above 0, at most 1 |
| `persona.missingSimilarity` | 0.5 | Weight of a hit without a distance. Above 0, at most 1 |

**`context`, `llm`, `embedding`, `gifs`**

| Key | Default | Meaning |
| --- | --- | --- |
| `context.transcriptLimit` | 20 | Messages in the reply transcript |
| `context.maxEntryChars` | 300 | Cut length of a transcript line and of a `them` example |
| `context.maxAgeMs` | 21600000 | Transcript messages older than this (before the target) are dropped |
| `context.timeZone` | `America/Chicago` | Zone for transcript times and the situation line |
| `llm.model`, `llm.baseURL` | `deepseek-v4-flash`, `https://api.deepseek.com` | Chat model and endpoint |
| `llm.thinking`, `llm.stream` | true, false | Thinking mode; streaming |
| `llm.timeoutMs` | 120000 | Per attempt. Above 0 |
| `llm.maxRetries`, `emptyRetries`, `postProcessRetries` | 1, 1, 1 | SDK retries; retries for empty content; retries for empty cleaned output. Integers, 0 or more |
| `embedding.modelName`, `embedding.dimensions` | `text-embedding-3-small`, 512 | Must not change for an existing collection |
| `gifs.maxQueryLength` | 50 | Code points of a GIF search |
| `gifs.candidates` | 5 | Results kept per engine. Integer, 1 or more |
| `gifs.timeoutMs` | 5000 | Per lookup. Above 0 |
| `gifs.maxPerMessage` | 2 | GIF tokens kept per delivered message. Integer, 0 or more |
| `gifs.klipy*`, `gifs.humorUrl` | see source | Klipy base URL, page size 8, customer id, locale `us`, content filter `off`, format `gif`; Humor API URL |

**`discord`, `profiles`**

| Key | Default | Meaning |
| --- | --- | --- |
| `discord.maxMessageLength` | 2000 | Delivered text length limit |
| `discord.truncateLookbackChars` | 200 | How far back a cut looks for whitespace |
| `discord.maxEmbeds` | 10 | Embeds per payload. Integer, 1 or more |
| `discord.modalPreviewChars` | 1000 | Target preview in the reply modal. Integer, 0 or more |
| `discord.modalTimeoutMs` | 120000 | How long the modal waits for a submission |
| `discord.embedColor` | `0x5865F2` | Author embed colour |
| `discord.webhookName` | `deep-pa-text` | Name of the channel webhook |
| `discord.webhookUsernameMax` | 80 | Display name length in webhook mode |
| `discord.webhookReplyLink` | true | Prefix webhook replies with a jump link |
| `profiles.refreshIntervalMs` | 3600000 | Refresh of all profiles. Integer, 0 or more; 0 disables it |
| `profiles.minCheckIntervalMs` | 10000 | Reuse window of a successful check. 0 or more |
| `profiles.lookupTimeoutMs` | 5000 | Per lookup. Above 0 |
| `profiles.searchLimit` | 100 | Members returned by a username search. Integer, 1 to 1000 |

**`storage`, `chroma`, `vector`**

| Key | Default | Meaning |
| --- | --- | --- |
| `storage.databasePath`, `usersPath`, `pingCachePath` | `messages.db`, `data/users.json`, `data/ping_caches.json` | File locations, relative to the working directory |
| `storage.inferredReferenceWindowMs` | 3600000 | Window for inferring a reply reference |
| `storage.busyTimeoutMs` | 5000 | SQLite busy timeout on every connection. Integer, 0 or more |
| `storage.chunkSize` | 500 | Ids per SQL lookup. Integer, 1 or more |
| `chroma.messagesCollection`, `repliesCollection` | `message_embeddings`, `message_reply_embeddings` | Base collection names |
| `chroma.timeoutMs` | 30000 | Interactive Chroma and embedding calls. Above 0 |
| `chroma.connectTimeoutMs` | 10000 | Startup connection. Above 0 |
| `chroma.batchTimeoutMs` | 120000 | Each call of a batch operation (backfill, re-import, sync). Above 0 |
| `vector.repairIntervalMs` | 600000 | Repair period and warning spacing. Above 0 |
| `vector.repairWindowMs` | 604800000 | How far back the repair looks (7 days). Above 0 |

**`topics`** (no environment overrides)

| Key | Default | Meaning |
| --- | --- | --- |
| `topics.maxMessages` | 30000 | Messages sampled per build. Integer, 1 or more |
| `topics.recentWindowMs`, `recentShare` | 31536000000, 0.6 | Window counted as recent (365 days, above 0) and the share of the sample taken from it (0 to 1) |
| `topics.sampleOverFetch` | 2 | Each sample statement reads this many times its limit before the filters. Integer, 1 or more |
| `topics.minWords`, `minDistinctWords`, `minChars` | 5, 4, 25 | Eligibility thresholds. Integers, 1 or more |
| `topics.maxPhraseRepeats` | 2 | A phrase seen more often is dropped. Integer, 1 or more |
| `topics.clusterDivisor` | 2 | Clusters are `round(sqrt(n / clusterDivisor))`. Above 0 |
| `topics.minClusters`, `maxClusters` | 5, 120 | Bounds on the cluster count. Integer, 2 or more, and `maxClusters` at least `minClusters` |
| `topics.iterations` | 15 | k-means rounds. Integer, 1 or more |
| `topics.minClusterSize`, `minAuthors` | 15, 3 | Cluster filter. Integers, 2 or more |
| `topics.minMedianChars` | 40 | Median message length of a cluster. 0 or more |
| `topics.maxAuthorShare`, `maxPrefixShare` | 0.6, 0.3 | Largest share one author, and one three-word opening, may have in a cluster. 0 to 1 |
| `topics.maxLabelled` | 80 | Clusters labelled per build, largest first. Integer, 1 or more |
| `topics.representatives` | 20 | Messages shown to the LLM per cluster. Integer, 2 or more |
| `topics.embeddingPageSize` | 500 | Ids per embedding read. Integer, 1 to 1000 |
| `topics.maxLabelChars`, `maxSummaryChars` | 80, 300 | Cut-offs for the label and the summary. Integers, 1 or more |
| `topics.minTopics`, `maxConsecutiveFailures` | 3, 3 | Topics needed to replace the bank, and failed labels in a row that stop a run. Integers, 1 or more |
| `topics.recencyHalfLifeMs`, `recencyFloor` | 15552000000, 0.1 | Topic weight at conversation time: `max(floor, 0.5 ^ (age / halfLife)) * log(1 + size)`. Above 0 and 0 to 1 |
| `topics.maxAgeMs` | 7776000000 | Age after which the bank counts as stale (90 days). Above 0 |
| `topics.conversationSamples` | 8 | Sample messages offered with a topic. Integer, 1 or more |
| `topics.fallbackSeeds`, `neighbourhoodSize`, `minNeighbours` | 6, 30, 8 | Empty-bank fallback: seeds tried, hits per seed (integer, 2 or more) and hits needed (integer, 2 or more) |

**`conversation`** (only `enabled` has an environment override, `CONVERSATIONS`; all counts and times are integers)

| Key | Default | Meaning |
| --- | --- | --- |
| `conversation.enabled` | `true` | Scripted conversations on or off |
| `conversation.chance` | 0.1 | Chance that a due revive becomes a conversation. 0 to 1; 0 never rolls |
| `conversation.minIntervalMs` | 86400000 | Minimum time since the last conversation turn. 0 or more |
| `conversation.minPersonas`, `maxPersonas` | 2, 5 | Personas per conversation. `minPersonas` 2 or more, `maxPersonas` at least `minPersonas` |
| `conversation.minMessages`, `maxMessages` | 3, 6 | Messages (turns) per conversation. `minMessages` 1 or more, `maxMessages` at least `minMessages` and at least `maxPersonas` |
| `conversation.minDelayMs`, `maxDelayMs` | 5000, 30000 | Gap before each turn after the first. `minDelayMs` 0 or more, `maxDelayMs` at least `minDelayMs` |
| `conversation.topicCandidates` | 5 | Candidates offered to the topic call. 1 or more |
| `conversation.openerSamples`, `avoidRecentTopics` | 6, 10 | Past chat restarters shown to the topic call; recent conversations whose topics are excluded and listed. 0 or more |
| `conversation.planRetries` | 1 | Extra asks after an unusable topic answer. 0 or more |
| `conversation.personaHits` | 60 | History hits used to top up the personas. 1 or more |
| `conversation.maxTopicChars`, `maxPremiseChars` | 80, 300 | Cut-offs for the chosen topic and premise. 1 or more |
| `conversation.arrangeAttempts` | 50 | Random arrangements tried before a fixed interleave is used. 1 or more |

**`backfill`, `lifecycle`, `catchUp`, `logging`**

| Key | Default | Meaning |
| --- | --- | --- |
| `backfill.pageSize` | 100 | Messages per history request. Integer, 1 to 100 |
| `backfill.batchSize` | 100 | Messages per ingest or sync batch. Integer, 1 or more |
| `backfill.pageRetries`, `retryDelayMs` | 3, 2000 | Page retries (integer, 0 or more) and delay (0 or more) |
| `backfill.pageTimeoutMs` | 30000 | Per history page. Above 0 |
| `backfill.comparisonPageSize` | 500 | Rows per page when a re-import compares databases. Integer, 1 or more |
| `lifecycle.graceMs`, `pollMs` | 10000, 100 | Shutdown grace (0 or more) and its poll step (above 0) |
| `catchUp.maxMessages` | 2000 | Messages imported at startup. Integer, 1 or more |
| `logging.locale`, `logging.timeZone` | `en-US`, `America/Chicago` | Timestamps in log lines and `inspect` |

## Development

Rules are in [CLAUDE.md](CLAUDE.md). The essentials: all database operations are non-destructive, `npm test` must pass before every commit, behaviour changes ship with tests, the bot never pings, and non-trivial changes start from a spec.

**Layout.** Imports point downward only, as enforced by `test/unit/layering.test.js`.

| Path | Role |
| --- | --- |
| `src/main.js`, `src/container.js`, `src/container/`, `src/vendor.js` | Entry point; the only place services are wired (one builder per layer, plus the default clock); the only place real third-party constructors are collected |
| `src/config.js`, `src/config/` | Every tunable, strict environment parsing, range validation, required-variable checks, the secret list and the optional `.env` loader |
| `src/backfill/` | History import, catch-up and the full re-import (steps, guards, database switch, archive reader, plan, comparison, report). Imported only by scripts and the container |
| `src/bot/` | Triggers and orchestration: the handlers (message create, edit, delete, `reply` command, revive tick, profile refresh), reply, chain, revive and command-limit policies, activity tracker, composer, responder, lifecycle, startup and ready steps, process hooks and state restore. `src/bot/conversation/` holds the conversation policy, planner (topic call, persona draw, turn order) and runner |
| `src/ingest/`, `src/retrieval/`, `src/context/`, `src/profiles/`, `src/llm/`, `src/gifs/`, `src/topics/` | Recording into SQLite and Chroma, vector sync and repair; retrieval and persona choice; transcript and thread builders; member profile checks; prompts, generators (reply, revive and conversation turn), chat client and output cleaning; GIF engines and resolver; the topic bank (sampling, clustering filter, labelling, builder, topic source and neighbourhood fallback) |
| `src/storage/`, `src/discord/` | SQLite schema, migrations, stores and the read-only inspector, and the Chroma vector store; Discord client, payloads, embeds, delivery, webhooks, the reply modal, command definition, login and error codes |
| `src/corpus/`, `src/text/`, `src/util/`, `src/userData/`, `src/logger.js` | Content transformers and filter predicates; pure text helpers; small pure helpers; validation of `data/*.json`; the logger |
| `scripts/` | `registerCommands.js`, `inspectDb.js`, `gifSmoke.js`, `backfill.js`, `reimport.js`, `topics.js` |
| `test/unit/` | One file per source module, mirroring `src/`, plus the enforcement tests `layering`, `sizeLimits`, `unusedExports`, `coverageMap`, `nonDestructive` and `sendSites` |
| `test/characterization/`, `test/scenarios/` | Whole-bot tests through the `createWorld()` harness: behaviour pinned from the original bot, then one file per feature |
| `test/harness/`, `test/support/` | Smoke tests of the harness, and the harness itself: the world, boot helper, fakes for Discord, Chroma, the LLM, GIFs, webhooks and members, clocks and the source scanners |

**Tests.** `npm test` runs `node --test` over `test/**/*.test.js`. Tests use fakes at the third-party boundary and never touch the network, real clock, real randomness or real data.

**Specs and audit.** Behaviour is specified in `docs/specs/`; the index and implementation order are in [docs/specs/README.md](docs/specs/README.md). Specs 27 to 33 resolve the findings of the audit recorded in [docs/audit/findings.md](docs/audit/findings.md). Decisions to leave things as they are are in [spec 33](docs/specs/33-standards-and-test-gaps.md).

## Limitations

- **Only fakes were run.** The automated tests drive the bot against fakes for Discord, the LLM and the GIF APIs. Storage calls were verified against a real local Chroma server during the audit, but the whole bot has not been run against real Discord, DeepSeek, OpenAI embeddings or GIF services. Do a first run against a test channel (set `PATEXT_CHANNEL_ID`) before pointing it at the real one.
- `PATEXT_CHANNEL_ID` and `GUILD_ID` default to the values the original bot hard-coded. Set both to point the bot elsewhere.
- The Klipy content filter stays `off` (`gifs.klipyContentFilter`) and no output token cap is set. Discord's length limit and the reply limits bound what is sent.
- A human replying to part one of a burst while later parts are pending, and GIF lookups that run one after another across burst parts, are accepted.
- Discord REST calls rely on discord.js's own request timeout and retries. The `reply` command has no role allow-list: the per-user cooldown and the concurrency cap bound its cost.
- Edits and deletes made while the bot is offline are not seen until a re-import. A re-import does not carry over edit history or soft-delete markers.
- A dry run of `backfill` may apply additive schema migrations and create empty collections.
- Recent channel messages, including from people not in `users.json`, are sent to the LLM provider as context.
- Scripted conversations need a topic bank to be good. With an empty bank they fall back to a neighbourhood search of one seeded corner of the corpus, and at ready the bot logs that the bank is empty or stale.
