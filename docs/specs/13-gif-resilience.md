# Spec 13: GIF resilience and variety

**Depends on:** 02. **Blocks:** none.

## Problem

- A GIF engine that throws (network error, unexpected JSON, non-200 response) rejects the whole response, so no reply is sent.
- GIF HTTP calls have no timeout.
- The first search result is always used, so the same query always yields the same GIF.

## Required behaviour

### Engines (`src/gifs/engines.js`)

- Each engine becomes `{ name, search(query) → Promise<string[]> }`, returning up to `config.gifs.candidates` URLs (empty array for no result). Empty-string URLs are dropped.
  - Klipy: unchanged request; take the first `candidates` items' `file.hd.gif.url`.
  - Giphy: `search(query, { limit: candidates })`; map `images.original.url`.
  - Humor: `number=<candidates>`; map `images[].url`.
- Klipy and Humor pass `signal: AbortSignal.timeout(config.gifs.timeoutMs)` to `fetch`, and treat a response with `ok === false` as an error (`Error('<engine> responded <status>')`).
- Giphy (SDK, no signal support) is wrapped with `withTimeout`.

### `src/util/withTimeout.js`

`withTimeout(promise, ms, label)` → resolves/rejects with `promise`, or rejects with `Error('<label> timed out after <ms> ms')` after `ms`. Clears its timer when the promise settles.

### Resolver (`src/gifs/gifResolver.js`)

- `createGifResolver({ engines, config, random, logger })`.
- For each token, engines are tried in order. An engine that throws or times out is logged (`logger.warn`, with engine name and query) and treated as having no result; the next engine is tried.
- From the first engine that returns a non-empty list, pick `urls[Math.floor(random() * urls.length)]`.
- All engines empty or failing → unresolved (placeholder text, as today). `resolve` never rejects because of an engine.

## Config

`gifs.candidates: 5`, `gifs.timeoutMs: 5000`. `klipyPerPage` stays 8.

## Random call order

GIF picks happen after persona selection, one roll per token that has more than one candidate (no roll for a single candidate). Scripted roll arrays in existing tests repeat their last value, so existing tests keep passing with single-result fakes.

## Harness change (`test/support/fakes/gifs.js`)

`setResult` additionally accepts an array of URLs (several results). A string still means one result. The fake `fetch` response gains `ok: true, status: 200`; `setResult({ status: 500 })` yields `ok: false`. The fake records the `signal` option passed to `fetch`.

## Edge cases

- Klipy throws, Giphy returns a URL → that URL is used, one warning logged.
- All three throw → placeholder text, reply still sent.
- Klipy returns HTTP 500 → treated as failure, next engine tried.
- Engine returns 5 URLs, roll 0 → first; roll 0.99 → last.
- Engine never settles → times out after `timeoutMs` (use mocked timers), next engine tried.
- Humor/Klipy JSON missing expected fields → treated as no result, no throw.

## Tests

- Flip `KNOWN BUG (spec 13)` in `test/characterization/gifs.test.js`: an engine that throws no longer rejects. Update request assertions for Giphy (`limit: 5`) and Humor (`number=5`).
- Unit: `withTimeout` (resolve, reject, timeout, timer cleared); each engine (candidates cap, empty, malformed JSON, non-OK status, signal passed); resolver (fallthrough on throw, random pick, single candidate makes no roll, never rejects).
- Scenario (`test/scenarios/gifs.test.js`): auto reply still delivered when every engine throws.

## Docs

README GIF section and known issues.

## Acceptance

`npm test` passes.
