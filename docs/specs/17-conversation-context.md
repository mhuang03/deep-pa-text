# Spec 17: Conversation context for replies

**Depends on:** 14, 15. **Blocks:** 18, 19, 20, 21.

## Problem

The reply prompt contains only the text of the target message. The model does not know who said it, what the conversation was about, or what was said just before, and retrieval for a short message such as "why" has nothing to match on.

## Design

### Channel history adapter (`src/discord/channelHistory.js`)

`createChannelHistory({ logger })` → `fetchBefore(channel, { before, limit }) → Promise<DiscordMessage[]>`: `channel.messages.fetch({ limit, before })`, returned oldest first (sorted by `createdTimestamp`, then id). `limit` is capped at 100. A failed fetch is logged as a warning and yields `[]`.

### Transcript (`src/context/transcript.js`, pure)

**TranscriptEntry:** `{ id, speaker, content, timestamp, replyTo: string | null }` where `speaker` is a username (for a bot message, the persona it was imitating).

`buildTranscript(messages, { resolveBot, transform, maxEntryChars, notBefore }) → TranscriptEntry[]`, for Discord messages oldest first:

- a message for which `resolveBot(message)` returns `{ persona, content }` → speaker `persona`, that content;
- any other message with `author.bot` → skipped;
- otherwise speaker `author.username`, content `transform(message.content)`;
- content has newlines replaced by a single space, is trimmed, and if longer than `maxEntryChars` is cut to that length with `…` appended; entries with empty content are skipped;
- entries with `timestamp < notBefore` are skipped;
- `replyTo` is the speaker of the entry whose id equals `message.reference?.messageId`, if that entry is in the result; else `null`.

`formatTranscript(entries, { timeZone }) → string`: one line per entry, `[HH:MM] speaker: content` or `[HH:MM] speaker (replying to other): content`, 24-hour time in `timeZone`.

### Context builder (`src/context/contextBuilder.js`)

`createContextBuilder({ channelHistory, botMessageResolver, messageFilter, config })` → `forReply({ channel, target }) → Promise<{ transcript: TranscriptEntry[] }>`: fetch `context.transcriptLimit` messages before `target.id`, build the transcript with `notBefore = target.timestamp - context.maxAgeMs`. `channel` missing → `{ transcript: [] }`.

### Prompt sections (`src/llm/promptSections.js`, `src/llm/prompts.js`)

Prompts are assembled from an ordered list of pure section functions `(ctx) → string | null`; `null` sections are omitted and the rest are joined with a blank line. Later specs add sections to the list instead of editing a template.

`buildReplyPrompt(ctx)` with `ctx = { author, name, message, messageAuthor, buckets, transcript, timeZone }` uses, in order:

1. `identity`: `The user you are emulating has username "<author>", and their real name is "<name>".`
2. `transcript` (omitted when empty): `Here is the recent conversation in the channel, oldest first, for context:` then a newline and `formatTranscript(...)`.
3. `target`: `The user has just received this message from "<messageAuthor>": "<message>".`
4. `replyExamples`, 5. `similarExamples`, 6. `gifExamples`, 7. `otherExamples`: each is the legacy introductory sentence, a newline, and `JSON.stringify` of the bucket (texts unchanged from the legacy template).

`buildRevivePrompt` is expressed with the same mechanism (`identity`, then the legacy examples sentence and list) and keeps its legacy output apart from the blank-line joining.

### Context-aware retrieval query (`src/retrieval/queryText.js`, pure)

`buildQueryText(record, transcript, { shortMessageChars, queryContextMessages }) → string`: when `record.content.length >= shortMessageChars`, the content; otherwise the contents of the last `queryContextMessages` transcript entries followed by the content, joined with newlines.

`retriever.retrieveForReply(author, record, { queryText } = {})` embeds `queryText ?? record.content`. Persona selection is unchanged (it still queries with the target content only).

### Pipeline

- `responder.respond` request gains `channel`. For triggers with a target it calls `contextBuilder.forReply({ channel, target })` before composing and passes `context` through `composer.compose({ persona, target, context })` to `generator.generateReply(persona, record, context)`.
- The generator computes `queryText`, retrieves, and builds the prompt with `transcript`, `messageAuthor: record.author`, `timeZone: config.context.timeZone`.
- Handlers pass `channel` (`message.channel`, or `targetMessage.channel` for the command).

## Config

`context.transcriptLimit: 20`, `context.maxEntryChars: 300`, `context.maxAgeMs: 21600000` (6 h), `context.timeZone: 'America/Chicago'`, `retrieval.shortMessageChars: 25`, `retrieval.queryContextMessages: 2`.

Add `context/` to the use-case layer list in `CLAUDE.md`.

## Harness change

- Fake channel keeps `history`: every message emitted in it through `emitMessage` and every bot message produced by `reply`/`send`/`editReply`, in order. `channel.messages.fetch({ limit, before })` resolves to a `Map` (id → message, newest first, like a discord.js Collection) of the `limit` newest messages older than `before` (all history when `before` is absent). `channel.messages.setFailing(error | null)`; `channel.messages.calls`.
- `world.addHistory(fields)` appends a message to history without emitting an event (pre-existing conversation); fake bot messages keep the `embeds` they were sent with.

## Edge cases

- No history → no transcript section; prompt still valid.
- History fetch rejects → warning logged, reply still sent without a transcript.
- A previous bot reply in the window appears under its persona's username with its stored content (GIF token included).
- A bot message with no stored row and no persona embed, and messages from other bots, do not appear.
- A message older than 6 h before the target does not appear.
- A reply inside the window shows `(replying to <speaker>)`; a reply to something outside the window shows no suffix.
- Mentions and URLs in transcript lines are transformed like corpus content.
- Target `why` with previous lines `are we still going friday` / `i cant make it`: the embedded query text is the three lines joined; a 40-character target is embedded alone.
- Command trigger: transcript is the history before the selected target message, not before "now".

## Tests

- Unit: `fetchBefore` (ordering, cap, failure); `buildTranscript` (each rule above); `formatTranscript` (time zone, reply suffix); every prompt section; `buildReplyPrompt` full-string equality with and without a transcript; `buildQueryText` boundaries (24/25 characters, fewer entries than requested); retriever embeds `queryText`; context builder window and age cut-off.
- Characterization updates: `prompts.test.js` and `generation.test.js` assert the new template (identity, target line naming the sender, blank-line joining); the `ragInput` subject mapping takes the new context shape. State the change in the commit.
- Scenario (`test/scenarios/context.test.js`): a three-message conversation then a replied-to message → the LLM user prompt contains the three transcript lines in order with times and speakers, and the target line names the sender; history failure; bot message attribution; short-target query text (assert the text passed to the fake embedding function).

## Docs

README retrieval and prompting section.

## Acceptance

`npm test` passes; only the listed characterization tests change.
