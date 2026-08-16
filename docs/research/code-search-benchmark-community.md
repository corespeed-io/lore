# Code search performance: community evidence and Lore benchmark results

Researched: 2026-08-12

Scope: exact code substring/punctuation search, PostgreSQL FTS and `pg_trgm`,
Zoekt/Sourcegraph, GitHub Blackbird, indexing/query tradeoffs, the SQL
microbenchmark completed for this change, and the larger benchmark still needed
before changing Lore's search architecture.

## Executive conclusion

Lore should **keep PostgreSQL for the bounded v1 and benchmark it end to end before
adopting a dedicated code-search service**. A real-PostgreSQL predicate benchmark
confirmed that the previous content-literal channel was the immediate bottleneck:

```sql
position(lower($query) in lower(artifact.content)) > 0
```

That predicate gives exact, case-insensitive literal semantics, including
punctuation, but PostgreSQL has no ordinary index path for it. Lore also puts FTS,
symbol substring, content substring, and path substring in one `OR`, so the actual
planner behavior can only be established with representative data and
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.

The measured response is deliberately narrow:

1. keep exact symbol/path and natural-token FTS as distinct channels;
2. use exact `LIKE '%literal%'` backed by a `lower(content) gin_trgm_ops` GIN index
   when the query contains an extractable word character;
3. retain the exact `position()` fallback for punctuation-only input, because the
   benchmark confirms that trigram lookup is worse when no trigram can be extracted;
4. run each channel as an independently bounded candidate query under the same
   Workspace/repository/exact-commit/generation predicates, then deduplicate and
   fuse results; Lore now implements this with weighted RRF;
5. retain exact content verification, because trigram lookup is candidate
   generation rather than proof of a punctuation-bearing match;
6. treat punctuation-only/very-short queries as a separate class: PostgreSQL
   documents that patterns with no extractable trigrams degenerate to a full index
   scan, and `pg_trgm` ignores non-word characters while constructing trigrams.

`pg_trgm` is therefore a plausible acceleration layer for literals such as
`fetch<User>` or `foo.bar(`, where letters provide selective trigrams. It is not a
complete answer for `=>`, `::`, `?.`, or a single `.`. If those queries are a hard
product requirement at large scale, Lore will eventually need a punctuation-aware
byte/rune ngram index or a dedicated engine such as Zoekt—not fuzzy similarity.

## Evidence hierarchy and collection notes

The report deliberately separates:

- **Primary/official evidence**: PostgreSQL documentation, GitHub's Blackbird
  engineering account, and the maintained Zoekt repository/design documents.
- **Maintainer discussion**: Zoekt issues and pull-request benchmark discussion.
- **Community anecdotes**: Reddit reports. These are useful hypotheses, not
  reproducible performance claims for Lore.

Collection used Agent Reach's active routes on 2026-08-12:

- Reddit through OpenCLI, reading both posts and comments;
- GitHub through `gh` for Zoekt source, documentation, issues, and comments;
- Twitter/X: `twitter-cli` search returned HTTP 404 after retry and after confirming
  the current 0.8.5 release; the prescribed OpenCLI fallback returned a noisy,
  weakly related result set. No X performance claim was promoted into the findings;
- official web pages through the web reader after Jina Reader was blocked by
  network-reputation authentication.

This negative X result is recorded to avoid presenting irrelevant high-engagement
posts as technical consensus.

## What the primary sources establish

### 1. PostgreSQL FTS and substring search solve different problems

PostgreSQL defines full-text search around normalized lexemes and natural-language
documents. Its preprocessing tokenizes text, normalizes words, can remove stop
words, and stores a `tsvector`; GIN is the preferred FTS index type
([FTS introduction](https://www.postgresql.org/docs/current/textsearch-intro.html),
[preferred FTS indexes](https://www.postgresql.org/docs/current/textsearch-indexes.html)).

Lore uses the `simple` configuration, which avoids language stemming and preserves
original words better than an English configuration. It still tokenizes source,
so it cannot by itself express exact punctuation layout. GitHub's code-search team
calls this out directly: code queries need punctuation, should not stem, should not
drop stop words, and should support regular expressions
([GitHub Blackbird](https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/)).

Implication for Lore: keep FTS for identifier/prose-like term recall, but do not ask
FTS to prove that `fetch<User>` occurred verbatim.

### 2. `pg_trgm` can accelerate `LIKE`/`ILIKE`, with important limits

PostgreSQL's `pg_trgm` extension provides GiST and GIN operator classes for
similarity and for indexed `LIKE`, `ILIKE`, regex, and equality searches. A leading
wildcard is allowed; more extractable trigrams generally make the search more
selective. A pattern with no extractable trigrams degenerates to a full-index scan
([official `pg_trgm` documentation](https://www.postgresql.org/docs/current/pgtrgm.html)).

The same documentation states that trigram extraction ignores non-alphanumeric
characters and treats words separately. Consequently:

- `fetch<User>` can use trigrams from `fetch` and `User`, followed by the exact
  `ILIKE` recheck that validates `<` and `>`;
- punctuation makes the final match exact, but does not necessarily make the index
  lookup more selective;
- `=>`, `::`, `?.`, and `.` provide no useful word trigrams and need an explicit
  fallback or a different index design;
- `similarity()`/`word_similarity()` are fuzzy-ranking semantics and must not
  replace exact literal containment.

The docs also distinguish access methods: GIN is effective for boolean candidate
lookup; GiST can efficiently support distance ordering with `ORDER BY distance
LIMIT k`. Lore's literal channel asks “does this exact literal occur?” and applies
its own cross-channel ranking, so GIN is the more natural first candidate. That is
still a hypothesis to benchmark, not a universal GIN-over-GiST rule.

### 3. Dedicated code engines buy query latency with larger, specialized indexes

Zoekt uses positional trigrams and exact offsets, explicitly targeting sub-50 ms
results on codebases such as Android and Chrome. Its design reports an on-disk index
around 3.5 times corpus size, local-SSD use, sharding, mmap-friendly immutable
files, and symbol-aware ranking
([Zoekt design](https://github.com/sourcegraph/zoekt/blob/main/doc/design.md),
[Zoekt README](https://github.com/sourcegraph/zoekt)).

Zoekt's FAQ provides historical, workload-qualified examples rather than one magic
latency number:

- a warmed rare query in the Linux kernel around 7–10 ms;
- a repository-scoped refinement around 13–20 ms;
- common queries become dominated by requested result count, with tens of thousands
  of results taking roughly 100 ms to one second;
- browser transfer/rendering can then take seconds;
- a historical single-thread Linux-kernel indexing run (55,000 files, 545 MB) took
  about 160 seconds.

The FAQ warns that corpus, limit, hardware, and cache state change the result
([Zoekt FAQ](https://github.com/sourcegraph/zoekt/blob/main/doc/faq.md)). This is a
good model for Lore's reporting: query class and cache state belong beside every
latency number.

Zoekt also illustrates an important semantic boundary. A maintainer rejected fuzzy
similarity as an efficient fit for its trigram-to-offset architecture; exact code
substring retrieval and typo-tolerant text similarity are separate products
([Zoekt issue #900](https://github.com/sourcegraph/zoekt/issues/900)).

### 4. GitHub reaches fast queries through content-addressed incremental work

GitHub Blackbird uses code-specific ngram indexes for content, symbols, and paths.
Its 2023 engineering report says:

- the beta covered 45 million repositories, 115 TB of code, and 15.5 billion
  documents;
- sharding by Git blob SHA removes duplicate content and distributes work;
- delta encoding and event-driven crawling avoid rebuilding unchanged blobs;
- commit-level consistency prevents partially updated search results;
- individual shard p99 was about 100 ms, while end-to-end latency was longer due to
  aggregation, permission checks, highlighting, and rendering;
- the ingest pipeline published about 120,000 documents/s and reindexed the whole
  corpus in about 18 hours after delta reduction.

Those numbers are not targets for a self-hosted Lore instance. They establish the
tradeoff: low query latency is financed by precomputed indexes, deduplication,
incremental ingestion, background compaction, and extra storage
([GitHub Blackbird](https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/)).

They also support Lore's proposed exact-commit generation model and blob-level
reuse more strongly than they support immediately introducing a separate search
service.

## What maintainers and community users report

### Reproducible maintainer evidence

Recent Zoekt work shows why “indexing time” must be decomposed:

- replacing per-blob Go library reads with a pipelined `git cat-file --batch
  --buffer` reduced the blob-reading phase on a 29,000-file Kubernetes checkout
  from 3.05 s to 0.62 s in a five-run Apple M1 Max benchmark
  ([Zoekt issue #1016](https://github.com/sourcegraph/zoekt/issues/1016));
- restructuring trigram posting-list storage reduced a 169 MB Kubernetes shard
  build from 9.3 s to roughly 2.3–2.5 s on the same class of machine. The author
  found that map pre-sizing alone was marginal; reducing per-trigram map operations
  and special-casing ASCII produced the large wins
  ([Zoekt issue #1017](https://github.com/sourcegraph/zoekt/issues/1017)).

These are scoped microbenchmarks, not full fetch-to-published-generation timings.
They nevertheless show that Git object reading, parsing/tokenization, posting-list
construction, serialization, and publication should be measured separately.

Zoekt's crash-consistency discussion is also relevant: repository shards are
immutable files written to a temporary directory and renamed only after completion,
but maintainers did not claim full crash consistency at the time
([Zoekt issue #710](https://github.com/sourcegraph/zoekt/issues/710)). Lore should
test failure at every batch/activation boundary rather than infer atomicity from
immutable files or database transactions alone.

### Reddit anecdotes: useful patterns, not Lore baselines

One PostgreSQL user reported a hybrid FTS + `pg_trgm` + vector + rewrite-rules
system over roughly 100,000 rows with most queries at 15–20 ms and a worst case of
250 ms. The same author emphasized non-obvious ranking configuration; a commenter
described a 200-million-user case where search plus relational filtering was slow
until data was denormalized around a tenant key and indexed within that scope
([discussion](https://www.reddit.com/r/PostgreSQL/comments/1l0tu1e/down_the_rabbit_hole_with_full_text_search/)).

That is directionally consistent with Lore's “Workspace/repository/revision before
ranking” rule. It is not comparable to code artifacts, RLS, Lore's query text, or
Lore's hardware.

Two other threads show recurring operator/planner mistakes:

- users called `word_similarity()` directly and expected a `gin_trgm_ops` index to
  help; commenters pointed out that an index-supported operator must appear in the
  predicate and recommended checking `EXPLAIN ANALYZE`
  ([thread](https://www.reddit.com/r/PostgreSQL/comments/1k2c04i/using_trigrams_for_fuzzy_search/));
- a 650,000-row fuzzy search reportedly stressed the database near 10 QPS;
  discussion focused on reducing the candidate set and using a composite/scoped
  access path before similarity ordering
  ([thread](https://www.reddit.com/r/PostgreSQL/comments/1lg4nxr/how_to_optimize_db_that_is_running_pg_trgm/)).

One comment in the first thread suggested changing `siglen` for a GIN trigram index.
The official documentation assigns `siglen` to the GiST operator class, not GIN.
This is exactly why community advice is retained as a test hypothesis and checked
against primary documentation.

Discussion around GitHub's new code search cared about repository/branch scoping,
literal search usefulness, ranking/sorting, and quick iteration more than a single
latency number
([Reddit launch discussion](https://www.reddit.com/r/programming/comments/yrphfe/github_introduces_an_allnew_code_search_and_code/)).
That supports benchmarking task-relevant result quality and scope correctness, not
only raw database execution time.

## Community consensus and real disagreement

### Areas of convergence

1. **Precompute for interactive search.** Fast repeated queries require indexes;
   exhaustive scans become uneconomic as corpus and concurrency grow.
2. **Scope before expensive ranking.** Tenant/repository/revision/path selectivity
   is part of the access path, not a filter to apply after global top-k.
3. **Use different channels for different intent.** Exact symbols, literal
   substrings, natural-token FTS, and fuzzy/vector similarity are not interchangeable.
4. **Query shape matters as much as index presence.** A created index proves
   nothing unless the operator and planner use it on the representative workload.
5. **Measure common and adversarial queries.** Rare literals, common identifiers,
   no-hit queries, short punctuation, result limits, and cache state have very
   different costs.
6. **Indexing and serving have different SLOs.** Background, incremental,
   generation-based indexing is allowed to spend CPU/storage so interactive reads
   remain predictable.

### Areas where there is no universal answer

- **PostgreSQL versus a dedicated engine.** Community reports show PostgreSQL can
  be operationally attractive at bounded scale; GitHub and Zoekt show why a
  specialized ngram engine wins at very large code-search scale. The crossover is
  workload-specific.
- **GIN versus GiST.** Boolean exact candidate lookup and K-nearest fuzzy ordering
  favor different access methods. Lore must benchmark its exact literal semantics,
  not copy a fuzzy-name-search recipe.
- **One SQL query versus channel fusion.** A single `OR` is simple and atomic, but
  can obscure per-channel budgets and planner behavior. Independently bounded
  channels add query work and fusion logic but make latency/quality controllable.
- **How short is too short.** Trigram indexes are structurally weak when a query
  yields no grams. Product policy can require a path/symbol scope, reject expensive
  punctuation-only global searches, scan a bounded revision, or adopt a different
  index. This is a product decision backed by measurements.

## Mapping to Lore's current implementation

Current search in `src/lib/code-index-read.ts` has these behaviors:

| Channel | Current predicate/rank | Existing useful index | Main implication |
|---|---|---|---|
| Exact symbol | `lower(matched_symbol.symbol) = lower($3)` after a lateral substring match | B-tree exists on raw `symbol` within Workspace/repository/revision/generation | The `lower` + `position` shape does not directly use that B-tree for lookup; benchmark a functional exact index/query. |
| Symbol substring | `position(lower($3) in lower(indexed_symbol.symbol)) > 0` | No matching substring index | Scans symbols associated with candidate artifacts; `pg_trgm` or prefix-only semantics are experiments. |
| Exact literal content | Indexed `lower(payload.content) LIKE '%' || lower($3) || '%'` when the query contains a letter/number; otherwise exact `position()` fallback | `code_artifact_payloads_content_trgm_idx` GIN expression index | Selective word-bearing literals get an index candidate path; punctuation-only literals remain correct but are explicitly expensive. |
| Path substring | exact `position`/`LIKE` behavior over the Artifact membership path | `code_artifacts_path_trgm_idx` plus scoped path/ordinal B-tree | Path identity stays revision-local even when text payloads are shared. |
| Token FTS | `payload.search_vector @@ websearch_to_tsquery('simple', $3)` and `ts_rank_cd(..., 32)` | `code_artifact_payloads_search_idx` | The content-only vector is shared by equal payload hashes; symbol and path are independent channels. |
| Cross-channel | independently bounded symbol, literal, lexical, and path candidates followed by weighted RRF | Per-channel indexes and exact-generation joins | Scope precedes rank, and one broad channel cannot consume every candidate slot. |

The SQL correctly includes Workspace, repository key, exact commit OID, indexer
revision, and optional path prefix before `ORDER BY ... LIMIT`. This preserves
authorization/revision semantics. It does not guarantee that every physical access
path is selective; correctness and execution efficiency are separate questions.

The baseline migration now installs `pg_trgm` beside `vector` and creates the
content expression index. Extension availability and index presence are migration
contract tests. Index size, write amplification, and self-host deployment impact
still need the complete benchmark below.

## Measured SQL microbenchmark

The checked-in `scripts/benchmark-code-search.ts` harness owns a disposable schema
inside a database whose name contains `benchmark`. It loads two equal scopes,
applies the scope predicates before ranking, builds B-tree/FTS/trigram indexes, runs
warmups plus timed samples, and captures `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.

On local PostgreSQL 14.20 with warm cache and `limit=10`, the selective
`fetch<User>` query produced:

| Visible / total Artifacts | Previous `position OR FTS` p95 | Indexed `LIKE OR FTS` p95 | Speedup | Load / all-index build |
|---:|---:|---:|---:|---:|
| 100,000 / 200,000 | 56.517 ms | 4.453 ms | 12.7x | 3.1 s / 4.7 s |
| 500,000 / 1,000,000 | 314.563 ms | 22.513 ms | 14.0x | 19.6 s / 27.8 s |

The adversarial `=>` query on 100,000 visible / 200,000 total Artifacts reversed
the result: the previous combined predicate had p95 72.745 ms, while forcing the
trigram combined predicate took p95 538.136 ms. This validates the conditional
fallback; it does not make punctuation-only global search cheap.

Reproduce one class with:

```sh
CODE_SEARCH_BENCHMARK_DATABASE_URL=postgresql://localhost/lore_code_search_benchmark \
  bun run benchmark:code-search --artifacts 100000 --query 'fetch<User>'
```

These are predicate microbenchmarks, not Lore's public-module SLO. They use
synthetic warm-cache rows, concurrency one, no network, and no production RLS or
Hyperdrive latency. The combined production query still has symbol/path channels,
and index size/WAL were not captured. The result is strong enough to reject the
unindexed content scan, but not to claim full code-search performance.

The checked-in `scripts/benchmark-code-index.ts` now covers the next seam against a
caller-provided migrated disposable PostgreSQL database. It first indexes a base
commit from scratch, then the target commit incrementally, and finally replays the
target as a no-op. Each phase reports wall time plus indexed, parsed, reused, and
excluded file counts, CPU/RSS, and database/relation growth. The harness persists the typed tree manifest and Artifacts
under RLS, inserts a higher-scoring forbidden-Workspace tripwire, measures warm
public-module searches and callers/callees reads, builds one Memory-to-Code
citation, measures production contextual traversal, checks Membership suspension,
and reports table/index bytes. It defaults to sequential reads; concurrency remains
configurable but is not part of the current acceptance baseline. Run it with:

```sh
CODE_INDEX_BENCHMARK_DATABASE_URL=postgresql://localhost/lore_code_index_benchmark \
  bun run benchmark:code-index --repository . --base-commit HEAD^ \
  --commit HEAD --output /tmp/lore-code-index-performance-v2.json
```

When `--base-commit` is omitted, the harness resolves `<commit>^`; a root commit
falls back to a full target index plus no-op replay. This makes parse/chunk reuse
observable without treating duplicated per-generation Artifact rows as storage
deduplication.

A source-derived PGlite prototype verified that the complete path terminates on
Lore `HEAD`: 333 manifest entries, 332 indexed files, one excluded entry, and 4,463
Artifacts in 117.1 seconds, followed by successful RLS search probes. PGlite is not
a PostgreSQL performance proxy; this result is retained only as a pipeline
correctness and coarse bottleneck signal. The throwaway prototype was removed.

## Full benchmark Lore should run next

### 1. Test environment

- real PostgreSQL matching the supported deployment profile; PGlite is useful for
  correctness but not a production performance proxy;
- fixed PostgreSQL version/configuration, CPU, RAM, storage type, filesystem,
  container/host limits, database size, and Git commit recorded in each result;
- `VACUUM (ANALYZE)` after data load and index creation;
- run database-only SQL timing and end-to-end public `CodeIndexModule.search`
  timing separately so transaction/RLS/connection/result-decoding costs remain
  visible;
- record both warmed runs and a separately documented cold-start procedure. Do not
  mix them into one percentile distribution.

PostgreSQL warns that `EXPLAIN ANALYZE` adds measurement overhead and excludes
network/result serialization unless requested. Use it for plan diagnosis, while
ordinary timed requests provide end-to-end latency
([`EXPLAIN` documentation](https://www.postgresql.org/docs/current/using-explain.html)).

### 2. Corpus matrix

Use deterministic source-derived artifacts, preserving realistic content length,
symbol density, paths, language mix, and repeated boilerplate:

| Scale | Artifacts | Approximate source | Purpose |
|---|---:|---:|---|
| S | 10,000 | 25–100 MB | planner crossover and developer laptop floor |
| M | 100,000 | 250 MB–1 GB | ordinary large repository/workspace |
| L | 1,000,000 | 2.5–10 GB | Postgres v1 stress/decision point |

At each scale include:

- one large revision and many small repositories/revisions with the same total
  artifacts;
- at least two Workspaces, with high-scoring inaccessible distractors;
- repeated blobs/boilerplate and unique code;
- short and maximum-sized artifacts;
- current and non-current generations, so exact-generation selectivity is real.

Report bytes and row distributions rather than relying on artifact count alone.

### 3. Query corpus

For each class, vary match cardinality: zero, one, ten, one percent, and common
enough to hit a large fraction of the selected revision. Test limits 1, 10, and 100.

| Class | Examples | What it isolates |
|---|---|---|
| Exact symbol | `MemoryModule`, mixed case | B-tree/functional exact lookup and ranking |
| Symbol/path prefix | `createCode`, `src/lib/` | scoped navigation |
| Rare identifier | `CodeRevisionConflictError` | selective FTS/literal behavior |
| Common identifier | `get`, `data`, `for` | posting-list/candidate explosion |
| Punctuation-bearing literal | `fetch<User>`, `foo.bar(`, `::new` | trigram candidates plus exact recheck |
| Short punctuation only | `=>`, `::`, `?.`, `.` | no-extractable-trigram adversary |
| Multi-term FTS | `memory proposal`, `index generation` | token matching and `ts_rank_cd` |
| Unicode/case | CJK identifier, composed/decomposed Unicode | casefold/encoding correctness and cost |
| No hit | plausible absent symbol/literal | negative-query worst case |

Correctness assertions must accompany timing: literal queries may return a row only
when the exact case-insensitive substring is present; the lexical distractor
`fetch User` must not satisfy `fetch<User>`.

### 4. Variants

Run at least these implementations against the identical loaded corpus:

1. **A — historical baseline:** monolithic `OR` and `position()` channels.
2. **B — current conditional trigram literal:** GIN `gin_trgm_ops` on content, with an exact literal
   `ILIKE` predicate and exact result validation; leave other channels unchanged.
3. **C — bounded channels:** exact symbol, symbol/path, literal, and FTS as separate
   scoped queries, each with a candidate budget, followed by deterministic rank
   fusion/deduplication.
4. **D — bounded channels + trigram:** combine B and C.

Optional experiments, only after A–D:

- GiST versus GIN for a deliberately fuzzy symbol-suggestion feature;
- table partitioning or another physical layout when repository/revision predicates
  do not sufficiently constrain GIN heap work;
- Zoekt on the same corpus and hardware if Postgres misses the accepted SLO even
  after an indexable literal channel.

Do not compare Zoekt's exact substring engine with `pg_trgm similarity()` and call
that an engine comparison; the result semantics differ.

### 5. Query metrics

Capture raw samples, not averages alone:

- warm and cold p50/p95/p99/max end-to-end latency;
- throughput and latency at concurrency 1, 8, and 32;
- open-loop offered rates as well as closed-loop clients, including schedule lag or
  late requests to avoid hiding queueing delay;
- planning time, execution time, node type, actual/estimated rows, rows removed by
  filter/index recheck, shared/local/temp buffer hits and reads, heap fetches, sort
  method/spill, and returned bytes;
- index size, table size, and database cache footprint;
- Recall@k/MRR for symbol/navigation cases and exact-literal precision;
- authorization/revision leakage count, which must remain zero.

PostgreSQL's `pgbench` supports custom scripts, client/thread counts, offered-rate
throttling, per-transaction logs, and latency limits; its documentation explains
that rate-limited latency includes scheduling lag and can count late/skipped work
([`pgbench`](https://www.postgresql.org/docs/current/pgbench.html)). A thin
application harness is still needed for public-module latency and result-quality
assertions.

### 6. Indexing metrics

Measure cold/full, no-op, 1%, 10%, and 100%-changed revisions separately. Break
each run into:

- Git tree enumeration and blob reading;
- language detection and AST parse/chunk;
- hashing/manifest work;
- database batch insertion;
- GIN/trigram index maintenance;
- completeness verification and atomic activation.

Record wall time, CPU time, peak RSS, files/s, source MB/s, artifacts/s, database
bytes, index bytes, and WAL bytes. Inject interruption after blob read, parse,
several persisted batches, and pre-activation; retry must converge while the prior
generation remains completely searchable.

This decomposition prevents a slow PGlite transaction, AST parser, Git reader, or
GIN write path from all being mislabeled “code search indexing.”

## Provisional decision gates for Lore

These are recommended product gates, not community-measured facts:

- representative M-scale, warm, repository/exact-revision scoped, `limit=10`,
  concurrency 8: end-to-end p95 at or below 100 ms and p99 at or below 250 ms for
  exact symbol, path, rare literal, common literal, FTS, and no-hit classes;
- no authorization, repository, revision, or generation leakage in any plan or
  result;
- exact punctuation-bearing precision of 100% on the adversarial corpus;
- short punctuation results must have an explicit supported scope/cost policy;
  silently falling into an unbounded scan is a failure even if a tiny fixture is
  fast;
- index-size and indexing-throughput results must be published beside query gains;
- do not adopt a dedicated engine until a real PostgreSQL variant misses the SLO at
  the supported corpus/concurrency, or until required regex/punctuation semantics
  cannot be implemented without unbounded scans.

Do not set an indexing SLO from Zoekt/GitHub numbers. First establish Lore's real
full and incremental baseline on the intended self-host hardware; then define a
background freshness SLO that includes queue delay and atomic publication.

## Recommended next action

The predicate microbenchmark justified conditional trigram candidates, and Lore now
implements variant D: independently bounded exact symbol, literal, FTS, and path
channels with trigram acceleration where a word trigram exists, exact scan fallback
otherwise, and weighted RRF. The source-derived real-PostgreSQL harness captures
full, incremental, no-op, storage, public-module concurrency, and isolation.

On local PostgreSQL 18.4, Lore `HEAD^ -> HEAD` measured 68.1 s full, 4.16 s
incremental with 328/332 files reused, and 45.6 ms exact-tree no-op. After explicit
`VACUUM (ANALYZE)`, concurrency-8 warm p50 was 21.7-36.8 ms across the checked-in
query classes. Most p95 values were 24-44 ms; punctuation-only `=>` was 103 ms.
Authorization and suspended-Membership tripwires passed. Two generations (8,926
Artifacts) used about 39.9 MiB of table storage and 26.0 MiB of indexes. These are
source-scale, one-machine observations rather than the M-scale decision gate.

The next P1 report should run the identical implementation on source-derived S/M/L
corpora, retain raw plans/latencies and WAL/RSS/CPU metrics, and compare optional
dense/compiler-graph variants against this measured baseline. It should answer:

1. Does Lore's current exact revision predicate already bound `position()` enough
   for the supported repository size?
2. Does `pg_trgm` materially improve realistic punctuation-bearing literals after
   accounting for index build, storage, and write cost?
3. Do dense or compiler-graph channels materially improve task/evidence recall
   enough to justify their indexing, privacy, and operational cost?

The evidence-backed stance is: **Postgres is the v1 default; bounded RRF plus
conditional `pg_trgm` is validated at Lore source scale; Zoekt remains the measured
escape hatch if representative M/L runs miss the gate or require broad regex and
punctuation semantics.**
