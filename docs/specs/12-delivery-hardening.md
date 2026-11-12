# Spec 12: Delivery hardening (awaited sends, safe mentions, single response pipeline)

**Depends on:** 11, 14. **Blocks:** 15, 22, 23.

## Problem

- `message.reply` and `channel.send` are not awaited: a failed send is an unhandled rejection, and reply state is updated even when nothing was sent.
- Generated text is sent with default mention parsing, so `@everyone`, `@here` or a raw `<@id>` in LLM output would ping.
- The three triggers each compose a payload and send it themselves; later specs (bot-message recording, typing, bursts, webhooks) need one place to hook into.

## Design

Introduce a delivery adapter and a responder so that handlers only decide *whether* and *as whom* to respond.

### `src/discord/delivery.js`

`createEmbedDelivery({ authorEmbeds, config })` → `{ deliver(request) → Promise<DiscordMessage> }`.

`request = { via, persona, guild, content, gifLinks }` where `via` is one of:

- `{ type: 'reply', message }` → `message.reply(payload)`
- `{ type: 'channel', channel }` → `channel.send(payload)`
- `{ type: 'interaction', interaction }` → `interaction.editReply(payload)`

`deliver` builds the author embed (`authorEmbeds.make(persona, guild)`; a failed avatar lookup already degrades to no icon inside `make`), then `payload = buildPayload({ content, gifLinks, authorEmbed })` plus `allowedMentions`, sends it, awaits the send and returns the resolved Discord message. A rejected send propagates. An unknown `via.type` throws `Error('unknown delivery type: <type>')`; later specs add types here.

### Safe mentions (`src/discord/payload.js`)

- `SAFE_MENTIONS = { parse: [] }`; `withSafeMentions(payload, { repliedUser })` returns a new payload with `allowedMentions: { parse: [], repliedUser }`.
- Replies use `repliedUser: config.discord.pingRepliedUser` (default `true`, preserving the current reply ping). Channel sends and interaction responses carry `allowedMentions: SAFE_MENTIONS` with no `repliedUser` key.
- **Every** outbound Discord call in `src/` carries `allowedMentions`: delivery payloads, the thinking placeholder, the failure notice, and the two ephemeral error replies.
- Defence in depth: `createDiscordClient` constructs the client with `allowedMentions: { parse: [] }` as well as the intents, so a call that forgets the option still cannot ping.

### `src/bot/responder.js`

`createResponder({ composer, delivery, logger })` → `{ respond(request) → Promise<{ response, message }> }`.

`request = { trigger: 'auto' | 'command' | 'revive', persona, target: MessageRecord | null, guild, via }`.

Steps: `composer.compose({ persona, target })` → `{ response, content, gifLinks }` (generation, GIF resolution and the spec 14 truncation; `target === null` means revive) → `delivery.deliver({ via, persona, guild, content, gifLinks })` → return `{ response, message }`.

Removed by this spec: `composeReply`/`composeRevive` (collapsed into `compose`), payload and author-embed building in the composer (`createComposer({ generator, gifResolver, config })`), `src/bot/detachedSend.js` and its uses, and the `authorEmbeds`/`composer` dependencies of the message and revive handlers (they take `responder`). The reply-command handler keeps `authorEmbeds` for the placeholder. The container builds `delivery` and `responder` and returns both.

### Handlers

- `messageCreate`: after the policy accepts and the persona is chosen, `await responder.respond({ trigger: 'auto', via: { type: 'reply', message }, ... })`. `replyPolicy.noteReply({ resetMisses: true })` and the second `activity.noteBot()` run only after `respond` resolves. The first `activity.noteBot()` before generation is unchanged and is deliberately not rolled back on failure.
- Failure handling in `messageCreate`: a **generation** failure (the composer rejects) behaves as today: logged, no rate limit armed. A **delivery** failure (the send rejects, for example because the target was deleted or the bot lacks permission) is logged and arms the rate limit with `replyPolicy.noteReply({ resetMisses: false })`, so a persistent send failure costs at most one LLM call per rate-limit window instead of one per message. The responder marks delivery failures by rejecting with an error whose `stage` property is `'delivery'`.
- `reviveTick`: `via: { type: 'channel', channel }`; the second `activity.noteBot()` runs only after success; failures are logged.
- `replyCommand`: the thinking placeholder is still sent with `modalInteraction.reply` (with safe mentions), then `responder.respond({ trigger: 'command', via: { type: 'interaction', interaction: modalInteraction }, ... })`. If anything fails after the placeholder was sent, the handler makes one best-effort `modalInteraction.editReply({ content: GENERATION_FAILED_MESSAGE, embeds: [], allowedMentions: SAFE_MENTIONS })` (constant `'Could not generate a reply.'` in `replyModal.js`; its own failure is logged and ignored) so the placeholder does not stay on "thinking..." forever, then rethrows to the handler boundary. Reply state is untouched on failure.

## Config

`discord.pingRepliedUser: true` (env `PING_REPLIED_USER`, `'false'` disables).

## Harness change

- Fake bot messages (already returned by `reply`, `send`, `editReply`) gain `reference` (`{ messageId: <target id> }` for `message.reply`, else `null`) and take `createdTimestamp` from the mocked clock.
- Failure hooks, each one-shot by default: `message.failReplies(error, { times = 1 })`, `channel.failSends(error, { times = 1 })`, and on a modal-submit interaction `failReply(error)` / the existing `failEdits(error)` extended with the same `{ times }` option. They are safe now that sends are awaited inside the handler boundary.

## Edge cases

- `message.reply` rejects → error logged once, no unhandled rejection, handler does not throw, the rate limit is armed (a replyable message 1 ms later with roll 0 gets no reply and no LLM call) and the miss counter is unchanged.
- The LLM rejects → logged, rate limit not armed (unchanged from today).
- Command: generation or `editReply` fails after the placeholder → one further `editReply` with `GENERATION_FAILED_MESSAGE` and no embeds; if that also rejects, only logs.
- `channel.send` rejects during revive → logged, no throw.
- LLM response containing `@everyone` and `<@111>` → payload has `allowedMentions.parse` equal to `[]`.
- Reply payload → `allowedMentions.repliedUser === true` by default, `false` when configured.

## Tests

- Characterization updates: payload assertions that compare whole payloads gain `allowedMentions`; the command test "LLM failure after submit" now expects one `editReply` carrying `GENERATION_FAILED_MESSAGE`; the client-options test also sees `allowedMentions`. Nothing else changes.
- Unit: `withSafeMentions` (does not mutate, both `repliedUser` values); `delivery.deliver` for the three `via` types (awaits, returns the message, passes safe mentions, propagates rejection); `responder.respond` (order compose → deliver, propagates errors, returns `{ response, message }`); handlers (state updated only after success).
- Scenario (`test/scenarios/delivery.test.js`): each edge case above. Add `test/unit/sendSites.test.js`: scans `src/` with comments stripped and fails if a `.reply(`, `.send(`, `.editReply(` or `.followUp(` call exists outside an explicit allowlist (`src/discord/delivery.js`, `src/bot/handlers/replyCommand.js`; later specs extend the list).

## Docs

README: remove the "not awaited" known issue; document `PING_REPLIED_USER`.

## Acceptance

`npm test` passes. `grep -rn "allowedMentions" src` shows it applied on every outbound path.
