# Lore Retrieval Invocation Policy — claude-sonnet-5

Generated: 2026-08-15T23:04:56.585Z

Suite version: 1; cases: 1; trials per case: 5.
Grounding policy: `retrieval-grounding-v1`.

`host-policy` runs Lore's production deterministic grounding gate. `host-forced-oracle` uses benchmark labels only as an architectural upper bound.

## Variant metrics

| Variant | Pass | Required-call recall | Unnecessary-call rate | Route | Exact revision | Clarify | Drill-down | Calls | p95 ms | Input tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| host-policy | 100.0% | 100.0% | — | 100.0% | 100.0% | — | — | 10 (2.00/case) | 47863 | 24 |

## Case results

| Variant | Case | Trial | Pass | Outcome | Calls | Route | Latency ms |
|---|---|---:|---:|---|---|---|---:|
| host-policy | adversarial/stale-confirmation | 1 | yes | answered | lore_retrieve_context | both | 25680 |
| host-policy | adversarial/stale-confirmation | 2 | yes | answered | lore_retrieve_context → lore_code_dependencies → lore_code_search | both | 33723 |
| host-policy | adversarial/stale-confirmation | 3 | yes | answered | lore_retrieve_context → lore_code_dependencies | both | 38731 |
| host-policy | adversarial/stale-confirmation | 4 | yes | answered | lore_retrieve_context → lore_code_dependencies → lore_code_dependencies | both | 47863 |
| host-policy | adversarial/stale-confirmation | 5 | yes | answered | lore_retrieve_context | both | 10070 |

## Notes

- The model saw schemas emitted by Lore's real MCP adapter. Tool results came from deterministic authorized benchmark fixtures.
- `primitive-auto`, `compound-auto`, and `compound-guided` measure model-selected invocation. `host-policy` applies the production required/auto/off gate; the oracle and always-on variants remain controls.
- Anthropic via Claude Code CLI includes its CLI agent harness context, so token counts are useful for comparing these variants but are not representative of a lean direct-API integration.
