# Query-time memory retrieval and ranking audit

Audited: 2026-08-07. This note asks a deliberately narrow question: which
retrieval-time ideas from recent long-term-memory systems can improve Lore v1
without automatic summarization, memory merging, entity extraction, graph
construction, or cross-tenant data access?

## Decision

The best next ablation after Lore's current hybrid retrieval plus Qwen3 0.6B
reranker is a **bounded, RLS-safe recall arm over Lore's existing durable Memory
Links**, followed by the unchanged reranker. Mnemis provides the clearest primary
signal: its System-1 retrieval already includes an 8B Qwen3 reranker and scores
`89.1`, while adding the complementary structural route raises it to `93.3`.
MemORAI independently finds that a query-focused one-hop subgraph raises LoCoMo
turn Recall@10 from `51.77` to `64.68` while reducing its PageRank kernel time.
These results do not prove that Lore's simpler links will reproduce either gain,
but they target a limitation no reranker can repair: an absent candidate.

The proposed Lore arm is an adaptation, not a reproduction of Mnemis or MemORAI.
It uses only explicit/imported durable `memory_links`, never visualization-only
affinity or automatically synthesized links; caps seeds, degree, and total
neighbors; reapplies every Actor/RLS and request filter to both endpoints; and
makes zero additional model calls. Details and an ablation order appear below.

Do not describe any result in this note as a universal SOTA comparison. The
papers use different reader models, judges, task exclusions, evidence units,
and automatically constructed memory representations. In particular, APEX-MEM
uses GPT-5 and up to 40 tool calls, MemORAI uses a 20B reader, LiCoMemory uses a
70B model or GPT-4o-mini, and Mnemis excludes LoCoMo's adversarial category from
its headline score.

## Evidence manifest

The ACL Anthology camera-ready PDFs are the authoritative paper versions. The
hashes below are SHA-256 values of the PDFs retrieved on the audit date.

| System | Primary paper | Official implementation/artifacts | License and fixed revision |
| --- | --- | --- | --- |
| APEX-MEM | Banerjee, Moshtaghi, Subramanian, Misra, and Chadha, 2026, [ACL paper](https://aclanthology.org/2026.acl-long.749/), [Amazon Science record](https://www.amazon.science/publications/apex-mem-agentic-semi-structured-memory-with-temporal-reasoning-for-long-term-conversational-ai), [PDF](https://aclanthology.org/2026.acl-long.749.pdf), `c0dec82436415dc05a6f657023b9c4aabf35ecc123e669369598cb97935ded9b` | The paper, ACL page, and Amazon Science publication page do not link an implementation. No author implementation was located. | Paper is an ACL 2026 publication; no software artifact or software license to pin. |
| HiGMem | Cao, He, and Tan, 2026, [Findings paper](https://aclanthology.org/2026.findings-acl.1690/), [PDF](https://aclanthology.org/2026.findings-acl.1690.pdf), `a9fa06d4da4bbee6ee49392df8ffe44c1efc74d741bcf4fbf76cc2d3c474e114` | [ZeroLoss-Lab/HiGMem](https://github.com/ZeroLoss-Lab/HiGMem/tree/f275072f25323a01a8bff3680edbb34ed97d33be) | MIT, commit `f275072f25323a01a8bff3680edbb34ed97d33be`, 2026-04-22; [license](https://github.com/ZeroLoss-Lab/HiGMem/blob/f275072f25323a01a8bff3680edbb34ed97d33be/LICENSE#L1-L21). |
| LiCoMemory / CogniRank | Huang, Tian, Guo, Zhang, Zhou, Jiang, Xie, and Zhou, 2026, [Findings paper](https://aclanthology.org/2026.findings-acl.1835/), [PDF](https://aclanthology.org/2026.findings-acl.1835.pdf), `73cf3a7ba1fe4c2ed536e760df3fdf11ee73a86f3cd97e96cde47a213f70ca24` | [EverM0re/LiCoMemory](https://github.com/EverM0re/LiCoMemory/tree/a844d993f77f947f682a0a52ec2825f2950bc0b3) | Commit `a844d993f77f947f682a0a52ec2825f2950bc0b3`, 2026-01-06. The fixed tree has no license file, so inspection is possible but copying code is not licensed. |
| MemORAI | Van, Hieu, Tuan, Hai, Van, Diep, and Le, 2026, [Findings paper](https://aclanthology.org/2026.findings-acl.1408/), [PDF](https://aclanthology.org/2026.findings-acl.1408.pdf), `131b42a05e96e04345af1a46fd8ab7b27fa04b3b75042de84b23b64ee9044c12` | The paper and ACL page do not link an implementation. No author implementation was located. | Paper is an ACL 2026 publication; no software artifact or software license to pin. |
| Mnemis | Tang, Yu, Xiao, Wen, Li, Zhou, Wang, Wang, Huang, Deng, Sun, and Zhang, 2026, [ACL paper](https://aclanthology.org/2026.acl-long.1096/), [PDF](https://aclanthology.org/2026.acl-long.1096.pdf), `1caed16fc8729d4f9e7d76b0746885e4c40233daf18a4931ad1a9769c36ce7d4` | [microsoft/Mnemis](https://github.com/microsoft/Mnemis/tree/4552fed19bc0cde7b990a6ceb0365cd75b1b3453) | MIT, commit `4552fed19bc0cde7b990a6ceb0365cd75b1b3453`, 2026-04-14; [license](https://github.com/microsoft/Mnemis/blob/4552fed19bc0cde7b990a6ceb0365cd75b1b3453/LICENSE#L1-L21). |

ACL camera-ready status does not make the accompanying software complete or
reproducible. Fixed commits, released prompts, result artifacts, dependency
locks, and data revisions are audited separately below.

## Current Lore evidence

Lore already has RLS-filtered lexical plus dense candidate generation,
deterministic fusion, a Qwen3 0.6B cross-encoder, optional query planning,
bounded feedback retrieval, evidence expansion, and temporal recency RRF.

The local 35-question LoCoMo experiment improved answer F1 from `0.5090` to
`0.5654` on its held-out slice and from `0.4313` to `0.4808` on its development
slice with the 0.6B reranker. Planner plus reranker increased evidence recall but
did not beat reranker-only answer quality on the held-out slice. These are small,
non-comparable local measurements, not a paper leaderboard claim; see
[the local LoCoMo ablation](./locomo-local-qwen35-4b-ablation.md).

The conflict workload went the other direction: generic pairwise reranking
regressed, while recency RRF helped. That suggests the next experiment should
test **joint evidence-set reasoning** and temporal contradictions rather than
merely increasing the size of the pairwise reranker; see
[the Apple-Silicon reranker audit](./local-reranker-apple-silicon.md).

## APEX-MEM

### Paper-backed method

APEX-MEM stores append-only temporal facts in a property graph. Its query path is
a ReAct agent with four paper-defined actions:

1. `SchemaViewer` exposes the relational schema and query guidance.
2. `EntityLookup(q, K)` performs dense plus lexical entity recall, then returns a
   time-aware fact snapshot for each entity.
3. `GraphSQL(sql, params)` accepts one read-only SQLite `SELECT` or
   `WITH ... SELECT` over a table whitelist and supports joins, aggregates,
   arithmetic, and temporal calculations.
4. `Search(q)` returns a hybrid graph/entity/property/event/evidence/turn context.

Each step appends the tool result to agent history. Relative time expressions are
resolved to dates or date ranges before tool execution. The maximum is 40 tool
invocations. LongMemEval uses an "online" variant that first chooses documents
with semantic plus lexical relevance greater than `0.2`, then builds a transient
query-conditioned graph only for those documents. The paper does not define the
relevance score scale, encoder, fusion formula, or calibration for that threshold.

The paper uses Claude Sonnet 4.5 for fact extraction, Claude Haiku 4.5 for
entity/property resolution, and several query agents including GPT-5, GPT-4o,
and Claude 4.5. Temperature is zero where supported. LoCoMo reports the mean of
three LLM-judge trials.

### What the results support

The GPT-5 LoCoMo headline is `88.88%` LLM-judge accuracy. In the Claude Haiku
tool ablation, `SchemaViewer + EntityLookup` scores `77.19`, adding GraphSQL gives
`79.45`, and adding Search gives `87.00`. The largest reported gain is therefore
the broad Search tool, not SQL. GraphSQL improves the temporal slice from `72.92`
to `82.29`, but the full tool set lowers it to `79.17`; more tools are not
monotonic.

The system is expensive. The paper reports an average `81,604` tokens per query:
`13,557` amortized graph construction, `7,854` fixed system prompt, `21,745`
retrieved memory, `16,174` agent-loop overhead, and `22,274` tool framing. Most
agents saturate around 20 calls, and the authors identify reducing 20-30 calls to
10-15 as future work.

### Reproducibility and Lore boundary

There is no released code, prompt, validator, model snapshot, Search contract,
or judge configuration. The paper's construction stage creates entities,
properties, events, typed facts, confidence values, valid-time intervals, and
evidence anchors. Those are automatic derived memory and fall outside Lore v1.

A Lore-compatible adaptation would expose bounded typed operations such as
`search_visible_memories`, `read_visible_timeline`, and
`traverse_visible_links`, each of which re-enters the normal Actor/RLS module.
It must not expose model-generated SQL or let a tool broaden the original scope,
time, or metadata filters. This is worth a later 2/4/8-call ablation, but it is
not the next experiment: the paper supplies no reproducible prompt or tool
implementation, and its query cost is far above Lore's local target.

Query-time complexity is approximately `A` serial language-model calls plus the
database work of the selected tools, where `A <= 40`; prompt history also grows
across the loop. The paper's full result cannot be attributed to query-time tools
alone because those tools depend on the automatically constructed graph.

## HiGMem

### Exact released query path

The main reproduction command uses `gpt-4o-mini`, disables profiles and direct
turn links, selects event metadata, and sets `k_event=10`; query rewriting is on
and `k_turn` defaults to 10
([README](https://github.com/ZeroLoss-Lab/HiGMem/blob/f275072f25323a01a8bff3680edbb34ed97d33be/README.md#L100-L132)).
The fixed code does the following:

1. One temperature-zero LLM call rewrites the question into a keyword query
   ([prompt and schema](https://github.com/ZeroLoss-Lab/HiGMem/blob/f275072f25323a01a8bff3680edbb34ed97d33be/run_fphm_evaluation.py#L68-L96)).
2. `all-MiniLM-L6-v2` independently retrieves the top ten turns and top ten
   events
   ([model selection](https://github.com/ZeroLoss-Lab/HiGMem/blob/f275072f25323a01a8bff3680edbb34ed97d33be/fphm_core.py#L91-L104),
   [retrieval](https://github.com/ZeroLoss-Lab/HiGMem/blob/f275072f25323a01a8bff3680edbb34ed97d33be/fphm_core.py#L936-L1009)).
3. For every retrieved event, one LLM call sees its title/metadata and **all of
   that event's turns**, then returns likely answer-bearing turn IDs
   ([selector](https://github.com/ZeroLoss-Lab/HiGMem/blob/f275072f25323a01a8bff3680edbb34ed97d33be/fphm_core.py#L1045-L1092)).
4. Direct-turn and event-predicted candidates are unioned. The main setting does
   not add turn links.
5. A final LLM relevance filter receives candidates in batches of ten and returns
   relevant IDs. The prompt explicitly says to be inclusive and include doubtful
   but potentially useful context
   ([batching](https://github.com/ZeroLoss-Lab/HiGMem/blob/f275072f25323a01a8bff3680edbb34ed97d33be/fphm_core.py#L886-L908),
   [prompt](https://github.com/ZeroLoss-Lab/HiGMem/blob/f275072f25323a01a8bff3680edbb34ed97d33be/prompts.py#L155-L174)).
6. Selected turns are sorted chronologically and sent to the answer model
   ([assembly](https://github.com/ZeroLoss-Lab/HiGMem/blob/f275072f25323a01a8bff3680edbb34ed97d33be/fphm_core.py#L1116-L1142)).

With `k_event=10`, the query path is roughly
`1 + 10 + ceil(C/10) + 1` LLM calls: rewrite, event-local selections, final
filter batches, and answer. The OpenAI path requests JSON Schema and temperature
zero but no output-token cap
([transport](https://github.com/ZeroLoss-Lab/HiGMem/blob/f275072f25323a01a8bff3680edbb34ed97d33be/memory_layer.py#L70-L114)).
Malformed output is salvaged when possible and otherwise converted to an empty
typed result rather than retried as a schema failure
([parser](https://github.com/ZeroLoss-Lab/HiGMem/blob/f275072f25323a01a8bff3680edbb34ed97d33be/fphm_core.py#L148-L234)).

### What the results support

On LoCoMo10, HiGMem reports overall category results rather than a single
aggregate row: multi-hop `.31`, temporal `.34`, open-domain `.15`, single-hop
`.49`, and adversarial `.78`. Its final evidence averages 8.09 turns with
precision `.1909` and recall `.7241`; A-Mem averages 99.84 turns with precision
`.0101` and recall `.7502`.

The most relevant controlled result removes the event hierarchy, retrieves the
top 100 turns, and applies the same LLM selection. This flat baseline obtains
overall token F1 `.46`, average K `22.71`, precision `.065`, and recall `.703`;
full HiGMem obtains `.49`, `8.09`, `.190`, and `.724`. Thus the paper supports
two separate observations:

- joint LLM evidence selection over a broad flat pool is competitive;
- the automatically built event layer contributes additional precision and a
  smaller context.

It does **not** isolate LLM selection against the same top-100 pool without
selection, and therefore does not prove a causal F1 gain for the selector alone.
The full system is also slower than A-Mem: 9.42 versus 5.91 seconds per question.

A supplementary Qwen2.5-3B experiment, with query rewriting disabled, reports
HiGMem `.42` versus A-Mem `.34` on LoCoMo10. A DialSim study reverses the result:
HiGMem `.42` versus A-Mem `.49`. The open-model evidence is encouraging but not
general enough to make a local selector the production default.

### Reproducibility and Lore boundary

The repository pins its listed Python dependencies and is MIT licensed, although
Torch is only an installation comment rather than a complete lock. Its bundled
LoCoMo file is not byte-identical to the upstream release at commit
[`3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376`](https://github.com/snap-research/locomo/tree/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376):
the upstream SHA-256 is
`79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`,
while HiGMem's fixed file is
`cf50e013bb20551cba62f27a93f8310e70422ed31fff6010871031ac9e875993`.
This must be a separate dataset revision, and the upstream
[CC BY-NC 4.0 license](https://github.com/snap-research/locomo/blob/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/LICENSE)
is not replaced by HiGMem's code license. Model artifacts are not pinned by
digest. Candidate union uses Python sets, parallel results use completion order,
the GPT model is a moving alias, and released paper-result traces/checkpoints are
absent.

More importantly, HiGMem's event titles, keywords, tags, fact sheets, and event
membership are created and updated by LLM calls during ingestion. That is
automatic organization/consolidation, outside Lore v1. Lore can reproduce the
flat selector without those artifacts, or route through **explicit** source
session metadata and durable links, but it cannot claim the full HiGMem method
or its hierarchy gains.

For the flat selector, vector search costs the ordinary corpus search, then LLM
filtering uses `ceil(B/10)` calls over `B` candidates. The full hierarchy adds up
to `k_event` event-local calls whose input size is the sum of all turns inside the
retrieved events.

## LiCoMemory and CogniRank

### Paper-backed formula

LiCoMemory first scores a session summary (`S_s`) and an entity-relation triple
inside that session (`S_t`). CogniRank fuses them with a harmonic mean:

```text
S_sem = 2 * S_s * S_t / (S_s + S_t)
```

It then applies a Weibull-shaped time multiplier:

```text
w(delta) = exp(-((delta / median_gap) ^ t_k)),  0 < t_k < 1
R = S_sem * w(delta)
```

`delta` is the absolute time gap from question time to the triple timestamp and
`median_gap` is the median gap among retrieved triples. The paper uses top 15 and
`t_k=0.1`, BGE-M3 embeddings, Llama-3-8B for memory construction, and either
Llama-3.1-70B-Instruct-Turbo or GPT-4o-mini for answering. It reports five runs.

The GPT-4o-mini ablation reports `67.20` LoCoMo / `73.80` LongMemEval with the
harmonic mean versus `58.31` / `61.80` with an arithmetic mean. The temporal
ablation reports whole-benchmark LoCoMo `67.22` with Weibull decay versus `57.05`
without decay; the temporal slice moves `47.92` to `59.38`. These are end-answer
judge scores from the entire graph/summary system. They do not isolate the
formula on raw Memories or establish that unconditional recency helps archival
queries.

### Released-code contradiction

The official fixed code does not implement the paper formula. It computes a
weighted **arithmetic** combination:

```text
S_sem = summary_weight * S_s + similarity_weight * S_t
```

and then applies the Weibull multiplier
([implementation](https://github.com/EverM0re/LiCoMemory/blob/a844d993f77f947f682a0a52ec2825f2950bc0b3/query/triple_reranker.py#L138-L200)).
The checked-in configuration sets `summary_weight=0.2`, `rerank_k=0.1`, and
`enable_CogniRank: False`
([configuration](https://github.com/EverM0re/LiCoMemory/blob/a844d993f77f947f682a0a52ec2825f2950bc0b3/config/Memory.yaml#L56-L74)).
Date parsing accepts only `%Y/%m/%d`; missing or unparsable dates receive gap zero
and therefore no decay
([date handling](https://github.com/EverM0re/LiCoMemory/blob/a844d993f77f947f682a0a52ec2825f2950bc0b3/query/triple_reranker.py#L202-L211)).

The README says `requirements.txt` is included, but the fixed tree has no such
file and no license. The repository therefore cannot reproduce the paper's
published CogniRank equation/default from its checked-in configuration and is
not a code source Lore should copy.

The released query path makes one LLM entity-extraction call before embedding
the question/entities and later makes one answer call
([query pipeline](https://github.com/EverM0re/LiCoMemory/blob/a844d993f77f947f682a0a52ec2825f2950bc0b3/query/query_processor.py#L86-L172),
[entity extraction](https://github.com/EverM0re/LiCoMemory/blob/a844d993f77f947f682a0a52ec2825f2950bc0b3/query/query_processor.py#L290-L308)).
The fixed implementation scans all graph nodes for entity similarity and all
incident candidate edges before sorting rather than using a documented ANN
index
([entity scan](https://github.com/EverM0re/LiCoMemory/blob/a844d993f77f947f682a0a52ec2825f2950bc0b3/query/query_processor.py#L310-L424),
[triple scan](https://github.com/EverM0re/LiCoMemory/blob/a844d993f77f947f682a0a52ec2825f2950bc0b3/query/query_processor.py#L456-L560)).
That makes the released retrieval path `O(V + E)` before its `O(k)` CogniRank
formula and is another material difference from a production indexed system.

### Lore boundary

The score itself is `O(k)` after retrieval and requires no extra model call.
However, `S_s` depends on automatically updated session summaries and `S_t` on
automatically extracted/deduplicated triples. Applying the paper formula to
Lore's first-stage score and Qwen reranker score would be a new Lore heuristic,
not CogniRank.

Lore already has a benchmark-gated recency RRF. A later temporal ablation may
compare that RRF with the exact Weibull multiplier using a canonical source/event
timestamp, but must gate it to temporal or knowledge-update questions. It must
not substitute `memory.updated_at` for event time when those meanings differ.

## MemORAI

### Paper-backed query-time method

MemORAI constructs a heterogeneous graph of segment, turn, entity, and typed
relation nodes/edges. At query time it:

1. retrieves top-k segment nodes by summary embeddings, top-k entity nodes by
   description embeddings, and top-k relation edges by triplet-description
   embeddings;
2. performs one-hop expansion from those seeds to form a query-focused subgraph;
3. runs Dynamic Weighted PageRank (DW-PR) on that subgraph; and
4. returns the highest-ranked turns plus all supporting triplets that cite them.

For a subgraph edge `u -> v`, the paper defines a query-dependent weight. It uses
`cos(q, entity_description)` for entity-turn edges,
`cos(q, relation_description)` for typed entity-relation-entity edges, and the
mean query/entity-description similarity for a turn-segment edge. Every subgraph
node starts with `seed(v)=cos(q,node_description)`, then iterates:

```text
PR_(t+1)(v) = (1 - d) * seed(v) + d * S(v)

S(v) = sum over u->v of
       [w(u->v) / sum over u->* w(u->*)] * PR_t(u)
```

The experiment uses Contriever embeddings, `openai/gpt-oss-20b` at temperature
zero, and top-k three. The paper does not report the damping value, convergence
tolerance, maximum iterations, or a complete released prompt/configuration, and
there is no official code artifact.

### What the ablations support

Replacing uniform weights with dynamic weights improves turn Recall@10 from
`62.01` to `64.68` on LoCoMo and `89.75` to `91.63` on LongMemEval-S. Restricting
PageRank to the query-focused subgraph rather than the whole graph improves
LoCoMo turn Recall@10 from `51.77` to `64.68` and reduces reported PageRank time
from 14.19 to 12.44 ms. The corresponding LongMemEval-S values are `88.91` to
`91.63` and 18.34 to 14.21 ms. These milliseconds measure the graph-ranking
kernel, not embedding, graph construction, retrieval, or answer generation.

The dominant dependency is outside Lore v1: removing automatic topic
segmentation collapses LoCoMo turn Recall@10 from `64.68` to `27.61` and
LongMemEval-S from `91.63` to `23.86`. MemORAI also automatically filters memory,
summarizes segments, extracts entities/relations, and builds the provenance graph.
The paper's headline result cannot be attributed to DW-PR alone.

### Lore boundary

DW-PR over an already authorized, explicit Memory-link subgraph is portable, but
it would be a Lore adaptation because Lore nodes/links are not MemORAI's
segment/turn/entity/relation schema. The safe form must:

- seed only from the normal RLS-filtered search;
- include only durable `memory_links` whose two endpoints are visible and still
  satisfy the original scope, time, and metadata filters;
- exclude visualization-only derived affinity edges;
- cap degree, nodes, edges, and iterations; and
- rerank only the resulting authorized passages.

For a bounded subgraph, search dominates setup and PageRank costs
`O(I * (V_sub + E_sub))` for `I` iterations. This is a valuable second experiment
on suites with real explicit links, but external LoCoMo/LongMemEval imports do
not provide such links. Automatically inventing them merely to make the
benchmark work would reintroduce the construction method that v1 excludes.

## Mnemis

### Paper-backed dual route

Mnemis is the strongest candidate here by reported headline score with released
code and result artifacts, but the released implementation is partial.

System-1 separately searches Episodes, Entities, and Edges with both cosine
embedding search and BM25, then reciprocal-rank fuses each type and truncates
each type independently. The paper describes a sum of reciprocal ranks but does
not report an offset constant. The main context budget is ten Episodes, twenty
Entities/Categories, and twenty Edges.

System-2 is a top-down traversal of an automatically constructed category
hierarchy. At each layer, one LLM call sees all candidate category names/tags and
selects every potentially relevant category. It may mark a category
`get_all_children=true` as an early-stop shortcut. At the bottom, the system
retrieves all directly linked episodes, edges, and entities. There is no strict
top-k during hierarchy traversal.

The released code validates selected names/UUIDs against the input category set
([selection](https://github.com/microsoft/Mnemis/blob/4552fed19bc0cde7b990a6ceb0365cd75b1b3453/global_selection/global_selector.py#L224-L265)),
walks layers and shortcuts descendants
([traversal](https://github.com/microsoft/Mnemis/blob/4552fed19bc0cde7b990a6ceb0365cd75b1b3453/global_selection/global_selector.py#L267-L319)),
and includes `group_id` in every released graph query
([queries](https://github.com/microsoft/Mnemis/blob/4552fed19bc0cde7b990a6ceb0365cd75b1b3453/global_selection/global_selector.py#L30-L83)).
The prompt is inclusive and asks for all possibly useful nodes
([prompt](https://github.com/microsoft/Mnemis/blob/4552fed19bc0cde7b990a6ceb0365cd75b1b3453/global_selection/prompts.py#L1-L23)).

After both routes, Episodes, Entities, and Edges are separately reranked. The
paper uses Qwen3-Embedding 0.6B at 128 dimensions, Qwen3-Reranker 8B, Neo4j, and
GPT-4.1-mini for answering and judging.

### What the ablations support

On LoCoMo, System-1 RAG scores `73.8`, System-1 Graph `81.6`, their union `89.1`,
and replacing RRF with Qwen3-Reranker-8B still scores `89.1`. System-2 alone
scores `87.7`; combining both routes scores `93.3`. Qwen3-Reranker-0.6B scores
`92.6`, BGE-Reranker-V2-M3 `92.7`, and Qwen3-Reranker-8B `93.3` in the combined
system. The paper therefore supports **complementary candidate routes** more
strongly than simply scaling the reranker.

The headline `93.9` uses a larger `k=30` setting and excludes all 460 adversarial
LoCoMo questions. The fixed artifact reports `accuracy_exculde_category5` as
`.9390`; the all-category field is `.8061`
([artifact](https://github.com/microsoft/Mnemis/blob/4552fed19bc0cde7b990a6ceb0365cd75b1b3453/results/locomo/metrics_graphiti_gpt-41-mini-shortco-2025-04-14-Bing_gpt-41-mini-shortco-2025-04-14-Bing_ragtopk30_gtopk60_RAG_GRAPH.json)).
The LongMemEval-S artifact reports 458/500, or `.916`, under its recorded model
alias and retrieval configuration
([artifact](https://github.com/microsoft/Mnemis/blob/4552fed19bc0cde7b990a6ceb0365cd75b1b3453/results/lme-s/metrics_graphiti_gpt-41-mini-shortco-2025-04-14-Bing_gpt-41-mini-shortco-2025-04-14-Bing_ragtopk10_gtopk20_RAG_GRAPH.json)).

### Reproducibility and Lore boundary

The repository states that it is based on Graphiti and releases generated result
contexts plus the Global Selection component, not the complete ingestion,
System-1, reranking, answering, or evaluation harness
([README](https://github.com/microsoft/Mnemis/blob/4552fed19bc0cde7b990a6ceb0365cd75b1b3453/README.md#L63-L66)).
It does not pin a Graphiti commit or provide a dependency lock. The model alias,
decoder controls, prompt hashes, and complete hierarchy-construction code are
not sufficient for end-to-end reproduction.

The category hierarchy and base knowledge graph are automatically extracted and
organized during ingestion, which is outside Lore v1. Global Selection costs one
LLM call per hierarchy layer plus descendant and one-hop graph queries; prompt
size can grow with every category at a layer because no top-k is enforced.

A Lore version may traverse operator/user-supplied categories, imported source
hierarchies, or durable Memory Links. It may not synthesize the hierarchy during
ordinary writes and then present the resulting gain as query-time-only. Mnemis
also shows why a larger reranker is not the immediate priority: 0.6B is within
`0.7` points of 8B under its own combined protocol, while the complementary route
adds `4.2` points over System-1 alone.

## Recommended ablation: `durable-link-recall-v1`

This is a bounded second candidate-recall arm between Lore's ordinary hybrid
search and its existing Qwen3 reranker. It adds no provider call and requires no
new resident model. Lore already stores link direction, kind, weight, metadata,
and both Memory endpoints, and its RLS policy requires both endpoints to be
visible
([module](https://github.com/corespeed-io/lore/blob/e26fd90c7f9e0b4ec5423f8b78d63dbec0d6778c/src/lib/graph.ts#L27-L45),
[RLS policy](https://github.com/corespeed-io/lore/blob/e26fd90c7f9e0b4ec5423f8b78d63dbec0d6778c/db/migrations/0001_initial.sql#L811-L826)).

### Exact proposed algorithm

Let `B=20` be the unchanged reranker candidate budget, `S=20` the hybrid seed
budget, `D` the maximum links read per seed, and `rho=0.20` the fraction of the
reranker pool reserved for novel linked endpoints.

1. Run Lore's unchanged hybrid candidate retrieval under the Actor transaction,
   active Workspace, RLS, scope, time range, and metadata filter. Retain the
   ordered top `S` Memories as seeds.
2. In the same Actor/RLS transaction, make one set-oriented query over durable
   `memory_links` in **both** directions. A row is eligible only when one endpoint
   is a seed and the other endpoint is a visible Memory in the same Workspace.
   Join the neighbor Memory before limiting and reapply the original `scope`,
   `updatedAfter`, exclusive `updatedBefore`, and `metadataFilter` predicates to
   that endpoint. The link table's visibility policy is necessary but does not
   replace these request filters.
3. Exclude self-links, already retained candidates, and every derived affinity
   used only by the graph visualization. For each seed, order eligible durable
   links by `weight DESC`, then neighbor `updated_at DESC`, then link and neighbor
   IDs; keep at most `D`. Sweep `D in {8,16,32}`.
4. Give every novel neighbor `v` a deterministic structural score based on its
   strongest visible seed path:

   ```text
   g(v) = max over linked seed u of
          link_weight(u,v) / (60 + rank_hybrid(u))
   ```

   Break equal `g` values by newer neighbor `updated_at`, then neighbor ID. Link
   `kind` and metadata are provenance only in v1; do not add a query-similarity
   model or hand-tuned kind weight to this first ablation.
5. Keep the leading `B - floor(rho * B) = 16` ordinary hybrid candidates. Fill
   at most the trailing four slots with novel neighbors in `g` order, then use
   further ordinary candidates if fewer than four eligible neighbors exist. If
   no links qualify, the candidate list must be byte-for-byte/order-equivalent to
   the baseline.
6. Build the ordinary compact authorized evidence passage for every candidate,
   preserving Memory/chunk boundaries. Send the fixed 20-candidate union to the
   unchanged Qwen3 0.6B reranker and unchanged reader. The reranker may reorder
   the union; link weight is a recall-arm signal, not a substitute reranker score.
7. Record for each added candidate the seed, link ID, direction, kind, weight,
   structural rank, and whether it survived into final evidence. Do not expose
   hidden endpoint IDs, counts, or degree, even in benchmark traces.

This differs from Mnemis and MemORAI in three explicit ways: it does not create a
category/entity graph, does not run PageRank, and does not embed relation
descriptions. It is a Lore adaptation whose only paper-backed claim is that a
bounded structural route is worth isolating after similarity reranking. Neither
paper's score can be attributed to this simpler algorithm.

### Complexity and privacy

The set-oriented link query reads at most `S * D` eligible edges before global
deduplication. Candidate scoring is `O(SD)`, or `O(G log G)` to sort `G` unique
neighbors, and only four enter the fixed reranker pool. With `S=20` and `D=32`,
the logical bound is 640 edges, one database round trip, zero additional
provider calls, and no additional model memory.

The implementation must execute through the native Memory/Graph data module,
not route-level SQL. RLS must authorize the seed, link row, and neighbor together;
the ordinary request filters must be applied before per-seed/global top-k. The
stage writes nothing and creates no summaries, entities, links, or derived graph,
so it does not implement AutoDream or cross-tenant state.

### Recommended ablation order and gates

Run the same indexed corpus, reranker, and reader for every row:

1. current hybrid + Qwen3 0.6B reranker;
2. the same pipeline plus durable-link recall at `D=8`;
3. repeat at `D=16` and `D=32` without changing `B=20` or `rho=0.20`.

External LoCoMo, LongMemEval, and MemoryAgentBench data do not supply Lore
durable Memory Links. On those imports this ablation must report
`linkCoverage=0` and remain neutral. Do not create links from benchmark answers,
gold evidence, entity overlap, embeddings, or LLM extraction: that would leak
labels or silently reintroduce the write-time graph construction excluded from
v1. The first informative suite must therefore contain **pre-existing explicit
links**: an isolated synthetic multi-hop/conflict fixture and, separately,
non-label-derived imported/user links with auditable provenance.

Record exact answer quality, exact answer-evidence Recall@1/Recall@K/MRR/nDCG,
candidate and final-evidence link coverage, no-answer accuracy and false results,
RLS tripwires, p50/p95 database/rerank/end-to-end latency, edge rows read,
neighbors deduplicated, and model/prompt/evidence-policy revisions. Reject the
stage on any leak, filter escape, hidden-degree disclosure, no-answer regression,
or if gains disappear once cases without links are included in the same report.

## Deferred ideas, in order

1. **Joint 4B evidence scoring.** Apply one local temperature-zero setwise call
   to the already authorized top 20 passages, require one finite `[0,1]` score
   for every opaque ID, validate the exact ID set, and rank-fuse it with Qwen3.
   This is the no-hierarchy HiGMem-inspired experiment. It is second because the
   paper does not isolate selector gain and it adds reader latency without adding
   a missing candidate.
2. **Temporal-intent Weibull scoring.** Compare LiCoMemory's exact multiplier to
   Lore's current recency RRF only on conflict/knowledge-update questions with
   canonical event time. Keep both off for timeless and archival queries.
3. **Natural-boundary hierarchy.** Use source sessions, imported topics, explicit
   references, or operator metadata as HiG-style coarse anchors. Do not generate
   summaries or event membership automatically.
4. **Bounded typed query tools.** Test APEX-inspired search/timeline/link tools at
   2/4/8 calls, always through the native RLS modules. Do not expose raw SQL.

The common finding across these papers is not that one graph algorithm or one
large reranker wins universally. Strong results come from **candidate-route
complementarity and evidence-set reasoning**. Lore should test those signals at
query time while leaving memory ownership, RLS, and v1's no-consolidation boundary
unchanged.
