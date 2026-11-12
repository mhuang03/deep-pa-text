# Spec 01: Characterization tests

**Depends on:** 00. **Blocks:** 02.

## Goal

Pin every observable behaviour of the legacy bot so the refactor (spec 02) can be proven behaviour-preserving. Tests run against the unmodified legacy code through the spec 00 harness and must pass before any source change.

## Rules

- Tests live in `test/characterization/`. They use only `createWorld()`, `world.subject` and `test/support/fixtures.js`. They never import a source module, `discord.js` internals aside from `Events`/`MessageFlags`, or anything that would change in the refactor.
- One `createWorld()` per test, with `t.after(() => world.close())`.
- Assert observable results only: return values, SQLite rows (`world.sqlite`), Chroma rows/calls (`world.chroma`), LLM requests (`world.llm`), GIF calls (`world.gifs`), Discord payloads. Do not assert on console output.
- Where a result is randomly ordered (SQL `ORDER BY RANDOM()`), compare as sets or check membership and size.
- A test that pins a known defect is named with the prefix `KNOWN BUG (spec NN):` so the fixing spec can find and flip it. Never "fix" the legacy code to make a test pass; if legacy behaviour differs from this spec, the legacy behaviour wins: pin it and report the discrepancy.
- Legacy source files are not modified. Harness files may be extended only additively, with the `Edit` tool, and each such change is reported.
- `Math.random` call order is part of the contract. Auto reply: (1) probability roll; (2) one index roll into the likely-repliers list, always consumed, even when the list is empty; (3) a second index roll into `USERS` only when (2) yielded no persona. Revive: one roll, index into `USERS`. Reply command with `random`: (1) likely-repliers index roll, always consumed; (2) fallback `USERS` index roll if (1) yielded nothing. An index is `Math.floor(roll * length)`. Messages that are ignored, not replyable or rate-limited consume no roll.
- Assert API keys and tokens against `world.env`, never against literals or `process.env`.
- Assert payloads by the keys under test (`payload.content`, `payload.embeds`), not by deep equality of the whole payload; later specs add keys such as `allowedMentions`.
- Do not make `message.reply` or `channel.send` reject: legacy does not await them. Do not seed two messages with the same timestamp when a test depends on "previous message" resolution.
- Chance values carry floating-point noise (11 misses give `0.15000000000000002`). Use equality-boundary rolls only at chances that are exact (`0.1` with at most 10 misses, `0.2` with 12).

## Work packages

Four packages with disjoint files; they may be implemented in parallel.

### Package A: `filter.test.js`, `prompts.test.js`, `gifs.test.js`

**Filter** (`subject.filter`, `subject.filterAnyAuthor`; author `alice` unless stated). Expected value is the returned `content`, or `null` when the message is dropped.

| Input content | Expected |
| --- | --- |
| `<@111> hello there` | `@alice hello there` |
| `<@!222> hello there` | `@bob hello there` |
| `<@999> hello there` (unknown id) | `hello there` |
| `<@111> <@222>` (mentions only) | `null` |
| `<@&333> assemble now` | `@mods assemble now` |
| `see <#444> please` | `see #general please` |
| `https://tenor.com/view/funny-cat-dance-gif-12345` | `<gif! funny cat dance>` |
| `https://tenor.com/view/cat-cat-jump-gif-99?x=1` | `<gif! cat jump>` |
| `lol https://tenor.com/view/tenor-wow-gif-5 nice` | `lol <gif! wow> nice` |
| `check [this site](https://example.com/x) out` | `check this site out` |
| `look at https://example.com/page now` | `look at now` |
| `https://example.com/only` | `null` |
| `see <https://example.com> right now` | `see right now` |
| `nice <:pog:12345> one` | `nice :pog: one` |
| `<a:dance:999> party time` | `:dance: party time` |
| `meet at <t:1700000000:R> okay` | `meet at  okay` (two spaces) |
| `listen <:sound:12:34> to this` | `listen  to this` (two spaces) |
| `join discord.gg/abc123 everyone` | `join  everyone` (two spaces) |
| `   padded text   ` | `padded text` |
| `abcd` | `null` (shorter than 5) |
| `abcde` | `abcde` |
| 200 × `a` | kept unchanged |
| 201 × `a` | `null` |
| each of `!play song`, `$balance now`, `#hashtag thing`, `%stuff here`, `&thing here`, `-minus thing`, `+plus thing`, `p!catch it` | `null` |
| `Connections today was hard` | `null` |
| `Puzzle #512 done` | `null` |
| `Wordle 1234 4/6 nice` | `null` |
| `Strands #123 easy` | `null` |
| `''`, `undefined`, `null` content | `null` |

Also:

- A kept message is returned with the same `id`, `author`, `timestamp`, `reference` and the transformed `content`.
- `filter` drops a non-approved author (`mallory`); `filterAnyAuthor` keeps the same message. For approved authors the two agree on every row above.

**Prompts** (`subject.SYSTEM_PROMPT`, `subject.ragInput`, `subject.contextlessInput`).

- `SYSTEM_PROMPT` equals the checked-in fixture `test/characterization/fixtures/system-prompt.txt`. Create the fixture by copying the current prompt text exactly (no trailing newline added).
- `ragInput('alice', 'Alice Example', 'hi "there"', ['r1'], ['c1', 'c2'], [], ['o1'])` equals, exactly, the legacy template output: the username/real-name line, `The user has just received the message: "hi "there"".`, then the four sections in order (reply examples, similar messages, GIF examples, other messages), each followed by `JSON.stringify` of its array. Assert the full string against a literal built in the test.
- `contextlessInput('alice', 'Alice Example', ['m1', 'm2'])` equals the legacy output exactly.

**GIFs** (`subject.processGIFs`).

- No token: `{ content: text, gifLinks: [] }`, and no engine is called.
- Klipy has a result: `processGIFs('yo <gif! funny cat>')` → `content === 'yo '`, `gifLinks` deep-equals `[{ match: '<gif! funny cat>', url }]`; Giphy and Humor are not called.
- Klipy empty, Giphy has a result → Giphy's url; Humor not called. Klipy and Giphy empty, Humor has a result → Humor's url.
- All empty: `content === 'yo <INSERT GIF:  funny cat>'` (two spaces: the placeholder is `'<INSERT GIF: '` plus the token text after `<gif!`), and `gifLinks` is `[{ match, url: '' }]`. `'<gif!cat>'` unresolved becomes `<INSERT GIF: cat>`.
- Two different tokens, both resolved: both removed from `content`; `gifLinks` contains both (compare as a set).
- One resolved and one unresolved token in the same text (compare `gifLinks` as a set: legacy pushes in completion order).
- Search text is trimmed, then cut to 50 characters without re-trimming (use a 60-character term with no space at index 49; assert the query each engine received).
- Klipy request: host `api.klipy.com`, path `/api/v1/<KLIPY_API_KEY>/gifs/search`, query `page=1`, `per_page=8`, `q=<term>`, `customer_id=deep-pa-text`, `locale=us`, `content_filter=off`, `format_filter=gif`.
- Humor request: host `api.humorapi.com`, path `/gif/search`, query `api-key=<HUMOR_API_KEY>`, `number=1`, `query=<term>`.
- Giphy is called with `(term, { limit: 1 })`.
- `KNOWN BUG (spec 13):` when an engine throws, `processGIFs` rejects.

### Package B: `storage.test.js`, `retrieval.test.js`, `generation.test.js`

**Storage** (`subject.recordMessage`, checked through `world.sqlite` and `world.chroma`).

- Every message gets a row in `messages` with raw (untransformed) `content`, `author`, `timestamp`, `reference`, including messages from non-approved authors and messages the filter drops.
- Recording the same `id` twice leaves one row in each table and does not throw.
- A kept message gets a `filtered_messages` row with transformed content and `has_gif` 1 when the content contains `<gif!`, else 0. A dropped message gets none.
- Reference resolution in `filtered_messages`:
  - explicit reference to an id present in `filtered_messages` → that id;
  - explicit reference to an id not in `filtered_messages` → falls through to the heuristic;
  - heuristic: the latest filtered message with a strictly smaller timestamp, if its author differs and it is less than 3 600 000 ms older → its id;
  - same author → `NULL`; exactly 3 600 000 ms older → `NULL`; no earlier message → `NULL`;
  - the author and one-hour rules apply only to the heuristic: an explicit reference to a stored message by the same author, or more than an hour older, is kept as is.
- When Chroma fails (`collection.setFailing(error)`), `recordMessage` rejects, and the `messages` and `filtered_messages` rows written before the failure remain.
- Chroma `message_embeddings`: a kept message is upserted with `id`, `document` = transformed content, metadata `author` and `timestamp`. A dropped message is not upserted.
- `KNOWN BUG (spec 10):` the stored metadata has no `has_gif` key, even for a message containing a GIF token.
- Chroma `message_reply_embeddings`: a kept message with an explicit reference to an id present in `message_embeddings` is stored with its own `id`, `document`, metadata, and the **referenced** message's embedding (assert equality with the referenced row's embedding). A message with an explicit reference to an unknown id is not stored there.
- `KNOWN BUG (spec 10):` a message whose reference was inferred by the heuristic (no explicit reference) is not stored in `message_reply_embeddings`.
- Wiring: the Chroma client is constructed with `{ port: 7429 }`; the embedding function with `apiKeyEnvVar: 'OPENAI_API_KEY'`, `modelName: 'text-embedding-3-small'`, `dimensions: 512`; the collections are named `message_embeddings` and `message_reply_embeddings`.

**Retrieval** (`subject.semanticSearch`, `randomSearch`, `searchLikelyRepliers`). Seed with `world.seed` and, for `has_gif` cases, `world.chroma.collection(name).seed` plus matching SQLite rows via `world.seed`.

- `semanticSearch(author, msg)` resolves to four arrays in this order: replies to similar messages, similar messages, GIF messages, other messages.
- All four contain only `author`'s content with `timestamp < msg.timestamp` (strict: a row with the same timestamp is excluded, which is why a message never retrieves itself). Seed another author's message, a later message and an equal-timestamp message and assert their absence.
- Limits: `message_reply_embeddings` is queried with `nResults: 10`, `message_embeddings` with 20 (similar) and 10 (GIF, `where` including `has_gif: true`); the other bucket holds at most 10 rows.
- The similar bucket is ordered nearest first (seed messages with graded token overlap).
- The GIF bucket only contains records whose metadata has `has_gif: true`.
- Deduplication: identical content appearing in several buckets appears only in the earliest bucket, precedence reply > similar > GIF > other. Identical content twice within a bucket appears once.
- The other bucket: with fewer than 10 candidate rows, every row not already in an earlier bucket is present (compare as a set).
- `randomSearch(author)` returns at most 50 contents, all from `author`; with 60 seeded messages it returns exactly 50 distinct seeded contents; with 3 it returns those 3.
- `searchLikelyRepliers(msg)` returns the `author` metadata of the nearest `message_reply_embeddings` rows, nearest first, at most 20, excluding rows authored by `msg.author` and rows with `timestamp >= msg.timestamp`. Duplicate authors are preserved. Empty collection → `[]`.

**Generation** (`subject.getRAGResponse`, `getRandomResponse`).

- `getRAGResponse('alice', msg)` sends one chat request: `model: 'deepseek-v4-flash'`, `thinking: { type: 'enabled' }`, `stream: false`, `messages` = system (`SYSTEM_PROMPT`) then user. It resolves to the response content string. The request goes to the client constructed with `baseURL: 'https://api.deepseek.com'` and the `DEEPSEEK_API_KEY` value.
- The user message equals `ragInput('alice', 'Alice Example', msg.content, ...buckets)` where `buckets` are four arrays; parse the four JSON arrays out of the prompt and compare each as a set with `semanticSearch`'s result for a seeded corpus small enough to be deterministic as sets.
- `getRandomResponse('bob')` sends the same request shape with user message `contextlessInput('bob', 'Bob Example', contents)` where `contents` is a subset of bob's seeded messages.
- An LLM failure rejects with that error.

### Package C: `auto-reply.test.js`, `revive.test.js`

**Auto reply** (`world.emitMessage`).

- A message in another channel, or with `bot: true`, is ignored: no `messages` row, no LLM call, no reply.
- A message in the channel is recorded (row in `messages`) whether or not it is replied to.
- Random roll above the chance (`random = 0.5`): no reply, no LLM call.
- Roll equal to the chance (`0.1`) replies; `0.11` does not.
- A reply: exactly one `message.reply(payload)`; `payload.content` is the LLM response with GIF tokens processed; `payload.embeds` are the resolved GIF image embeds (`embed.data.image.url`) followed by one author embed with `data.author.name` = persona username, `data.author.icon_url` = the avatar URL from `guild.members.fetch({ query: persona, limit: 1 })`, and `data.color === 0x5865F2`. Nothing is sent with `channel.send`.
- The LLM user prompt names the persona, its real name, and the **transformed** message content (send `<@111> hello there` and expect `@alice hello there` in the prompt).
- Persona selection: with reply embeddings seeded so that `searchLikelyRepliers` returns `[bob, carol, ...]`, rolls `[0, 0]` pick the first and `[0, 0.99]` the last. With no likely repliers the fallback roll indexes `USERS` (`[0, 0, 0.99]` → `dave`). Note the fallback can pick the message's own author; pin it (`[0, 0, 0]` with author `alice` → persona `alice`).
- A message from a non-approved author (`mallory`) that passes the content filters can be replied to, but gets no `filtered_messages` row.
- A message that fails the content filters (`'hi'`) is never replied to even with `random = 0`, and does not count as a miss (see escalation).
- Rate limit: after a reply, a second replyable message sent less than 300 000 ms later gets no reply and triggers no LLM call even with `random = 0`; at exactly 300 000 ms it is replied to. Rate-limited messages do not count as misses.
- Escalation: with constant roll `0.12`, replyable messages 1 to 11 get no reply and the 12th is replied to (chance is `0.1 + max(0, misses - 10) * 0.05`). After that reply the counter resets: advance past the rate limit and the next message with roll `0.12` gets no reply.
- Escalation ceiling: with constant roll `0.99`, replyable messages 1 to 28 get no reply and the 29th is replied to (the chance reaches 1.0 after 28 misses).
- Avatar lookup failure (`guild.members.setFailing(true)`): the reply is still sent, with `icon_url` absent or `null`.
- LLM failure: no reply is sent and nothing lands in `world.errors`; the roll was consumed; no rate limit is armed (an immediate next message with roll 0 is replied to); the miss counter is unchanged; and no revive occurs until the next human message (the bot is recorded as the last author before the LLM call and that is not rolled back).
- Ingest failure (Chroma failing): the `messages` row exists, no reply is attempted, nothing lands in `world.errors`, and after `setFailing(null)` later messages work.
- A rate-limited message consumes no roll: with `setRandom([0, 0, 0.5, 0])` and likely repliers seeded, the first message is replied to (rolls `0`, `0`), the second is rate-limited, and the third (after the window) must see roll `0.5` and get no reply. Had the rate-limited message consumed a roll, the third would see `0` and be replied to.
- GIF resolution in a reply: response `'haha <gif! cat>'` with Klipy returning a URL → `content === 'haha '` and the first embed's image URL is that URL. With no GIF result the content contains the `<INSERT GIF: ...>` placeholder and there is only the author embed.

**Revive** (`world.ready()`, `world.advance`). Times are US Central (CST, UTC−6, in November); `BASE_TIME` is 12:00 Central.

- Without `ready()`, advancing time never sends anything.
- Fresh start: `ready()` then 48 h with no human message → nothing is sent.
- Day rule: `ready()` and a human message at the same instant T (so checks fall on T + k × 600 000 ms); `advance(3 h)` → nothing (not strictly greater than 3 h); `advance(10 min)` → exactly one `channel.send`.
- Idle time is measured from the message's `createdTimestamp`, not its arrival: a human message emitted with `timestamp: now - 2 h` triggers a revive after 1 h 10 min.
- `ready()` emitted twice starts one interval (one revive, not two).
- A bot-authored message in the channel does not count as activity: it neither re-arms nor delays a revive.
- The revive payload: `content` and `embeds` built like a reply (GIF embeds then author embed); sent with `channel.send`, not as a reply. Pin explicitly: a resolved GIF token becomes an image embed and is removed from the content; an avatar lookup failure still sends, without an icon. Persona is `USERS[floor(roll * length)]` (roll `0.99` → `dave`, `0` → `alice`). The LLM user prompt equals `contextlessInput(persona, name, contents)` with `contents` ⊆ the persona's seeded messages.
- Never twice in a row: after a revive, 48 more hours with no human message → no second revive. A new human message re-arms it.
- After an auto reply the last activity is the bot's: no revive until another human message.
- A human message that is filtered out or loses the probability roll still counts as human activity and restarts the timer from its timestamp.
- Night rule: with the last human message at 21:00 Central, nothing is sent through 09:00 next day (12 h, not strictly greater); the 09:10 check sends one revive (hour 9 is night; more than 12 h).
- Daytime boundary: with the last human message at 23:00 Central, nothing is sent through 09:50; the 10:00 check sends one revive (hour 10 is daytime; more than 3 h). Hours 10 to 22 inclusive are daytime.
- LLM failure during a revive: nothing is sent, nothing throws, and no further attempt is made until a new human message.
- The legacy `guilds.fetch` path (undefined identifier, reached only when `channel.guild` is missing) is deliberately not exercised; spec 02 corrects it.

### Package D: `reply-command.test.js`, `wiring.test.js`

**Reply command** (`world.openReplyCommand`, `makeInteraction`).

- An interaction that is not a message context-menu command, or whose `commandName` is not `reply`, is ignored (no reply, no modal).
- Target not replyable (`'hi'`): `interaction.reply({ content: 'The selected message is not replyable.', flags: MessageFlags.Ephemeral })`; no modal.
- Target in another channel (and replyable): reply `'This command can only be used in the #pa-text channel.'`, ephemeral; no modal. A target that is both unreplyable and in another channel gets the "not replyable" message (that check runs first).
- Modal (assert on the recorded `toJSON()`): `custom_id` `replyModal`; title `Reply using deep pa-text`; a text display whose content is `**Original message from <author>:**\n<transformed content>`; a label `Who should I reply as?` wrapping a string select with `custom_id` `authorSelect`, placeholder `Select an author`, and options: one per user (`label` username, `description` `Reply as <name>`, `value` username) in `USERS` order, then `{ label: 'random', description: 'Reply as a random user', value: 'random' }`.
- `awaitModalSubmit` is called with `{ time: 120000 }`.
- Submit with `author: 'bob'`: first `modalInteraction.reply({ embeds: [thinking] })` where the thinking embed has author name `bob`, the avatar, colour `0x5865F2` and footer text `thinking...`; then `modalInteraction.editReply({ embeds, content })` with GIF embeds followed by the author embed (no footer). One LLM call whose prompt names `bob` and the target's transformed content. The target message's `reply` is not called and nothing goes through `channel.send`.
- Submit with `author: 'random'`: persona comes from likely repliers by roll (`[0]` → first), falling back to `USERS` (`[0, 0.99]` with no repliers → `dave`).
- The target may be authored by a bot or a non-approved user; the command still works.
- Target with `guild: null`: the guild is obtained with `client.guilds.fetch(guildId)` (one entry in `guildFetches`) and the flow completes. The guild lookup happens before the channel check.
- LLM failure after submit: the thinking reply was sent, `editReply` is never called, nothing lands in `world.errors`, and the rate limit is not armed (an auto-reply candidate immediately afterwards with roll 0 is replied to).
- The command does not write the target to `messages`.
- Submit with a different `customId`: no reply, no LLM call.
- `timeout()`: nothing is sent and the handler does not throw.
- A command reply counts as a bot reply for the rate limit: an auto-reply candidate less than 300 000 ms later is not replied to even with `random = 0`.
- A command reply counts as bot activity for revive: `ready()`, human message, command reply, then 48 h → no revive.
- The command ignores the probability roll and the rate limit: it works immediately after an auto reply.

**Wiring.**

- The Discord client is constructed with intents `Guilds`, `GuildMessages`, `MessageContent`, and `login` is called once with the `DISCORD_BOT_TOKEN` value.
- An `OpenAI`-compatible client is constructed with the `DEEPSEEK_API_KEY` value and `baseURL: 'https://api.deepseek.com'`, and every chat request goes to it. Do not pin how many other clients exist (legacy also builds an unused embeddings client that spec 02 removes).
- `GiphyFetch` is constructed with the `GIPHY_API_KEY` value.

## Acceptance

- `npm test` passes against the unmodified legacy source, with every case above implemented as its own test (table rows may be loop-generated subtests).
- No test depends on another test, on wall-clock time, or on network access.
- Each package's final report lists: tests written, any legacy behaviour that differed from this spec (pinned as found), and any harness change made.
