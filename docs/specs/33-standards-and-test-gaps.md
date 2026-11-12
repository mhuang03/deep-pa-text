# Spec 33: Standards compliance and test gaps

**Depends on:** 32. **Blocks:** none. **Audit findings:** A32, A34, A58, A69, A70, A71, A72, A74, A80, A82, A83, A84, A85, A86.

## Problem

The audit measured the code against `CLAUDE.md` and found: factory functions far over the size guideline (`createMessageStore` 173 lines, `createVectorStore` 128, `createReimporter` 118, `createReplyCommandHandler` 112, `createGenerator` 109, `createResponder` 106), `src/container.js` over 200 lines, imports between peer service layers, tunables defined outside the configuration, argument mutation and `.then` chains, modules with no unit test, exports nobody uses, and several spec edge cases whose tests cannot detect a regression. Nothing enforces the layering or size rules mechanically.

This spec changes structure and tests only. **No behaviour changes.** Every existing test must pass with its assertions unchanged (imports and construction may change).

## Required behaviour

### Mechanical enforcement (new tests)

- `test/unit/layering.test.js`: builds the import graph of `src/` (static `import … from` statements) and fails on any edge that violates the layer order below, on any import cycle, and on any file outside `src/discord/`, `src/bot/`, `src/backfill/`, `src/vendor.js` and `scripts/` that imports `discord.js`. The layer of a file is its first directory under `src/`.

  | Level | Members |
  | --- | --- |
  | 5 | `main.js`, `container.js`, `vendor.js`, `scripts/*` |
  | 4 | `backfill/` |
  | 3 | `bot/` |
  | 2 | `ingest/`, `retrieval/`, `context/`, `profiles/`, `llm/`, `gifs/` |
  | 1 | `storage/`, `discord/` |
  | 0 | `corpus/`, `text/`, `util/`, `config/`, `config.js`, `logger.js`, `userData/` |

  An import may go to a lower level, or stay inside its own directory. Imports between different directories on the **same** level are forbidden, with one documented exception: `storage/` and `discord/` do not import each other at all. `CLAUDE.md` is updated to this table.
- `test/unit/sizeLimits.test.js`: every file under `src/` and `scripts/` has at most 200 lines; every function body has at most 40 lines (the guideline stays "about 25"; 40 is the enforced ceiling) and at most 3 positional parameters. Function boundaries are found with a small brace-matching scanner over arrow functions and `function` declarations (no new dependency); the scanner itself is unit-tested on samples.

### Refactors to make them pass

- **Peer imports (A82).** Pure helpers used across services move to level 0: `src/text/` receives `normalize.js` (dedup key), `queryText.js`, `transcript.js` (building and formatting transcript entries), `situation.js`, and the `src/util/text.js` functions from spec 31 (re-exported from their old location is **not** allowed; update the importers). `src/retrieval/`, `src/context/` and `src/llm/` then import them from `src/text/`.
- **Oversize factories (A83).** Split by responsibility, keeping each factory's public object identical:
  - `messageStore.js` → statements grouped in `messageStatements.js`; edit/delete operations in `messageEdits.js`; read queries in `messageQueries.js`; `createMessageStore` composes them.
  - `vectorStore.js` → collection lookup, record mapping and write operations in separate files.
  - `generator.js` → reply, chain and revive generation as separate small factories composed by `createGenerator`.
  - `responder.js` → context resolution, part delivery and recording as separate functions.
  - `replyCommand.js` → preparation (target, limits, modal) and answering (acknowledge, persona, respond) as separate modules.
  - `reimport.js` → one function per numbered step of spec 26.
  - `container.js` → `src/container/` with one builder per layer (storage, services, discord, bot, backfill), composed by `buildContainer`; `src/container.js` stays the public entry.
  - The two four-parameter functions (`chainReply`, `fillGifKey`) take an options object.
- **Tunables (A84).** Move into configuration: persona weight constants (`persona.missingSimilarity`), SQL chunk size (`storage.chunkSize`), comparison page size (`backfill.comparisonPageSize`), quiet-description thresholds (`revive.quietHourMs`, `revive.quietDaysMs`). Discord API error codes stay as named constants in one module, `src/discord/errorCodes.js`. The wrong-channel message no longer names a channel: `This command can only be used in the bot's channel.` (the one user-visible text change; update the characterization assertion).
- **Mutation and `.then` (A85).** No function mutates an error it caught or an argument it received; `memberProfiles` uses `async`/`await` with `try`/`catch`/`finally`. `withTimeout` may keep its promise plumbing.
- **Unused exports (A86).** Remove `export` from anything imported by neither production code nor tests; constants imported only by tests stay exported.

### Missing unit tests (A86)

Add direct unit tests for: `backfill/ownWebhooks.js` (including the failure fallback), `backfill/reimportComparison.js` (paging, missing tables), `backfill/reimportPlan.js`, `storage/messageSql.js` statements not otherwise covered, `storage/migrations.js` (descriptor validity), `discord/login.js` (resolves on ready, rejects on login failure), `util/vectorError.js`, `bot/triggers.js`. A new test, `test/unit/coverageMap.test.js`, fails when a file under `src/` has no test file that imports it.

### Test gaps from the audit

Each of these is a test that must fail if the behaviour regresses:

- A32: the reply-command characterization test asserts `typeof modalOptions.filter === 'function'`, and a unit test shows the timeout follows `config.discord.modalTimeoutMs`.
- A34: the re-import scenario asserts the contents of the new reply collection (ids, parent embedding, `has_gif`).
- A58: transcript tests for a reply to the target itself (no suffix) and URL cleaning of embed-fallback bot content.
- A69: a composer test where truncation before GIF resolution would produce a different result than after; a scenario asserting the logged error for an all-empty response.
- A70: bot-message scenarios assert the stored row id equals the delivered message's id for auto, command and revive.
- A71: the recency scenario uses parents at different insertion order so that uniform selection would pick the other author.
- A72: the nearest-hit dedup test gives the two duplicate hits different parents and asserts the nearest one's parent.
- A74: scenario tests for the soft-delete filter on starters and on frequency counts.

## Edge cases

- The layering test's own samples: an upward import, a peer import, a cycle and a stray `discord.js` import are each reported.
- The size scanner handles nested arrow functions, template literals containing braces, and comments containing braces.
- After the refactor every public factory returns an object with exactly the same keys as before (assert in the container test by listing them).

## Tests

- The new enforcement tests and their self-tests; the added unit and scenario tests above.
- The whole existing suite passes with unchanged assertions, except the wrong-channel message text.

## Docs

`CLAUDE.md`: the layer table, the enforced ceilings (200 lines per file, 40 per function, 3 positional parameters) next to the guideline, and the three enforcement tests. README: file map updated to the final layout (A80), limitations section reviewed against `docs/audit/findings.md`.

## Decisions recorded (no change)

- **Default channel and guild ids (A75, A81).** They stay as defaults because they were the hardcoded values of the original bot and removing them would break the existing deployment. Both can be overridden with `PATEXT_CHANNEL_ID` and `GUILD_ID`.
- **Klipy content filter (A63)** stays `off` as in the original; it is a configuration key.
- **Output token cap (A64)** is not set: the provider's handling of a cap together with thinking mode is unverified; Discord's length limit and the reply limits bound the visible effect.
- **A human replying to part one of a burst while later parts are pending (A51)** and **sequential GIF lookups across burst parts (A62)** are accepted.

## Acceptance

`npm test` passes, including `layering`, `sizeLimits` and `coverageMap`.

## Amendments after review (these override the text above where they differ)

1. **Everything over the limits is split, not only the listed factories.** At the time this spec is implemented, any file over 200 lines and any function over 40 lines (top-level or inner closure), including growth from specs 27 to 32, is split by responsibility with its public keys unchanged. Known additional offenders: `createWebhookDelivery`, `createRetriever`, `createMessageCreateHandler`, `createDatabaseSwitch`, `createVectorSync`, `createIngestService`, `createBotMessageImporter`, `createHistoryReader`. A destructured options object counts as one parameter.
2. **Layer rule, precisely.** Add `container/` to level 5. A top-level file and the directory with the same stem (`config.js` and `config/`, `container.js` and `container/`) are one unit. Imports between different directories of the same level are forbidden on levels 1 to 4; levels 0 and 5 may import within their level (no cycles). The scanner covers `import … from`, `export … from`, side-effect imports and dynamic `import()`, and fails on a relative path that does not resolve. Pure helpers moved to `src/text/` take what they need as parameters; they do not import the configuration.
3. **Tunables.** Only these move to configuration: `persona.missingSimilarity: 0.5`, `storage.chunkSize: 500`, `backfill.comparisonPageSize: 500`. `ONE_HOUR_MS`, `TWO_DAYS_MS`, `MS_PER_DAY` and `HALF_LIFE_BASE` are unit conversions, phrase boundaries or mathematical constants and stay as named constants; `describeQuiet` keeps its signature.
4. **Wrong-channel text:** three assertions change (two in `test/characterization/reply-command.test.js`, one in the reply-command handler unit test).
5. **`coverageMap`** requires, for every file under `src/` except `src/main.js`, a test file that imports it directly by resolved path. That includes the modules added by specs 27 to 32.
6. **A34.** Add a human-to-human reply to the re-import scenario's seed (updating the counts that depend on it, or in a separate test) and assert its reply row; the reply to a bot message must have none.
7. **A70.** The fake modal-submit interaction records the messages its `editReply` resolved to (`editedMessages`), so the command scenario can compare the stored id.
8. **Scanner self-tests** also cover regular-expression literals containing braces or quotes, nested `${…}`, object-method shorthand and `async` arrows.
9. **Unused exports** are enforced by `test/unit/unusedExports.test.js`: every named export under `src/` is imported somewhere in `src/`, `scripts/` or `test/`.
10. **README (A80):** the file map lists every directory under `src/` and `test/`, the handlers for profile refresh, edits and deletes, and the operations section reflects what specs 27 to 29 actually deliver.
11. **Further decisions recorded (no change):** Discord REST calls rely on discord.js's own request timeout and retries (the Discord half of A31); a dry run may apply additive migrations and create empty collections (A44); the reply command has no role allow-list, since the per-user cooldown and concurrency cap bound its cost (A19); GIF engine errors are logged by message only and secrets are redacted by the logger (A66).
