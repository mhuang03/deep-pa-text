# Spec 20: Context for revives

**Depends on:** 17, 19. **Blocks:** none.

## Problem

A revive prompt contains only 50 random messages by the persona, under a system prompt that says "respond to this message" although there is no message. The model has no idea what time it is, how long the channel has been quiet, what was last discussed, or how this person actually opens a conversation.

## Required behaviour

### Conversation starters (`src/storage/messageStore.js`)

`randomStarters({ author, minGapMs, limit }) → string[]`: random contents of the author's filtered messages that began a conversation, meaning the previous message in the channel by anyone, **including messages the corpus filter dropped**, is more than `minGapMs` milliseconds older, or there is none. The gap is therefore measured on the raw `messages` table:

```sql
SELECT f.content
FROM (
  SELECT id, timestamp - LAG(timestamp) OVER (ORDER BY timestamp, id) AS gap
  FROM messages
) g
JOIN filtered_messages f ON f.id = g.id
WHERE f.author = ? AND (g.gap IS NULL OR g.gap > ?)
ORDER BY RANDOM() LIMIT ?
```

This scans the whole `messages` table; that is acceptable a few times a day. The tables hold one channel only.

### Context (`src/context/contextBuilder.js`)

`forRevive({ channel, nowMs }) → Promise<{ transcript, quietMs }>`: fetch the last `revive.transcriptLimit` messages of the channel (`fetchBefore` with no `before`); `transcript` is `buildTranscript` of them with no age cut-off (it may hold fewer entries than fetched, since some are skipped); `quietMs = nowMs - createdTimestamp` of the newest fetched message whether or not it produced an entry, or `null` when nothing was fetched.

### Pure helpers (`src/context/situation.js`)

- `describeLocalTime(nowMs, timeZone) → string`, for example `Thursday 3:10 PM` (`Intl.DateTimeFormat('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit', hour12: true, timeZone })`, assembled as `<weekday> <time>`).
- `describeQuiet(quietMs) → string | null`: `null` for `null`; negative values count as 0; under `ONE_HOUR_MS` → `less than an hour`; under `TWO_DAYS_MS` → `about N hours` with `N = Math.max(1, Math.round(hours))` (`about 1 hour` when N is 1); otherwise `about N days` with `N = Math.round(days)`. The two thresholds are named constants in the module.

### Prompt

`REVIVE_SYSTEM_PROMPT` (in `src/llm/prompts.js`) is derived from `SYSTEM_PROMPT` by two string replacements, so the two cannot drift apart; module load throws if either source segment is not found exactly once:

- the first paragraph (`You are emulating a user on a Discord server. Your task is to respond to this message in a way that is consistent with how the user has responded to messages in the past.`) becomes `You are emulating a user on a Discord server. The channel has gone quiet. Your task is to write the next message this user would send to get conversation going again, in a way that is consistent with how the user has written in the past. It can follow up on the last conversation or bring up something new, as that user would.`
- in the GIF paragraph, `based on the content of the message they received, and based on the search terms that the user has used in the past when responding to similar messages` becomes `based on what you are saying and on the search terms that the user has used in the past`.

(A thrown error at import is an invariant check on two constants, not a side effect.)

`buildRevivePrompt(ctx)` with `ctx = { author, name, examples, starters = [], transcript = [], quietMs = null, nowMs, timeZone, recentBotMessages = [] }`, sections in order, each omitted when it has nothing to say:

1. `identity` (as in spec 17).
2. `situation` (omitted unless `nowMs` is a finite number): `It is <describeLocalTime>.` followed, when `describeQuiet(quietMs)` is non-null, by ` The channel has been quiet for <describeQuiet>.`
3. `lastConversation` (omitted when the transcript is empty): `Here is the end of the last conversation in the channel, oldest first:` newline `formatTranscript(...)`.
4. `starters` (omitted when empty): `Here are messages this user has sent to start a conversation after the channel had been quiet:` newline JSON.
5. `examples`: the legacy sentence `Here are some examples of messages that the user has sent in the past:` newline JSON.
6. `avoidRepeats` (spec 19).

With only `{ author, name, examples }` the output is exactly today's prompt; the subject's `contextlessInput(author, name, examples)` maps to that.

### Wiring

- `reviveTick` passes its `channel` in the `respond` request.
- `responder.respond` with `target === null` calls `contextBuilder.forRevive({ channel, nowMs: now() })` (the responder's injected `now`) and passes the result as `context` to `composer.compose({ persona, target: null, context })`, which calls `generator.generateRevive(persona, context = {})`.
- `generateRevive`: `starters` = `messageStore.randomStarters({ author, minGapMs: config.revive.starterGapMs, limit: config.revive.starterSamples * config.retrieval.overFetchFactor })`, deduplicated by `normalizeForDedup` key and cut to `starterSamples`; `examples` = `retriever.retrieveForRevive(author)` minus anything whose key is already among the starters; prompt built with `nowMs: context.nowMs`, `timeZone: config.context.timeZone`; `chatClient.complete({ system: REVIVE_SYSTEM_PROMPT, user })`. `forRevive` includes `nowMs` in the context it returns. The generator gains `messageStore` as a dependency.
- A failure of `forRevive` or `randomStarters` is logged as a warning and degrades to no context / no starters; the revive is still sent.

## Config

`revive.transcriptLimit: 10`, `revive.starterGapMs: 3600000`, `revive.starterSamples: 20`, `retrieval.reviveSamples: 30` (was 50).

## Edge cases

- Persona with no starters → section omitted.
- Empty channel history or failed fetch → no `lastConversation`, no quiet sentence, but the time sentence is still present; revive still sent.
- First message ever in the table (no previous) counts as a starter.
- A message exactly `minGapMs` after the previous one is not a starter (strictly greater).
- A message that follows, within the gap, a short message the filter dropped (for example `lol`) is not a starter.
- Two raw messages with the same timestamp: order is by id, deterministically.
- The newest fetched message is attachment-only (no transcript entry) → `quietMs` is still measured from it.
- `describeQuiet`: 59 min → `less than an hour`; 60 min → `about 1 hour`; 90 min → `about 2 hours`; 3 h 20 min → `about 3 hours`; 47 h 40 min → `about 48 hours`; 48 h → `about 2 days`; 71 h → `about 3 days`; negative → `less than an hour`.
- Daylight saving: `describeLocalTime` for a July timestamp uses CDT.

## Tests

- Unit: `randomStarters` (gap boundary, first row, dropped messages count for the gap, other authors' rows count, equal timestamps, limit); `describeLocalTime` (winter, summer, midnight); `describeQuiet` (every value above plus `null`); each new section; `REVIVE_SYSTEM_PROMPT` differs from `SYSTEM_PROMPT` only in the two stated places (apply the inverse replacements and compare); `buildRevivePrompt` with minimal input equals the legacy output; `forRevive`; generator revive branch including the degradations.
- Existing tests: assertions pinned to 50 revive samples become 30; revive prompt assertions account for the new sections and the revive system prompt (examples ⊆ the persona's messages still holds).
- Scenario (`test/scenarios/revive-context.test.js`), with the world clock set to a known weekday and time: seeded conversation, then silence → the revive prompt names the weekday and time at the moment of the revive, says how long the channel was quiet, contains the conversation tail, and lists the persona's seeded starters but not their mid-conversation messages in the starters section. Random samples are asserted by set membership.

## Docs

README triggers and prompting sections.

## Acceptance

`npm test` passes; existing tests change only where the revive prompt or sample count requires it.
