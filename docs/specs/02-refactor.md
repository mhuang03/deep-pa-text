# Spec 02: Refactor to a modular architecture

**Depends on:** 00, 01 (all characterization tests green on legacy). **Blocks:** every spec numbered 10 and above.

## Goal

Restructure the code to follow `CLAUDE.md` (dependency injection, no import-time side effects, small single-purpose modules, one config source) without changing behaviour. The characterization suite must pass with its test files unchanged; only `test/support/boot.js` and `test/harness/harness.test.js` are rewritten for the new construction.

## Permitted behaviour changes

Only these. Anything else observable stays identical, including `Math.random` call order (spec 01), the order of side effects in each handler (listed below), payload shapes, prompt text, SQL schema, Chroma collection names and metadata.

1. `guilds.fetch(...)` in the revive path becomes `client.guilds.fetch(...)` (the legacy identifier was undefined).
2. The message filter no longer mutates its argument; it returns a new record. Content is transformed once instead of twice on the reply path (the transformers are idempotent for real inputs; a unit test proves it over the spec 01 table).
3. The unused OpenAI embeddings client, `fetchEmbedding(s)` and `BOTTESTING_CHANNEL_ID` are removed. Only the DeepSeek-configured chat client is constructed.
4. Chroma is connected at startup (`vectorStore.connect()` before `bot.start()`), not at import.
5. `node db.js` (debug dump) becomes `npm run inspect`, which opens SQLite read-only and does not need Chroma. `test.js` becomes `npm run gif-smoke`. `register.js` becomes `npm run register`. `index.js` is deleted.
6. Channel and guild IDs, Chroma port and the two override flags gain optional environment overrides with the legacy values as defaults.
7. `message.reply` and `channel.send` are still **not awaited** (state updates follow immediately, as in legacy), but each gets a rejection handler that logs the error, so a failed send is no longer an unhandled rejection. Spec 12 replaces this with awaited sends. The whole reply-command handler, including the part before the modal, runs inside the handler's catch-and-log.
8. `gifLinks` are returned in token order (legacy order depended on which lookup finished first). Placeholder/removal replacement inserts text literally (legacy `String.replace` interpreted `$` sequences in search terms).
9. Log wording may change; console output is not pinned. Keep each legacy log event (received message, filter result, reply decision, reply, revive, command reply, errors).
10. Known bugs pinned by `KNOWN BUG` tests are preserved exactly (later specs fix them).

**Deferred, not part of this spec:** timeouts on external calls (specs 13 and 14), awaited sends and safe mentions (spec 12). The refactor is not judged against those `CLAUDE.md` rules.

## Target layout

```
src/
  main.js                 entry point: loadEnvFile, loadConfig, loadData, buildContainer, connect, start
  container.js            buildContainer({ config, vendor, data, clock, logger })
  vendor.js               createVendor(): the real third-party constructors
  config.js               DEFAULTS, loadConfig(env)
  logger.js               createLogger(sink), formatTimestamp(ms, { locale, timeZone })
  userData/loadData.js    loadData(paths), buildUserDirectory(users)
  corpus/transformers.js  createTransformers({ pingCache })
  corpus/predicates.js    createPredicates({ usernames, config })
  corpus/messageFilter.js createMessageFilter({ users, pingCache, config })
  storage/migrations.js   MIGRATIONS
  storage/database.js     openDatabase(path, options), runMigrations(db)
  storage/messageStore.js createMessageStore({ db, config })
  storage/vectorStore.js  createVectorStore({ client, embeddingFunction, config })
  ingest/ingestService.js createIngestService({ messageStore, vectorStore, messageFilter })
  retrieval/dedupe.js     dedupeBuckets(buckets)
  retrieval/retriever.js  createRetriever({ vectorStore, messageStore, config }), BUCKET_ORDER
  retrieval/personaSelector.js  createPersonaSelector({ vectorStore, users, random, config })
  llm/prompts.js          SYSTEM_PROMPT, buildReplyPrompt, buildRevivePrompt
  llm/chatClient.js       createChatClient({ client, config })
  llm/generator.js        createGenerator({ chatClient, retriever, userDirectory })
  gifs/gifTokens.js       findGifTokens, applyGifResults
  gifs/engines.js         createKlipyEngine, createGiphyEngine, createHumorEngine
  gifs/gifResolver.js     createGifResolver({ engines, config })
  discord/client.js       createDiscordClient(Client)
  discord/messageRecord.js toMessageRecord(discordMessage)
  discord/authorEmbed.js  createAuthorEmbeds({ config, logger })
  discord/payload.js      buildPayload({ content, gifLinks, authorEmbed })
  discord/replyModal.js   buildReplyModal, readSelectedAuthor, REPLY_MODAL_ID, AUTHOR_SELECT_ID, RANDOM_AUTHOR
  discord/commands.js     REPLY_COMMAND_NAME, buildCommands()
  bot/activityTracker.js  createActivityTracker({ now })
  bot/replyPolicy.js      createReplyPolicy({ config, now, random })
  bot/revivePolicy.js     isDaytime, shouldRevive
  bot/composer.js         createComposer({ generator, gifResolver, authorEmbeds })
  bot/logLines.js         pure formatters for the handler log lines
  bot/handlers/messageCreate.js   createMessageCreateHandler(deps)
  bot/handlers/replyCommand.js    createReplyCommandHandler(deps)
  bot/handlers/reviveTick.js      createReviveTick(deps)
  bot/bot.js              createBot(deps) → { start() }
scripts/
  registerCommands.js     npm run register
  inspectDb.js            npm run inspect
  gifSmoke.js             npm run gif-smoke
test/unit/...             mirrors src/
```

Do not create any directory named `data` (git-ignored at every depth). Legacy root files `api.js`, `bot.js`, `data.js`, `db.js`, `filter.js`, `index.js`, `prompt.js`, `register.js`, `test.js` are deleted in package R3b.

## Shared types

- **MessageRecord:** `{ id: string, author: string (username), content: string, timestamp: number (ms), reference: string | null }`.
- **StoredMessage:** MessageRecord with the resolved `reference` plus `hasGif: boolean`.
- **Hit:** `{ id, document, metadata, distance }` (one vector query result; always all four, regardless of what legacy requested via `include`).
- **GifLink:** `{ match: string, url: string }` (`url` is `''` when unresolved).
- **UserDirectory:** `{ users, usernames: Set<string>, nameOf(username) → string | undefined }`. An unknown username yields `undefined`, which legacy rendered as the text `undefined` in prompts; keep that.
- **Buckets:** `{ replies: string[], similar: string[], gifs: string[], other: string[] }`; `BUCKET_ORDER = ['replies', 'similar', 'gifs', 'other']` is the precedence and prompt order. Code never relies on object key order.

## Configuration (`src/config.js`)

`loadConfig(env = {})` returns a deep-frozen object. It never throws on missing secrets (entry points validate what they need). A non-numeric `CHROMA_PORT` throws `Error('CHROMA_PORT must be a number')`. Boolean overrides are true only for the string `'true'`. Values, with environment overrides in parentheses:

```
discord:   token (DISCORD_BOT_TOKEN), clientId (DISCORD_CLIENT_ID),
           channelId '704837777564500149' (PATEXT_CHANNEL_ID), guildId '478743674826784769' (GUILD_ID),
           botName 'deep-pa-text', embedColor 0x5865F2 (legacy '#5865F2'; same embed data), modalTimeoutMs 120000
reply:     probability 0.1, minIntervalMs 300000, escalateAfterMisses 10, escalationStep 0.05,
           override false (REPLY_OVERRIDE)
revive:    checkIntervalMs 600000, overrideCheckIntervalMs 60000, dayIdleMs 10800000, nightIdleMs 43200000,
           dayStartHour 10, dayEndHour 22 (inclusive), timeZone 'America/Chicago', override false (REVIVE_OVERRIDE)
filter:    minLength 5, maxLength 200, commandPrefixes ['!','$','#','%','&','-','+','p!']
storage:   databasePath 'messages.db', usersPath 'data/users.json', pingCachePath 'data/ping_caches.json',
           inferredReferenceWindowMs 3600000
chroma:    port 7429 (CHROMA_PORT), messagesCollection 'message_embeddings', repliesCollection 'message_reply_embeddings'
embedding: apiKeyEnvVar 'OPENAI_API_KEY', modelName 'text-embedding-3-small', dimensions 512
retrieval: replyResults 10, similarResults 20, gifResults 10, otherResults 10, reviveSamples 50, likelyRepliers 20
llm:       apiKey (DEEPSEEK_API_KEY), baseURL 'https://api.deepseek.com', model 'deepseek-v4-flash',
           thinking true (request carries thinking: { type: 'enabled' }; omitted when false), stream false
gifs:      klipyApiKey (KLIPY_API_KEY), giphyApiKey (GIPHY_API_KEY), humorApiKey (HUMOR_API_KEY),
           maxQueryLength 50, klipyBaseUrl 'https://api.klipy.com/api/v1', klipyPerPage 8, klipyCustomerId 'deep-pa-text',
           klipyLocale 'us', klipyContentFilter 'off', klipyFormatFilter 'gif',
           humorUrl 'https://api.humorapi.com/gif/search', humorNumber 1, giphyLimit 1
logging:   locale 'en-US', timeZone 'America/Chicago'
```

Modules receive `config` (or the slice they need) as a dependency. Tunables and IDs appear nowhere else. User-facing strings (modal title, labels, the two ephemeral error messages, `thinking...`) are named constants in the `src/discord/` module that uses them.

## Module contracts

Behaviour of each function is the legacy behaviour of the code it replaces (legacy location in brackets).

**`logger.js`**: `createLogger(sink = console)` → `{ info, warn, error }` forwarding to `sink.log/warn/error`. `formatTimestamp(ms, { locale, timeZone })` → the legacy `toLocaleString` string.

**`userData/loadData.js`** [`data.js`]: `loadData({ usersPath, pingCachePath })` → `{ users, pingCache }` (reads and parses the two files); `buildUserDirectory(users)` → UserDirectory.

**`corpus/messageFilter.js`** [`filter.js`]: `createMessageFilter(...)` → `{ transform(content) → string, filter(record) → MessageRecord | null, filterAnyAuthor(record) → MessageRecord | null }`. Falsy content (`''`, `null`, `undefined`) is treated as `''`. Transformers and predicates are ordered lists of `{ name, apply }` / `{ name, test }` in the legacy order; `filterAnyAuthor` excludes the predicate **named** `approvedAuthors` (not by position). Never mutates its input. Do not call `.test()` on a shared `/g` regex.

**`storage/migrations.js`**: `MIGRATIONS` is an ordered array of descriptors, each either `{ sql }` (must begin `CREATE TABLE IF NOT EXISTS` or `CREATE INDEX IF NOT EXISTS`) or `{ addColumn: { table, column, definition } }` (applied only if `PRAGMA table_info` lacks the column). This spec contains only the three legacy `{ sql }` statements, verbatim. **`storage/database.js`**: `openDatabase(path, { readOnly = false } = {})` opens `node:sqlite` and, unless read-only, calls `runMigrations(db)`.

**`storage/messageStore.js`** [`db.js` SQL]: statements prepared once in the factory.
- `insertRaw(record)` and `insertFiltered(record) → StoredMessage`, both `ON CONFLICT(id) DO NOTHING`, with legacy reference resolution and `has_gif`.
- `randomContents({ author, before = null, limit }) → string[]` (SQL `ORDER BY RANDOM()`, not injectable; `before` filters `timestamp < before`).
- `latestRaw(limit)`, `latestFiltered(limit)`, `latestWithReference(limit)` (rows joined with the referenced content), `latestWithGif(limit)` for the inspect script.

**`storage/vectorStore.js`** [`db.js` Chroma]:
- Collections are obtained through one memoised promise (`getOrCreateCollection` for both, in the legacy order); a rejected attempt is not cached, so the next call retries.
- `connect()` → `client.heartbeat()` then resolves the collections.
- `embed(text) → number[]` (one call to `embeddingFunction.generate([text])`).
- `upsertMessages(messages)` → legacy `insertEmbeddings` step for step: upsert all into the messages collection with metadata `{ author, timestamp, has_gif: m.hasGif }`; collect distinct non-null references; if none, return; `get({ ids, include: ['embeddings'] })`; if none found, return; upsert **every** referencing message into the replies collection with the parent's embedding (legacy does not skip rows whose parent was not found; spec 10 fixes that).
- `query(collection, { embedding, text, where, limit }) → Hit[]`, `collection` being `'messages'` or `'replies'`; exactly one of `embedding` (sent as `queryEmbeddings: [embedding]`) or `text` (sent as `queryTexts: [text]`, embedded by the collection) must be given, otherwise it throws.

**`ingest/ingestService.js`** [`recordMessage`]: `recordMessage(record) → { filtered: MessageRecord | null }`. Order: `insertRaw(record)`, `filter(record)`, and when kept `insertFiltered(filtered)` then `vectorStore.upsertMessages([filtered])`. To preserve the pinned known bugs it passes the **filter output** (raw Discord reference, no `hasGif`) to the vector store, not the StoredMessage.

**`retrieval/retriever.js`** [`semanticSearch`, `randomSearch`]: `retrieveForReply(author, record) → Buckets`: embed `record.content` once; three vector queries with that embedding (`replies` collection limit `replyResults`; `messages` limit `similarResults`; `messages` with `has_gif: true` limit `gifResults`), each with `where` = author and `timestamp < record.timestamp` in the legacy `$and` form; `other` from `randomContents`; then `dedupeBuckets` in `BUCKET_ORDER`. `retrieveForRevive(author) → string[]` (`reviveSamples` random contents). **`retrieval/dedupe.js`**: `dedupeBuckets(arrays) → arrays`: exact-string dedup within each array and against all earlier arrays; does not mutate.

**`retrieval/personaSelector.js`** [`searchLikelyRepliers` + selection in `bot.js`]: `likelyRepliers(record) → Promise<string[]>` (text query on the replies collection, `where` author `$ne` and `timestamp $lt`, limit `likelyRepliers`, authors in hit order with duplicates). `pickReplier(record) → Promise<username>`: fetch the list, **always** consume one roll for `list[Math.floor(roll * list.length)]`, and only if that is undefined call `pickRandomUser()` (one more roll). `pickRandomUser() → username`.

**`llm/prompts.js`** [`prompt.js`]: `SYSTEM_PROMPT` unchanged; `buildReplyPrompt({ author, name, message, buckets })` and `buildRevivePrompt({ author, name, examples })` produce the legacy strings byte for byte.

**`llm/chatClient.js`**: `complete({ system, user }) → Promise<string>` sends `{ model, thinking, stream, messages: [system, user] }` and returns `choices[0].message.content` unmodified. **`llm/generator.js`** [`getRAGResponse`, `getRandomResponse`]: `generateReply(persona, record) → Promise<string>`, `generateRevive(persona) → Promise<string>`.

**`gifs/`** [`processGIFs`]: `findGifTokens(text, maxQueryLength) → [{ match, query }]` (regex `/<gif!(.*?)>/g`; `query` is the capture trimmed, then cut to `maxQueryLength`). `applyGifResults(text, gifLinks) → string`: for each link, replace the **first** occurrence of `match` with `''` when it has a url, else with `'<INSERT GIF: ' + match.slice(5)`, inserting literally. Engines: `createKlipyEngine({ fetch, config })`, `createGiphyEngine({ giphy })` (a `GiphyFetch` instance), `createHumorEngine({ fetch, config })`, each `{ name, search(query) → Promise<string> }` returning `''` for no result, with the legacy request shape and result path. `createGifResolver({ engines, config })` → `{ resolve(text) → Promise<{ content, gifLinks }> }`: tokens resolved concurrently, each trying engines in order Klipy, Giphy, Humor until one returns a url; an engine error rejects (pinned).

**`discord/`**: `toMessageRecord(message)` → MessageRecord (`author` is `message.author.username`; `reference` is `message.reference?.messageId || null`). `createAuthorEmbeds(...)` → `{ make(author, guild, { thinking = false } = {}) }` [`makeAuthorEmbed`: member lookup `{ query: author, limit: 1 }`, `first()?.displayAvatarURL() ?? null`, a failed lookup is logged as a warning and yields no icon, footer `thinking...` when requested]. `buildPayload` → `{ content, embeds }` with one image embed per link that has a url, then the author embed. `buildReplyModal({ record, users })` returns the legacy modal. `createDiscordClient(Client)` constructs it with intents `Guilds`, `GuildMessages`, `MessageContent`. `buildCommands()` → the JSON bodies registered by legacy `register.js`.

**`bot/activityTracker.js`**: `{ noteHuman({ timestamp, author }), noteBot(), get() → { lastMessageTime, lastWasBot } }`. Initial state: `now()` and `lastWasBot: true`. `noteBot()` sets `lastMessageTime = now()`.

**`bot/replyPolicy.js`**: `{ decide() → { reply, reason, roll?, chance? }, noteReply({ resetMisses }) }`. `decide()`: with `override`, return `{ reply: true, reason: 'override' }` without rolling; else if a reply time exists and `now() - replyTime < minIntervalMs`, `{ reply: false, reason: 'rate-limited' }` (no roll, no miss); else `roll = random()`, `chance = probability + Math.max(0, misses - escalateAfterMisses) * escalationStep` (exactly this expression), and if `roll > chance` count a miss and return `{ reply: false, reason: 'random', roll, chance }`, else `{ reply: true, reason: 'accepted', roll, chance }`. `noteReply` sets the reply time to `now()` and zeroes misses only when `resetMisses` is true.

**`bot/revivePolicy.js`**: `isDaytime(nowMs, config)` (hour in `timeZone` via the legacy `toLocaleString` call; `dayStartHour <= hour <= dayEndHour`); `shouldRevive({ activity, nowMs, config })` = `override || (!activity.lastWasBot && (daytime ? elapsed > dayIdleMs : elapsed > nightIdleMs))`. Pure.

**`bot/composer.js`**: `composeReply({ persona, record, guild }) → { response, payload }`; `composeRevive({ persona, guild }) → { response, payload }`. The single place that runs generate → resolve GIFs → author embed → `buildPayload`.

**`bot/handlers/messageCreate.js`**, steps in order:
1. Return unless `message.channel.id === config.discord.channelId` and `!message.author.bot`.
2. `record = toMessageRecord(message)`; `activity.noteHuman({ timestamp: message.createdTimestamp, author })` synchronously, before any await.
3. Inside try/catch (errors logged): `await ingest.recordMessage(record)`.
4. `target = messageFilter.filterAnyAuthor(record)`; if null, log and return.
5. `decision = replyPolicy.decide()`; if not `reply`, log and return.
6. `activity.noteBot()` (not rolled back on later failure).
7. `persona = await personaSelector.pickReplier(target)`.
8. `{ response, payload } = await composer.composeReply({ persona, record: target, guild: message.guild })`.
9. `message.reply(payload)` not awaited, rejection logged.
10. `replyPolicy.noteReply({ resetMisses: true })`; `activity.noteBot()`; log.

**`bot/handlers/reviveTick.js`**, inside try/catch: (1) return unless `shouldRevive`; (2) `activity.noteBot()`; (3) `channel = await client.channels.fetch(channelId)`, `guild = channel.guild ?? await client.guilds.fetch(channel.guildId)`; (4) `persona = personaSelector.pickRandomUser()`; (5) `composer.composeRevive`; (6) `channel.send(payload)` not awaited, rejection logged; (7) `activity.noteBot()`; log.

**`bot/handlers/replyCommand.js`**, inside try/catch: (1) return unless a message context-menu command named `reply`; (2) `target = filterAnyAuthor(toMessageRecord(targetMessage))`; if null, ephemeral "not replyable" reply and return; (3) `guild = message.guild ?? await client.guilds.fetch(message.guildId)`; (4) wrong channel → ephemeral reply and return; (5) `await interaction.showModal(buildReplyModal(...))`; (6) `await interaction.awaitModalSubmit({ time: modalTimeoutMs })`, a rejection is logged and ends the flow; (7) return if `customId !== REPLY_MODAL_ID`; (8) persona = selected value, or `await pickReplier(target)` for `random`; (9) `await modalInteraction.reply({ embeds: [thinking embed] })`; (10) `composeReply`, then `await modalInteraction.editReply(payload)`; (11) log, `replyPolicy.noteReply({ resetMisses: false })`, `activity.noteBot()`. No state is touched before step 11.

**`bot/bot.js`**: `createBot({ client, config, handlers, clock, logger })` → `{ start() }`: `client.once(ClientReady)` logs `Logged in as <tag>` and starts the revive interval with `clock.setInterval` (`overrideCheckIntervalMs` when `revive.override`, else `checkIntervalMs`); `client.on(MessageCreate)`; `client.on(InteractionCreate)`; then `client.login(config.discord.token)`.

**`container.js`**: `buildContainer({ config, vendor, data, clock = defaultClock(), logger = createLogger() })`. `vendor = { Client, ChromaClient, OpenAIEmbeddingFunction, OpenAI, GiphyFetch, fetch }`; `data = { users, pingCache }`; `clock = { now, random, setInterval }`. `defaultClock()` returns lazy wrappers (`() => Date.now()`, `() => Math.random()`, `(fn, ms) => setInterval(fn, ms)`) and `createVendor()` supplies `fetch: (...args) => globalThis.fetch(...args)`, so global mocks installed before or after construction are honoured. Returns `{ bot, client, db, logger, vectorStore, messageStore, messageFilter, ingest, retriever, personaSelector, generator, gifResolver, composer, userDirectory }`. `vendor.js` is the documented exception that may import `discord.js` outside `discord/` and `bot/`.

**`main.js`**: `loadEnvFile('.env')`; `config = loadConfig(process.env)`; `data = loadData(config.storage)`; `container = buildContainer({ config, vendor: createVendor(), data })`; `await container.vectorStore.connect()`; `container.bot.start()`.

**`scripts/`**: `registerCommands.js` [`register.js`]: loads env and config, PUTs `buildCommands()` to `Routes.applicationGuildCommands(clientId, guildId)`, logs start/success/error. `inspectDb.js` [`db.js` main block]: opens the database read-only and prints the four legacy sections (latest 10 raw, latest 10 filtered, latest 10 with reference and the referenced content, latest 10 with GIF) using `formatTimestamp`. `gifSmoke.js` [`test.js`]: resolves a sample text through the real GIF engines and prints the result. Scripts contain no logic beyond wiring and printing.

## Work packages

R1 and R2 create new files only and run in parallel while legacy code keeps working; neither imports the other's files. R3a follows both; R3b follows R3a.

### R1: pure and leaf modules

Files: `config.js`, `logger.js`, `userData/loadData.js`, `corpus/*`, `gifs/*`, `discord/*` except `client.js`, `bot/activityTracker.js`, `bot/replyPolicy.js`, `bot/revivePolicy.js`, with unit tests under `test/unit/`.

Unit test requirements:
- `config`: defaults equal the table; each environment override; deep freeze; booleans parse only `'true'`; invalid `CHROMA_PORT` throws.
- `logger`: forwarding; `formatTimestamp` equals the legacy expression.
- `loadData`: reads temp files; `buildUserDirectory` (`nameOf` known/unknown).
- `corpus`: each transformer and predicate individually (cases from spec 01 package A plus boundaries); falsy content; input not mutated; `filterAnyAuthor` skips `approvedAuthors` by name; idempotency (`transform(transform(x)) === transform(x)`) for every spec 01 filter row; repeated calls give identical results (no regex state leak).
- `gifs`: token parsing (none, one, several, duplicates, trim-then-cut), `applyGifResults` (removal, placeholder, first occurrence only, `$&` in terms inserted literally), each engine's request and result parsing with a fake `fetch`/Giphy, resolver order and fallthrough, token-ordered `gifLinks`, rejection when an engine throws.
- `replyPolicy`: rate-limit boundary (299 999 / 300 000 ms); roll boundary at chance 0.1 (equal replies, greater does not); chance values at 10, 11, 12 and 28 misses; rate-limited and override paths consume no roll and count no miss; `noteReply` with both `resetMisses` values.
- `revivePolicy`: `isDaytime` for hours 9, 10, 22, 23 and 0 in `America/Chicago` in both standard and daylight time; `shouldRevive` truth table (bot last / human last × day / night × below / at / above each threshold × override).
- `activityTracker`: initial state and transitions.
- `discord`: `toMessageRecord` with and without a reference; payload ordering and omission of unresolved links; author embed with avatar, member missing, fetch failure (warning logged), and `thinking`; modal JSON equals the shape pinned in spec 01; `buildCommands()` JSON is one message context-menu command named `reply`.

### R2: storage, ingest, retrieval, LLM

Files: `storage/*`, `ingest/*`, `retrieval/*`, `llm/*`, with unit tests. Tests build config slices as plain literals and use `:memory:` SQLite and the standalone fakes in `test/support/fakes/`; they do not import R1 files (a stub filter object stands in for `messageFilter`).

Unit test requirements:
- `database`/`migrations`: both tables and the index exist; running twice is a no-op; a database pre-populated with legacy-schema rows keeps every row; `readOnly` rejects writes; an `addColumn` descriptor adds the column once and is skipped when present.
- `messageStore`: every reference-resolution case from spec 01; idempotent inserts; `randomContents` respects `author`, `before`, `limit`; the `latest*` queries.
- `vectorStore`: collections created once across concurrent calls; a rejected attempt is retried on the next call; `connect` calls `heartbeat`; `upsertMessages` per the legacy steps (no references, references none found, some found, pinned bugs); `query` maps to Hits, passes `where`/`limit`, uses `queryEmbeddings` vs `queryTexts`, throws when neither or both are given.
- `ingestService`: order of operations; dropped messages stored raw only; what is passed to the vector store.
- `dedupe`: precedence, within-bucket duplicates, empty buckets, input not mutated.
- `retriever`: one embedding call shared by three queries; limits; author and strict time restriction; GIF-only bucket; dedup applied.
- `personaSelector`: roll-to-index mapping; exactly one roll with a non-empty list, two with an empty list.
- `prompts`: byte-for-byte equality with literals and with `test/characterization/fixtures/system-prompt.txt`.
- `chatClient`/`generator`: request shape (with and without `thinking`), raw content returned, prompt assembly in `BUCKET_ORDER`, unknown persona name renders `undefined`, error propagation.

### R3a: orchestration

Files: `discord/client.js`, `bot/composer.js`, `bot/logLines.js`, `bot/handlers/*`, `bot/bot.js`, with unit tests using stub services and the Discord fakes.

Unit test requirements: `client` intents; `composer` reply and revive; every handler branch pinned in spec 01, plus step order (activity claimed before generation and kept on failure; the command touches no state before `editReply` succeeds and does not reset misses; override does not roll; a rejected send is logged and does not throw); `bot.start` registers `once`/`on`, uses the right interval period in normal and override modes, and logs in.

### R3b: wiring and cut-over

Files: `container.js`, `vendor.js`, `main.js`, `scripts/*`; rewrite `test/support/boot.js` and `test/harness/harness.test.js`; delete `test/support/legacy-hooks.mjs` and the legacy root files; update `package.json` and `README.md`; add `test/unit/nonDestructive.test.js`.

- `boot.js`: `bootBot(world)` builds `config = loadConfig(world.env)` with `storage.databasePath` replaced by `':memory:'`, a vendor made of the world's fakes, `data` from the world's fixtures, then `buildContainer`, `await vectorStore.connect()`, `bot.start()`. It returns `{ subject, sqlite, dispose }`: `sqlite` reads from `container.db`; `subject` maps the spec 00 surface onto services (`semanticSearch` → `BUCKET_ORDER.map` over `retrieveForReply`; `randomSearch` → `retrieveForRevive`; `searchLikelyRepliers` → `likelyRepliers`; `getRAGResponse`/`getRandomResponse` → generator; `processGIFs` → `gifResolver.resolve`; `ragInput(author, name, message, ...four arrays)` → `buildReplyPrompt`; `contextlessInput` → `buildRevivePrompt`; `recordMessage` → `ingest.recordMessage`; `filter`/`filterAnyAuthor` → `messageFilter`). No temp directory, `chdir`, environment mutation, module mock or loader hook remains; the test script drops `--experimental-test-module-mocks`.
- `harness.test.js`: drop the cwd, temp-directory and module-mock assertions; keep everything else.
- `package.json`: `"main": "src/main.js"`, `"engines": { "node": ">=22.18" }`, scripts `start` (`node src/main.js`), `test` (`node --test "test/**/*.test.js"`), `register`, `inspect`, `gif-smoke`.
- `nonDestructive.test.js`: scans every `.js` file under `src/` and `scripts/` and fails on `/\b(DELETE\s+FROM|DROP\s+(TABLE|INDEX|COLUMN|VIEW)|TRUNCATE|REPLACE\s+INTO|INSERT\s+OR\s+REPLACE)\b/i`, on `deleteCollection(` or `.reset(` anywhere, and on `.delete(` inside `src/storage/`. It also asserts every `MIGRATIONS` entry is a valid descriptor as defined above.
- Unit tests: `container` builds with fake vendor and exposes the listed services; `vendor` returns the six members; `scripts/inspectDb` output against a seeded temp database opened read-only.
- `README.md`: update the file map, setup commands, configuration overrides and the known-issues list (remove issues this spec resolves; keep the pinned bugs).

## Acceptance

- `npm test` passes: the entire characterization suite, with files under `test/characterization/` byte-identical to their pre-refactor state (`git diff --stat` shows none), plus all unit tests.
- No file outside `src/main.js` and `scripts/` has import-time side effects; `grep -rn "process.env" src` matches only `src/main.js`.
- No source file exceeds about 200 lines and functions follow the size rules in `CLAUDE.md`.
- `node --check` passes for every file. In a temp directory with a dummy `.env` and data files, `node <repo>/src/main.js` fails at the Chroma connection, not with an import or wiring error.
