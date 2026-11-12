# Spec 18: Paired reply examples

**Depends on:** 10, 17. **Blocks:** 19.

## Problem

The "replies to similar messages" bucket shows only what the persona said. The model cannot see what each example was a reply to, so it cannot learn how the persona reacts to a given kind of message.

## Required behaviour

### Store (`src/storage/messageStore.js`)

`getParents(ids) → Map<id, { author, content }>`: for each given filtered-message id whose `reference` points at an existing filtered message, that parent's author and content. Ids without a stored parent are absent from the map. One query per chunk of at most 500 ids.

### Retriever

The `replies` bucket becomes an array of **ReplyExample** `{ you: string, them: string | null, themAuthor: string | null }`, built from the reply-collection hits (`you` = hit document) joined with `getParents(hit ids)`. Deduplication uses `you` as the key, with the same precedence as before (`replies` first). The other three buckets stay arrays of strings.

### Prompt (`replyExamples` section)

```
Here are examples of how the user replied to messages similar to the one they just received. "them" is the other person's message and "you" is the user's reply:
<JSON.stringify(examples)>
```

where each example is serialised as `{ "them": ..., "you": ... }`, or `{ "you": ... }` when `them` is `null`. `themAuthor` is not included in the prompt.

## Edge cases

- Hit whose SQLite row has no reference or whose parent row does not exist (older data, or Chroma and SQLite out of step) → `{ you }` only.
- Two hits with identical `you` text → first (nearest) kept, including its parent.
- A text present in `replies` is removed from `similar`, `gifs` and `other` as before.
- Empty bucket → section present with `[]` (unchanged from legacy behaviour for empty buckets).

## Tests

- Unit: `getParents` (hit, no reference, missing parent, more than 500 ids, empty input); retriever builds examples and dedups on `you`; section text and JSON shape for both example forms.
- Characterization updates: `retrieval.test.js` (the first bucket holds objects; compare `you` values as before and add `them` assertions), `prompts.test.js`/`generation.test.js` (new section sentence and JSON). The `semanticSearch` subject mapping returns the new first bucket.
- Scenario (`test/scenarios/context.test.js`, extended): seeded exchange "anyone up for food" → "im down, where" by the persona; a similar incoming message produces a prompt whose reply examples contain that pair.

## Docs

README retrieval section.

## Acceptance

`npm test` passes; only the listed characterization tests change.
