# Frozen facts plus raw Episode evidence: LongMemEval-S

Measured 2026-10-12 on `codex/episode-evidence-search`, based on commit
`f0245a579f22d305af0b84d9afade5dc291f7d1a` with the local Episode-search changes.
This is a fixed retrieval/reader experiment, not a deployed agent workflow.

## Result

Adding the current lexical raw-evidence channel produced a small measured gain:
**84.2% → 85.0%, +0.8 percentage points** on all 500 questions. Five questions
improved and one regressed. The exact two-sided McNemar p-value is **0.21875**;
the paired question bootstrap 95% interval is **[0.0, +1.8] points**. This run
does not establish a statistically reliable improvement.

| Metric | Facts Memory only | Facts Memory + raw evidence |
| --- | ---: | ---: |
| Correct answers | 421 / 500 | 425 / 500 |
| Answer accuracy | 84.2% | 85.0% |
| Mean native reader input tokens | 2,467.16 | 2,548.42 |
| Gold-session Recall (470 answerable questions) | 98.6631%, top 10 | 98.7163%, top 10 from each channel |

Mean input tokens increased **3.29%**. Both arms had the same **24,000 UTF-16-code-unit
input ceiling**, including question and evidence wrappers. This is an equal cap,
not equal actual token usage. The largest rendered inputs were 12,324 units for
Memory and 21,933 for dual: neither arm exhausted the ceiling. No recorded reader
output usage reached the 8,192-token output cap (maxima 3,109 and 3,471).

Raw retrieval returned any result on only **85 / 500 questions (17%)**. For the
other **415**, the reader inputs were identical and the same answer/judgment was
reused. This avoids counting repeated model sampling as a retrieval improvement.
Raw-only gold-session Recall@10 was **11.6560%**; no raw-only answer arm was run.

## What the comparison means

- The baseline uses the user's existing **automatically extracted facts**, not
  hand-curated project Memory. No new fact extraction was performed.
- Both arms share the same facts index, question, reader instruction, decoding,
  date context, and judge. The reader receives no question-type label, gold
  answer, `has_answer`, or answer-session identifiers.
- Memory uses current native hybrid retrieval with cached
  `google/gemini-embedding-2`, 1536 dimensions, `lore-embedding-v1`; exact current
  v2 chunks are verified before importing their vectors. Query vectors use the
  same model through Vercel AI Gateway and Gemini's retrieval task prefix.
- Raw evidence uses the native Episode engine's **lexical** channels, no dense
  embedding, reranking, query rewrite, or agent query planning. Both searches
  receive the original natural-language question.
- Each channel returns at most 10 session results. The dual packet alternates
  Memory and raw results, preserving each channel's ranks. Each result contributes
  the default retrieved excerpt: one selected 1,200-code-point chunk, no neighbors.
  The baseline also uses retrieved excerpts, not full fact sheets.
- Raw sessions are exact rendered source text, one Observation per session.
  Bounded Episode envelopes batch these Observations for admission; the benchmark
  groups evidence by the explicit session metadata key. This uses the engine's
  grouping seam, not the public endpoint's default Episode-envelope grouping.
- These are fixed module calls followed by one reader answer, not an evaluation
  of an agent deciding when or how to call the two MCP tools.

The earlier **87.8% facts / 94.2% full-session** results are different experiments:
reader instructions, evidence assembly, judge, and retrieval implementation differ.
This new 84.2% baseline cannot be subtracted from those historical scores.

## Where the gain and regressions came from

All five improved questions already had their relevant gold session(s) in
Memory's top 10. None of the wins added a previously missing gold session through
the raw channel. Additional excerpts and reader behavior account for these
changes; this experiment does not isolate extraction loss from snippet selection
or attention effects.

Only **one** answerable question (`6d550036`) gained a previously missing gold
session in the union; it remained incorrect in both arms. The union's source
recall therefore barely changed.

| Question ID | Category | Outcome |
| --- | --- | --- |
| `51a45a95` | single-session-user | improved |
| `8a2466db` | single-session-preference | improved |
| `gpt4_e414231f` | temporal-reasoning | improved |
| `0bc8ad93` | temporal-reasoning | improved |
| `69fee5aa` | knowledge-update | improved |
| `51c32626` | multi-session | regressed |

Two inspected cases:

- **Premiere Pro resources (`8a2466db`)**: Memory retrieved the gold session but
  the reader said the available evidence was insufficient. The added raw excerpt
  contained Premiere Pro resources and advanced-settings context; the dual answer
  used that preference and passed the official rubric.
- **Paper submission date (`51c32626`)**: Memory answered February 1st correctly.
  The added raw excerpt discussed submitting the sentiment-analysis paper to ACL
  but omitted the date. The dual reader then claimed the date was unspecified,
  despite receiving the same Memory evidence. Additional related text can distract
  the reader from sufficient existing evidence.

The coffee-coupon win (`51a45a95`) is less clean evidence of recovered facts: both
packets contained Target-related context and the raw excerpt did not directly
state a redemption store. Treat it as a judged outcome, not proof that extraction
removed the answer.

## Per-category results

Abstention IDs are separated from their original question-type labels, and are
excluded from positive retrieval recall.

| Category | Questions | Memory | Dual | Difference, points |
| --- | ---: | ---: | ---: | ---: |
| single-session-user | 64 | 93.75% | 95.31% | +1.56 |
| abstention | 30 | 100.00% | 100.00% | +0.00 |
| multi-session | 121 | 77.69% | 76.86% | -0.83 |
| single-session-preference | 30 | 50.00% | 53.33% | +3.33 |
| temporal-reasoning | 127 | 89.76% | 91.34% | +1.57 |
| knowledge-update | 72 | 93.06% | 94.44% | +1.39 |
| single-session-assistant | 56 | 73.21% | 73.21% | +0.00 |

## Corpus and isolation checks

- Pinned cleaned S split: Hugging Face revision
  `98d7416c24c778c2fee6e6f3006e7a073259d48f`, SHA-256
  `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.
- Frozen fact rows: **23,876**; original source sessions: **23,867**. Long source
  sessions contributed nine extra fact fragments. The old count of 24,376 also
  included 500 Bob-private tripwires and was not a true conversation count.
- The imported fact content/key aggregate matches the read-only legacy corpus:
  MD5 `3e6a021243f7a3ee7805bb290f39378f` (audit checksum, not a security signature).
- **38,598** cached fact vectors; **250,710** Episode evidence chunks including
  private raw tripwires. The exact-text embedding transport probe had cosine
  similarity approximately 1 and the expected 1536 values.
- A fresh disposable PostgreSQL database uses the current migration chain,
  schema revision **13**, transformed to the legacy benchmark width of 1536.
  This does not change Lore deployment's 1024-dimensional protocol.
- Every question is isolated in its own Workspace. Reads execute as `lore_app`
  through the native Actor/storage binding and RLS. There are 500 Bob-private
  Memory tripwires and 500 Bob-private raw tripwires inside the search filters.
  **Zero tripwires were returned**; an observed leak aborts scoring.
- The old database connection enforces read-only transactions. No production
  memory, migration, or canonical-fact extraction was changed for this run.

## Reader and judge provenance

Reader: `google/gemini-3.5-flash` through Vercel AI Gateway,
`lore-portable-deterministic-v3`, temperature 0, one generic instruction,
maximum output 8192 tokens. Question date is supplied for both arms.

Judge: `openai/gpt-4o` through the same gateway, temperature 0, maximum output
16 tokens (the gateway rejects the upstream script's 10-token setting).
The five official V1 rubric templates are loaded unchanged from
[LongMemEval evaluate_qa.py](https://github.com/xiaowu0162/LongMemEval/blob/d6dc8b50a2d9ac0c99485ea28fa5755c62414c34/src/evaluation/evaluate_qa.py),
SHA-256 `ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251`.
Question type and gold answer are used only in scoring. The gateway model is an
alias, not the paper's date-pinned `gpt-4o-2024-08-06` deployment; these are the
official rubric prompts, not a claim of exact official-system reproduction.

## Interpretation and next experiment

This simple parallel lexical route gives **little additional benefit in this
configuration**. Natural-language questions are passed directly to
`websearch_to_tsquery`, which combines many surviving words with AND within a
small chunk. Low raw hit coverage and limited excerpts prevent this run from
establishing the value of raw evidence under stronger retrieval policies.

Memory already locates almost all gold sessions. A motivated next comparison is
**Memory hit → bounded expansion of its corresponding raw source**, using
explicit provenance, dates, and corrections. Another separate ablation could
compare planned keyword queries for independent raw retrieval. Neither strategy
was implemented or measured here. The evidence does not justify treating this
+0.8-point result as a general benefit of dual retrieval.

## Artifacts and reproduction

Runner: [run-memory-evidence.ts](../../tools/evaluation/retrieval/run-memory-evidence.ts).
Preparation and resume instructions are in the
[evaluation tool index](../../tools/evaluation/README.md#frozen-facts-and-raw-evidence).

Ignored local artifacts: `evaluation/results/dual-memory-evidence-20261012-v2/`:
`protocol.json`, `summary.json`, `analysis.json`, `corpus-audit.json`,
`embedding-probe.json`, and 500 per-question JSON files containing retrieved
packets, answers, and judgments. No credential is stored in these artifacts.

Protocol SHA-256: `5632361acc13fee7ff915800542942e12112aaaa0831098d15d9e39ebee86e94`.
The final verification resumed all 500 completed questions without another
reader/judge call and regenerated the same summary after the live embedding-space
probe. Typecheck, the runner's lint check, the architecture/import guard, and
`git diff --check` passed. This is evaluated local branch work, not a deployment.
