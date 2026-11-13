# Spec 34: Topic bank

**Depends on:** 33. **Blocks:** 35.

## Why

Scripted conversations (spec 35) need something to talk about. A topic drawn from a handful of random messages is usually mundane, stale or repeated. The message embeddings already encode what this group talks about: clustering them finds the recurring subjects, and an LLM can name each one. The result is a **topic bank**: a list the maintainer can read, built once in a while outside the bot, from which a conversation picks.

Decisions already made with the maintainer:

- Topics come from clustering message embeddings, with an LLM call per cluster on a representative list of its messages.
- Very short messages (`yes`, `yeah`) must not be able to form topics.
- Clustering runs in a script, never inside the bot. Measured plain-JavaScript k-means at 512 dimensions: 2,000 messages 0.3 s, 10,000 messages 7 s, 30,000 messages 33 s. The bot is single-threaded.
- When the bank is empty the bot falls back to a neighbourhood search at conversation time (no clustering).
- Messages that historically restarted a quiet channel are offered as a second source of openers.

## Overview

```
npm run topics            sample eligible messages → fetch stored embeddings → k-means
                          → filter clusters → LLM labels each → append to the topic bank

conversation time         topicSource.candidates()  = weighted sample from the bank,
(spec 35)                                             or, if the bank is empty, one seeded neighbourhood
```

Nothing is embedded again: the script reads the embeddings already stored in Chroma.

## Layering

- `src/topics/` is a new level-2 service directory (add it to the table in `CLAUDE.md` and to `test/unit/layering.test.js`). It receives the chat client, stores and vector store by injection and imports only level 0 and level 1 modules.
- Pure maths and text helpers go to level 0: `src/util/kmeans.js`, `src/text/topicEligibility.js`, `src/text/jsonObject.js`.

## Eligibility (`src/text/topicEligibility.js`, pure)

`topicText(content) → string`: the content with GIF tokens (`<gif! …>`), emoji names (`:name:`), `@name` mentions and every character that is not a letter, digit, apostrophe or whitespace removed, whitespace collapsed, trimmed.

`isTopicEligible(content, { minWords, minChars }) → boolean`: `topicText(content)` has at least `minWords` whitespace-separated words and at least `minChars` characters.

This is the first of three guards against filler. With the defaults (5 words, 25 characters) `yes`, `yeah lol`, `ok sounds good` and a bare GIF can never enter a cluster.

## Storage (additive migrations; `src/storage/topicStore.js`)

```sql
CREATE TABLE IF NOT EXISTS topic_builds (
  build_id     TEXT PRIMARY KEY,
  completed_at INTEGER NOT NULL,
  stats        TEXT NOT NULL            -- JSON of the build report
)
CREATE TABLE IF NOT EXISTS topics (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id         TEXT NOT NULL,
  label            TEXT NOT NULL,
  summary          TEXT NOT NULL,
  size             INTEGER NOT NULL,    -- messages in the cluster
  author_count     INTEGER NOT NULL,
  cohesion         REAL NOT NULL,       -- mean cosine similarity of members to the centroid
  median_timestamp INTEGER NOT NULL,
  deleted_at       INTEGER              -- set by --hide
)
CREATE INDEX IF NOT EXISTS idx_topics_build ON topics (build_id)
CREATE TABLE IF NOT EXISTS topic_authors (
  topic_id INTEGER NOT NULL,
  author   TEXT NOT NULL,
  share    REAL NOT NULL,               -- this author's fraction of the cluster
  newest_timestamp INTEGER NOT NULL,
  PRIMARY KEY (topic_id, author)
)
CREATE TABLE IF NOT EXISTS topic_messages (
  topic_id   INTEGER NOT NULL,
  message_id TEXT NOT NULL,             -- corpus row id of a representative message
  rank       INTEGER NOT NULL,          -- 0 is closest to the centroid
  PRIMARY KEY (topic_id, message_id)
)
```

The bank is **append-only**. Each run writes its topics under a new `build_id` and inserts its `topic_builds` row last. The **current bank** is the visible topics (`deleted_at IS NULL`) of the newest row in `topic_builds`. A run that dies midway leaves topic rows whose build never completed; they are ignored. Earlier builds stay in the table. No row is ever updated except the `deleted_at` marker.

`createTopicStore({ db })` →

- `insertTopic({ buildId, label, summary, size, authorCount, cohesion, medianTimestamp, authors, messages }) → id`, one transaction for the topic and its author and message rows;
- `completeBuild({ buildId, completedAt, stats })`;
- `currentBuild() → { buildId, completedAt } | null`;
- `currentTopics() → Topic[]`, each `{ id, label, summary, size, authorCount, cohesion, medianTimestamp, authors: [{ author, share, newestTimestamp }] }`;
- `samplesOf(topicId, limit) → [{ author, text }]`: the representative messages in rank order, joined to **visible** corpus rows (a since-deleted message simply disappears), at most `limit`;
- `hide(id, at) → boolean` (sets `deleted_at` where it is `NULL`).

`messageStore` gains:

- `topicSample({ minChars, sinceMs, recentLimit, olderLimit }) → [{ id, author, content, timestamp }]`: up to `recentLimit` random visible corpus rows with `LENGTH(content) >= minChars` and `timestamp >= sinceMs`, plus up to `olderLimit` such rows older than `sinceMs` (two `ORDER BY RANDOM() LIMIT ?` statements);
- `randomCorpus({ minChars, limit }) → [{ id, author, content, timestamp }]`: random visible corpus rows of any author with `LENGTH(content) >= minChars`;
- `randomStartersAll({ minGapMs, limit }) → [{ author, content }]`: the existing starter query (spec 32) without the author condition.

`vectorStore.getEmbeddings(ids, { batch = false } = {})`: with `batch: true` the call uses `chroma.batchTimeoutMs`.

## Clustering (`src/util/kmeans.js`, pure)

`kmeans({ vectors, dimensions, clusters, iterations, random }) → { assignments: Int32Array, centroids: Float32Array, cohesion: Float32Array }`

- `vectors` is a `Float32Array` of `count × dimensions`, each row already scaled to unit length (the caller normalises; a zero vector is dropped before clustering). Similarity is the dot product (spherical k-means).
- Seeding is k-means++: the first centre is a random row; each next centre is a row drawn with probability proportional to `1 − (similarity to its nearest chosen centre)`. All randomness comes from the injected `random`.
- Each iteration assigns every row to its most similar centre, then recomputes each centre as the normalised mean of its rows. A centre left with no rows is re-seeded from the row least similar to its own centre. It stops after `iterations` rounds or when no assignment changed.
- `cohesion[c]` is the mean similarity of cluster `c`'s rows to its centre.

`clusterCount(count, { clusterDivisor, minClusters, maxClusters }) → number`: `Math.round(Math.sqrt(count / clusterDivisor))` clamped to the two bounds, and never more than `count`.

## Building the bank (`src/topics/`)

`createTopicBuilder({ messageStore, vectorStore, topicStore, chatClient, userDirectory, random, clock, config, logger })` → `run({ dryRun = false, maxMessages = config.topics.maxMessages }) → Promise<Report>`.

1. **Sample.** `topicSample` with `recentLimit = round(maxMessages × recentShare)`, `olderLimit = maxMessages − recentLimit`, `sinceMs = now − recentWindowMs`, `minChars`.
2. **Filter.** Keep rows that pass `isTopicEligible`. Then count each row's `normalizeForDedup` key over the kept rows and drop every row whose key occurs more than `maxPhraseRepeats` times (stock phrases).
3. **Embeddings.** `vectorStore.getEmbeddings(ids, { batch: true })` in pages of `embeddingPageSize`; rows without a stored embedding are dropped and counted. The vectors are copied into one `Float32Array` and normalised. The dimension is taken from the first embedding. Fewer than `minClusters × minClusterSize` rows left → stop with `reason: 'too-few-messages'` (nothing written).
4. **Cluster.** `kmeans` with `clusterCount(...)` and `config.topics.iterations`.
5. **Filter clusters** (`src/topics/clusterFilter.js`, pure). A cluster is kept when it has at least `minClusterSize` rows, at least `Math.min(minAuthors, number of users in the directory)` distinct authors, and a median `topicText` length of at least `minMedianChars`. The kept clusters are ordered by cohesion, highest first, and cut to `maxLabelled`.
6. **Representatives.** For each kept cluster: its rows ordered by similarity to the centre, deduplicated by `normalizeForDedup` key, with at most `ceil(representatives / 2)` from any one author, cut to `representatives`.
7. **Label.** One `chatClient.complete({ system: TOPIC_LABEL_SYSTEM_PROMPT, user })` per cluster, one after another, where `user` is `JSON.stringify` of the representatives as `[{ "author": …, "text": … }]`. The answer is parsed with `parseJsonObject`; it must have boolean `usable` and, when usable, non-empty string `topic` and `summary`. An unusable cluster is counted as `rejected`; an unparseable answer or a failed call is logged, counted as `failed`, and does not stop the run. `topic` is cut to `maxLabelChars`, `summary` to `maxSummaryChars`. A cluster whose label has the same `normalizeForDedup` key as one already accepted in this run is counted as `duplicate` and skipped.
8. **Store.** Unless `dryRun`: `insertTopic` for each accepted cluster as it is labelled, then `completeBuild`. `buildId` is `t` followed by the UTC timestamp `YYYYMMDDHHMMSS`.

With `dryRun`, steps 7 and 8 are skipped entirely: no LLM call and no write. The report then carries, for each kept cluster, its size, author count, cohesion and its first five representatives, so the thresholds can be tuned by eye.

`Report = { buildId, sampled, eligible, embedded, clusters, kept, labelled, rejected, duplicate, failed, reason?, preview? }`.

`TOPIC_LABEL_SYSTEM_PROMPT` (`src/topics/topicPrompts.js`):

```
You label groups of chat messages from a private Discord server. You are given messages that an algorithm grouped because they are about similar things. Decide whether they share a subject that these people could have a conversation about.

Reply with a single JSON object and nothing else:
{"usable": true or false, "topic": "<at most 8 words>", "summary": "<one or two sentences on what people say about it>"}

Set "usable" to false when the messages are reactions or acknowledgements, greetings, scheduling or logistics, commands for bots, game results, or have no subject in common; "topic" and "summary" may then be empty strings. Do not put people's names in the topic.
```

`parseJsonObject(text) → object | null` (`src/text/jsonObject.js`): parses the text between the first `{` and the last `}`; `null` when there is none or it is not valid JSON or not a plain object.

## Topic candidates at conversation time (`src/topics/topicSource.js`)

`createTopicSource({ topicStore, messageStore, vectorStore, userDirectory, random, clock, config, logger })` →

`candidates({ limit, excludeTopicIds = [], excludeLabels = [] }) → Promise<TopicCandidate[]>`

**TopicCandidate:** `{ topicId: number | null, label: string | null, summary: string | null, authors: [{ author, share, newestTimestamp }], samples: [{ author, text }] }`.

1. **From the bank.** Take `currentTopics()`; drop topics whose id is in `excludeTopicIds` or whose label key is among the keys of `excludeLabels`; keep only authors that are in the user directory and drop topics left with fewer than two. Draw up to `limit` topics without replacement, each draw with probability proportional to `weight = max(recencyFloor, 0.5 ** (age / recencyHalfLifeMs)) × Math.log(1 + size)`, `age = now − medianTimestamp` (one `random()` call per draw). Each gets `samples = samplesOf(id, conversationSamples)`; a topic with no remaining samples is dropped.
2. **Fallback, only when step 1 yields nothing** (`src/topics/neighbourhood.js`): take `randomCorpus({ minChars, limit: fallbackSeeds × 4 })`, keep eligible rows, use the first `fallbackSeeds` as seeds. For each seed: its stored embedding (`getEmbeddings([id])`; skip the seed if it has none), then `vectorStore.query('messages', { embedding, limit: neighbourhoodSize })` with no `where`; drop hits hidden in SQLite (`messageStore.hiddenIds`) and hits whose document is not eligible; drop authors not in the directory. A neighbourhood qualifies with at least `minNeighbours` remaining hits from at least two authors; its score is `hits × distinct authors`. The best one becomes a single candidate with `topicId: null`, `label: null`, `summary: null`, `authors` (share by hit count, newest by `metadata.timestamp`) and `samples` (its nearest `conversationSamples` hits). No qualifying neighbourhood → `[]`. A vector-store failure here is logged and yields `[]`.

`openers({ limit }) → [{ author, text }]`: `randomStartersAll` (over-fetched by `retrieval.overFetchFactor`), eligible rows only, deduplicated by key, authors in the directory, cut to `limit`. A failure is logged and yields `[]`.

`bankStatus() → { topics: number, completedAt: number | null, stale: boolean }` (`stale` when there is no completed build or it is older than `topics.maxAgeMs`). The bot logs one line at `ClientReady` when the bank is empty or stale, saying to run `npm run topics`.

The container builds `topicStore`, `topicSource` and `topicBuilder` and returns all three.

## Script (`scripts/topics.js`, `npm run topics`)

```
npm run topics -- [--dry-run] [--max-messages <n>] [--list] [--hide <id>]
```

- No options: build the bank and print the report.
- `--dry-run`: cluster and print the preview; no LLM call, nothing written.
- `--max-messages <n>`: integer ≥ 1; overrides `topics.maxMessages`.
- `--list`: print the current bank (id, label, size, authors, median date, summary), newest build only; needs neither Chroma nor the LLM.
- `--hide <id>`: hide one topic; prints whether it was found.
- `parseTopicsArgs(argv)` (pure, `src/topics/args.js`); unknown or invalid options print the usage and exit 2; `--list` and `--hide` cannot be combined with the build options.

Required variables (`assertRequired` purpose `topics`): `DEEPSEEK_API_KEY` and the embedding key variable for a build; none for `--list`, `--hide` and `--dry-run` beyond what constructing the container needs (the embedding key). The script does not log in to Discord. It only reads Chroma and only inserts into SQLite, so it may run while the bot is running (the busy timeout covers the brief overlaps); it is CPU-heavy for a minute or so.

## Config

```
topics:
  maxMessages 30000 (≥ 1)        recentWindowMs 31536000000 (365 days)   recentShare 0.6 (0 to 1)
  minWords 5 (≥ 1)               minChars 25 (≥ 1)                        maxPhraseRepeats 2 (≥ 1)
  clusterDivisor 2 (> 0)         minClusters 5 (≥ 2)                      maxClusters 120 (≥ minClusters)
  iterations 15 (≥ 1)            minClusterSize 15 (≥ 2)                  minAuthors 3 (≥ 2)
  minMedianChars 40 (≥ 0)        maxLabelled 60 (≥ 1)                     representatives 20 (≥ 2)
  embeddingPageSize 500 (1 to 1000)   maxLabelChars 80                    maxSummaryChars 300
  recencyHalfLifeMs 15552000000 (180 days, > 0)   recencyFloor 0.1 (0 to 1)   maxAgeMs 7776000000 (90 days, > 0)
  conversationSamples 8 (≥ 1)    fallbackSeeds 6 (≥ 1)                    neighbourhoodSize 30 (≥ 2)
  minNeighbours 8 (≥ 2)
```

All validated by `assertTopics` as in spec 27. No environment overrides.

## Edge cases

- A corpus where one theme is hundreds of `yeah` / `lol nice` messages and another is real sentences about a game: no cluster contains the short messages; the game theme becomes a topic.
- A phrase of five or more words repeated twenty times by one person (a catchphrase) is dropped by the repeat rule.
- A cluster written by a single author is rejected by the author rule; with a two-person directory the rule requires two authors.
- A cluster of long messages with no common subject is rejected by the LLM (`usable: false`) and counted.
- The LLM answers with prose around the JSON → parsed; with invalid JSON → `failed`, the run continues; the chat client throws for one cluster → `failed`, the run continues.
- Two clusters labelled `Weekend plans` and `weekend plans!` → the second is a duplicate.
- Rows whose embedding is missing from Chroma are skipped and counted, not embedded.
- Too few eligible messages → report with `reason: 'too-few-messages'`; the bank is unchanged.
- A build interrupted after three topics → those rows exist, no `topic_builds` row; `currentTopics()` still returns the previous build's topics.
- A second build → `currentTopics()` returns only the new build's topics; the old rows still exist.
- `--hide 12` → topic 12 no longer appears in `currentTopics()`; its row still exists with `deleted_at` set; hiding again changes nothing.
- A representative message deleted after the build → absent from `samplesOf`; a topic whose samples are all gone is not offered.
- `candidates` with every bank topic excluded or with fewer than two directory authors → falls back to a neighbourhood.
- Fallback with a corpus of unrelated one-off messages → `[]`.
- Chroma down during the fallback → warning, `[]`.
- `--dry-run` makes no LLM call and leaves every table unchanged.
- `kmeans` on three well-separated groups of vectors returns three clusters matching the groups for any seed; an empty centre is re-seeded; a single-row input with one cluster works.

## Tests

- Unit: `topicText` and `isTopicEligible` (table of inputs including GIF-only, emoji-only, mentions, exactly at each boundary); `parseJsonObject`; `kmeans` (separated groups, determinism for a fixed `random`, re-seeding, early stop, cohesion values) and `clusterCount`; cluster filter and representative selection; the repeat rule; `topicStore` (each method, append-only builds, interrupted build, hide, `samplesOf` visibility, idempotent migrations on an existing database); `topicSample`, `randomCorpus`, `randomStartersAll`; `getEmbeddings` batch option; `topicBuilder.run` with fakes (each numbered step, each edge case, dry run); `topicSource` (bank weights with scripted rolls, exclusions, directory filter, fallback scoring, failures, `openers`, `bankStatus`); `parseTopicsArgs`; `assertTopics`; `assertRequired('topics')`.
- Scenario (`test/scenarios/topics.test.js`): through the world container, seed a corpus with three themed groups by several authors plus many short messages and a single-author theme; script the LLM fake to label by content; run the builder; assert the stored topics, authors and samples, that no short message is a representative, and that `candidates` returns them and then, with all excluded, a neighbourhood candidate.
- Entry point (child process, temp directory): `node scripts/topics.js --bogus` exits 2; `--list` on a database without the tables prints an empty bank.
- `nonDestructive`, `layering`, `sizeLimits`, `coverageMap`, `unusedExports` pass (the layer table gains `topics/`).

## Docs

README: a "Topic bank" section under Scripts (what it is, when to run it, options, cost: one LLM call per kept cluster, up to `maxLabelled`; safe to run with the bot up), the configuration tables, the storage section (four tables, append-only), and `CLAUDE.md`'s layer table.

## Acceptance

`npm test` passes. `node scripts/topics.js --bogus` exits 2 without touching the network.
