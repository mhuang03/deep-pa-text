# Spec 27: Configuration and startup validation

**Depends on:** 26. **Blocks:** 28. **Audit findings:** A2, A24, A27, A28, A29, A36, A40, A41, A76, A77, A78, A83 (config part). See `docs/audit/findings.md`.

## Problem

A misconfigured deployment fails late and confusingly: missing secrets surface as library stack traces or as a bot that starts and then fails every reply; a missing `DEEPSEEK_API_KEY` makes the OpenAI SDK silently send `OPENAI_API_KEY` to DeepSeek; `BURSTS=0` leaves bursts on; a malformed `users.json` gives a deep stack trace; every entry point demands a `.env` file even when variables come from the environment. `npm run inspect` copies the whole database to a temp directory for old schemas.

## Required behaviour

### Layout

`src/config.js` (295 lines) is split so that no file exceeds 200 lines: `src/config/parse.js` (env parsing helpers), `src/config/sections.js` and, if needed, further section files (the per-section builders), `src/config/validate.js` (range checks), `src/config/requirements.js` (required variables). `src/config.js` stays the public entry and exports `loadConfig`, `DEFAULTS`, `assertRequired`, `ConfigError`. Existing `assert*` exports that tests use stay available from it.

### `ConfigError`

`class ConfigError extends Error` (the one class this codebase defines, because entry points must tell operator mistakes from bugs). Every validation failure below throws it. Entry points print `error.message` only (no stack) for a `ConfigError` and exit 1.

### Strict environment parsing (`loadConfig`)

- Booleans (`REPLY_OVERRIDE`, `REVIVE_OVERRIDE`, `PING_REPLIED_USER`, `CHAIN_REPLIES`, `BURSTS`): unset or empty → the default; otherwise trimmed and case-insensitive `true` / `false`; anything else throws `<VAR> must be "true" or "false", got "<value>"`.
- `CHROMA_PORT`: an integer from 1 to 65535.
- `PATEXT_CHANNEL_ID`, `GUILD_ID`: when set, must match `/^\d{5,25}$/`.
- `PERSONA_DISPLAY`: as today.
- Every numeric key is validated as a finite number in its range. Add the missing checks: `gifs.candidates` (integer ≥ 1), `gifs.timeoutMs` (> 0), `llm.timeoutMs` (> 0), `llm.maxRetries` and `llm.emptyRetries` (integers ≥ 0), `reply.probability` (0 to 1), `reply.minIntervalMs` (≥ 0), `filter.minLength ≤ filter.maxLength`, every `retrieval.*Results`/`reviveSamples`/`likelyRepliers` (integers ≥ 1), `storage.busyTimeoutMs` (≥ 0).

### Required variables (`assertRequired(config, env, purpose)`)

Throws one `ConfigError` listing **all** missing variables: `Missing required environment variables: A, B. Set them in .env or the environment.`

| Purpose | Required |
| --- | --- |
| `bot` | `DISCORD_BOT_TOKEN`, `DEEPSEEK_API_KEY`, the embedding key variable (`config.embedding.apiKeyEnvVar`, normally `OPENAI_API_KEY`) |
| `backfill`, `reimport` | `DISCORD_BOT_TOKEN`, the embedding key variable |
| `register` | `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID` |
| `gif-smoke` | at least one of `KLIPY_API_KEY`, `GIPHY_API_KEY`, `HUMOR_API_KEY` |
| `inspect` | none |

A variable that is set to an empty or whitespace-only string counts as missing. Because `DEEPSEEK_API_KEY` is required for the bot, the chat client is never built with an undefined key (the SDK's fallback to `OPENAI_API_KEY` can no longer happen); `buildContainer` additionally throws a `ConfigError` if it is asked to build the chat client without `config.llm.apiKey`.

### GIF keys are optional

`buildGifResolver` builds only the engines whose key is set, in the usual order. With none, the resolver has no engines and every token stays unresolved (placeholder text). The bot logs one warning at startup naming the GIF variables that are not set.

### `.env` is optional

`loadEnvIfPresent(path, { existsSync, loadEnvFile })` (`src/config/env.js`): loads the file when it exists, does nothing otherwise. `src/main.js` and every script use it.

### Data files (`src/userData/loadData.js`)

Each failure throws a `ConfigError` that names the file:

- file missing or unreadable; invalid JSON;
- `users.json`: must be a non-empty array of objects, each with a non-empty string `username` and `name`, an optional `id` matching `/^\d{5,25}$/`, and usernames unique ignoring case;
- `ping_caches.json`: must be an object; `users`, `roles` and `channels` default to `{}` when absent and must be objects when present.

### Entry points

`src/main.js` and each script: load env if present, `loadConfig`, `assertRequired(purpose)`, `loadData` where needed, then proceed. Usage errors in scripts keep exit code 2.

- `scripts/gifSmoke.js`: exits 1 with a message when no token resolves, and 1 on any error.
- `scripts/inspectDb.js`: `src/storage/snapshot.js` is **deleted**; nothing copies the database. `src/storage/inspector.js`: `createInspector({ db })` over a read-only handle builds each section's query from the columns that exist (`PRAGMA table_info`): the visibility filter is applied only when `deleted_at` exists, a section whose table is missing prints `(no <table> table yet)`. A missing or unreadable database prints a one-line message and exits 1. The exemption for `snapshot.js` is removed from `test/unit/nonDestructive.test.js`.

### SQLite busy timeout

`openDatabase` runs `PRAGMA busy_timeout = <config.storage.busyTimeoutMs>` (default 5000) on every handle, read-only ones included, so a brief overlap between the bot and a script waits instead of failing. `openDatabase(path, { readOnly, busyTimeoutMs })`.

## Edge cases

- `DEEPSEEK_API_KEY` unset and `OPENAI_API_KEY` set → startup fails naming `DEEPSEEK_API_KEY`; no client is constructed.
- Three variables missing → one message listing all three.
- `BURSTS=0`, `CHAIN_REPLIES=off`, `REPLY_OVERRIDE=yes` → `ConfigError`; `REPLY_OVERRIDE=TRUE` → true; `BURSTS=` (empty) → default.
- `CHROMA_PORT=abc`, `0`, `70000`, `80.5` → `ConfigError`.
- `PATEXT_CHANNEL_ID=abc` → `ConfigError`.
- No `.env` file, all variables in the environment → starts.
- `users.json`: `[]`, an object, an entry without `name`, two entries `Bob` and `bob`, invalid JSON → each a `ConfigError` naming the file.
- No GIF keys → one startup warning; a reply with a GIF token is still sent, with the placeholder.
- Only `GIPHY_API_KEY` set → only the Giphy engine is called.
- `npm run inspect` on a legacy-schema database (no `deleted_at`, no `bot_messages`) → prints the sections without copying or writing anything; the database file's bytes are unchanged and no file appears in the temp directory.
- `npm run inspect` with no database → one line, exit 1.

## Tests

- Unit: every parsing and range rule (valid, each invalid form); `assertRequired` for each purpose (none missing, one, several, whitespace value); `ConfigError` identity; `loadEnvIfPresent`; `loadData` (each failure, defaults for missing ping-cache keys, duplicate detection); `buildGifResolver` with each subset of keys; container refuses a missing LLM key; `createInspector` on current and legacy schemas and missing tables; `openDatabase` sets the busy timeout (read it back with `PRAGMA busy_timeout`).
- Entry points (child-process tests in a temp directory, as the existing inspect test does): `main.js` with a missing variable exits 1 with the one-line message and no stack; `gifSmoke.js` with no keys exits 1; `inspectDb.js` cases above.
- Existing tests: config tests move with the split; the nonDestructive exemption is removed; nothing else changes.

## Docs

README: configuration table (required and optional variables, strict boolean values), setup (`.env` optional), data file format and validation, GIF keys optional, inspect behaviour.

## Acceptance

`npm test` passes. `src/storage/snapshot.js` no longer exists and `src/` contains no `rmSync`. No file under `src/config/` or `src/config.js` exceeds 200 lines.
