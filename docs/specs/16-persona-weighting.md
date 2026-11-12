# Spec 16: Weighted persona selection

**Depends on:** 02. **Blocks:** none.

## Problem

The replying persona is picked uniformly from the authors of the 20 nearest reply-embedding hits, so a barely related reply from three years ago counts as much as a close, recent one. Separately, when there are no hits the fallback picks uniformly from all users, which can pick the author of the message being replied to (the bot then answers someone as themselves).

## Required behaviour

### Weighting (`src/retrieval/personaWeights.js`, pure)

- `hitWeight(hit, { referenceTimeMs, halfLifeMs, minRecency })`:
  - `similarity = 1 / (1 + Math.max(0, hit.distance))`;
  - `ageMs = Math.max(0, referenceTimeMs - hit.metadata.timestamp)`;
  - `recency = Math.max(minRecency, 0.5 ** (ageMs / halfLifeMs))`;
  - weight = `similarity * recency`. "Missing" means `!Number.isFinite(value)`: a hit with a missing distance gets `similarity = 0.5`, one with a missing timestamp gets `recency = minRecency`.
  - Chroma distances here are squared L2 over unit vectors (range 0 to 4), so similarity ranges from 1 down to 0.2.
- `weighAuthors(hits, { ...options, allowedAuthors }) → [{ author, weight }]`: sum of hit weights per `metadata.author`, in order of each author's first (nearest) appearance. Hits without metadata or author, and authors not in `allowedAuthors` (the current user directory), are skipped.
- `pickWeighted(entries, roll) → author | undefined`: `undefined` for an empty list or when the total weight is not a positive finite number; otherwise, with the roll clamped to `[0, 1)`, the first entry whose cumulative weight exceeds `roll * totalWeight` (the last entry if rounding leaves none).

### Selector (`src/retrieval/personaSelector.js`)

- `likelyRepliers(record)` is unchanged for callers that want the plain author list, and a new `likelyReplierHits(record) → Hit[]` exposes the hits. The query already excludes hits authored by `record.author`; the exclusion below matters only on the fallback path.
- `pickReplier(record)`: fetch hits; consume **one** roll; `pickWeighted(weighAuthors(hits, { referenceTimeMs: record.timestamp, ... }), roll)`; if that yields nothing, `pickRandomUser({ exclude: record.author })` (one more roll).
- `pickRandomUser({ exclude } = {})`: uniform over users whose username is not `exclude`, in directory order (`filtered[Math.floor(roll * filtered.length)]`); if that leaves nobody (single-user directory), uniform over all users.
- Revive keeps calling `pickRandomUser()` with no exclusion.

Roll count and order are unchanged from spec 01 (probability, then selection, then fallback).

## Config

`persona.recencyHalfLifeMs: 15552000000` (180 days; must be > 0), `persona.minRecencyWeight: 0.25` (must be in `(0, 1]`). `loadConfig` throws on invalid values.

This spec deliberately changes default behaviour (weighted selection, author exclusion) and offers no switch back to uniform selection.

## Edge cases

- One author with many weak hits vs another with one strong recent hit: verify by arithmetic in the unit test that weights, not counts, decide.
- All hits by one author → that author for any roll.
- Roll `0` → first author by nearest appearance; roll `0.999999` → last.
- Hits with identical weights and two authors: roll `0.49` → first, `0.5` → second.
- No hits, message author `alice`, roll `0` → `bob` (first user other than alice).

## Tests

- Unit: `hitWeight` (distance 0, large distance, age 0, one half-life, far older than the floor, missing or non-finite fields); `weighAuthors` (ordering, skipped hits, authors outside the directory); `pickWeighted` boundaries (roll 0, just below 1, ≥ 1, zero total); selector roll counts (one with hits, two without) and exclusion. The existing `personaSelector` unit tests for uniform roll-to-index mapping are replaced by weighted-mapping tests.
- Characterization updates in `test/characterization/auto-reply.test.js` and `reply-command.test.js`:
  - the fallback case `[0, 0, 0]` with author `alice` now yields `bob`; rename it to state that the fallback never picks the message's author;
  - persona-by-roll cases (roll 0 → first author, roll 0.99 → last) hold for the existing seeds even though their weights are unequal; verify, and if one does not hold, adjust the seed, not the assertion;
  - the fallback case `[0, 0, 0.99]` → `dave` still holds (dave is last among users other than the author).
- Scenario (`test/scenarios/persona.test.js`): (a) `bob` replied once, two years ago, to a loosely similar message and `carol` replied recently to a near-identical one → with roll `0.5`, `carol` is chosen; (b) recency alone: `bob` and `carol` replied to identical parents (equal distance), bob two years before the target and carol a day before → roll `0.5` picks `carol`. Seed timestamps explicitly relative to `BASE_TIME`.

## Docs

README triggers table: describe weighted selection and the author exclusion; list the two config keys.

## Acceptance

`npm test` passes; only the listed characterization assertions change.
