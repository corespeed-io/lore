# Research and evaluation reports

These are dated source audits and measured results, not deployment instructions.
Use the [current guides](../README.md) for setup and the
[architecture guide](../architecture.md) for source paths. Model comparisons,
implementation snapshots, and timings apply only to each report's recorded
revision and workload. Proposed experiments are not shipped capabilities.

## Retained benchmark reports

- [Memory chunking v2](memory-chunking-v2-benchmark.md) — reconstruction and retrieval checks.
- [Code-aware Memory foundation](code-aware-memory-evaluation-baseline.md) — Artifact and citation correctness.
- [Code dependency stress](code-aware-memory-dependency-stress-baseline.md) — adversarial dependency resolution.
- [Code dependency graph](code-dependency-graph-benchmark.md) — graph correctness, coverage, and cost.
- [Code Index performance v4](code-index-performance-v4-derived-sets.md) — shared derivation storage, read latency, and remaining build limits.
- [Joint Memory + Code synthetic v2](joint-memory-code-v2-baseline.md) — bounded routing and side-effect-free assessment.
- [Joint Memory + Code real-Git v6](joint-memory-code-real-git-v6-baseline.md) — exact-revision contextual impact and reader evaluation.

## Retrieval and local inference

- [Query-time Memory retrieval audit](query-time-memory-retrieval-audit.md)
- [Model retrieval tool design](model-retrieval-tool-best-practice.md)
- [Apple Silicon reranker audit](local-reranker-apple-silicon.md)
- [Proposed reranking experiments](reranking-next-experiments.md)
- [Ollama benchmark reader](ollama-benchmark-reader.md)
- [Gemini embedding API audit](google-gemini-embeddings-api.md)

## Benchmark and paper provenance

- [Memory benchmark paper provenance](memory-benchmark-paper-provenance.md)
- [LoCoMo runner audit](locomo-runner-audit.md)
- [LongMemEval V2 adoption](longmemeval-v2-adoption.md)
- [LongMemEval V2 multimodal protocol](longmemeval-v2-multimodal.md)
- [CAR paper and implementation audit](car-paper-implementation-audit.md)
- [Mem0 token-efficient algorithm audit](mem0-token-efficient-algorithm-audit.md)

## Code search and visualization

- [Code-search benchmark methodology](code-search-benchmark-community.md)
- [Large D3 force graphs](d3-large-force-graph.md)

Superseded benchmark versions, one-off model traces, and completed handoffs are
available in Git history. The executable benchmark harnesses and fixtures remain
under `scripts/benchmarks`, `scripts/evaluation`, and `evaluation`.
