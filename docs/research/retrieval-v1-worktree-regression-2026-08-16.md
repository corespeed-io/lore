# Retrieval-v1 Quality Regression — retrieval-grounding branch (2026-08-16)

Regression checkpoint for `codex/retrieval-grounding-joint-wip`: this branch
changes only the orchestration layer above the retrievers, so retrieval quality
should be unchanged from the module's expected behavior. Run on a freshly
migrated disposable database (`lore_wt_retrieval_benchmark`) with the local
deployment default embedding space `ollama/qwen3-embedding:0.6b` @1024
(`lore-embedding-v2`), hybrid search, no reranker, no query planner,
`bun run benchmark:retrieval` defaults (12 positive + 6 no-answer cases).

**Hard gates: isolation passed, zero hard failures, report valid.** Bob-owned
private tripwires never appeared in any Alice query across all variants.

| Variant | R@1 | R@K | MRR | nDCG | No-answer acc | Avg false | p95 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| lexical | 0.500 | 0.500 | 0.500 | 0.500 | 1.000 | 0.00 | 42 |
| hybrid@0.35 | 0.583 | 0.583 | 0.583 | 0.583 | 1.000 | 0.00 | 699 |
| hybrid@0.40 | 0.583 | 0.583 | 0.583 | 0.583 | 1.000 | 0.00 | 696 |
| hybrid@0.45 | 0.667 | 0.667 | 0.667 | 0.667 | 1.000 | 0.00 | 690 |
| hybrid@0.50 (default) | 0.750 | 0.750 | 0.750 | 0.750 | 0.833 | 0.17 | 691 |

Observations:

- Hybrid beats lexical by +25pp Recall@1 at the default threshold; the
  documented threshold tradeoff reproduces exactly — widening to 0.5 gains
  recall (`polaris`, `allergy`, `studio` recovered progressively) but admits
  one false answer on the `no-recovery-key` no-answer case, which is why the
  no-answer gate shares the quality bar.
- Persistent misses at every threshold: `backup`, `milk` (distractor wins),
  `incident` — the suite's known-hard paraphrase cases; they are candidates
  for reranker/planner variants, not threshold inflation.
- Warm hybrid p95 ≈ 690 ms is dominated by per-query embedding on local Ollama
  (~680 ms each on this machine); lexical alone is 42 ms.
- Workload: 93 embedding calls (20 documents, 73 queries), 5.4k input
  characters; no reranking or planning configured.

This is the deterministic CI-grade suite, not a leaderboard; treat it as the
branch's retrieval-layer regression baseline. Raw JSON retained outside the
repository (session scratchpad); rerun with `LORE_BENCHMARK_REUSE_INDEXED=1`
against the same database for cheap repeats.
