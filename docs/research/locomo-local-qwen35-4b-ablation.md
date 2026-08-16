# Local LoCoMo 4B retrieval ablation

Measured on 2026-08-07. This note records a small, reproducible local experiment;
it is not a full LoCoMo score, a leaderboard result, or a SOTA claim.

Update, 2026-08-14: Lore now ships the separately versioned,
reconstruction-safe `lore-memory-chunking-v2` under the greenfield baseline. The
experimental `lore-embedding-v3` profile below remains historical and is not a
quality measurement of the shipped chunker.

## Primary provenance

- Benchmark: [*Evaluating Very Long-Term Conversational Memory of LLM
  Agents*](https://aclanthology.org/2024.acl-long.747/), ACL 2024. Lore pins the
  authors' final ten-conversation dataset at
  [`snap-research/locomo@3eb6f2c`](https://github.com/snap-research/locomo/tree/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376),
  2,805,274 bytes, SHA-256
  `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`.
- Reranker: [*Qwen3 Embedding: Advancing Text Embedding and Reranking Through
  Foundation Models*](https://arxiv.org/abs/2506.05176) and
  [`QwenLM/Qwen3-Embedding@44548aa`](https://github.com/QwenLM/Qwen3-Embedding/tree/44548aa5f0a0aed1c76d64e19afe47727a325b8f).
  The local Q8 GGUF is pinned to
  [`ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF@a02f48b`](https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/tree/a02f48bb4f057028298c21fa033da2b30d7742d5)
  and was served by
  [`llama.cpp@61881b1`](https://github.com/ggml-org/llama.cpp/tree/61881b1f7).
- Retrieval-method attribution and deviations, including RRF and cross-encoder
  provenance, are audited in
  [`memory-benchmark-paper-provenance.md`](memory-benchmark-paper-provenance.md).
  Lore's multi-query planner is explicitly Lore-specific: it is not HyDE or
  Query2doc and receives no borrowed paper attribution.

The complete LoCoMo protocol audit is in
[`locomo-runner-audit.md`](locomo-runner-audit.md). In particular, the run below
uses only positive QA categories 1–4 with the original deterministic normalized
token-F1 semantics. It does not mix in the released category-5 rows whose schema
is defective, and it does not claim the event-summary or multimodal-generation
tasks.

## Fixed local profile

- Hardware: Apple M4 Pro, 12 CPU cores, 24 GB unified memory.
- Embedding: `qwen3-embedding:0.6b`, 1024 dimensions, experimental
  `lore-embedding-v3` (official query transform plus structured list chunking).
  The shipped protocol keeps only the query transform as `lore-embedding-v2` until
  canonical chunks have a safe migration path.
- Reader: local Ollama `qwen3.5:4b`, model digest
  `2a654d98e6fba55d452b7043684e9b57a947e393bbffa62485a7aac05ee4eefd`,
  Q4_K_M, server 0.32.6. Thinking is disabled; temperature is zero; seed is 42;
  context is 8,192 tokens; output is capped at 32 tokens. The exact instruction
  hash is `ccb64e7e23cffbbc0a75c38fa8047767784e6583888abad3022cbe469237048b`.
- Retrieval: RLS-filtered lexical+dense hybrid, semantic distance 0.5, ten
  returned Memories, one evidence chunk per Memory.
- Reranking: Qwen3-Reranker-0.6B Q8_0, 20 candidates, pure reranker order
  (`weight=1`, `lambda=1`, `minimumScore=0`).
- Planning: the same local 4B model via native Ollama `/api/chat`, thinking off,
  8,192-token context, 256-token output cap, maximum three retrieval queries.
  Matching planner and reader context prevents Ollama from reloading the shared
  model between calls.
- Isolation: every run included Bob-private answer tripwires and passed with zero
  hard failures.

`conv-26` is the development slice (20 questions, five selected from each positive
category). `conv-30` is a separate held-out slice (15 questions; it has no selected
open-domain cases). These are deterministic slices, but 35 questions are still too
small to estimate full-dataset confidence intervals.

## Results

### Held-out `conv-30`

| Variant | Answer F1 | Evidence R@1 | Evidence R@10 | Evidence MRR | Search ms/query |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hybrid baseline | 0.5090 | 0.2333 | 0.5111 | 0.4167 | 219 |
| + planner | 0.5349 | 0.2333 | 0.5778 | 0.4073 | 1,511 |
| + reranker | **0.5654** | **0.3556** | 0.5111 | 0.5333 | 1,209 |
| + planner + reranker | 0.5518 | 0.3556 | **0.5778** | **0.5750** | 2,340 |

The planner expanded candidate recall but lowered rank quality and did not compose
additively with the reranker. The reranker alone was the best answer-quality and
latency tradeoff on this held-out slice: +5.64 F1 points for about +0.99 seconds of
search latency.

### Development `conv-26`

| Variant | Answer F1 | Evidence R@1 | Evidence R@10 | Evidence MRR | Search ms/query |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hybrid baseline | 0.4313 | 0.2895 | **0.7632** | 0.4632 | 216 |
| + reranker | **0.4808** | **0.3158** | 0.7368 | **0.5259** | 1,342 |

The answer-F1 improvement repeated on a second conversation (+4.95 points), while
R@10 fell slightly. This is consistent with a second-stage ranker improving the
reader-facing evidence order without increasing the first-stage recall ceiling.

## Decision boundary

The current local evidence supports a named **quality profile** using the 0.6B
reranker. It does not justify enabling reranking unconditionally for every
deployment or workload: earlier pinned MemoryAgentBench Conflict measurements
regressed under reranking, and the two LoCoMo slices total only 35 questions.

Keep the planner available as an opt-in recall path, but do not globally stack it
with the reranker. Before changing defaults, run all 1,540 positive LoCoMo QA cases
or a pre-registered stratified sample, plus the existing LongMemEval,
MemoryAgentBench, isolation, latency, and cost gates. Report each workload
separately; never average away an RLS failure or use this local 4B result as a
comparison to the LoCoMo paper's closed-model headline numbers.
