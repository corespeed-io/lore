# Memory benchmark and retrieval paper provenance

Research date: 2026-08-07. This map uses only original papers, formal proceedings,
author-maintained repositories, and official benchmark repositories. Repository
links are pinned to the commit inspected when one was available.

## Claim discipline

The labels in this note are deliberate:

- **Paper-backed** means Lore implements the material mechanism or metric described
  by the cited primary source.
- **Adapted** means the source motivates the shape of the method, but Lore changes
  inputs, scoring, budgets, or safety constraints.
- **Lore-specific** means it is an engineering or product-quality rule, not a
  conclusion established by the cited paper.
- **Diagnostic** means the result is useful locally but is not the benchmark's
  official end-answer score.

An official-looking metric name does not make two runs comparable. A report must
also pin the dataset revision and split, question subset, memory granularity,
reader and judge model/version, prompts and decoding, context and evidence budgets,
image routing, retrieval configuration, and latency boundary.

## Current Lore method audit

| Lore capability | Primary provenance | Status and boundary |
| --- | --- | --- |
| Simple and English FTS plus dense retrieval, fused with reciprocal ranks | Cormack, Clarke, and Büttcher (2009) | **Adapted.** The rank-only fusion and `k=60` follow RRF. The particular sparse/dense channels, proper-name weighting, candidate budgets, chunk-to-Memory collapse, time/metadata predicates, and deterministic tie-breaks are Lore-specific. |
| Optional second-stage query-passage reranking | Nogueira and Cho (2019/2020); Qwen3 Embedding (2025) | **Adapted.** Joint query-passage scoring is paper-backed. Lore's provider adapters, strict one-score-per-authorized-candidate validation, `[0,1]` requirement, compact evidence policy, weighted fusion, score abstention, and fail-open behavior are product invariants. |
| Lexical evidence diversity | Carbonell and Goldstein (1998) | **Adapted.** Lore trades rank-derived relevance against lexical Jaccard novelty. It is MMR-style, not the paper's exact relevance/similarity model. |
| Deployment-level query planner | HyDE and Query2doc are useful contrasts | **Lore-specific, not HyDE.** Lore asks for alternate evidence-seeking queries, explicitly says not to answer, searches each query independently under the same Actor/RLS transaction, keeps the original query, and fuses the visible results. It does not generate and embed a hypothetical answer document. |
| Bounded retrieval feedback | Lavrenko and Croft (2001) | **Inspired by pseudo-relevance feedback, not an implementation of the relevance model.** Lore deterministically appends one high-overlap sentence, excludes prior anchor Memories, caps depth at three, and reserves at most 20% of a full pool for novel feedback results. |
| Optional recency fusion | LongMemEval and MemoryAgentBench supply temporal/conflict workloads | **Lore-specific.** Reciprocal-rank fusion over `Memory.updated_at` is not a method claimed by either benchmark paper and must not be described as conflict resolution. It stays off by default. |
| Recall@1/K, MRR, binary nDCG@K, no-answer accuracy, false-result count, latency, provider accounting, and RLS tripwires | BEIR/MTEB motivate retrieval metrics; memory benchmarks motivate answer/no-answer tests | Retrieval formulas are **paper-backed/adapted**. Binary Memory-id qrels, tenancy hard failures, cost accounting, and latency gates are **Lore-specific**. A parent Memory hit does not prove that the answer-bearing chunk was retrieved. |

The mapped implementation is primarily in
[`src/lib/memory.ts`](../../src/lib/memory.ts),
[`src/lib/reranking.ts`](../../src/lib/reranking.ts),
[`src/lib/query-planning.ts`](../../src/lib/query-planning.ts), and
[`src/lib/retrieval-benchmark.ts`](../../src/lib/retrieval-benchmark.ts).

## Benchmark provenance

### LongMemEval and LongMemEval-S

- **Paper:** [*LongMemEval: Benchmarking Chat Assistants on Long-Term
  Interactive Memory*](https://openreview.net/forum?id=pZiyCaVuti), Di Wu,
  Hongwei Wang, Wenhao Yu, Yuwei Zhang, Kai-Wei Chang, and Dong Yu, ICLR 2025;
  [arXiv 2410.10813 v2](https://arxiv.org/abs/2410.10813).
- **Official artifacts:**
  [`xiaowu0162/LongMemEval@9e0b455`](https://github.com/xiaowu0162/LongMemEval/tree/9e0b455f4ef0e2ab8f2e582289761153549043fc)
  and cleaned dataset revision
  [`98d7416`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/tree/98d7416c24c778c2fee6e6f3006e7a073259d48f).
- **Claimed protocol:** 500 manually authored questions exercise extraction,
  multi-session reasoning, temporal reasoning, knowledge updates, and abstention.
  LongMemEval-S is roughly 115k tokens per question; M uses 500 sessions and is
  roughly 1.5M tokens. Official end-answer accuracy is a binary decision from the
  pinned GPT-4o judge, not exact match. Official retrieval uses human
  answer-location labels and distinguishes `recall_any`, `recall_all`, and
  `ndcg_any`; all 30 abstention questions are excluded from retrieval scoring
  because they have no gold location
  ([QA evaluator](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/evaluation/evaluate_qa.py),
  [retrieval evaluator](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/retrieval/eval_utils.py)).
- **Lore mapping:**
  [`evaluation/external/longmemeval.json`](../../evaluation/external/longmemeval.json),
  [`scripts/benchmark-longmemeval.ts`](../../scripts/benchmark-longmemeval.ts), and
  [`scripts/lib/longmemeval.ts`](../../scripts/lib/longmemeval.ts) pin the cleaned
  release, isolate every question in its own Workspace, store sessions as private
  Memories, and add a Bob-private answer tripwire.
- **Deviations and limits:** Lore's Recall@1/K, MRR, and binary Memory-id nDCG are
  local retrieval diagnostics unless the official answer-location protocol is
  reproduced. Oracle is a smoke test, not a comparable S/M score. The cleaned
  September 2025 release postdates the ICLR paper and changed histories, so it must
  not be compared silently with original-release tables. Lore must report
  no-answer accuracy separately because the official retrieval score excludes
  abstention cases.

### LongMemEval-V2

- **Paper:** [*LongMemEval-V2: Evaluating Long-Term Agent Memory Toward
  Experienced Colleagues*](https://arxiv.org/abs/2605.12493), Di Wu, Zixiang Ji,
  Asmi Kawatkar, Bryan Kwan, Jia-Chen Gu, Nanyun Peng, and Kai-Wei Chang, 2026,
  arXiv 2605.12493 v1. It is currently a preprint.
- **Official artifacts:**
  [`xiaowu0162/LongMemEval-V2@ef67f10`](https://github.com/xiaowu0162/LongMemEval-V2/tree/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b)
  and dataset revision
  [`f152293`](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/tree/f152293e235517d504809563c833d7190b8c713b).
- **Claimed protocol:** 451 questions cover static state, dynamic tracking,
  workflow knowledge, environment gotchas, and premise awareness across web and
  enterprise domains. Small uses 100 shared trajectories (about 25M tokens) and
  Medium uses 500 question-specific trajectories (about 115M tokens). A system
  sequentially inserts trajectories and returns ordered multimodal evidence to a
  fixed reader; evaluation combines answer accuracy and memory-query latency.
- **Reader and judge:** the official reader configuration is Qwen3.5-9B with a
  200k Qwen-token memory budget, temperature `0.6`, top-p `0.95`, top-k `20`,
  thinking enabled, and a 20k completion cap
  ([run configuration](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/evaluation/run_eval.py)).
  Therefore “fixed reader” does not mean deterministic. The pinned data contains
  295 deterministically scored cases, 128 premise-awareness judge cases, 28 gotcha
  judge cases, and 29 question screenshots. Judge cases use the official GPT-5.2
  medium-reasoning rubrics; a generic `UNKNOWN` is not sufficient for an
  abstention answer
  ([scorers](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/evaluation/qa_eval_metrics.py)).
- **Multimodal protocol:** question text is followed by its screenshot. Evidence
  may itself contain ordered images; the official harness truncates the evidence
  prefix only at whole-item boundaries with the Qwen processor and sends images as
  inline data URLs
  ([harness](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/evaluation/harness.py)).
- **Lore mapping:**
  [`evaluation/external/longmemeval-v2.json`](../../evaluation/external/longmemeval-v2.json),
  [`scripts/benchmark-longmemeval-v2.ts`](../../scripts/benchmark-longmemeval-v2.ts),
  [`scripts/lib/benchmark-reader.ts`](../../scripts/lib/benchmark-reader.ts), and
  [`scripts/lib/benchmark-judge.ts`](../../scripts/lib/benchmark-judge.ts) pin the
  data, reader/judge prompts, images, RLS tripwires, timing, and usage metadata.
- **Deviations and limits:** `lore-portable-deterministic-v2` uses a character
  budget and temperature zero; it is not the paper's sampled Qwen-token-budgeted
  reader. Retrieval-only literal-anchor Recall/MRR leaves answer accuracy null and
  is a diagnostic. Alternate readers, partial subsets, changed context budgets, or
  omitted screenshots are ablations. Lore currently sends verified question
  images to a capable reader but its text retriever does not consume them; reports
  must preserve `questionImageSentToRetriever=false`. A partial run must not claim
  the official leaderboard's complete web+enterprise accuracy or LAFS.

### MemoryAgentBench

- **Paper:** [*Evaluating Memory in LLM Agents via Incremental Multi-Turn
  Interactions*](https://openreview.net/forum?id=DT7JyQC3MR), Yuanzhe Hu, Yu Wang,
  and Julian McAuley, ICLR 2026;
  [arXiv 2507.05257 v4](https://arxiv.org/abs/2507.05257v4).
- **Official artifacts:**
  [`HUST-AI-HYZ/MemoryAgentBench@455306d`](https://github.com/HUST-AI-HYZ/MemoryAgentBench/tree/455306dcabc3842526eb83cd4e225e5d486c5c5d)
  and dataset revision
  [`7ea0669`](https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/tree/7ea066982b140a19337e17e60d45d4076e042faf).
- **Claimed protocol:** long inputs arrive incrementally, followed by multiple
  questions. The suite covers Accurate Retrieval, Test-Time Learning, Long-Range
  Understanding, and the capability called Selective Forgetting in paper prose but
  Conflict Resolution in the current repository. Metrics are task-specific:
  EventQA/RULER and FactConsolidation use normalized `substring_exact_match`,
  DetectiveQA/ICL use strict exact match, recommendation uses Recall@5, and other
  sources use their own judge or summarization metrics
  ([official mapping](https://github.com/HUST-AI-HYZ/MemoryAgentBench/blob/455306dcabc3842526eb83cd4e225e5d486c5c5d/README.md#L171-L185)).
- **Temporal/conflict claim:** FactConsolidation presents a fact and later
  counterfactual rewrites, explicitly assigning larger serial numbers to newer
  facts. This supports a synthetic “newest serial wins” resolver for that source;
  it does not establish a universal recency-ranking policy.
- **Lore mapping:**
  [`evaluation/external/memoryagentbench.json`](../../evaluation/external/memoryagentbench.json),
  [`scripts/benchmark-memoryagentbench.ts`](../../scripts/benchmark-memoryagentbench.ts),
  and [`scripts/benchmark-memoryagentbench-accurate.ts`](../../scripts/benchmark-memoryagentbench-accurate.ts)
  preserve incremental order, use the official normalized substring metric for
  the conflict answer, and plant Bob-private tripwires.
- **Deviations and limits:** the conflict runner's latest-literal-answer Memory
  Recall/MRR and the Accurate Retrieval runner's selected literal anchor are Lore
  diagnostics. The source assembly/max-serial helper is a Lore engineering
  interpretation, not an algorithm contributed by the official benchmark repo.
  Conflict Resolution is one subtask, not a MemoryAgentBench overall score. Its
  `LME(S*)` is a reformulated five-context 300-question variant, not standard
  LongMemEval-S. The task does not model source reliability, valid-time ranges,
  retractions, or concurrent facts.

### LoCoMo

- **Paper:** [*Evaluating Very Long-Term Conversational Memory of LLM
  Agents*](https://aclanthology.org/2024.acl-long.747/), Adyasha Maharana,
  Dong-Ho Lee, Sergey Tulyakov, Mohit Bansal, Francesco Barbieri, and Yuwei Fang,
  ACL 2024; [arXiv 2402.17753](https://arxiv.org/abs/2402.17753).
- **Official artifact:**
  [`snap-research/locomo@3eb6f2c`](https://github.com/snap-research/locomo/tree/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376),
  released under CC BY-NC 4.0.
- **Claimed protocol:** the final ACL/current release has 10 conversations,
  averaging 27.2 sessions, about 587 turns, and 16.6k tokens. Its 1,986 questions
  include 841 single-hop, 282 multi-hop, 321 temporal, 96 open-domain, and 446
  adversarial examples. QA uses normalized token F1/partial multi-answer scoring,
  while annotated-dialog retrieval uses Recall@k. Event summarization uses ROUGE
  and adapted FActScore; multimodal dialogue generation uses MM-Relevance plus NLG
  metrics
  ([official evaluator](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/evaluation.py#L126-L241)).
- **Multimodal boundary:** paper QA and event-summary experiments replace images
  with BLIP-2 captions. Direct images are used in the multimodal dialogue-generation
  task. The repo contains URLs, captions, and image-search queries rather than a
  fixed bundle of source images, so later reconstruction can drift.
- **Lore mapping:** none. No LoCoMo manifest or runner is present. LongMemEval or
  MemoryAgentBench coverage must not be presented as LoCoMo coverage.
- **Deviations and limits:** the arXiv v1 abstract described an earlier
  50-conversation release; comparisons should use the final ACL/current
  10-conversation artifact. QA-only token F1 is not full LoCoMo, and it is neither
  exact-match accuracy nor a generic LLM-judge score. The non-commercial dataset
  license must be considered before redistributing or using it commercially.

## Retrieval-method provenance

### Reciprocal Rank Fusion

- **Paper:** [*Reciprocal Rank Fusion outperforms Condorcet and individual Rank
  Learning Methods*](https://doi.org/10.1145/1571941.1572114), Gordon V. Cormack,
  Charles L. A. Clarke, and Stefan Büttcher, SIGIR 2009
  ([author PDF](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)).
- **Official implementation:** no author code artifact was published with the
  paper.
- **Claimed method:** add `1 / (k + rank)` for each ranked list in which a document
  appears. The paper uses `k=60`; this is an empirical rank-smoothing choice, not a
  universal constant.
- **Lore mapping:** `src/lib/memory.ts` uses `k=60` to combine authorized lexical
  and dense chunk ranks and to combine query variants. The core rank-only fusion is
  paper-backed.
- **Deviations and limits:** the paper does not specifically validate Lore's FTS
  channels, pgvector channel, weighted second-stage/recency fusion, chunk collapse,
  or thresholds. RRF cannot recover evidence absent from every input list, resolve
  temporal truth, or authorize a result. Lore applies Workspace/scope/metadata/time
  predicates before top-k and RRF; global fusion followed by RLS filtering would be
  both insecure and methodologically wrong.

### Cross-encoder and model reranking

- **Paper:** [*Passage Re-ranking with BERT*](https://arxiv.org/abs/1901.04085),
  Rodrigo Nogueira and Kyunghyun Cho, first released 2019, arXiv v5 (2020).
- **Official implementation:**
  [`nyu-dl/dl4marco-bert@a75f26a`](https://github.com/nyu-dl/dl4marco-bert/tree/a75f26a3342a38f146fc9f0958bf458be7a68e15).
- **Claimed method:** retrieve a large BM25 candidate set, jointly encode each
  query-passage pair with BERT, and reorder it by a learned relevance probability.
  It establishes the two-stage pattern and its recall ceiling; it does not define
  Lore's provider API contract.
- **Current model reference:** [*Qwen3 Embedding: Advancing Text Embedding and
  Reranking Through Foundation Models*](https://arxiv.org/abs/2506.05176), Yanzhao
  Zhang, Mingxin Li, Dingkun Long, Xin Zhang, Huan Lin, Baosong Yang, Pengjun Xie,
  An Yang, Dayiheng Liu, Junyang Lin, Fei Huang, and Jingren Zhou, 2025, with
  [`QwenLM/Qwen3-Embedding@44548aa`](https://github.com/QwenLM/Qwen3-Embedding/tree/44548aa5f0a0aed1c76d64e19afe47727a325b8f).
  Its official reranker formats instruction, query, and document jointly and scores
  relevance from yes/no logits.
- **Lore mapping:** `src/lib/reranking.ts` and its vLLM/llama.cpp/hosted adapters
  pass only RLS-authorized compact evidence passages to an optional second stage.
- **Deviations and limits:** a reranker cannot restore a missing candidate. Lore's
  candidate cap, neighboring-chunk policy, exactly-one-finite-`[0,1]` validation,
  minimum score, weighted rank fusion, and fail-open fallback are Lore-specific.
  Provider outputs and score semantics differ, so every report must pin the model,
  endpoint contract, prompt/instruction, candidate and evidence budgets, and actual
  calls. MS MARCO gains cannot be extrapolated to Memory data; candidate recall,
  exact answer-evidence recall, end-answer accuracy, and latency all need testing.

### MMR-style diversity

- **Paper:** [*The Use of MMR, Diversity-Based Reranking for Reordering Documents
  and Producing Summaries*](https://doi.org/10.1145/290941.291025), Jaime Carbonell
  and Jade Goldstein, SIGIR 1998.
- **Official implementation:** no author repository accompanies the paper.
- **Claimed method:** greedily balance query relevance against similarity to
  already selected items with a lambda trade-off.
- **Lore mapping and deviation:** Lore's reranking diversity uses rank-derived
  relevance and lexical Jaccard between authorized evidence passages. That is an
  MMR-style local adaptation, not the paper's exact scorer. The lambda defaults to
  behavior-neutral and requires versioned evidence-level evaluation.

### Query expansion, HyDE, and feedback

- **HyDE paper:** [*Precise Zero-Shot Dense Retrieval without Relevance
  Labels*](https://aclanthology.org/2023.acl-long.99/), Luyu Gao, Xueguang Ma,
  Jimmy Lin, and Jamie Callan, ACL 2023; official implementation
  [`texttron/hyde@a2fd873`](https://github.com/texttron/hyde/tree/a2fd8734307612cb0225d71ffbf26e0d225986b8).
- **HyDE claim:** generate answer-like hypothetical documents, accept that they may
  hallucinate, encode the original query plus generated documents with an
  unsupervised dense retriever, average their vectors, and retrieve real documents.
  The paper uses `text-davinci-003` at temperature `0.7`; the official code defaults
  to eight generated documents.
- **Query2doc paper:** [*Query2doc: Query Expansion with Large Language
  Models*](https://aclanthology.org/2023.emnlp-main.585/), Liang Wang, Nan Yang,
  and Furu Wei, EMNLP 2023. No author code repository is linked by the paper. It
  generates a pseudo-document and concatenates it to the original query.
- **Feedback paper:** [*Relevance-Based Language
  Models*](https://doi.org/10.1145/383952.383972), Victor Lavrenko and W. Bruce
  Croft, SIGIR 2001
  ([author PDF](https://ciir.cs.umass.edu/pubfiles/ir-225.pdf)). No accompanying
  author repository was published. It estimates a relevance language model from a
  query and initial retrieval results.
- **Lore mapping:** the planner returns at most four alternate evidence-seeking
  queries in addition to the original and searches all of them independently under
  identical Actor/RLS constraints. The feedback loop instead extracts a strongest
  lexical-overlap sentence from one visible first-pass passage, extends the query,
  excludes prior anchor Memories, and caps chain depth and pool displacement.
- **Deviations and limits:** Lore's planner is neither HyDE nor Query2doc because it
  explicitly forbids answering and never embeds a hypothetical answer document as
  the retrieval representation. Its feedback loop is not Lavrenko-Croft's
  relevance model. Both features can drift, increase latency/cost, and hurt
  no-answer precision; they remain deployment-level, bounded, fail-open, and
  separately benchmarked variants. The planner sees only the original question,
  never Memory content.

### Temporal search and conflict resolution

- **LongMemEval evidence:** the ICLR 2025 paper above evaluates time-aware query
  expansion that infers a relevant date range and narrows or prioritizes records.
  Lore supports caller-supplied `updatedAfter` and exclusive `updatedBefore`
  predicates before top-k, but its planner does not infer a structured time range.
  Therefore Lore does not implement the paper's automatic temporal expansion.
- **MemoryAgentBench evidence:** the ICLR 2026 benchmark above supports evaluation
  of an explicit serial-number “newest update wins” task. It does not support an
  unconditional newest-Memory boost for archival or timeless queries.
- **Post-retrieval assembly paper:** [*Reliable Post-Retrieval Assembly for Agent
  Memory*](https://arxiv.org/abs/2606.01435), Chandan Vikas Reddy, arXiv v2
  (2026-08-02), with official MIT-licensed implementation
  [`cvikasreddy/memory-conflict-resolution@7d319f4`](https://github.com/cvikasreddy/memory-conflict-resolution/tree/7d319f460b0ee0945d7de05d06c34681dceca46a).
  It separates candidate extraction from deterministic `max(serial)` selection and
  uses CAR decomposition plus fact-level BM25 retrieval per hop for multi-hop cases.
  This is evidence for the bounded synthetic policy, not generic temporal reasoning.
- **Lore assembly mapping:** the optional benchmark path first retrieves authorized
  Memories, then performs fact-level BM25 only inside that visible evidence; it derives
  serials by exact source-fact lookup rather than trusting model output. Multi-hop CAR
  performs a fresh RLS-authorized Lore search per hop. These are deliberate tenancy and
  small-reader safety adaptations, so results must be reported as Lore ablations rather
  than copied paper scores.
- **Entity-hop evidence:** [*Multi-step Entity-centric Information Retrieval for
  Multi-Hop Question Answering*](https://aclanthology.org/D19-5816/) (Das et al.,
  MRQA/EMNLP 2019, DOI `10.18653/v1/D19-5816`) starts with BM25 evidence, links
  entities found in that evidence, and reranks candidate evidence chains. The paper
  reports a 10.59 F1 increase in an unchanged HotpotQA reader; its authors' code is
  pinned at
  [`ameyagodbole/entity-centric-ir-for-multihop-qa@29a6f20`](https://github.com/ameyagodbole/entity-centric-ir-for-multihop-qa/tree/29a6f20b9d8616849c30c28f03d3cc51119372d5).
  Lore's CAR ablation carries a validated hop answer into a fresh authorized query,
  which is an entity-hop adaptation. It does **not** reproduce the paper's alias table,
  BERT chain reranker, Wikipedia setting, or HotpotQA result.
- **Lore boundary:** `LORE_RETRIEVAL_RECENCY_WEIGHT` fuses relevance with visible
  `Memory.updated_at`. It is a calibrated Lore heuristic, not a paper-backed
  conflict resolver. It must stay off unless a pinned temporal/conflict benchmark
  improves without unacceptable regressions in timeless, historical, and
  no-answer cases.

## Retrieval metric provenance

### BEIR

- **Paper:** [*BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of
  Information Retrieval Models*](https://openreview.net/forum?id=wCu6T5xFjeJ),
  Nandan Thakur, Nils Reimers, Andreas Rücklé, Abhishek Srivastava, and Iryna
  Gurevych, NeurIPS Datasets and Benchmarks 2021;
  [arXiv 2104.08663](https://arxiv.org/abs/2104.08663).
- **Official implementation:**
  [`beir-cellar/beir@ef83d293`](https://github.com/beir-cellar/beir/tree/ef83d29307061c65d04b035b4f4e7c18bd8374af).
- **Claimed metrics:** the paper centers nDCG@10 to support graded relevance; the
  official library also calculates MAP, Recall, Precision, and MRR. BEIR further
  shows that cross-encoder gains are domain-dependent, not universal.
- **Lore mapping and deviation:** Lore reports Recall@1/K, MRR, and nDCG@K, but its
  qrels are normally binary expected Memory IDs rather than BEIR's document-level,
  sometimes graded judgments. It is therefore not a BEIR score. BEIR does not test
  answer correctness, abstention false positives, temporal truth, RLS leakage,
  provider cost, or Memory/chunk evidence boundaries.

### MTEB

- **Paper:** [*MTEB: Massive Text Embedding
  Benchmark*](https://aclanthology.org/2023.eacl-main.148/), Niklas Muennighoff,
  Nouamane Tazi, Loïc Magne, and Nils Reimers, EACL 2023;
  [arXiv 2210.07316](https://arxiv.org/abs/2210.07316).
- **Official implementation:**
  [`embeddings-benchmark/mteb@a57299e`](https://github.com/embeddings-benchmark/mteb/tree/a57299e4d06ea7972c6a2ee5a758fe77feb3139a).
- **Claimed scope and metrics:** the original paper covers eight task families, 58
  datasets, 112 languages, and 33 models. Retrieval primarily uses nDCG@10 and also
  exposes MAP, Recall, Precision, and MRR; reranking reports MRR and MAP. The current
  repository has grown beyond the paper, including multimodal evaluation, so its
  version and task must be pinned.
- **Lore mapping and deviation:** Lore's metric names and rank formulas are
  compatible with standard retrieval evaluation, but a single-gold Recall@K is
  effectively hit rate. Multi-evidence memory questions need `recall_all` or exact
  evidence coverage as well. MTEB does not measure Workspace isolation, no-answer
  behavior, reader accuracy, latency, or provider cost. Lore results must not be
  marketed as MTEB scores without actually running a pinned MTEB task.

## 2026 SOTA-candidate audit

This section audits methods worth testing; it does **not** award a “state of the
art” label. Headline tables use different LoCoMo/LongMemEval releases and subsets,
answer models, LLM judges, context limits, evidence budgets, image handling, and
latency definitions. Those results are not directly comparable to one another or
to Lore.

### APEX-MEM

- **Paper:** [*APEX-MEM: Agentic Semi-Structured Memory with Temporal Reasoning
  for Long-Term Conversational AI*](https://aclanthology.org/2026.acl-long.749/),
  Pratyay Banerjee, Masud Moshtaghi, Shivashankar Subramanian, Amita Misra, and
  Ankit Chadha, ACL 2026.
- **Official artifacts:** no author code or data artifact is linked from the formal
  paper, and none was located as of the research date. It evaluates on public
  benchmarks but is not end-to-end reproducible from an official implementation.
- **Claim:** an append-only temporal event/entity property graph plus a multi-tool
  retrieval agent that resolves evolving/conflicting facts at query time.
- **Consolidation fit:** its append-only source representation avoids overwrite and
  automatic consolidation, so the storage principle is compatible with Lore v1.
- **Portable query-time candidate:** typed entity lookup, temporal/aggregate graph
  traversal, lexical/semantic search, and retrieval-time conflict resolution. A
  Lore experiment would need an RLS-covered derived event/entity schema whose
  edges retain provenance to canonical Memories.
- **Limit:** the paper's agentic construction/retrieval and answer evaluations use
  particular Claude models and many ReAct tool calls. It is not evidence that the
  same method is best under Lore's reader, latency, privacy, or cost envelope.

### HiGMem

- **Paper:** [*HiGMem: A Hierarchical and LLM-Guided Memory System for Long-Term
  Conversational Agents*](https://aclanthology.org/2026.findings-acl.1690/), Shuqi
  Cao, Jingyi He, and Fei Tan, Findings of ACL 2026.
- **Official artifact:**
  [`ZeroLoss-Lab/HiGMem@f275072`](https://github.com/ZeroLoss-Lab/HiGMem/tree/f275072f25323a01a8bff3680edbb34ed97d33be),
  an MIT-licensed repository with code, prompts, and the LoCoMo10 data used by its
  scripts.
- **Claim:** inspect high-level event summaries first, then let an LLM choose a
  small set of related raw turns, improving evidence precision and reducing answer
  context.
- **Consolidation fit:** automatic event-summary and affiliation creation/update is
  automated summarization/consolidation and is outside Lore v1's core scope.
- **Portable query-time candidate:** benchmark an event-first coarse-to-fine
  selector only when the event summaries are explicit/imported or produced by a
  future opt-in extension. Measure exact answer-evidence recall and retrieved-turn
  count, not only end-answer F1.
- **Limit:** paper settings mix fixed embedding, construction, retrieval, and answer
  models; one cost table changes the answer model. Its reported score is not
  directly comparable to Lore's reader profile.

### Amory

- **Paper:** [*Amory: Building Coherent Narrative-Driven Agent Memory through
  Agentic Reasoning*](https://aclanthology.org/2026.eacl-long.183/), Yue Zhou,
  Xiaobo Guo, Belhassen Bayar, and Srinivasan H. Sengamedu, EACL 2026.
- **Official artifacts:** no author code or data artifact is linked from the formal
  paper, and none was located as of the research date.
- **Claim:** offline agentic reasoning creates episodic narratives, performs
  momentum-triggered consolidation, and semanticizes peripheral facts.
- **Consolidation fit:** the core method is automatic narrative formation and
  consolidation, directly outside Lore v1 scope.
- **Portable query-time candidate:** narrative-leaf selection and graph-query
  translation are interesting, but they cannot be isolated faithfully without the
  paper's offline memory representation. They are not immediate Lore-v1 transfers.
- **Limit:** the reported comparison fixes a particular Claude answer/judge setup
  and a different representation pipeline; without official code it cannot be
  reproduced or compared fairly.

### LiCoMemory

- **Paper:** [*LiCoMemory: Lightweight and Cognitive Agentic Memory for Efficient
  Long-Term Reasoning*](https://aclanthology.org/2026.findings-acl.1835/), Zhengjun
  Huang, Zhoujin Tian, Qintian Guo, Fangyuan Zhang, Yingli Zhou, Di Jiang, Zeying
  Xie, and Xiaofang Zhou, Findings of ACL 2026.
- **Official artifact:**
  [`EverM0re/LiCoMemory@a844d99`](https://github.com/EverM0re/LiCoMemory/tree/a844d993f77f947f682a0a52ec2825f2950bc0b3)
  includes code and evaluation data. No license file was present at the inspected
  revision, so inspectability does not establish permission to reuse the code.
- **Claim:** a hierarchical entity/relation graph with session summaries and
  temporal/hierarchy-aware unified reranking (CogniRank), retaining links to source
  dialogue.
- **Consolidation fit:** automatic session summaries and graph reorganization are
  outside Lore v1; an RLS-covered derived graph could be considered later without
  replacing canonical Memories.
- **Portable query-time candidate:** top-down session-summary → relation/entity →
  source-chunk retrieval and CogniRank-style temporal/hierarchical reranking. Test
  each signal as an ablation while preserving source provenance and authorization.
- **Limit:** the paper combines Llama-3-8B construction, BGE-M3, different answer
  models, an LLM judge, and a fixed retrieval budget. Its score is not comparable to
  Lore without reproducing that entire operating point.

### MemORAI

- **Paper:** [*MemORAI: Memory Organization and Retrieval via Adaptive Graph
  Intelligence for LLM Conversational Agents*](https://aclanthology.org/2026.findings-acl.1408/),
  Hung Pham Van, Nguyen Manh Hieu, Khang Pham Tran Tuan, Nam Le Hai, Linh Ngo Van,
  Nguyen Thi Ngoc Diep, and Trung Le, Findings of ACL 2026.
- **Official artifacts:** no author code or data artifact is linked from the formal
  paper, and none was located as of the research date.
- **Claim:** selective memory filtering, dual-layer compression, provenance-rich
  multi-relational graph storage, and a query-adaptive subgraph ranked with Dynamic
  Weighted PageRank.
- **Consolidation fit:** selective retention and automatic compression change what
  canonical memory survives and therefore conflict with Lore v1's non-consolidating
  storage semantics.
- **Portable query-time candidate:** semantic-query-seeded subgraph extraction and
  query-conditioned PageRank over an RLS-authorized derived graph, returning
  provenance-bearing source turns. Evaluate graph recall, evidence recall, and
  latency independently of compression.
- **Limit:** the reported pipeline fixes its own generator, Contriever embeddings,
  top-k, and GPT-4o judge. With no official code, headline results cannot establish
  a reproducible ranking against Lore.

### LoCoMo-Plus

- **Paper:** [*Locomo-Plus: Beyond-Factual Cognitive Memory Evaluation Framework
  for LLM Agents*](https://aclanthology.org/2026.acl-long.1150/), Yifei Li, Weidong
  Guo, Lingling Zhang, Rongman Xu, Muye Huang, Hui Liu, Lijiao Xu, Yu Xu, and Jun
  Liu, ACL 2026; [arXiv 2602.10715](https://arxiv.org/abs/2602.10715).
- **Official artifact:**
  [`xjtuleeyf/Locomo-Plus@059f4e3`](https://github.com/xjtuleeyf/Locomo-Plus/tree/059f4e3d38f7f1f96765e8e2cb7de3097551bffb)
  includes released samples, generation tools, and the evaluator. The generation
  pipeline still contains manual filtering steps, and the inspected revision has
  no clear license file; released evaluation is inspectable, but regeneration and
  reuse have those limits.
- **Claim:** benchmark cue-trigger semantic disconnect and implicit user
  constraints that surface factual-recall metrics miss. Its LLM judge assigns
  `0`, `0.5`, or `1` for wrong, partial, or correct constraint-consistent answers.
- **Consolidation fit:** it is an evaluation framework, not an automatic memory
  consolidation algorithm, so it does not conflict with Lore v1 scope.
- **Portable query-time candidate:** none is claimed. Its value to Lore is a future
  evaluation slice for implicit constraints, not a retrieval algorithm.
- **Limit:** the official setup uses its own answer and Gemini-based judge profiles
  and discusses judge stability. Different judges, model versions, decoding, and
  context assembly prevent direct score comparison.

## Actionable, defensible next experiments

The most plausible Lore-v1-compatible query-time ablations are APEX-style typed
temporal tools, HiGMem-style coarse-to-fine evidence selection over explicitly
provided summaries, LiCoMemory-style temporal/hierarchical reranking, and
MemORAI-style query-adaptive graph ranking. In every case, canonical Memory content
and provenance remain intact, every derived row and edge remains under RLS, and the
method receives only authorized evidence.

The minimum honest comparison matrix is Recall@1/K, MRR, binary and where possible
graded nDCG, exact answer-evidence coverage/`recall_all`, no-answer accuracy,
false-result count, fixed-reader end-answer accuracy, RLS leakage hard failure,
p50/p95 latency, and provider calls/tokens/cost. Each query-time method should be a
separate versioned variant. None should be enabled globally from a paper's headline
score alone.
