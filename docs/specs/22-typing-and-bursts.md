# Spec 22: Typing indicator and multi-message bursts

**Depends on:** 21. **Blocks:** 23.

## Problem

Replies appear instantly with no typing indicator, and always as a single message, although several members habitually send a thought as two or three short messages in a row.

## Required behaviour

### Clock additions

`clock` gains `clearInterval(handle)` and `sleep(ms) → Promise<void>` (lazy wrappers over the globals in `defaultClock()`; `sleep` uses `clock.setTimeout`). The test harness passes its own `sleep` into `buildContainer` (through `boot.js`): it records the duration in `world.sleeps` and resolves immediately.

### Typing (`src/discord/typing.js`)

`startTyping(channel, { clock, refreshMs, logger }) → { pulse(), stop() }`: calls `channel.sendTyping()` immediately and every `refreshMs` until `stop()`; `pulse()` sends one extra indicator right away (Discord clears the indicator whenever the bot sends a message and otherwise after about 10 s). A rejected `sendTyping` is caught, logged at warn level only the first time per `startTyping`, and otherwise ignored. `stop` is idempotent and clears the interval.

The responder starts typing for triggers `auto`, `chain` and `revive` before building context, pulses before each inter-part sleep, and stops in a `finally`. The `command` trigger does not type (the interaction shows its own placeholder). `typing.enabled: false` disables it.

### Burst tendency

- `messageStore.burstStats({ author, windowMs }) → { samples, rate }`, measured on the raw `messages` table (the corpus filter drops the short messages bursts are made of): `samples` is the number of the author's messages; `rate` is the fraction of them whose very next message in the channel is by the same author within `windowMs`.

  ```sql
  SELECT COUNT(*) AS samples, COALESCE(AVG(is_burst), 0) AS rate FROM (
    SELECT author,
           CASE WHEN LEAD(author) OVER w = author
                 AND LEAD(timestamp) OVER w - timestamp <= ?
                THEN 1.0 ELSE 0.0 END AS is_burst
    FROM messages
    WINDOW w AS (ORDER BY timestamp, id)
  ) WHERE author = ?
  ```

  This is a full scan; it runs at most once per author per `burst.cacheMs`.
- `src/retrieval/burstProfile.js`: `createBurstProfile({ messageStore, config, now })` → `rateFor(author) → number`: `0` when `samples < burst.minSamples`, else `rate`; cached per author for `burst.cacheMs`.

### Prompt section `burst`

Present when `burst.enabled` and `rateFor(persona) >= burst.minRate`. It sits immediately before `avoidRepeats` in the reply prompt, the chain preamble and the revive prompt:

```
This user often sends several short messages in a row instead of one longer message. If that fits here, you may split your response into up to <maxMessages> separate messages by putting <split> on its own line between them. Only split where this user would.
```

The generator gains `burstProfile` as a dependency and puts `burstRate` in the prompt context.

### Post-processing (`src/llm/burst.js`, `src/llm/postProcess.js`, pure)

`splitBurst(raw, { maxMessages, enabled }) → string[]`:

- split on `<split>` (case-insensitive, surrounding whitespace consumed), trim each part, drop empty parts;
- more than `maxMessages` parts → the extra parts are joined onto the last allowed part with newlines;
- `enabled: false` → one part, with every `<split>` marker replaced by a newline;
- no marker → `[raw.trim()]`.

`postProcess(raw, { burst }) → { response, parts }`: split **first**, then `sanitizeResponse` each part (so a model that quotes each part separately is handled), drop parts that are empty after sanitising; `parts` is the resulting list of texts and `response` is `parts.join('\n<split>\n')`. No parts → `Error('LLM returned an empty response')`.

`generator.generateReply` / `generateRevive` now resolve `{ response, parts }` (this replaces the spec 14 single-string sanitising step; a stray `<split>` from a non-bursty persona is still honoured). The subject's `getRAGResponse`/`getRandomResponse` map to `.response`.

`burstDelay(text, { msPerChar, minDelayMs, maxDelayMs })` in `burst.js`: `text.length * msPerChar` clamped to the two bounds.

### Delivery of parts (`src/bot/responder.js`, `src/bot/composer.js`)

- `composer.compose({ persona, target, context })` resolves `{ response, parts: [{ text, content, gifLinks }] }`: one entry per part, each with its own GIF resolution and `truncateForDiscord`; `text` keeps the GIF tokens.
- Part 1 is delivered through the request's `via`. Each later part is delivered through `{ type: 'channel', channel }` for `auto`/`chain`/`revive`, or `{ type: 'followUp', interaction }` for `command` (`interaction.followUp(payload)`; a new `via` type in the delivery adapter, sent with `SAFE_MENTIONS`). Only part 1 can ping the replied user.
- Before each later part: `typing.pulse()` (when typing), then `await clock.sleep(burstDelay(part.text, config.burst))`.
- Every delivered part is recorded in `bot_messages` with `content: part.text` and the same persona, trigger and reference.
- **State timing.** The `respond` request gains `onDelivered()`, called once, right after part 1 is delivered. Handlers move their success updates (`replyPolicy.noteReply(...)`, the second `activity.noteBot()`) into it, so the rate limit is armed before the burst delays and a message arriving mid-burst cannot trigger a second reply. If part 1 fails, `onDelivered` is not called and `respond` rejects as before. If a later part fails, the error is logged, the remaining parts are skipped, and `respond` resolves normally.
- `respond` resolves `{ response, messages }` (all sent messages).

### Chains (amends spec 21)

In `chainBuilder`, consecutive bot messages with the same persona and the same `reference` (the parts of one burst) are one turn: contents joined with newlines, counted once in `botTurns`. When the bot parent is a later part of a burst, the walk continues from the parts' shared `reference`. `botMessageStore.siblings(botMessage) → BotMessage[]` returns the rows sharing persona, reference and trigger within `burst.siblingWindowMs` of it, oldest first (a revive burst has `reference = NULL`; the time window keeps separate revives apart).

## Config

`typing.enabled: true`, `typing.refreshMs: 8000`, `burst.enabled: true` (env `BURSTS`, `'false'` disables), `burst.maxMessages: 3` (integer ≥ 1), `burst.windowMs: 30000`, `burst.minRate: 0.2`, `burst.minSamples: 20`, `burst.cacheMs: 3600000`, `burst.msPerChar: 40`, `burst.minDelayMs: 800`, `burst.maxDelayMs: 4000`, `burst.siblingWindowMs: 60000`.

## Harness change

- Fake channel: `sendTyping()` (counted in `channel.typingCalls`; `channel.failTyping(error)`).
- Fake modal-submit interaction: `followUp(payload)` recorded in `followUps`, resolving to a fake bot message.
- `world.sleeps` (above). `world.llm.hold()` makes the next completion wait and returns a `release()` function; a handler blocked on a held completion is parked (as for a pending modal), so `settle`, `advance` and `emitMessage` still return.
- The fixture personas have fewer than `minSamples` messages unless a test seeds more, so existing prompts contain no burst section.

## Edge cases

- Response `one\n<split>\ntwo` with a bursty persona → a reply with `one`, then a channel message with `two` and its own author embed; `world.sleeps` has one entry within the clamp range; two `bot_messages` rows.
- Response `"one"\n<split>\n"two"` → parts `one` and `two` (quotes removed per part).
- Four parts with `maxMessages: 3` → three messages, the third containing parts 3 and 4 on separate lines.
- Persona below `minRate` or below `minSamples` → no burst section; a stray `<split>` in the response is still honoured.
- `BURSTS=false` → no section; `<split>` becomes a newline in a single message.
- A part consisting only of a GIF token → sent with empty content and the GIF embed; its `bot_messages.content` is the token.
- A part that is empty after sanitising → dropped.
- Second part's send rejects → first stays, error logged, reply state already updated by `onDelivered`.
- A replyable human message emitted between part 1 and part 2 (use a `sleep` hook) with roll 0 → rate-limited, no second reply.
- Typing: one `sendTyping` at the start of an auto reply plus one pulse per later part; none for the command; `sendTyping` rejecting does not prevent the reply; with a held completion and 20 s of advanced time, typing is refreshed twice; after the reply no further `sendTyping` on later ticks.
- Replying to the second message of a burst → a chain with the same persona, in which the burst is one assistant turn with both lines and `botTurns` is 1.
- `burstStats`: author with messages at t, t+10 s, t+5 min → `{ samples: 3, rate: 1/3 }`; unknown author → `{ samples: 0, rate: 0 }`; another author's message in between breaks the burst; equal timestamps are ordered by id.

## Tests

- Unit: `startTyping` (immediate call, refresh, pulse, stop, first-failure-only logging); `burstStats`; `createBurstProfile` (minimum samples, caching, expiry); `splitBurst`; `postProcess` (split before sanitise, empties, error); `burstDelay` clamps; `burst` section and its position in the three prompts; composer parts; responder part delivery, recording, `onDelivered` timing, partial failure; delivery `followUp`; `siblings`; chain builder burst collapsing; config validation.
- Existing tests: generator and composer unit tests adapt to `{ response, parts }`; handler tests adapt to `onDelivered`. Characterization assertions do not change.
- Scenario (`test/scenarios/bursts.test.js`): each edge case above.

## Docs

README: triggers and configuration.

## Acceptance

`npm test` passes; no characterization assertion changes.
