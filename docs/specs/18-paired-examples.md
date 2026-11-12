# Spec 18: Paired reply examples

**Depends on:** 10, 17. **Blocks:** 19.

## Problem

The "replies to similar messages" bucket shows only what the persona said. The model cannot see what each example was a reply to, so it cannot learn how the persona reacts to a given kind of message.

## Required behaviour

### Store (`src/storage/messageStore.js`)

`getParents(ids) → Map<id, { content }>`: for each given filtered-message id whose `reference` points at an existing filtered message, that parent's stored content (GIF tokens included). Ids without a stored parent are absent from the map. Empty input returns an empty map without touching the database; otherwise one query per chunk of at most 500 ids (statement built for the chunk's size). Spec 24 later adds visibility filtering here.

### Retriever

The `replies` bucket becomes an array of **ReplyExample** `{ you: string, them: string | null }`. The retriever keeps `{ id, document }` for the reply-collection hits, deduplicates exactly as today on the document strings (`replies` first in precedence), then calls `getParents` once with the ids of the surviving hits and builds each example (`you` = hit document, `them` = parent content or `null`). When two hits share a document, the nearest one's id is used. The other three buckets stay arrays of strings. `retrieveForReply` returns the new shape; `generator` and `prompts` pass it through.

An explicit self-reply (parent by the same author) is kept as a normal pair.

### Prompt (`replyExamples` section)

```
Here are examples of how the user replied to messages similar to the one they just received. "them" is the message the user was responding to and "you" is the user's reply:
<JSON.stringify(examples)>
```

where each example is serialised with `them` first: `{ "them": ..., "you": ... }`, or `{ "you": ... }` when `them` is `null`. `them` is cut to `config.context.maxEntryChars` characters with `…` appended when longer (the spec 17 rule).

## Edge cases

- Hit whose SQLite row has no reference or whose parent row does not exist (older data, or Chroma and SQLite out of step) → `{ you }` only.
- Two hits with identical `you` text → first (nearest) kept, including its parent.
- A text present in `replies` is removed from `similar`, `gifs` and `other` as before.
- Empty bucket → the section is present with `[]`, as today.
- A reply-collection row whose id is not in SQLite at all (seeded only in Chroma) → `{ you }` only.

## Tests

- Unit: `getParents` (hit, no reference, missing parent, more than 500 ids, empty input); retriever builds examples and dedups on `you`; section text and JSON shape for both example forms.
- Characterization and unit updates: the subject's `semanticSearch` keeps returning four arrays of strings (the first mapped to the `you` values), so `retrieval.test.js` is unchanged; `prompts.test.js`/`generation.test.js` and the unit tests for `retriever`, `generator` and `prompts` take the new section sentence and JSON shape. The subject's `ragInput` accepts either strings or ReplyExamples in its `replies` argument (strings become `{ you }`).
- Scenario (`test/scenarios/context.test.js`, extended): seeded exchange "anyone up for food" → "im down, where" by the persona; a similar incoming message produces a prompt whose reply examples contain exactly `{"them":"anyone up for food","you":"im down, where"}`; a Chroma-only reply row appears as `{"you":...}`.

## Docs

README retrieval section.

## Acceptance

`npm test` passes; existing tests change only where the reply-example shape requires it.
