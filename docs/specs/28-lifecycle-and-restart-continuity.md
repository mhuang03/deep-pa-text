# Spec 28: Process lifecycle, gateway resilience and restart continuity

**Depends on:** 27. **Blocks:** 29. **Audit findings:** A6, A7, A54, A55. Also covers restart behaviour raised by the restart auditor: state lost on restart and messages missed while the bot was down.

## Problem

- The bot registers no client-level listeners. If the token is revoked or the Message Content intent is disabled, the gateway closes for good, nothing is logged, and the process keeps running and posting revives over REST.
- `SIGTERM`/`SIGINT` kill the process mid-reply; the database and client are never closed.
- An escaped rejection or exception crashes the process without a clear last log line.
- Every restart forgets the rate limit and who spoke last: a restart can be followed by an immediate extra reply, and a quiet channel never gets its revive because a fresh start waits for a human.
- Messages posted while the bot was down never reach the corpus.
- The bot will happily start on a database whose re-import was interrupted.

## Required behaviour

### Lifecycle (`src/bot/lifecycle.js`)

`createLifecycle({ client, closeDatabase, clock, logger, exit, config })` →

- `track(handler) → wrapped`: counts in-flight invocations; once shutdown has begun, new invocations return immediately without calling the handler.
- `every(fn, ms)`: `clock.setInterval`, remembered so shutdown can clear it.
- `shutdown({ reason, code }) → Promise<void>`: idempotent (a second call returns the first call's promise). Logs the reason; clears the intervals; waits until no tracked handler is in flight or `lifecycle.graceMs` has elapsed (polling with `clock.sleep(lifecycle.pollMs)`), logging how many were abandoned if the grace period ran out; `await client.destroy()` and `closeDatabase()`, each in its own try/catch with the error logged; then `exit(code)`.

`createBot` wraps every event handler with `track` and creates its intervals with `every`.

### Gateway events (`src/bot/gatewayEvents.js`)

`registerGatewayEvents({ client, lifecycle, logger })`, called by `createBot.start` before login:

| Event | Action |
| --- | --- |
| `Events.Error` | `logger.error` |
| `Events.Warn` | `logger.warn` |
| `Events.ShardError` | `logger.error` with the shard id |
| `Events.ShardReconnecting`, `Events.ShardResume` | `logger.info` |
| `Events.ShardDisconnect` | `logger.warn` with the close code; if the code is one of `FATAL_CLOSE_CODES` (4004 authentication failed, 4010 invalid shard, 4011 sharding required, 4012 invalid API version, 4013 invalid intents, 4014 disallowed intents) → `logger.error` with a hint (4004: check `DISCORD_BOT_TOKEN`; 4014: enable the Message Content intent in the developer portal) and `lifecycle.shutdown({ reason, code: 1 })` |
| `Events.Invalidated` | `logger.error` and `lifecycle.shutdown({ reason: 'session invalidated', code: 1 })` |

Exiting non-zero lets a process supervisor restart the bot and makes the failure visible.

### Process hooks (`src/bot/processHooks.js`)

`installProcessHooks({ process, lifecycle, logger })`: `SIGINT` and `SIGTERM` → `lifecycle.shutdown({ reason: signal, code: 0 })`; `unhandledRejection` and `uncaughtException` → `logger.error` with the error and `lifecycle.shutdown({ reason, code: 1 })`. `src/main.js` installs them (with the real `process` and `exit: (code) => process.exit(code)`) after building the container. The container exposes `lifecycle`.

### Startup sequence (`src/main.js`, logic in `src/bot/startup.js`)

`createStartup({ container, logger })` → `run()`:

1. **Re-import guard.** If `meta` has `reimport_started_at` and no `reimport_completed_at` → `ConfigError`: `A re-import of this database is unfinished. Finish it with: npm run reimport -- --resume --yes`.
2. **Vector store.** `await vectorStore.connect()`; on failure throw a `ConfigError` that names the port and says how to start Chroma (`npx chroma run --port <port> --path <dir>`).
3. `bot.start()` (registers events, logs in).

At `ClientReady` the bot runs, in order and each guarded so a failure is logged and the next step still runs: **catch-up**, **state restore**, then starts the intervals.

### Catch-up after downtime (`src/backfill/catchUp.js`)

`createCatchUp({ channelHistory, historyImporter, messageStore, config, logger })` → `run(channel) → Promise<{ fetched, insertedRaw, kept, capped }>`:

- `newest = messageStore.newestRaw()` (`{ id, timestamp }` of the raw message with the greatest timestamp, ties by id) → none: return zeros (an empty database is filled by `npm run backfill`, not here).
- Page **forward** with `channelHistory.fetchAfter(channel, { after: cursor, limit: 100 })` (new: `channel.messages.fetch({ after, limit, cache: false })`, returned oldest first; the next cursor is the newest id of the page) until a page is empty or `catchUp.maxMessages` were fetched; convert with `toHistoryMessage`.
- `historyImporter.importMessages(messages, { channel })`. No replies are generated for caught-up messages.
- When the cap was hit, `capped: true` and a warning says to run `npm run backfill`.

`catchUp.enabled: false` skips it. Message events that arrive while it runs are ingested by the normal handler; ingest is idempotent, so overlap is harmless.

### State restore (`src/bot/stateRestore.js`)

`restoreState({ messageStore, botMessageStore, activity, replyPolicy })`, after catch-up:

- `lastHuman = messageStore.newestRaw()` (visible rows only);
- `lastNatural = botMessageStore.newest({ triggers: [AUTO, REVIVE] })`, `lastReply = botMessageStore.newest({ triggers: [AUTO, CHAIN, COMMAND] })` (visible rows; `newest` is new);
- Activity: no `lastHuman` → unchanged (fresh-start rule: the bot counts as last speaker). Otherwise, if `lastNatural` is newer than `lastHuman` → `activity.restore({ lastMessageTime: lastNatural.timestamp, lastWasBot: true })`, else `activity.restore({ lastMessageTime: lastHuman.timestamp, lastWasBot: false })`.
- Reply policy: `replyPolicy.restore({ replyTime: lastReply?.timestamp ?? null })`. The miss counter starts at 0.

`activity.restore(state)` and `replyPolicy.restore({ replyTime })` are new. Consequences: a restart no longer lifts the rate limit, and a channel that was already quiet keeps counting from the last human message (a revive that was due fires at the first check instead of never).

## Config

`lifecycle.graceMs: 10000`, `lifecycle.pollMs: 100`, `catchUp.enabled: true` (env `CATCH_UP`), `catchUp.maxMessages: 2000` (integer ≥ 1).

## Harness change

- Fake client: `destroy()` (already counted), and helpers to emit the gateway events above.
- Fake `channel.messages.fetch` supports `{ after, limit }` (the `limit` oldest messages newer than `after`, returned newest first).
- `createWorld({ exit })` records exit codes in `world.exits` instead of exiting; `createWorld({ preload })` runs a callback against the container before `ClientReady` so tests can seed the database as if from a previous run.

## Edge cases

- `ShardDisconnect` with code 4014 → error log with the intent hint, client destroyed, database closed, exit code 1. Code 1000 or 4000 → warning only, no shutdown.
- `SIGTERM` while a reply is being generated (hold the LLM) → shutdown waits; when the completion is released within the grace period the reply is sent and recorded, then exit 0. If it is not released, exit 0 after `graceMs` with a warning naming one abandoned handler.
- A message arriving after shutdown began → ignored.
- Two signals → one shutdown.
- `unhandledRejection` → error logged, exit 1.
- `client.destroy()` throws → logged, the database is still closed, exit still happens.
- Unfinished re-import → startup refuses with the resume command; nothing connects.
- Chroma down at startup → one-line message with the port; exit 1; no Discord login.
- Restart 2 minutes after an auto reply → a replyable message with roll 0 is still rate-limited until 5 minutes after that reply.
- Restart with the last human message 5 h old and no bot message after it, in daytime → a revive at the first check.
- Restart where the last message is a revive → no revive until a human speaks.
- Restart where the last bot message is a chain or command reply newer than the last human message → activity is the human's (those do not block revives), but the rate limit is restored from it.
- Empty database → fresh-start behaviour exactly as today.
- Three messages were posted while the bot was down → after ready they are in `messages` (and the corpus when kept), no reply was generated for them, and activity reflects the newest of them.
- A reply to a bot message posted during downtime → stored with `NULL` reference; no chain reply is generated for it.
- Catch-up fetch fails → warning; state restore and intervals still happen.
- More than `maxMessages` missed → the oldest `maxMessages` after the cursor are imported, `capped` warning logged.
- `ClientReady` emitted twice → one set of intervals, one catch-up.

## Tests

- Unit: `lifecycle` (tracking, grace timeout, idempotence, failures in destroy/close, intervals cleared); `registerGatewayEvents` (each event, fatal and non-fatal codes); `installProcessHooks` with a fake process emitter; `createStartup` (guard, Chroma failure message, order); `catchUp` (no rows, paging, cap, disabled, failure); `fetchAfter`; `newestRaw`, `botMessageStore.newest`; `restoreState` (each case above); `activity.restore`, `replyPolicy.restore`.
- Scenario (`test/scenarios/lifecycle.test.js`, `test/scenarios/restart.test.js`): every edge case above through the world.
- Existing tests: `bot.start` unit tests gain the new registrations; any test that seeds data before `ready()` and relied on fresh-start state is updated to the restored state. The characterization test "fresh start → no revive" (empty database) must still pass unchanged.

## Docs

README: an "Operations" section (signals and graceful shutdown, exit codes, what is logged on gateway failure, running under a supervisor, what a restart restores, catch-up and its cap).

## Acceptance

`npm test` passes. In a temp directory with dummy configuration and no Chroma, `node src/main.js` prints the one-line Chroma message and exits 1.
