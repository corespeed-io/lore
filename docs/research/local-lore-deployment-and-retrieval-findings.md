# Local Lore deployment and retrieval findings

Audited: 2026-08-12. This is a local, primary-source research memo for a future
article. It is not a leaderboard report, a security proof, or a claim that one
small benchmark determines Lore's defaults.

Sources are the running local deployment, checked-in source and tests, Git
history, existing benchmark reports, and ignored raw result JSON. No `.env`
content or credential was read. The repository convention is to keep long-form
research in `docs/research/`, architectural decisions in `docs/adr/`, fixed
benchmark manifests in `evaluation/{suites,external}/`, reproducible runners in
`scripts/benchmark-*.ts`, and ignored raw output in `evaluation/results/`.

## Operational snapshot

The active local deployment is in the sibling worktree
`/Users/spenc/.codex/worktrees/04fc/lore`, not this `5ce0` research worktree.
On 2026-08-12:

- `bun run service:status` reported healthy Postgres, application, and maintenance
  processes; search mode was `hybrid` and the managed reranker was disabled.
- `GET http://127.0.0.1:3000/readyz` returned HTTP 200 with `database`,
  `embedding`, `rlsRole`, `schema`, and `vector` all `ok`.
- Ollama was listening only on localhost and listed local Qwen3.5 4B/9B and
  Qwen3-Embedding 0.6B/4B models.

This shape is deliberate. The service wrapper starts the request application,
maintenance worker, and optional llama.cpp reranker as distinct processes, gives
the application and maintenance worker distinct Postgres credentials, strips
unneeded database secrets from child environments, and binds the application and
reranker to `127.0.0.1` (`scripts/local-service.mjs`, especially
`localServiceConfiguration`, `buildRuntimeEnvironment`,
`buildMaintenanceEnvironment`, `buildRerankerArguments`, and `up`; introduced by
commit `6f886ee`). The current deployment is therefore evidence that the local
hybrid profile runs end to end, not evidence that the optional reranker should be
always on.

## Strongest findings

### 1. Retrieval stages solve different bottlenecks, so stacking them is not monotonic

In a held-out 15-question LoCoMo slice on an Apple M4 Pro with 24 GB unified
memory and a local Qwen3.5 4B reader, Hybrid reached answer F1 `0.5090` at
`219 ms/query`. Query planning raised evidence Recall@10 from `0.5111` to
`0.5778`, but cost `1,511 ms/query`. The Qwen3 0.6B reranker instead produced the
best answer F1, `0.5654`, and raised evidence Recall@1 from `0.2333` to `0.3556`
at `1,209 ms/query`. Combining planner and reranker produced the best evidence
MRR (`0.5750`) but lower answer F1 (`0.5518`) and `2,340 ms/query`.

The planner widened candidate recall; the reranker improved reader-facing order.
Their gains did not add linearly. The answer-F1 reranking gain repeated on a
separate 20-question development slice (`0.4313` to `0.4808`), but the total 35
questions remain too small for a release claim. Source:
`docs/research/locomo-local-qwen35-4b-ablation.md`, **Fixed local profile**,
**Results**, and **Decision boundary**.

### 2. The same reranker can improve ordinary retrieval and damage conflict retrieval

On the document-aware MemoryAgentBench Accurate workload, the local Qwen3 0.6B
reranker raised Hybrid Recall@1 from `0.72` to `0.89` and MRR from `0.8299` to
`0.9375`, while average latency rose from `113 ms` to `1,156 ms` and p95 reached
`1,734 ms`. Every one of 100 provider calls was live and the isolation gate
passed.

On a two-source, 200-question Conflict workload, however, the non-reranked path
reached exact evidence Recall@10 `0.800` and MRR `0.4370` at `178 ms`. Adding the
same reranker reduced Recall@10 to `0.755`; after Lore correctly bounded the
cross-encoder input to compact evidence, Recall@10 fell to `0.720`, MRR to
`0.3686`, and latency still measured `930 ms`.

This is evidence against a universal “reranking improves memory” rule. Pairwise
query/passage relevance is not the same task as temporal conflict resolution or
selecting one fact from a Memory containing unrelated facts. Source:
`docs/research/local-reranker-apple-silicon.md`, **Lore measurement on Apple M4
Pro**.

### 3. A Memory-id hit can substantially overstate answerability

In the audited Conflict run, parent-Memory Recall@10 was `0.800`, while exact
answer-evidence Recall@10 was only `0.635`; a relevant container did not guarantee
that the reader received the answer-bearing chunk. When the explicit bounded
evidence budget covered every chunk of a small visible Memory, returning that
Memory in ordinal order restored exact evidence Recall@10 to `0.800` and MRR from
`0.3697` to `0.4370`, without crossing a Memory or RLS boundary.

The useful retrieval unit is therefore not merely “a matched Memory,” but the
authorized evidence actually placed in the reader context. Source:
`docs/research/local-reranker-apple-silicon.md`, **Lore measurement on Apple M4
Pro**; implementation contract in `src/lib/memory.ts` (`EVIDENCE_POLICY` and the
compact rerank/expanded-answer paths).

### 4. Recursive retrieval reaches diminishing returns quickly

On a balanced 12-question LongMemEval-S smoke, one deterministic feedback hop
raised Recall@10 from `0.9792` to `1.00` and nDCG@10 from `0.9558` to `0.9661`,
but average latency increased from `1,534 ms` to `2,187 ms`. On the Conflict
workload, a second feedback hop moved multi-hop-source Recall@10 only from
`0.440` to `0.450`, increased average latency from about `178 ms` to `269 ms`,
and lowered evidence MRR to `0.3618`.

Lore consequently bounds feedback depth at three, excludes previous anchor
Memories, and reserves at most the trailing 20% of a full pool for feedback
results (`src/lib/memory.ts`, `feedbackRetrievalQueries` and
`appendFeedbackCandidates`). Source for measurements:
`docs/research/local-reranker-apple-silicon.md`, **Lore measurement on Apple M4
Pro**.

### 5. Dense-retrieval thresholds trade recall against false answers, not just recall against latency

The raw local 18-case suite in the active `04fc` worktree includes 12 positive
queries, six no-answer cases, and private tripwires. With Qwen3-Embedding 0.6B
under `lore-embedding-v2`, raising cosine-distance allowance from `0.50` to
`0.55` raised Recall@1 from `0.75` to `0.9167` and Recall@K from `0.75` to `1.0`,
but no-answer accuracy was only `0.8333`; at `0.60`, the positive metrics stayed
flat while average false results doubled from `0.1667` to `0.3333`.

This raw artifact is a small calibration fixture, not a product benchmark, but it
shows why Lore treats abstention errors as part of the same quality gate and does
not raise the semantic threshold merely to inflate recall. Source:
`/Users/spenc/.codex/worktrees/04fc/lore/evaluation/results/retrieval-0.6b-threshold-sweep.json`
(written 2026-08-10); fixture definition in `evaluation/suites/retrieval-v1.json`.

### 6. An embedding model or query prefix is a versioned vector space, not a hot-swappable setting

Lore fixes vectors at 1,024 dimensions and identifies a space by provider,
model, dimensions, and preprocessing revision. Qwen3/Ollama's
`lore-embedding-v2` adds the model's retrieval instruction to query text only;
stored document text stays unchanged (`src/lib/embedding-config.ts` and
`src/lib/embedding/ollama.ts`). A replacement generation builds beside the active
one, cannot activate without exact coverage, atomically becomes active, and leaves
the old generation available for bounded rollback (`src/lib/maintenance.ts`;
`tests/maintenance.test.ts`, **embedding revisions build beside the active
generation and cut over atomically** and **an incomplete embedding generation
cannot become active**).

The database stores vectors by generation and restricts the active semantic
candidate set before distance ordering (`db/migrations/0001_v1_baseline.sql`,
`embedding_generations`, `memory_chunk_embeddings`; `src/lib/memory.ts`,
`active_semantic_chunks AS MATERIALIZED`). This prevents approximate traversal
from mixing incompatible spaces. Architectural decision:
`docs/adr/0001-deployment-embedding-configuration.md`.

### 7. Local inference is viable, but residency and parallelism do not erase ranking cost

The measured local stack used Qwen3-Embedding 0.6B, a Qwen3.5 4B reader, and a
Q8 Qwen3-Reranker 0.6B served by llama.cpp on an Apple M4 Pro with 24 GB unified
memory. Loaded reranker RSS was about `1,600,720 KiB` with one slot. Four slots
raised RSS only modestly, to about `1,665,952 KiB`, but did not improve
single-request latency. The runtime could schedule more work; it did not make one
ranking request faster.

That finding supports a small single-user deployment and a measured throughput
experiment for concurrency, not a blanket `parallel=4` default. Source:
`docs/research/local-reranker-apple-silicon.md`, **Lore measurement on Apple M4
Pro**. Current optional local serving arguments are in
`scripts/local-service.mjs`, `buildRerankerArguments`.

### 8. Lore treats raw evidence, suggestions, and accepted knowledge as different objects

An Episode contains ordered, immutable Observations such as messages, tool results,
document fragments, and events. They are evidence, not searchable canonical
Memory. An Agent may submit an owner-private Memory Proposal grounded in visible
Memory or Observation ids, but only the owner human can accept it. Pending
proposals are absent from Memory search and Graph; update acceptance is bound to
the exact Memory version. If an explicitly forgotten Observation was cited, Lore
retains only its content-free reference id and refuses acceptance rather than
silently dropping the missing evidence.

This boundary is encoded in `db/migrations/0001_v1_baseline.sql`
(`episodes`, `observations`, `memory_proposals`, proposal-evidence tables, and
their RLS policies), explained in
`docs/adr/0002-observations-before-automatic-memory.md`, and exercised in
`tests/observations.test.ts` and `tests/memory-proposals.test.ts` (especially
**Agent proposal remains private and non-canonical until its owner accepts it**,
**Update proposal applies only to the exact reviewed Memory version**, and **A
Proposal cites only RLS-visible Observation evidence without making it Memory**).

### 9. Privacy is part of retrieval correctness, not a post-ranking filter

The Memory, chunk, embedding, link, Episode/Observation, Proposal, Agent, Code
Index, and Evaluation tables all have RLS policies. Memory search applies
Workspace, owner/scope, time, and metadata constraints in every lexical and dense
candidate query before top-k. Planner expansions and feedback hops re-enter the
same Actor-scoped search; only authorized compact passages reach a reranker
(`src/lib/memory.ts`, especially `retrieveCandidates` and `search`). Graph links
are visible only when both endpoints are visible
(`db/migrations/0001_v1_baseline.sql`, `memory_links_select`).

Local LoCoMo, MemoryAgentBench, Conflict, and the small retrieval suite plant
Bob-private tripwires and report zero hard failures in the cited runs. Tests also
cover a second Workspace, co-members with different private Memories, revoked
Memberships, revoked Agent grants, and direct chunk access (`tests/memory.test.ts`,
`tests/access.test.ts`, `tests/observations.test.ts`, and
`tests/code-index.test.ts`). This is not a formal proof; it is a methodological
choice that makes any leak invalidate a run instead of letting an average quality
score hide it.

### 10. Code evidence must be bound to an immutable revision and kept separate from Memory

The current Code Index accepts only full 40- or 64-character Git OIDs, resolves
the exact commit, reads blobs from Git's object database rather than the working
tree, records an independent tree digest and one typed manifest outcome for every
tree entry, and searches only a requested repository and exact commit. It
structurally parses supported web languages into bounded, reconstructable
Artifacts; unsupported or substantially malformed input receives a bounded text
fallback. Unchanged parse/chunk outputs may be reused only when Git blob OID,
full content SHA-256, and `CODE_INDEX_REVISION` all agree. A rename remaps
path-qualified identities rather than pretending it is unchanged identity
(`src/lib/code-index.ts`, `readGitRevisionFiles`, reuse validation,
`indexGitRevision`, and `search`).

These Artifacts are rebuildable evidence and never canonical Memory. Current
verification indexed Lore `HEAD` into 333 manifest entries, 332 indexed files,
one typed exclusion, and 4,463 Artifacts in 117.1 seconds under PGlite. That is a
bounded correctness/profile result, not a production SLO. Source:
`docs/research/code-aware-memory-best-practice.md`, **Verdict**, **Direct
verification matrix**, and **What was actually executed**; public tests in
`tests/code-index.test.ts`.

### 11. Code-search optimization depends on literal semantics, including punctuation

On warm PostgreSQL 14.20 synthetic data, changing the exact content-literal branch
from an unindexed `position()` scan to a trigram-backed exact `LIKE` reduced
combined-query p95 from `56.517 ms` to `4.453 ms` at 100,000 visible / 200,000
total Artifacts, and from `314.563 ms` to `22.513 ms` at 500,000 visible / one
million total Artifacts. But forcing the same trigram lookup for the
punctuation-only query `=>` regressed p95 from `72.745 ms` to `538.136 ms`.

Lore therefore conditionally uses the trigram path only when the query has usable
word trigrams and preserves the exact revision-scoped scan for punctuation-only
queries (`src/lib/code-index.ts`, `hasWordTrigram` and `search`). The wider lesson
is that “add an index” is not a universal optimization; query language semantics
determine which index has information to work with. Source:
`docs/research/code-search-benchmark-community.md`, **Measured SQL
microbenchmark**; reproducible harness in `scripts/benchmark-code-search.ts`.

## Article thesis and limits

A defensible article thesis is:

> We built and measured an AI memory system on one Mac, then discovered that
> candidate recall, evidence ranking, and answer-evidence assembly are separate
> problems. More queries, more reranking, and deeper feedback did not reliably
> compose. The hard requirement was not “retrieve something similar,” but deliver
> the answer-bearing evidence under the correct Actor and revision boundary.

The strongest counterintuitive arc is the contrast between ordinary retrieval and
the Conflict workload, followed by the parent-Memory versus exact-evidence gap.
The Code Index results provide an independent systems example of the same theme:
boundary conditions and query semantics can dominate the apparently obvious
optimization.

Keep the limitations explicit: the LoCoMo result covers 35 questions, the
LongMemEval result is a 12-question smoke, several Conflict and code-search metrics
are retrieval diagnostics rather than official end-answer scores, the local raw
18-case suite is a calibration fixture, and the PGlite Code Index timing is not a
production Postgres capacity claim.
