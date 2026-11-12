# Spec 19: Deduplicating retrieved examples

**Depends on:** 15, 18. **Blocks:** 20, 21, 24.

## Problem

Retrieved examples are deduplicated only by exact string. `lol`, `LOL`, `lol ` and `lolll` all survive, near-identical sentences fill a bucket, and one habitual phrase can occupy most of the examples. Deduplicating after fetching also leaves buckets short. Nothing stops the bot from repeating what it said recently.

## Required behaviour

### Normalised key (`src/retrieval/normalize.js`, pure)

`normalizeForDedup(text) → string`: Unicode NFKC; lowercase; collapse every whitespace run to one space; collapse every run of 3 or more identical characters to one character; strip leading and trailing characters that are not letters, digits or `<`/`>` (so GIF tokens keep their brackets); trim. Two texts are exact-variants when their keys are equal and non-empty; a text with an empty key (pure punctuation or emoji) uses the trimmed original text as its key.

### Near-duplicates (`src/retrieval/similarity.js`, pure)

`cosineSimilarity(a, b) → number` (0 when either vector is missing or zero-length).

### Candidates and dedup (`src/retrieval/dedupe.js`)

**Candidate:** `{ id, text, embedding: number[] | null, example? }` (`example` carries the ReplyExample for the `replies` bucket).

`dedupeBuckets(buckets: Candidate[][], { nearDuplicateThreshold }) → Kept[][]` where **Kept** is a Candidate plus `variants: string[]` (distinct original texts merged into it, itself first). Greedy, buckets in `BUCKET_ORDER`, candidates in their given order. A candidate is merged into an already-kept item (from any bucket) and dropped when:

1. their normalised keys are equal; or
2. both have embeddings and `cosineSimilarity >= nearDuplicateThreshold`.

Check 1 before 2; merge into the first match. Inputs are not mutated.

### Retriever

- Vector queries request `limit * retrieval.overFetchFactor` hits with embeddings (`vectorStore.query(..., { includeEmbeddings: true })` adds `embedding` to each Hit).
- The `other` bucket uses `messageStore.randomMessages({ author, before, limit }) → [{ id, content }]` (replacing `randomContents`) with the over-fetched limit, and `vectorStore.getEmbeddings(ids) → Map<id, embedding>` (messages collection `get`); ids missing from Chroma get `embedding: null`.
- After `dedupeBuckets`, each bucket is cut to its configured limit (`replyResults`, `similarResults`, `gifResults`, `otherResults`).
- `retrieveForRevive` over-fetches by the same factor, dedups by normalised key only, and cuts to `reviveSamples`.

### Frequency signal

- `messageStore.countContents({ author, contents }) → Map<content, number>`: exact-content counts among the author's filtered messages (chunks of at most 500).
- Additive migration: `CREATE INDEX IF NOT EXISTS idx_filtered_messages_author_content ON filtered_messages (author, content)`.
- For every kept item (after the cut), `count` = sum of `countContents` over its `variants`.
- `Buckets.frequent: [{ text, times }]` = kept items with `count >= retrieval.frequentMinCount`, sorted by `count` descending (ties by first appearance), at most `retrieval.frequentLimit`.
- Prompt section `frequentPhrases` (reply prompts; omitted when empty), placed after `otherExamples`:

  ```
  The user sends some of these messages often. Number of times they have sent each:
  <JSON.stringify(frequent)>
  ```

### Recent bot output

- The generator loads `botMessageStore.recent({ limit: retrieval.recentBotMessages })` and passes their `content` values (newest first) as `ctx.recentBotMessages` to both the reply and revive prompts.
- Prompt section `avoidRepeats` (omitted when empty), last in both prompts:

  ```
  The bot you are part of recently sent these messages in the channel. Do not repeat them or reuse their distinctive phrasing:
  <JSON.stringify(recentBotMessages)>
  ```

## Config

`retrieval.overFetchFactor: 3`, `retrieval.nearDuplicateThreshold: 0.95`, `retrieval.frequentMinCount: 3`, `retrieval.frequentLimit: 10`, `retrieval.recentBotMessages: 10`.

## Edge cases

| Texts | Result |
| --- | --- |
| `lol`, `LOL`, `lol `, `lolll`, `lol!!` | one item, five variants |
| `cool` vs `col` | distinct (a run of two is not collapsed) |
| `<gif! cat>` vs `<gif! CAT>` | merged |
| `???` vs `!!!` | distinct (empty keys fall back to the text) |
| `see you tomorrow` vs `see you tomorrow!` (identical fake embeddings) | merged by key |
| `ok see you tomorrow then` vs `see you tomorrow then ok` (same tokens, cosine 1) | merged by embedding |
| candidates without embeddings | key dedup only |

- Precedence: a text in `replies` suppresses its variants in later buckets; the kept item keeps its bucket.
- Twenty near-identical nearest hits plus distinct ones further out: the bucket still reaches its limit when enough distinct candidates exist within the over-fetched set.
- `frequent` counts merge variants: `lol` ×4 and `LOL` ×2 → `{ text: 'lol', times: 6 }` (text is the kept variant).
- No bot messages yet → no `avoidRepeats` section.

## Tests

- Unit: `normalizeForDedup` (table plus idempotency); `cosineSimilarity`; `dedupeBuckets` (key merge, embedding merge, precedence, variants, no mutation, threshold boundary just below/at); `randomMessages`; `countContents`; `getEmbeddings`; retriever over-fetch and cut; `frequent` computation; both prompt sections.
- Characterization updates: `retrieval.test.js` limit assertions become "queried with `nResults` = limit × 3 and returns at most limit"; dedup tests gain the variant cases. `nonDestructive.test.js` still passes with the new index migration.
- Scenario (`test/scenarios/dedup.test.js`): a persona whose corpus is dominated by one phrase in several spellings → the prompt's example buckets contain it once in total, the `frequent` line reports the combined count, and after one bot reply the next prompt contains `avoidRepeats` with that reply.

## Docs

README retrieval section.

## Acceptance

`npm test` passes; only the listed characterization tests change.
