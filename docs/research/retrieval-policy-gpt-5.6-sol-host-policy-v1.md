# Lore Retrieval Invocation Policy — gpt-5.6-sol

Generated: 2026-08-15T22:35:11.695Z

Suite version: 1; cases: 10; trials per case: 1.

Grounding policy: `retrieval-grounding-v1`.

`host-policy` runs Lore's production deterministic grounding gate. `host-forced-oracle` uses benchmark labels only as an architectural upper bound.

## Variant metrics

| Variant | Pass | Required-call recall | Unnecessary-call rate | Route | Exact revision | Clarify | Drill-down | Calls | p95 ms | Input tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| host-policy | 100.0% | 100.0% | 0.0% | 100.0% | 100.0% | 100.0% | 100.0% | 12 (1.20/case) | 18085 | 278577 |

## Case results

| Variant | Case | Trial | Pass | Outcome | Calls | Route | Latency ms |
|---|---|---:|---:|---|---|---|---:|
| host-policy | memory/prior-decision | 1 | yes | answered | lore_retrieve_context | memory-only | 4615 |
| host-policy | code/current-implementation | 1 | yes | answered | lore_retrieve_context | code-only | 4416 |
| host-policy | joint/decision-drift | 1 | yes | abstained | lore_retrieve_context → lore_code_dependencies → lore_code_dependencies → lore_code_search | both | 18085 |
| host-policy | general/supplied-rewrite | 1 | yes | answered | none | — | 3067 |
| host-policy | clarify/missing-commit | 1 | yes | clarified | none | — | 5576 |
| host-policy | drill-down/direct-callers | 1 | yes | answered | lore_retrieve_context → lore_code_dependencies → lore_code_dependencies | code-only | 13069 |
| host-policy | adversarial/stale-confirmation | 1 | yes | answered | lore_retrieve_context | both | 6218 |
| host-policy | memory/chinese-prior-decision | 1 | yes | answered | lore_retrieve_context | memory-only | 10727 |
| host-policy | code/chinese-current-implementation | 1 | yes | answered | lore_retrieve_context | code-only | 4603 |
| host-policy | general/chinese-brainstorm | 1 | yes | answered | none | — | 7760 |

## Notes

- The model saw schemas emitted by Lore's real MCP adapter. Tool results came from deterministic authorized benchmark fixtures.
- `primitive-auto`, `compound-auto`, and `compound-guided` measure model-selected invocation. `host-policy` applies the production required/auto/off gate; the oracle and always-on variants remain controls.
- Codex exec includes its agent harness context, so token counts are useful for comparing these variants but are not representative of a lean Responses API integration.
