# Spec 00: Test harness

**Depends on:** nothing. **Blocks:** 01, 02 and every later spec.

## Goal

Provide a harness that boots the whole bot with fakes at the third-party boundary, so the same test files run unchanged against the current (legacy) code and against the refactored code. Only one file, `test/support/boot.js`, knows how the application is constructed.

The legacy source files (`bot.js`, `db.js`, `api.js`, `filter.js`, `data.js`, `prompt.js`, `register.js`) MUST NOT be modified by this spec.

## Constraints of the legacy code

Legacy modules have import-time side effects and module-level state:

- `loadEnvFile('.env')`, `data/users.json`, `data/ping_caches.json` and `messages.db` are resolved against the current working directory. `loadEnvFile` does not override variables already present in `process.env`.
- `db.js` constructs a `ChromaClient`, awaits `heartbeat()` and creates two collections at import.
- `api.js` constructs two `OpenAI` clients and a `GiphyFetch` at import, and uses global `fetch`.
- `bot.js` constructs a discord.js `Client`, registers handlers, calls `login`, and keeps reply/revive state in module variables. It uses `Math.random`, `Date.now`, `new Date()` and `setInterval`. It does not await `message.reply` or `channel.send`.

## Design rules

- **One world per process at a time.** Timers, `Math.random`, `fetch`, console, cwd and `process.env` are process-global. `createWorld` throws if a world is already open. Test files run in separate processes (`node --test` default), and tests inside a file run sequentially; never enable `concurrency`.
- **`world.js` is construction-agnostic.** Everything specific to how the app is built (module mocks, loader hook, temp directory, `.env`, `chdir`, opening the database) lives in `boot.js`. `bootBot(world)` returns `{ subject, sqlite, dispose }`; `world.js` only calls it.
- **Fakes are standalone.** Each fake module exports a factory returning `{ <constructors>, state }` with no reference to a world, so unit tests can use a fake directly. `boot.js` creates the fakes for a world and exposes their `state` on it.
- **Cleanup is exact.** `world.close()` undoes each patch it installed, in reverse order, through the handle it kept (`mock.timers.reset()`, each `mock.method` handle's `.mock.restore()`). It MUST NOT call `mock.restoreAll()` or `mock.reset()`, which would also drop the module mocks and let the next world construct real clients. If boot throws, `createWorld` runs the same cleanup before rethrowing.

## Legacy boot technique (validated by prototype; use exactly this)

1. **Module mocks**, registered once per process at the top of `boot.js` with `node:test`'s `mock.module` (needs `--experimental-test-module-mocks`):
   - `discord.js`: `namedExports: { ...realDiscordJs, Client }` (real builders are kept).
   - `chromadb`: `namedExports: { ChromaClient }`.
   - `@chroma-core/openai`: `namedExports: { OpenAIEmbeddingFunction }`.
   - `openai`: `defaultExport: OpenAI`.
   - `@giphy/js-fetch-api`: `namedExports: { GiphyFetch }`.
   The mocked exports are thin delegating classes: each constructor forwards to the fake constructors of the world currently booting (a module-level `current` in `boot.js`, set only for the duration of the import).
2. **Fresh module graph per world.** A resolve hook registered with `node:module`'s `register()` propagates a `?gen=N` query from a parent module to every project-local child. `import('<repo>/bot.js?gen=N')` then evaluates a fresh copy of every legacy module.

   ```js
   // test/support/legacy-hooks.mjs
   const ROOT = new URL('../../', import.meta.url).href;
   const isProjectFile = (url) =>
     url.startsWith(ROOT) && !url.includes('/node_modules/') && !url.startsWith(`${ROOT}test/`);

   export async function resolve(specifier, context, nextResolve) {
     const result = await nextResolve(specifier, context);
     if (!context.parentURL) return result;
     const gen = new URL(context.parentURL).searchParams.get('gen');
     if (!gen || !isProjectFile(result.url)) return result;
     const url = new URL(result.url);
     url.searchParams.set('gen', gen);
     return { ...result, url: url.href };
   }
   ```
3. **Environment and working directory.** Boot creates a temp directory with `.env` (from `fixtures.ENV`), `data/users.json`, `data/ping_caches.json`; saves and deletes the `ENV` keys from `process.env`; `chdir`s in; imports. `dispose` restores cwd and the saved environment values and removes the directory.
4. **Time and randomness** (installed by `world.js`): `mock.timers.enable({ apis: ['setInterval', 'Date'], now })`, `mock.method(Math, 'random', ...)`, `mock.method(globalThis, 'fetch', ...)`.
5. **Settling.** `FakeClient.on`/`once` wrap listeners. Each invocation's returned promise is tracked, with a `.catch` attached that records the error in `world.errors` (an unobserved rejection would fail the run). `world.settle()` loops: await every tracked promise that is not *parked*, then `await` one `setImmediate`; it finishes when no unparked promise is outstanding and two consecutive yields start no new work. A handler is **parked** while it is blocked inside a fake `awaitModalSubmit`; `submit()`/`timeout()` unpark it and then settle. Fakes never use timers.
6. **Console.** The world replaces `console.log`/`warn`/`error` with collectors (`world.logs`) for its lifetime.

## Files

```
test/support/
  world.js            createWorld(options) and the world API below
  boot.js             bootBot(world): the only construction-aware file
  legacy-hooks.mjs    resolve hook (removed by spec 02)
  fixtures.js         USERS, PING_CACHE, ENV, IDs, BASE_TIME
  fakes/discord.js    createFakeDiscord()
  fakes/chroma.js     createFakeChroma(), fakeEmbed
  fakes/llm.js        createFakeOpenAI()
  fakes/gifs.js       createFakeGifs()
test/harness/harness.test.js   smoke tests for the harness itself
```

`package.json`: `"test": "node --experimental-test-module-mocks --test \"test/**/*.test.js\""`. Remove the placeholder test script. Do not add dependencies.

## Fixtures (`fixtures.js`)

- `USERS`: `[{username:'alice',name:'Alice Example'},{username:'bob',name:'Bob Example'},{username:'carol',name:'Carol Example'},{username:'dave',name:'Dave Example'}]`.
- `PING_CACHE`: `{ users: {'111':'alice','222':'bob'}, roles: {'333':'mods'}, channels: {'444':'general'} }`.
- `ENV`: `{ DISCORD_BOT_TOKEN: 'test-discord-token', DISCORD_CLIENT_ID: 'test-client-id', OPENAI_API_KEY: 'test-openai-key', DEEPSEEK_API_KEY: 'test-deepseek-key', GIPHY_API_KEY: 'test-giphy-key', HUMOR_API_KEY: 'test-humor-key', KLIPY_API_KEY: 'test-klipy-key' }`.
- `CHANNEL_ID = '704837777564500149'` (hardcoded in legacy `bot.js`), `OTHER_CHANNEL_ID = '999'`, `GUILD_ID = '478743674826784769'`.
- `BASE_TIME = Date.parse('2026-11-12T18:00:00Z')` (12:00 Central, CST, daytime).

## World API (`world.js`)

`createWorld(options?)` is async; `options`: `{ users = USERS, pingCache = PING_CACHE, now = BASE_TIME, random = 0.99 }`. Default random 0.99 means "do not auto-reply" unless a test opts in (note: after 28 consecutive misses the legacy chance reaches 1.0). The caller registers `t.after(() => world.close())`.

| Member | Behaviour |
| --- | --- |
| `world.env` | The `ENV` fixture values the app was booted with. Tests assert keys against this. |
| `world.now()` | Current mocked time (ms). |
| `world.advance(ms)` | Ticks in chunks of at most 600 000 ms (`mock.timers.tick` evaluates every callback at the end time of a tick, so chunks keep each revive check at its own time), settling after each chunk. |
| `world.advanceTo(epochMs)` | `advance(epochMs - now())`; throws if in the past. |
| `world.setRandom(x)` | `x` is a number (constant), an array (consumed in order, last value repeats), or a function. `world.randomCalls` counts calls. |
| `world.settle()` | See technique 5. |
| `world.ready()` | Emits `Events.ClientReady` and settles. |
| `world.emitMessage(fields)` | Builds a fake message, emits `Events.MessageCreate`, settles, returns the message. |
| `world.openReplyCommand({ target, user })` | Builds a context-menu interaction for command `reply`, emits `Events.InteractionCreate`, settles (the handler ends up parked on the modal, or finished), returns the interaction. |
| `world.emitInteraction(interaction)` | Emits an arbitrary interaction and settles. |
| `world.discord` | `{ client, clientOptions, guild, channel, otherChannel }`; `clientOptions` is what the `Client` constructor received. |
| `world.llm` | `{ calls, callClients, respondWith(x), constructed }`. `calls` are chat-completion requests in order; `callClients[i]` is the constructor options of the instance that received `calls[i]`; `respondWith` takes a string, an array (consumed in order, last repeats), a function `(request) => string`, or an `Error` (rejects; inside an array, that call rejects). Default `'ok cool'`. `constructed` lists every instance's constructor options. |
| `world.gifs` | `{ klipy, giphy, humor, constructed }`, each engine `{ calls, setResult(x) }`; `x` is a URL string, `null` (no result), a function `(query) => url|null`, or an `Error`. Default `null`. `klipy.calls`/`humor.calls` record the requested `URL` object; `giphy.calls` record `[term, options]`. `constructed` lists `GiphyFetch` constructor arguments. |
| `world.chroma` | `{ constructed, embeddingFunctionOptions, collection(name) }`; `collection(name)` throws for a collection the app never created. |
| `world.sqlite` | `{ all(sql, ...params), get(sql, ...params) }`, read-only queries against the bot's database (from `bootBot`). |
| `world.subject` | The function-level surface (below). |
| `world.seed(messages)` | For each `{id, author, content, timestamp, reference?}` in order, calls `subject.recordMessage`; resolves to an array of booleans (`true` if a `filtered_messages` row exists for that id afterwards). |
| `world.logs`, `world.errors` | `{ log: [], warn: [], error: [] }` captured console calls; rejections of tracked handler promises. |
| `world.close()` | Rejects any pending modal wait, restores patches in reverse order, calls `dispose`. Idempotent. |

A world boots the bot inside `createWorld` (the app registers handlers and calls `login`). `ClientReady` is not emitted until `world.ready()`.

### Subject surface (returned by `bootBot`)

Tests use this instead of importing source modules:

```
{ filter(msg), filterAnyAuthor(msg),                 // return the transformed message or null
  recordMessage(msg),                                // resolves when stored; return value unspecified
  semanticSearch(author, msg), randomSearch(author), searchLikelyRepliers(msg),
  getRAGResponse(author, msg), getRandomResponse(author),
  processGIFs(text),
  SYSTEM_PROMPT, ragInput(...), contextlessInput(...) }
```

Legacy mapping: the same-named exports of `filter.js`, `db.js`, `api.js`, `prompt.js`, imported with the world's `?gen=N`. The `filter`, `filterAnyAuthor`, `recordMessage`, `semanticSearch`, `getRAGResponse` and `searchLikelyRepliers` wrappers pass a shallow clone of the message, because legacy mutates its argument and that mutation is not part of the contract.

## Fakes

### Discord (`createFakeDiscord()` → `{ Client, state, makeMessage, makeInteraction, makeReplyCommand }`)

- `Client extends EventEmitter`: `user = { id: 'bot-user', tag: 'deep-pa-text#0000', username: 'deep-pa-text' }`; `login(token)` pushes to `loginTokens` and resolves; `channels.fetch(id)` returns the known channel (rejects for unknown ids); `guilds.fetch(id)` returns the guild and records the call in `guildFetches`; listener wrapping per technique 5.
- Guild: `{ id: GUILD_ID, members: { fetch({ query, limit }) } }`, returning a collection-like `{ first() }`. By default the member has `displayAvatarURL()` → `https://cdn.example/avatars/<query>.png`. Controls: `members.calls`, `members.setFailing(true)` (fetch rejects), `members.setMissing(true)` (`first()` returns `undefined`), `members.avatars[username] = url | null`.
- Channel: `{ id, guild, guildId, send(payload), sent: [] }`; `send` records the payload and resolves to a fake bot message `{ id, author: { id: 'bot-user', bot: true }, content, embeds, createdTimestamp, channel }`.
- Message fields: `{ id = 'auto-<n>', author = 'alice', content = '', timestamp = now, reference = null, bot = false, channel = state.channel, guild = channel.guild }`. Produces `{ id, author: { id: 'user-<username>', username, bot }, content, createdTimestamp, reference: reference ? { messageId: reference } : null, channel, guild, guildId, reply(payload), replies: [] }`. Passing `guild: null` yields `guild: null` with `guildId` still set. `reply` records the payload and resolves to a fake bot message.
- Reply-command interaction: `{ id, commandName: 'reply', user: { id, username }, targetMessage, isMessageContextMenuCommand() → true, reply(payload), showModal(modal), awaitModalSubmit(options) }` plus controls: `replies`, `modal` (`modal.toJSON()` of what was shown, else `null`), `modalOptions` (the `awaitModalSubmit` argument), `submit({ author, customId = modal.custom_id })` → resolves the pending wait with a modal-submit interaction, settles, and returns it; `timeout()` → rejects the wait with an `Error` and settles. The modal-submit interaction is `{ customId, user, fields: { getStringSelectValues(id) → [author] }, reply(payload), editReply(payload), replies: [], edits: [] }`; `reply`/`editReply` resolve to a fake bot message. `failEdits(error)` on it makes `editReply` reject.
- `makeInteraction(overrides)` builds non-matching interactions (`isMessageContextMenuCommand() → false`, or another `commandName`).

Payloads are recorded as received. Tests read embeds via `embed.data` (real `EmbedBuilder`). Legacy does not await `message.reply`/`channel.send`, so the fakes offer no way to make those two reject (a rejection would be unhandled); spec 12 adds that.

### Chroma (`createFakeChroma()` → `{ ChromaClient, OpenAIEmbeddingFunction, state }`)

- `fakeEmbed(text)`: lowercase, split on `/[^a-z0-9]+/`, drop empties; for each token add 1 to dimension `fnv1a32(token) % 64`; L2-normalise. No tokens → the unit vector along dimension 0.
- `OpenAIEmbeddingFunction`: constructor options recorded; `generate(texts)` → `texts.map(fakeEmbed)`.
- `ChromaClient`: constructor options recorded; `heartbeat()` resolves (or rejects after `state.failHeartbeat(error)`); `getOrCreateCollection({ name, embeddingFunction })` returns the collection for `name`, creating it once.
- Collection:
  - `upsert({ ids, documents, metadatas, embeddings })`: stores copies by id (later upserts overwrite). When `embeddings` is absent, uses the collection's embedding function. Metadata values that are `undefined` are dropped (the real client drops them). Records every call in `upserts`.
  - `get({ ids, include })` → the existing ids in request order, with `embeddings`/`documents`/`metadatas` only when named in `include` (default `['documents','metadatas']`).
  - `query({ queryEmbeddings | queryTexts, nResults, where, include })` → `{ ids: [[...]], ... }`, one inner list per query, nearest first by squared L2 distance, ties by insertion order; `queryTexts` are embedded with the collection's embedding function; fields other than `ids` are present only when named in `include` (default `['documents','metadatas','distances']`). An empty collection returns `[[]]`. Records calls in `queries`.
  - `where`: `{ field: value }` equality, `$and`, `$or`, and per-field `$eq`, `$ne`, `$lt`, `$lte`, `$gt`, `$gte`, `$in`, `$nin`. A record lacking the field fails equality/`$eq`/`$lt`/`$lte`/`$gt`/`$gte`/`$in` and passes `$ne`/`$nin`.
  - Controls: `rows` (Map id → `{ document, metadata, embedding }`), `seed(records)` inserting `{ id, document, metadata, embedding? }`, `setFailing(error | null)` making every operation reject.

### LLM (`createFakeOpenAI()` → `{ OpenAI, state }`)

`chat.completions.create(request)` records the request and resolves `{ choices: [{ message: { content } }] }` per `respondWith`; `embeddings.create({ input })` resolves `{ data: [{ embedding }] }` for each input using `fakeEmbed`.

### GIFs (`createFakeGifs()` → `{ GiphyFetch, fetch, state }`)

- `GiphyFetch` (constructor argument recorded): `search(term, options)` → `{ data: url ? [{ images: { original: { url } } }] : [] }`.
- `fetch(url)`: routes by hostname. `api.klipy.com` → `{ json: async () => ({ data: { data: url ? [{ file: { hd: { gif: { url } } } }] : [] } }) }`. `api.humorapi.com` → `{ json: async () => ({ images: url ? [{ url }] : [] }) }`. Any other host rejects with `Error('unexpected fetch: <url>')`.

## Smoke tests (`test/harness/harness.test.js`)

1. Sequential worlds are independent: world A replies to a message and closes; world B has a different client, an empty database, and replies immediately (not rate-limited by A).
2. `createWorld` while a world is open throws. A boot failure (force one, for example a pre-set failing heartbeat option) leaves no patches behind: the next `createWorld` succeeds.
3. `emitMessage` from an approved author with `random = 0` produces one `message.replies` entry and one `world.llm.calls` entry; the message is in `world.sqlite.all('SELECT id FROM messages')`.
4. `ready()`, a human message, then `advance(4 * 3600_000)` produces exactly one payload in `channel.sent`; each interval callback observed its own time (revive fired at +3 h 10 min, not at +4 h: check the bot message `createdTimestamp`).
5. `openReplyCommand` shows a modal; while it is pending, `emitMessage` and `advance` still return; `submit({ author: 'bob' })` yields one `reply` and one `editReply`; `timeout()` on another interaction yields none. `close()` with a pending modal does not hang.
6. `setRandom` array form (last repeats) and function form; `respondWith` array containing an `Error`; `gifs.klipy.setResult(Error)` makes `subject.processGIFs('<gif! cat>')` reject; a URL result is returned; an unexpected host rejects.
7. Collection `query`: ordering by distance, `where` operators (`$and`, `$or`, `$lt`, `$ne`, `$in`, `$nin`, equality, missing field), `include` filtering, empty collection → `[[]]`, `queryTexts`. `fakeEmbed` is deterministic and identical token sets give identical vectors.
8. `guild.members` controls: default avatar, `setMissing`, `setFailing`, per-user override. `channels.fetch` of an unknown id rejects.
9. `close()` restores `process.cwd()`, the saved `process.env` values, `Math.random`, `Date.now`, `fetch`, `console.log`, and removes the temp directory; calling it twice is safe; a world created afterwards still gets fake clients (module mocks intact).

## Acceptance

- `npm test` passes on the unmodified legacy source.
- No legacy source file is changed. No real network, API key, `messages.db` or `data/` in the repo root is touched.
- Harness files follow `CLAUDE.md` (small functions, no duplication). Classes are allowed where a faked library API is class-shaped.
