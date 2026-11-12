# Spec 14: LLM robustness (timeouts, retries, output sanitising)

**Depends on:** 02. **Blocks:** 17.

## Problem

- The chat call has no explicit timeout (the SDK default is 10 minutes) and no handling of an empty completion.
- The model sometimes wraps its answer in quotes or emits JSON escapes (the system prompt asks for "JSON-safe" output), and nothing enforces Discord's 2000-character limit.

## Required behaviour

### Transport (`src/container.js`, `src/llm/chatClient.js`)

- The OpenAI-compatible client is constructed with `timeout: config.llm.timeoutMs` and `maxRetries: config.llm.maxRetries` in addition to `apiKey` and `baseURL`. The SDK then retries connection errors, 408, 409, 429 and 5xx with backoff, and aborts an attempt after the timeout.
- `chatClient.complete({ system, user })`:
  - sends the request (unchanged shape);
  - if the completion has no choices, or `message.content` is not a string, or it is empty after trimming, that attempt counts as an empty completion;
  - retries empty completions up to `config.llm.emptyRetries` additional times, then throws `Error('LLM returned an empty response')`;
  - errors thrown by the SDK are not retried here (the SDK already did) and propagate.

### Sanitising (`src/llm/sanitize.js`)

`sanitizeResponse(text) → string`, pure, applied by the generator to every completion before it is returned:

1. Trim.
2. If the whole text is wrapped in one pair of matching quotes (`"…"`, `'…'`, `“…”`) and is at least 2 characters long: for double quotes, try `JSON.parse`; if that yields a string, use it; otherwise (and for the other quote styles) strip the outer pair. Text that merely starts or ends with a quote is left alone.
3. Otherwise replace stray escapes left in unwrapped text: the two-character sequences `\n` → newline, `\"` → `"`, `\t` → tab.
4. Trim again.

`truncateForDiscord(content, max = config.discord.maxMessageLength)`: if longer than `max`, cut at `max`; if a whitespace character exists in the last 200 characters of the cut text, cut there instead; trim the end. Applied by the composer to the final content after GIF processing.

If the sanitised response is empty, `generator` throws `Error('LLM returned an empty response')` (the handler logs it and nothing is sent).

## Config

`llm.timeoutMs: 60000`, `llm.maxRetries: 2`, `llm.emptyRetries: 1`, `discord.maxMessageLength: 2000`.

## Harness change (`test/support/fakes/llm.js`)

`respondWith` additionally accepts, per response, `null` (content `null`), `''`, or `{ choices: [] }` to simulate empty completions; arrays may mix values.

## Edge cases

| Input | Output |
| --- | --- |
| `"hello there"` | `hello there` |
| `"line one\nline two"` (JSON string with escaped newline) | two lines |
| `'yo'` | `yo` |
| `“fancy”` | `fancy` |
| `"unterminated` | unchanged |
| `he said "hi" ok` | unchanged |
| `no way\nreally` (backslash-n as two characters, unwrapped) | two lines |
| `"` (single character) | unchanged |
| `   ` | `''` → generator throws |
| 2500 characters without spaces | 2000 characters |
| 2500 characters with a space at index 1950 | cut at 1950 |

- First completion empty, second valid → one reply, two LLM calls.
- Two empty completions → error logged, nothing sent, later messages still work.

## Tests

- Characterization: the wiring test for the DeepSeek client additionally expects `timeout: 60000` and `maxRetries: 2`. No other change.
- Unit: `sanitizeResponse` (table above, plus idempotency: sanitising twice equals once); `truncateForDiscord`; `chatClient` empty-completion retry and error propagation; `generator` applies sanitising and throws on empty.
- Scenario (`test/scenarios/llm.test.js`): quoted response is delivered unquoted; empty-then-valid; all-empty; over-long response delivered truncated to at most 2000 characters.

## Docs

README: note timeout/retry config and output cleaning.

## Acceptance

`npm test` passes.
