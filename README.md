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
| `src/bot/` | Triggers and orchestration: `handlers/` (message, `reply` command, revive tick), reply and revive policies, activity tracker, composer (generate, resolve GIFs, truncate), responder (compose then deliver), `bot.js`. |
| `src/corpus/` | Content transformers and keep/drop predicates applied before a message enters the corpus. |
| `src/storage/` | SQLite schema, migrations and queries; the Chroma vector store. |
| `src/ingest/`, `src/retrieval/`, `src/llm/`, `src/gifs/`, `src/context/` | Recording a message, retrieval and persona choice, prompts (assembled from sections) and the chat client, GIF resolution, the conversation transcript for replies. |
| `src/discord/` | Discord client construction, payloads and safe mentions, embeds, delivery (the one place replies, channel posts and interaction edits are sent), the reply modal and the command definition. |
| `src/userData/`, `src/logger.js` | Reading `data/*.json`; logging and timestamp formatting. |
| `scripts/` | `registerCommands.js`, `inspectDb.js`, `gifSmoke.js` (see the npm scripts below). |

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

3. Create the data files (git-ignored).

   `data/users.json` lists the members the bot may imitate. Only their messages enter the corpus.

   ```json
   [{ "username": "discord_username", "name": "Real Name" }]
   ```

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

Other npm scripts: `npm test` (unit and scenario tests; no network, real clock or real data), `npm run inspect` (prints the latest rows of `messages.db`, including the latest bot messages, opened read-only, no Chroma needed) and `npm run gif-smoke` (resolves a sample text through the real GIF APIs).

### Configuration overrides

Everything else is defined in `src/config.js`. These optional environment variables (in `.env` or the shell) override the defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PATEXT_CHANNEL_ID` | `704837777564500149` | The one channel the bot reads and posts in |
| `GUILD_ID` | `478743674826784769` | Guild for command registration and member lookups |
| `CHROMA_PORT` | `7429` | Chroma server port (must be a number) |
| `REPLY_OVERRIDE` | off | `true` replies to every message, ignoring randomness and the rate limit (testing) |
| `REVIVE_OVERRIDE` | off | `true` checks every minute and revives regardless of idle time (testing) |
| `PING_REPLIED_USER` | on | `false` stops auto replies from pinging the author of the message they reply to |

The corpus is only filled by live messages (`ingest.recordMessage`). There is no history backfill script in this repo; the vector store accepts batches, but nothing calls it in bulk.

## Triggers

All three only act on the configured channel (`PATEXT_CHANNEL_ID`), and bot-authored messages are ignored.

| Trigger | When | Persona | Posts as |
| --- | --- | --- | --- |
| Auto reply | A human message that passes the content filters, at least 5 min after the last bot reply, with probability 0.1. After 10 consecutive random misses the chance rises 0.05 per miss until a reply happens. | Weighted pick from the authors of the 20 nearest entries in `message_reply_embeddings` (people who replied to similar messages, excluding the message's author). Each hit weighs `1 / (1 + distance)` times a recency factor that halves every `persona.recencyHalfLifeMs` (180 days) and never drops below `persona.minRecencyWeight` (0.25); an author's weight is the sum over their hits. With no usable hits it falls back to a random user other than the message's author. | Discord reply to the message |
| Revive | Checked every 10 min. Fires only when the last activity in the channel was a human message (not a bot reply or revive, and not a fresh start) and it is more than 3 h old during 10:00–22:59 Central, or more than 12 h old otherwise. The bot therefore never revives twice in a row. | Random user | Plain channel message |
| `reply` context menu | A user right-clicks a message, then **Apps → reply**, and picks a persona (or `random`, which uses the auto-reply selection) in a modal. Skips the probability and rate limit. | Chosen in the modal | Interaction reply (not a Discord reply to the target) |

`REPLY_OVERRIDE` and `REVIVE_OVERRIDE` remove the randomness and timers for testing.

## Storage

SQLite (`messages.db`):

- `messages`: every human message in the channel, raw (`id`, `author` username, `content`, `timestamp` ms, `reference`).
- `bot_messages`: every message the bot sent and Discord accepted (`id` Discord message id, `persona` username it imitated, `content` generated text in corpus form with GIF tokens kept, `timestamp` ms, `reference` id of the message it answered or null for a revive, `trigger` `auto`, `command`, `revive` or `chain`). Written right after delivery; a failed send records nothing, and a failed insert is logged without affecting the reply. Bot messages sent before this table existed are attributed through their embed author instead.
- `filtered_messages`: messages that passed `filter()`, with transformed content and `has_gif`. `reference` is the Discord reply target if that target is also in this table; otherwise the previous filtered message when it is from a different author and less than 1 h older; otherwise null. An index on `(author, content)` (`idx_filtered_messages_author_content`) serves the frequency counts below.

Chroma:

- `message_embeddings`: one entry per filtered message, embedded on its own content. Metadata: `author`, `timestamp`, `has_gif`.
- `message_reply_embeddings`: one entry per filtered message whose resolved reference (explicit Discord reply, else the inferred previous message) has an embedding in `message_embeddings`, stored under the embedding of the message it replies to. Querying it with a new message returns what people said in response to similar messages.

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

For a revive (`retrieveForRevive`), the prompt is 50 random messages from the persona (150 are fetched and deduplicated by normalised key only) followed by the avoid-repeats section (`buildRevivePrompt`). No channel context is included (see spec 20).

## Filtering

`messageFilter.filter(record)` returns a new record with transformed content, or `null`; the input is not modified. `filterAnyAuthor` is the same without the `approvedAuthors` predicate (excluded by name).

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

- There is no history backfill.
