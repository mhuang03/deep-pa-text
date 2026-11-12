# Spec 21: Reply chains on bot messages

**Depends on:** 15, 16, 17, 19. **Blocks:** 22, 24.

## Problem

When someone replies to a bot message, the bot treats it like any other message: a 10% chance of a reply, from a freshly chosen persona with no memory of the exchange. Replying to "bob" should get an answer from "bob" that follows the thread.

## Required behaviour

### Detection (`src/context/chainBuilder.js`)

`createChainBuilder({ botMessageStore, messageStore, messageFilter, userDirectory, config })` → `build(record, { fallbackParent = null } = {}) → Chain | null`.

**Chain:** `{ persona, turns: Turn[], botTurns: number }`; **Turn:** `{ speaker, content, isPersona: boolean }`, oldest first, the last turn being the incoming message.

1. `parent = botMessageStore.getById(record.reference) ?? fallbackParent`. No reference or no parent → `null`.
2. `persona = parent.persona`; if it is not in the user directory → `null`.
3. Walk upward from the parent, at most `chain.maxContextTurns` turns in total:
   - a bot message → `{ speaker: its persona, content: its content, isPersona: its persona === persona }`, continue with its `reference`;
   - otherwise `messageStore.getRaw(id)` → `{ speaker: author, content: messageFilter.transform(content), isPersona: false }`, continue with its `reference`; turns whose transformed content is empty are skipped but the walk continues;
   - id not found, or no reference → stop.
4. `botTurns` = number of bot-message turns collected.

`messageStore.getRaw(id) → MessageRecord | null` (new, from the `messages` table).

The fallback parent covers bot messages sent before spec 15: when the store has no row for `record.reference`, the handler fetches the referenced Discord message (`message.fetchReference()`, failures ignored), runs `botMessageResolver.resolve`, and passes `{ persona, content, reference: null }` if it resolves. The walk stops after a fallback parent.

### Policy (`src/bot/chainPolicy.js`)

`createChainPolicy({ config, random })` → `decide({ botTurns }) → { reply, reason, chance, roll? }`:

- `!chain.enabled` → `{ reply: false, reason: 'chain-disabled' }`;
- `botTurns >= chain.maxBotTurns` → `{ reply: false, reason: 'chain-limit' }`;
- `chance = botTurns <= chain.fullDepth ? 1 : chain.decay ** (botTurns - chain.fullDepth)`;
- `chance >= 1` → reply without rolling; otherwise one roll, reply when `roll <= chance`.

`botTurns` is at least 1 (the bot message being replied to). With defaults the first three replies in a thread are guaranteed (`botTurns` 1 to 3), the next come with 50%, 25%, 12.5% and 6.25%, and a thread never holds more than eight bot messages.

### Message filter

`messageFilter.filterForChain(record)`: like `filterAnyAuthor` but also skipping the predicate named `minLength`, so short replies such as `why` continue a chain.

### Handler (`messageCreate`), after ingest

1. `chainTarget = messageFilter.filterForChain(record)`; if it is non-null and the record has a reference, `chain = chainBuilder.build(chainTarget, { fallbackParent })`.
2. If `chain`:
   - `decision = chainPolicy.decide(chain)`; not `reply` → log and **return** (the message does not fall through to the random policy; a different persona butting into the thread would be wrong);
   - `activity.noteBot()`; `responder.respond({ trigger: 'chain', persona: chain.persona, target: chainTarget, channel, guild, via: reply, context: { chain } })`;
   - on success `replyPolicy.noteReply({ resetMisses: false })` and `activity.noteBot()`.
   The global rate limit and probability do not apply to chain replies.
3. Otherwise continue with the existing flow (`filterAnyAuthor`, `replyPolicy.decide`, `pickReplier`).

### Prompt (`src/llm/chatTurns.js`, pure; `src/llm/chatClient.js`)

`buildChatMessages({ system, preamble, turns }) → messages`:

- `[{ role: 'system', content: system }, { role: 'user', content: preamble }]`, then one message per turn: persona turns as `{ role: 'assistant', content }`, others as `{ role: 'user', content: '<speaker>: <content>' }`;
- consecutive messages with the same role are merged, joined by a blank line (so the preamble merges with a leading user turn, and the list always starts system, user).

`chatClient.complete({ system, user, turns = [] })` sends `buildChatMessages(...)`; with no turns the request is unchanged.

`generator.generateReply(persona, record, context)` with `context.chain`: retrieval and the reply prompt sections are built as usual, with `buildQueryText` given the chain turns (in place of the transcript) as preceding context; the `target` section is replaced by the `thread` section: `You are in a reply thread. Your own earlier messages in it appear as assistant turns; other people's messages are prefixed with their username. Write your next message in the thread.` The chain turns are passed as `turns`.

### Ingest

A human reply to a bot message must not be linked to an unrelated earlier message: `ingestService.recordMessage` calls `insertFiltered(filtered, { inferReference: false })` when `botMessageStore.getById(record.reference)` exists, so the stored reference is `NULL` and no reply-embedding row is written.

### Reply command

When the target is a bot message (`botMessageResolver.resolve(targetMessage)` non-null): the target record uses `author: persona` and `content` from the resolver; the modal's persona select marks that persona's option as default. Everything else is unchanged.

## Config

`chain.enabled: true` (env `CHAIN_REPLIES`, `'false'` disables), `chain.fullDepth: 3`, `chain.decay: 0.5`, `chain.maxBotTurns: 8`, `chain.maxContextTurns: 12`.

## Harness change

Fake messages gain `fetchReference()` resolving to the history message with the referenced id (rejecting when absent).

## Edge cases

- Reply to a bot message → answered by the same persona even with `random = 0.99` and inside the rate-limit window.
- Reply `why` (3 characters) to a bot message → answered. The same text not replying to the bot → not replyable, as before.
- Thread bot → human → bot → human: turns alternate assistant/user; the first user message contains the preamble and, if the thread root is a human message, that root.
- Thread rooted at a revive (bot first): messages are system, user (preamble), assistant, user.
- Two different humans in a row → merged into one user message with both prefixed lines.
- A bot message of another persona inside the thread → a user turn prefixed with that persona's name.
- Persona removed from `users.json` → not a chain; normal flow.
- Fifth bot turn pending (`botTurns = 4`): chance 0.5; roll 0.4 replies, 0.6 does not and nothing else replies.
- `botTurns = 8` → never.
- Chain reply updates the reply time (an unrelated message 1 minute later is rate-limited) but not the miss counter.
- Parent only resolvable through the embed fallback → chain of two turns.
- `CHAIN_REPLIES=false` → previous behaviour.
- Stored reference of the human reply is `NULL` and `message_reply_embeddings` has no row for it.

## Tests

- Unit: `chainBuilder` (each walk rule, depth cap, fallback parent, unknown persona, skipped empty turns); `chainPolicy` (table of `botTurns` 0–8 with rolls); `filterForChain`; `buildChatMessages` (merging, role mapping, leading assistant); `chatClient` with turns; generator chain branch; ingest `inferReference`; modal default option.
- Scenario (`test/scenarios/chains.test.js`): every edge case above, asserting the LLM request `messages` array and the persona on the reply embed.
- Characterization: no existing test should change; the legacy flow is untouched for messages that are not replies to bot messages. If one changes, stop and report.

## Docs

README triggers table: add the chain trigger and `CHAIN_REPLIES`.

## Acceptance

`npm test` passes.
