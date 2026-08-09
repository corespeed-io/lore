# LoCoMo runner audit

Verified against the original paper and the authors' repository on 2026-08-07.
This note covers the ACL 2024 LoCoMo release. It does not treat later third-party
ports, leaderboard wrappers, or LLM-judge variants as the original protocol.

## Canonical sources and immutable inputs

The canonical paper is **“Evaluating Very Long-Term Conversational Memory of LLM
Agents,” Adyasha Maharana, Dong-Ho Lee, Sergey Tulyakov, Mohit Bansal, Francesco
Barbieri, and Yuwei Fang (ACL 2024)**
([ACL Anthology / DOI](https://aclanthology.org/2024.acl-long.747/),
[final PDF](https://aclanthology.org/2024.acl-long.747.pdf)). The final paper's
Table 5 describes ten conversations averaging 27.2 sessions, 21.6 turns per
session, and 16,618.1 tokens per conversation.

Do not use [arXiv:2402.17753v1](https://arxiv.org/abs/2402.17753v1) as the data
identity. That February 2024 version describes an earlier 50-conversation release
with different statistics. The official repository says that the current ten
conversations are a quality- and cost-selected subset of that earlier release
([README](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/README.MD#L6-L26)).

Recommended dataset manifest:

```json
{
  "name": "locomo-acl24",
  "repository": "snap-research/locomo",
  "revision": "3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376",
  "path": "data/locomo10.json",
  "bytes": 2805274,
  "sha256": "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4",
  "gitBlobSha1": "d95b872480b413d935821fdc3c84f8a8f5f29e73",
  "license": "CC-BY-NC-4.0",
  "paperDoi": "10.18653/v1/2024.acl-long.747"
}
```

Fetch the JSON from the
[commit-pinned raw URL](https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json),
verify byte length and SHA-256 before parsing, and keep the downloaded file in
ignored local benchmark storage. The repository supplies the full Creative
Commons Attribution-NonCommercial 4.0 license
([identity and acceptance](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE.txt#L57-L68),
[noncommercial definition and grant](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE.txt#L116-L155)).
Using or redistributing it in a commercial evaluation needs license review; Lore
should not vendor it into its own source release.

The JSON is one array of ten evaluation conversations. There are no official
train/dev/test partitions for QA. The released schema contains the chronological
conversation sessions and timestamps, generated observations, generated session
summaries, annotated event summaries, and QA annotations
([schema](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/README.MD#L12-L21)).
The official evaluator reads that array and iterates every conversation and every
QA item; it does not select a split
([runner](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/evaluate_qa.py#L67-L105)).

Images are not released. Image-bearing turns retain a web URL, search query, and
BLIP caption
([README](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/README.MD#L14-L26)).
The paper's QA and event-summarization experiments replace images with their
captions; only the multimodal dialogue-generation task uses images directly. A QA
runner should therefore use the pinned `blip_caption`, not re-download mutable web
images or call a new captioner.

## Tasks and QA categories

LoCoMo defines three tasks:

1. question answering;
2. event summarization; and
3. multimodal dialogue generation.

Only QA has executable evaluation code in the official release. Event summarization
and multimodal generation are still marked “Coming soon”
([README](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/README.MD#L90-L102)).
The paper specifies ROUGE-1/2/L plus an adapted FActScore precision/recall/F1 for
event summarization, and BLEU-1/2, ROUGE-L, and MM-Relevance for multimodal
generation, but the missing official evaluators and prompts prevent a
fixed-repository reproduction of those two tasks. A Lore QA runner must not be
described as the complete three-task LoCoMo benchmark.

The fixed JSON has 1,986 QA items. Its numeric categories map to the paper as
follows:

| JSON category | Paper category | Definition | Count |
| ---: | --- | --- | ---: |
| 4 | Single-hop | Answerable from one session | 841 |
| 1 | Multi-hop | Synthesize evidence across sessions | 282 |
| 2 | Temporal reasoning | Resolve temporal cues and dates | 321 |
| 3 | Open-domain knowledge | Combine speaker facts with outside/common knowledge | 96 |
| 5 | Adversarial | The question is unanswerable from the conversation | 446 |

These counts match the final paper's Table 5. The official reporting order is
`[4, 1, 2, 3, 5]`, and its overall score sums all per-question scores before
dividing by all questions; it is a question-count-weighted micro average, not an
equal average of five category means
([aggregation](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/evaluation_stats.py#L94-L108)).

## Official QA reader protocol

There is no original LoCoMo LLM judge. A reader generates a short answer and the
repository scores it programmatically.

The common prompt asks for a short phrase and requests exact conversation wording
where possible; the batched form requests a JSON dictionary
([prompts](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/gpt_utils.py#L23-L51)).
The released OpenAI path additionally:

- appends an instruction to use conversation dates for category 2;
- turns category 5 into a two-option question containing one distractor and “Not
  mentioned in the conversation,” with unseeded random option order;
- uses temperature 0 and a 32-token cap for single-question generation; and
- serializes each retrieved turn with its date, speaker, text, and BLIP caption.

Those behaviors are visible in the
[question construction and call](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/gpt_utils.py#L225-L296)
and the
[dialog serialization](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/gpt_utils.py#L78-L103).
The final paper reports API/model state as of May 2024, temperature 0, top-p 1,
one run per model, and an A6000 for local inference. The released adapters do not
fully realize that claim: Claude maps to a date-pinned model but leaves decoding
defaults implicit; Gemini uses mutable `models/gemini-1.0-pro-latest`; OpenAI uses
mutable aliases
([provider calls](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/global_methods.py#L56-L128),
[Gemini alias](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/evaluate_qa.py#L44-L58)).
The Hugging Face path pins repository names but not weight/tokenizer revisions and
actually samples at temperature 0.4, top-p 0.9, and top-k 10
([decoding](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/hf_llm_utils.py#L91-L167),
[model mapping](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/hf_llm_utils.py#L305-L335)).

Consequently, “official prompt” does not imply a bit-reproducible official reader.
A Lore result must pin provider, exact model revision/digest, tokenizer revision,
transport, prompt bytes/hash, context serialization, decoding parameters, output
budget, and repetition count. A local 4B reader score is a valid named LoCoMo data
evaluation, but it is not directly comparable to the paper's closed-model results.

## Official RAG protocol

The final paper's RAG baseline uses DRAGON's distinct query and context encoders,
dot-product retrieval, and `gpt-3.5-turbo` as reader. The code loads mutable
Hugging Face model identifiers `facebook/dragon-plus-query-encoder` and
`facebook/dragon-plus-context-encoder`
([encoder loading](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/rag_utils.py#L53-L91))
and takes the highest dot products
([ranking](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/gpt_utils.py#L145-L169)).
The official script evaluates three separately named databases:

- dialog turns at top-k 5, 10, 25, and 50;
- generated observations at top-k 5, 10, 25, and 50; and
- generated session summaries at top-k 2, 5, and 10.

See the fixed
[RAG sweep script](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/scripts/evaluate_rag_gpts.sh#L4-L27).
Retrieval recall is annotated-evidence coverage, not answer accuracy: dialog mode
matches exact turn IDs; summary mode maps evidence to session IDs
([retrieval metric](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/evaluation.py#L228-L237)).
The code assigns recall 1 when the prediction has no recorded context or the QA has
no evidence, so that fallback must not be reported as measured retrieval success.

Lore's hybrid search, query expansion, reranking, feedback, evidence expansion, and
different chunk unit are benchmark variants, not the paper's DRAGON baseline. Each
must be named and recorded independently. For a native Lore memory-system test,
dialog-turn/session ingestion and authorized Lore retrieval are appropriate, while
the pre-generated observation and summary databases are separate comparison modes;
using them silently would test upstream generated consolidation rather than Lore's
v1 no-AutoDream scope.

## Exact answer scoring

The official scorer lowercases, removes commas and punctuation, removes the words
`a`, `an`, `the`, and `and`, collapses whitespace, Porter-stems tokens, and computes
multiset token precision/recall/F1
([normalization and F1](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/evaluation.py#L75-L145)).
Category-specific behavior is:

- categories 2, 3, and 4 use ordinary token F1;
- category 1 splits prediction and gold on commas, then averages each gold part's
  best match against any predicted part; extra predicted parts are not penalized
  symmetrically;
- category 3 discards gold text after the first semicolon; and
- category 5 gives 1 only when the output contains `no information available` or
  `not mentioned`, otherwise 0.

The exact branches are in
[`eval_question_answering`](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/evaluation.py#L189-L241).
Lore should vendor a small independently tested scorer implementation or call a
commit-pinned copy; any semantic/LLM judge must be a separately named, separately
reported non-original metric.

## Release defects that prevent an unchanged full run

The current data and current official code cannot execute all 1,986 cases unchanged.

At the pinned revision, 444 of 446 category-5 rows have `adversarial_answer` but no
`answer`; two contain both. A representative row is visible in the
[fixed dataset](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json#L1268-L1275).
Every released reader constructs the adversarial choice from `qa["answer"]`, for
example the
[OpenAI reader](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/gpt_utils.py#L243-L256),
and the scorer dereferences `line["answer"]` before branching on category
([scorer](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/task_eval/evaluation.py#L197-L218)).
Both paths therefore raise on almost every adversarial item. In addition, the
multiple-choice option order uses unseeded `random.random()`, so merely mapping the
field does not make the prompts deterministic.

Other reproducibility gaps include mutable API aliases, unpinned Hugging Face model
and tokenizer revisions, unpinned DRAGON revisions, paper/code decoding differences,
and a launch script that invokes Llama 3 twice while omitting its apparent Llama 2
entry
([script](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/scripts/evaluate_hf_llm.sh#L5-L9)).

## Recommended Lore protocol versions

Implementing a runner should start with two distinct, immutable profiles rather
than hiding the upstream defect:

1. **`locomo-acl24-positive-f1`** — categories 1–4 only; all 1,540 positive cases;
   original prompt behavior and exact programmatic scorer. This is the cleanest
   unchanged QA subset, but must not be called the full 1,986-question score.
2. **`locomo-acl24-repaired-adversarial`** — category 5 only; use
   `adversarial_answer` as the distractor, use the original unanswerable phrase as
   gold, and fix option order deterministically (or record a seed). Label the field
   mapping and ordering as a Lore repair. Do not merge it into an “official” overall
   without exposing the repaired protocol ID.

For every profile, also record:

- dataset manifest and license acknowledgement;
- included sample IDs, category counts, skipped cases, and a case-order hash;
- exact reader and scorer revisions, prompt hash, decoding, and token budget;
- ingestion unit and timestamp/turn-ID preservation;
- retrieval mode, candidate top-k, chunk/evidence policy, embedding space, planner,
  reranker, feedback, and calibration settings;
- answer F1 and evidence recall separately, including evidence-less cases; and
- RLS isolation failures as a hard failure rather than part of an average.

Each conversation should run in an isolated evaluation Workspace with its own
Actor/RLS context. Retrieval and any query-time enhancement must operate only on
authorized evidence. Keep this evaluation read-only with respect to production
Memories and do not convert observations/session summaries into automatic production
memory consolidation.
