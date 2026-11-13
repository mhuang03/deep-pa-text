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
| [12](12-delivery-hardening.md) | Awaited sends, safe mentions, single response pipeline | 11, 14 |
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
| [23](23-webhook-delivery.md) | Webhook persona display (opt-in) and member profiles | 22 |
| [24](24-edits-and-deletes.md) | Message edits and deletes (soft) | 15, 18, 19, 20, 21, 22 |
| [25](25-backfill.md) | History import machinery, backfill and vector sync | 10, 15, 17, 21, 23, 24 |
| [26](26-full-reimport.md) | Full re-import from Discord (final step) | 23, 24, 25 |
| [27](27-config-and-startup-validation.md) | Configuration and startup validation | 26 |
| [28](28-lifecycle-and-restart-continuity.md) | Process lifecycle, gateway resilience and restart continuity | 27 |
| [29](29-vector-store-resilience.md) | Vector-store resilience | 28 |
| [30](30-reply-control-and-command-ack.md) | Reply control, cost limits and command acknowledgement | 29 |
| [31](31-output-safety.md) | Output safety, text handling and safe logging | 30 |
| [32](32-data-and-reimport-correctness.md) | Data, retrieval and re-import correctness | 31 |
| [33](33-standards-and-test-gaps.md) | Standards compliance and test gaps | 32 |
| [34](34-topic-bank.md) | Topic bank (clustered conversation topics) | 33 |
| [35](35-conversations.md) | Scripted conversations | 34 |
| [36](36-reimport-preflight.md) | Re-import preflight | 26, 32 |
| [37](37-mention-replies.md) | Mention replies, and no limits on manual engagement | 30, 35 |
| [38](38-named-persona-mentions.md) | Naming a persona in a mention | 37 |
| [39](39-named-persona-in-chains.md) | A named persona joins an existing chain | 38 |

Specs 27–33 come from the audit recorded in [`docs/audit/findings.md`](../audit/findings.md); each cites the findings it resolves.

## Implementation order

Each line is a wave; specs on one line touch disjoint areas and may be implemented in parallel, and a wave starts only when the previous one is merged.

```
00
01
02
10, 11, 13, 14, 16
12
15
17
18
19
20
21
22
23
24
25
26
27
28
29
30
31
32
33
34
35
36
37
38
39
```

Most later specs extend the same pipeline (responder, generator, prompts, message store), so they are implemented one at a time.

## Maintainer decisions

- **Revive blocking.** A bot message as the last activity blocks revives until a human speaks, within the 10 AM–10 PM rules. This is intended, but only for naturally spawned messages (auto replies and revives). Chain replies and command replies do not count. Specified in spec 21.
