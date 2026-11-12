# Spec 23: Webhook persona display (opt-in) and member profiles

**Depends on:** 22. **Blocks:** 24 (shared files only), 26.

## Problem

Bot messages appear under the bot's own name with an embed naming the persona. A channel webhook can post with any display name and avatar, which reads far more naturally. For that to be right, the name and avatar must be the member's **current** ones: people change nicknames and avatars, and a message sent in someone's name must never show stale information. Webhook messages cannot be native Discord replies, so webhook display is an opt-in mode rather than a replacement.

## Part 1: Member profiles (both display modes)

### Storage (additive migration, `src/storage/profileStore.js`)

```sql
CREATE TABLE IF NOT EXISTS user_profiles (
  username     TEXT NOT NULL,
  user_id      TEXT,
  display_name TEXT NOT NULL,
  avatar_url   TEXT,
  observed_at  INTEGER NOT NULL,
  PRIMARY KEY (username, observed_at)
)
```

Append-only: each row is an observation; a user's **stored profile** is their newest row. `createProfileStore({ db })` → `latest(username) → Profile | null`, `record({ username, userId, displayName, avatarURL, observedAt })` (`ON CONFLICT DO NOTHING`), `all() → Profile[]` (newest row per username).

**Profile:** `{ username, userId, displayName, avatarURL }`.

### Lookup adapter (`src/discord/memberLookup.js`)

`fetchMember(guild, { username, userId, searchLimit }) → Promise<{ userId, displayName, avatarURL } | null>`:

- with a known `userId`: `guild.members.fetch({ user: userId, force: true })` (`force` bypasses discord.js's member cache, which is not kept fresh without the privileged members intent);
- otherwise `guild.members.fetch({ query: username, limit: searchLimit })` and take the member whose `user.username` equals `username` exactly (case-insensitive). A query matches by prefix, so the first result is **not** assumed to be the right person; no exact match → `null`;
- result: `userId: member.user.id`, `displayName: member.displayName`, `avatarURL: member.displayAvatarURL() ?? null`. A user id that no longer resolves (member left) → `null`.

Errors propagate to the caller.

### Service (`src/discord/memberProfiles.js`)

`createMemberProfiles({ profileStore, fetchMember, userDirectory, config, now, logger })` →

- `current(username, guild) → Promise<Profile>`, called **every time a message is about to be sent in that user's name**:
  1. If this username was checked less than `profiles.minCheckIntervalMs` ago, return that result (so the parts of one burst share a lookup).
  2. `live = await fetchMember(guild, { username, userId: stored?.userId, searchLimit })`.
  3. If `live` differs from the stored profile in `userId`, `displayName` or `avatarURL` (or nothing is stored), `profileStore.record(...)` with `observedAt: now()` and log the change at info level (old → new display name; avatar changed yes/no).
  4. Return `live`.
  5. If the lookup throws or returns `null`: log a warning and return the stored profile if there is one, else `{ username, userId: null, displayName: username, avatarURL: null }`. Nothing is recorded.
- `refreshAll(guild) → Promise<{ checked, changed, failed }>`: runs the same check (ignoring the minimum interval) for every user in the directory, sequentially; one user's failure does not stop the rest.

### Periodic refresh

`src/bot/handlers/profileRefresh.js`: `createProfileRefresh({ client, config, memberProfiles, logger })` → an async function that fetches the configured channel, takes its guild (`channel.guild ?? await client.guilds.fetch(channel.guildId)`), calls `refreshAll`, logs the counts, and catches and logs any error. `createBot` runs it once at `ClientReady` and then every `profiles.refreshIntervalMs` through `clock.setInterval` (`0` disables both).

### Use

`authorEmbeds.make(author, guild, options)` takes the avatar from `memberProfiles.current(author, guild)` instead of doing its own member search (the embed's author name stays the username). The avatar-failure warning now comes from `memberProfiles`.

## Part 2: Webhook display mode

### Mode

`config.discord.personaDisplay`: `'embed'` (default, current behaviour) or `'webhook'` (env `PERSONA_DISPLAY`). Any other value makes `loadConfig` throw an error naming the value. The container builds the delivery adapter for the mode; nothing else in the bot knows the mode.

### Webhook provider (`src/discord/webhooks.js`)

`createWebhookProvider({ getBotUserId, config, logger })` → `{ forChannel(channel) → Promise<Webhook>, forget(channel) }`:

- The **promise** is cached per channel id, so concurrent sends share one lookup and never create duplicates. A rejected promise is evicted; `forget(channel)` evicts explicitly.
- Lookup: among `[...(await channel.fetchWebhooks()).values()]`, the first whose `owner?.id` is the bot's user id and whose `name` is `config.discord.webhookName`; else `channel.createWebhook({ name: config.discord.webhookName })`.
- A channel without `fetchWebhooks` (threads) rejects with `Error('channel does not support webhooks')`.

Both fetching and creating need the Manage Webhooks permission; a channel is limited to 15 webhooks.

### Webhook delivery (`src/discord/webhookDelivery.js`)

`createWebhookDelivery({ webhooks, memberProfiles, fallback, config, logger })` → `{ deliver(request), placeholder(request) }`, same request shape as the embed delivery (`fallback` is the embed delivery):

1. Channel: `via.message.channel`, `via.channel`, or `via.interaction.channel`.
2. `profile = await memberProfiles.current(persona, guild)`.
3. `webhook = await webhooks.forChannel(channel)`; then

   ```
   webhook.send({
     content,                                  // see reply link below
     username: profile.displayName.slice(0, config.discord.webhookUsernameMax),
     avatarURL: profile.avatarURL ?? undefined,
     embeds: <GIF image embeds only>,          // no author embed
     allowedMentions: { parse: [] },
   })
   ```

   and the resolved message is returned. `buildPayload` accepts a missing `authorEmbed` and then returns only the GIF embeds.
4. **Reply link.** A webhook message cannot be a native reply. For `via.type === 'reply'` with `discord.webhookReplyLink` on, the content is prefixed with the line `-# ↪ <via.message.url>` (small text with a jump link to the message being answered), and the combined text is passed through `truncateForDiscord` again.
5. `via.type === 'interaction'`: after the persona message is sent (by webhook or by fallback), `interaction.editReply({ content: 'Sent as <persona>.', allowedMentions: { parse: [] } })`. `via.type === 'followUp'`: persona message only.
6. **Fallback.** If obtaining the webhook or sending through it fails (missing permission, deleted webhook, a name Discord rejects, thread channel): call `webhooks.forget(channel)`, log a warning (once per channel per error message), and deliver through `fallback`. For `interaction`/`followUp` vias the fallback request uses `{ type: 'channel', channel }` because the interaction's placeholder is ephemeral; step 5 still runs.

`placeholder({ persona, guild }) → Promise<payload>` is new on both adapters and replaces the handler's direct use of `authorEmbeds` (the reply-command handler takes `delivery` instead): the embed delivery returns the thinking-embed payload (as today); the webhook delivery returns `{ content: 'Replying as <persona>…', flags: MessageFlags.Ephemeral }`. Both carry `allowedMentions: { parse: [] }`.

### Consequences handled elsewhere

- Webhook messages have `author.bot === true`, so `messageCreate` already ignores them.
- The id returned by `webhook.send` is recorded in `bot_messages` (spec 15), so chains, transcripts and bursts work unchanged; `botMessageResolver` resolves webhook messages through the store.
- Messages already sent keep the name and avatar they were sent with; Discord does not update old webhook messages.

## Config

`discord.personaDisplay: 'embed'` (`PERSONA_DISPLAY`), `discord.webhookName: 'deep-pa-text'`, `discord.webhookUsernameMax: 80`, `discord.webhookReplyLink: true`, `profiles.refreshIntervalMs: 3600000` (`0` disables), `profiles.minCheckIntervalMs: 10000`, `profiles.searchLimit: 10`.

## Harness change

- Guild member fake: members have `user: { id, username }`, `displayName` (default `<username>-display`) and `displayAvatarURL()`; `members.fetch` supports `{ user, force }` (by id) and `{ query, limit }` (all members whose username starts with the query, up to `limit`); controls to add a member, change a member's `displayName`/avatar, remove a member, and the existing `setFailing`/`setMissing`. `members.calls` records arguments.
- Fake channel: `fetchWebhooks()` resolving to a `Map`, `createWebhook({ name })` creating `{ id, name, owner: { id: 'bot-user' }, send(payload), sent: [] }`. `webhook.send` records the payload, appends a bot message (`id`, `createdTimestamp`, `channel`, `embeds`, `reference: null`, `webhookId`, `author: { id: webhook.id, bot: true, username: payload.username }`) to channel history, and resolves to it. Controls: `channel.webhooks.list`, `failFetch(error)`, `failCreate(error)`, `add({ name, ownerId })`, `webhook.failSends(error, { times })`.
- Fake messages gain `url` (`https://discord.test/channels/<guild>/<channel>/<id>`).
- `createWorld({ env })` merges extra environment values into `world.env` before boot, so a test can boot with `PERSONA_DISPLAY: 'webhook'`.
- `test/unit/sendSites.test.js` allowlist gains `src/discord/webhookDelivery.js`.

## Edge cases

Profiles:
- First send as `bob`: a row is recorded; the embed icon / webhook avatar is the live one.
- Bob changes nickname and avatar, then a message is sent as bob → the new name and avatar are used and a second row is recorded; the first row is still there.
- Nothing changed → no new row.
- Lookup fails at send time → the stored profile is used, warning logged, message still sent. No stored profile → username and no avatar.
- A different member whose username merely starts with `bob` (`bobby`) is never used for `bob`.
- Once a user id is stored, the lookup is by id: bob renaming his **username** on Discord still resolves.
- Member left the server → stored profile used.
- Burst of three parts → one member lookup.
- Hourly refresh: with time advanced one hour, every directory user is checked once; a changed user gets a new row; a failing user is counted in `failed` and the others are still checked. Refresh runs once at ready.
- `profiles.refreshIntervalMs: 0` → no refresh at ready and no interval.

Webhook mode:
- Default mode: no webhook call is ever made (assert `fetchWebhooks` is not called).
- Auto reply: one `webhook.send` with the member's display name and avatar, GIF embeds only, safe mentions, content starting with the reply-link line; `message.reply` not called; a `bot_messages` row with the webhook message id whose `content` has no link line.
- Existing bot-owned webhook with the configured name → reused; one owned by someone else or with another name → ignored and a new one created; second send → no further `fetchWebhooks`.
- Two concurrent sends in a fresh channel → one `createWebhook`.
- `createWebhook` rejects → warning, message delivered in embed form via `message.reply`; the next send tries the webhook again.
- Webhook deleted after caching (`send` rejects once) → that message falls back; the next send looks the webhook up again.
- Display name of 100 characters → username cut to 80.
- Command in webhook mode: ephemeral placeholder, webhook message, placeholder edited to `Sent as bob.`; with the webhook failing, the persona message goes to the channel in embed form (not into the ephemeral reply) and the placeholder is still edited.
- Burst in webhook mode: every part goes through the webhook; only the first carries the reply link.
- A user replies to a webhook message → the chain continues with the stored persona.
- Revive in webhook mode → webhook message with no link line.

## Tests

- Unit: `profileStore` (append-only, latest, all, idempotent migration); `fetchMember` (by id with `force`, exact match among prefix matches, no match, left member); `memberProfiles.current` (each numbered step, divergence detection per field, minimum interval, failure fallbacks); `refreshAll`; `profileRefresh` handler; `createBot` schedules it; webhook provider (reuse, create, promise cache, eviction, ownership and name checks, thread channel); webhook delivery for each `via` type, reply link and re-truncation, fallback paths, once-only warning; `placeholder` for both adapters; `buildPayload` without an author embed; config validation; container selects the adapter.
- Existing tests: avatar-related assertions adapt to the exact-match lookup (the fake member for a persona must exist with that exact username). Nothing else changes in embed mode.
- Scenario (`test/scenarios/profiles.test.js`, `test/scenarios/webhook.test.js`): each edge case above.

## Docs

README: a "Persona display" section (the two modes, Manage Webhooks permission, reply link, old messages keep their old name) and a "Member profiles" section (checked at every send and hourly, stored history, fallback behaviour); configuration table.

## Acceptance

`npm test` passes; characterization tests change only where the member lookup arguments are asserted.
