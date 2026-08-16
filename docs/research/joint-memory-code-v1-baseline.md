# Joint Memory + Code v1 prototype baseline

Date: 2026-08-14  
Revision: `joint-memory-code-v1`  
Command: `bun run evaluate:joint-memory-code --strict`

## Decision

**Bounded prototype gate: pass. Production/default-MCP gate: not evaluated.**

The deterministic 13-case corpus supports the proposed state model: independently
authorized Memory and Code retrieval, a selective `memory-only` / `code-only` /
`both` / `abstain` route, typed anchor expansion, exact-revision local
revalidation, and a separate one-hop contextual-impact state can produce a grouped
evidence packet without merging source authority or raw scores.

This is a scratch-PGlite logic and retrieval evaluation. It does not establish
model answer quality, learned routing quality, production latency, or broad
repository generalization.

## Ablation result

| Variant | Route accuracy | Required evidence recall | Memory top-1 | Anchor state | Contextual impact | Evidence precision | Avg. evidence items | Retrieval harm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Code only | 30.8% | 52.9% | 0% | 0% | 0% | 100% | 0.692 | 0% |
| Memory only | 7.7% | 47.1% | 87.5% | 0% | 0% | 66.7% | 0.923 | 30.8% |
| Always-on union | 53.8% | 100% | 87.5% | 0% | 0% | 81.0% | 1.615 | 30.8% |
| Selective routes | 100% | 100% | 87.5% | 0% | 0% | 94.4% | 1.385 | 7.7% |
| + typed anchors | 100% | 100% | 100% | 28.6% | 0% | 94.4% | 1.385 | 7.7% |
| + local revalidation | 100% | 100% | 100% | 100% | 0% | 94.4% | 1.385 | 7.7% |
| + contextual impact | 100% | 100% | 100% | 100% | 100% | 94.4% | 1.385 | 7.7% |

Every variant returned zero cross-Workspace evidence. The final variant also
classified every expected explicit contradiction and freshness conflict.

The comparison is deliberately source-preserving. Memory and Code scores are
never treated as calibrated against each other; required evidence and precision
are scored after grouping.

## Adversarial cases

The fixture exercises:

1. a rationale Memory whose exact code declaration moved;
2. a current-implementation query that should pay no Memory cost;
3. a locally changed declaration;
4. a byte-identical anchor whose resolved callee changed;
5. a dependency-impact query;
6. a deleted target;
7. a historical target that becomes ambiguous across two identical declarations;
8. an indexed historical anchor against an unavailable target revision;
9. an explicit `contradicts` relationship;
10. a Memory-only personal preference;
11. an exact-symbol Code-only query;
12. an exact-revision no-answer query; and
13. a neutral query that should abstain.

The same repository key, commit, Memory terms, and code terms are seeded in a
forbidden Workspace. No forbidden Memory, Artifact, anchor, path, or marker appears
in any result.

## Red-green finding: anchor-aware Memory priority

The first run reached 100% required-evidence recall but failed a more revealing
top-1 check. For the rationale query, an unrelated formatting Memory mentioning
`deploymentGuard` ranked ahead of the reviewed rationale. Selective routing alone
therefore did not solve within-source distraction.

The prototype now applies one stable source-local rule after anchor expansion:
Memories carrying a typed Code anchor rank before otherwise equal unanchored
Memories, while original Memory order is preserved within both groups. Memory
top-1 rose from 87.5% to 100%. It does not combine Memory and Code scores or remove
unanchored Memories.

This validates typed anchors as a staged orchestration signal in the fixture. It
does not prove the rule generalizes; the next corpus needs relevant unanchored
rationales and misleading/stale anchors as negative controls.

## Contextual freshness result

The `authorizeRequest` declaration is byte-identical at both revisions, so local
anchor revalidation correctly reports `current`. Its resolved `checkPolicy` callee
changes content, so the separate bounded contextual state reports `affected`.

This demonstrates why local anchor state and contextual impact cannot be one enum.
The prototype compares one-hop resolved callee fingerprints only:

- a known dependency content change is `affected`;
- an added/removed or resolution-changing edge is `possibly_affected`;
- truncation, ambiguity, unresolved targets, or missing content is `unknown`;
- no observed bounded change is `unaffected`.

These states describe static evidence, not runtime truth.

## Implementation shape

- `src/lib/joint-memory-code-prototype.ts` contains the pure route, grouped packet,
  anchor-priority, and contextual-impact functions.
- `scripts/lib/joint-memory-code-prototype-fixture.ts` owns the disposable PGlite
  corpus and real Lore Memory/Code/RLS orchestration.
- `scripts/evaluate-joint-memory-code.ts` runs every ablation and release gate.
- `scripts/prototype-joint-memory-code.ts` exposes the same cases in a one-screen
  interactive terminal shell through `bun run prototype:joint-memory-code`.

All prototype files are explicitly marked throwaway. No production HTTP, SDK,
MCP, database schema, or default retrieval behavior uses them.

## Deliberate limits and next falsification

The current pass is necessary but not sufficient:

- the route policy is a deterministic English keyword baseline, not a trained or
  model-planned policy;
- retrieval uses prepared files rather than trusted Git ingestion;
- the corpus is synthetic and small;
- there is no reverse Artifact-to-Memory lookup;
- contextual impact covers one-hop static callees, not callers, tests,
  configuration, generated files, external dependencies, or runtime dispatch;
- there is no claim-level reader, citation entailment judge, patch generation, or
  repository test execution;
- latency is scratch-PGlite concurrency one and is not a production SLO.

Before this becomes a default MCP `lore_context` capability, run a temporal,
repository-disjoint corpus with a fixed reader and score answer correctness,
citation completeness/entailment, false-premise abstention, repository tests, and
point-to-point regressions. Include unanchored relevant Memory, stale/misleading
anchors, future-history leakage, graph truncation, and dynamic-runtime unknowns.
