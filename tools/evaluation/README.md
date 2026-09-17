# Evaluation tools

Manual benchmarks and evaluation harnesses are grouped by the capability they
measure. Run the existing `bun run` commands from the repository root; moving
their implementation here does not change command names. These tools are
excluded from the runtime image.

| Directory | Purpose | Command families (`bun run …`) |
| --- | --- | --- |
| [`retrieval/`](retrieval/) | Synthetic and external-dataset retrieval runners, dataset parsing, and the shared retrieval suite | `benchmark:retrieval`, `benchmark:longmemeval*`, `benchmark:locomo*`, `benchmark:memoryagentbench*` |
| [`code/`](code/) | Code indexing/search and Memory-to-Code evidence evaluations | `benchmark:code-index`, `benchmark:code-search`, `evaluate:code-aware-memory`, `evaluate:code-aware-memory:stress` |
| [`context/`](context/) | Joint Memory + Code retrieval with synthetic and real-Git evidence | `evaluate:joint-memory-code`, `evaluate:joint-memory-code:real` |
| [`policy/`](policy/) | Agent retrieval-policy trials and runner adapters | `benchmark:retrieval-policy` |
| [`chunking/`](chunking/) | Memory chunk reconstruction and retrieval checks | `benchmark:memory-chunking` |
| [`graph/`](graph/) | Synthetic Graph renderer stress data | `benchmark:graph:seed`, `prototype:graph-scale` |
| [`shared/`](shared/) | Cross-family readers, judges, downloads, integrity checks, scoring, and usage accounting | Imported by the runners |

`*` denotes related commands, including dataset fetch and profile variants; see
[package.json](../../package.json) for their exact names. Domain-specific helpers
and output schemas stay with their runner family. The policy MCP fixture remains
in [`packages/mcp/benchmark-fixture.ts`](../../packages/mcp/benchmark-fixture.ts)
so its server dependency resolves within that package.

The standalone [dimension setup helper](retrieval/benchmark-migrate-dimensions.mjs)
documents how to prepare a disposable benchmark database for non-default embedding
dimensions. The Code SQL microbenchmark measures predicate strategies outside
production RLS; its timings are not application request latency.

Data stays under [`evaluation/`](../../evaluation/): `external/` records dataset
manifests, `suites/` contains versioned inputs, and ignored `datasets/` and
`results/` hold downloaded data and run artifacts. Keep dataset and result paths
relative to the repository root.

Use the [technical reference](../../docs/reference.md#verify-changes) for setup,
provider configuration, dataset preparation, and runner parameters. The
[research index](../../docs/research/README.md) links source audits and
[retained baselines](../../docs/research/README.md#retained-benchmark-reports);
their results apply to the recorded revision and workload.
