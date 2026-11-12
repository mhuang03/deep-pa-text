# Spec 11: Reply-modal safety

**Depends on:** 02. **Blocks:** 12.

## Problem

`interaction.awaitModalSubmit({ time })` has no filter. discord.js resolves it with the next modal submission from anyone, so when two users have the reply modal open, the first submission resolves both waits: one user's choice is applied to the other user's target message, and both handlers respond to the same submission. A dismissed modal rejects after two minutes and is logged as an error.

## Required behaviour

- Each invocation uses a unique modal custom id: `replyModal:<interaction.id>`. `REPLY_MODAL_ID` is removed and replaced by `REPLY_MODAL_PREFIX = 'replyModal'`; `buildReplyModal({ record, users, modalId })` takes the id. `AUTHOR_SELECT_ID`, `RANDOM_AUTHOR` and `readSelectedAuthor` are unchanged.
- `awaitModalSubmit` is called with `{ time: config.discord.modalTimeoutMs, filter }` where `filter(i)` is `i.customId === modalId && i.user.id === interaction.user.id`.
- The explicit `customId` check after the await is removed (the filter guarantees it).
- The handler wraps only the `awaitModalSubmit` call in a try/catch. A collector timeout (discord.js rejects with an error whose `code` is `'InteractionCollectorError'`) is not an error: `logger.info(MODAL_TIMEOUT_LOG)` (the constant `'reply modal dismissed or timed out'`, exported from `replyModal.js`) and return. Any other rejection is rethrown to the handler boundary, which logs it as an error.
- The user gets no feedback when a modal times out; that is accepted.

## Interfaces

- `discord/replyModal.js`: `REPLY_MODAL_PREFIX = 'replyModal'`, `buildModalId(interactionId)`, `buildReplyModal({ record, users, modalId })`, `isModalTimeout(error)`.
- No config change.

## Harness change (`test/support/fakes/discord.js`)

Model discord.js faithfully so the bug is reproducible:

- The world keeps a list of pending modal waits (`{ filter, resolve, reject }`), added by any interaction's `awaitModalSubmit(options)`.
- `awaitModalSubmit(options)` throws when `options.time` is not a number, as the real method does.
- `interaction.submit({ author, customId = modal.custom_id, user = interaction.user })` (`user` is `{ id, username }`) builds a modal-submit interaction carrying `user` and offers it to **every** pending wait in the world, across all interactions, in the order the waits were created. Each wait whose `filter` is absent or returns true resolves with it, is removed, and its handler is un-parked. A wait that rejects the submission stays pending and parked. `submit` never throws when no wait accepts; it settles and returns the modal-submit interaction.
- `interaction.timeout()` rejects that interaction's own pending wait with `Object.assign(new Error('Collector received no interactions before ending with reason: time'), { code: 'InteractionCollectorError' })`, and throws if that interaction has no pending wait.

## Edge cases

- Two users open the modal on different targets; user B submits first → only B's flow runs, with B's target; A's wait stays pending and A's later submit runs A's flow.
- Same user opens two modals (two interactions) → each submit resolves only its own interaction (distinct ids).
- A submission with a foreign `customId` or from another user is ignored and leaves the wait pending.
- Timeout → nothing sent, `MODAL_TIMEOUT_LOG` appears in `world.logs.log`, and both `world.logs.error` and `world.errors` are empty.
- A submit after the wait already resolved or timed out has no effect.
- `awaitModalSubmit` rejecting with any other error → one error log, nothing sent.

## Tests

- Update `test/characterization/reply-command.test.js`: modal `custom_id` is `replyModal:<interaction.id>`; `awaitModalSubmit` receives `time: 120000` and a `filter` function; the "different customId" case still yields no reply; timeout yields no `world.logs.error` entry. The harness smoke test and `test/unit/discord/replyModal.test.js` that assert the old id are updated the same way.
- New scenario tests (`test/scenarios/reply-modal.test.js`) for each edge case above. The concurrent-users test must fail against the pre-change handler (verify by running it before changing the handler).
- Unit: `buildModalId`, `isModalTimeout`, `buildReplyModal` uses the given id.

## Docs

Remove the modal entry from README "Known issues".

## Acceptance

`npm test` passes; only the listed characterization assertions change.
