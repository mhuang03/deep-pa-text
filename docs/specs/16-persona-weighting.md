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
  - weight = `similarity * recency`. A hit with a missing distance or timestamp gets `similarity = 0.5` / `recency = minRecency` respectively.
- `weighAuthors(hits, options) → [{ author, weight }]`: sum of hit weights per `metadata.author`, in order of each author's first (nearest) appearance.
- `pickWeighted(entries, roll) → author | undefined`: `undefined` for an empty list; otherwise the first entry whose cumulative weight exceeds `roll * totalWeight` (the last entry if rounding leaves none).

### Selector (`src/retrieval/personaSelector.js`)

- `likelyRepliers(record)` is unchanged for callers that want the plain author list, and a new `likelyReplierHits(record) → Hit[]` exposes the hits.
- `pickReplier(record)`: fetch hits; consume **one** roll; `pickWeighted(weighAuthors(hits, { referenceTimeMs: record.timestamp, ... }), roll)`; if that yields nothing, `pickRandomUser({ exclude: record.author })` (one more roll).
- `pickRandomUser({ exclude } = {})`: uniform over users other than `exclude`; if that leaves nobody (single-user directory), uniform over all users.
- Revive keeps calling `pickRandomUser()` with no exclusion.

Roll count and order are unchanged from spec 01 (probability, then selection, then fallback).

## Config

`persona.recencyHalfLifeDays: 180`, `persona.minRecencyWeight: 0.25`.

## Edge cases

- One author with many weak hits vs another with one strong recent hit: verify by arithmetic in the unit test that weights, not counts, decide.
- All hits by one author → that author for any roll.
- Roll `0` → first author by nearest appearance; roll `0.999999` → last.
- Hits with identical weights and two authors: roll `0.49` → first, `0.5` → second.
- No hits, message author `alice`, roll `0` → `bob` (first user other than alice).

## Tests

- Unit: `hitWeight` (distance 0, large distance, age 0, one half-life, far older than the floor, missing fields); `weighAuthors`; `pickWeighted` boundaries; selector roll counts (one with hits, two without) and exclusion.
- Characterization updates in `test/characterization/auto-reply.test.js` and `reply-command.test.js`:
  - the fallback case `[0, 0, 0]` with author `alice` now yields `bob`; rename it to state that the fallback never picks the message's author;
  - persona-by-roll cases keep passing with seeds of equal weight; if a seed makes weights unequal, fix the seed (same timestamps and distances), not the assertion.
- Scenario (`test/scenarios/persona.test.js`): a corpus where `bob` replied once long ago to a loosely similar message and `carol` replied recently to a near-identical one → with roll `0.5`, `carol` is chosen.

## Docs

README triggers table: describe weighted selection and the author exclusion.

## Acceptance

`npm test` passes; only the listed characterization assertions change.
