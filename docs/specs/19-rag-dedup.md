# Spec 19: Deduplicating retrieved examples

**Depends on:** 15, 18. **Blocks:** 20, 21, 24.

## Problem

Retrieved examples are deduplicated only by exact string. `lol`, `LOL`, `lol ` and `lolll` all survive, near-identical sentences fill a bucket, and one habitual phrase can occupy most of the examples. Deduplicating after fetching also leaves buckets short. Nothing stops the bot from repeating what it said recently.

## Required behaviour

### Normalised key (`src/retrieval/normalize.js`, pure)

`normalizeForDedup(text) → string`:

1. Unicode NFKC, lowercase, collapse every whitespace run to one space, trim.
2. If the result starts with `<gif!`, stop here (GIF tokens are compared whole).
3. Collapse every run of 3 or more identical **letters** to one letter (`/(\p{L})\1{2,}/gu`). Digits and punctuation are never collapsed (`1000` stays `1000`).
4. Strip leading and trailing characters that are not letters, marks or digits (`[^\p{L}\p{M}\p{N}]`), then trim.
5. If that leaves an empty string (pure punctuation or emoji), the key is the step 1 text instead.

Two texts are exact-variants when their keys are equal.

### Near-duplicates (`src/retrieval/similarity.js`, pure)

`cosineSimilarity(a, b) → number` (0 when either vector is missing, empty, of different length, or zero).

### Candidates and dedup (`src/retrieval/dedupe.js`)

**Candidate:** `{ id, text, embedding: number[] | null, example? }` (`example` carries the ReplyExample for the `replies` bucket).

`dedupeBuckets(buckets: Candidate[][], { nearDuplicateThreshold, nearDuplicateMinChars }) → Kept[][]` where **Kept** is a Candidate plus `variants: string[]` (distinct original texts merged into it, its own text first). Greedy, buckets in `BUCKET_ORDER`, candidates in their given order. A candidate is merged into an already-kept item (from any bucket) and dropped when:

1. their normalised keys are equal; or
2. both have embeddings, both keys are at least `nearDuplicateMinChars` long, and `cosineSimilarity >= nearDuplicateThreshold`. (Very short messages such as `sounds good` / `sounds bad` are never merged by embedding.)

Check 1 before 2; merge into the first match. Inputs are not mutated. This replaces the exact-string `dedupeBuckets`.

### Embeddings for dedup

Embeddings always come from the **messages** collection, where each row is embedded on its own text. Rows in the replies collection are stored under their parent's embedding, so their hit embeddings must not be used.

`vectorStore.getEmbeddings(ids) → Promise<Map<id, number[]>>`: one `get({ ids, include: ['embeddings'] })` on the messages collection; `[]` → empty map without a Chroma call; ids not present are absent from the map.

### Retriever

`retrieveForReply(author, record, { queryText } = {})`:

1. Run the three vector queries with `limit * retrieval.overFetchFactor`, and `messageStore.randomMessages({ author, before, limit }) → [{ id, content }]` (replaces `randomContents`) with the over-fetched limit.
2. `getEmbeddings` once for all distinct candidate ids. If it rejects, log a warning and continue with `embedding: null` for every candidate (key-only dedup).
3. Build candidates, `dedupeBuckets`, cut each bucket to its configured limit (`replyResults`, `similarResults`, `gifResults`, `otherResults`).
4. Build ReplyExamples for the kept `replies` items (spec 18), compute `frequent` (below), and return **Buckets** `{ replies: ReplyExample[], similar: string[], gifs: string[], other: string[], frequent: [{ text, times }] }`.

`retrieveForRevive(author)` over-fetches by the same factor, dedups by normalised key only, and cuts to `reviveSamples`.

### Frequency signal

- `messageStore.countContents({ author, contents, before }) → Map<content, number>`: exact-content counts among the author's filtered messages with `timestamp < before` (chunks of at most 500).
- Additive migration, appended after the existing entries: `CREATE INDEX IF NOT EXISTS idx_filtered_messages_author_content ON filtered_messages (author, content)`.
- For every kept item (after the cut), `count` = sum of `countContents` over its `variants`. This counts only spellings seen among the retrieved candidates, so it is a lower bound.
- `frequent` = kept items with `count >= retrieval.frequentMinCount`, sorted by `count` descending (ties by first appearance), at most `retrieval.frequentLimit`, as `{ text, times }`.
- Prompt section `frequentPhrases` (reply prompts; omitted when empty), placed after `otherExamples`:

  ```
  The user sends some of these messages often. Number of times they have sent each (use them only where they fit):
  <JSON.stringify(frequent)>
  ```

### Recent bot output

- `createGenerator({ chatClient, retriever, userDirectory, botMessageStore, config, logger })`. For every reply and revive, the generator loads `botMessageStore.recent({ limit: retrieval.recentBotMessages })` and passes their `content` values (newest first) as `ctx.recentBotMessages`. A failure to load is logged as a warning and treated as an empty list.
- The bot serves a single channel (`config.discord.channelId`), so `bot_messages` needs no channel filter.
- Prompt section `avoidRepeats` (omitted when empty), last in both prompts:

  ```
  The bot you are part of recently sent these messages in the channel. Do not repeat them or reuse their distinctive phrasing:
  <JSON.stringify(recentBotMessages)>
  ```

The container passes `botMessageStore` and `logger` to the generator.

## Config

`retrieval.overFetchFactor: 3` (integer ≥ 1), `retrieval.nearDuplicateThreshold: 0.95` (in `(0, 1]`), `retrieval.nearDuplicateMinChars: 12`, `retrieval.frequentMinCount: 3`, `retrieval.frequentLimit: 10`, `retrieval.recentBotMessages: 10`. The threshold was chosen conservatively and is a tunable; note that in the README.

## Edge cases

| Texts | Result |
| --- | --- |
| `lol`, `LOL`, `lol `, `lolll`, `lol!!` | one item, five variants |
| `cool` vs `col` | distinct (a run of two is not collapsed) |
| `1000` vs `10`, `$500` vs `$50` | distinct (digits are not collapsed) |
| `<gif! cat>` vs `<gif! CAT>` | merged |
| `>:(` vs `>:)` | distinct (empty keys fall back to the text) |
| `???` vs `!!!` | distinct |
| `see you tomorrow` vs `see you tomorrow!` | merged by key |
| `ok see you tomorrow then` vs `see you tomorrow then ok` (same tokens, cosine 1 in the fake) | merged by embedding |
| `sounds good` vs `good sounds` (cosine 1, keys shorter than 12) | distinct |
| candidates without embeddings | key dedup only |

- A `replies` row whose stored (parent) embedding equals another candidate's embedding but whose own text differs → not merged (proves the messages-collection embedding is used).
- Precedence: a text in `replies` suppresses its variants in later buckets; the kept item keeps its bucket.
- Twenty near-identical nearest hits plus distinct ones further out: the bucket still reaches its limit when enough distinct candidates exist within the over-fetched set.
- `frequent` counts merge variants: `lol` ×4 and `LOL` ×2 → `{ text: 'lol', times: 6 }` (text is the kept variant).
- `getEmbeddings` rejects → warning, reply still generated.
- No bot messages yet → no `avoidRepeats` section.

## Tests

- Unit: `normalizeForDedup` (table plus idempotency); `cosineSimilarity`; `dedupeBuckets` (key merge, embedding merge, minimum length, precedence, variants, no mutation, threshold just below/at); `randomMessages`; `countContents` (with `before`); `getEmbeddings` (empty input, missing ids); retriever (over-fetch factor on all three vector queries with the GIF filter intact, cut, embedding source, failure fallback); `frequent` computation; both prompt sections; generator loads recent bot messages and tolerates failure; migration idempotent.
- Existing tests: the exact-string dedupe unit tests are rewritten for the new function; tests of `randomContents` move to `randomMessages`; retrieval characterization assertions on `nResults` become limit × 3 with results still at most the limit. The subject's `semanticSearch` keeps returning the four `BUCKET_ORDER` arrays of strings.
- Scenario (`test/scenarios/dedup.test.js`): a persona whose corpus is dominated by one phrase in several spellings → the prompt's example buckets contain it once in total, the `frequent` line reports the combined count, and after one bot reply the next prompt contains `avoidRepeats` with that reply.

## Docs

README retrieval section, including the tunables.

## Acceptance

`npm test` passes; existing tests change only where the dedup, over-fetch or bucket shape requires it.
