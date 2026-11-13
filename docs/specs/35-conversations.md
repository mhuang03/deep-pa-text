# Spec 35: Scripted conversations

**Depends on:** 34. **Blocks:** none.

## Why

A revive is one message from one persona. Sometimes the bot should instead play out a short conversation between several personas, so a quiet channel reads as if the group picked something up among themselves.

Decisions already made with the maintainer:

- When a revive is due there is a configurable chance (10%) that it becomes a conversation, provided the last conversation was at least a configurable interval (24 h) ago.
- A conversation has 2 to 5 personas and 3 to 6 messages, both drawn at random within configurable bounds, with every persona speaking at least once. A burst counts as one message.
- The topic is chosen by an LLM call from topic candidates (spec 34), the tail of the last real conversation, the time, recent bot conversation topics, and past conversation openers.
- Personas are the people whose history fits the topic.
- The conversation is generated one message at a time with retrieval for each speaker, and each request includes the messages generated so far.
- Messages are sent 5 to 30 seconds apart (random).
- **The personas talk over real people.** A human posting mid-conversation does not stop or change it.
- The same persona never speaks twice in a row.
- A conversation is abandoned on shutdown and not resumed after a restart.

## Trigger (`src/bot/handlers/reviveTick.js`, `src/bot/conversation/conversationPolicy.js`)

When the revive tick has decided a revive is due (all existing checks unchanged), it asks `conversationPolicy.decide()` before sending the revive:

- `conversation.enabled` false → `{ start: false, reason: 'disabled' }`;
- the newest visible bot message with trigger `conversation` is younger than `conversation.minIntervalMs` → `{ start: false, reason: 'too-soon' }` (no roll);
- otherwise one roll: `roll <= conversation.chance` → `{ start: true, roll }`, else `{ start: false, reason: 'roll', roll }`.

The time of the last conversation is read from `botMessageStore.newest({ triggers: [CONVERSATION] })`, so it survives restarts and needs no new state.

`start: true` → the tick runs the conversation (below). If **planning** fails (no topic, too few personas, the topic call fails), the reason is logged and a normal revive is sent in the same tick. Once the first turn is being generated there is no fallback: a failure there is a failed revive (activity undone, revive failure cooldown), exactly as today.

`TRIGGERS` gains `CONVERSATION: 'conversation'`.

A tick that finds a conversation still running returns immediately (a `running` flag in the tick's closure).

## Planning (`src/bot/conversation/conversationPlanner.js`)

`createConversationPlanner({ topicSource, conversationStore, contextBuilder, chatClient, vectorStore, messageStore, userDirectory, random, clock, config, logger })` → `plan({ channel }) → Promise<Plan | { failed: reason }>`.

**Plan:** `{ id, topicId, topic, premise, personas: string[], turns: string[] }` (`turns[i]` is the persona speaking turn `i`).

1. **Candidates.** `recent = conversationStore.recent({ limit: conversation.avoidRecentTopics })`; `topicSource.candidates({ limit: conversation.topicCandidates, excludeTopicIds: recent topic ids, excludeLabels: recent topics })`. None → `{ failed: 'no-topics' }`.
2. **Context.** `contextBuilder.forRevive({ channel, nowMs })` for the tail of the last real conversation and the quiet time (a failure degrades to none); `topicSource.openers({ limit: conversation.openerSamples })`.
3. **Topic call.** `chatClient.complete({ system: CONVERSATION_TOPIC_SYSTEM_PROMPT, user })`. The user prompt is assembled from sections, each omitted when empty:
   - `It is <describeLocalTime>.` and, when known, ` The channel has been quiet for <describeQuiet>.`
   - `Here is the end of the last conversation in the channel, oldest first:` + the transcript;
   - `These topics were used recently. Do not choose them again:` + JSON list of recent topics;
   - `Candidate topics:` then for each candidate, numbered from 1: `<n>. <label>: <summary>` (or `<n>. (unnamed)` for a neighbourhood candidate) followed by `Sample messages:` + JSON of its samples;
   - `Messages that have restarted this chat after a quiet spell:` + JSON of the openers.
   The answer is parsed with `parseJsonObject` and must have an integer `choice` naming a candidate and non-empty strings `topic` and `premise` (cut to `conversation.maxTopicChars` and `conversation.maxPremiseChars`). An invalid answer is retried up to `conversation.planRetries` times; then, or when the call throws, `{ failed: 'topic-call' }`.
4. **Personas.** `count = randomInt(minPersonas, maxPersonas)`. Draw without replacement from the chosen candidate's authors, each draw weighted by `share × max(persona.minRecencyWeight, 0.5 ** (age / persona.recencyHalfLifeMs))` (one roll per draw). If the candidate has fewer authors than `count`, top up from history: `vectorStore.query('messages', { text: '<topic>. <premise>', limit: conversation.personaHits })`, hidden hits removed, `weighAuthors` (spec 16) over authors not yet chosen, drawn the same way. Stop at `count` or when nobody is left. Fewer than `minPersonas` in the end → `{ failed: 'too-few-personas' }`. A vector failure during the top-up is logged and treated as no further authors.
5. **Turns** (`src/bot/conversation/turnOrder.js`, pure). `messages = randomInt(max(minMessages, personas.length), maxMessages)`; `planTurns({ personas, count: messages, random }) → string[]`:
   - every persona gets one turn; the remaining `count − personas.length` turns are handed out one at a time to a random persona whose total would not exceed `ceil(count / 2)` (the largest share that still allows no adjacent repeats);
   - the turns are then arranged at random with no persona twice in a row: repeatedly pick the next speaker among personas with turns left other than the previous speaker, weighted by turns left; if only the previous speaker has turns left, start again, at most `ARRANGE_ATTEMPTS` (50) times, then fall back to a deterministic interleave (most turns left first, never the previous speaker).
6. `id = 'c' + <UTC YYYYMMDDHHMMSS>`; `conversationStore.insert(...)`; return the plan.

`randomInt(min, max)` is `min + Math.floor(random() * (max − min + 1))`.

`CONVERSATION_TOPIC_SYSTEM_PROMPT` (`src/bot/conversation/conversationPrompts.js`):

```
You are planning a short group chat between members of a private Discord server. It will be written afterwards in their own voices. Choose what they would most plausibly talk about right now.

Reply with a single JSON object and nothing else:
{"choice": <number of the candidate you chose>, "topic": "<at most 8 words>", "premise": "<one or two sentences: what prompts the conversation and the angle it takes>"}

Prefer a candidate that fits the time and what was said recently, without repeating a recently used topic. You may sharpen a candidate into something more specific, but stay within what its sample messages show these people actually talk about.
```

## Running (`src/bot/conversation/conversationRunner.js`)

`createConversationRunner({ responder, replyPolicy, activity, lifecycle, random, clock, config, logger })` → `run({ plan, channel, guild }) → Promise<{ delivered: number }>`.

- Before the first turn the runner takes `hold = replyPolicy.claim()` (new: a public claim on the in-flight counter that `decide()` already honours) and releases it in a `finally`. While it is held no auto reply is started, so the bot does not answer bystanders in the middle of its own conversation. Chain replies (a direct reply to a bot message) are unaffected.
- For each turn `i`, in order:
  1. stop if `lifecycle.isShuttingDown()`;
  2. `request = { trigger: TRIGGERS.CONVERSATION, persona: plan.turns[i], target: previous, conversation: { id: plan.id, topic, premise, participants: plan.personas, turns: said, isLast: i === last }, guild, channel, via: { type: 'channel', channel }, beforeDeliver, onDelivered }`, where `previous` is `null` for the opener and otherwise `{ id: <first message id of the previous turn>, author: <its persona>, content: <its text>, timestamp: <its send time> }`, and `said` is the list of delivered turns `{ speaker, content, timestamp }`;
  3. `await responder.respond(request)`;
  4. append the turn to `said`.
- **Spacing.** For every turn after the first, `delay = randomInt(minDelayMs, maxDelayMs)` is drawn when the previous turn has been delivered. Generation of the next turn starts at once; `beforeDeliver` (new hook, below) waits for whatever is left of the delay, so the gap between two turns is the delay or the generation time, whichever is longer. The typing indicator shows during the gap.
- **State.** Each turn's `onDelivered` calls `activity.noteBot()` and `replyPolicy.noteReply({ resetMisses: false })`. The revive tick's existing `undo` applies only if the first turn was never delivered.
- **Humans.** Messages from people during the conversation are ingested as usual and otherwise ignored by the runner: they are not added to `said`, and the remaining turns are generated and sent as planned.
- **Failure.** If a turn fails after at least one was delivered, the error is logged, the conversation ends there and `run` resolves. If the first turn fails, `run` rejects (the tick treats it as a failed revive).

### Responder changes (`src/bot/responder.js` and its parts)

- `respond(request)` awaits `request.beforeDeliver?.()` after generation and before the first part is delivered (still inside the typing indicator).
- `resolver.contextFor(request)` returns `{ conversation: request.conversation }` when the request has one (no history fetch).
- The recorder stores `conversation_id` (from `request.conversation?.id`) with every part. `reference` is `target?.id` as today, so every turn after the opener references the previous turn.
- `composer.compose` routes a context with `conversation` to `generator.generateConversationTurn(persona, target, conversation)`.

### Generating a turn (`src/llm/conversationGenerator.js`)

`generateConversationTurn(persona, target, conversation) → Promise<{ response, parts }>`:

- **Retrieval** for the speaker with the existing retriever: `retrieveForReply(persona, record, { queryText })`. For the opener, `record = { id: conversation.id, author: '', content: '<topic>. <premise>', timestamp: now }` and `queryText` is that content. For later turns, `record = target` and `queryText = buildQueryText(target, conversation.turns, config.retrieval)`.
- **Prompt** `buildConversationPrompt(ctx)` (`src/llm/prompts.js`), sections in order: `identity`; `conversationBrief`; `transcript` (the turns so far, formatted with `formatTranscript`; omitted for the opener); `target` (the previous turn, as in a reply; omitted for the opener); `replyExamples`, `similarExamples`, `gifExamples`, `otherExamples`, `frequentPhrases`; `burst`; `avoidRepeats`.
- `conversationBrief` text:

  ```
  You are taking part in a conversation in the channel between <participants, comma separated>. It is about: <topic>. <premise>
  ```

  followed by `You are starting it. Write the message that opens the conversation.` for the opener, or `Write your next message in the conversation. Stay with the topic unless the conversation has naturally moved on.` otherwise, and, on the last turn, ` Nobody replies after this message, so do not ask the others a question.`
- **System prompt:** `REVIVE_SYSTEM_PROMPT` for the opener, `SYSTEM_PROMPT` for later turns.
- Post-processing, bursts, GIF handling and sanitising are the existing ones (`complete`).

### Chains on conversation turns (amends spec 21, `src/context/chainBuilder.js`)

A human who replies to a conversation turn gets a chain reply from that turn's persona; the walk follows the references back through the earlier turns, so the model sees the conversation up to that point. Conversation turns are scripted, not answers in the thread, so bot messages with trigger `conversation` do **not** count towards `botTurns`.

### Restart (amends spec 28, `src/bot/stateRestore.js`)

`CONVERSATION` is added to both trigger lists: a conversation counts as the bot speaking last (it is naturally spawned) and its last turn restores the rate limit.

## Storage (additive migrations; `src/storage/conversationStore.js`)

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  topic_id   INTEGER,                 -- topic bank id, NULL for a neighbourhood topic
  topic      TEXT NOT NULL,
  premise    TEXT NOT NULL,
  personas   TEXT NOT NULL,           -- JSON array of usernames
  turns      TEXT NOT NULL            -- JSON array: the planned speaker of each turn
)
addColumn bot_messages.conversation_id TEXT
CREATE INDEX IF NOT EXISTS idx_bot_messages_conversation ON bot_messages (conversation_id)
```

`createConversationStore({ db })` → `insert(plan, startedAt)` (`ON CONFLICT DO NOTHING`), `recent({ limit }) → [{ id, startedAt, topicId, topic }]` newest first, `getById(id)`.

`botMessageStore.insert` accepts `conversationId` (default `null`). A conversation row with no delivered turn can exist (the first turn failed); timing never reads this table, only `bot_messages`.

`npm run inspect` gains a section listing the latest conversations (start time, topic, personas, planned and delivered turn counts), tolerant of the table or column being absent.

## Config

```
conversation:
  enabled true (env CONVERSATIONS)     chance 0.1 (0 to 1)             minIntervalMs 86400000 (≥ 0)
  minPersonas 2 (≥ 2)                  maxPersonas 5 (≥ minPersonas)
  minMessages 3 (≥ 1)                  maxMessages 6 (≥ minMessages and ≥ maxPersonas)
  minDelayMs 5000 (≥ 0)                maxDelayMs 30000 (≥ minDelayMs)
  topicCandidates 5 (≥ 1)              openerSamples 6 (≥ 0)           avoidRecentTopics 10 (≥ 0)
  planRetries 1 (≥ 0)                  personaHits 60 (≥ 1)            maxTopicChars 80   maxPremiseChars 300
```

Validated by `assertConversation` as in spec 27. `CONVERSATIONS` is a strict boolean.

The test fixtures set `CONVERSATIONS: 'false'` in their default environment, so every existing test keeps its random-roll order and LLM call counts; conversation tests enable it explicitly.

## Random rolls, in order

For a tick where a conversation is possible: (1) the conversation roll; if it starts: (2) one roll per topic candidate drawn; (3) persona count; (4) one roll per persona drawn; (5) message count; (6) the rolls of `planTurns`; then per turn: (7) the delay before it (not for the opener), and any GIF picks inside the turn as today. If planning fails after some rolls, the fallback revive then makes its usual persona roll.

## Edge cases

- `CONVERSATIONS=false` → never; the revive path makes exactly the rolls it makes today.
- A conversation 23 h ago → `too-soon`, no roll, normal revive. 25 h ago with roll 0.05 → conversation; with roll 0.5 → normal revive.
- Empty topic bank and a corpus with no qualifying neighbourhood → `no-topics`, logged, normal revive sent in the same tick.
- The topic call returns prose around the JSON → parsed. Invalid twice → `topic-call`, normal revive. `choice` out of range → invalid.
- The chosen topic has one directory author → topped up from history; nobody else found → `too-few-personas`, normal revive.
- Two users in the directory → conversations have exactly two personas, strictly alternating.
- Five personas and six messages → everyone speaks, one persona twice, never consecutively.
- `planTurns` over many random seeds: length is right, every persona appears, no adjacent repeats, no persona above `ceil(count / 2)`.
- A full run of four turns: four channel messages by the planned personas in order; each `bot_messages` row has trigger `conversation`, the conversation id, and a reference to the previous turn (the opener's is `NULL`); the LLM request for turn 3 contains turns 1 and 2 in its transcript and names the topic; three delays, each within the bounds.
- Generation of a turn takes longer than its delay → it is sent as soon as it is ready, with no extra wait.
- A turn that is a two-part burst → two messages by the same persona (the burst's own short delay between them), counted as one turn; the next turn references the burst's first message.
- A human posts between turns 2 and 3 with roll 0 → the message is stored, gets no auto reply, and turn 3 is generated without it and sent.
- A human **replies** to turn 2 during or after the conversation → a chain reply as turn 2's persona, whose request carries turns 1 and 2 as earlier turns and is guaranteed (`botTurns` 0).
- Turn 3 of 5 fails to generate → turns 1 and 2 stay, an error is logged, the claim is released, later messages get auto replies again, and the 24 h interval counts from turn 2.
- The opener fails → nothing sent; the revive failure cooldown applies; no fallback revive in that tick.
- Shutdown during the wait before turn 3 → no further turns; nothing is resumed after the restart; after the restart the conversation's last turn restores the rate limit and counts as the bot speaking last.
- The revive check fires again while a conversation is running → ignored.
- After a conversation no revive is due until a human speaks (the bot spoke last), and no auto reply for 5 minutes after the last turn.
- Webhook display: every turn goes through the webhook under its persona's name, with no reply-link line.
- A deleted conversation turn (soft delete) is skipped like any deleted bot message in a later chain walk.

## Tests

- Unit: `conversationPolicy` (each reason, the interval boundary, roll boundary, no roll when too soon or disabled); `randomInt`; `planTurns` (properties above over 500 seeded runs, two personas, fallback interleave); planner (candidate exclusion from recent conversations, prompt sections present and omitted, parsing and retries, persona draws with scripted rolls, top-up, each failure reason, the stored row); runner (order, requests, spacing arithmetic with a fake clock, hold and release on every path, per-turn state updates, failure after delivery, failure of the opener, shutdown, humans ignored); `beforeDeliver` hook; context resolver and composer routing; recorder stores the conversation id; `generateConversationTurn` (opener and later turn: retrieval inputs, sections, system prompt, last-turn sentence); `buildConversationPrompt` full-string equality; chain builder ignores conversation turns in `botTurns`; `restoreState` with a conversation as the newest bot message; `conversationStore`; `botMessageStore.insert` with a conversation id; migrations on an existing database; `assertConversation`; inspector section.
- Scenario (`test/scenarios/conversations.test.js`), with `CONVERSATIONS: 'true'`, a seeded topic bank and scripted rolls and LLM answers: every edge case above through the world.
- Harness: the default test environment gains `CONVERSATIONS: 'false'`; no other change is expected (the LLM fake already takes a function of the request, `world.sleeps` records delays, `world.llm.hold` parks a generation).
- Existing tests: none change their assertions. `nonDestructive`, `layering`, `sizeLimits`, `coverageMap`, `unusedExports` pass.

## Docs

README: the conversation trigger (when it happens, what it does, talk-over behaviour, the reply hold, chains on turns), configuration table, storage (`conversations`, `bot_messages.conversation_id`), a note that webhook display suits conversations better than embeds, and that `npm run topics` should be run before conversations are expected to be good.

## Acceptance

`npm test` passes with no existing assertion changed.

## Amendments after review (these override the text above where they differ)

1. **Trigger constants move down a level.** `TRIGGERS` moves to `src/util/triggers.js` (level 0) and every importer is updated; `src/bot/triggers.js` is removed. `src/context/chainBuilder.js` imports it from there.
2. **Policy.** `createConversationPolicy({ botMessageStore, random, now, config })`. A conversation starts when `roll < conversation.chance`. `chance` of 0 is treated like disabled: no roll.
3. **Revive tick structure.** In order:
   1. the tick sets its `running` flag synchronously on entry and clears it in a `finally`; a tick that finds it set returns at once;
   2. the existing cooldown and `shouldRevive` checks;
   3. `conversationPolicy.decide()`; if it does not start, the existing revive runs unchanged;
   4. the channel and guild are fetched once, before planning, and used by both the conversation and a fallback revive;
   5. one `activity.noteBot()` is taken (one `undo`), and one `hold = replyPolicy.claim()` (a new public method returning the idempotent release function), **before planning**, so no auto reply starts during the topic call; `hold()` is called in a `finally`;
   6. planning; on `{ failed }` the reason is logged and the normal revive is sent inside the same `try`, reusing the same `undo` and `delivered` flag;
   7. otherwise `runner.run({ plan, channel, guild, onFirstDelivered })`, where `onFirstDelivered` sets the tick's `delivered` flag. If `run` rejects (the opener failed), nothing was delivered and the tick undoes the activity and arms the revive failure cooldown.
   The conversation dependencies of `createReviveTick` are required; the existing revive-tick unit tests are updated to supply them.
4. **What `respond` returns.** `respond` also returns `delivered: [{ message, text }]`, one entry per part actually sent. For the runner a turn is: `content` = the delivered texts joined with a newline, `id` = `delivered[0].message.id`, `timestamp` = `delivered[0].message.createdTimestamp ?? clock.now()`.
5. **Spacing and shutdown.** `beforeDeliver` computes `remaining = Math.max(0, delay − (clock.now() − drawnAt))` and calls `clock.sleep(remaining)` only when `remaining > 0`. After the wait it checks `lifecycle.isShuttingDown()`; if so it throws an error marked `isConversationAborted`, which the responder lets through and the runner treats as a quiet stop (no error log; `run` resolves). The runner also checks before generating each turn. A shutdown during a long wait may still log the lifecycle's "abandoning" warning after the 10 s grace period; accepted.
6. **Turn index.** Additive column `bot_messages.turn_index INTEGER` (an `addColumn` descriptor after the existing ones), written by the recorder from `request.conversation.turnIndex`; the inspector counts delivered turns as distinct `turn_index` values. `botMessageStore.insert` accepts `conversationId` and `turnIndex`.
7. **Chain walk.** A soft-deleted conversation turn ends the walk, like any deleted bot message today (the edge case above saying it is skipped is wrong).
8. **Query text.** Later turns use `buildQueryText(target, conversation.turns.slice(0, -1), config.retrieval)`, because `turns` already ends with the target.
9. **Prompts.**
   - **Opener.** Sections: `identity`; `conversationBrief`; `situation` (time and quiet duration, from `contextBuilder.forRevive`, passed in the request's conversation context); `starters` (this persona's own, as in a revive); `topicExamples` (new): `Here are messages this user has sent about similar things:` + JSON of the `similar` bucket from `retrieveForReply(persona, record, { queryText })`; `pastExamples` (the revive examples from `retrieveForRevive`, minus anything already shown); `burst`; `avoidRepeats`. The reply-example and GIF sections are not used for the opener (their wording assumes a received message).
   - **Opener system prompt.** `CONVERSATION_OPENER_SYSTEM_PROMPT` is derived from `REVIVE_SYSTEM_PROMPT` by replacing the sentence `It can follow up on the last conversation or bring up something new, as that user would.` with `It opens a conversation on the topic you are given.`; module load throws if that sentence is not found exactly once.
   - **Later turns.** The `transcript` section holds `turns.slice(0, -1)` and the `target` section holds the last turn, so nothing appears twice.
   - **Brief.** `conversationBrief` is: `You are taking part in a conversation in the channel between <participants>. It is about: <topic>. <premise>` then `Only these people take part; do not address anyone else.` then, for the opener, `You are starting it. Write the message that opens the conversation. Do not greet the channel.`, and for later turns `Write your next message. React to what was just said, stay with the topic unless the conversation has naturally moved on, and do not end every message with a question.` followed by `<n> more messages follow yours.` or, on the last turn, `Nobody replies after this message, so do not ask the others a question.`
10. **Persona draws.** `age` for an author is `now − authors[].newestTimestamp` from the candidate. Recent-topic exclusion uses topic ids only (`excludeTopicIds`).
11. **Random picks, exactly.** `randomInt` lives in `src/util/random.js`. A uniform pick from a list is `list[Math.floor(roll × list.length)]`; a weighted pick is the first entry whose cumulative weight exceeds `roll × total` (as `pickWeighted` does). In `planTurns` the personas are in the order they were drawn; the extra turns are handed out by uniform picks among the personas still under the cap; the arrangement uses weighted picks and, because a restart consumes further rolls, its roll count varies. The deterministic interleave cannot be reached with the default ranges and is unit-tested by calling it directly. `conversation.arrangeAttempts` (50, integer ≥ 1) replaces the `ARRANGE_ATTEMPTS` constant.
12. **Module split** (each within the size limits): `src/bot/conversation/conversationPolicy.js`, `topicCall.js` (prompt assembly, parsing, retries), `personaDraw.js`, `turnOrder.js`, `conversationPlanner.js` (orchestration and the stored row), `conversationRunner.js`, `conversationPrompts.js`; `src/llm/conversationGenerator.js`.
13. **Container.** The planner and runner are built where `lifecycle` exists (with the handlers); they receive `chatClient`, `topicSource`, `conversationStore`, `contextBuilder`, `vectorStore`, `messageStore`, `userDirectory`, `responder`, `replyPolicy`, `activity`, `lifecycle`, `clock`, `config`, `logger`. The container exposes `conversationStore`, `conversationPlanner`, `conversationRunner` and `conversationPolicy`.
14. **Configuration.** All `conversation.*` counts and millisecond values are integers. The cross-field rules (`maxPersonas ≥ minPersonas`, `maxMessages ≥ minMessages`, `maxMessages ≥ maxPersonas`, `maxDelayMs ≥ minDelayMs`) are checked by a dedicated `assertConversation`.
15. **Tests.**
    - Existing tests that pin an exact trigger list, the `bot_messages` column list, the table list, the row shape returned by `botMessageStore.getById`, the container's public keys, or the revive tick's dependencies are updated for the additions. No behaviour they assert changes.
    - The reply hold is tested while the opener's generation is held (`world.llm.hold`): a replyable human message with roll 0 gets no auto reply and no LLM call. (After a delivered turn the rate limit already blocks auto replies, so that case does not exercise the hold.)
    - `world.sleeps` also records burst delays and shutdown polling; conversation tests select the turn delays by their range.
    - Scenario tests seed the topic bank through `world.container.topicStore`.
