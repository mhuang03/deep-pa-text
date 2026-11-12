# Spec 20: Context for revives

**Depends on:** 17, 19. **Blocks:** none.

## Problem

A revive prompt contains only 50 random messages by the persona, under a system prompt that says "respond to this message" although there is no message. The model has no idea what time it is, how long the channel has been quiet, what was last discussed, or how this person actually opens a conversation.

## Required behaviour

### Conversation starters (`src/storage/messageStore.js`)

`randomStarters({ author, minGapMs, limit }) → string[]`: random contents of the author's filtered messages that began a conversation, meaning the previous filtered message in the channel (any author) is more than `minGapMs` older, or there is none. Computed with a window function:

```sql
SELECT content FROM (
  SELECT author, content, timestamp - LAG(timestamp) OVER (ORDER BY timestamp) AS gap
  FROM filtered_messages
) WHERE author = ? AND (gap IS NULL OR gap > ?)
ORDER BY RANDOM() LIMIT ?
```

### Context (`src/context/contextBuilder.js`)

`forRevive({ channel, nowMs }) → Promise<{ transcript, quietMs }>`: the last `revive.transcriptLimit` messages of the channel (`fetchBefore` with no `before`), built with `buildTranscript` and no age cut-off; `quietMs = nowMs - last entry timestamp`, or `null` when the transcript is empty.

### Pure helpers (`src/context/situation.js`)

- `describeLocalTime(nowMs, timeZone) → string`, for example `Thursday 3:10 PM` (`en-US` weekday and 12-hour time).
- `describeQuiet(quietMs) → string | null`: `null` for `null`; under 1 h → `less than an hour`; under 48 h → `about N hours` (rounded, `about 1 hour` for one); otherwise `about N days`.

### Prompt

`REVIVE_SYSTEM_PROMPT` (new constant in `src/llm/prompts.js`) is `SYSTEM_PROMPT` with two changes:

- first paragraph replaced by: `You are emulating a user on a Discord server. The channel has gone quiet. Your task is to write the next message this user would send to get conversation going again, in a way that is consistent with how the user has written in the past. It can follow up on the last conversation or bring up something new, as that user would.`
- in the GIF paragraph, `based on the content of the message they received, and based on the search terms that the user has used in the past when responding to similar messages` becomes `based on what you are saying and on the search terms that the user has used in the past`.

`buildRevivePrompt(ctx)` with `ctx = { author, name, examples, starters, transcript, quietMs, nowMs, timeZone, recentBotMessages }`, sections in order:

1. `identity` (as in spec 17).
2. `situation`: `It is <describeLocalTime>.` followed, when `quietMs` is known, by ` The channel has been quiet for <describeQuiet>.`
3. `lastConversation` (omitted when the transcript is empty): `Here is the end of the last conversation in the channel, oldest first:` newline `formatTranscript(...)`.
4. `starters` (omitted when empty): `Here are messages this user has sent to start a conversation after the channel had been quiet:` newline JSON.
5. `examples`: the legacy sentence `Here are some examples of messages that the user has sent in the past:` newline JSON.
6. `avoidRepeats` (spec 19).

### Pipeline

- `responder.respond` for a revive calls `contextBuilder.forRevive({ channel, nowMs: now() })` and passes the context to `generator.generateRevive(persona, context)`.
- The generator fetches `randomStarters` (deduplicated by normalised key, at most `revive.starterSamples`), `retrieveForRevive(author)` with `retrieval.reviveSamples` lowered to 30, removes from `examples` anything already in `starters`, and calls `chatClient.complete({ system: REVIVE_SYSTEM_PROMPT, user })`.

## Config

`revive.transcriptLimit: 10`, `revive.starterGapMs: 3600000`, `revive.starterSamples: 20`, `retrieval.reviveSamples: 30` (was 50).

## Edge cases

- Persona with no starters → section omitted.
- Empty channel history or failed fetch → no `lastConversation`, no quiet sentence; revive still sent.
- First message ever in the table (no previous) counts as a starter.
- A message exactly `minGapMs` after the previous one is not a starter (strictly greater).
- The transcript's last entry may be a bot message; `quietMs` still measures from it.
- Quiet for 3 h 20 min → `about 3 hours`; 50 h → `about 2 days`.
- Daylight saving: `describeLocalTime` for a July timestamp uses CDT.

## Tests

- Unit: `randomStarters` (gap boundary, first row, other authors' rows count for the gap, limit); `describeLocalTime`; `describeQuiet` boundaries (59 min, 60 min, 89 min, 47 h, 48 h, `null`); each new section; `REVIVE_SYSTEM_PROMPT` differs from `SYSTEM_PROMPT` only in the two stated places (assert by replacing them back); `forRevive`.
- Characterization updates: `revive.test.js` prompt assertions (the user prompt now has the new sections; examples ⊆ persona's messages still holds; system prompt is the revive variant); `generation.test.js` for `getRandomResponse`. State the change in the commit.
- Scenario (`test/scenarios/revive-context.test.js`): seeded conversation, then silence → the revive prompt names the weekday and time at the moment of the revive, says how long the channel was quiet, contains the conversation tail, and lists the persona's seeded starters but not their mid-conversation messages in the starters section.

## Docs

README triggers and prompting sections.

## Acceptance

`npm test` passes; only the listed characterization tests change.
