# Local reranking: next experiments

Research date: 2026-08-10. Sources are limited to original papers, publisher
model cards, official documentation, and source repositories. Published model
scores below are evidence for choosing an experiment, not a substitute for a
Lore benchmark.

## Decision

Keep **Hybrid as the default**. In the 32-case real-Memory diagnostic, Hybrid
reached Recall@1 `0.5625`, MRR `0.7255`, and p50 `267 ms`; the current
Qwen3-Reranker-0.6B path reached Recall@1 `0.6250`, MRR `0.7786`, and p50
`1,869 ms`. Reranking won seven cases and lost five, its two-sided McNemar
result was `p ~= 0.774`, and both paths reached Recall@10 `1.0`. This is a small,
hand-built diagnostic, not a release-quality evaluation, but it says two useful
things: the candidate pool contains the target, while always-on pairwise
reranking has not yet justified roughly seven times the median latency.

The best next isolated model experiment is
[`jinaai/jina-reranker-v3.5`](https://huggingface.co/jinaai/jina-reranker-v3.5)
through its official Apple-Silicon
[`MLX` port](https://huggingface.co/jinaai/jina-reranker-v3.5-mlx). It is a
0.6B **listwise** model: one forward pass jointly encodes the query and candidate
list, allowing cross-document comparison instead of repeating the query in ten
independently scored cross-encoder pairs. The publisher's unified top-100 evaluation
reports stronger BEIR, MIRACL, RTEB, and structured-retrieval results than
Qwen3-Reranker-0.6B, and the paper reports a 305 ms mean for its short-context
top-100 A100 test. Those are vendor measurements on different data and hardware;
only a Lore M4 run can establish local quality or latency.

This must initially remain a **research-only profile**. The weights are CC
BY-NC 4.0, the Apple port is a Python library rather than a Lore-compatible HTTP
server, and the published speed result uses A100 FlashAttention-2. The official
GGUF package also requires a separate projector and a llama.cpp fork because its
non-causal encoder mode and token-output support are not yet in upstream
llama.cpp. None of those constraints applies to the current Apache-2.0 Qwen
default.

The best latency-oriented companion experiment is candidate-only late
interaction with
[`LiquidAI/LFM2.5-ColBERT-350M`](https://www.liquid.ai/blog/lfm2-5-retrievers).
Its publisher measured query encoding plus MaxSim at p50 `8.2 ms` on an M4 Max
when document token vectors were cached. The uncached p50 `34.3 ms` measurement
covers only one 256-token document, so it cannot be extrapolated to Lore's ten
candidates. A safe first test should encode only the already RLS-authorized
candidate passages online; it does not need a new global index. The model covers
11 listed languages but not Chinese, uses the custom LFM 1.0 license, and its
published quality comparison is against first-stage embedding models rather than
Qwen's cross-encoder, so it is a speed hypothesis rather than a proven quality
upgrade.

Regardless of which model wins, the best product architecture to test is a **routed
cascade**: return Hybrid for high-confidence lookups and call the reranker only
for ambiguous, paraphrased, aggregate, or multi-hop queries. Adaptive-RAG is
evidence that a small classifier can route queries among strategies by
complexity, but Lore must learn its own routing labels from actual ranking
outcomes; the current 32 cases are far too few to train such a router
([paper](https://aclanthology.org/2024.naacl-long.389/)). Until then, an explicit
"deep search" path is safer than a learned gate.

The new, unreviewed AgentIR preprint is directly aligned with long-term memory:
its BM25-margin cascade skipped the dense channel on 63% of 500 LongMemEval
queries at parity judged accuracy and reported a 2.67x speedup
([paper](https://arxiv.org/abs/2605.25092)). That is supporting evidence for the
shape of the experiment, not validation of Lore's proposed reranker gate.

## Practical option map

| Route | What improves | Lore / Apple-Silicon implications | Priority |
| --- | --- | --- | --- |
| **Jina reranker v3.5 (listwise LBNL)** | Jointly compares all candidates in one 0.6B forward pass. Its 3-local/2-global hybrid attention reduces part of the quadratic attention cost; its paper reports BEIR `63.20` versus Qwen3-0.6B `56.94` under one publisher-run protocol ([paper](https://arxiv.org/html/2607.18152v1)). | Official MLX weights are 1.19 GB. Needs a thin local scoring server and strict Lore cardinality/score validation. Candidate order should be permuted during evaluation to test positional stability. Non-commercial weights prevent making it the general OSS default. | **First experiment** |
| **Qwen3-Reranker-4B cross-encoder** | A clean size/quality ceiling with the same yes/no scoring family. Qwen reports MTEB-R `69.76` versus `65.80` for 0.6B; 8B is not consistently better than 4B across its reported tasks ([official model card](https://huggingface.co/Qwen/Qwen3-Reranker-4B)). | Apache-2.0 and conceptually compatible with Lore's current pairwise contract. A local quantized build should fit 24 GB unified memory, but it repeats the full forward pass per candidate and is unlikely to solve the latency problem. Do not infer Apple latency from parameter count. | Optional quality ceiling |
| **MemReranker-4B cross-encoder** | Fine-tunes Qwen3-Reranker-4B for temporal, causal, coreference, and conversational-memory relevance. The authors report MAP `0.737` on their memory benchmark ([paper](https://arxiv.org/abs/2605.06132), [model card](https://huggingface.co/IAAR-Shanghai/MemReranker-4B)). | Apache-2.0, but the released BF16 checkpoint is 8.83 GB and the documented server path is vLLM/CUDA. Apple serving needs a separately validated MPS/Metal or conversion path. It is the most domain-relevant stronger cross-encoder, not the easiest local test. | Second quality ceiling |
| **LFM2.5-ColBERT-350M candidate reranker** | Uses 128-dimensional token vectors and `MaxSim`. Liquid reports M4 Max FP16 p50 `8.2 ms` with cached document vectors and `34.3 ms` when encoding one query and one 256-token document ([official release](https://www.liquid.ai/blog/lfm2-5-retrievers), [GGUF model](https://huggingface.co/LiquidAI/LFM2.5-ColBERT-350M-GGUF)). | Encode only the authorized top 3/5/10 candidates online for the first ablation, avoiding schema changes. Cached production use would require new generation-versioned, RLS-covered token-vector state; it cannot reuse Lore's `vector(1024)` column. Only 11 languages are listed, excluding Chinese, and the custom LFM 1.0 license needs operator review. | **Second experiment (latency)** |
| **Full-corpus ColBERTv2 / PLAID** | Precomputes token-level document vectors and performs query-token `MaxSim`. ColBERTv2 compresses its multi-vector footprint by 6-10x; PLAID reports up to 45x CPU and 7x GPU search speedups over vanilla ColBERTv2 ([ColBERTv2](https://arxiv.org/abs/2112.01488), [PLAID](https://arxiv.org/abs/2205.09707)). | This is a new retrieval index, not a drop-in reranker. Lore would need generation-versioned token matrices plus RLS-safe pre-top-k execution; the official implementation precomputes a separate disk index and says GPU is required for indexing ([repository](https://github.com/stanford-futuredata/ColBERT)). A global PLAID sidecar cannot be allowed to retrieve first and filter tenants later. For the current ~1k-Memory corpus, migration and authorization complexity outweigh likely benefit. | Defer |
| **Generative listwise / RankGPT-style** | A language model can compare a candidate set and emit a permutation; RankGPT uses back-to-front sliding windows when the list exceeds context ([official repository](https://github.com/sunnweiwei/RankGPT)). Lore already has a stricter one-call scored-set adaptation through `ollama-listwise`. | It adds prompt prefill plus generated structured output, so a local 4B model is unlikely to beat a discriminative 0.6B listwise model on latency. It is useful only if a resident reader model eliminates another model load and materially improves conflict/aggregate cases. | Benchmark after Jina |
| **Learned score fusion / LambdaMART** | The lowest-complexity option is a learned convex combination of normalized lexical and dense scores; Bruch et al. report it outperforming RRF in their in- and out-of-domain tests while needing few examples for its one parameter ([paper](https://arxiv.org/abs/2210.11934)). With more labels, LambdaMART can also learn exact-match, recency, and reranker features; XGBoost supports `rank:ndcg`, `rank:map`, and pairwise objectives ([official guide](https://xgboost.readthedocs.io/en/stable/tutorials/learning_to_rank.html)). | Convex fusion adds essentially no model latency and is worth sweeping before another neural model. Rich LambdaMART still needs many labeled query-candidate groups and a workspace-disjoint holdout; 32 queries would overfit. Neither can repair a missing first-stage candidate. | Fusion sweep now; LTR later |
| **Confidence cascade / query router** | Avoids paying rerank cost on cases where Hybrid and the reranker agree. Signals can include lexical/dense lane agreement, top-score margin, identifier/proper-name structure, and aggregate/multi-hop wording. | The gate must use only the original query and already-authorized candidate features. Start with an auditable rule or explicit deep-search mode; train a deployment-level router only after enough outcomes exist. Never make the model choice a Workspace/User setting. | **Best production shape** |

## Proposed benchmark

Run the following on the same authorized ten-candidate pool and the same compact
evidence passages. For neural arms, sweep reranked prefixes of 3, 5, and 10 so
the latency/quality tradeoff is explicit; the remaining candidates retain their
deterministic Hybrid order.

1. Hybrid baseline.
2. Current Qwen3-Reranker-0.6B Q8 pairwise baseline.
3. Jina reranker v3.5 MLX listwise, with candidate order randomly permuted across
   repeated runs and results mapped back by opaque id.
4. LFM2.5-ColBERT-350M as an online, candidate-only late-interaction reranker; do
   not persist a new token index for this first run.
5. Optionally, Qwen3-Reranker-4B or MemReranker-4B as a quality ceiling, not a
   latency contender.

First use pure model order (`LORE_RERANK_WEIGHT=1`) to isolate ranking quality;
then sweep the existing `0, 0.25, 0.5, 0.75, 1` fusion weights without repeating
identical provider calls. Expand materially beyond 32 cases (target at least 100)
and pre-register exact-answer, paraphrase, aggregate/multi-hop, temporal/conflict,
multilingual, and no-answer slices. Report Recall@1/5/10, MRR, nDCG, answer-evidence
recall, false results, pairwise wins/losses, McNemar confidence, warm and cold
mean/p50/p95, model-load time, peak unified memory, input characters/tokens, and
provider failure/fail-open rate. Preserve `RETRIEVAL_EVIDENCE_POLICY`, RLS before
top-k, and exact candidate cardinality in every arm.

Only after that run should Lore test a cascade. Label each query by whether
reranking improved its answer-bearing top result, fit or hand-author a gate using
first-stage-only features, and evaluate it on a disjoint holdout. Compare total
quality and the full latency distribution against both always-Hybrid and
always-rerank; a router that merely reproduces the 32 development cases is not
evidence of a deployable gain.
