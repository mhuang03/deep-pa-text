# Spec 31: Output safety, text handling and safe logging

**Depends on:** 30. **Blocks:** 32. **Audit findings:** A21, A22, A23, A25, A30, A38, A56, A57, A61, A66, A67, A68.

## Problem

- Generated text is posted as-is. A member can steer the model into emitting a masked phishing link or an invite, which the bot then posts under another member's name.
- Nothing limits the number of GIF tokens in a response: forty tokens mean 120 API requests and a payload Discord rejects.
- A failed webhook send logs the error object, whose `url` contains the webhook token. Other error logs could contain API keys embedded in request URLs.
- Quote handling has gaps: a multi-part answer wrapped in one pair of quotes keeps stray quotes; `"yes" or "no"` loses its outer quotes; over-cap burst parts are merged before their quotes are stripped.
- Truncation by UTF-16 length can cut a surrogate pair in transcript lines and example text, sending a lone surrogate to the LLM and embedding APIs.
- `src/discord/webhookDelivery.js` imports from `src/llm/` (an upward import).
- A failure while building the transcript fails the whole reply; error logs do not say which message or persona was involved.

## Required behaviour

### Text utilities (`src/util/text.js`, pure)

- `truncateCodePoints(text, max, { ellipsis = '' } = {})`: at most `max` code points, never splitting a surrogate pair; `ellipsis` appended when something was cut.
- `truncateForDiscord` moves here unchanged (callers and tests updated; `src/llm/sanitize.js` no longer exports it). This removes the upward import from `src/discord/`.
- Transcript entries, reply-example `them` text, the modal preview and the webhook name all use `truncateCodePoints`.

### Link removal (`src/corpus/links.js`, pure)

The URL handling of the corpus transformers is exported as pure functions and reused: `stripLinks(text)` replaces a markdown link `[text](url)` with `text`, removes bare `http(s)` URLs (including the `<…>` form) and `discord.gg/…` invites, exactly as the corpus filter does. The corpus transformers call the same functions (no behaviour change there).

### Sanitising (`src/llm/sanitize.js`)

Unwrapping (step 2 of `sanitizeResponse`) applies only when the text between the outer quotes contains no unescaped quote character of the same kind (for `“…”`, neither `“` nor `”`). `"yes" or "no"` is therefore left alone, while `"hello there"` and `"she said \"hi\""` are unwrapped. Idempotency must hold for every input in the tests, including a doubled backslash before a quote.

### Post-processing (`src/llm/postProcess.js`)

Order: (1) trim and unwrap the whole text once (handles a whole answer wrapped in quotes); (2) split on `<split>` **without** merging overflow; (3) for each part: `sanitizeResponse`, `stripLinks`, `limitGifTokens`, trim; (4) drop empty parts; (5) merge parts beyond `burst.maxMessages` onto the last allowed part with newlines. `response` is the kept parts joined with the split marker, as today.

`limitGifTokens(text, max)` (`src/gifs/gifTokens.js`): keeps the first `gifs.maxPerMessage` GIF tokens of a part and removes the rest from the text.

### Embed cap (`src/discord/payload.js`)

A payload never carries more than Discord's 10 embeds: GIF image embeds are cut so that, together with the author embed when present, the total is at most `discord.maxEmbeds`.

### Safe logging (`src/logger.js`)

`createLogger(sink = console, { secrets = [] } = {})`:

- Every `Error` argument is rendered as text by `formatError(error)`: its `stack` (or `name: message`), followed by ` [code=… status=…]` when those properties exist, followed by `\n  caused by: …` for a `cause` chain (at most 3 levels). Objects are never passed through for the console to dump, so library error properties such as a request `url` are not printed.
- Every string that is logged (including formatted errors) has each non-empty value in `secrets` replaced by `[redacted]`.

The container builds the logger with the secret values from the configuration and environment: the Discord token, the LLM key, the embedding key, and the three GIF keys. Webhook tokens are covered by never dumping error objects; in addition `formatError` output is passed through a pattern that redacts `/webhooks/<id>/<token>` paths.

`logger.debug` is added (forwarding to `sink.debug`), and per-item diagnostics that the specs called "debug" use it.

### Error context

Handler boundaries log which work failed. `src/bot/logLines.js` gains `formatFailure({ what, messageId, trigger, persona, stage })`, used as the label of every handler-level error log (for example `Error processing message 123 (auto reply as bob, stage delivery):`). The responder attaches `stage` (`'context' | 'generation' | 'delivery'`) and `persona` to the errors it rethrows by wrapping them in a new `Error` with `cause` (no mutation of the caught error; this also replaces the `Object.assign` marker in `responder.js`).

### Transcript failures are not fatal (`src/bot/responder.js`)

If `contextBuilder.forReply` or `forRevive` throws, the responder logs a warning and continues with an empty context (no transcript), as a failed history fetch already does.

## Config

`gifs.maxPerMessage: 2` (integer ≥ 0), `discord.maxEmbeds: 10`.

## Edge cases

| Model output | Delivered |
| --- | --- |
| `check [free nitro](http://phish.example) now` | `check free nitro now` |
| `join discord.gg/abc now` | `join  now` (as the corpus filter does) |
| `https://example.com` only | part dropped; if it was the only part, the response counts as empty |
| `"a <split> b"` | parts `a` and `b` |
| `"a"\n<split>\n"b"\n<split>\n"c"\n<split>\n"d"` with a cap of 3 | `a`, `b`, and `c` + newline + `d`, no stray quotes |
| `"yes" or "no"` | unchanged |
| `"hello"` | `hello` |
| five GIF tokens in one part, cap 2 | two tokens resolved, three removed from the text, no placeholder for them |
| 12 resolved GIFs across the cap (cap raised in a test) | at most 9 image embeds plus the author embed |

- A transcript entry or `them` text whose 300th character is the first half of an emoji → cut before the emoji; the prompt contains no lone surrogate (assert with a regular expression for unpaired surrogates).
- Webhook send rejects with an error object carrying `url: 'https://discord.com/api/v10/webhooks/1/SECRET'` → no log line contains `SECRET`.
- An error whose message contains the Klipy key → logged with `[redacted]`.
- `formatError` on a non-Error value → its string form; on an error with a three-level cause chain → all three.
- `contextBuilder.forReply` throws → the reply is still generated and sent, without a transcript; one warning.
- Error log for a failed auto reply names the message id, the persona and the stage.

## Tests

- Unit: `truncateCodePoints` (ASCII, astral characters at the boundary, ellipsis, shorter input); `stripLinks` (each form; parity with the corpus filter over the spec 01 URL rows); unwrap rule (table above plus idempotency including the doubled-backslash case); `postProcess` order (each table row); `limitGifTokens`; payload embed cap; `formatError` and redaction (secrets, webhook paths, cause chain, no object dump); `logger.debug`; `formatFailure`; responder stage tagging without mutation and the context fallback.
- Scenario (`test/scenarios/output-safety.test.js`): link stripping end to end in embed and webhook mode; GIF cap; webhook failure log contains no token; lone-surrogate check on the LLM request.
- A layering unit test is added in spec 33; here it is enough that `grep -rn "from '../llm" src/discord` finds nothing.
- Existing tests: sanitise tests for the changed unwrap rule; imports of `truncateForDiscord`; logger tests (errors are now strings).

## Docs

README: output cleaning (links removed, GIF cap), logging (redaction), configuration table.

## Acceptance

`npm test` passes. No `logger.*` call site passes a raw error object that reaches the console unformatted (the logger guarantees it).

## Amendments after review (these override the text above where they differ)

1. **GIF cap after merging.** `limitGifTokens` runs on each **final** part, after overflow parts were merged, so the cap is per delivered message.
2. **`stripLinks` is its own function, for generated output only** (`src/util/links.js`); the corpus filter is not changed. It replaces a markdown link with its text for any target (case-insensitive scheme, optional `<…>`, optional title, parentheses inside the URL): `/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g` → `$1`; then removes bare URLs with any scheme (`/<?\b[a-z][a-z0-9+.-]*:\/\/[^\s>]+>?/gi`), `www.`-prefixed hosts, and invites (`discord.gg/…`, `discord.com/invite/…`, `discordapp.com/invite/…`, `dsc.gg/…`). Test rows: `[x](<http://e.example>)`, `[x](HTTP://e.example)`, `[x](http://a.example/p_(1))`, `[x](https://a.example "title")`, `www.e.example/x`, each invite form; all leave no link.
3. **Sanitising is a fixed point.** `sanitizeResponse` repeats unwrap-then-unescape until the text stops changing (each change shortens it, so it terminates); the cap of three unwraps is removed. Tests assert `f(f(x)) === f(x)` over a list including nested quotes and doubled backslashes. `unwrapQuotes` is exported for the whole-text step, so escapes are not replaced twice. A single-quoted text containing an apostrophe (`'it's fine'`) is not unwrapped; accepted.
4. **Dangling quotes after a split.** After splitting, a part that starts or ends with a double quote and contains no other unescaped double quote has that quote removed (`"a <split> b" <split> "c"` → `a`, `b`, `c`). With bursts disabled the single part gets the same cleaning.
5. **Secrets.** `config.embedding.apiKey` is read in the configuration from the variable named by `apiKeyEnvVar` (the embedding function still receives the variable name). `secretsOf(config)` returns the Discord token, LLM key, embedding key and GIF keys, omitting values shorter than 8 characters, longest first; the logger also redacts each secret's URL-encoded form. **One** logger is created in each entry point (`main.js`, scripts) with those secrets and injected into the container; nothing else constructs a logger; entry-point error output goes through it.
6. **Logger arguments.** Non-string, non-Error objects are rendered with `util.inspect(value, { depth: 1 })` and then redacted. `logger.debug` is **not** added.
7. **Responder errors.** The responder rethrows `new Error(original.message, { cause: original })` carrying own properties `stage` (`'generation'` or `'delivery'`; there is no `'context'` stage), `persona` and `trigger`. Handlers keep testing `error.stage === DELIVERY_STAGE`. The handler's catch supplies `messageId` to `formatFailure`.
8. **Context fallback.** A throwing `forReply` yields `{ transcript: [] }`; a throwing `forRevive` yields `{}`. Chain context is unaffected.
9. **Truncation.** GIF query truncation in `gifTokens.js` and the webhook-name cut also use `truncateCodePoints` (replacing `cutToCodePoints`). The "modal preview" is the one introduced by spec 30. Transcript and prompt tests that counted UTF-16 units are updated to code points.
10. **`buildPayload({ content, gifLinks, authorEmbed, maxEmbeds = 10 })`**; both delivery adapters pass `config.discord.maxEmbeds`.
