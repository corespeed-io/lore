# Joint Memory + Code v2 baseline

Date: 2026-08-14  
Revision: `joint-memory-code-v2`  
Decision: **pass**

## Change under test

V2 separates one-target Code Evidence freshness into two operations:

- `assess` computes a typed `current`/`moved`/`changed`/`deleted`/`ambiguous`/
  `unverifiable` result inside the Actor/RLS transaction and performs no write;
- `revalidate` calls the exact same transaction-local resolver, then explicitly
  persists the result only when the Actor can write the cited Memory.

Joint retrieval now uses only `assess`. Its plan vocabulary is
`needsLocalAssessment`, and the prototype revision is
`joint-memory-code-prototype-v2`.

## TDD findings

Two red tests exposed observable defects:

1. There was no way to preview the target state without updating
   `memory_code_evidence`.
2. When a shared-Memory reader without write authority called `revalidate`, RLS
   filtered the update to zero rows, but the implementation selected and returned
   the old row as if persistence had succeeded. `UPDATE ... RETURNING id` now makes
   zero-row persistence an explicit access denial.

The orchestration gate also caught a nullable-locator bug: merging assessment
fields with `??` restored the historical path for `deleted`, `ambiguous`, and
`unverifiable`. These states now retain a null validated target.

## Evaluation

Command:

```bash
bun run evaluate:joint-memory-code -- \
  --strict \
  --output /tmp/joint-memory-code-v2.json
```

The 13-case PGlite suite passed every gate: route accuracy, required-evidence
recall, Memory top-1, anchor-state accuracy, contextual-impact accuracy,
conflict accuracy, zero leakage, context efficiency, and lower retrieval harm.

| Variant | Route | Evidence recall | Memory top-1 | Anchor state | Precision | Avg evidence | Harm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Always-on union | 53.8% | 100% | 87.5% | 0% | 81.0% | 1.615 | 30.8% |
| Selective | 100% | 100% | 87.5% | 0% | 94.4% | 1.385 | 7.7% |
| + anchors | 100% | 100% | 100% | 0% | 94.4% | 1.385 | 7.7% |
| + local assessment | 100% | 100% | 100% | 100% | 94.4% | 1.385 | 7.7% |
| + contextual impact | 100% | 100% | 100% | 100% | 94.4% | 1.385 | 7.7% |

The `deleted`, `ambiguous`, and `unverifiable` cases all return
`validatedPath=null`.

