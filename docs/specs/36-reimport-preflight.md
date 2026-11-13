# Spec 36: Re-import preflight

**Depends on:** 26, 32. **Blocks:** none.

## Problem

An applied re-import reads the whole channel from Discord first (tens of minutes for a channel of about 90,000 messages) and only then connects to Chroma and makes its first embedding request. If Chroma is not running or the embedding key is bad, the run fails after the whole fetch, with the database already switched, and the fetch has to be repeated on `--resume`.

## Required behaviour

`src/backfill/reimportPreflight.js` exports `preflight(ctx)`. An applied run (`--yes`, with or without `--resume`) calls it after the state checks and before it connects to Discord. A dry run does not: it needs neither Chroma nor embeddings.

Checks, run together, each with a timeout:

| Check | How | Limit |
| --- | --- | --- |
| Chroma reachable | `new vendor.ChromaClient({ port }).heartbeat()` | `chroma.connectTimeoutMs` |
| Embedding API works | one `generate` call on `vendor.OpenAIEmbeddingFunction` with the configured model; the vector must have `embedding.dimensions` entries | `chroma.timeoutMs` |
| Database directory | `fs.accessSync(dir, R_OK | W_OK)` on the directory of `storage.databasePath` (the switch creates `.new` and `.old` there) | none |

Every failing check is collected and reported in one error:

```
Preflight failed; nothing was fetched or changed:
  - Chroma on port 7429: <reason>
  - Embedding API (OPENAI_API_KEY): <reason>
```

Nothing is written by the preflight: no collection is created and no file is touched. Discord itself is already verified before the read (login and channel fetch), and the old database by the state inspection.

The preflight narrows the window; it cannot close it. A service that goes down during the read still fails the import afterwards, and `--resume` finishes it.

## Tests

- Unit (`reimportPreflight.test.js`): all pass; Chroma unreachable; Chroma hanging; embedding rejected; wrong vector size; directory not writable; several failures in one error.
- Unit (`reimport.test.js`): an applied run preflights after `inspect` and before anything else; a failing preflight never constructs the Discord client; a resumed run is preflighted; a dry run is not.
- Scenario (`reimport.test.js`): Chroma down before an applied run leaves the database bytes unchanged, creates no `.old` or `.new`, and makes no history request. The existing "crash after the swap" scenario now takes Chroma down after the preflight.

## Docs

README re-import section.
