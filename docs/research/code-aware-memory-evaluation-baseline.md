# Code-Aware Memory Foundation Evaluation

Date: 2026-08-14  
Suite revision: `code-aware-memory-foundation-v1`  
Command: `bun run evaluate:code-aware-memory`

## Decision

**Current decision: pass the full workflow gate. Original baseline: 23/24.**

The unchanged suite now passes 24 of 24 cases (100%) with zero hard failures and
zero unsupported cases. The post-fix rerun measured p50 5.047 ms, p95 14.049 ms,
and max 17.845 ms in the same PGlite single-thread environment.

The original baseline below passed 23 of 24 cases (95.8%). Its sole failure was the
missing pending-Proposal Code Evidence seam; retaining that result here records the
adversarial test that drove the fix.

## Original baseline

| Gate | Result | Threshold |
| --- | ---: | ---: |
| Evidence recall@k | 100% | 90% |
| Exact-revision isolation | 100% | 100% |
| No-answer precision | 100% | 100% |
| Dependency resolution accuracy | 100% | 95% |
| Ambiguity honesty | 100% | 100% |
| Stale-state classification | 100% | 95% |
| RLS isolation | 100% | 100% |
| Workflow support | 66.7% | 100% |

PGlite single-thread probe latency was p50 6.261 ms, p95 22.340 ms, max 25.668
ms. These numbers validate bounded local execution only; they are not a hosted
Postgres or end-to-end agent latency SLO.

## Covered adversarial behavior

- exact symbol, path, punctuation-literal, exact-commit, and no-answer retrieval;
- imported calls, intentionally unresolved cross-file calls, same-name ambiguity,
  `this` method calls, and bounded fanout truncation;
- `current`, `moved`, `changed`, `deleted`, `ambiguous`, and `unverifiable` Code
  Evidence states, plus canonical Memory immutability during revalidation;
- proposals remaining non-canonical, submission-time immutable Code anchors, and
  accepted Memories receiving the same typed Code Evidence transactionally;
- cross-Workspace search isolation, private-Memory evidence isolation, and
  suspended-Membership revocation for search and dependency queries.

## Deliberate limits

The suite uses Lore's prepared-file fixture seam so it is deterministic and fast.
It does not authenticate fixture commits against a Git object database. Existing
Git-ingestion tests cover that invariant, but a future production gate should run
the same workflow through the trusted Git/job path.

The suite also excludes model answer quality, aliases/re-exports across richer
language ecosystems, hosted Postgres query plans, concurrency, production-scale
storage, and model calls/tokens/cost. The earlier Code Index benchmark remains the
performance baseline for real Postgres.

## P0 follow-up

Resolved. `memory_proposal_code_evidence` now snapshots repository, exact commit,
path, symbol/declaration locator, Artifact id, digest, and relationship under the
submitting Actor's RLS visibility. The human review surface exposes the anchor;
acceptance copies it transactionally without re-resolution, and an adversarial
integration test deletes the rebuildable generation/Artifact before acceptance.
The accepted historical Memory anchor still survives.
