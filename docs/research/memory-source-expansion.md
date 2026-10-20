# Memory hits and raw sources: LongMemEval-S

Measured 2026-10-13 on `codex/episode-evidence-search`, based on commit
`f0245a579f22d305af0b84d9afade5dc291f7d1a` with the local Episode-search changes.
This is a fixed retrieval/reader experiment, not a deployed agent workflow. It
follows the [dual retrieval baseline](memory-episode-dual-retrieval-baseline.md).

## Result

Raw text helps once it actually reaches the reader, and the best use combines a
Memory hit's own source with independent dense raw search. On all 500 questions:

- **Combined, with dense** (`combined-hybrid`): **84.4% → 91.8%**, +7.4 points,
  47 wins and 10 losses, exact McNemar p < 10⁻⁶, paired bootstrap 95% interval
  **[+4.6, +10.2]**. Half of the raw budget goes to whole sessions of the Memory
  hits, the rest to raw hybrid excerpts from other sessions. Reader input is
  2.50× Memory alone.
- Each part alone gives about five points: whole Memory-hit sessions
  (`source-session`, 89.6%, +5.2) and independent raw hybrid search
  (`raw-hybrid`, 89.4%, +5.0). They fix different questions: 22–21 head to head.
- **Dense helps on top of the link, but the evidence is moderate.** The same
  combination with keyword-only raw search (`combined-keywords`) scores 448. The
  dense version wins 16–5 head to head (p = 0.027), the planned deciding
  comparison. Under an independent second judgment it wins 16–8 (457 against
  449, p = 0.15): the same direction, but not significant.
- **Reading a hit's source only when Memory declines** keeps `source-session` at
  439 (+3.4 points) for 1.37× Memory's input. It needs no raw index and 1.2×
  Memory's storage ([gating](#reading-raw-text-only-when-memory-declines),
  [storage](#cost)).

The earlier parallel lexical arm replicates its small effect: +0.6 points here,
+0.8 in the baseline. That arm failed because the raw channel found text for only
85 of 500 questions, not because raw text lacks value.

The two combined arms are a follow-up, designed after the first nine arms were
answered, with the 50/50 budget split fixed before any combined answer was read.
The keyword-against-dense comparison inside the combination was decided in
advance; comparisons across all eleven arms are exploratory.

| Arm | Correct | Accuracy | Δ points | Wins / losses | McNemar p | 95% interval | Input tokens | Evidence turns delivered |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `memory` | 422 | 84.4% | — | — | — | — | 2,469 | 0.2% |
| `dual-lexical` | 425 | 85.0% | +0.6 | 3 / 0 | 0.250 | [+0.0, +1.4] | 2,550 | 5.5% |
| `source-question` | 426 | 85.2% | +0.8 | 4 / 0 | 0.125 | [+0.2, +1.6] | 2,538 | 5.5% |
| `source-keywords` | 435 | 87.0% | +2.6 | 23 / 10 | 0.035 | [+0.4, +4.8] | 4,701 | 39.9% |
| `source-keywords-neighbors` | 440 | 88.0% | +3.6 | 27 / 9 | 0.004 | [+1.4, +6.0] | 5,986 | 52.5% |
| `source-session` | **448** | **89.6%** | **+5.2** | 32 / 6 | <0.0001 | [+3.0, +7.6] | 6,041 | 70.8% |
| `raw-keywords` | 440 | 88.0% | +3.6 | 26 / 8 | 0.003 | [+1.4, +6.0] | 5,265 | 38.8% |
| `raw-hybrid` | **447** | **89.4%** | **+5.0** | 34 / 9 | 0.0002 | [+2.6, +7.6] | 4,857 | 54.5% |
| `source-hybrid` | 442 | 88.4% | +4.0 | 30 / 10 | 0.002 | [+1.6, +6.4] | 4,418 | 54.6% |
| `combined-keywords` | 448 | 89.6% | +5.2 | 38 / 12 | 0.0003 | [+2.6, +8.0] | 6,213 | 65.3% |
| `combined-hybrid` | **459** | **91.8%** | **+7.4** | 47 / 10 | <10⁻⁶ | [+4.6, +10.2] | 6,179 | 76.1% |

Wins and losses are paired against `memory` under the same reader and judge.
"Input tokens" is the reader's own mean count. "Evidence turns delivered" is an
offline proxy: the share of LongMemEval `has_answer` turns, over 470 answerable
questions, of which at least half reaches the rendered reader input verbatim.
Extracted facts paraphrase turns, so the proxy reads near zero for `memory`.

## Arms

Every arm uses the same ten Memory excerpts: the frozen top 10 that the baseline
retrieved, replayed verbatim from its saved packets. No arm re-runs Memory search,
so Memory evidence is identical across arms. Raw text is added only inside the
baseline's 24,000-UTF-16-unit reader cap, and Memory excerpts are never cut. The
runner checks this for every arm (`requireMemoryInsideCap`). Re-rendered from the
saved packets, all 5,000 Memory excerpts of every arm reach the reader whole, and
every answer's input hash matches its packet. One `raw-hybrid` packet crosses the
cap and loses raw text at its tail.

- `dual-lexical`: the baseline's own dual packet. Independent raw lexical search
  with the original question; Memory and raw ranks alternate.
- `source-*`: raw text only from the sessions the Memory hits came from. Each
  hit's raw block sits right after the hit, in Memory rank order, until the cap.
  `source-question` uses the existing `sourceKeys` search with the original
  question. `source-keywords` uses the keyword rewrite below.
  `source-keywords-neighbors` adds one neighbor chunk on each side of the anchor.
  `source-hybrid` uses the original question with lexical and dense channels.
  `source-session` reads the whole session Observation and attaches it, trimming
  the last one that crosses the cap. On average 1.75 sessions fit.
- `raw-keywords` and `raw-hybrid`: independent raw search over the whole haystack,
  alternated with Memory like `dual-lexical`. `raw-hybrid` adds the dense channel
  to the original-question lexical channels.
- `combined-*`: half of what Memory leaves of the cap goes to whole Memory-hit
  sessions, attached as in `source-session`. The rest, plus anything the sessions
  leave unused, goes to `raw-keywords` or `raw-hybrid` excerpts from sessions not
  already attached, appended in raw rank order.

The keyword rewrite keeps the question's distinct terms (the Memory relaxed
channel's term rule), drops PostgreSQL `english.stop` words, and joins the rest
with the `websearch_to_tsquery` OR. A chunk then needs any term, not every term.

### The source mapping is a benchmark convenience

A fact Memory's metadata names the session it was extracted from. The source arms
use that key to find the raw Observation. **When this ran, production Memories had
no such link.** Schema revision 14 adds it as Memory Observation Evidence: direct
citations, and Proposal acceptance copying `evidenceObservationIds`. This
experiment still used the benchmark key, so it measures the strategy, not that path.

## Why raw text helps here

Memory already finds the right sessions. Among the 79 baseline Memory failures,
70 had every gold session in the Memory top 10. The facts lost the detail, or one
1,200-code-point excerpt did not carry it. Source arms add no new gold session by
construction, so all their wins come from **more detail inside a source Memory
already found**.

Independent raw search adds a few new sources too. `raw-hybrid` had 5 wins whose
gold session was missing from the Memory top 10; `raw-keywords` had 3. The rest of
their wins are also detail inside sources Memory had found.

Where the gains land (accuracy, %):

| Arm | User | Assistant | Preference | Multi-session | Temporal | Knowledge update | Abstention |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `memory` | 95.3 | 75.0 | 53.3 | 76.0 | 90.6 | 91.7 | 100.0 |
| `source-session` | 95.3 | **96.4** | 63.3 | 81.8 | 92.1 | 97.2 | 93.3 |
| `raw-hybrid` | 96.9 | 91.1 | 63.3 | 81.0 | 92.1 | 97.2 | **100.0** |
| `combined-hybrid` | 96.9 | **98.2** | **73.3** | **86.0** | **94.5** | 95.8 | 90.0 |

Question counts: 64 user, 56 assistant, 30 preference, 121 multi-session,
127 temporal, 72 knowledge update, 30 abstention. Assistant-side questions gain
most: the facts dropped what the assistant said (a song's chord progression, a
shop name, a shift-rota entry). `source-session` moves them from 42 to 54 of 56.

### Depth beats breadth inside the cap

With about the same input size, whole sessions of the top one or two hits
(`source-session`, 6,041 tokens) beat three-chunk windows over five or six hits
(`source-keywords-neighbors`, 5,986 tokens): 448 against 440. Choosing the anchor
chunk with dense search instead of keywords helps a little at fewer tokens
(`source-hybrid` 442 at 4,418 against `source-keywords` 435 at 4,701).

### What did not work

`source-question` scopes the existing search to the right sources but keeps the
original question. `websearch_to_tsquery` then asks one chunk for every content
word, and only 85 questions get any raw text, exactly as in the parallel arm.
Source scoping alone is not expansion.

## Regressions

Raw text can also mislead. The six `source-session` losses:

- Two **false-premise** questions (`a96c20ee_abs`, `09ba9854_abs`). Raw detail,
  such as bus fares the assistant once listed, led the reader to answer a premise
  the user never stated. Abstention fell from 30 to 28 of 30 in `source-session`
  and to 27 in `source-keywords-neighbors`. `raw-hybrid` kept all 30.
- Two **multi-session totals**. In `gpt4_15e38248` the reader dropped the mattress
  the facts had counted. In `edced276` it stopped trusting the 10-day figure the
  facts gave for Hawaii and declined to add the trips.
- One **date** case (`4dfccbf7`): the reader took a second event's date from a
  raw sentence that only stated an intention ("by the end of this month").
- One **answer format** case (`a82c026e`): the text named the right Dark Souls 3
  DLC, but the boxed final answer dropped "DLC", and the judge said no.

The combined arms lost three false-premise questions each (27 of 30), the most of
any arm: more raw detail gives the reader more ways to accept a false premise.

The baseline's regression `51c32626` (a correct date lost after related but
undated raw text) did not regress in any arm under this profile.

## Robustness

**Judge resampling.** The Codex judge exposes no temperature, so Memory-only and
each of the two best arms were judged a second time, independently:

- `source-session`: 994 of 1,000 verdicts agreed. The second judgment scored 449
  against 421: 34 wins, 6 losses, p = 8.4 × 10⁻⁶, interval [+3.2, +8.0].
- `raw-hybrid`: 996 of 1,000 verdicts agreed. The second judgment scored 448
  against 421: 34 wins, 7 losses, p = 2.5 × 10⁻⁵, interval [+3.0, +8.0].
- `combined-hybrid`: 994 of 1,000 verdicts agreed. The second judgment scored 457
  against 422: 46 wins, 11 losses, p = 3.3 × 10⁻⁶, interval [+4.2, +9.8].
- `combined-keywords`: 993 of 1,000 verdicts agreed. The second judgment scored 449
  against 420: 39 wins, 10 losses, p = 3.8 × 10⁻⁵, interval [+3.2, +8.6].

Each arm's gain over Memory survives resampling. The dense-against-keyword
difference inside the combination is smaller than that: a handful of flipped
verdicts moves it from p = 0.027 (16–5) to p = 0.15 (16–8). Its direction held in
both judgments; its size is not settled at 500 questions.

**Profile change.** The baseline's Vercel reader and GPT-4o judge were unavailable,
so this run uses its own profile (below) and re-answers Memory-only. Memory-only
scored 422 here and 421 in the baseline; 479 of 500 verdicts match. All comparisons
in this report pair arms within this profile only. Do not subtract these numbers
from the baseline's.

**Reproduced raw store.** A fresh local database re-seeded every raw session with
the baseline's exact batching, text, dates, and metadata: 24,367 Observations and
250,710 chunks, as before. The independent raw packet matched the baseline
byte for byte on 499 of 500 questions. The last one has the same sources and text
in a different order, from a tie broken by random chunk ids.

**Embedding space.** Raw chunks were embedded with `gemini-embedding-2` at 1536
dimensions through the native Google adapter and Core's Episode `index()`. On 20
questions, 9,087 local chunks have text identical to chunks in the frozen corpus's
whole-session Memories. Every pair of vectors has cosine similarity 1, so this is
the frozen benchmark's embedding space.

**Isolation.** Each question has its own Workspace and a Bob-private raw canary
that also carries a vector. Searches run as `lore_app` under RLS. No canary was
returned by any search, lexical or dense.

**Re-verified after the follow-up changes** (2026-10-14, `main` at `dacf222`, after
the whitespace partition fix and index-on-request). Index verification recomputed
every Episode's chunks with the merged code: 1,000 Episodes and 250,710 chunks,
identical to those the run used. Rebuilding every arm's packet from scratch gave
5,500 of 5,500 packets byte-identical to the saved ones, and each saved answer's
input hash matched. The reader would see the same input, so the scores stand
without new reader or judge calls.

## Reading raw text only when Memory declines

The reader is told to say when its evidence is insufficient. A gated strategy
answers from Memory first and reads an arm's packet only when that answer
declines, fully or partly (`answerDeclines` in the library; added 2026-10-14).
This replays the saved answers and makes no new model call. `--summarize` reports
it as each arm's `gated` result.

Memory declines on 76 questions. Of its 78 failures, 37 are confident wrong
answers. They never escalate, so no gate on the answer can fix them.

| Arm | Always: correct | Input tokens | Gated: correct | Wins / losses | McNemar p | Input tokens | vs Memory |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `source-session` | 448 | 6,041 | 439 | 20 / 3 | 0.0005 | 3,385 | 1.37× |
| `raw-hybrid` | 447 | 4,857 | 437 | 17 / 2 | 0.0007 | 3,190 | 1.29× |
| `combined-keywords` | 448 | 6,213 | 441 | 24 / 5 | 0.0006 | 3,414 | 1.38× |
| `combined-hybrid` | 459 | 6,179 | 444 | 27 / 5 | 0.0001 | 3,401 | 1.38× |

Wins and losses are paired against `memory`. Gated input counts both reader calls
on an escalated question; their output and thinking tokens are not counted. A gate
keeps about 60% of the always-on gain for about a quarter of its extra input:
`source-session` keeps 17 of 26 extra correct answers for 916 of 3,572 extra
tokens. Gated `source-session` answers 28 of 30 abstention questions, as it does
always on.

## Reader and judge

- Reader: `gemini-3.5-flash` through Google's Interactions API directly, with the
  baseline's instruction (SHA-256 `9b76824b…187d7`), temperature 0, 8,192 output
  tokens, and 24,000-unit cap. Question date is included; the reader never sees the
  question type, gold answer, or evidence labels.
- Judge: `gpt-5.5` at low reasoning effort through `codex exec` on a ChatGPT
  login, in an isolated, tool-less Codex home. Codex refuses `gpt-4o` on a ChatGPT
  login. The five official V1 rubric templates are used unchanged from
  [evaluate_qa.py](https://github.com/xiaowu0162/LongMemEval/blob/d6dc8b50a2d9ac0c99485ea28fa5755c62414c34/src/evaluation/evaluate_qa.py)
  (SHA-256 `ecce9c4c…95251`), and only an exact "yes" or "no" is accepted.
- Identical reader inputs reuse one answer, and identical answers reuse one
  judgment, so sampling noise is never counted as a retrieval effect.

## Cost

Prices are Google's paid-tier list prices on 2026-10-13: `gemini-3.5-flash` input
$0.75 and output, thinking included, $3.75 per million tokens (both double on
2027-01-01); `gemini-embedding-2` $0.20 per million input tokens, $0.10 in batch.
The Codex judge runs on a ChatGPT plan and has no per-token price.

**Per query, in production.** Reader cost per 1,000 questions, from the full run's
input and visible output tokens plus thinking tokens measured on a 60-question
sample (the saved answers do not record thinking):

| Arm | Input | Output + thinking | Cost / 1,000 queries | Extra vs Memory | Per extra correct answer |
| --- | ---: | ---: | ---: | ---: | ---: |
| `memory` | 2,469 | 74 + 619 | $4.45 | — | — |
| `raw-hybrid` | 4,857 | 81 + 652 | $6.39 | +$1.94 | $0.039 |
| `source-session` | 6,041 | 82 + 628 | $7.19 | +$2.74 | $0.053 |
| `combined-keywords` | 6,213 | 83 + ~754 | $7.80 | +$3.35 | $0.064 |
| `combined-hybrid` | 6,179 | 85 + 754 | $7.78 | +$3.33 | $0.045 |

`combined-keywords` was not in the thinking sample; it uses `combined-hybrid`'s
thinking mean. A query embedding adds about $0.005 per 1,000 queries, and Memory
search already embeds the same question with the same model, so it can be shared.

**Fixed cost of dense raw search** (`raw-hybrid`, `combined-hybrid`). Raw sessions
average 10,400 characters, 10.3 chunks, and 4.55 characters per token:

- Embedding: $0.46 per 1,000 sessions ($0.23 in batch), once per session.
- Storage at 1536 dimensions: 154 KB per session for vectors and their HNSW
  index (1.98 GB of vectors and 1.55 GB of index here). Raw text with its lexical
  chunks and indexes takes 57 KB per session. Dense raw search roughly triples
  raw-evidence storage. Lore's 1024 dimensions would be smaller; not measured.
- A new leased background lane to embed Episodes, since admission is model-free.

**Storage per 1,000 sessions.** Raw sizes are measured on the local database
(24,367 Observations, the 500 canaries included). The Memory row is read-only from
the frozen database: its Memory tables also hold whole-session Memories, so the
fact Memories' share is apportioned by chunk count (39,098 of 289,812 chunks).

| What is stored | Size | Total vs Memory | Best always-on accuracy |
| --- | ---: | ---: | --- |
| Memory facts, chunks, and 1536-dimension vectors | 32 MB | 1.0× | 84.4% (`memory`) |
| + raw Observations and a Memory-to-source link | +6 MB | 1.2× | 89.6% (`source-session`) |
| + raw lexical chunks and indexes | +51 MB | 2.8× | 89.6% (`combined-keywords`) |
| + raw dense vectors and their HNSW index | +154 MB | 7.6× | 91.8% (`combined-hybrid`) |

`source-session` reads its sources by key and needs no raw index. The link table
does not exist yet; a few ids per Memory would add little. The lexical row costs
about 8× the raw text it indexes. On this benchmark it gave no answer gain over
reading the linked sessions, though direct raw search (`lore_search_evidence`) needs
it. So recording an Episode does not build it; an owner builds it on request with
`POST /api/v1/episodes/{id}/index` (decided 2026-10-14).

**Latency.** Warm, on the local PostgreSQL 18 database, 100 questions:

| Step | p50 | p95 |
| --- | ---: | ---: |
| Raw lexical search, original question | 8 ms | 9 ms |
| Raw lexical search, keyword OR | 11 ms | 23 ms |
| Read the Memory hits' source sessions | 4 ms | 5 ms |
| Raw hybrid search, including the query embedding call | 187 ms | 257 ms |
| — of which the `gemini-embedding-2` query call | 161 ms | 232 ms |
| Reader, Memory only (60 questions) | 3.9 s | 7.6 s (p90) |
| Reader, `combined-hybrid` (60 questions) | 4.2 s | 9.1 s (p90) |

Shared with Memory search, the query embedding costs dense raw search no extra
call, leaving about 26 ms of database time.

**This experiment's spend.**

- Raw embedding: 8,551 requests, 250,897 texts, 55.7 million tokens: **$11.14**.
  Six batches failed transiently and were embedded again.
- Reader: 4,607 calls after reuse, 23.4 million input tokens ($17.53), 0.37
  million visible output tokens ($1.38), and about 3.1 million thinking tokens
  (about $11.46, estimated from the sample). The thinking sample cost $1.55.
  Reader total: **about $32**.
- Query embeddings for retrieval: under $0.05.
- Gemini total: **about $43**.
- Judge: 9,323 Codex calls (5,346 first judgments, 3,977 re-judgments), about
  10,800 input tokens each, mostly Codex's own prompt: about 100 million tokens of
  ChatGPT plan quota. Two phases at once hit HTTP 429 rate limits.
- Local database: 4.9 GB (raw text 1.2 GB, vectors 3.6 GB, Observations 0.1 GB).

## Recommendation

**Store Memory, raw Observations, and a link between them. When Memory is not
enough, read the whole linked Observation. Keep raw search indexes optional.**
Yunpeng Zhao agreed on this direction on 2026-10-14. Keep the online default
unchanged until the path below is built and measured on real links.

- **The link does most of the work for almost no storage.** `source-session` reads
  its sources by key, with no raw index: 448 of 500, +5.2 points, at 1.2× Memory's
  storage.
- **A raw lexical index added no answer gain here.** `combined-keywords` also
  scores 448, at 2.8× the storage.
- **Dense raw search adds the rest, but is not confirmed.** `combined-hybrid`
  scores 459 at 7.6× the storage and needs a new background lane. Dense against
  keywords is not significant under both judgments: 23–16 alone (p = 0.34), and
  16–5 then 16–8 inside the combination (p = 0.027, then 0.15). Confirm it with the
  GPT-4o judge or a second dataset before building it.
- **Give the reader the whole linked Observation, not a span.** Narrower anchors
  scored lower at a similar size (435 and 440 against 448). gbrain measured the same
  on LongMemEval-S: whole sessions answered 361 of 400 and neighbor windows 285–292
  ([evidence delivery](https://github.com/garrytan/gbrain/blob/23fdb464a944cb95ec9e55ddaec68f7abdd8b3dc/docs/evidence-delivery.md)).
- **Gate it.** Reading the linked source only when Memory declines keeps 17 of the
  26 extra correct answers for a quarter of the extra input (439 at 1.37×).

The steps:

1. **Record which Observations a Memory came from.** Built in schema revision 14 as
   Memory Observation Evidence: an RLS-protected table (Memory Links cannot carry
   this, since both of their ends are Memories). Proposal acceptance copies
   `evidenceObservationIds`, and direct writes cite through their own call.
   Forgetting either side removes the citation. It links whole Observations: this
   run never used a span, since it trimmed only the tail of the last source.
   **The open question remains.** A Memory written without a citation has nothing to
   expand, and this benchmark's session keys hid that.
2. **Read in two steps.** Answer from the Memory hits. When the answer declines,
   add the whole linked Observations in Memory rank order inside the reader
   budget. The read is built (`readMemorySources`, MCP `lore_read_evidence`); the
   agent decides when to call it. Reading the sources took 4 ms here.
3. **Guard abstention before turning it on.** The source arms lost 2 of 30
   false-premise questions. Measure a reader instruction or evidence labeling that
   separates raw conversation from canonical Memory, as its own run.
4. **Keep raw indexes optional.** Recording builds no lexical index; an owner
   builds one on request, for direct raw search. Build the dense Episode lane only
   after dense passes the confirmation above.

Two limits apply. This ran in the 1536-dimension benchmark space with
`gemini-embedding-2`; Lore deployments use 1024 dimensions. And the benchmark's
session keys stand in for the link of step 1. A Memory written directly by an agent
without a citation has no source to expand; then only independent raw search can
help, and that needs a raw index.

## Order alone: each Memory's sources beside it (2026-10-15, corrected)

The product-path rerun had put each source right after its Memory and scored 450
against 442 for the API's order (10 fixed, 2 broken, p = 0.039). The eval harness
then tested the order alone.

- **Setup:**
  - Command: `bun run eval gate --base origin/main --system memory-sources
    --dataset longmemeval-s-facts --tier standard`.
  - Questions: 140, stratified.
  - Records: fact Memories, each citing its whole session.
  - Read: the same sources at the same default budget on both sides.
  - Base: main's order, as `lore_search` then `lore_read_evidence` returns it:
    every Memory first.
  - Candidate: each Memory then its own sources, through
    `lore_search withSources` (branch `experiment/lore-search-with-sources`,
    4638d76).
  - Reader: Gemini 3.5 Flash. Judge: GPT-5.6 Sol.
- **Result:**
  - Answers: 87.9% against 89.3%, 6 fixed and 4 broken, McNemar p = 0.75, 95%
    interval [−2.9, +5.7] points.
  - Retrieval: identical.
  - Verdict: `no-evidence`, so `withSources` was not shipped.
- **Reading:** the two runs point the same way, and neither settles it. Both
  earlier arms already sized sources alike: what the 24,000-character reader cap
  left after the Memories, in rank order, cutting the first one past it. So the
  earlier win was not a sizing effect, as this section first said; more likely it
  was noise. One difference is untested: the earlier cap left the sources about
  15,600 characters a question on average, while this gate gave them 24,000.

## Do sources help at all? All 500 questions (2026-10-15)

The eval harness reran the core question on every LongMemEval-S question:
fact Memories alone, against the same Memories plus the sources they cite.

- **Setup:**
  - Commands: `bun run eval run --system memory-search` and `--system
    memory-sources`, both `--dataset longmemeval-s-facts --tier full`.
  - The same search, reader (Gemini 3.5 Flash), and judge (GPT-5.6 Sol).
  - Sources read in rank order at the default 24,000-character budget.
- **Answers:** 84.2% against 89.4%: +5.2 points, 95% interval [+2.6, +7.8], 38
  fixed and 12 broken, McNemar p = 0.0003. This reproduces the earlier +5.4
  (421 to 448).
- **Where the gain is:**
  - single-session-assistant: +21.4 (12 fixed, 0 broken).
  - single-session-preference: +20.0 (7 to 1).
  - multi-session: +5.8 (10 to 3).
- **What it costs:**
  - Reader input: 2,229 to 7,664 tokens per question, 3.4 times as much.
  - Abstention: 96.7% to 83.3%, 0 fixed and 4 broken of 30.
- **The abstention losses:** three are real. The raw text holds a nearby
  detail, and the reader answers a false-premise question instead of declining
  (a job title it corrects but still answers, an estimated fare, a university).
  The fourth is a judge miss: the reader said no visit was recorded and answered
  0, which the gold answer is.
- **Verdict:** `no-evidence` under the pre-registered rule. The gain is
  significant, but a category regressed by 3 or more net cases, even without the
  judge miss.

So reading sources stays an agent's decision (`lore_read_evidence`), not a
default, and nothing more is built for now (decided 2026-10-20). The tool's
description already says the text is raw recorded conversation, not canonical
Memory, and may hold statements later corrected. Making sources a default would
first need an abstention guard, measured on its own. Reading only when Memory
declines would not be that guard: a correct abstention looks like a decline, so
it would trigger the same reading.

## Artifacts and reproduction

Runner: [run-memory-source-expansion.ts](../../tools/evaluation/retrieval/run-memory-source-expansion.ts);
pure rules: [memory-source-expansion.ts](../../tools/evaluation/retrieval/memory-source-expansion.ts);
Codex turn: [codex-exec.ts](../../tools/evaluation/shared/codex-exec.ts). Setup and
commands are in the
[evaluation tool index](../../tools/evaluation/README.md#memory-hit-to-raw-source).

Ignored local artifacts: `evaluation/results/memory-source-expansion-20261013/`:
`protocol.json`, `summary-retrieval.json`, `summary-gemini-codex.json`,
`summary-gemini-codex-smoke.json`, `embedding-usage.json`, the re-judge summaries,
500 per-question retrieval records (every arm's exact packet and diagnostics), and
500 per-question answer records, the re-judge records, and the two cost probes:
`cost-thinking-sample.json` (240 reader calls with full usage) and
`cost-retrieval-latency.json`. The probes were one-off scripts, not part of the
runner. No credential is stored in any artifact.

Protocol SHA-256: `68dce6349667cf0a4e9e92ef9169a0228a6381cb732f0251201f0f6f4046e3d1`. It extends the first nine arms' protocol
(`5aeee62d…d8ae`) with the two combined arms and their budget fields; the runner
refuses any change to a value an earlier result ran with. Rebuilt from scratch,
all nine earlier arms reproduced their stored packets byte for byte.
The smoke run (five questions per category, chosen by a hash of the id) checked
the pipeline before the full run; at 35 questions it could not separate the arms.
