# Spec 37: Mention replies, and no limits on manual engagement

**Depends on:** 30, 35. **Blocks:** none.

## Why

Pinging the bot does nothing today: the mention is stripped like any unknown mention and the message goes through the normal 10% roll. The maintainer wants a ping to summon a reply.

Maintainer decisions:

- A message that mentions the bot gets a guaranteed reply from the automatically chosen best reply author (the same selection auto replies use).
- **Nothing users manually choose to engage with is limited or capped.** That covers mention replies, reply chains and the `reply` command. This reverses the chain and command limits of specs 21 and 30 (audit findings A19 and A20). The cost of every such reply is one LLM call and a few embedding and vector calls, with no bound other than how often people ask.

## Part 1: Remove limits on manual engagement

- **Chains.** A reply to a bot message whose chain can be built is always answered. Removed: the per-thread cap and decay (`chain.fullDepth`, `chain.decay`, `chain.maxBotTurns`), the per-user cooldown and window throttle (`chain.userCooldownMs`, `chain.maxPerWindow`, `chain.windowMs`), and the one-at-a-time rule (`chain-busy`). `src/bot/chainPolicy.js` is deleted. `chain.enabled`, `chain.maxContextTurns` and `chain.maxWalkSteps` stay (they shape the prompt, not whether a reply is sent).
- **Command.** `src/bot/commandLimiter.js` and the `command` configuration section are deleted, with the two refusal messages. The command is answered every time.
- Unchanged: a manual reply still arms the rate limit for **auto** replies (`replyPolicy.noteReply({ resetMisses: false })`), does not count as the bot speaking last, and is not blocked by the auto-reply in-flight hold, cooldown or a running conversation.

The chain log line becomes `    [CHAIN: <persona>, <botTurns> bot turns]`.

## Part 2: Mention replies

### Detection (`src/text/botMention.js`, pure)

- `mentionsUser(content, userId) → boolean`: the content contains `<@userId>` or `<@!userId>`. A falsy `userId` or content → `false`. Role mentions, `@everyone` and the automatic mention Discord adds to a reply do not count: only a mention written in the message text does.
- `stripUserMention(content, userId) → string`: every such mention removed, whitespace runs collapsed, trimmed.

### Flow (`src/bot/handlers/messageMention.js`)

In the message handler, after ingest and after the chain check (a reply to a bot message is a chain even if it also pings the bot), before the random auto-reply path:

1. Skip unless `mention.enabled` and `mentionsUser(message.content, client.user?.id)`.
2. **Target.** `own = messageFilter.filterForChain({ ...record, content: stripUserMention(record.content, botId) })` (the chain filter skips the minimum length, so `@bot why` is answerable).
   - `own` non-null → the target is `own`.
   - Otherwise the ping carries no usable text and points at another message:
     - if the message is a Discord reply, the referenced message: `messageStore.getRaw(record.reference)`; when that is unknown, `message.fetchReference()` converted with `toMessageRecord` (a failed fetch counts as none);
     - else the newest visible human message before this one: `messageStore.previousRaw({ before: record.timestamp, excludeId: record.id })` (new).
     The candidate is passed through `messageFilter.filterForChain`; a deleted or unusable candidate, or none, means there is nothing to answer: log `    [MENTION: nothing to reply to]` and stop. The message does not fall through to the random path.
3. **Persona.** `personaSelector.pickReplier(target)`: the weighted likely repliers for the target, never the target's author, with the usual random fallback.
4. **Respond.** `responder.respond({ trigger: TRIGGERS.MENTION, persona, target, guild, channel, via: { type: 'reply', message }, onDelivered })`. The reply is addressed to the message that pinged the bot, also when the target is another message. `onDelivered` calls `replyPolicy.noteReply({ resetMisses: false })`.
5. Failures propagate to the handler boundary and are logged; a delivery failure arms the auto-reply rate limit as for other replies (the shared `respondTo` helper). No cooldown is applied to mentions.

`TRIGGERS` gains `MENTION: 'mention'`; the failure label is `mention reply`. `restoreState` adds it to the reply triggers (rate limit) and not to the natural triggers (it does not count as the bot speaking last).

`messageStore.previousRaw({ before, excludeId }) → { id, author, content, timestamp, reference } | null`: the newest row of `messages` with `deleted_at IS NULL`, `timestamp <= before` and `id != excludeId`, ordered by `timestamp DESC, id DESC`, with revision content applied as `getRaw` does.

The handler gets `client` (for `client.user.id`).

### Corpus

Unchanged: the pinging message is ingested like any message. Its stored corpus text already has the bot mention removed by the existing mention transformer when the bot is not in the ping cache.

## Config

`mention.enabled: true` (env `MENTION_REPLIES`, strict boolean). Removed: `chain.fullDepth`, `chain.decay`, `chain.maxBotTurns`, `chain.userCooldownMs`, `chain.maxPerWindow`, `chain.windowMs`, and the whole `command` section.

## Edge cases

- `<@bot> what do we think about this` with roll 0.99 and inside the rate-limit window → answered; the prompt's target text is `what do we think about this`; the persona is not the author.
- `<@!bot> why` → answered (short text allowed).
- A bare `<@bot>` after someone's message → the reply answers that previous message and is addressed to the ping.
- A bare `<@bot>` written as a Discord reply to an older human message → answers that older message.
- A bare ping whose referenced message is not stored → fetched from Discord; a failed fetch → `nothing to reply to`.
- A bare ping as the first message ever, or after only filtered-out or deleted messages → `nothing to reply to`, no LLM call.
- A reply to a bot message that also pings the bot → a chain reply by that persona, one reply only.
- With `CHAIN_REPLIES=false`, a reply to a bot message that pings the bot → a mention reply.
- `MENTION_REPLIES=false` → the message is treated as before (random path).
- A message that only has the automatic reply mention (replying to the bot's embed-mode message without a written ping) is not a mention.
- A mention in another channel or from a bot → ignored, as all such messages are.
- A mention while a conversation is running, or while an auto reply is in flight → answered.
- After a mention reply, an unrelated message one minute later is rate-limited for auto replies; a revive is still due on the human's schedule.
- Ten mentions in a row from one user → ten replies. Ten replies in a row to bot messages → ten chain replies, including in a thread with more than eight bot messages. The command twice within a second by the same user → both answered.
- A restart after a mention reply restores the auto-reply rate limit from it.

## Tests

- Unit: `mentionsUser`, `stripUserMention` (both mention forms, several mentions, other users' mentions kept, empty id); `previousRaw` (ordering, deleted rows, exclusion, revisions); the mention handler (each target rule, persona, request, `nothing to reply to`, disabled); message handler order (chain before mention before random); `chainReply` without a policy; reply command without a limiter; `restoreState`; config (new key, removed keys, strict boolean); `formatFailure` label.
- Scenario (`test/scenarios/mentions.test.js`): each edge case above. `test/scenarios/reply-control.test.js` and `chains.test.js`: the limit tests are replaced by tests that many chain replies and repeated commands are all answered.
- Deleted with their modules: `chainPolicy.test.js`, `commandLimiter.test.js`.
- Harness: fake messages expose nothing new (the handler reads `message.content`); `world.discord.client.user.id` is the bot id.

## Docs

README: triggers table (mention row; chain and command rows without limits), a short note that manual engagement is unlimited and what that costs, configuration reference (`MENTION_REPLIES`, removed keys). Spec index.

## Acceptance

`npm test` passes.

## Part 3: Reply link for command replies in webhook mode

Added at the maintainer's request. In webhook mode an auto, chain or mention reply starts with a small jump link to the message it answers (spec 23), but a `reply` command answer did not, so nothing showed which message it was about.

- The command passes the selected message with its delivery: `via: { type: 'interaction', interaction, replyTo: <target message> }`.
- The webhook delivery adds the link line for `via.type === 'reply'` (from `via.message`) and for `via.type === 'interaction'` (from `via.replyTo`), when `discord.webhookReplyLink` is on and the message has a `url`. Later burst parts (follow-ups) carry no link, as for other replies.
- The stored `bot_messages` content has no link line, as before. Embed mode is unchanged.
- Tests: unit (interaction with and without `replyTo`, setting off); scenario (command in webhook mode starts with the link to the selected message; a burst links only its first part).
