# Spec 17: Conversation context for replies

**Depends on:** 14, 15. **Blocks:** 18, 19, 20, 21.

## Problem

The reply prompt contains only the text of the target message. The model does not know who said it, what the conversation was about, or what was said just before, and retrieval for a short message such as "why" has nothing to match on.

## Design

### Channel history adapter (`src/discord/channelHistory.js`)

`createChannelHistory({ logger })` → `fetchBefore(channel, { before, limit }) → Promise<DiscordMessage[]>`: `channel.messages.fetch({ limit, before })` returns a collection ordered newest first; the adapter returns its values reversed (oldest first) without re-sorting. `limit` is capped at 100 (Discord's page size). A failed fetch is logged as a warning and yields `[]`. A `before` id that no longer exists is still accepted by Discord.

### Transcript (`src/context/transcript.js`, pure)

**TranscriptEntry:** `{ id, speaker, content, timestamp, replyTo: string | null }` where `speaker` is a username (for a bot message, the persona it was imitating).

`buildTranscript(messages, { resolveBot, transform, maxEntryChars, notBefore }) → TranscriptEntry[]`, for Discord messages oldest first:

- a message for which `resolveBot(message)` returns `{ persona, content }` → speaker `persona`, content `transform(content)` (stored content keeps its GIF tokens through the transform; content from the embed fallback gets URLs and mentions cleaned);
- any other message with `author.bot` → skipped;
- otherwise speaker `author.username`, content `transform(message.content)`;
- content then has newlines replaced by a single space and is trimmed; entries whose content is now empty (attachment-only or mention-only messages) are skipped; content longer than `maxEntryChars` is cut to `maxEntryChars` characters and `…` is appended;
- entries with `timestamp < notBefore` are skipped;
- `replyTo` is the speaker of the entry whose id equals `message.reference?.messageId`, if that entry is in the result; else `null`.

`formatTranscript(entries, { timeZone }) → string`: one line per entry, `[HH:MM] <speaker>: <content>`, or `[HH:MM] <speaker> (replying to <replyTo>): <content>` when `replyTo` is set. The time comes from `Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone })` (midnight is `00:05`, never `24:05`).

### Context builder (`src/context/contextBuilder.js`)

`createContextBuilder({ channelHistory, botMessageResolver, messageFilter, config })` → `forReply({ channel, target }) → Promise<{ transcript: TranscriptEntry[] }>`: fetch `context.transcriptLimit` messages before `target.id`, build the transcript with `resolveBot: botMessageResolver.resolve`, `transform: messageFilter.transform` and `notBefore = target.timestamp - context.maxAgeMs`. `channel` missing → `{ transcript: [] }`.

`src/context/` is a use-case layer module: it imports only `src/discord/channelHistory.js` types and pure helpers; the resolver (which lives in `src/bot/`) is injected, never imported.

### Prompt sections (`src/llm/promptSections.js`, `src/llm/prompts.js`)

Prompts are assembled from an ordered list of pure section functions `(ctx) → string | null`; `null` sections are omitted and the rest are joined with a blank line. Later specs add sections to the list instead of editing a template.

`buildReplyPrompt(ctx)` with `ctx = { author, name, message, messageAuthor, buckets, transcript, timeZone }` uses, in order:

1. `identity`: `The user you are emulating has username "<author>", and their real name is "<name>".`
2. `transcript` (omitted when empty): `Here is the recent conversation in the channel, oldest first, for context:` then a newline and `formatTranscript(...)`.
3. `target`: `The user has just received this message from "<messageAuthor>": "<message>".`
4. `replyExamples`, 5. `similarExamples`, 6. `gifExamples`, 7. `otherExamples`: each is the legacy introductory sentence, a newline, and `JSON.stringify` of the bucket (texts unchanged from the legacy template).

`buildRevivePrompt` is expressed with the same mechanism (`identity`, then the legacy examples sentence and list). Its output is byte-identical to today's (the legacy template already separates the two parts with a blank line), so the revive characterization tests keep passing unchanged.

Expected reply prompt with a two-line transcript, as a literal for the unit test (bucket contents elided):

```
The user you are emulating has username "bob", and their real name is "Bob Example".

Here is the recent conversation in the channel, oldest first, for context:
[12:01] alice: anyone around
[12:02] carol (replying to alice): yeah whats up

The user has just received this message from "alice": "want to get food".

Here are some examples of messages that the user has sent in response to messages that are similar in semantic meaning to the message they just received:
[...]
```

followed by the remaining three example sections, each separated by a blank line.

### Context-aware retrieval query (`src/retrieval/queryText.js`, pure)

`buildQueryText(record, transcript, { shortMessageChars, queryContextMessages }) → string`: when `record.content.length >= shortMessageChars` (the content is already transformed), or `queryContextMessages` is 0, or the transcript is empty, the content; otherwise the contents of the last `queryContextMessages` transcript entries (bot persona lines included) followed by the content, joined with newlines.

`retriever.retrieveForReply(author, record, { queryText } = {})` embeds `queryText ?? record.content`. Persona selection is unchanged (it still queries with the target content only).

### Pipeline

- `createResponder({ composer, delivery, contextBuilder, botMessageStore, now, logger })`. The `respond` request gains `channel`. For triggers with a target the responder calls `contextBuilder.forReply({ channel, target })` before composing and passes the result as `composer.compose({ persona, target, context })`, which forwards it to `generator.generateReply(persona, record, context = {})`.
- `createGenerator({ chatClient, retriever, userDirectory, config })`. `generateReply` computes `queryText`, calls `retriever.retrieveForReply(author, record, { queryText })`, and builds the prompt with `transcript: context.transcript ?? []`, `messageAuthor: record.author`, `timeZone: config.context.timeZone`.
- Handlers pass `channel` (`message.channel`, or `targetMessage.channel` for the command).
- The container builds `channelHistory` and `contextBuilder` and returns `contextBuilder`.
- Subject surface (`test/support/boot.js`): `ragInput(author, name, message, replies, similar, gifs, other, { messageAuthor, transcript = [] } = {})` maps onto `buildReplyPrompt`.

## Config

`context.transcriptLimit: 20`, `context.maxEntryChars: 300`, `context.maxAgeMs: 21600000` (6 h), `context.timeZone: 'America/Chicago'`, `retrieval.shortMessageChars: 25`, `retrieval.queryContextMessages: 2`.

Add `context/` to the use-case layer list in `CLAUDE.md`.

## Harness change

- Fake channel keeps `history`: every message emitted in it through `emitMessage` and every bot message produced by `reply`/`send`/`editReply`, in order of occurrence. `channel.messages.fetch({ limit, before })` resolves to a `Map` (id → message, newest first, like a discord.js Collection) of the `limit` messages that precede, in the history array, the message whose id equals `before` (the newest `limit` of all history when `before` is absent or unknown). `channel.messages.setFailing(error | null)`; `channel.messages.calls`.
- Existing tests that emit several messages in one channel now see a transcript in later prompts. Update the assertions that this changes (for example the target line and whole-prompt comparisons); do not suppress the transcript.
- `world.addHistory(fields)` appends a message to history without emitting an event (pre-existing conversation); fake bot messages keep the `embeds` they were sent with.

## Edge cases

- No history → no transcript section; prompt still valid.
- History fetch rejects → warning logged, reply still sent without a transcript.
- A previous bot reply in the window appears under its persona's username with its stored content (GIF token included).
- A bot message with no stored row and no persona embed, and messages from other bots, do not appear.
- A message older than 6 h before the target does not appear.
- A reply inside the window shows `(replying to <speaker>)`; a reply to something outside the window, or to the target itself, shows no suffix.
- A mention-only message in the window is skipped.
- An entry of 400 characters appears as its first 300 characters followed by `…`.
- Mentions and URLs in transcript lines are transformed like corpus content.
- Target `why` with previous lines `are we still going friday` / `i cant make it`: the embedded query text is the three lines joined; a 40-character target is embedded alone.
- Command trigger: transcript is the history before the selected target message, not before "now".

## Tests

- Unit: `fetchBefore` (ordering, cap, failure); `buildTranscript` (each rule above); `formatTranscript` (time zone, reply suffix); every prompt section; `buildReplyPrompt` full-string equality with and without a transcript; `buildQueryText` boundaries (24/25 characters, fewer entries than requested); retriever embeds `queryText`; context builder window and age cut-off.
- Characterization updates: `prompts.test.js` and `generation.test.js` assert the new template (identity, target line naming the sender, blank-line joining); the `ragInput` subject mapping takes the new context shape. State the change in the commit.
- Scenario (`test/scenarios/context.test.js`): a three-message conversation then a replied-to message → the LLM user prompt contains the three transcript lines in order with times and speakers, and the target line names the sender; history failure; bot message attribution; short-target query text (assert the text passed to the fake embedding function).

## Docs

README retrieval and prompting section. State plainly that up to `context.transcriptLimit` recent channel messages, including those of people not listed in `users.json`, are now sent to the LLM provider as context (previously only the target message was).

## Acceptance

`npm test` passes; existing tests change only where the prompt format or the presence of a transcript requires it.
