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
| `src/bot/` | Triggers and orchestration: `handlers/` (message, `reply` command, revive tick), reply and revive policies, activity tracker, composer, `bot.js`. |
| `src/corpus/` | Content transformers and keep/drop predicates applied before a message enters the corpus. |
| `src/storage/` | SQLite schema, migrations and queries; the Chroma vector store. |
| `src/ingest/`, `src/retrieval/`, `src/llm/`, `src/gifs/` | Recording a message, retrieval and persona choice, prompts and the chat client, GIF resolution. |
| `src/discord/` | Discord client construction, payloads, embeds, the reply modal and the command definition. |
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

Other npm scripts: `npm test` (unit and scenario tests; no network, real clock or real data), `npm run inspect` (prints the latest rows of `messages.db`, opened read-only, no Chroma needed) and `npm run gif-smoke` (resolves a sample text through the real GIF APIs).

### Configuration overrides

Everything else is defined in `src/config.js`. These optional environment variables (in `.env` or the shell) override the defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PATEXT_CHANNEL_ID` | `704837777564500149` | The one channel the bot reads and posts in |
| `GUILD_ID` | `478743674826784769` | Guild for command registration and member lookups |
| `CHROMA_PORT` | `7429` | Chroma server port (must be a number) |
| `REPLY_OVERRIDE` | off | `true` replies to every message, ignoring randomness and the rate limit (testing) |
| `REVIVE_OVERRIDE` | off | `true` checks every minute and revives regardless of idle time (testing) |

The corpus is only filled by live messages (`ingest.recordMessage`). There is no history backfill script in this repo; the vector store accepts batches, but nothing calls it in bulk.

## Triggers

All three only act on the configured channel (`PATEXT_CHANNEL_ID`), and bot-authored messages are ignored.

| Trigger | When | Persona | Posts as |
| --- | --- | --- | --- |
| Auto reply | A human message that passes the content filters, at least 5 min after the last bot reply, with probability 0.1. After 10 consecutive random misses the chance rises 0.05 per miss until a reply happens. | Random pick from the authors of the 20 nearest entries in `message_reply_embeddings` (people who replied to similar messages, excluding the message's author); falls back to a random user. | Discord reply to the message |
| Revive | Checked every 10 min. Fires only when the last activity in the channel was a human message (not a bot reply or revive, and not a fresh start) and it is more than 3 h old during 10:00–22:59 Central, or more than 12 h old otherwise. The bot therefore never revives twice in a row. | Random user | Plain channel message |
| `reply` context menu | A user right-clicks a message, then **Apps → reply**, and picks a persona (or `random`, which uses the auto-reply selection) in a modal. Skips the probability and rate limit. | Chosen in the modal | Interaction reply (not a Discord reply to the target) |

`REPLY_OVERRIDE` and `REVIVE_OVERRIDE` remove the randomness and timers for testing.

## Storage

SQLite (`messages.db`):

- `messages`: every human message in the channel, raw (`id`, `author` username, `content`, `timestamp` ms, `reference`).
- `filtered_messages`: messages that passed `filter()`, with transformed content and `has_gif`. `reference` is the Discord reply target if that target is also in this table; otherwise the previous filtered message when it is from a different author and less than 1 h older; otherwise null.

Chroma:

- `message_embeddings`: one entry per filtered message, embedded on its own content. Metadata: `author`, `timestamp`, `has_gif`.
- `message_reply_embeddings`: one entry per filtered message that has a (Discord) reference, stored under the embedding of the message it replies to. Querying it with a new message returns what people said in response to similar messages.

## Retrieval and prompting

For a reply (`retrieveForReply`), four buckets are fetched, all restricted to the persona's messages older than the target message:

1. 10 nearest from `message_reply_embeddings` (their replies to similar messages)
2. 20 nearest from `message_embeddings` (their own similar messages)
3. 10 nearest from `message_embeddings` with `has_gif`
4. 10 random rows from `filtered_messages`

Buckets are deduplicated by exact content, with earlier buckets taking precedence. `buildReplyPrompt` puts the persona's username, real name, the target message's content, and the four buckets into one user message.

For a revive (`retrieveForRevive`), the prompt is just 50 random messages from the persona (`buildRevivePrompt`). No channel context is included.

## Filtering

`messageFilter.filter(record)` returns a new record with transformed content, or `null`; the input is not modified. `filterAnyAuthor` is the same without the `approvedAuthors` predicate (excluded by name).

Transformers, in order: resolve mentions through the ping cache (mention-only messages become empty), turn Tenor links into `<gif! search terms>`, strip URLs (markdown links keep their text), reduce custom emoji to `:name:`, drop Discord timestamps, soundboard tags and invite links, trim.

Predicates: approved author, non-empty, 5–200 characters, no bot-command prefix (`! $ # % & - + p!`), no Connections/Wordle/Strands shares.

## GIFs

`<gif! terms>` is the corpus representation of a GIF. When the LLM emits one, the GIF resolver searches Klipy, then Giphy, then Humor API with the first 50 characters of the terms and takes the first hit. Resolved GIFs are removed from the text and attached as image embeds; unresolved ones are left as `<INSERT GIF: terms>`.

## Known issues

These behaviours are pinned by the characterization tests in `test/characterization/` and are fixed by later specs.

- Live messages are stored in Chroma with `has_gif: undefined` (the stored message is not passed on), so they never match the GIF bucket.
- The inferred (previous-message) reference is saved to SQLite but not passed to the vector store, so live messages only enter `message_reply_embeddings` when they are explicit Discord replies.
- `awaitModalSubmit` has no filter, so two users with the modal open at once can receive each other's submission. A dismissed modal logs a timeout error after 2 min.
- A GIF API that throws (rather than returning no results) fails the whole response.
- The bot's own messages are not stored, so there is no record of which persona wrote a given bot message.
- There is no history backfill.
- `message.reply` and `channel.send` are not awaited: a failed send is logged, but the bot's state is updated as if it had succeeded. There are no timeouts on external calls.
