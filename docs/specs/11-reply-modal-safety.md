# Spec 11: Reply-modal safety

**Depends on:** 02. **Blocks:** 12.

## Problem

`interaction.awaitModalSubmit({ time })` has no filter. discord.js resolves it with the next modal submission from anyone, so when two users have the reply modal open, the first submission resolves both waits: one user's choice is applied to the other user's target message, and the second handler then fails with "already replied". A dismissed modal rejects after two minutes and is logged as an error.

## Required behaviour

- Each invocation uses a unique modal custom id: `replyModal:<interaction.id>` (`REPLY_MODAL_ID` becomes the prefix `replyModal`; `buildReplyModal({ record, users, modalId })` takes the id).
- `awaitModalSubmit` is called with `{ time: config.discord.modalTimeoutMs, filter }` where `filter(i)` is `i.customId === modalId && i.user.id === interaction.user.id`.
- The explicit `customId` check after the await is removed (the filter guarantees it).
- A collector timeout (discord.js rejects with an error whose `code` is `'InteractionCollectorError'`) is not an error: log at info level (`reply modal dismissed or timed out`) and return. Any other rejection is logged as an error by the handler boundary.

## Interfaces

- `discord/replyModal.js`: `REPLY_MODAL_PREFIX = 'replyModal'`, `buildModalId(interactionId)`, `buildReplyModal({ record, users, modalId })`, `isModalTimeout(error)`.
- No config change.

## Harness change (`test/support/fakes/discord.js`)

Model discord.js faithfully so the bug is reproducible:

- The world keeps a list of pending modal waits (`{ filter, resolve, reject }`), added by any interaction's `awaitModalSubmit(options)`.
- `interaction.submit({ author, customId = modal.custom_id, user = interaction.user })` builds a modal-submit interaction (now including `user`) and offers it to **every** pending wait in order; each wait whose `filter` is absent or returns true resolves with it and is removed. `submit` returns the modal-submit interaction.
- `interaction.timeout()` rejects that interaction's own pending wait with an error carrying `code: 'InteractionCollectorError'`.

## Edge cases

- Two users open the modal on different targets; user B submits first → only B's flow runs, with B's target; A's wait stays pending and A's later submit runs A's flow.
- Same user opens two modals (two interactions) → each submit resolves only its own interaction (distinct ids).
- A submission with a foreign `customId` or from another user is ignored and leaves the wait pending.
- Timeout → nothing sent, one info log, no error log.

## Tests

- Update `test/characterization/reply-command.test.js`: modal `custom_id` is `replyModal:<interaction.id>`; `awaitModalSubmit` receives `time: 120000` and a `filter` function; the "different customId" case still yields no reply; timeout yields no `world.logs.error` entry.
- New scenario tests (`test/scenarios/reply-modal.test.js`) for each edge case above. The concurrent-users test must fail against the pre-change handler (verify by running it before changing the handler).
- Unit: `buildModalId`, `isModalTimeout`, `buildReplyModal` uses the given id.

## Docs

Remove the modal entry from README "Known issues".

## Acceptance

`npm test` passes; only the listed characterization assertions change.
