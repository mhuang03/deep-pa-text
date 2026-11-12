# Spec 14: LLM robustness (timeouts, retries, output sanitising)

**Depends on:** 02. **Blocks:** 17.

## Problem

- The chat call has no explicit timeout (the SDK default is 10 minutes) and no handling of an empty completion.
- The model sometimes wraps its answer in quotes or emits JSON escapes (the system prompt asks for "JSON-safe" output), and nothing enforces Discord's 2000-character limit.

## Required behaviour

### Transport (`src/container.js`, `src/llm/chatClient.js`)

- The OpenAI-compatible client is constructed with `timeout: config.llm.timeoutMs` and `maxRetries: config.llm.maxRetries` in addition to `apiKey` and `baseURL`. The SDK then retries connection errors, timeouts, 408, 409, 429 and 5xx with backoff, and aborts an attempt after the timeout. (The SDK defaults are a 10-minute timeout and 2 retries; this makes both explicit and bounded.)
- Worst case before a failure is reported: `(maxRetries + 1) × timeoutMs` per completion, times `emptyRetries + 1`. With the defaults that is 2 × 120 s × 2 = 8 minutes; the common failure (one timeout, then success) costs 120 s. The timeout is generous because the model runs with thinking enabled.
- `chatClient.complete({ system, user })`:
  - sends the request (unchanged shape);
  - if the completion has no choices, or `message.content` is not a string, or it is empty after trimming, that attempt counts as an empty completion;
  - retries empty completions up to `config.llm.emptyRetries` additional times (same request each time), then throws `Error('LLM returned an empty response')`;
  - returns a non-empty completion's content unmodified (sanitising is the generator's job);
  - errors thrown by the SDK are not retried here (the SDK already did) and propagate after a single call.

### Sanitising (`src/llm/sanitize.js`)

`sanitizeResponse(text) → string`, pure, applied by the generator to every completion before it is returned:

1. Trim.
2. Unwrap, repeated until the text is no longer wrapped (at most 3 times): if the whole text is wrapped in one pair of matching quotes (`"…"`, `'…'`, `“…”`) and is at least 2 characters long, then for double quotes try `JSON.parse` and use the result if it is a string; otherwise (and for the other quote styles) strip the outer pair. Trim after each unwrap. Text that merely starts or ends with a quote is left alone.
3. Replace stray escapes: the two-character sequences `\n` → newline, `\"` → `"`, `\t` → tab. This also rewrites a literal backslash-n the persona might have meant (for example a Windows path); that is accepted.
4. Trim again.

The function is idempotent: `sanitizeResponse(sanitizeResponse(x)) === sanitizeResponse(x)`.

`truncateForDiscord(content, { maxLength, lookback })`: if `content.length <= maxLength`, unchanged. Otherwise cut to `maxLength` UTF-16 units; if the cut would split a surrogate pair, cut one unit earlier; if a whitespace character exists within the last `lookback` characters of the cut text and cutting there leaves non-empty text, cut there instead; trim the end.

The composer applies `truncateForDiscord` to the content **after** GIF processing, with `config.discord.maxMessageLength` and `config.discord.truncateLookbackChars`. Only the delivered content is truncated; the `response` the composer returns (used for logging and, later, storage) is the sanitised, untruncated text. A response that is only a GIF token still yields empty content plus the GIF embed, as today.

If the sanitised response is empty, `generator` throws `Error('LLM returned an empty response')` (the handler logs it and nothing is sent).

## Config

`llm.timeoutMs: 120000`, `llm.maxRetries: 1`, `llm.emptyRetries: 1` (integer ≥ 0), `discord.maxMessageLength: 2000`, `discord.truncateLookbackChars: 200`.

## Harness change (`test/support/fakes/llm.js`)

`respondWith` additionally accepts, per response, `null` (content `null`), `''`, or a plain object with a `choices` key, which is returned as the completion verbatim (for example `{ choices: [] }`); arrays may mix values. `callClients` entries are the full constructor options, including `timeout` and `maxRetries`. The fake does not simulate the SDK's own retries or timeout; tests assert the constructor options only.

## Edge cases

| Input | Output |
| --- | --- |
| `"hello there"` | `hello there` |
| `"line one\nline two"` (JSON string with escaped newline) | two lines |
| `'yo'` | `yo` |
| `“fancy”` | `fancy` |
| `"unterminated` | unchanged |
| `"\"hi\""` (a JSON string whose value is itself quoted) | `hi` |
| `"a\\nb"` (JSON string containing backslash-n) | `a`, newline, `b` |
| `he said "hi" ok` | unchanged |
| `no way\nreally` (backslash-n as two characters, unwrapped) | two lines |
| `"` (single character) | unchanged |
| `   ` | `''` → generator throws |
| 2500 characters without spaces | 2000 characters |
| 2500 characters with a space at index 1950 | cut at 1950 |
| 2500 characters with the only space at index 1700 | 2000 characters (outside the lookback) |
| an astral character (surrogate pair) straddling index 2000 | 1999 units, no lone surrogate |

- First completion empty, second valid → one reply, two LLM calls.
- Two empty completions → error logged, nothing sent, later messages still work.

## Tests

- Characterization: assertions that deep-compare the chat client's constructor options (`generation.test.js`) gain `timeout: 120000, maxRetries: 1`; the wiring test asserts them too. No other change.
- Unit: `sanitizeResponse` (table above, plus idempotency over every table row); `truncateForDiscord`; `chatClient` empty-completion retry, `emptyRetries: 0` throws after one call, an SDK error is not retried (one call); `generator` applies sanitising and throws on empty; composer truncates only the delivered content.
- Scenario (`test/scenarios/llm.test.js`): quoted response is delivered unquoted; empty-then-valid; all-empty; over-long response delivered truncated to at most 2000 characters.

## Docs

README: note timeout/retry config and output cleaning.

## Acceptance

`npm test` passes.
