# Lore Retrieval Invocation Policy — claude-sonnet-5

Generated: 2026-08-15T23:54:39.480Z

Suite version: 2; cases: 1; trials per case: 5.
Grounding policy: `retrieval-grounding-v3`.

`host-policy` runs Lore's production deterministic grounding gate. `host-forced-oracle` uses benchmark labels only as an architectural upper bound.

## Variant metrics

| Variant | Pass | Required-call recall | Unnecessary-call rate | Route | Exact revision | Clarify | Drill-down | Calls | p95 ms | Input tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| host-policy | 100.0% | — | — | — | — | 100.0% | — | 0 (0.00/case) | 0 | 0 |

## Case results

| Variant | Case | Trial | Pass | Outcome | Calls | Route | Latency ms |
|---|---|---:|---:|---|---|---|---:|
| host-policy | clarify/missing-commit | 1 | yes | clarified | none | — | 0 |
| host-policy | clarify/missing-commit | 2 | yes | clarified | none | — | 0 |
| host-policy | clarify/missing-commit | 3 | yes | clarified | none | — | 0 |
| host-policy | clarify/missing-commit | 4 | yes | clarified | none | — | 0 |
| host-policy | clarify/missing-commit | 5 | yes | clarified | none | — | 0 |

## Notes

- The model saw schemas emitted by Lore's real MCP adapter. Tool results came from deterministic authorized benchmark fixtures.
- `primitive-auto`, `compound-auto`, and `compound-guided` measure model-selected invocation. `host-policy` applies the production required/auto/off gate and, since `retrieval-grounding-v2`, returns the gate's clarification deterministically without a model turn when exact revision context is missing; the oracle and always-on variants remain controls.
- Anthropic via Claude Code CLI includes its CLI agent harness context, so token counts are useful for comparing these variants but are not representative of a lean direct-API integration.
