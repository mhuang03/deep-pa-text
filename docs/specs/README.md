# Implementation specs

Each spec defines one change completely: behaviour, interfaces, schema and config changes, edge cases, required tests, and what it depends on. Implement a spec only when everything it depends on is merged. `CLAUDE.md` applies to all of them.

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
| [21](21-reply-chains.md) | Reply chains on bot messages | 15, 16, 17, 19 |
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
