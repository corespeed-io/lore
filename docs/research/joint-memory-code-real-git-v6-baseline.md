# Joint Memory + Code real-Git v6 baseline

Date: 2026-08-15  
Production packet revision: `joint-memory-code-v2`  
Evaluation revision: `joint-memory-code-real-git-v6`  
Decision: **pass**

## Change under test

V6 replaces the public change route's placeholder contextual result with a
bounded, exact-revision dependency comparison. Local citation freshness and
contextual impact remain separate:

- local assessment asks whether the cited Artifact itself is current, moved,
  changed, deleted, ambiguous, or unverifiable;
- contextual assessment compares direct callee/import/reference fingerprints
  between the cited commit and requested commit;
- at most five citation anchors and 25 direct edges per anchor are traversed;
- symbol subjects are path-qualified, so unrelated same-name declarations do not
  create false ambiguity;
- a dependency target's fingerprint covers its complete logical declaration
  chunk sequence, not only the first Artifact;
- missing history, ambiguity, unresolved targets, and truncation remain explicit
  uncertainty rather than being treated as unaffected.

The orchestration still calls side-effect-free `assess`; it does not persist Code
Evidence revalidation or mutate Memory.

## Adversarial correctness tests

The focused HTTP integration test holds the cited `tenantGuard` Artifact byte-for-
byte constant while changing only a direct dependency, `policyCheck`. It also adds
an unrelated same-name `tenantGuard` and makes `policyCheck` large enough to span
multiple structural chunks, with the change only in the final chunk.

The result remains:

- local state: `current`;
- contextual state: `affected`;
- stored citation state: unchanged at its historical commit.

This catches both bare-symbol ambiguity and the false-negative caused by hashing
only the first chunk of a logical declaration.

## Strict real-Git result

The trusted-Git corpus indexes two adjacent Lore commits:

- 326 manifest entries in each revision;
- 4,173 base Artifacts and 4,177 target Artifacts;
- 307 target files reused from immutable prior parse/chunk output.

All production gates passed. The two routed change cases produced
`possibly_affected` with concrete added/removed call edges; non-change routes kept
`contextualImpact=null`. No case fell back to `not_assessed`.

With the isolated GPT-5.6 reader (`gpt-5.6-sol`, low reasoning, empty read-only
working directory, no tools/plugins), the result was:

| Variant | Route accuracy | Memory recall | Code recall | Anchor accuracy | Reader pass |
| --- | ---: | ---: | ---: | ---: | ---: |
| Code only | 0.500 | 0.500 | 0.833 | 0.000 | not run |
| Always-on union | 0.500 | 1.000 | 0.833 | 0.000 | 0.667 |
| Selective final | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |

This continues to reject unconditional Memory injection while showing that the
new contextual receipt does not regress bounded answer generation.

## Limits and next measurement

This is six hand-authored cases from one adjacent commit pair, not a repository-
disjoint benchmark. Contextual traversal is deliberately one-hop; it is not a
transitive blast-radius engine. Exact active generation ids are not yet included
in the public receipt.

Fresh evaluation indexing was visibly measured in minutes on this development
machine, while the contextual comparison itself is bounded. The next performance
gate should separately instrument cold base indexing, incremental target indexing,
warm retrieval, contextual traversal, parsed/reused file counts, database growth,
and peak memory instead of reporting one blended wall time.

Reproduction:

```bash
bun run evaluate:joint-memory-code:real -- \
  --strict \
  --reader-provider codex \
  --model gpt-5.6-sol \
  --database /path/to/an/initialized/evaluation-pglite-directory \
  --output /tmp/joint-memory-code-real-git-v6-gpt56.json
```
