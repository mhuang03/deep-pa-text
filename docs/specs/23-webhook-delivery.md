# Spec 23: Member profiles and webhook persona display (opt-in)

**Depends on:** 22. **Blocks:** 24 (shared files only), 25, 26.

## Problem

Bot messages appear under the bot's own name with an embed naming the persona. A channel webhook can post with any display name and avatar, which reads far more naturally. For that to be right, the name and avatar must be the member's **current** ones: people change nicknames and avatars, and a message sent in someone's name must not show stale information. Webhook messages cannot be native Discord replies, so webhook display is an opt-in mode rather than a replacement.

## Part 1: Member profiles (both display modes)

Requirement: a user's display name and avatar are checked against Discord every time a message is about to be sent in that user's name, and all users are re-checked periodically (hourly), so the stored information stays current.

**Guarantee.** At send time the profile used was read from Discord within the last `profiles.minCheckIntervalMs` (10 s). It can be older only when Discord could not be reached, in which case the last stored profile is used.

### Storage (additive migration in `src/storage/migrations.js`; `src/storage/profileStore.js`)

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

Append-only: each row is an observation; a user's **stored profile** is the row with the greatest `observed_at`. `createProfileStore({ db })` →

- `latest(username) → Profile | null`;
- `record({ username, userId, displayName, avatarURL, observedAt })` (`ON CONFLICT DO NOTHING`);
- `all() → Profile[]` (newest row per username);
- `namesOf(username) → string[]` (every distinct display name ever observed for that user; used by spec 25 to attribute old webhook messages).

**Profile:** `{ username, userId, displayName, avatarURL }`.

### User ids

`data/users.json` entries may carry an optional `id` (the Discord user id): `{ "username": "…", "name": "…", "id": "…" }`. `buildUserDirectory` exposes `idOf(username) → string | undefined`. When present it makes lookups exact from the first use; without it the id is learned from the first successful search and kept in the stored profile.

### Lookup adapter (`src/discord/memberLookup.js`)

The bot does not enable the privileged `GuildMembers` intent, so it must not use the gateway member query (`guild.members.fetch({ query })`), which can go unanswered for two minutes. Both paths below are REST calls and need no privileged intent.

`fetchMember(guild, { username, userId, searchLimit }) → Promise<{ userId, displayName, avatarURL } | null>`:

- with a `userId`: `guild.members.fetch({ user: userId, force: true })` (`force` bypasses discord.js's member cache, which is not kept fresh without the intent). A rejection whose `code` is `10007` (Unknown Member) or `10013` (Unknown User) → `null`;
- otherwise `guild.members.search({ query: username, limit: searchLimit })` and take the member whose `user.username` equals `username` exactly (case-insensitive). The search matches prefixes of usernames and nicknames, so the first result is **not** assumed to be the right person; no exact match → `null`;
- result: `userId: member.user.id`, `displayName: member.displayName`, `avatarURL: member.displayAvatarURL() ?? null`.

Other errors propagate.

### Service (`src/profiles/memberProfiles.js`)

`src/profiles/` is a use-case layer module (it combines the storage and Discord adapters); add it to the layering list in `CLAUDE.md`.

`createMemberProfiles({ profileStore, fetchMember, userDirectory, config, clock, logger })` →

- `current(username, guild) → Promise<Profile>`:
  1. If a successful check for this username finished less than `profiles.minCheckIntervalMs` ago, return its result. If a check for this username is in flight, await that same promise (concurrent sends and burst parts share one lookup). Failures are not cached. The cache is an in-memory map inside the factory.
  2. `stored = profileStore.latest(username)`; `live = await withTimeout(fetchMember(guild, { username, userId: stored?.userId ?? userDirectory.idOf(username), searchLimit }), { ms: profiles.lookupTimeoutMs, … })`.
  3. If `live` is non-null and differs from `stored` in `userId`, `displayName` or `avatarURL` (or nothing is stored): `profileStore.record({ username, ...live, observedAt: clock.now() })` and log at info level that the profile changed (which fields, not their values).
  4. Return `{ username, ...live }`.
  5. If the lookup throws, times out or returns `null`: log a warning (at most once per username per `profiles.refreshIntervalMs`) and return `stored` if there is one, else `{ username, userId: null, displayName: username, avatarURL: null }`. Nothing is recorded.
- `refreshAll(guild) → Promise<{ checked, changed, failed }>`: the same check, ignoring the minimum interval, for every user in the directory, one after another; a failure for one user is counted and does not stop the rest.

### Periodic refresh (`src/bot/handlers/profileRefresh.js`)

`createProfileRefresh({ client, config, memberProfiles, logger })` → an async function that fetches the configured channel, takes its guild (`channel.guild ?? await client.guilds.fetch(channel.guildId)`), calls `refreshAll`, logs the counts, and catches and logs any error. `createBot` starts it at `ClientReady` **without awaiting it** and then every `profiles.refreshIntervalMs` through `clock.setInterval` (`0` disables both).

### Use

`authorEmbeds.make(author, guild, options)` takes the avatar from `memberProfiles.current(author, guild)` (injected) instead of doing its own member lookup; the embed's author name stays the username. The delivery adapters therefore check the profile on every send.

## Part 2: Webhook display mode

### Mode

`config.discord.personaDisplay`: `'embed'` (default, current behaviour) or `'webhook'` (env `PERSONA_DISPLAY`). Any other value makes `loadConfig` throw an error naming the value. The container builds the delivery adapter for the mode; nothing else in the bot knows the mode.

### Delivery request

The `deliver` request gains `channel` (the responder already has it from spec 17), so adapters never depend on `interaction.channel`, which can be null.

### Webhook provider (`src/discord/webhooks.js`)

`createWebhookProvider({ getBotUserId, config, logger })` → `{ forChannel(channel) → Promise<Webhook>, forget(channel), ownedIds(channel) → Promise<Set<string>> }`:

- The **promise** is cached per channel id, so concurrent sends share one lookup and never create duplicates. A rejected promise is evicted; `forget(channel)` evicts explicitly.
- Lookup: among `[...(await channel.fetchWebhooks()).values()]`, the first whose `owner?.id` is the bot's user id and whose `name` is `config.discord.webhookName`; else `channel.createWebhook({ name: config.discord.webhookName })`.
- `ownedIds(channel)`: ids of all the channel's webhooks whose `owner?.id` is the bot's user id (used by spec 25 to recognise the bot's own webhook messages).
- A channel without `fetchWebhooks` (threads) rejects with `Error('channel does not support webhooks')`.

Both fetching and creating need the Manage Webhooks permission; a channel is limited to 15 webhooks.

### Webhook names (`src/discord/webhookName.js`, pure)

`toWebhookName(displayName, username, max) → string | null`: Discord rejects webhook usernames that are empty, longer than 80 characters, or contain `clyde` or `discord` (case-insensitive). Take `displayName` cut to `max` code points (never splitting a surrogate pair); if it is empty or contains a forbidden word, try `username` the same way; if that fails too, `null`.

### Webhook delivery (`src/discord/webhookDelivery.js`)

`createWebhookDelivery({ webhooks, memberProfiles, fallback, config, logger })` → `{ deliver(request), placeholder(request) }`, same request shape as the embed delivery (`fallback` is the embed delivery):

1. `profile = await memberProfiles.current(persona, guild)`; `name = toWebhookName(profile.displayName, persona, config.discord.webhookUsernameMax)`. `name === null` → deliver through `fallback` (step 6) without touching the provider cache.
2. `webhook = await webhooks.forChannel(channel)`; then

   ```
   webhook.send({
     content,                                  // see reply link below
     username: name,
     avatarURL: profile.avatarURL ?? undefined,
     embeds: <GIF image embeds only>,          // no author embed
     allowedMentions: { parse: [] },
   })
   ```

   and the resolved message is returned. `buildPayload` accepts a missing `authorEmbed` and then returns only the GIF embeds.
3. **Reply link.** A webhook message cannot be a native reply. For `via.type === 'reply'` with `discord.webhookReplyLink` on, the content is prefixed with the line `-# ↪ <via.message.url>` (small text with a jump link to the message being answered), and the combined text is passed through `truncateForDiscord` again. `REPLY_LINK_PREFIX = '-# ↪ '` is exported for spec 25.
4. `via.type === 'interaction'`: after the persona message is sent (by webhook or by fallback), `interaction.editReply({ content: 'Sent as <persona>.', allowedMentions: { parse: [] } })`. `via.type === 'followUp'`: persona message only.
5. **Recording.** The id returned by `webhook.send` is recorded in `bot_messages` by the responder as usual, with the generated text (no link line).
6. **Fallback.** If obtaining the webhook or sending through it fails: log a warning (once per channel per error message) and deliver through `fallback`. For `interaction`/`followUp` vias the fallback request uses `{ type: 'channel', channel }`, because the interaction's placeholder is ephemeral; step 4 still runs. `webhooks.forget(channel)` is called only when the webhook itself is the problem: the lookup or creation failed, or the send was rejected with code `10015` (Unknown Webhook) or status 404. If a send times out after Discord accepted it, the fallback can post a duplicate; accepted.

`placeholder({ persona, guild }) → Promise<payload>` is new on both adapters and replaces the reply-command handler's direct use of `authorEmbeds` (the handler takes `delivery` instead): the embed delivery returns the thinking-embed payload (as today); the webhook delivery returns `{ content: 'Replying as <persona>…', flags: MessageFlags.Ephemeral }`. Both carry `allowedMentions: { parse: [] }`.

### Consequences handled elsewhere

- Webhook messages have `author.bot === true`, so `messageCreate` already ignores them.
- Chains, transcripts and bursts work unchanged, because `botMessageResolver` resolves webhook messages through the `bot_messages` store. (Its embed fallback does not apply to webhook messages; spec 25 covers importing old ones.)
- Messages already sent keep the name and avatar they were sent with; Discord does not update old webhook messages.

## Config

`discord.personaDisplay: 'embed'` (`PERSONA_DISPLAY`), `discord.webhookName: 'deep-pa-text'`, `discord.webhookUsernameMax: 80`, `discord.webhookReplyLink: true`, `profiles.refreshIntervalMs: 3600000` (integer ≥ 0; `0` disables), `profiles.minCheckIntervalMs: 10000` (≥ 0), `profiles.lookupTimeoutMs: 5000` (> 0), `profiles.searchLimit: 100` (1 to 1000). `loadConfig` throws on values outside these ranges.

## Harness change

- Guild member fake: the guild holds members `{ user: { id, username }, displayName, displayAvatarURL() }`; `createWorld` seeds one for every fixture user (`displayName` `<username>-display`, avatar `https://cdn.example/avatars/<username>.png`, id `user-<username>`), so existing avatar assertions keep their URLs. `members.fetch({ user, force })` resolves the member by id or rejects with an error carrying `code: 10007`; `members.search({ query, limit })` resolves a `Map` of the members whose username or display name starts with the query, up to `limit`. Controls: add, remove and update a member; `setFailing(error | true)`; `setHanging(true)` (lookups never settle); `calls` (method and arguments). The old `{ query, limit }` form of `fetch`, `setMissing` and `avatars` are removed, and their uses in tests are migrated.
- Fake channel: `fetchWebhooks()` resolving to a `Map`, `createWebhook({ name })` creating `{ id, name, owner: { id: 'bot-user' }, send(payload), sent: [] }`. `webhook.send` records the payload, appends a bot message (`id`, `createdTimestamp`, `channel`, `embeds`, `content`, `reference: null`, `webhookId`, `author: { id: webhook.id, bot: true, username: payload.username }`) to channel history, and resolves to it. Controls: `channel.webhooks.list`, `failFetch(error)`, `failCreate(error)`, `add({ name, ownerId })`, `webhook.failSends(error, { times })`.
- Fake messages gain `url` (`https://discord.test/channels/<guild>/<channel>/<id>`).
- `test/unit/sendSites.test.js` allowlist gains `src/discord/webhookDelivery.js`.

## Edge cases

Profiles:
- First send as `bob`: a row is recorded; the embed icon / webhook avatar is the live one.
- Bob changes nickname and avatar, then a message is sent as bob → the new name and avatar are used and a second row is recorded; the first row is still there; `namesOf('bob')` returns both names.
- Nothing changed → no new row.
- Lookup fails or hangs at send time → after at most `lookupTimeoutMs` the stored profile is used, one warning is logged, the message is still sent. No stored profile → username and no avatar.
- A different member whose username merely starts with `bob` (`bobby`), or whose nickname is `bob`, is never used for `bob`.
- Once a user id is known (stored, or from `users.json`), the lookup is by id: bob changing his **username** on Discord still resolves.
- Member left the server (code 10007) → stored profile used.
- Burst of three parts, or two concurrent sends as the same user → one member lookup.
- A send 11 s after the previous check → a new lookup.
- Hourly refresh: with time advanced one hour, every directory user is checked once; a changed user gets a new row; a failing user is counted in `failed` and the others are still checked. A refresh also starts at ready without delaying it.
- `profiles.refreshIntervalMs: 0` → no refresh at ready and no interval.

Webhook mode:
- Default mode: no webhook call is ever made (assert `fetchWebhooks` is not called).
- Auto reply: one `webhook.send` with the member's display name and avatar, GIF embeds only, safe mentions, content starting with the reply-link line; `message.reply` not called; a `bot_messages` row with the webhook message id whose `content` has no link line.
- Existing bot-owned webhook with the configured name → reused; one owned by someone else or with another name → ignored and a new one created; second send → no further `fetchWebhooks`.
- Two concurrent sends in a fresh channel → one `createWebhook`.
- `createWebhook` rejects → warning, message delivered in embed form via `message.reply`; the next send tries the webhook again.
- Webhook deleted after caching (`send` rejects once with code 10015) → that message falls back; the next send looks the webhook up again.
- A send rejected for another reason (validation) → falls back, the cached webhook is kept.
- Display name of 100 characters → cut to 80 code points; display name `Discord Dan` → the username is used instead; both forbidden → embed fallback.
- Command in webhook mode: ephemeral placeholder, webhook message, placeholder edited to `Sent as bob.`; with the webhook failing, the persona message goes to the channel in embed form (not into the ephemeral reply) and the placeholder is still edited.
- Burst in webhook mode: every part goes through the webhook; only the first carries the reply link.
- A user replies to a webhook message → the chain continues with the stored persona.
- Revive in webhook mode → webhook message with no link line.

## Tests

- Unit: `profileStore` (append-only, latest, all, `namesOf`, idempotent migration); `fetchMember` (by id with `force`, 10007/10013 → null, other errors propagate, exact match among prefix and nickname matches, no match); `memberProfiles.current` (each numbered step, divergence per field, minimum interval, in-flight sharing, timeout, failure fallbacks, id from the directory); `refreshAll`; `profileRefresh`; `createBot` schedules it without awaiting; `idOf`; `toWebhookName` (table of names); webhook provider (reuse, create, promise cache, eviction, ownership and name checks, `ownedIds`, thread channel); webhook delivery for each `via` type, reply link and re-truncation, fallback paths and when `forget` is called, once-only warning; `placeholder` for both adapters; `buildPayload` without an author embed; config validation; container selects the adapter.
- Existing tests: assertions on the member lookup call (auto-reply characterization, `authorEmbed` unit test, harness smoke test) change to the new call shape; avatar URLs stay the same thanks to the seeded members. Nothing else changes in embed mode.
- Scenario (`test/scenarios/profiles.test.js`, `test/scenarios/webhook.test.js`): each edge case above.

## Docs

README: a "Member profiles" section (checked at every send and hourly, stored history, the guarantee and its fallback, optional `id` in `users.json`), a "Persona display" section (the two modes, Manage Webhooks permission, reply link, name restrictions, old messages keep their old name), and the configuration table.

## Acceptance

`npm test` passes; characterization tests change only where the member lookup call is asserted.
