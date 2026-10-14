# Lore eval harness

Measure a change before calling it an improvement. The harness runs the product's
own code path on fixed slices of public memory benchmarks, then compares a
candidate with a base ref under one rule, fixed before any result is read.

```sh
export LORE_EVAL_SERVER_URL=postgres://postgres@127.0.0.1:5433/postgres  # may create lore_eval_bench_* databases
export GEMINI_API_KEY=…                                                   # embeddings and the reader

bun run eval run  --dataset locomo,longmemeval-s --tier smoke
bun run eval gate --base origin/main --dataset locomo,longmemeval-s --tier standard
bun run eval report --run <id> [--vs <base run id>]
bun run eval gc [--older-than-days 14]   # drop corpora no run used lately
```

`--candidate` defaults to the working tree, uncommitted changes included. Reports
are written to `evaluation/results/harness/reports/`. A gate that finds a
regression exits 1.

## How a run works

1. **Dataset.** An adapter (`datasets.ts`) yields isolated Units: one per
   LongMemEval question, one per LoCoMo conversation. Each Unit has its raw
   records, its cases, and Bob-private tripwires.
2. **Tier.** `smoke` has 5 cases per category and only measures retrieval.
   `standard` has 20 per category (50 for LoCoMo) and answers them. `full` has
   every case. A case's place in its category is its SHA-256 order, never its
   outcome, so a tier holds the same questions on every branch.
3. **Collect.** The system under test (`systems.ts`; today `memory-search`, the
   shipped Memory path) writes every record into Lore as an Alice-private Memory,
   embeds it through leased maintenance, and answers each case with one Memory
   search at the deployment's default knobs. The evidence Packet and its
   retrieval metrics are stored. A search that returns a tripwire is an isolation
   failure, and any isolation failure fails a gate.
4. **Answer.** A pinned reader profile answers each Packet. The dataset's scorer
   grades the answer: the LongMemEval V1 rubric through a pinned judge, or
   LoCoMo's token F1.
5. **Compare.** Cases pair across the two runs.

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
  provider revision: AGENTS.md requires a new revision for any change to query or
  document preprocessing.
- **Answers and verdicts** are keyed by the exact reader input and by scorer,
  judge, case, and answer. A gate pays the reader only for changed Packets. It
  grades each distinct answer once.
- **Old refs work too.** A git ref runs in its own worktree under
  `~/.cache/lore-eval/worktrees`, with this checkout's harness copied over it.
  The provenance line shows its engine loaded from that worktree.
- **Budget guard.** The reader cost is estimated before any call. A run stops if
  the estimate is over `--budget-usd` (default $10).

All of this lives on one machine: the store, the worktrees, and the
`lore_eval_bench_*` databases. A fresh sandbox starts empty. Its first standard
gate seeds and embeds every corpus and pays every reader and judge call. Copy
`evaluation/results/harness/store.sqlite` to carry the caches over.

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
  - `gpt-5.6-sol`: a logged-in Codex CLI (the default; GPT-5.5 left ChatGPT Codex
    on 2026-10-14).
  - `gpt-4o`: through the Vercel AI Gateway, with `AI_GATEWAY_API_KEY`.

A profile's identity is part of every cache key. When a judge disappears, rerun
with a new judge: stored answers are graded again and no reader call is repeated.

## Adding to it

- **A dataset:** implement `Dataset` in `datasets.ts` (index, units, scorer,
  reader instruction) and add it to `DATASETS`.
- **A system:** implement `EvalSystem` in `systems.ts`: ingest identity,
  retrieval identity, ingest, retrieve, and usage. Ingest must report what it
  seeded and reused. Keep it in `systems.ts`, or add its file to `CORPUS_ENTRIES`
  and `RUN_ENTRIES` in `harness.ts`, so its code is part of the keys. Examples:
  Memory plus linked sources, or Episode search.
- **A scorer:** add it to `scorers.ts` with its identity.
