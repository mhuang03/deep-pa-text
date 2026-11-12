# Implementation specs

Each spec defines one change completely: behaviour, interfaces, schema and config changes, edge cases, required tests, and what it depends on. Implement a spec only when everything it depends on is merged. `CLAUDE.md` applies to all of them.

## Rules for implementing any spec

1. **Existing tests that pin superseded behaviour must be updated.** A spec's Tests section names the important ones, but the list is not exhaustive: run the whole suite, and for every existing test (characterization, unit, harness) that fails because the spec deliberately changes that behaviour, update the assertion to the new behaviour. Never weaken or delete a test for behaviour the spec does not change. List every changed existing test in the hand-back report.
2. **A later spec supersedes earlier contracts.** Where a spec changes a signature or rule from spec 02 or another earlier spec, the later spec wins. Do not edit earlier specs.
3. **Scenario tests** live in `test/scenarios/` (created by the first spec that needs it) and drive the bot through `createWorld()` exactly like the characterization tests.
4. **Harness changes are additive** unless the spec says otherwise, and every new fake capability gets a smoke test in `test/harness/harness.test.js`.
5. **Config.** Every new key goes in `src/config.js` with the stated default, is validated in `loadConfig` when the spec gives a valid range, is covered in `test/unit/config.test.js`, and is documented in the README configuration section.
6. **README.** The Docs section names topics; update every statement in `README.md` that the change makes inaccurate, including the known-issues list.
7. **Wiring.** New services are constructed in `src/container.js` and exposed on the container when tests need them.

## Index

| Spec | Title | Depends on |
| --- | --- | --- |
| [00](00-test-harness.md) | Test harness | — |
| [01](01-characterization-tests.md) | Characterization tests | 00 |
| [02](02-refactor.md) | Refactor to a modular architecture | 00, 01 |
| [10](10-ingest-fixes.md) | Ingest fixes (GIF metadata, inferred references) | 02 |
| [11](11-reply-modal-safety.md) | Reply-modal safety | 02 |
| [12](12-delivery-hardening.md) | Awaited sends, safe mentions, single response pipeline | 11 |
| [13](13-gif-resilience.md) | GIF resilience and variety | 02 |
| [14](14-llm-robustness.md) | LLM timeouts, retries, output sanitising | 02 |
| [15](15-bot-message-store.md) | Bot message store | 12 |
| [16](16-persona-weighting.md) | Weighted persona selection | 02 |
| [17](17-conversation-context.md) | Conversation context for replies | 14, 15 |
| [18](18-paired-examples.md) | Paired reply examples | 10, 17 |
| [19](19-rag-dedup.md) | Deduplicating retrieved examples | 15, 18 |
| [20](20-revive-context.md) | Context for revives | 17, 19 |
| [21](21-reply-chains.md) | Reply chains on bot messages | 15, 17, 19 |
| [22](22-typing-and-bursts.md) | Typing indicator and multi-message bursts | 21 |
| [23](23-webhook-delivery.md) | Webhook persona display (opt-in) | 22 |
| [24](24-edits-and-deletes.md) | Message edits and deletes (soft) | 15, 19, 21 |
| [25](25-backfill.md) | History backfill and vector sync | 10, 24 |

## Dependency order

```
00 → 01 → 02 ─┬─ 10 ───────────────┐
              ├─ 11 → 12 → 15 ─┐   │
              ├─ 13            │   │
              ├─ 14 ───────────┼─ 17 → 18 → 19 ─┬─ 20
              └─ 16 ───────────┼────────────────┴─ 21 ─┬─ 22 → 23
                               │                       └─ 24 → 25
                               └ (15 also feeds 19, 21, 24)
```

Waves that can run in parallel once their dependencies are merged: {10, 11, 13, 14, 16}, then 12, then 15, then 17, 18, 19, then {20, 21}, then {22, 24}, then {23, 25}. Specs in the same wave may touch `src/config.js`, `src/container.js` and `README.md`; make minimal edits there.

## Suggestions deliberately not specified

- **Revive after a bot reply.** Since the 10 AM–10 PM change, a bot reply as the last message blocks revives until a human speaks. Whether that is intended is a product decision for the maintainer, so no spec changes it.
