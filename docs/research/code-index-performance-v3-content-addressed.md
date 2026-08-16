# Code Index performance v3: content-addressed Artifact payloads

Date: 2026-08-15  
Benchmark revision: `code-index-performance-v3-content-addressed`  
Decision: **ship the payload layer; do not describe the whole Code Index as content-addressed yet**

Follow-up: shared Symbol/Dependency Sets are implemented and measured in
[`code-index-performance-v4-derived-sets.md`](code-index-performance-v4-derived-sets.md).

## What changed

Lore now separates an exact-revision Code Artifact membership from its immutable
text payload:

- `code_artifact_payloads` stores text plus content-only simple-FTS and trigram
  indexes once per Workspace, `CODE_INDEX_REVISION`, and SHA-256;
- PostgreSQL recomputes and checks `SHA-256(content)` instead of trusting the
  caller's digest;
- `code_artifacts` keeps revision, path, parser, symbol/declaration identity,
  range, and ordinal, and references one payload through a Workspace-qualified
  foreign key;
- rename reuse remaps path-qualified identities while retaining the same payload
  id;
- the application and maintenance roles may select and insert payloads but may
  not update them;
- deleting Artifact memberships garbage-collects a payload only after its last
  reference disappears. Memory Code Evidence remains an immutable hash/locator
  anchor and does not depend on rebuildable payload retention.

The public `CodeIndexModule`, HTTP, SDK, CLI, and MCP contracts did not change.
Search still selects one Workspace, repository, full commit OID, and active
generation before ranking.

## Adversarial verification

The implementation tests prove that:

1. unchanged and renamed chunks in adjacent commits share payload ids;
2. a changed file adds only new payload hashes;
3. identical bytes in different Workspaces do not share a payload row;
4. an application Actor cannot mutate payload text;
5. even an administrative write with a stale digest fails the database CHECK;
6. an indexer-revision mismatch cannot reuse prior parse output;
7. deleting one of two sharing generations retains the payload, while deleting
   the last membership collects it;
8. symbol, literal, punctuation-only, wildcard, lexical, graph, evidence,
   proposal, RLS, and exact-source reconstruction behavior remains green.

## Benchmark comparison

The v2 and v3 runs use the same Apple M4 Pro host, local PostgreSQL 18.4, Lore
commit pair, 332 indexed files per revision, one retrieval caller, and 20 measured
warm-read iterations. OS, Git-object, and PostgreSQL caches were not flushed, so
wall-time differences across runs are diagnostic rather than causal proof.

| Metric | v2 duplicated text | v3 content-addressed text | Change |
| --- | ---: | ---: | ---: |
| Fresh Artifacts | 4,462 | 4,462 | none |
| Fresh unique payloads | not separate | 4,204 | 5.78% intra-revision text dedup |
| Fresh Code-relation growth | 40.45 MiB | 43.11 MiB | +6.59% first-revision overhead |
| Incremental Artifacts | 4,463 | 4,463 | none |
| Incremental new payloads | 4,463 inline copies | 7 | 99.84% payload reuse |
| Incremental Code-relation growth | 29.79 MiB | 22.23 MiB | **−25.39%** |
| Incremental/full growth ratio | 73.65% | 51.56% | −22.09 points |
| Total Code relations after two revisions | 70.58 MiB | 65.72 MiB | **−6.89%** |
| Same-generation no-op growth | 0 | 0 | unchanged |

The fresh revision is modestly larger because membership rows now carry a
payload foreign key and the payload store has its own identity and GC indexes.
The design crosses break-even on this corpus by the second adjacent revision.

The storage win is intentionally bounded. The target generation still adds 4,463
Artifact memberships, 3,546 Symbol memberships, and 20,780 dependency rows. At
the end of the run, `code_dependency_edges` remains the largest Code relation at
about 22.4 MiB. Text payload dedup cannot make an unchanged revision near-zero
while those path/resolution projections remain generation-local.

## Timing and quality

| Phase/read | v2 | v3 final run |
| --- | ---: | ---: |
| Fresh index | 77.31 s | 77.32 s |
| Incremental index | 4.51 s | 10.77 s |
| No-op | 37.6 ms | 52.2 ms |
| Five search classes, p50 range | 20.95–24.02 ms | 19.57–22.15 ms |
| Five search classes, maximum observed p95 | 25.45 ms | 61.60 ms |
| Callers p50 / p95 | 34.94 / 35.80 ms | 39.01 / 48.24 ms |
| Callees p50 / p95 | 23.74 / 26.92 ms | 22.52 / 23.29 ms |

The v3 search join did not produce a stable latency regression: its final p50s
were slightly faster than v2, while one no-answer sample raised that class's p95.
Twenty samples are too few for a production tail claim.

The incremental wall time is also not attributable from these runs. Earlier v2
runs ranged from 4.5 to 23.3 seconds, and v3 iterations ranged from 9.8 to 21.2
seconds as caches changed. An initial v3 implementation that attempted an
`INSERT ... ON CONFLICT` for every reused payload was removed; the final path
first fetches hashes and inserts only the seven missing payloads. Statement-level
timing and WAL bytes are still required before making an indexing-latency claim.

Peak RSS remained unacceptable and highly variable (about 8.3 GiB in the final
fresh run). Payload dedup addresses durable storage, not the all-at-once in-memory
Git/AST build.

## Release judgment and next step

This slice passes its intended gate: it preserves correctness and isolation,
reuses 99.84% of target payloads, and reduces adjacent-revision relation growth by
25.39%. It is a sound content-addressed **text payload** layer.

It was not full repository CAS. v4 subsequently extracted path-free ordered
symbol/dependency derivations and retained path/resolution projections per
generation. The higher-priority remaining gap is still a bounded-memory,
file-checkpointed build so large repositories do not require multi-gigabyte process
residency.

## Reproduction

```bash
CODE_INDEX_BENCHMARK_DATABASE_URL=postgresql:///lore_code_index_benchmark \
  bun run benchmark:code-index --repository . \
  --base-commit 6188e3ab93a32b9e73a82753373ff2284e94d476 \
  --commit f422692f5143f0295663d913eefece804a3ee551 \
  --iterations 20 --warmups 5 \
  --output /tmp/lore-code-index-performance-v3.json
```

The disposable database name guard requires `bench` or `benchmark`. The raw
result used above is `/tmp/lore-code-index-performance-v3.json` on the benchmark
host.
