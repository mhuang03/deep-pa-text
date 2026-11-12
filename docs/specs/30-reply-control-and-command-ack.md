# Spec 30: Reply control, cost limits and command acknowledgement

**Depends on:** 29. **Blocks:** 31. **Audit findings:** A5, A8, A11, A12, A13, A14, A16, A19, A20, A37, A43, A48, A49, A50, A65.

## Problem

- The rate limit is armed only when the first part of a reply is delivered. Two messages a few seconds apart both pass the limit and both roll while the first reply is still being generated, so the bot answers twice.
- When the LLM or retrieval is down, nothing is armed at all: every message that wins the roll starts its own multi-minute chain of LLM requests.
- A failed reply or revive leaves the activity tracker saying the bot spoke last, which blocks revives until a human speaks.
- Chain replies and command replies have no limit: one member can make the bot generate and post without bound.
- With `CHAIN_REPLIES=false`, a reply to a bot message gets no answer at all instead of being treated as a normal message.
- The reply command does member lookups and, for `random`, an embedding and vector query before acknowledging the modal submission. If that takes more than Discord's 3 seconds the interaction fails for the user.
- The modal throws with more than 24 users, or when the target message is very long.
- A reply fails outright if its target message was deleted while the reply was being generated.

## Required behaviour

### Reply policy (`src/bot/replyPolicy.js`)

State: `replyTime`, `misses`, `inFlight`, `cooldownUntil`.

`decide()`, in this order:

1. `override` → `{ reply: true, reason: 'override' }` and the slot is claimed (as below).
2. rate-limited → `{ reply: false, reason: 'rate-limited' }`.
3. `inFlight` → `{ reply: false, reason: 'in-flight' }`.
4. `now() < cooldownUntil` → `{ reply: false, reason: 'cooldown' }`.
5. roll, as today. An accepted roll **claims the slot**: `inFlight = true`.

Cases 2 to 4 consume no roll and count no miss.

- `release()`: `inFlight = false`. The handler calls it in a `finally` around the whole reply attempt.
- `noteFailure()`: `cooldownUntil = now() + reply.failureCooldownMs`. Called when a reply attempt fails **before anything was delivered** (generation, retrieval, context or persona selection failed). A delivery failure keeps arming the normal rate limit (spec 12).
- `noteReply`, `restore` unchanged.

### Activity rollback (`src/bot/activityTracker.js`)

`snapshot() → state` and `restore(state)` (the latter from spec 28). The auto-reply path and the revive tick take a snapshot before `activity.noteBot()` and restore it when the attempt ends without a delivered message. A failed attempt therefore no longer blocks revives.

### Revive failure cooldown (`src/bot/handlers/reviveTick.js`)

After a failed revive attempt, no new attempt is made for `revive.failureCooldownMs`, even though the restored activity state would allow one. Without this, an LLM outage would cause one failed attempt per check.

### Chain limits (`src/bot/chainPolicy.js`)

`decide({ botTurns, userId })` gains, after the `chain-busy` check and before the per-thread rules:

- per-user cooldown: the same user had a chain reply accepted less than `chain.userCooldownMs` ago → `{ reply: false, reason: 'chain-user-cooldown' }`;
- global window: `chain.maxPerWindow` chain replies were accepted within the last `chain.windowMs` → `{ reply: false, reason: 'chain-throttled' }`.

Acceptances are recorded in `begin({ userId })`. The handler passes `message.author.id`.

`chain.enabled: false`: `decide` is not consulted; a reply to a bot message is handled by the normal flow (filter, rate limit, roll, persona selection), exactly as before chains existed. The corpus rule for replies to bot messages still applies.

### Command limits (`src/bot/commandLimiter.js`)

`createCommandLimiter({ config, now })` → `check(userId) → { allowed: true } | { allowed: false, reason: 'cooldown' | 'busy' }`, `begin(userId)`, `end()`:

- `cooldown`: this user started a command reply less than `command.userCooldownMs` ago;
- `busy`: `command.maxConcurrent` command replies are in progress.

The handler checks when the command is invoked, before showing the modal, and answers a refusal with an ephemeral message (`COMMAND_COOLDOWN_MESSAGE` = `You are using this too quickly. Try again in a moment.`, `COMMAND_BUSY_MESSAGE` = `The bot is busy with other replies. Try again in a moment.`). `begin` is called when a modal submission is accepted, `end` in a `finally`.

### Acknowledge first (`src/bot/handlers/replyCommand.js`, delivery adapters)

After the modal submission is received:

1. `await modalInteraction.deferReply(delivery.deferOptions())` immediately. The embed delivery returns `{}` (public); the webhook delivery returns `{ flags: MessageFlags.Ephemeral }`.
2. Choose the persona (this may embed and query), then `await modalInteraction.editReply(await delivery.placeholder({ persona, guild }))`.
3. `responder.respond(...)` as today (final content through `editReply`).
4. Any failure after step 1 → the existing best-effort failure notice through `editReply`.

Nothing slow happens between receiving the submission and step 1. Before the modal is shown, the handler only filters the target, reads stores and (rarely) fetches the guild.

### Modal limits (`src/discord/replyModal.js`)

- The persona select holds at most 24 users plus `random` (`MODAL_MAX_USERS = 24`, Discord allows 25 options). With more users, the list is the default persona (when the target is a bot message) followed by the directory order, cut to 24.
- The original-message preview is cut to `discord.modalPreviewChars` code points with `…`.

### Replies survive a deleted target (`src/discord/delivery.js`)

Embed-mode replies are sent with `failIfNotExists: false`, so Discord posts the message as a normal channel message when the target no longer exists.

### Retry on empty output (`src/llm/generator.js`)

When post-processing yields no parts (the model produced only quotes or markers), the generator requests a new completion, up to `llm.emptyRetries` extra times in total (shared with the chat client's empty-completion retries per attempt is **not** required: this is a separate, outer counter), then throws `LLM returned an empty response`.

## Config

`reply.failureCooldownMs: 60000`, `revive.failureCooldownMs: 1800000`, `chain.userCooldownMs: 10000`, `chain.maxPerWindow: 6`, `chain.windowMs: 600000`, `command.userCooldownMs: 30000`, `command.maxConcurrent: 2`, `discord.modalPreviewChars: 1000`. All non-negative; counts are integers ≥ 1.

## Harness change

Fake modal-submit interaction: `deferReply(options)` (recorded in `deferrals`; `failDefer(error)`); `editReply` may be called several times (already recorded in order).

## Edge cases

- Two replyable messages 2 s apart with roll 0 while the LLM is held → one LLM call, one reply; the second message logs `in-flight` and consumes no roll.
- A reply attempt whose generation fails → `release` runs; a message 1 s later with roll 0 logs `cooldown`; 60 s later it is replied to. The miss counter is unchanged throughout.
- Retrieval (Chroma) failure mid-reply → same cooldown path.
- Delivery failure → normal rate limit, no failure cooldown (unchanged).
- Failed auto reply (generation) → activity is the human's again: a revive fires 3 h after that human message.
- Failed revive → activity restored; the next check 10 minutes later makes no attempt; the first check after 30 minutes does.
- Seven chain replies requested within 10 minutes across different threads → six answered, the seventh `chain-throttled`.
- The same user replying to bot messages 3 s apart → the second `chain-user-cooldown`; another user at that moment is answered.
- `CHAIN_REPLIES=false`, reply to a bot message with roll 0 → answered through the normal flow by a selected persona; with roll 0.99 → not answered; stored reference `NULL` either way.
- Command: a second invocation by the same user within 30 s → ephemeral cooldown message, no modal; three users at once → the third gets the busy message.
- Command with `random` and a held embedding → `deferReply` has already been called before the embedding is requested (assert call order); when the embedding fails → failure notice through `editReply`.
- `deferReply` itself rejects → logged, nothing else sent, limiter released.
- 30 users in the directory → the modal builds with 25 options; the default persona is among them.
- Target message of 5000 characters → the modal builds; the preview is 1000 characters plus `…`.
- Target deleted during generation (embed mode) → the reply payload carries `failIfNotExists: false`.
- Model returns `""` then a real answer → one reply, two completions.

## Tests

- Unit: `replyPolicy` (order of checks, claim on accept and on override, `release`, cooldown boundaries, no roll or miss in the blocked states); `activity.snapshot/restore`; revive cooldown; `chainPolicy` limits (window sliding, per-user, recorded only on `begin`); `commandLimiter`; reply-command step order; `buildReplyModal` with 24, 25 and 30 users and long content; delivery `failIfNotExists` and `deferOptions`; generator outer retry.
- Scenario (`test/scenarios/reply-control.test.js`): every edge case above, including a chain-path delivery failure arming the rate limit (A65).
- Existing tests: characterization tests that pin "LLM failure: no rate limit armed" and "no revive after an LLM failure" change to the new behaviour (cooldown; revive allowed after rollback, subject to the revive cooldown); command tests expect `deferReply` then `editReply` for the placeholder instead of `reply`; the `chain-disabled` test expects the normal flow.

## Docs

README: triggers (in-flight guard, cooldowns, chain and command limits, behaviour with chains disabled), configuration table.

## Acceptance

`npm test` passes; existing assertions change only as listed.

## Amendments after review (these override the text above where they differ)

1. **Claim token.** `decide()` returns `{ reply: true, reason, release }` when it accepts; `release` is a closure that frees that claim and is idempotent. In-flight is a counter, so an `override` claim and a normal claim do not clear each other. Only the handler that received `reply: true` calls `release` (in a `finally`). There is no separate `release()` method. The chain path does not claim.
2. **`noteFailure`** is called by the auto-reply path for any failure whose stage is not delivery, including a failed `pickReplier`. Chain and command failures do not call it.
3. **Activity rollback.** `activity.noteBot()` returns an `undo()` function. `undo` restores the state from before that `noteBot` **only if nothing has changed the tracker since** (a version counter); otherwise it does nothing. There is no `snapshot()`. Edge case: a human message that arrives during a failing generation keeps its timestamp after the failure.
4. **Revive cooldown** state lives in the closure of `createReviveTick` (not persisted; a restart clears it). Any failed attempt counts, including a delivery failure.
5. **Chains disabled.** The handler checks `config.chain.enabled` before building a chain; when it is false, no chain is built and `chainPolicy.decide` is not called. The `chain-disabled` reason is removed.
6. **Command limiter.** `begin(userId)` re-checks and claims atomically and returns `{ allowed, reason }`; `end()` is called only after a successful `begin`. The check before the modal is a courtesy. A refusal at submission is answered with an ephemeral `modalInteraction.reply` and no `deferReply`. Both maps prune entries older than their window on every check.
7. **Before the modal** the handler does no network call: the guild lookup (`client.guilds.fetch` when `message.guild` is missing) moves after `deferReply`.
8. **Placeholder.** The payload passed to `editReply` has no `flags` (the ephemeral flag is set by `deferReply`). `deferOptions()` exists on both delivery adapters.
9. **Modal default.** The default persona is used only if it is in the user directory.
10. **Empty output retry.** Only an empty result from post-processing is retried, up to `llm.postProcessRetries: 1` extra completions per generation. Post-processing signals it with an error marked `isEmptyOutput: true`; an exhausted chat client (its own empty-completion retries) is not retried again.
11. **Config validation** for the new keys follows spec 27 (`chain.windowMs > 0`; `chain.maxPerWindow`, `command.maxConcurrent` integers ≥ 1; cooldowns ≥ 0). The container builds `commandLimiter` and passes it to the reply-command handler.
12. **Existing tests to update:** `test/characterization/auto-reply.test.js` and `revive.test.js` (LLM-failure cases), `reply-command.test.js` (acknowledgement sequence), the chain scenario for `CHAIN_REPLIES=false`, and the handler unit tests.
