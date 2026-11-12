# Development standards

These rules are mandatory for every change in this repository, whether written by a person or an agent. `README.md` describes what the bot does; this file describes how to change it.

## Non-negotiables

1. **All database operations MUST be non-destructive.** See [Data safety](#data-safety).
2. **`npm test` must pass before every commit**, and every behaviour change ships with tests.
3. **No secrets or real user data in the repo.** `.env`, `data/`, and `*.db` stay git-ignored. Tests, fixtures, docs and commit messages use invented usernames, names, IDs and messages.
4. **The bot must never ping anyone.** Every outbound Discord message sets `allowedMentions: { parse: [] }` (replies may keep `repliedUser`).

## Data safety

The SQLite database and the Chroma collections hold an irreplaceable message history. Code may add to them; it may never destroy or overwrite what is there.

**Forbidden, in `src/`, `scripts/`, and tests that touch a real database:**

- SQL: `DELETE`, `DROP`, `TRUNCATE`, `REPLACE INTO`, `INSERT OR REPLACE`, and any `UPDATE` that overwrites a non-null value of user data (content, author, timestamp, reference).
- Migrations that rebuild a table (create new, copy, drop old) or change/remove a column.
- Chroma: `collection.delete`, `deleteCollection`, `reset`, and `update`/`upsert` of an existing id with different content or a different embedding.

**Allowed:**

- `INSERT ... ON CONFLICT DO NOTHING`.
- Additive, idempotent migrations run at startup: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` (nullable or with a default). Migrations must succeed on a database created by any earlier version, with existing rows untouched.
- `UPDATE` only to set a soft-delete or marker column (for example `deleted_at`), or to fill a column that is currently `NULL`.
- Chroma `upsert`/`add` of new ids. Re-upserting an id with identical content is tolerated for idempotency.
- A metadata-only fill of a missing key on an existing Chroma row, with its document and embedding passed back unchanged.
- Replacing the database file only through `src/backfill/databaseSwitch.js`: the old file is backed up to `*.old` (never overwritten) and a re-import always uses a new Chroma generation, so the old collections stay untouched. No file is deleted, truncated or overwritten anywhere else; `rename`, `link` and `copy` of files appear only in that module.

**Patterns to use instead of destruction:**

- Removal is a soft delete: set a marker in SQLite and filter it out in queries. SQLite is the source of truth; Chroma results are filtered against it in application code rather than deleted from Chroma.
- Edits are append-only revisions, never in-place overwrites.
- Scripts that write (backfill, migrations) are idempotent and support `--dry-run`.

Tests use `:memory:` SQLite or a temp directory and fake Chroma. They never open `messages.db` or read `data/` in the repo root. `test/unit/nonDestructive.test.js` scans the source for the forbidden operations; do not weaken it.

## Architecture

Runtime code lives in `src/`, CLI entry points in `scripts/`, tests in `test/`, specs in `docs/specs/`. Never name a directory `data`: `.gitignore` ignores that name at every depth.

- **Functional core, imperative shell.** Decision logic (filters, policies, prompt building, dedup, ranking) is pure and takes plain data. I/O (Discord, SQLite, Chroma, HTTP, LLM) lives in thin adapters at the edge.
- **Dependency injection through factories.** A module exports `createX(deps)` returning a plain object of functions. Dependencies, including `now`, `random`, `logger`, `fetch` and timers, are passed in; they are never imported globals inside logic. No classes unless a library requires one.
- **No import-time side effects.** Importing a module must not read files, open connections, read `process.env`, start timers, or log. Only entry points (`src/main.js`, `scripts/*.js`) do that. `src/container.js` is the only place services are wired together, and `src/vendor.js` is the only place real third-party constructors are collected.
- **No module-level mutable state.** State lives in the closure of a factory instance so each test gets a fresh one.
- **One source of configuration.** Every tunable, ID, model name, limit and probability is defined in `src/config.js`. No magic numbers or hardcoded IDs elsewhere. Only `config.js` and entry points read `process.env`.
- **Layering.** Imports point downward only: entry points → `backfill/` (history import and vector sync; imported only by scripts and the container) → `bot/` (triggers, handlers, orchestration) → use-case services (`ingest/`, `retrieval/`, `llm/`, `gifs/`, `context/`, `profiles/`) → adapters (`storage/`, `discord/`) and pure modules (`corpus/`, `config.js`), above `util/` (pure helpers with no project imports). Lower layers never import higher ones. Only `src/discord/`, `src/bot/`, `src/vendor.js` and entry points may import `discord.js`.
- **One responsibility per module.** If a file needs "and" to describe it, split it. Prefer adding a small module over growing an existing one.
- **Handlers are boundaries.** Event handlers and timers catch errors, log them with context, and never throw. Everything below them lets errors propagate.

## Code style

- Node 22.18+, ES modules, plain JavaScript, no build step. Do not add a runtime dependency without a stated reason in the spec.
- Two-space indent, semicolons, single quotes, trailing commas in multiline literals, `const` by default, `let` only when reassigned, never `var`.
- Module-level functions are `const name = (args) => { ... };` arrow functions. Named exports only; no default exports.
- Naming: `camelCase` for values and files, `UPPER_SNAKE_CASE` for constants, `createX` for factories, `buildX` for pure constructors of data, `isX`/`hasX`/`shouldX` for predicates.
- **Small functions.** A function does one thing, fits in about 25 lines, nests at most three levels, and takes at most three positional parameters (use an options object beyond that). Use early returns instead of nested conditionals. Files stay under about 200 lines.
- Do not mutate arguments. Return new values.
- `async`/`await` only; no `.then` chains. No floating promises: every promise is awaited or deliberately handled.
- Throw `Error` objects with enough context to debug. Never swallow an error silently; if a failure is tolerated (a GIF lookup, an avatar fetch), log it and state the fallback.
- Every external call (LLM, HTTP, Discord) has a timeout and a defined failure behaviour.
- Log through the injected `logger`, not `console`, outside entry points.
- Comments explain why, not what. Delete dead code instead of commenting it out.
- Do not duplicate logic. If two triggers need the same steps, extract them.

## Testing

- Test runner is `node:test` with `node:assert/strict`. Run with `npm test`. No other test framework or mocking library.
- Tests never touch the network, the real clock, real randomness, or real data. Use the fakes in `test/support/` and inject `now`/`random`.
- **Unit tests** (`test/unit/`, mirroring `src/`) cover every module: each exported function, each branch, boundary values, and failure paths.
- **Scenario tests** (`test/characterization/`, `test/scenarios/`) drive the whole bot through the `createWorld()` harness with fakes at the third-party boundary (Discord client, Chroma client, OpenAI-compatible client, GIF HTTP). A new feature or trigger gets scenario tests as well as unit tests.
- **Characterization tests pin existing behaviour.** Change one only when a spec explicitly changes that behaviour, and say so in the commit.
- A bug fix starts with a test that fails before the fix.
- Assert on observable behaviour (returned values, rows written, payloads sent, prompts built), not on implementation details or call order that does not matter.
- Test names state the behaviour: `'does not reply within the rate-limit window'`.
- Tests are independent and deterministic: fresh world or fresh factory instance per test, no shared mutable fixtures, no reliance on test order.

## Workflow

- Non-trivial changes start from a spec in `docs/specs/` that defines behaviour, interfaces, schema and config changes, edge cases, test requirements and dependencies on other specs. Implement the spec; if it is wrong or incomplete, fix the spec first.
- Keep `README.md` accurate: update it in the same change as any behaviour, config, setup or schema change.
- Commits are small and focused, with an imperative summary line. Never commit with failing tests.
- New config keys get a default that preserves current behaviour unless the spec says otherwise.
