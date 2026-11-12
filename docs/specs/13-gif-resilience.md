# Spec 13: GIF resilience and variety

**Depends on:** 02. **Blocks:** none.

## Problem

- A GIF engine that throws (network error, unexpected JSON, non-200 response) rejects the whole response, so no reply is sent.
- GIF lookups have no timeout.
- The first search result is always used, so the same query always yields the same GIF.

## Required behaviour

### Engines (`src/gifs/engines.js`)

- Each engine becomes `{ name, search(query) → Promise<string[]> }`, returning up to `config.gifs.candidates` distinct URLs (empty array for no result).
  - Klipy: unchanged request; items' `file.hd.gif.url`.
  - Giphy: `search(query, { limit: candidates })`; items' `images.original.url`. `createGiphyEngine({ giphy, config })` requires `config` (the `DEFAULTS` import and fallback are removed).
  - Humor: `number=<candidates>`; items' `url`.
- Result mapping is defensive: a body that is not the expected shape (missing key, non-array list, item without the nested field) yields no URLs rather than throwing. Only strings matching `/^https?:\/\//` are kept, duplicates are removed, and the list is cut to `candidates`.
- Klipy and Humor treat a response with `ok === false` as an error: `Error('<engine name> responded <status>')`. Error messages never include the request URL (the Klipy URL contains the API key).

### `src/util/withTimeout.js`

`withTimeout(promise, { ms, label, setTimeout, clearTimeout }) → Promise`: settles with `promise`, or rejects with `Error('<label> timed out after <ms> ms')` once `ms` elapse; the timer is cleared when `promise` settles first. The timer functions are injected. It does not cancel the underlying work (an abandoned request finishes in the background; accepted).

`src/util/` is a new bottom layer for pure helpers with no project imports; add it to the layering list in `CLAUDE.md`.

### Clock

`clock` gains `setTimeout(fn, ms)` and `clearTimeout(handle)` (lazy wrappers over the globals in `defaultClock()`).

### Resolver (`src/gifs/gifResolver.js`)

`createGifResolver({ engines, config, random, logger, clock })` → `{ resolve(text) }`:

1. Find tokens (unchanged).
2. For every token concurrently, find its candidate list: try engines in order; each `engine.search(query)` is wrapped in `withTimeout` (`ms: config.gifs.timeoutMs`, `label: engine.name`); an engine that throws or times out is logged with `logger.warn` (engine name, query and error message only) and treated as empty; the first non-empty list wins.
3. Then, sequentially **in token order**, pick a URL for each token that has candidates: a single candidate is used without rolling; otherwise `candidates[Math.floor(random() * candidates.length)]` (one roll per such token).
4. Tokens with no candidates are unresolved (`url: ''`, placeholder text as today). `resolve` never rejects because of an engine.

The container passes `random: clock.random`, `logger` and `clock`.

## Config

`gifs.candidates: 5` (integer ≥ 1, else `loadConfig` throws), `gifs.timeoutMs: 5000`. `klipyPerPage` stays 8. `gifs.giphyLimit` and `gifs.humorNumber` are removed; both requests use `candidates`.

## Random call order

GIF rolls happen during composition, after the persona has been selected, in token order. Scripted roll arrays in existing tests repeat their last value and the fakes return one result by default, so existing tests keep passing.

## Harness change

- `world.js` adds `setTimeout` to the mocked timer APIs, so `world.advance(ms)` fires `withTimeout` timers.
- `test/support/fakes/gifs.js`: `setResult(x)` accepts, for every engine: a URL string (one result), an array of URL strings (several), `null` (none), an `Error` (the call rejects), `{ hang: true }` (the call never settles), or a function `(query) =>` any of these. Klipy and Humor additionally accept `{ status: n }` (response with `ok: n < 400` and that status, empty body) and `{ body: value }` (that JSON body verbatim, for malformed-shape tests). The fake responses carry `ok: true, status: 200` by default. The Giphy fake honours `options.limit`.

## Edge cases

- Klipy throws, Giphy returns a URL → that URL is used, one warning logged.
- All three throw → placeholder text, reply still sent.
- Klipy returns HTTP 500 → warning, next engine tried; the warning text does not contain the API key.
- Klipy body `{}` / `{ data: {} }` / `{ data: { data: 'x' } }`, Humor body `{}` / `{ images: null }`, Giphy `{}` → no result, no warning, next engine tried.
- Engine returns 5 URLs: roll 0 → first; roll 0.99 → last.
- Engine returns 8 URLs → only the first 5 are candidates.
- Engine returns duplicates or a non-http URL → removed before the pick.
- Engine hangs → after `timeoutMs` (advance mocked time) a warning is logged and the next engine is tried.
- Two tokens: rolls are consumed in token order regardless of which lookup finishes first.
- Two identical tokens → each resolved and rolled independently.

## Tests

- Flip the `KNOWN BUG (spec 13)` tests in `test/characterization/gifs.test.js`: an engine that throws no longer rejects; the text gets the placeholder. Update the request assertions for Giphy (`limit: 5`) and Humor (`number=5`).
- Unit: `withTimeout` (resolve, reject, timeout, timer cleared, with fake timer functions); each engine (candidates cap, empty, each malformed body, non-OK status, URL filtering, de-duplication, error text without URL); resolver (fallthrough on throw and on timeout, token-order rolls, single candidate makes no roll, never rejects).
- Scenario (`test/scenarios/gifs.test.js`): auto reply still delivered when every engine throws; a hanging engine does not block the reply beyond the timeout.

## Docs

README GIF section (random pick among up to five results, per-engine timeout and failure handling) and the known-issues entry.

## Acceptance

`npm test` passes; only tests pinning the fixed bug and the two request parameters change.
