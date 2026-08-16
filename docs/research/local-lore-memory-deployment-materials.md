# Local Lore Memory deployment: article research materials

Research date: 2026-08-12. This note inventories primary material in the running
local Lore deployment and the repository. It is an article brief, not a release
benchmark, leaderboard result, or SOTA claim.

## Research object

The local Lore corpus is a compact history of engineering decisions rather than a
generic document collection. Its own `[[index/lore-memory]]` Memory records 952 PR
evidence Memories,
34 repository-contribution pages, 16 topic pages, 16 technical-specification pages,
and one temporal digest. Its knowledge-layer rule is important for the article:
PR bodies are evidence; repository/topic/spec pages are curated interpretations
whose claims should resolve back to evidence.

This makes the corpus useful for three research questions:

1. How should a Memory system distinguish raw evidence, curated interpretation,
   and canonical claims?
2. Do stronger retrieval components actually give a reader more answerable
   evidence, or merely improve parent-document metrics?
3. Can quality be evaluated without treating authorization, provenance, conflict,
   and reproducibility as separate afterthoughts?

Primary local Memory references:

- `[[index/lore-memory]]`
- `[[topic/retrieval]]`
- `[[topic/retrieval/specs]]`
- `[[me/spinsirr/2026-08-03-to-2026-08-12]]`
- `[[pr/corespeed-io/lore/66]]`
- `[[pr/corespeed-io/lore/69]]`
- `[[pr/corespeed-io/lore/80]]`
- `[[pr/corespeed-io/corespeed-haas/268]]`

## Strongest research findings

### Retrieval stages do not improve quality monotonically

On a held-out 15-question LoCoMo slice, the fixed local M4 Pro profile measured:

| Variant | Answer F1 | Evidence R@10 | Search ms/query |
| --- | ---: | ---: | ---: |
| Hybrid | 0.5090 | 0.5111 | 219 |
| Planner | 0.5349 | 0.5778 | 1,511 |
| Reranker | **0.5654** | 0.5111 | 1,209 |
| Planner + reranker | 0.5518 | **0.5778** | 2,340 |

The planner widened candidate recall; the reranker improved reader-facing order.
Stacking them improved some evidence metrics but did not produce the best answer F1.
Source: [`locomo-local-qwen35-4b-ablation.md`](locomo-local-qwen35-4b-ablation.md).

### One reranker helped accurate retrieval and hurt conflict retrieval

On 100 MemoryAgentBench Accurate Retrieval questions, the local Qwen3 0.6B
reranker raised Recall@1 from `0.72` to `0.89` and MRR from `0.8299` to `0.9375`.
Average search latency rose from `113 ms` to `1,156 ms`, with `1,734 ms` p95.

On the two-source, 200-question Conflict workload, the non-reranked profile reached
exact evidence R@10 `0.800` and MRR `0.4370` at `178 ms`. The same reranker reduced
R@10 to `0.755`; the later compact-input contract reduced it to `0.720` and MRR to
`0.3686` while still taking `930 ms`.

The defensible interpretation is narrow: a relevance cross-encoder can improve
semantic passage ordering without learning the workload's temporal/latest-value
semantics. Reranking is a calibrated deployment profile, not a universal quality
switch. Source: [`local-reranker-apple-silicon.md`](local-reranker-apple-silicon.md).

### A Memory hit is not necessarily answer evidence

One audited Conflict profile reported parent-Memory Recall@10 `0.800`, but exact
answer-evidence Recall@10 only `0.635`. Counting the parent id overstated what the
reader could answer. When a bounded evidence budget could cover the whole small
Memory, returning all of its chunks in order restored exact evidence R@10 to
`0.800` and MRR from `0.3697` to `0.4370` without crossing a Memory or RLS boundary.

The article's central metric claim should therefore be: evaluate the evidence the
reader actually receives, not merely whether a parent document appeared in top-k.

### More retrieval depth has rapid diminishing returns

In a 12-question LongMemEval smoke run, one feedback query moved R@10 from `0.9792`
to `1.00` while average end-to-end latency rose from `1,534 ms` to `2,187 ms`. In
the Conflict profile, a second feedback hop moved multi-hop-source R@10 only from
`0.440` to `0.450`, raised latency to `269 ms`, and lowered evidence MRR to `0.3618`.

This supports treating recursive retrieval as an explicit quality/latency/drift
tradeoff rather than free “deeper thinking.”

### Embedding spaces are deployment protocols, not interchangeable settings

The local Memory `[[pr/corespeed-io/corespeed-haas/268]]` preserves a prior A/B on
121 real Memories and 196 author-declared true edges. Moving Gemini
`embedding-001` to `embedding-2` at the same 1,536 dimensions changed pairwise AUC
from `0.848` to `0.872`, graph-neighbor Recall@1 from `40.9%` to `47.8%`, and
Recall@5 from `70.4%` to `78.3%`. It also required recalibrating the similarity
threshold from `0.85` to `0.84` and fully re-embedding the corpus.

The current Lore protocol consequently binds provider, model, dimension, and
preprocessing revision into an embedding generation. Model changes build a full
new generation before activation; vectors from incompatible spaces are never
mixed. See [`0001-deployment-embedding-configuration.md`](../adr/0001-deployment-embedding-configuration.md).

### Privacy failures are benchmark hard failures

The synthetic retrieval runner executed 90 queries under the non-owner `lore_app`
role and planted near-duplicate private Memories as high-rank tripwires. Its local
Qwen3-Embedding 0.6B diagnostic measured Recall@K `1.0`, MRR `0.9583`, nDCG
`0.9692`, and no-answer accuracy `0.8333`, with isolation passing. The key research
rule is not the small-suite quality number: one RLS leak invalidates the run and is
never averaged away by relevance.

Sources: local Memory `[[pr/corespeed-io/lore/66]]`,
[`memory-benchmark-paper-provenance.md`](memory-benchmark-paper-provenance.md), and
the RLS-first retrieval implementation summarized by local Memory
`[[pr/corespeed-io/lore/69]]`.

## Claim limits

- The LoCoMo result covers 35 total positive questions across development and
  held-out slices, not the full 1,540 positive QA set.
- The LongMemEval result is a 12-question smoke run.
- Historical local ablations that predate the generation-scoped validator are
  research observations and need a pinned rerun before becoming release defaults.
- The strongest local embedding profile changed query preprocessing, structured
  chunking, and lexical specificity together; its gain cannot be assigned to one
  factor.
- Benchmark names alone do not make runs comparable. Dataset bytes and split,
  memory granularity, reader and judge revision, prompts, decoding, top-k, evidence
  budget, latency boundary, and provider usage must all be pinned.

## Recommended article thesis

> After organizing 952 pull requests as evidence rather than prose, we discovered
> that AI Memory is not one retrieval problem. Candidate recall, evidence ordering,
> answer-evidence assembly, temporal reasoning, and authorization are separate
> failure surfaces. More models, more queries, and deeper retrieval do not
> guarantee a better answer.

The article should use the running corpus as its concrete setup, lead with the
non-monotonic reranker/planner results, use the parent-Memory versus exact-evidence
gap as the metric correction, and close on the RLS hard-failure rule. That is a
research report about a system, not a product manifesto.

## Experimental setting (supporting detail)

The measurements were reproduced in the active local deployment. At the research
cutoff it contained 1,020 visible Memories and one complete active embedding
generation covering all 4,441 eligible chunks, with no missing chunks or queued/dead
jobs. The service reported healthy database, schema, vector, RLS-role, application,
and maintenance components. Hardware and local model inventory belong in a methods
footnote or appendix; they are not the article's subject.
