# Spec 22: Typing indicator and multi-message bursts

**Depends on:** 21. **Blocks:** 23.

## Problem

Replies appear instantly with no typing indicator, and always as a single message, although several members habitually send a thought as two or three short messages in a row.

## Required behaviour

### Clock additions

`clock` gains `clearInterval(handle)` and `sleep(ms) → Promise<void>` (default: lazy wrappers over the globals). The test harness injects a `sleep` that records the duration in `world.sleeps` and resolves immediately.

### Typing (`src/discord/typing.js`)

`startTyping(channel, { clock, refreshMs, logger }) → stop()`: calls `channel.sendTyping()` immediately and every `refreshMs` until `stop()` is called. A rejected `sendTyping` is logged at warn level once per `startTyping` and otherwise ignored. `stop` is idempotent.

The responder starts typing for triggers `auto`, `chain` and `revive` before building context, and stops it in a `finally` after the last part is delivered or on failure. The `command` trigger does not type (the interaction shows its own placeholder). `typing.enabled: false` disables it.

### Burst tendency (`src/retrieval/burstProfile.js`, `messageStore`)

- `messageStore.burstRate({ author, windowMs }) → number`: the fraction of the author's filtered messages that are followed, as the very next filtered message in the channel, by another message from the same author within `windowMs`; `0` when the author has no messages.

  ```sql
  SELECT AVG(is_burst) AS rate FROM (
    SELECT author,
           CASE WHEN LEAD(author) OVER (ORDER BY timestamp) = author
                 AND LEAD(timestamp) OVER (ORDER BY timestamp) - timestamp <= ?
                THEN 1.0 ELSE 0.0 END AS is_burst
    FROM filtered_messages
  ) WHERE author = ?
  ```
- `createBurstProfile({ messageStore, config, now })` → `rateFor(author) → number`, cached per author for `burst.cacheMs`.

### Prompt section `burst`

Added to the reply, chain and revive prompts (before `avoidRepeats`) when `burst.enabled` and `rateFor(persona) >= burst.minRate`:

```
This user often sends several short messages in a row instead of one longer message. If that fits here, you may split your response into up to <maxMessages> separate messages by putting <split> on its own line between them. Only split where this user would.
```

### Splitting (`src/llm/burst.js`, pure)

`splitBurst(response, { maxMessages, enabled }) → string[]`:

- split on `<split>` (case-insensitive, surrounding whitespace consumed), trim each part, drop empty parts;
- more than `maxMessages` parts → the extra parts are joined onto the last allowed part with newlines;
- `enabled: false` → one part, with every `<split>` marker replaced by a newline;
- no marker → `[response]`. Always returns at least one part for non-empty input.

`sanitizeResponse` (spec 14) runs before splitting on the whole response and again on each part.

### Delivery of parts (`src/bot/responder.js`)

- `composer.compose` returns `{ response, parts: [{ text, content, gifLinks }] }`: one entry per burst part, each with its own GIF resolution and `truncateForDiscord`.
- Part 1 is delivered through the request's `via`. Each later part is delivered through `{ type: 'channel', channel }` for `auto`/`chain`/`revive`, or `{ type: 'followUp', interaction }` for `command` (`interaction.followUp(payload)`; new `via` type in the delivery adapter).
- Before each later part: `await clock.sleep(burstDelay(part.text, config.burst))` with `burstDelay = clamp(text.length * msPerChar, minDelayMs, maxDelayMs)`.
- Every delivered part is recorded in `bot_messages` with `content: part.text` and the same persona, trigger and reference.
- If part 1 fails, `respond` rejects as before. If a later part fails, the error is logged, the remaining parts are skipped, and `respond` resolves normally.
- `respond` resolves `{ response, messages }` (all sent messages).

## Config

`typing.enabled: true`, `typing.refreshMs: 8000`, `burst.enabled: true` (env `BURSTS`, `'false'` disables), `burst.maxMessages: 3`, `burst.windowMs: 30000`, `burst.minRate: 0.2`, `burst.cacheMs: 3600000`, `burst.msPerChar: 40`, `burst.minDelayMs: 800`, `burst.maxDelayMs: 4000`.

## Harness change

- Fake channel: `sendTyping()` (counted in `channel.typingCalls`; `channel.failTyping(error)`).
- Fake modal-submit interaction: `followUp(payload)` recorded in `followUps`, resolving to a fake bot message.
- `mock.timers` also mocks `setTimeout` is **not** needed: `sleep` is injected; `world.sleeps` lists requested delays.

## Edge cases

- Response `one\n<split>\ntwo` with a bursty persona → a reply with `one`, then a channel message with `two` and its own author embed; `world.sleeps` has one entry within the clamp range; two `bot_messages` rows.
- Four parts with `maxMessages: 3` → three messages, the third containing parts 3 and 4 on separate lines.
- Persona below `minRate` → no burst section in the prompt; a stray `<split>` in the response is still honoured.
- `BURSTS=false` → no section; `<split>` becomes a newline in a single message.
- A part consisting only of a GIF token → sent with empty content and the GIF embed.
- A part that is empty after sanitising → dropped.
- Second part's send rejects → first stays, error logged, reply time still updated.
- Typing: one `sendTyping` at the start of an auto reply; none for the command; `sendTyping` rejecting does not prevent the reply; with a 20 s generation (advance timers while the LLM fake is held) typing is refreshed.
- Replying to the second message of a burst starts a chain with the same persona (both parts are in `bot_messages`).
- `burstRate`: author with messages at t, t+10 s, t+5 min → 1/3.

## Tests

- Unit: `startTyping` (immediate call, refresh, stop, failure); `burstRate` (pairs inside/outside the window, interleaved authors, last message, empty); `createBurstProfile` caching and expiry; `splitBurst` (table above, case-insensitivity); `burstDelay` clamps; `burst` section; responder part delivery, recording, partial failure; delivery `followUp`.
- Characterization updates: none expected except that auto-reply and revive tests may assert `channel.typingCalls`; existing assertions stay. The LLM fake needs a "hold" control for the refresh test (`world.llm.hold()` returning a release function).
- Scenario (`test/scenarios/bursts.test.js`): each edge case above.

## Docs

README: triggers and configuration.

## Acceptance

`npm test` passes; no existing characterization assertion changes.
