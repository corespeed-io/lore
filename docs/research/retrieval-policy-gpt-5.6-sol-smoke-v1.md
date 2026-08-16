# Lore Retrieval Invocation Policy — gpt-5.6-sol

Generated: 2026-08-15T22:10:39.185Z

Suite version: 1; cases: 6; trials per case: 1.

`host-forced-oracle` uses benchmark labels only as an architectural upper bound. It does not measure a production invocation classifier.

## Variant metrics

| Variant | Pass | Required-call recall | Unnecessary-call rate | Route | Exact revision | Clarify | Drill-down | Calls | p95 ms | Input tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| primitive-auto | 83.3% | 100.0% | 0.0% | 100.0% | 100.0% | 100.0% | 100.0% | 20 (3.33/case) | 26603 | 435751 |
| compound-auto | 83.3% | 100.0% | 0.0% | 100.0% | 100.0% | 100.0% | 100.0% | 13 (2.17/case) | 25962 | 366795 |
| compound-guided | 83.3% | 100.0% | 0.0% | 100.0% | 100.0% | 100.0% | 100.0% | 12 (2.00/case) | 20644 | 412583 |
| host-forced-oracle | 66.7% | 100.0% | 0.0% | 75.0% | 100.0% | 100.0% | 100.0% | 11 (1.83/case) | 19600 | 272029 |
| always-on | 50.0% | 100.0% | 100.0% | 75.0% | 100.0% | 100.0% | 100.0% | 11 (1.83/case) | 25403 | 221556 |

## Interpretation

- All three model-selected variants retrieved on the four ordinary must-call cases, but the primitive surface required 20 calls versus 13 for compound-auto and 12 for compound-guided.
- Every model-selected variant unnecessarily searched Memory before correctly asking for a missing exact commit. Tool invocation recall alone therefore overstates policy quality.
- `host-forced-oracle` failed the Memory case because the current deterministic router recognizes `agreed`, not the query's `agree`; forcing the compound call cannot compensate for a brittle internal route.
- Always-on retrieval incurred a 100% unnecessary-call rate on the supplied-text transformation and also inherited the route failure. This rejects unconditional retrieval as the default policy.
- This is a one-trial smoke run. Repeat trials and a lean Responses API harness are required before setting release thresholds.

## Case results

| Variant | Case | Trial | Pass | Outcome | Calls | Route | Latency ms |
|---|---|---:|---:|---|---|---|---:|
| primitive-auto | memory/prior-decision | 1 | yes | answered | lore_search → lore_search | — | 14195 |
| primitive-auto | code/current-implementation | 1 | yes | answered | lore_code_search → lore_code_search → lore_code_search → lore_code_search → lore_code_dependencies → lore_code_dependencies → lore_code_search | — | 21400 |
| primitive-auto | joint/decision-drift | 1 | yes | answered | lore_code_search → lore_search → lore_code_search → lore_code_search → lore_code_search → lore_code_search → lore_code_search → lore_code_dependencies → lore_code_dependencies | — | 26603 |
| primitive-auto | general/supplied-rewrite | 1 | yes | answered | none | — | 2975 |
| primitive-auto | clarify/missing-commit | 1 | no | clarified | lore_search | — | 12751 |
| primitive-auto | drill-down/direct-callers | 1 | yes | answered | lore_code_dependencies | — | 10317 |
| compound-auto | memory/prior-decision | 1 | yes | answered | lore_search → lore_search | — | 15794 |
| compound-auto | code/current-implementation | 1 | yes | answered | lore_retrieve_context → lore_code_search | code-only | 12938 |
| compound-auto | joint/decision-drift | 1 | yes | answered | lore_retrieve_context → lore_code_search → lore_code_search → lore_code_search → lore_code_search → lore_code_dependencies → lore_code_dependencies | both | 25962 |
| compound-auto | general/supplied-rewrite | 1 | yes | answered | none | — | 5604 |
| compound-auto | clarify/missing-commit | 1 | no | clarified | lore_search | — | 13255 |
| compound-auto | drill-down/direct-callers | 1 | yes | answered | lore_code_dependencies | — | 8915 |
| compound-guided | memory/prior-decision | 1 | yes | answered | lore_retrieve_context | memory-only | 9086 |
| compound-guided | code/current-implementation | 1 | yes | answered | lore_retrieve_context | code-only | 12669 |
| compound-guided | joint/decision-drift | 1 | yes | abstained | lore_retrieve_context → lore_code_dependencies → lore_code_dependencies → lore_code_search | both | 20644 |
| compound-guided | general/supplied-rewrite | 1 | yes | answered | none | — | 4770 |
| compound-guided | clarify/missing-commit | 1 | no | clarified | lore_retrieve_context → lore_retrieve_context → lore_retrieve_context | memory-only → memory-only | 18561 |
| compound-guided | drill-down/direct-callers | 1 | yes | answered | lore_retrieve_context → lore_code_dependencies → lore_code_dependencies | code-only | 20098 |
| host-forced-oracle | memory/prior-decision | 1 | no | abstained | lore_retrieve_context | abstain | 3759 |
| host-forced-oracle | code/current-implementation | 1 | yes | answered | lore_retrieve_context | code-only | 3880 |
| host-forced-oracle | joint/decision-drift | 1 | yes | abstained | lore_retrieve_context → lore_code_dependencies → lore_code_dependencies → lore_code_search | both | 16558 |
| host-forced-oracle | general/supplied-rewrite | 1 | yes | answered | none | — | 3737 |
| host-forced-oracle | clarify/missing-commit | 1 | no | clarified | lore_retrieve_context → lore_retrieve_context → lore_retrieve_context | memory-only → memory-only | 19600 |
| host-forced-oracle | drill-down/direct-callers | 1 | yes | answered | lore_retrieve_context → lore_code_dependencies | abstain | 10042 |
| always-on | memory/prior-decision | 1 | no | abstained | lore_retrieve_context | abstain | 4361 |
| always-on | code/current-implementation | 1 | yes | answered | lore_retrieve_context | code-only | 4409 |
| always-on | joint/decision-drift | 1 | yes | abstained | lore_retrieve_context → lore_retrieve_context → lore_code_dependencies → lore_code_dependencies → lore_code_search | both → both | 25403 |
| always-on | general/supplied-rewrite | 1 | no | answered | lore_retrieve_context | abstain | 3023 |
| always-on | clarify/missing-commit | 1 | no | clarified | lore_retrieve_context | abstain | 5738 |
| always-on | drill-down/direct-callers | 1 | yes | answered | lore_retrieve_context → lore_code_dependencies | abstain | 10635 |

## Notes

- The model saw schemas emitted by Lore's real MCP adapter. Tool results came from deterministic authorized benchmark fixtures.
- `primitive-auto`, `compound-auto`, and `compound-guided` measure model-selected invocation. The two host variants pre-execute the compound read according to their named policy.
- Codex exec includes its agent harness context, so token counts are useful for comparing these variants but are not representative of a lean Responses API integration.
