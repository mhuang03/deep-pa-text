# Spec 23: Webhook persona display (opt-in)

**Depends on:** 22. **Blocks:** none.

## Problem

Bot messages appear under the bot's own name with an embed naming the persona. A channel webhook can post with any display name and avatar, which reads far more naturally. Webhook messages cannot be native Discord replies, so this is an opt-in mode rather than a replacement.

## Required behaviour

### Mode

`config.discord.personaDisplay`: `'embed'` (default, current behaviour) or `'webhook'` (env `PERSONA_DISPLAY`). An unknown value makes `loadConfig` throw. The container builds the delivery adapter for the mode; nothing else in the bot knows the mode.

### Member profiles (`src/discord/memberProfile.js`)

`createMemberProfiles({ logger })` → `lookup(username, guild) → Promise<{ displayName, avatarURL }>`: the member lookup currently inside `authorEmbed.js` (`guild.members.fetch({ query: username, limit: 1 })`), returning `displayName: member?.displayName ?? username` and `avatarURL: member?.displayAvatarURL() ?? null`; a failed lookup is logged as a warning and yields `{ displayName: username, avatarURL: null }`. `authorEmbed.js` is changed to use it (no behaviour change).

### Webhook provider (`src/discord/webhooks.js`)

`createWebhookProvider({ getBotUserId, config, logger })` → `forChannel(channel) → Promise<Webhook>`: returns the cached webhook for the channel id, else the first webhook from `channel.fetchWebhooks()` whose `owner?.id` is the bot's user id and whose `name` is `config.discord.webhookName`, else `channel.createWebhook({ name: config.discord.webhookName })`. A rejected lookup is not cached.

### Webhook delivery (`src/discord/webhookDelivery.js`)

`createWebhookDelivery({ webhooks, memberProfiles, fallback, logger })` → `{ deliver(request) }` with the same request shape as the embed delivery (`fallback` is the embed delivery):

- Resolve the channel: `via.message.channel`, `via.channel`, or `via.interaction.channel`.
- `profile = await memberProfiles.lookup(persona, guild)`.
- `webhook.send({ content, username: profile.displayName, avatarURL: profile.avatarURL ?? undefined, embeds: <GIF image embeds only>, allowedMentions: { parse: [] } })`; the resolved message is returned. No author embed is added. When `content` is empty and there are no GIF embeds, `content` is the persona's display name is **not** substituted; such a part is never produced (spec 14 rejects empty responses).
- `via.type === 'interaction'`: after the webhook message is sent, `interaction.editReply({ content: 'Sent as <persona>.', allowedMentions: { parse: [] } })`. `via.type === 'followUp'`: webhook send only.
- Any failure to obtain the webhook or to send through it (for example missing Manage Webhooks permission) is logged as a warning and the request is delivered through `fallback` instead. The warning for a missing permission is logged once per channel.

In webhook mode the command's placeholder (`modalInteraction.reply`) is ephemeral text `Replying as <persona>…` instead of the thinking embed; the handler asks the delivery adapter for it: `delivery.placeholder({ persona, guild }) → payload` (embed delivery returns the thinking-embed payload, webhook delivery the ephemeral text).

### Consequences handled elsewhere

- Webhook messages have `author.bot === true`, so `messageCreate` already ignores them.
- The id returned by `webhook.send` is recorded in `bot_messages` (spec 15), so chains, transcripts and bursts work unchanged. `botMessageResolver` resolves webhook messages through the store; the embed fallback does not apply to them.
- Auto and chain replies are not native replies in this mode. This limitation is documented, not worked around.

## Config

`discord.personaDisplay: 'embed'`, `discord.webhookName: 'deep-pa-text'`.

## Harness change

- Fake channel: `fetchWebhooks()` resolving to a `Map` of its webhooks, `createWebhook({ name })` creating `{ id, name, owner: { id: 'bot-user' }, send(payload), sent: [] }`. `webhook.send` records the payload, appends a bot message to channel history with `webhookId`, `author: { id: webhook.id, bot: true, username: payload.username }`, and resolves to it. Controls: `channel.webhooks.list`, `channel.webhooks.failFetch(error)`, `channel.webhooks.failCreate(error)`, `webhook.failSends(error)`, `channel.webhooks.add({ name, ownerId })`.
- Guild member fake gains `displayName` (default `<username>-display`), overridable per user.
- `createWorld({ env })` merges extra environment values so a test can boot with `PERSONA_DISPLAY: 'webhook'`.

## Edge cases

- Default mode: no webhook call is ever made (assert `fetchWebhooks` not called).
- Webhook mode, auto reply: one `webhook.send` with the member's display name and avatar, GIF embeds only, safe mentions; `message.reply` not called; a `bot_messages` row with the webhook message id.
- Existing bot-owned webhook with the configured name → reused; a webhook owned by someone else or with another name → ignored and a new one created; second send → no further `fetchWebhooks` (cached).
- Member not found → username as display name, no avatar.
- `createWebhook` rejects → warning, reply delivered in embed form via `message.reply`; later sends try the webhook again.
- Command in webhook mode: ephemeral placeholder, webhook message, then the placeholder edited to `Sent as bob.`
- Burst in webhook mode: every part goes through the webhook.
- A user replies to a webhook message → chain continues with the stored persona.
- Revive in webhook mode → webhook message in the channel.

## Tests

- Unit: `memberProfiles.lookup` (found, missing, failure); provider (reuse, create, cache, rejected lookup not cached, ownership and name checks); webhook delivery for each `via` type, fallback, once-only warning; `placeholder` for both adapters; config validation; container selects the adapter.
- Scenario (`test/scenarios/webhook.test.js`): each edge case above.
- Characterization: unchanged (default mode).

## Docs

README: new "Persona display" subsection covering the mode, the Manage Webhooks permission, and the no-native-replies limitation.

## Acceptance

`npm test` passes; no characterization test changes.
