# Code Index performance v2 baseline

Date: 2026-08-15  
Benchmark revision: `code-index-performance-v2`  
Decision: **correctness pass; optimize indexing memory and reused-output storage**

Follow-up: the first storage slice is implemented and measured in
[`code-index-performance-v3-content-addressed.md`](code-index-performance-v3-content-addressed.md).
It deduplicates immutable Artifact text/search payloads, not yet Symbol or
dependency projections.

## Scope

This run separates four production-domain costs against local PostgreSQL instead
of blending them into one evaluation wall time:

1. a fresh logical base-revision index with no prior Lore Code rows;
2. an incremental adjacent revision with immutable Git-blob reuse;
3. warm exact-revision Code search and dependency reads;
4. the public `joint-memory-code-v2` contextual traversal over a real
   Memory-to-Code citation.

The harness also measures a same-generation no-op replay, process CPU/RSS,
database/relation growth, a forbidden-Workspace tripwire, and Membership
revocation. Retrieval concurrency is one, following the current decision not to
make concurrency an acceptance dimension yet.

## Environment and corpus

- Apple M4 Pro, 12 logical CPUs, 24 GiB RAM;
- macOS arm64, Bun 1.3.6;
- local PostgreSQL 18.4 (Homebrew);
- Lore commits `6188e3ab93a32b9e73a82753373ff2284e94d476` to
  `f422692f5143f0295663d913eefece804a3ee551`;
- 333 Git tree entries per revision, 332 indexed and one excluded;
- 20 measured iterations after five warmups for each read class.

"Fresh" here means empty Lore tenant/index rows. It is not a claim that operating-
system, Git-object, or PostgreSQL caches were flushed. A preliminary run before
the final run measured 113.7 seconds full and 23.3 seconds incremental, while the
final run measured 77.3 and 4.5 seconds. That spread is direct evidence that a
true cold-start SLO needs a dedicated cache-isolated host or reboot protocol.

## Indexing result

| Phase | Wall time | User + system CPU | Parsed / reused | Artifacts | Code-relation growth | Sampled peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Fresh base | 77.306 s | 74.161 s | 332 / 0 | 4,462 | 40.45 MiB | 5.14 GiB |
| Incremental target | 4.509 s | 0.894 s | 4 / 328 | 4,463 | 29.79 MiB | 4.87 GiB |
| Exact-generation no-op | 37.6 ms | 7.9 ms | 0 / 332 | 4,463 | 0 | 4.82 GiB process RSS |

The incremental run reused 98.8% of indexed files and took 5.8% of the final
fresh-run wall time. However, it added 73.7% as many Code-relation bytes as the
full base revision. Artifact rows doubled from 4,462 to 8,925 and dependency rows
doubled from 20,764 to 41,544. Lore is reusing parse/chunk computation but still
duplicating almost all immutable derived output into the new generation.

The 5.14 GiB fresh-index peak is also too high for the corpus size. The current
trusted-Git path collects the complete file snapshot, reusable/parsed Artifact
arrays, and dependency arrays before one generation transaction. The maintenance
worker delegates to that same all-at-once path; the present implementation does
not yet realize the file-checkpointed building-generation behavior described by
the intended architecture.

## Warm retrieval result

| Read | Result count | p50 | p95 |
| --- | ---: | ---: | ---: |
| Symbol `createMemoryModule` | 10 | 22.448 ms | 25.450 ms |
| Literal `workspace_id` | 10 | 20.960 ms | 22.990 ms |
| Phrase `Memory Proposal` | 10 | 21.500 ms | 22.947 ms |
| Punctuation `=>` | 10 | 24.018 ms | 24.486 ms |
| No-answer marker | 0 | 20.950 ms | 23.067 ms |
| 15 callers | 15 | 34.943 ms | 35.796 ms |
| 26 callees | 26 | 23.741 ms | 26.922 ms |

All exact-revision warm search classes stayed below 26 ms p95 locally, including
punctuation-only and no-answer scans. Both isolation tripwires passed.

## Contextual traversal result

The benchmark created one canonical Memory, cited the base revision's exact
`createMemoryModule` Artifact, and repeatedly called the production joint-context
module against the target revision.

| Route | Local state | Context state | p50 | p95 |
| --- | --- | --- | ---: | ---: |
| both | current | unknown | 87.982 ms | 184.007 ms |

`unknown` is the correct conservative result here: the subject exposes 26 direct
edges while v2 intentionally caps traversal at 25, and several external `Math.*`
calls are unresolved. The benchmark exposed that this previously appeared as
`not_assessed`; the implementation and red tests now report explicit
`truncated:before`, `truncated:after`, and `uncertain:<edge>` reasons.

Twenty samples make p95 effectively the maximum observed value, so 184 ms is a
diagnostic baseline rather than a stable production SLO. The result does show that
bounded contextual composition is materially more expensive than one Code search
while remaining far cheaper than indexing.

## Optimization order

1. **P0 — bounded-memory generation build.** Parse and persist complete files in
   checkpoints under `building`; release AST/source/Artifact arrays after each
   checkpoint; validate manifest coverage before `ready` and atomic activation.
2. **Partially complete — stop duplicating immutable reused payloads.** v3 stores
   chunk text plus content-only FTS/trigram indexes by Workspace, indexer revision,
   and SHA-256. Path/symbol memberships and dependency projections remain per
   revision, so a path-free file derivation payload is still future work.
3. **P1 — instrument database write amplification.** Record WAL bytes and statement
   timing for manifest, Artifact, Symbol, and dependency batches to explain the
   incremental wall time independently of parsing.
4. **P1 — stabilize contextual latency distribution.** Run at least 200 sequential
   warm samples for low-edge, near-limit, truncated, unresolved, and no-anchor
   classes before setting a p95 gate.
5. **P2 — controlled cold protocol.** Measure fresh process/database and genuinely
   cold filesystem/object-cache runs separately; never merge them with warm data.

## Reproduction

```bash
CODE_INDEX_BENCHMARK_DATABASE_URL=postgresql:///lore_code_index_benchmark \
  bun run benchmark:code-index --repository . \
  --base-commit HEAD^ --commit HEAD \
  --iterations 20 --warmups 5 \
  --output /tmp/lore-code-index-performance-v2.json
```

The database name guard requires `bench` or `benchmark`, and the harness truncates
tenant data in that disposable database before each run.
