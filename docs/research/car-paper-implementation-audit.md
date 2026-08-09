# CAR paper and implementation audit

Audited 2026-08-07. Primary sources only: Reddy and Challaram, *Reliable
Post-Retrieval Assembly for Agent Memory: Separating Evidence Extraction from
Policy Execution*, arXiv:2606.01435 [v2, 2026-08-02](https://arxiv.org/abs/2606.01435v2)
([HTML](https://arxiv.org/html/2606.01435v2)); the authors' official companion
repository at commit
[`7d319f460b0ee0945d7de05d06c34681dceca46a`](https://github.com/cvikasreddy/memory-conflict-resolution/tree/7d319f460b0ee0945d7de05d06c34681dceca46a)
(`Align companion repo with the published paper`, 2026-08-03); and, only for
the score definition, the official MemoryAgentBench repository at
[`455306dcabc3842526eb83cd4e225e5d486c5c5d`](https://github.com/HUST-AI-HYZ/MemoryAgentBench/tree/455306dcabc3842526eb83cd4e225e5d486c5c5d).
No later claims, forks, or third-party summaries are used.

## What CAR actually is

The paper's contribution is an answer-time interface, not a new memory store or
retriever. It factors a direct reader into `K = E(q, R)`, where an LLM turns
retrieved text into a candidate set, followed by `y = A_pi(K)`, where a separate
operator applies a known policy. In the evaluated FactConsolidation task that
policy is exactly `argmax(candidate.serial)`
([paper section 3](https://arxiv.org/html/2606.01435v2#S3)). The official README
gives the same three-stage interpretation and explicitly says that the main
gain is structured candidate identification, not merely replacing an LLM with
`max()`
([README lines 11–42](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/README.md#L11-L42)).

For a single hop, SH-Conflict is:

1. Parse one numbered fact per corpus item, tokenize with lowercased
   `[A-Za-z0-9]+`, and retrieve BM25 top 10. The code ranks all corpus facts and
   returns `{rank, fact_idx, score, text}`
   ([retrieval lines 60–130](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/scripts/_pipeline.py#L60-L130));
   `rank_bm25.BM25Okapi` uses the paper's `k1=1.5`, `b=0.75` defaults.
2. Ask the same backbone at temperature 0 for **every** retrieved fact whose
   subject and predicate match the question. The requested record is
   `{serial, fact_text, answer_entity}`; the extractor must not compare serials
   or choose a winner. The released prompt is stricter than the paper's phrase
   “semantically matching”: it requires the predicate noun to be the same and
   a named subject to occur verbatim
   ([prompt lines 296–314](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/scripts/_pipeline.py#L296-L314)).
3. Return no answer for an empty set; otherwise deterministically return the
   `answer_entity` attached to the largest model-returned serial
   ([picker lines 366–389](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/scripts/_pipeline.py#L366-L389)).

CAR adds an LLM decomposition before that primitive. The prompt demands an
inside-out chain, at most one listed relationship word per hop, and
`{hop_N_answer}` placeholders; its requested JSON shape includes integer hop ids
([decomposition prompt lines 208–255](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/scripts/_pipeline.py#L208-L255)).
For each resolved hop the implementation performs a **fresh BM25 retrieval**, a
fresh candidate extraction, and `max(serial)`; its answer is substituted into
dependent later queries
([hop execution lines 469–485](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/scripts/_pipeline.py#L469-L485)).
Thus a multi-hop answer is assembled as a chain of current-value lookups, not by
selecting one global top-10 list or asking the reader to reason over the whole
chain at once.

The paper pseudocode breaks on an unresolved placeholder or an empty hop and
returns the last valid intermediate answer
([section 3](https://arxiv.org/html/2606.01435v2#S3)). The fixed repository is
slightly different: it records a failed dependent hop as skipped, continues to
any later hop, and finally returns the last non-empty answer in the entire trace
([CAR loop lines 518–558](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/scripts/_pipeline.py#L518-L558)).
That difference is normally hidden by a valid linear plan but matters for a
malformed or branching plan. A released record demonstrates the resulting
failure mode: a four-hop question executes two hops and returns the intermediate
`F. Scott Fitzgerald` instead of failing closed
([artifact lines 39–50](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/poc_results/ablation_mh_fact_gpt4omini_factconsolidation_mh_262k.json#L39-L50)).

## Exact evaluated contract

- Dataset: MemoryAgentBench v3 FactConsolidation SH/MH, 100 questions in each
  of 6K, 32K, 64K, and 262K. Facts are MQUAKE-derived rewrites and a larger
  integer serial means newer
  ([paper section 4](https://arxiv.org/html/2606.01435v2#S4)).
- Retrieval: fact-level BM25 top 10, regex tokenizer, `k1=1.5`, `b=0.75`.
  The separate chunk ablation is described as sliding 4,096 characters in the
  paper, but the released function uses adjacent non-overlapping 4,096-character
  slices
  ([lines 58–64](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/scripts/14_ablations.py#L58-L64)).
- Models: paper Table 6 pins `gpt-4o-mini-2024-07-18`,
  `gpt-4o-2024-08-06`, and `o4-mini`; structured temperature is 0 and maximum
  output is 256
  ([Appendix A](https://arxiv.org/html/2606.01435v2#A1)). The repository instead
  defaults to the moving alias `gpt-4o-mini`
  ([lines 21–27](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/scripts/_pipeline.py#L21-L27))
  and none of its chat calls supplies a maximum-output parameter; dependency
  versions are lower bounds rather than a lock
  ([requirements lines 1–5](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/requirements.txt#L1-L5)).
- Metric: normalized substring exact match. The official benchmark lowercases,
  removes punctuation and articles, normalizes whitespace, then checks whether
  a reference is a prediction substring
  ([normalization lines 32–48](https://github.com/HUST-AI-HYZ/MemoryAgentBench/blob/455306dcabc3842526eb83cd4e225e5d486c5c5d/utils/eval_other_utils.py#L32-L48),
  [substring check lines 105–116](https://github.com/HUST-AI-HYZ/MemoryAgentBench/blob/455306dcabc3842526eb83cd4e225e5d486c5c5d/utils/eval_other_utils.py#L105-L116)).
  The companion repo's helper only lowercases and checks a substring
  ([lines 133–147](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/scripts/_pipeline.py#L133-L147)).
- The runner loads the Hugging Face dataset at mutable `revision="main"`, not a
  content commit
  ([lines 114–124](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/scripts/13_paper_experiment.py#L114-L124)).
  Lore's manifest pin is therefore a reproducibility improvement, not part of
  CAR.

The supported result is narrow. At 262K, SH-Conflict scores 82% with
gpt-4o-mini and 93% with gpt-4o; CAR scores 27% and 41%, respectively. The
single-hop structured/direct difference is a whole-pipeline comparison because
prompt, task, format, temperature, and executor all change. Holding extraction
and temperature approximately fixed, deterministic versus LLM policy execution
adds only 2.0 percentage points on average and 0 at 262K
([paper sections 5.1–5.3](https://arxiv.org/html/2606.01435v2#S5)). CAR averages
2.56 planned hops, observes at most six, executes 86%, and most failures start
with a bad first hop and cascade
([section 5.6](https://arxiv.org/html/2606.01435v2#S5.SS6)). “Six” is an observed
maximum, not a paper-specified safety cap.

The method is not demonstrated for historical, partially ordered, causal,
aggregation, or general temporal questions. Its LongMemEval check is a null
result (26/45 structured versus 29/45 direct, exact McNemar `p=0.45`), including
failures where the required operator is yes/no synthesis, second-newest, or
temporal aggregation
([section 5.7](https://arxiv.org/html/2606.01435v2#S5.SS7),
[limitations](https://arxiv.org/html/2606.01435v2#S6)). It is a task-specific
answer-time method, not evidence for automatic memory consolidation.

## Validation and retry audit

The primary implementation has no semantic retry, parse repair, candidate
source validation, or decomposition validator:

- Decomposition makes one JSON-object request and immediately indexes
  `json.loads(raw)["hops"]`; ids, dependency order, relationship count, cycles,
  and output shape are not checked
  ([lines 258–276](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/scripts/_pipeline.py#L258-L276)).
- Extraction makes one JSON-object request with no system message. A JSON decode
  error becomes `[]`; valid JSON is not checked for field types, membership in
  the retrieved pool, copied fact text, duplicate serials, or grounded answer
  spans
  ([lines 327–363](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/scripts/_pipeline.py#L327-L363)).
- Outer runners catch an exception, mark the question wrong, and continue; they
  do not retry
  ([lines 180–211](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/scripts/14_ablations.py#L180-L211)).
- The paper's direct-reader fallback after an empty extraction is only an
  ablation and was effectively a wash (+0.2 pp), not the CAR protocol
  ([section 5.5](https://arxiv.org/html/2606.01435v2#S5.SS5)).

The release also cannot fully support all trace-level claims without rerunning.
Its README says several reported cells remain pending and older FactConsolidation
JSON omits candidate lists and retrieved serials
([lines 151–179](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/README.md#L151-L179)).
Moreover, the current multi-hop writer drops the `decomposition` and per-hop
`trace` returned by `run_car_v2`, retaining only hop counts in each result
([lines 188–211](https://github.com/cvikasreddy/memory-conflict-resolution/blob/7d319f460b0ee0945d7de05d06c34681dceca46a/scripts/14_ablations.py#L188-L211)).
This conflicts with Appendix E's statement that per-question traces are
available for every reported cell
([Appendix E](https://arxiv.org/html/2606.01435v2#A5)).

## Why a 4B reader can emit an empty candidate set despite a matching top-10 fact

The paper did not evaluate a local 4B reader, so the following is a source-based
failure analysis, not a paper result.

1. **The extraction boundary can fail independently of retrieval.** This is the
   paper's central premise. Its qualitative pilot attributes about 10% of sampled
   SH errors to conservative empty extraction and another 25% to a predicate
   semantic gap
   ([Appendix D](https://arxiv.org/html/2606.01435v2#A4)). A smaller model can
   over-obey the released prompt's verbatim-subject and same-predicate-noun rules.
   Thus “married to” may be rejected for a question phrased with “spouse,” or a
   correct fact may be rejected when the decomposer produced an unnatural or
   underspecified hop.
2. **Transport-valid JSON is weaker than a valid candidate.** A reader may emit
   string serials, copy a visible list position rather than the source serial,
   include the serial prefix inside `fact_text`, paraphrase the fact, or leave
   `answer_entity` empty. The paper code trusts those fields; a secure Lore
   adapter correctly rejects them, which turns an apparently non-empty model
   response into zero validated candidates.
3. **Broad bad hops can exhaust the output budget.** An underspecified query such
   as “Who is the author?” makes many of the ten facts match. Copying every fact
   plus entity can truncate JSON. This is especially plausible under a bounded
   local reader, while the released source neither pins its claimed 256-token cap
   nor distinguishes truncation from a semantic empty.
4. **A parent Memory hit is not necessarily usable fact evidence.** Lore first
   returns authorized Memory evidence and then parses numbered fact lines. A
   relevant Memory can lose the exact subject, predicate, serial, or answer span
   through evidence truncation/chunk selection. CAR also retrieves again for each
   resolved hop, so final-answer presence in the original question's top 10 says
   nothing about first-hop fact recall.
5. **CAR compounds errors.** A wrong decomposition changes the retrieval query;
   one wrong selected entity changes every dependent query; and one empty hop
   aborts the chain. The paper directly observes this cascade and leaves FC-MH
   far from solved even with larger proprietary readers.

The diagnostic implication is important: log four different states—retrieved
answer-bearing fact, raw model output, schema/grounding-valid candidate, and
policy-selected candidate. Reporting all of them as “retrieval miss” or all as
“empty extraction” hides the failure boundary CAR was designed to expose.

## Lore mapping: paper-backed versus adaptation

Lore's current benchmark helper preserves the paper-backed core: fact-level
top-10 BM25 compaction, an LLM-created candidate representation, deterministic
maximum serial, inside-out placeholders, and a fresh search/extract/select cycle
per hop. Everything below is a Lore adaptation and must be reported as such:

- Lore first performs the ordinary hybrid/reranked search under Actor, Workspace,
  scope, time, metadata, and RLS constraints, then parses only those returned
  passages into facts. The paper uses one global in-memory BM25 corpus and has no
  tenancy model.
- Lore's compact BM25 pool is a second stage over already-authorized evidence,
  with deterministic newer-serial tie-breaking; this is not the paper's single
  global BM25 retrieval.
- Lore requests native JSON Schema where its reader transport supports it,
  validates decomposition ids and backward-only placeholders, and caps the plan
  at six. The paper has none of these validators and its six hops is observational.
- Lore validates copied fact text against authorized source facts, derives the
  authoritative serial from that source instead of trusting the model, requires
  a non-empty answer entity grounded as a source-text substring, and rejects
  unsupported candidates. These are security and small-model robustness
  adaptations, not tested CAR components.
- Lore aborts a failed chain and returns `UNKNOWN` unless every declared hop
  completes. That is safer than returning an intermediate answer and differs
  from both the paper pseudocode's `last_valid` return and the fixed repo's
  continue/last-nonempty behavior.
- Lore retains raw decomposition, validated plan, per-hop authorized evidence
  ids, candidate pools, raw extraction, selected candidates, extra search
  latency, and provider usage. This closes gaps in the released artifacts.

None of this should enter Lore's production Memory write path. It is a
benchmark-only, query-time evaluator for explicitly versioned current-value
questions; it creates no memories, summaries, links, merges, or consolidation.

## Portable fixes and recommended ablation order

All candidate facts must already be RLS-visible, and every CAR hop must repeat
the same Actor/Workspace/scope/time/metadata authorization before top-k. Prior
answers may refine a query but must never broaden access. Within that boundary,
run these ablations in order:

1. **Instrumentation only.** Record per hop: authorized source facts, compact
   pool, literal-answer fact recall, raw output, finish reason, parse validity,
   rejection reason (`shape`, `id`, `fact_text`, `answer_span`), validated
   candidates, selected serial, latency, and tokens. Report extraction
   recall/precision conditional on fact recall, invalid-output rate, empty rate,
   per-hop survival, final SubEM, and RLS tripwires.
2. **Stable local evidence ids.** Give each of the at most ten facts a short
   prompt-local id and ask the model for `{evidence_id, answer_span}`. Map ids to
   source fact text/serial server-side and require `answer_span` to be an exact
   source substring. Do not ask a 4B model to reproduce long fact text or serials.
   This is the smallest robust fix, but it is a Lore adaptation and needs a new
   protocol revision.
3. **One repair attempt for mechanical failure only.** Retry once on malformed,
   truncated, or schema-invalid output with the validation error and the same
   authorized pool; never retry an accepted semantic `[]` as though it were a
   transport error. Pin retry count and include both calls in cost/latency.
4. **Strict versus grounded-semantic extraction.** Compare the paper's verbatim
   subject/same-noun rule with relation-equivalent matching while retaining exact
   evidence-id and answer-span grounding. Measure no-answer precision as well as
   candidate recall; do not silently loosen the production default.
5. **Empty semantic fallback.** Only after the above, compare: abstain; a simpler
   per-fact binary classifier; and direct answering over the same top 10. The
   paper's direct fallback was a wash, so no fallback should be promoted without
   local gains and unchanged isolation.
6. **CAR after SH is healthy.** Gate CAR to explicit multi-hop current-value
   cases; validate a linear, backward-referencing plan with an explicit final hop;
   cap depth; abort on failure; and compare against a direct reader. Do not add
   recursive retrieval or more hops merely to rescue benchmark-specific chains.
7. **Question-type policy gate last.** `max(serial)` is valid only for an explicit
   latest/current-value question. Historical, aggregation, yes/no, partial-order,
   and no-answer cases require a different declared operator or abstention. This
   avoids overfitting all temporal memory to FactConsolidation's synthetic rule.

The first decision gate should be SH extraction conditional on verified top-10
fact recall. If a 4B reader cannot reliably cross that boundary, deeper CAR,
query expansion, reranking, or larger retrieval pools only add cost and failure
surface; they do not repair assembly.
