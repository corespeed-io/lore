# Lore Retrieval Invocation Policy — gpt-5.6-sol

Generated: 2026-08-15T22:13:06.854Z

Suite version: 1; cases: 1; trials per case: 1.

`host-forced-oracle` uses benchmark labels only as an architectural upper bound. It does not measure a production invocation classifier.

## Variant metrics

| Variant | Pass | Required-call recall | Unnecessary-call rate | Route | Exact revision | Clarify | Drill-down | Calls | p95 ms | Input tokens |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| primitive-auto | 0.0% | 0.0% | — | 0.0% | 0.0% | — | — | 0 (0.00/case) | 8976 | 32301 |
| compound-auto | 0.0% | 0.0% | — | 0.0% | 0.0% | — | — | 0 (0.00/case) | 11686 | 32916 |
| compound-guided | 100.0% | 100.0% | — | 100.0% | 100.0% | — | — | 1 (1.00/case) | 12425 | 49259 |
| host-forced-oracle | 0.0% | 100.0% | — | 0.0% | 0.0% | — | — | 1 (1.00/case) | 4332 | 15935 |
| always-on | 0.0% | 100.0% | — | 0.0% | 0.0% | — | — | 1 (1.00/case) | 5252 | 15932 |

## Interpretation

- With generic guidance, both primitive-auto and compound-auto made zero retrieval calls after the user said “Do not search”; they abstained instead of verifying and correcting the stale claim.
- The explicit grounding contract overrode that instruction, called the compound tool once, selected both Memory and exact-revision Code, and correctly rejected the stale claim.
- Host forcing guaranteed invocation, but the current keyword router abstained. Invocation guarantees and internal Memory/Code routing must therefore be evaluated as separate layers.
- This is one adversarial case with one trial; it demonstrates a failure mode, not a calibrated population rate.

## Case results

| Variant | Case | Trial | Pass | Outcome | Calls | Route | Latency ms |
|---|---|---:|---:|---|---|---|---:|
| primitive-auto | adversarial/stale-confirmation | 1 | no | abstained | none | — | 8976 |
| compound-auto | adversarial/stale-confirmation | 1 | no | abstained | none | — | 11686 |
| compound-guided | adversarial/stale-confirmation | 1 | yes | answered | lore_retrieve_context | both | 12425 |
| host-forced-oracle | adversarial/stale-confirmation | 1 | no | abstained | lore_retrieve_context | abstain | 4332 |
| always-on | adversarial/stale-confirmation | 1 | no | abstained | lore_retrieve_context | abstain | 5252 |

## Notes

- The model saw schemas emitted by Lore's real MCP adapter. Tool results came from deterministic authorized benchmark fixtures.
- `primitive-auto`, `compound-auto`, and `compound-guided` measure model-selected invocation. The two host variants pre-execute the compound read according to their named policy.
- Codex exec includes its agent harness context, so token counts are useful for comparing these variants but are not representative of a lean Responses API integration.
