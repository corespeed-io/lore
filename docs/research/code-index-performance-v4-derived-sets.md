# Code Index performance v4: shared symbol and dependency sets

Date: 2026-08-15  
Benchmark revision: `code-index-performance-v4-derived-sets`  
Decision: **ship shared derivation sets while retaining exact-generation resolution overlays**

Indexer protocol: `ast-grep-0.45.1-web-structural-graph-v6-derived-sets`

## Decision

Lore should deduplicate immutable parser output, but it must not deduplicate facts
whose truth depends on the requested revision.

The final layout is:

```text
Code Artifact membership (revision + path + range)
  -> shared text payload
  -> shared ordered path-free Symbol Set
  -> shared ordered path-free Dependency Set

Code Dependency Edge (exact generation)
  -> source Artifact + dependency ordinal
  -> resolved / ambiguous / unresolved target overlay
```

Text, symbol derivations, raw dependency target/site data, and module bindings are
content-addressed once per Workspace and `CODE_INDEX_REVISION`. Artifact membership,
path-qualified identities, and dependency resolution remain generation-local. The
latter cannot be shared safely: an unchanged call site can resolve differently when
another file is added, removed, renamed, or changes its exports.

The database, rather than only TypeScript, verifies the split. An Artifact may
reference only text/symbol/dependency payloads with the generation's indexer
revision. A `BEFORE INSERT` trigger rejects an edge ordinal that does not belong to
the source Artifact's Dependency Set. Shared payloads are immutable under the
application roles and are garbage-collected only after the final Artifact membership
is pruned.

## Rejected intermediate design

The first implementation gave every raw dependency member its own content-addressed
UUID, Workspace id, revision digest, and indexes. It reduced incremental relation
growth from 22.23 MiB to 15.66 MiB, but increased fresh growth from 43.11 MiB to
53.85 MiB. After two revisions it was still 6.47% larger than v3.

The measured result invalidated that design. Grouping ordered dependencies per
Artifact amortizes CAS identity, and deriving the set id through `from_artifact_id`
keeps the resolution overlay compact. The final overlay stores only the dependency
ordinal rather than duplicating the set UUID.

## Same-corpus comparison

v3 and v4 used the same Apple M4 Pro host, PostgreSQL 18.4, Lore commit pair, 332
indexed files per revision, warm retrieval, concurrency 1, and 20 measured read
iterations. Operating-system, Git-object, and PostgreSQL caches were not flushed,
so wall-clock indexing and tail latency are diagnostic rather than controlled causal
measurements.

| Metric | v3 text payload CAS | v4 derived sets | Change |
| --- | ---: | ---: | ---: |
| Fresh Code-relation growth | 43.11 MiB | 47.72 MiB | +10.69% |
| Incremental Code-relation growth | 22.23 MiB | 15.47 MiB | **-30.40%** |
| Total after two revisions | 65.72 MiB | 63.66 MiB | **-3.13%** |
| Same-generation no-op growth | 0 | 0 | unchanged |
| Fresh Artifact memberships | 4,462 | 4,462 | unchanged |
| Incremental Artifact memberships | 4,463 | 4,463 | unchanged |
| Incremental symbol rows / new shared members | 3,546 | 1 | **99.97% fewer new members** |
| Incremental dependency overlays | 20,780 | 20,780 | intentionally unchanged |
| Incremental new Dependency Sets | n/a | 242 | shared raw derivations |
| Incremental new dependency members | 20,780 inline copies | 2,291 | **88.97% fewer new raw members** |

The first revision is larger because shared-set identity, integrity, GC, and lookup
indexes are real overhead. This commit pair crosses break-even on the second
revision. Repositories with little unchanged parser output may not cross that point;
retention policy and revision similarity remain part of the storage model.

The 20,780 target-revision edge overlays are not failed deduplication. They are the
minimum exact-generation projection currently retained for direct graph reads. A
future delta-encoded resolution layer could reduce them only if it preserves bounded
exact-revision reads and explicit unresolved/ambiguous state; v4 does not make that
claim.

## Read latency and quality

| Warm read | v3 p50 / p95 | v4 p50 / p95 |
| --- | ---: | ---: |
| Symbol-heavy search | 20.12 / 22.55 ms | 16.52 / 17.03 ms |
| Identifier literal search | 19.87 / 21.17 ms | 16.38 / 17.22 ms |
| Punctuation-only search | 22.15 / 23.22 ms | 18.85 / 20.25 ms |
| Callers | 39.01 / 48.24 ms | 24.60 / 25.39 ms |
| Callees | 22.52 / 23.29 ms | 19.90 / 21.84 ms |
| Joint contextual traversal | not recorded in final v3 report | 73.15 / 76.10 ms |

The first shared-set run exposed a callees p50 regression to 43.7 ms because it
filtered on a reconstructed `path || '#' || suffix`. Splitting that into an exact
Artifact path predicate plus a path-free suffix predicate and adding a partial
source-symbol index restored the read gate. One of 20 v4 `Memory Proposal` search
samples took 134.06 ms; with this harness's percentile calculation that single
maximum is also reported as p95/p99. It is a tail outlier, not evidence of a stable
improvement.

Result counts and top evidence stayed unchanged for the benchmark queries. The
forbidden-Workspace tripwire and suspended-Membership checks passed. Focused tests
cover rename remapping, exact source reconstruction, graph callers/callees,
Memory-to-Code evidence, joint retrieval, RLS, immutability, invalid edge ordinals,
indexer revision separation, and last-reference garbage collection.
The final repository run passed all 73 test files and all 519 tests, plus TypeScript
type checking, targeted Biome checks, and `git diff --check`.

## Remaining bottleneck

This is a durable-storage optimization, not a scalable build pipeline. Fresh index
still took 83.21 seconds and sampled 6.71 GiB peak RSS; the prior v3 run sampled
8.32 GiB, but cache and allocator state make the difference non-causal. The worker
still assembles a complete revision's source, Artifacts, and dependency arrays in
memory before final publication. File-level `building` checkpoints, manifest
coverage validation, and bounded-memory resume remain the next higher-priority Code
Index work.

## Reproduction

```bash
CODE_INDEX_BENCHMARK_DATABASE_URL=postgresql:///lore_code_index_benchmark \
  bun run benchmark:code-index --repository . \
  --base-commit 6188e3ab93a32b9e73a82753373ff2284e94d476 \
  --commit f422692f5143f0295663d913eefece804a3ee551 \
  --iterations 20 --warmups 5 \
  --output /tmp/lore-code-index-performance-v4.json
```

The target must be a migrated disposable database whose name contains `bench` or
`benchmark`. The v3 comparison source is
`/tmp/lore-code-index-performance-v3.json`; the final v4 result is
`/tmp/lore-code-index-performance-v4.json` on the benchmark host.
