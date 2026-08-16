# LongMemEval-V2 adoption for Lore

Research date: 2026-08-14. External claims below use only the official
LongMemEval and LongMemEval-V2 papers, repositories, and released datasets.
Lore-specific claims use this repository's pinned manifests, benchmark runner,
and ADRs.

## Decision

Adopt **LongMemEval-V2-Small as Lore's primary agent-memory release benchmark**,
and run V2-Medium as a scheduled scale/capacity gate. Do not retire the cleaned
legacy LongMemEval: keep it as a separately named conversational and personal
memory regression track. The V2 authors themselves distinguish V1's
user-assistant chat histories from V2's web-agent experience histories, and V2
changes the task, ability taxonomy, context, reader, evaluator, and latency
metric rather than merely refreshing V1's examples
([V2 paper, Table 1 and Sections 3.1-3.3](https://arxiv.org/abs/2605.12493),
[legacy benchmark overview](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/README.md#L19-L30)).

Accordingly, **V1 and V2 scores are not cross-version comparable**. This is an
inference from the incompatible official protocols below, not a claim that a
conversion formula exists. Never put V1 accuracy and V2 accuracy on one trend
line or describe a V2 score as an improvement over a V1 score. Namespace the
result families and preserve independent baselines.

## Why V2 should be primary, but not the only benchmark

| Dimension | Cleaned LongMemEval (legacy) | LongMemEval-V2 |
| --- | --- | --- |
| Product behavior tested | A chat assistant remembers timestamped user-assistant conversations. | A memory module accumulates experience from web-agent trajectories and returns compact evidence that makes an agent an experienced operator. |
| Questions and abilities | 500 questions over information extraction, multi-session reasoning, knowledge updates, temporal reasoning, and abstention. | 451 manually curated questions over static state, dynamic state, workflows, environment gotchas, and premise awareness, across web and enterprise domains. |
| Context scale | `S`: about 115k tokens and about 40 sessions; `M`: about 500 sessions (the paper reports roughly 1.5M tokens). | `Small`: 100 trajectories and about 25.6M tokens; `Medium`: about 498 trajectories and 114.8M tokens on average. |
| Interface | Feed chat history to a system, or index/retrieve chat sessions or turns, then answer. | Sequential `Insert(trajectory)` plus `Query(question[, image])`; Query returns bounded, ordered text/image evidence to a fixed reader. |
| Primary metric | Generated-answer accuracy from an LLM evaluator; retrieval recall is also available separately. | Full-set answer accuracy and memory-query latency; the leaderboard derives LAFS from the accuracy-latency frontier. |
| Modality | Released benchmark histories and questions are text. | Trajectory context is text plus screenshots, and some questions include a screenshot. |

The legacy facts and file formats are specified by the
[official README](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/README.md#L72-L107)
and [ICLR 2025 paper](https://arxiv.org/abs/2410.10813). The V2 figures and
context-gathering formulation come from the
[official V2 README](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/README.md#L27-L55)
and [V2 paper, Sections 3.2-3.3](https://arxiv.org/abs/2605.12493). V2 is the
better primary benchmark for Lore's agent-facing direction because it directly
tests reusable environment knowledge, failure modes, false-premise handling,
query latency, and evidence gathering over far noisier histories. V1 remains
necessary because V2 does not test personal preference, knowledge-update, and
timestamped conversational memory under the same distribution.

## What constitutes a complete and comparable V2 score

The pinned official `questions.jsonl` contains 451 cases. Counting its
`eval_function` fields gives **295 deterministic cases** and **156 LLM-judged
cases**: 128 flawed-premise/abstention cases and 28 gotchas cases. The official
scorer uses normalized phrase and multiple-choice matching for the deterministic
cases, and dedicated LLM judges for the other two families. It also forces an
exact `UNKNOWN` response to be incorrect after evaluation; a flawed-premise
answer must identify the flaw rather than merely decline to answer
([pinned questions](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/blob/f152293e235517d504809563c833d7190b8c713b/questions.jsonl),
[official scoring source](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/evaluation/qa_eval_metrics.py#L1-L24),
[official harness](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/evaluation/harness.py#L1032-L1057)).

Therefore:

- retrieval-only output is a diagnostic, not a V2 end-to-end accuracy score;
- a deterministic-only 295-case score is a useful stable slice, but not the
  official 451-case score;
- including LLM-judged cases without actually running the judge leaves the score
  incomplete; and
- `scoreComplete=true` must be interpreted relative to the selected set, not as
  proof that all 451 official cases were evaluated.

For paper/leaderboard comparability, run all questions in both domains for the
same tier, combine the domain results using question-count weighting, and pin the
official downstream stack. The released defaults are Qwen3.5-9B as the fixed
reader, temperature `0.6`, `top_p=0.95`, `top_k=20`, thinking enabled, a 20,000
completion-token cap, a 200,000-token memory-context cap, and GPT-5.2 with
`medium` reasoning as the judge
([run configuration](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/evaluation/run_eval.py#L62-L129)).
The fixed reader is consequently **not deterministic**. The official leaderboard
package validates full question coverage, a reader identity containing
`qwen3.5-9b`, and a judge identity containing `gpt-5.2`, then scores both accuracy
and average memory-query latency
([leaderboard contract](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/leaderboard/README.md#L12-L33),
[submission validation](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/leaderboard/README.md#L90-L100)).

Lore should maintain two explicit profiles:

1. `longmemeval-v2-official-qwen-vllm`: the official reader, decoding, context
   budget, judge, complete question set, and latency protocol for external
   comparison.
2. `longmemeval-v2-lore-deterministic`: Lore's fixed deterministic reader and
   deployment retrieval stack for low-variance product regressions. This is an
   ablation, not an official leaderboard score.

There is also a byte-level prompt compatibility trap: the official Python source
contains ordinary-string `\boxed{}` sequences, so `\b` becomes a backspace at
runtime, while Lore deliberately uses the corrected literal backslash. Lore
already fingerprints and labels this as `corrected-v1`; it must not call that
byte-for-byte official
([official prompt source](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/evaluation/harness.py#L71-L90),
[Lore prompt analysis](./longmemeval-v2-multimodal.md#prompt-compatibility-trap)).

Legacy results have a different judge dependency: the official V1 evaluation
prompts GPT-4o (or another supported metric model) to judge every generated
answer, with task-specific rubrics and temperature zero
([legacy evaluator](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/evaluation/evaluate_qa.py#L11-L42),
[evaluation call](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/evaluation/evaluate_qa.py#L88-L130)).
That alone prevents direct comparison with V2's mixed deterministic/GPT-5.2
protocol.

## Multimodal and image caveats

The pinned V2 data has **29 question screenshots**, all in `errors-gotchas`; 28
use the gotchas judge and one uses deterministic phrase matching. Omitting those
images changes the evaluated subset. The official Query API receives an optional
question image and may return text or image evidence, while the reader receives
the ordered memory context and the question image
([backend contract](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/README.md#L188-L222),
[dataset schema](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/blob/f152293e235517d504809563c833d7190b8c713b/SCHEMA.md)).

The official simple RAG baseline accepts but deliberately ignores `query_image`.
Thus Lore's current behavior—send the verified question screenshot to the reader,
not the retriever—is comparable to that RAG baseline, provided reports say
`questionImageSentToRetriever=false`. It is not evidence that Lore performs
multimodal retrieval
([official RAG source](https://github.com/xiaowu0162/LongMemEval-V2/blob/ef67f10aacd9080c75aeb2dd527a0af25dc26f1b/memory_modules/rag.py#L544-L560),
[Lore multimodal audit](./longmemeval-v2-multimodal.md#finding)).

The 29 question images total only about 3 MiB, whereas the two full trajectory
screenshot archives total about 5.9 GB. Lore need not fetch the trajectory images
for its current text/accessibility-tree path, but every such result must record
`trajectoryImagesIndexed=false` and must not be marketed as a full multimodal
memory result. A future image-evidence method should be a separately versioned
profile.

## Scale and execution tiers

Lore's pinned V2 manifest fixes a 286,186-byte question file, a
1,195,604,539-byte trajectory file, and the small/medium haystack maps at 822,632
and 4,054,244 bytes respectively, all by SHA-256
([Lore manifest](../../evaluation/external/longmemeval-v2.json)). The official
dataset describes 1,870 released trajectories; the pinned Small map references
200 unique trajectories in total (one shared 100-trajectory set per domain),
while the pinned Medium map references 1,473 unique trajectories and gives 428 of
451 questions a full 500-trajectory haystack. The remaining Medium questions have
387-487 trajectories because their matching pools are smaller
([official data card](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/blob/f152293e235517d504809563c833d7190b8c713b/DATA_CARD.md),
[official schema](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/blob/f152293e235517d504809563c833d7190b8c713b/SCHEMA.md),
[pinned Small map](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/blob/f152293e235517d504809563c833d7190b8c713b/haystacks/lme_v2_small.json),
[pinned Medium map](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2/blob/f152293e235517d504809563c833d7190b8c713b/haystacks/lme_v2_medium.json)).

Recommended cadence:

- pull requests: parser, manifest, prompt fingerprint, and `--plan` tests only;
- nightly: stratified deterministic V2-Small retrieval/reader smoke, clearly
  labeled as a diagnostic;
- release gate: all 451 V2-Small cases with reader, judge, both domains, and
  question screenshots;
- scheduled capacity gate: full V2-Medium under the same pinned profile; and
- separate scheduled track: cleaned legacy LongMemEval-S for conversational and
  personal-memory regression.

Small still requires obtaining and verifying the shared 1.2 GB trajectory file,
so it is not a cheap per-PR fixture. Medium is a materially different scale test,
not a score that should be averaged with Small.

## Lore integration status

The current Lore runner already does several important things correctly: it pins
the dataset revision and hashes, isolates web and enterprise in distinct
Workspaces, hides benchmark answer tripwires behind RLS, keys corpus reuse by the
dataset/render/chunking revisions, records `lore-memory-chunking-v2`, reports the
reader/judge/retrieval configurations, and marks unresolved judge cases and score
completeness
([Lore V2 runner](../../scripts/benchmark-longmemeval-v2.ts)).

Implementation update: that prerequisite is now resolved. The runner preserves
each rendered trajectory exactly across one or more bounded workflow
Episodes/Observations, builds revisioned lexical/vector artifacts through
`src/lib/episode-evidence.ts`, applies Workspace/RLS and exact haystack source keys
before top-k, then groups evidence back by trajectory identity. Bob-private
tripwires use the same Episode-evidence path. Raw trajectories never become
canonical Memories, and deleting an Episode cascades its rebuildable artifacts
([bounded-Memory ADR](../adr/0003-bounded-memory-not-document.md),
[Lore V2 runner](../../scripts/benchmark-longmemeval-v2.ts)).

V2-Small is therefore the right primary agent-memory gate, V2-Medium is the right
scale gate, and legacy LongMemEval remains a distinct coverage track rather than a
deprecated predecessor.
