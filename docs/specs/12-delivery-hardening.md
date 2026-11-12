# Spec 12: Delivery hardening (awaited sends, safe mentions, single response pipeline)

**Depends on:** 11. **Blocks:** 15, 22, 23.

## Problem

- `message.reply` and `channel.send` are not awaited: a failed send is an unhandled rejection, and reply state is updated even when nothing was sent.
- Generated text is sent with default mention parsing, so `@everyone`, `@here` or a raw `<@id>` in LLM output would ping.
- The three triggers each compose a payload and send it themselves; later specs (bot-message recording, typing, bursts, webhooks) need one place to hook into.

## Design

Introduce a delivery adapter and a responder so that handlers only decide *whether* and *as whom* to respond.

### `src/discord/delivery.js`

`createEmbedDelivery({ authorEmbeds, config })` → `{ deliver(request) → Promise<DiscordMessage> }`.

`request = { via, persona, guild, content, gifLinks, thinking? }` where `via` is one of:

- `{ type: 'reply', message }` → `message.reply(payload)`
- `{ type: 'channel', channel }` → `channel.send(payload)`
- `{ type: 'interaction', interaction }` → `interaction.editReply(payload)`

`payload = buildPayload({ content, gifLinks, authorEmbed })` plus `allowedMentions`. Every call is awaited and the resolved Discord message is returned.

### Safe mentions (`src/discord/payload.js`)

- `SAFE_MENTIONS = { parse: [] }`; `withSafeMentions(payload, { repliedUser })` returns a new payload with `allowedMentions: { parse: [], repliedUser }`.
- Replies use `repliedUser: config.discord.pingRepliedUser` (default `true`, preserving the current reply ping). Channel sends and interaction responses use `{ parse: [] }`.
- **Every** outbound Discord call in `src/` carries `allowedMentions`: delivery payloads, the thinking placeholder, and the two ephemeral error replies.

### `src/bot/responder.js`

`createResponder({ composer, delivery, logger })` → `{ respond(request) → Promise<{ response, message }> }`.

`request = { trigger: 'auto' | 'command' | 'revive', persona, target: MessageRecord | null, guild, via }`.

Steps: `composer.compose({ persona, target })` → `{ response, content, gifLinks }` (generation and GIF resolution; `target === null` means revive) → `delivery.deliver({ via, persona, guild, content, gifLinks })` → return `{ response, message }`. `composer` no longer builds payloads or author embeds; `composeReply`/`composeRevive` collapse into `compose`.

### Handlers

- `messageCreate`: after the policy accepts and the persona is chosen, `await responder.respond({ trigger: 'auto', via: { type: 'reply', message }, ... })`. `replyPolicy.noteReply({ resetMisses: true })` and the second `activity.noteBot()` run only after `respond` resolves. If it rejects, the handler boundary logs the error and the reply time is not updated. (The first `activity.noteBot()` before generation is unchanged.)
- `reviveTick`: `via: { type: 'channel', channel }`, same rule.
- `replyCommand`: the thinking placeholder is still sent with `modalInteraction.reply` (with safe mentions), then `responder.respond({ trigger: 'command', via: { type: 'interaction', interaction: modalInteraction }, ... })`.

## Config

`discord.pingRepliedUser: true` (env `PING_REPLIED_USER`, `'false'` disables).

## Harness change

Fake `message.reply`, `channel.send`, `modalInteraction.editReply` resolve to a fake bot message `{ id (unique), author: { id: 'bot-user', bot: true }, content, embeds, createdTimestamp: world.now(), channel, reference }`. Add `message.failReplies(error)` and `channel.failSends(error)` (making `reply`/`send` reject); they are safe now that sends are awaited inside the handler boundary.

## Edge cases

- `message.reply` rejects → error logged once, no unhandled rejection, `replyPolicy` reply time not set (a replyable message 1 ms later with roll 0 is replied to), handler does not throw.
- `channel.send` rejects during revive → logged, no throw.
- LLM response containing `@everyone` and `<@111>` → payload has `allowedMentions.parse` equal to `[]`.
- Reply payload → `allowedMentions.repliedUser === true` by default, `false` when configured.

## Tests

- Characterization updates: reply/revive/command payload assertions gain `allowedMentions`; nothing else changes. State the changed assertions in the commit message.
- Unit: `withSafeMentions` (does not mutate, both `repliedUser` values); `delivery.deliver` for the three `via` types (awaits, returns the message, passes safe mentions, propagates rejection); `responder.respond` (order compose → deliver, propagates errors, returns `{ response, message }`); handlers (state updated only after success).
- Scenario (`test/scenarios/delivery.test.js`): each edge case above. Add a test that scans `src/` and fails if a `.reply(`, `.send(`, `.editReply(` or `.followUp(` call site exists outside `src/discord/delivery.js` and `src/bot/handlers/replyCommand.js`.

## Docs

README: remove the "not awaited" known issue; document `PING_REPLIED_USER`.

## Acceptance

`npm test` passes. `grep -rn "allowedMentions" src` shows it applied on every outbound path.
