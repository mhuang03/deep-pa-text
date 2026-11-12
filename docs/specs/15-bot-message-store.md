# Spec 15: Bot message store

**Depends on:** 12. **Blocks:** 17, 19, 21, 22, 23, 24.

## Problem

The bot ignores and never stores its own messages, so nothing records which persona wrote a given bot message or what it said. Reply chains, transcript attribution and "do not repeat yourself" all need that.

## Design

### Schema (additive migrations)

```sql
CREATE TABLE IF NOT EXISTS bot_messages (
  id TEXT PRIMARY KEY,          -- Discord id of the message the bot sent
  persona TEXT NOT NULL,        -- username the bot was imitating
  content TEXT NOT NULL,        -- generated text in corpus form (GIF tokens kept)
  timestamp INTEGER NOT NULL,   -- ms
  reference TEXT,               -- id of the message it responded to; NULL for a revive
  trigger TEXT NOT NULL         -- 'auto' | 'command' | 'revive' | 'chain'
)
CREATE INDEX IF NOT EXISTS idx_bot_messages_timestamp ON bot_messages (timestamp)
```

### `src/storage/botMessageStore.js`

`createBotMessageStore({ db })` → 
- `insert({ id, persona, content, timestamp, reference, trigger })` (`ON CONFLICT(id) DO NOTHING`);
- `getById(id) → BotMessage | null`;
- `recent({ limit }) → BotMessage[]`, newest first.

**BotMessage:** `{ id, persona, content, timestamp, reference, trigger }`.

### Recording (in `src/bot/responder.js`)

After `delivery.deliver` resolves with the sent Discord message, the responder calls `botMessageStore.insert` with `id: message.id`, `persona`, `content: response` (the generated text before GIF processing), `timestamp: message.createdTimestamp ?? now()`, `reference: target?.id ?? null`, `trigger`. A failure to record is logged and does not fail the response. `respond` still resolves `{ response, message }`.

### Resolving the persona of a Discord message (`src/bot/botMessageResolver.js`)

`createBotMessageResolver({ botMessageStore, userDirectory, getBotUserId })` → `resolve(discordMessage) → { persona, content } | null`:

1. If the store has `discordMessage.id` → `{ persona, content }` from the store.
2. Else if `discordMessage.author.id === getBotUserId()`: read the persona from the embeds with `readPersonaFromEmbeds` and return `{ persona, content: discordMessage.content }` (messages sent before this feature existed).
3. Else `null`.

`src/discord/botPersona.js`: `readPersonaFromEmbeds(discordMessage, userDirectory) → username | null`: the `author.name` of the last embed that has one, if it is a known username. Reads both received embeds (`embed.author?.name`) and builders (`embed.data?.author?.name`).

The container passes `getBotUserId: () => client.user?.id`.

### Inspect script

`npm run inspect` gains a fifth section: latest 10 bot messages (timestamp, persona, trigger, content, reference).

## Edge cases

- Revive → `reference` is `NULL`, `trigger` is `'revive'`.
- Command reply → the id comes from the message `editReply` resolves to; `reference` is the target id.
- Delivery fails → nothing is recorded.
- `insert` throws → logged at error level, response still counts as sent (reply time and activity updated).
- Persona in the store that is no longer in `users.json` → `resolve` still returns it (callers decide).
- Embed fallback with no embeds, or an embed author that is not a known user → `null`.

## Tests

- Unit: migrations add the table and index and are idempotent on a database that already has them; store insert/get/recent, idempotent insert, ordering, limit; `readPersonaFromEmbeds` (builder embeds, received embeds, several embeds, unknown name, none); resolver (store hit, embed fallback, foreign bot, human); responder records after delivery, not on failure, and survives a failing store.
- Scenario (`test/scenarios/bot-messages.test.js`): after an auto reply, a revive and a command reply, `world.sqlite` shows one `bot_messages` row each with the right persona, trigger, reference and content containing the GIF token when the response had one.
- `nonDestructive.test.js` still passes.

## Docs

README storage section: describe `bot_messages`; remove the "bot's own messages are not stored" known issue.

## Acceptance

`npm test` passes; no characterization test changes.
