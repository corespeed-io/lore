# Lore eval harness

Measure a change before calling it an improvement. The harness runs the product's
own code path on fixed slices of public memory benchmarks, then compares a
candidate with a base ref under one rule, fixed before any result is read.

```sh
export LORE_EVAL_SERVER_URL=postgres://…   # the team's shared eval server; see below
export GEMINI_API_KEY=…                    # new embeddings and reader calls

bun run eval run  --dataset locomo,longmemeval-s --tier smoke
bun run eval gate --base origin/main --dataset locomo,longmemeval-s --tier standard
bun run eval report --run <id> [--vs <base run id>]
bun run eval gc [--older-than-days 14]                       # drop corpora no run used lately
bun run eval warm --from-database lore_longmemeval_bench_1536 # copy a Lore database's vectors, read-only
```

`--candidate` defaults to the working tree, uncommitted changes included. Reports
are written to `evaluation/results/harness/reports/`. A gate that finds a
regression exits 1. Pinned datasets download on first use, checksum-verified.

## One shared server

Everything the harness keeps lives on the PostgreSQL server `LORE_EVAL_SERVER_URL`
names:

- **`lore_eval_store`:** embeddings, answers, verdicts, runs, packets, results,
  provenance events, and which corpora were used when.
- **`lore_eval_bench_<dims>_<digest of db/migrations>`:** one database of seeded
  corpora per migration chain.

Point every sandbox at the same server and they share all of it: a fresh sandbox
reuses every corpus, embedding, answer, and verdict another one already paid for.
The team's server is the Railway `lore-benchmarks` Postgres. Ask the team for its
URL, and never commit or print it. The harness only creates and writes its own
databases there. `warm` reads another database read-only, so a frozen corpus
such as `lore_longmemeval_bench_1536` stays as it is.

Sandboxes may share the server at the same time:

- **Seeding.** A Unit's Workspace is seeded under an advisory lock, so a second
  sandbox waits and then reuses it.
- **Clean-up.** `gc` waits for no one: it skips a database while a collection
  holds it.
- **Cached values.** Concurrent writes of one cached value keep the first.

What stays per sandbox:

- the ref worktrees and their `bun install`;
- the downloaded datasets;
- the Codex login the default judge needs.

## How a run works

1. **Dataset.** An adapter (`datasets.ts`) yields isolated Units: one per
   LongMemEval question, one per LoCoMo conversation. Each Unit has its raw
   records, its cases, and Bob-private tripwires.
2. **Tier.** `smoke` has 5 cases per category and only measures retrieval.
   `standard` has 20 per category (50 for LoCoMo) and answers them. `full` has
   every case. A case's place in its category is its SHA-256 order, never its
   outcome, so a tier holds the same questions on every branch.
3. **Collect.** The system under test (`--system`; see Systems below) writes
   every record into Lore through the product's own modules, embeds it through
   leased maintenance, and answers each case at the deployment's default knobs.
   The evidence Packet and its retrieval metrics are stored. A Packet that holds a
   tripwire is an isolation failure, and any isolation failure fails a gate.
4. **Answer.** A pinned reader profile answers each Packet. The dataset's scorer
   grades the answer: the LongMemEval V1 rubric through a pinned judge, or
   LoCoMo's token F1.
5. **Compare.** Cases pair across the two runs.

## Systems and datasets

| `--system` | Stores | A question is |
| --- | --- | --- |
| `memory-search` (default, `systems.ts`) | each record as an Alice-private Memory | one Memory search |
| `memory-sources` (`memory-sources.ts`) | each source as an Alice-private Observation, and each record as a Memory citing the sources it came from | one Memory search, then one read of the cited sources at the product's default budget |

`memory-sources` lays its Packet out the way the checked-out code would show it
to an agent (`source-layout.ts`):

- **When the checkout's SDK exports `attachMemorySources`:** each Memory, then
  its own sources. Main has none. `experiment/lore-search-with-sources` adds it
  behind `lore_search withSources`, which the 2026-10-15 gate did not ship.
- **Without it:** the two calls an agent makes, `lore_search` then
  `lore_read_evidence`. Every Memory comes first, then the sources in the read's
  order.

Both read the same sources, and every run records which layout it used. Bob's
tripwire is a private Memory citing a private Observation, so a leak through
either path fails.

| `--dataset` | Unit | Records | Score |
| --- | --- | --- | --- |
| `longmemeval-s` | one question | each session (split past 32k) | LongMemEval V1 rubric, judged |
| `longmemeval-s-facts` | one question | the session's extracted facts, citing the whole session as their source | the same |
| `locomo` | one conversation | each dialog turn | token F1 |

`longmemeval-s-facts` uses the frozen corpus's fact Memories (`longmemeval-facts-v1`,
one extractor model and instruction). They are exported once, read-only, and
pinned by SHA-256. The frozen corpus also extracted a fact from Bob's tripwire
in every question. That fact restates the gold answer, so it is excluded, and
each question must have exactly one fact per session Memory. Its reader has room
for a full search plus a full default source read (60,000 characters), so
either layout reaches the reader whole.

## What is reused, and how it is proved

Nothing is reused on trust. Every summary has a **Provenance** list with one line
per step that touched the run. A collect line gives:

- the checkout, and whether `@corespeed/lore-core` loaded from that checkout;
- the code digests;
- Units seeded and reused, and chunks checked;
- cases searched and already stored;
- embeddings answered from the store and made new.

An answer line gives the answers and verdicts taken from the store and made new.

- **Runs are keyed by code, not by name.** `code.ts` follows every runtime
  import from the harness entry files, as Bun resolves them in that checkout. It
  hashes each in-repo file it reaches, plus `bun.lock` and Bun's version. It
  refuses a file that resolves outside the checkout. A run id hashes that digest
  and the following:
  - the corpus key;
  - the database (its migration chain) and the PostgreSQL version;
  - the dataset revision and the tier's case list;
  - the retrieval settings.
  A harness or product change therefore gets new Packets, even when no revision
  constant moved. Two refs whose code is byte-identical share one run, and the
  gate says so.
- **Corpora are keyed by what they store.** A Unit's Workspace id hashes the
  following, so two checkouts share a Workspace only when they would write the
  same thing:
  - the code digest of `systems.ts` (the ingest path, with all of lore-core);
  - the dataset and database;
  - the Unit's exact records and tripwires.
  Any change to lore-core or the Memory module seeds a new corpus. Its embeddings
  still come from the store when the chunk text is unchanged.
- **A Workspace is checked before it is used.** It is marked ready only when it
  holds one Alice Memory per record, one Bob Memory per tripwire, and a vector in
  the benchmark space for every chunk. A reused Workspace is checked again.
- **Embeddings** are cached by provider, model, width, revision, task, and exact
  text. Maintenance embeds each chunk's text as is. The cache trusts the
  provider revision: `docs/agent-conventions.md` requires a new revision for
  any change to query or document preprocessing.
- **Answers and verdicts** are keyed by the exact reader input and by scorer,
  judge, case, and answer. A gate pays the reader only for changed Packets. It
  grades each distinct answer once.
- **Every score records its grading:** the reader, scorer, and judge behind it.
  Answering under another profile regrades every score that lacks that grading,
  from cached answers and verdicts where they exist. A comparison refuses runs
  whose scores came from more than one grading, so a judge change can never pass
  for a system change.
- **Old refs work too.** A git ref runs in its own worktree under
  `~/.cache/lore-eval/worktrees`, with this checkout's harness copied over it, and
  its width transform (`tools/evaluation/retrieval/migrate-dimensions.ts`) too, so
  every ref's migrations are rewritten by one rule.
  The provenance line shows its engine loaded from that worktree.
- **Budget guard.** The reader cost is estimated before any call. A run stops if
  the estimate is over `--budget-usd` (default $10).

- **Warming from a Lore database.** `warm` copies the document vectors another
  Lore database holds, keyed as the harness keys them. Its source session is
  read-only, which it checks first. It compares every vector the store already
  holds and stops before writing more if one differs by over 1e-5. Its summary
  states how many it read, compared, and added, and the largest difference.

## The gate rule

The rule is fixed in `stats.ts`, tested, and never tuned after reading a result.

- **regressed**: either of
  - a significant overall loss: the paired-bootstrap 95% interval is wholly below
    zero (and, for yes/no scores, exact McNemar p < 0.05);
  - any isolation failure.
- **improved**: both of
  - a significant overall gain, by the same test;
  - no category regressed: three or more net broken cases for yes/no scores, or
    an interval wholly below zero for continuous ones.
- **no-evidence**: everything else. It is not an improvement.

Answer quality is the primary verdict when the tier answers. Retrieval (every
gold record retrieved) is reported beside it and is the verdict for `smoke`.

`smoke` has 30 to 35 cases with gold, which is too few to call most changes
significant. A control that broke 5 of 30 LongMemEval cases and fixed none got
McNemar p = 0.063, so `no-evidence`. Use `smoke` to see that packets moved, and
`standard` for a verdict.

Search latency is reported, never gated. It moves with whatever else the
database is doing: it went from 112 ms to 7 s (p50) while another corpus was
seeding.

## Profiles

- **Reader:** `gemini-3.5-flash`. The Google Interactions API at temperature 0,
  with the dataset's instruction and a 24,000-unit cap.
- **Judges:**
  - `gpt-5.6-luna`: a logged-in Codex CLI, at low reasoning effort (the default
    since 2026-10-23).
  - `gpt-5.6-sol`: a logged-in Codex CLI, at low reasoning effort (the default from
    2026-10-14, when GPT-5.5 left ChatGPT Codex, until 2026-10-23).
  - `gpt-4o`: through the Vercel AI Gateway, with `AI_GATEWAY_API_KEY`.

A profile's identity is part of every cache key. When a judge disappears, rerun
with a new judge: stored answers are graded again and no reader call is repeated.

## Adding to it

- **A dataset:** implement `Dataset` in `datasets.ts` (index, units, scorer,
  reader instruction) and add it to `DATASETS`.
- **A system:** implement `EvalSystem` in its own file: ingest identity,
  retrieval identity, ingest, retrieve, and usage.
  - Seed through `seedUnits` (`system-common.ts`), which owns the locks, the
    drain, and the checks. Ingest must report what it seeded and reused.
  - Declare `corpusEntries`, the files that decide what it stores, and
    `runEntries`, the files that also decide its Packets. Keep retrieval-only code
    out of `corpusEntries`, so changing it never seeds a new corpus.
  - Register it in `SYSTEMS` in `run-eval.ts`.
  - Example to add next: Episode search.
- **A scorer:** add it to `scorers.ts` with its identity.
