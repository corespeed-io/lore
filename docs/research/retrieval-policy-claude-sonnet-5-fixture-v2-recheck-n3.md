# Retrieval Policy Fixture v2 Recheck — claude-sonnet-5 (N=3)

Grounding policy `retrieval-grounding-v3`; suite version 4; fixture change: the benchmark fixture now includes the
`reviewRequired` guard implementation artifact and a resolved `submitMemoryProposal -> reviewRequired`
callee edge, so evidence-sufficiency questions have a true answer in evidence.

| Variant | Case | Before (insufficient fixture) | After (fixture v2) |
|---|---|---:|---:|
| compound-auto | code/chinese-current-implementation | 2/3 | 3/3 |
| compound-auto | code/current-implementation | 1/3 | 3/3 |
| compound-auto | joint/decision-drift | 1/3 | 3/3 |
| host-policy | code/chinese-current-implementation | 1/3 | 3/3 |
| host-policy | code/current-implementation | 3/3 | 3/3 |
| host-policy | joint/decision-drift | 0/3 | 3/3 |

Total: 18/18 after, versus 8/18 on the same cases in the baseline run.
Every failure in the baseline on these cases was an `abstained` outcome (or a missing evidence citation)
caused by the fixture citing `reviewRequired` without defining it; with the definition present, the model
answers and cites `src/lib/memory.ts` consistently in both English and Chinese. The baseline report
(`retrieval-policy-claude-sonnet-5-baseline-v4-n3`) remains the honest pre-fix record.
