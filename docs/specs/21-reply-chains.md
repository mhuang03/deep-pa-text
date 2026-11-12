# Spec 21: Reply chains on bot messages

**Depends on:** 15, 17, 19. **Blocks:** 22, 24.

## Problem

When someone replies to a bot message, the bot treats it like any other message: a 10% chance of a reply, from a freshly chosen persona with no memory of the exchange. Replying to "bob" should get an answer from "bob" that follows the thread.

## Required behaviour

### Finding the bot parent (`messageCreate` handler)

For an incoming message with a reference, before ingest:

1. `parent = botMessageStore.getById(record.reference)`.
2. If there is no stored row **and** `messageStore.getRaw(record.reference)` is also `null` (the referenced message is unknown to us, so it may be a bot message from before spec 15): `message.fetchReference()` (a failure is ignored), then `botMessageResolver.resolve(fetched)`; if that resolves, `parent = { id: record.reference, persona, content, reference: null, fallback: true }`.
3. Otherwise there is no bot parent. No Discord fetch is made for replies to known human messages or for messages without a reference.

`messageStore.getRaw(id) → { id, author, content, timestamp, reference } | null` (new, from the `messages` table).

### Ingest

A human reply to a bot message must not be linked in the corpus to an unrelated earlier message. `ingestService.recordMessage(record, { repliesToBot = false } = {})`: when `repliesToBot` is true, `insertFiltered(filtered, { inferReference: false })` stores `reference = NULL` and no reply-embedding row is written. The handler passes `repliesToBot: Boolean(parent)`. This rule applies whether or not chain replies are enabled.

### Building the chain (`src/context/chainBuilder.js`)

`createChainBuilder({ botMessageStore, messageStore, messageFilter, userDirectory, config })` → `build(target, parent) → Chain | null` (`target` is the filtered incoming record, `parent` the bot parent from above).

**Chain:** `{ persona, turns: Turn[], botTurns: number }`; **Turn:** `{ speaker, content, isPersona: boolean }`.

1. `persona = parent.persona`; if it is not in the user directory → `null`.
2. Walk upward starting at the parent, following `reference`, for at most `chain.maxWalkSteps` steps, never visiting an id twice:
   - a bot message (store row, or the fallback parent) → `{ speaker: its persona, content: its content, isPersona: its persona === persona }`; count it in `botTurns`;
   - otherwise `messageStore.getRaw(id)` → `{ speaker: author, content: messageFilter.transform(content), isPersona: false }`; a turn whose transformed content is empty is dropped but the walk continues through its reference;
   - id not found, no reference, or a fallback parent (its ancestry is unknown) → stop.
3. `turns` = the collected turns reversed (oldest first), cut to the **last** `chain.maxContextTurns - 1`, followed by the incoming turn `{ speaker: target.author, content: target.content, isPersona: false }`, which is always present. `botTurns` counts over the whole walk, not just the kept turns.

### Policy (`src/bot/chainPolicy.js`)

`createChainPolicy({ config, random })` → `{ decide({ botTurns }), begin(), end() }`. `decide` returns `{ reply, reason, chance?, roll? }`:

- `!chain.enabled` → `{ reply: false, reason: 'chain-disabled' }`;
- a chain reply is already being generated (between `begin()` and `end()`) → `{ reply: false, reason: 'chain-busy' }` (one chain reply at a time, so rapid replies cannot fan out into parallel LLM calls);
- `botTurns >= chain.maxBotTurns` → `{ reply: false, reason: 'chain-limit' }`;
- `chance = botTurns <= chain.fullDepth ? 1 : chain.decay ** (botTurns - chain.fullDepth)`;
- `chance >= 1` → reply without rolling; otherwise one roll, reply when `roll <= chance`.

`botTurns` is at least 1 (the bot message being replied to). With defaults the first three replies in a thread are guaranteed (`botTurns` 1 to 3), the next come with 50%, 25%, 12.5% and 6.25%, and a thread never holds more than eight bot messages.

### Message filter

`messageFilter.filterForChain(record)`: like `filterAnyAuthor` but also skipping the predicate named `minLength`, so short replies such as `why` continue a chain.

### Handler flow (`messageCreate`)

After the channel/bot check and `activity.noteHuman`:

1. Find the bot parent (above); `await ingest.recordMessage(record, { repliesToBot: Boolean(parent) })`.
2. If `parent`: `chainTarget = messageFilter.filterForChain(record)`; `chain = chainTarget && chainBuilder.build(chainTarget, parent)`.
3. If `chain`:
   - `decision = chainPolicy.decide(chain)`; not `reply` → log the reason and **return** (the message does not fall through to the random policy; a different persona butting into the thread would be wrong);
   - `chainPolicy.begin()`; `activity.noteBot()`; `await responder.respond({ trigger: TRIGGERS.CHAIN, persona: chain.persona, target: chainTarget, chain, channel, guild, via: { type: 'reply', message } })`; `chainPolicy.end()` in a `finally`;
   - on success `replyPolicy.noteReply({ resetMisses: false })` and `activity.noteBot()`; failure handling as for auto replies (spec 12).
   The global rate limit and probability do not apply to chain replies.
4. Otherwise (no parent, unknown persona, or empty chain target) continue with the existing flow (`filterAnyAuthor`, `replyPolicy.decide`, `pickReplier`).

The log line for a chain decision states the persona, `botTurns`, and the reason.

### Responder and generator

- The `respond` request gains an optional `chain`. When present, the responder does **not** call `contextBuilder.forReply` (the thread is the context; no history fetch) and passes `context = { chain }` to `composer.compose`.
- `generator.generateReply(persona, record, context)` with `context.chain`:
  - retrieval as usual, with `queryText = buildQueryText(record, chain.turns.slice(0, -1), ...)` (turns are shape-compatible with transcript entries; the incoming turn is excluded so it is not embedded twice);
  - the user preamble is built from the chain section list: `identity`, `replyExamples`, `similarExamples`, `gifExamples`, `otherExamples`, `frequentPhrases`, `avoidRepeats`, `thread`. There is no `transcript` or `target` section. `thread` is: `You are in a reply thread. Your own earlier messages in it appear as assistant turns; other people's messages are prefixed with their username. Write your next message in the thread.`
  - `chatClient.complete({ system: SYSTEM_PROMPT, user: preamble, turns: chain.turns })`.

### Chat turns (`src/llm/chatTurns.js`, pure; `src/llm/chatClient.js`)

`buildChatMessages({ system, user, turns = [] }) → messages`:

- `[{ role: 'system', content: system }, { role: 'user', content: user }]`, then one message per turn: persona turns as `{ role: 'assistant', content }`, others as `{ role: 'user', content: '<speaker>: <content>' }`;
- consecutive messages with the same role are merged, joined by a blank line (so the preamble merges with a leading user turn, and the list always starts system, user and ends with a user message).

`chatClient.complete({ system, user, turns = [] })` sends `buildChatMessages(...)`; with no turns the request is unchanged.

### Reply command

When the target is a bot message (`botMessageResolver.resolve(targetMessage)` non-null): the target record uses `author: persona` and `content` from the resolver; the modal's persona select marks that persona's option as default. Everything else is unchanged.

## Config

`chain.enabled: true` (env `CHAIN_REPLIES`, `'false'` disables), `chain.fullDepth: 3`, `chain.decay: 0.5` (in `(0, 1)`), `chain.maxBotTurns: 8`, `chain.maxContextTurns: 12` (≥ 2), `chain.maxWalkSteps: 50`.

## Harness change

Fake messages gain `fetchReference()` resolving to the history message with the referenced id (rejecting when absent), and count calls in `message.referenceFetches`.

## Accepted behaviour

Anyone can keep a thread going up to the cap, and the first three replies are guaranteed regardless of the rate limit. One chain reply is generated at a time. That is the intended trade-off for a small private server.

## Edge cases

- Reply to a bot message → answered by the same persona even with `random = 0.99` and inside the rate-limit window.
- Reply `why` (3 characters) to a bot message → answered. The same text not replying to the bot → not replyable, as before.
- Thread bot → human → bot → human: turns alternate assistant/user; the first user message contains the preamble and, if the thread root is a human message, that root.
- Thread rooted at a revive (bot first): messages are system, user (preamble), assistant, user.
- Two different humans in a row → merged into one user message with both prefixed lines.
- A bot message of another persona inside the thread → a user turn prefixed with that persona's name.
- Persona removed from `users.json` → not a chain; normal flow.
- `botTurns = 4`: chance 0.5; roll 0.4 replies, 0.6 does not and nothing else replies.
- A 20-message alternating thread: `botTurns` is 10 (counted over the whole walk) → `chain-limit`; the prompt would have held only the last 12 turns.
- A second reply to the bot while a chain reply is being generated → `chain-busy`, no LLM call.
- Chain reply updates the reply time (an unrelated message 1 minute later is rate-limited) but not the miss counter.
- Parent only resolvable through the embed fallback → chain of two turns; one `fetchReference` call. A reply to a human message that is in `messages` → no `fetchReference` call.
- Short incoming message: the embedded query text is the previous turns' text plus the message, with the message appearing once.
- `CHAIN_REPLIES=false` → no chain replies; the corpus rule for replies to bot messages still applies.
- Stored reference of the human reply is `NULL` and `message_reply_embeddings` has no row for it.
- Reference cycle in stored data (defensive) → the walk terminates.

## Tests

- Unit: `chainBuilder` (each walk rule, context cap vs whole-walk count, incoming turn always last, fallback parent, unknown persona, skipped empty turns, cycle guard); `chainPolicy` (table of `botTurns` 0–8 with rolls, busy state); `filterForChain`; `buildChatMessages` (merging, role mapping, leading assistant, ends with user); `chatClient` with turns; generator chain branch (sections, query text); ingest `repliesToBot`; `getRaw`; modal default option; handler branches.
- Scenario (`test/scenarios/chains.test.js`): every edge case above, asserting the LLM request `messages` array and the persona on the reply embed.
- Existing tests: none should change; the flow is untouched for messages that are not replies to bot messages. If one fails, the implementation is wrong.

## Docs

README triggers table: add the chain trigger and `CHAIN_REPLIES`.

## Acceptance

`npm test` passes with no change to existing test assertions.
