# Mem0 token-efficient algorithm: source and benchmark audit

Research date: 2026-08-07. This note audits only Mem0's [algorithm
article](https://mem0.ai/blog/mem0-the-token-efficient-memory-algorithm), the
official [`mem0ai/mem0`](https://github.com/mem0ai/mem0) and
[`mem0ai/memory-benchmarks`](https://github.com/mem0ai/memory-benchmarks)
repositories, and the original benchmark papers/data to which those sources
point. The article is a product/engineering post, not a peer-reviewed algorithm
paper.

## Revisions inspected

| Artifact | Pinned revision | Why it matters |
| --- | --- | --- |
| Mem0 OSS current `main` | [`4debc58a83377b18be81ae1e5969a300736b2fac`](https://github.com/mem0ai/mem0/tree/4debc58a83377b18be81ae1e5969a300736b2fac) | Current source at the research cutoff. |
| Article modification-time snapshot proxy | [`df9d5cc4b151861304bb4f7ec1fdca6d54bbc45a`](https://github.com/mem0ai/mem0/tree/df9d5cc4b151861304bb4f7ec1fdca6d54bbc45a) | The page's own JSON-LD says `datePublished=2026-04-16` and `dateModified=2026-07-10T03:58:56.817Z`. This unrelated documentation fix is the closest `main` commit before that modification time; there is no 10 July algorithm release commit or tag. It is a temporal proxy, not a claimed release. |
| OSS v3 feature port | [`a488e19044e4de9322a4e82be8d49ee67a322151`](https://github.com/mem0ai/mem0/commit/a488e19044e4de9322a4e82be8d49ee67a322151) | The actual merged commit, on 2026-04-14, titled “port v3 pipeline with hybrid search, entity extraction, and additive scoring.” |
| First tagged OSS v3 release | [`fb224083e4f82fb9a1604b5f113c30378587a7f0`](https://github.com/mem0ai/mem0/commit/fb224083e4f82fb9a1604b5f113c30378587a7f0) | The 2026-04-16 release commit tagged Python `v2.0.0` and Node `ts-v3.0.0`, matching the article's original publication date. |
| Mem0 benchmark suite | [`4b61c5d31b9c668a12b4f5e78064248a02c82d2b`](https://github.com/mem0ai/memory-benchmarks/tree/4b61c5d31b9c668a12b4f5e78064248a02c82d2b) | Current benchmark `main`; it is also the `evaluation` submodule revision pinned by current Mem0. This commit changed README score tables, not result artifacts. |

The relevant algorithm files are unchanged between the 10 July modification-time
proxy and current `main`; later changes in the inspected diff concern identity
metadata hardening and bulk deletion. Pinning the feature commit separately avoids
mistaking the 10 July blog modification for the code landing date.

## Executive verdict

- **ADD-only fact extraction, assistant attribution, entity extraction/linking,
  lemmatized BM25, and three score signals are present in OSS.** They are not all
  present in precisely the form described by the article.
- OSS performs **score-level additive fusion over a dense-only candidate set**. It
  is not reciprocal-rank fusion, and keyword/entity hits cannot introduce a
  candidate that dense retrieval missed.
- “One LLM call” means one extraction call for each `Memory.add(..., infer=True)`
  ingestion unit. The published runners call `add` repeatedly: one LoCoMo turn or
  two LongMemEval/BEAM messages at a time. It does not mean one extraction call for
  an entire benchmark conversation.
- The automatic ingestion path only emits `ADD`, but the OSS API still exposes
  explicit update and delete operations. “ADD-only” is therefore an inference
  pipeline property, not an immutable event-store contract.
- The prompt asks the LLM for explicit `linked_memory_ids`, but the current
  primary-memory persistence path never consumes that output field. The durable
  relationship that does exist is a separately embedded entity record containing
  a list of Memory ids.
- The advertised managed scores cannot be reproduced from the open repository as
  pinned. The README contains the new LoCoMo/LongMemEval numbers, while the checked-in
  per-question artifacts contain older, lower numbers. BEAM's checked-in artifacts
  do support its table values.
- The article explicitly says its scores use proprietary managed-platform
  optimizations unavailable in OSS. They are not comparable to Lore's current local
  4B experiment without a matched dataset revision, reader, judge, embedder,
  extraction policy, top-k, prompt, and token-accounting protocol.

## Claim-to-code audit

### 1. ADD-only and assistant facts

**Present, with scope qualifications.**

The v3 system prompt names ADD as its sole operation, extracts from both user and
assistant messages, and requests `attributed_to`; see
[`ADDITIVE_EXTRACTION_PROMPT`](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/configs/prompts.py#L468-L540)
and its output schema
([lines 917–940](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/configs/prompts.py#L917-L940)).
The synchronous inferred-add path:

1. retrieves ten existing vector memories;
2. invokes the configured LLM once;
3. parses `memory[]`, hashes exact extracted text for deduplication, embeds the
   surviving facts, and batch-inserts new UUID records;
4. writes history rows whose event is always `ADD`.

The implementation is
[`Memory._add_to_vector_store`](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/memory/main.py#L874-L1081).
`infer=False` also writes each non-system input message as an `ADD`
([lines 875–909](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/memory/main.py#L875-L909)).

Important limitations:

- This is LLM-based automatic fact extraction from conversation. Porting it into
  Lore v1 would cross the current no-AutoDream/no-automatic-consolidation scope,
  even though it does not merge or overwrite old facts.
- Exact MD5 text deduplication is not semantic deduplication. Changed wording can
  produce another fact.
- The public `Memory.update()` and deletion methods remain available after
  ingestion. The older `add()` docstring also still describes add/update/delete
  decision-making, despite the v3 inferred path being additive.
- The prompt builder has fields for summary, recently extracted memories, and an
  observation timestamp, but this `add` call supplies only existing memories, new
  messages, the last ten messages, and custom instructions. Summary/recent fields
  are empty and the observation date falls back to the current date; see the caller
  [lines 945–951](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/memory/main.py#L945-L951)
  and builder
  [lines 1018–1073](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/configs/prompts.py#L1018-L1073).

### 2. Entity extraction and linking

**Present as deterministic NLP plus an entity vector collection.**

After new fact records are inserted, Mem0 uses spaCy to extract named entities,
technical identifiers, proper-name spans, quoted text, and noun/topic phrases. It
returns no entities when the optional spaCy model is absent; batched extraction
uses `nlp.pipe(..., batch_size=32)`. The entry points are
[`extract_entities` / `extract_entities_batch`](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/utils/entity_extraction.py#L751-L773).

The add path lowercases/collapses entity text, embeds each unique entity, prefers
an exact normalized-text match, accepts a semantic entity match at similarity
`>=0.95`, and stores/updates entity payloads containing `linked_memory_ids`; see
[phase 7](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/memory/main.py#L1081-L1185).

This supports the article's **entity-to-Memory adjacency** claim. It does not
currently implement the prompt's separate LLM-suggested Memory-to-Memory links:
`linked_memory_ids` from each extracted `memory[]` object is neither copied into the
new Memory payload nor used during persistence. Only the entity records' link lists
are consumed at query time.

Entity collection filters are limited to nonempty `user_id`, `agent_id`, and
`run_id`. That convention is not an authorization substitute and must not be copied
into Lore's Workspace/user-private model.

### 3. Semantic + BM25 + entity fusion

**All three signals exist; the article's “rank fusion” description is imprecise for
OSS.**

`Memory.search` defaults to `top_k=20`, semantic `threshold=0.1`, and reranking off
([signature](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/memory/main.py#L1374-L1383)).
Its internal path
([lines 1623–1682](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/memory/main.py#L1623-L1682)):

1. lemmatizes the query and extracts entities;
2. embeds the original query;
3. performs dense search with `internal_limit=max(top_k*4, 60)`;
4. performs keyword search with the same limit when the vector store implements it;
5. normalizes BM25 scores and computes entity boosts;
6. constructs candidates **only from dense results**, applies the semantic threshold,
   then adds scores.

The exact OSS formula is

```text
combined = (semantic + normalized_bm25 + entity_boost) / max_possible
```

where `max_possible` is `1`, `2`, `1.5`, or `2.5` depending on which auxiliary
maps are nonempty. `ENTITY_BOOST_WEIGHT=0.5`; see
[`scoring.py`](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/utils/scoring.py#L57-L141).
This is additive score fusion, not RRF and not fusion of three independent ranked
candidate lists. A keyword-only or entity-only candidate cannot recover from a
dense miss or a semantic score below `0.1`.

Query entity processing is bounded to the first eight unique normalized entities.
Each query entity searches up to 500 entity rows at similarity `>=0.5`; at most four
threads run those lookups. The per-Memory boost takes the maximum—not the sum—across
matches and discounts high-degree entities as
`1 / (1 + 0.001 * (linked_count - 1)^2)`; see
[`_compute_entity_boosts`](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/memory/main.py#L1725-L1808).

The synchronous implementation executes dense, keyword, and entity stages in
sequence; only entity subqueries use a thread pool. “In parallel” is an architectural
description, not the current Python call schedule.

### 4. Keyword normalization

**Present when the NLP extra and a keyword-capable vector store are available.**

[`lemmatize_for_bm25`](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/utils/lemmatization.py#L1-L48)
lowercases text, drops punctuation and stopwords, emits alphanumeric spaCy lemmas,
and also keeps an original `-ing` form when it differs from the lemma. If spaCy is
unavailable it returns the original text unchanged. Facts store the result as
`text_lemmatized`; queries receive the same transformation.

Raw BM25 is mapped through a logistic sigmoid. Parameters depend on lemmatized query
length: `<=3: (midpoint=5, steepness=.7)`, `<=6: (7,.6)`, `<=9: (9,.5)`,
`<=15: (10,.5)`, otherwise `(12,.5)`; see
[`get_bm25_params`](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/utils/scoring.py#L14-L45).
Unsupported vector stores warn and degrade to semantic/entity behavior. The
benchmark Docker profile uses Qdrant and installs the NLP dependency, so the feature
is intended to be active there.

### 5. What is not in OSS

The separate entity collection is not Mem0 Graph Memory. Mem0's current official
docs state that Graph Memory and its entity graph are Platform-only, while OSS has
only the entity-overlap boost
([how it works](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/docs/core-concepts/how-it-works.mdx#L53-L65),
[migration guide](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/docs/migration/oss-v2-to-v3.mdx#L332-L348)).
The exact managed fusion backend, temporal extraction/scoring, Graph store, model
stack, and asynchronous event pipeline are not present in the inspected OSS core.
Accordingly, the article's managed behavior cannot be reconstructed merely by
turning on the OSS spaCy entity collection.

## Benchmark protocol audit

### Dataset identity and ingestion

| Benchmark | Original source | What the Mem0 runner actually selects | Version finding |
| --- | --- | --- | --- |
| LoCoMo | Maharana et al., *Evaluating Very Long-Term Conversational Memory of LLM Agents*, ACL 2024 ([paper](https://arxiv.org/abs/2402.17753), [official repo](https://github.com/snap-research/locomo)) | Mutable `snap-research/locomo/main/data/locomo10.json`; ten conversations; categories 1–4 only, excluding 446 adversarial questions; one turn per `add`; image URLs are represented by released BLIP caption/query text, not inline images. Runner: [`locomo/run.py`](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/benchmarks/locomo/run.py#L85-L113). | No upstream commit, byte length, or SHA-256 is pinned. Current official repo HEAD observed during this audit was `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376`; that does **not** establish what the April run used. |
| LongMemEval | Wu et al., *LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory*, ICLR 2025 ([paper](https://arxiv.org/abs/2410.10813), [official repo](https://github.com/xiaowu0162/LongMemEval), [official cleaned data](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)) | Mutable HF `resolve/main/longmemeval_s_cleaned.json`; all 500 questions for published runs; one user/assistant pair per `add`. Runner: [`longmemeval/run.py`](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/benchmarks/longmemeval/run.py#L90-L96). | No HF revision or file hash is pinned. Current HF dataset HEAD observed was `98d7416c24c778c2fee6e6f3006e7a073259d48f`; the published-run revision is unknowable from the report. |
| BEAM | Tavakoli et al., *Beyond a Million Tokens: Benchmarking and Enhancing Long-Term Memory in LLMs*, arXiv v2 (2026) ([paper](https://arxiv.org/abs/2510.27246v2), [official 100K–1M data](https://huggingface.co/datasets/Mohammadta/BEAM), [official 10M data](https://huggingface.co/datasets/Mohammadta/BEAM-10M)) | Mutable HF datasets/splits; two turns per `add`. Published artifacts cover 700 questions at 1M and 200 at 10M, rather than the complete 2,000-question/100-conversation benchmark. Runner: [`beam/run.py`](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/benchmarks/beam/run.py#L84-L164). | No HF revision or file hash is pinned. Current observed HEADs were `3205395e897e7318c7b094ef4e6047b9b82dbb03` (BEAM) and `9b2096193fe74e2837e4713e483351e19817773c` (10M); the April-run revisions remain unknown. |

The lack of immutable dataset manifests is material: LongMemEval's official source
documents a September 2025 cleaned-data revision, and all three runner URLs follow a
mutable `main`.

The benchmark's self-host container compounds this: its dependency file installs
Mem0 from mutable branch `feat/v3-pipeline`, not from a commit or release tag
([requirements](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/docker/mem0/requirements.txt#L1-L5)).

### Retrieval depth, models, and scoring

The source defaults—not the stale CLI text in the benchmark README—are:

| Benchmark | Retrieval / sample | Answerer and judge | Metric used for article number |
| --- | --- | --- | --- |
| LoCoMo | `top_k=200`, cutoffs `10,20,50,200`, all ten conversations, categories 1–4 | Source defaults `gpt-5` / `gpt-5`; published artifact says Azure and `with_evidence=false`. [CLI](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/benchmarks/locomo/run.py#L682-L688). | Custom binary LLM-judge accuracy at top 200, not the original LoCoMo token-F1 protocol. Its prompt grants correctness for one item from a list, dates within 14 days, durations within 50%, and same referent despite different descriptions; see [`locomo/prompts.py`](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/benchmarks/locomo/prompts.py#L203-L275). |
| LongMemEval | `top_k=200`, cutoffs `10,20,50,200`; published artifact all 500 | Source defaults `gpt-5` / `gpt-5`; checked-in artifacts identify generic `gpt-5`, usually Azure, but no dated model snapshot. [CLI](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/benchmarks/longmemeval/run.py#L936-L1015). | Custom yes/no LLM-judge accuracy. The prompt is adapted, not identical to the official evaluator, explicitly says “when in doubt, lean toward yes,” and adds many permissive equivalences; see [`longmemeval/prompts.py`](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/benchmarks/longmemeval/prompts.py#L262-L354). |
| BEAM | `top_k=200`; runner's default cutoff is 100, but published artifacts use top 200; selected 1M/10M conversations only | Source and artifacts use generic `gpt-5` / `gpt-5`, Azure in artifacts, no dated model snapshot. [CLI](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/benchmarks/beam/run.py#L896-L925). | A judge scores each rubric nugget `0/0.5/1`; the article's 64.1/48.6 are mean scores (`0.641`/`0.486`), not pass rates. The corresponding pass rates are 70.1%/50.5%. [Judge](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/benchmarks/beam/prompts.py#L161-L235). |

The shared client advertises temperature zero, but deliberately omits temperature
for `gpt-5` and o-series models because those endpoints accept the provider default
temperature; see
[`LLMClient`](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/benchmarks/common/llm_client.py#L71-L84).
Consequently these reported GPT-5 answerer/judge runs are not a pinned,
temperature-zero deterministic reader protocol.

The benchmark's default **self-host** Docker configuration is a different system:
`gpt-4o-mini` extraction, `text-embedding-3-small` at 1,536 dimensions, and Qdrant
([compose](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/docker-compose.yml#L17-L31)).
Its published OSS LongMemEval comparison instead says it used Qwen 600M via
SageMaker, Qdrant, GPT-5 answerer/judge, and four different extraction models
([README](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/README.md#L240-L257)).
The JSON artifacts do not record the extractor or embedder identifiers/revisions,
and several record `metadata.total_questions=1000` while their metrics contain 500.

### Advertised scores versus checked-in evidence

The blog's scores match the benchmark README, but not all committed raw artifacts:

| Claim | README at `4b61c5d` | Checked-in result artifact at the same commit | Audit status |
| --- | --- | --- | --- |
| LoCoMo top-200 | 92.5% (1425/1540) | [`locomo_results.json`](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/results/platform/locomo_results.json) says 91.56% (1410/1540). | New score is README-only; no matching per-question artifact is committed. |
| LongMemEval top-200 | 94.4% (472/500) | [`longmemeval_results.json`](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/results/platform/longmemeval_results.json) says 93.4% (467/500). | New score is README-only; no matching per-question artifact is committed. |
| BEAM 1M top-200 | 64.1 mean score | [`beam_1m_results.json`](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/results/platform/beam_1m_results.json) says `0.640865...`. | Supported, subject to the unpinned protocol caveats above. |
| BEAM 10M top-200 | 48.6 mean score | [`beam_10m_results.json`](https://github.com/mem0ai/memory-benchmarks/blob/4b61c5d31b9c668a12b4f5e78064248a02c82d2b/results/platform/beam_10m_results.json) says `0.4860235`. | Supported, subject to the unpinned protocol caveats above. |

Commit `4b61c5d` changed only the README from the older artifact values to the new
LoCoMo/LongMemEval values. This does not prove the claims false, but the open
repository does not contain the corresponding runs needed to independently audit or
reproduce them.

### Token-accounting finding

The article reports mean tokens per query (LoCoMo 6,956; LongMemEval 6,787; BEAM 1M
6,719; BEAM 10M 6,914). The open benchmark code has optional `prompt_tokens` and
`completion_tokens` fields in its schema, but the LLM client returns only response
text, never reads provider `usage`, and no runner assigns those fields. The checked-in
results contain no token counts. The article does not define the tokenizer, whether
the number covers retrieved context only or the complete answer/judge pipeline, or
how managed extraction costs are amortized.

Therefore the token claims may be valid internal measurements, but they are **not
reproducible from the released evaluator** and should not be used as a cost baseline
for Lore.

### Managed-platform boundary

The article explicitly states that its results reflect the managed Mem0 platform
and include proprietary optimizations unavailable in OSS; it promises only
directionally similar OSS gains. The open README separately reports OSS
LongMemEval scores of 88.6–91.0 under its Qwen/SageMaker setup. Managed and OSS
results are different systems and must not be mixed into one public leaderboard
claim.

## Comparability to Lore's current local 4B experiment

**Not directly comparable.** A number from either system would only become
comparable after a paired rerun that fixes all of the following:

- exact dataset bytes and included question ids (especially LoCoMo adversarial
  exclusion and BEAM conversation subsets);
- ingestion unit and automatic extraction policy;
- embedding model/revision/dimension and candidate generation;
- top-k and evidence/context budget (Mem0 commonly supplies up to 200 extracted
  Memories to its reader);
- reader and judge provider, dated model revision, prompts, decoding, and retry
  policy;
- scoring protocol (custom permissive binary judges versus official metric, and
  BEAM mean score versus pass rate);
- token measurement boundary and tokenizer;
- managed proprietary retrieval/temporal features.

Lore's local 4B reranker experiment tests a specific local second stage over
RLS-authorized evidence. Mem0's article evaluates an end-to-end managed memory
pipeline with a GPT-5 reader and judge. A higher end-answer percentage cannot be
attributed to retrieval, and it does not establish that Mem0's retrieval is more
accurate than Lore's local 4B configuration.

## Smallest safe candidates for Lore

Ordered by implementation value and scope fit:

1. **Entity as a third, independently authorized recall channel.** Derive bounded
   deterministic entities/aliases from canonical chunks, store them in RLS-covered
   Workspace/user-private tables, and require Workspace/scope/owner predicates
   before entity top-k. Fuse its independent candidate list with Lore's existing
   lexical/dense lists using the existing deterministic RRF seam. Do not copy Mem0's
   dense-only candidate gate or global entity link lists. Start with exact aliases
   and identifiers; benchmark spaCy semantic entity merging separately.
2. **English query/document lemma ablation.** Mem0's `-ing` preservation is a
   concrete, small heuristic worth testing against Lore's current simple/English
   FTS channels. If adopted, make it a pinned indexing-protocol revision and
   deployment-wide reindex, not a request option. Keep original identifier/proper
   noun tokens and fail back to existing lexical search for unsupported languages.
3. **Assistant-origin provenance, only on explicit remember.** Lore already has
   agent provenance. Permit callers to store an agent/assistant-produced Memory as
   a first-class canonical write with its existing ownership and scope rules. Do
   not automatically mine every assistant response.

Explicitly reject for Lore v1:

- the LLM ADD-only conversation extractor, profile summary, or behavioral-pattern
  extraction: these are automatic consolidation/AutoDream by another name;
- prompt-produced Memory-to-Memory links without a validated deterministic writer;
- entity/keyword rescoring after global retrieval or after RLS filtering;
- copying Mem0's additive raw-score constants without a versioned Lore ablation;
- enabling global recency/latest-wins behavior from these article scores. Temporal
  conflict handling requires its own benchmark and explicit query semantics.

The first experiment should therefore be **baseline Lore hybrid RRF versus the same
pipeline plus an RLS-first exact entity/alias channel**, on identical indexed data,
with candidate recall, exact evidence recall, no-answer false results, isolation,
reader accuracy, latency, and provider cost all reported. That isolates the one
portable article idea without importing Mem0's automatic consolidation or weakening
Lore's authorization model.
