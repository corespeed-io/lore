# Code Dependency Graph benchmark

Date: 2026-08-14

## Scope

This benchmark exercises Lore's production domain seams against PostgreSQL 17.10:

- exact local-Git object reads for a base commit and one incremental commit;
- AST Artifact, Symbol, and Dependency Edge derivation;
- immutable generation persistence and blob reuse;
- bounded `callers` and `callees` queries under the request RLS role;
- a forbidden-Workspace tripwire and suspended-Membership revocation.

The database was an unclaimed Claimable Postgres instance in `us-east-2`. The
client ran from the US west coast. Results therefore include several remote
transaction round trips and are not a local query-engine latency gate.

## Dataset

The synthetic Git repository contained 251 TypeScript files. One shared function
had 250 static callers. The incremental commit changed one file while preserving
250 Git blobs.

| Metric | Value |
| --- | ---: |
| Base manifest entries | 251 |
| Base Artifacts | 751 |
| Incremental Artifacts | 752 |
| Persisted Dependency Edges across two generations | 1,500 |
| Warmups / measured iterations / concurrency | 5 / 20 / 1 |

## Results

| Operation | Result | Elapsed / p50 | p95 |
| --- | --- | ---: | ---: |
| Full index | 251 parsed, 0 reused | 5,245.9 ms | — |
| Incremental index | 1 parsed, 250 reused | 4,627.7 ms | — |
| Exact-generation no-op | 0 parsed, 251 reused | 733.2 ms | — |
| `callers(sharedTarget)` | 200 returned, truncated | 524.6 ms | 535.3 ms |
| `callees(sharedTarget)` | 0 returned | 524.2 ms | 532.6 ms |

The ordinary Code search controls measured roughly 375–462 ms p50 on the same
remote database, including zero-result queries. The similar zero-edge and
200-edge graph timings show that this run is dominated by remote transaction/RLS
round trips rather than result materialization.

Both isolation checks passed: the forbidden Workspace never appeared and a
suspended Membership immediately lost Code search and dependency access.

## Findings

The first full-repository attempt exposed a source-symbol foreign-key defect that
small fixtures missed: a structurally merged span could find an outer AST symbol
that was not represented by the Artifact containing the dependency site. Lore now
emits a symbol-level source only when that exact Artifact owns the Symbol row;
otherwise the edge remains conservatively file-level.

The unclaimed database's 100 MB cap could not hold base and incremental generations
for the complete Lore repository. This is an external fixture limit, not an index
limit, and motivated the bounded synthetic repository used above.

Correctness and isolation pass this benchmark. The remote latency numbers are a
baseline, not a production gate. Before setting an SLO, rerun the checked-in
`benchmark:code-index` harness against local Postgres and the intended Cloudflare
Hyperdrive topology, pinning dataset, commit, network region, cache state, and
generation counts.
