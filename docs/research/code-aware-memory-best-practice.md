# Code Index + canonical Memory: best-practice verification

Audited: 2026-08-12

Scope: Lore's current revision-bound Code Index, its separation from canonical
Memory, and the proposed path to full-repository indexing. Sources are limited to
official specifications/documentation, official source repositories, and original
papers. Implementation claims were checked against `src/lib/code-index.ts`, the v1
baseline migration, and the public module tests.

## Verdict

Lore's architectural boundary is right:

> Code Index is rebuildable evidence about an exact source snapshot; Memory is
> durable, reviewed knowledge about facts, decisions, constraints, and rationale.

That boundary is **best-practice-convergent**, not a proven universal optimum.
Its components are independently well supported: Git's content-addressed snapshot
model, exact-commit code intelligence, AST-aware chunking, symbol/lexical retrieval,
atomic index publication, row-level authorization, and citation revalidation.
GitHub Copilot Memory is especially close: repository facts carry code citations,
citations are checked against the current branch, and only validated facts are used
([GitHub Copilot Memory](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/agents/copilot-memory)).
No located primary study evaluates Lore's complete Code Artifact -> evidence link ->
reviewed Memory -> staleness proposal loop end to end.

The implementation is now a **bounded, production-capable full-revision indexer**,
not a web-scale or compiler-precise code-intelligence engine. Lore resolves a full
OID to an exact commit/tree, batch-reads Git objects rather than the working tree,
persists complete typed manifest outcomes, and publishes through leased resumable
`building -> ready -> active` generations while retaining the previous generation
for rollback. The low-level `indexRevision(files[])` seam remains explicitly
prepared/test-only and cannot silently share authenticated Git evidence. The main
remaining scale/quality questions are P1 experiments: duplicated Artifact rows per
generation, dense retrieval, compiler-derived definition/reference graphs, and
task-level retrieval/chunk-policy ablations.

Status meanings:

- **Verified**: implemented and exercised through Lore's public module seam.
- **Aligned**: design matches primary-source practice; coverage may remain bounded.
- **Gap**: planned property has no typed implementation yet.

## Direct verification matrix

| Property | Primary-source baseline | Lore evidence | Assessment |
|---|---|---|---|
| Separate Code Evidence from canonical Memory | Sourcegraph describes code-graph data as indexer-produced definitions, references, symbols, and documentation—derived code intelligence rather than authored knowledge ([Sourcegraph Code Graph](https://sourcegraph.com/docs/cody/core-concepts/code-graph)). GitHub stores repository facts separately and revalidates their supporting code citations before use ([GitHub Copilot Memory](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/agents/copilot-memory)). | `code_repositories`/`code_revisions`/`code_index_generations`/`code_artifacts` are separate from `memories`; the public test verifies indexing creates zero Memories and application roles cannot rewrite Artifacts. | **Verified / aligned.** Keep this boundary. Derived refreshes must never silently rewrite a Memory claim. |
| Exact immutable revision binding | A Git commit points to a tree representing a repository state; refs such as branch names point to commits and may move. Git supports full 40-hex SHA-1 and 64-hex SHA-256 object names ([Git revisions](https://git-scm.com/docs/gitrevisions), [Git hash transition](https://git-scm.com/docs/hash-function-transition)). Sourcegraph requires both repositories to be indexed at the exact imported commit for cross-repository SCIP navigation ([writing a SCIP indexer](https://sourcegraph.com/docs/code-navigation/writing-an-indexer)). | `indexGitRevision` validates a full 40/64-hex OID, resolves `${oid}^{commit}`, requires exact equality, enumerates the full tree, reads blobs by object OID rather than the working tree, binds the revision to source and tree SHA-256 digests, and persists one typed manifest outcome per entry. Tests cover SHA-1/SHA-256 repositories, a dirty working tree, a well-formed nonexistent OID, abbreviated OIDs, idempotency/conflict, exact-revision search, and manifest RLS/revocation. Public enqueue accepts only an operator-configured repository key plus exact commit OID. | **Verified for the trusted local-Git adapter.** Keep `indexRevision(files[])` as an explicitly prepared/internal seam; HTTP/SDK/MCP expose only the authenticated job adapter and never a caller-supplied path or Workspace. |
| AST/symbol-aware, lossless, bounded chunks | CAST's stated goals are syntactic integrity, bounded high-density chunks, and verbatim reconstruction when chunks are concatenated; it recursively splits large AST nodes and merges adjacent small siblings ([CAST, Findings of EMNLP 2025](https://aclanthology.org/2025.findings-emnlp.430/)). Tree-sitter exposes concrete syntax nodes including tokens and source byte ranges and is designed to remain useful in the presence of syntax errors ([Tree-sitter basic parsing](https://tree-sitter.github.io/tree-sitter/using-parsers/2-basic-parsing.html), [Tree-sitter overview](https://tree-sitter.github.io/tree-sitter/)). | Lore uses tree-sitter through ast-grep for its built-in web languages, distinguishes logical symbol/declaration/chunk identity, supports multiple bindings per exact Artifact, falls back on malformed/unsupported input, preserves source characters, and caps each chunk at 6,000 UTF-16 units without splitting a Unicode code point. Tests cover exact reconstruction, delimiters, CRLF, CJK, emoji, boundary newlines, whitespace-only spans, large declarations, destructuring, parser recovery, and fallback. | **Verified / aligned for the supported languages.** The 6,000-unit metric is an implementation protocol, not a proven optimum. CAST uses non-whitespace characters, so Lore must calibrate size and merge policy with retrieval/task evaluation rather than cite CAST as validation of 6,000. |
| Symbol, lexical, path, graph, and dense retrieval | Sourcegraph explicitly separates search-based navigation (text + syntax heuristics) from precise compiler-derived definition/reference navigation; SCIP represents definition/reference occurrences and symbols ([Sourcegraph Code Navigation](https://sourcegraph.com/docs/code-navigation), [SCIP indexer guide](https://sourcegraph.com/docs/code-navigation/writing-an-indexer)). RepoCoder's original evaluation found iterative similarity retrieval better than in-file and vanilla one-shot RAG in its code-completion setting ([RepoCoder, EMNLP 2023](https://aclanthology.org/2023.emnlp-main.151/)). Reciprocal Rank Fusion is an established rank-level method for combining heterogeneous retrieval lists without pretending their raw scores are calibrated ([Cormack, Clarke & Büttcher, SIGIR 2009](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf)). | Search now runs independently bounded symbol, exact-literal, `simple` FTS, and path channels under the same Workspace/repository/exact-commit/active-generation predicate, then applies deterministic weighted RRF. Symbol/path/content word-bearing substring channels use exact `LIKE` plus trigram candidates; punctuation-only input keeps exact scan semantics. There is still no dense channel, compiler-derived reference/call graph, or reranker. | **Verified deterministic first stage; P1 semantic/graph gap.** Rank fusion is implemented without mixing raw scores. Dense and compiler-precise channels should be added only as versioned evaluation variants that beat this baseline. |
| Preserve punctuation-bearing literal intent | GitHub's code-search engineering account states that code search differs from prose search: punctuation must be searchable, stemming is undesirable, and stop words must not disappear; Blackbird therefore uses code-specific substring/ngram indexing ([GitHub Blackbird](https://github.blog/engineering/architecture-optimization/the-technology-behind-githubs-new-code-search/)). PostgreSQL can accelerate leading-wildcard `LIKE`/`ILIKE` with `pg_trgm`, but patterns with no extractable trigrams fall back to a full-index scan ([PostgreSQL `pg_trgm`](https://www.postgresql.org/docs/current/pgtrgm.html)). | An adversarial public-seam test with `fetch<User>` initially ranked a lexical `"fetch User"` distractor first. Lore now gives exact case-insensitive literals their own bounded RRF channel, uses trigram GIN candidates when the query has a word trigram, and preserves exact `position()` semantics for punctuation-only input. | **Verified for the v1 fixed-string contract after a red-green fix and SQL benchmark.** `=>`, `::`, and similar inputs are exact repository/revision-scoped scans with explicit measured cost; Lore does not claim global regex, selectable case modes, or cheap punctuation-only web-scale search. |
| Blob-level incremental indexing | Git trees store the object ID of each file's blob. An unchanged file reuses its prior blob ID, and a rename does not change the blob object because blobs are content-addressed and independent of path ([Git data model](https://git-scm.com/docs/gitdatamodel), [Git user manual: trees and blobs](https://git-scm.com/docs/user-manual#object-details)). Tree-sitter can also reuse unchanged syntax-tree structure when reparsing edited text ([Tree-sitter incremental parsing](https://tree-sitter.github.io/tree-sitter/using-parsers/3-advanced-parsing.html)). | Lore persists every tree outcome, batch-reads bounded Git blobs, reuses prior Artifact output only when blob OID, SHA-256, and `CODE_INDEX_REVISION` agree, reconstructs the exact blob, and remaps path-qualified identities on rename. Text, ordered path-free Symbol Sets, and ordered path-free Dependency Sets are content-addressed within a Workspace; Artifact membership and dependency resolution overlays remain exact-generation projections. Tests cover unchanged, rename, change, deletion, mode-only change, indexer revision invalidation, invalid dependency ordinals, and last-reference GC. Tracked generated/vendor text is indexed consistently; Lore does not guess from path names. Exact commit/tree OIDs provide a fast no-op identity path. | **Verified incremental lifecycle and derived-payload reuse.** Per-generation Artifact memberships and resolution overlays remain intentional because path and target resolution can change independently of source bytes. |
| Immutable generation and atomic publication | Lucene commits pending index changes so a reader sees the committed state, and supports rollback; it also documents all-or-none visibility for atomic document blocks ([Lucene `IndexWriter`](https://lucene.apache.org/core/9_6_0/core/org/apache/lucene/index/IndexWriter.html)). Elasticsearch's alias API supports an atomic old-index/new-index swap for zero-downtime reindexing ([Elasticsearch aliases](https://www.elastic.co/docs/manage-data/data-store/aliases)). Sourcegraph runs queued asynchronous index jobs through indexing/completed/error states and retries failures ([Sourcegraph auto-indexing](https://sourcegraph.com/docs/code-navigation/auto-indexing)). | Durable jobs use bounded attempts and leases. Files checkpoint in separate transactions into `building`; retries reuse completed files. Exact manifest coverage is required for `ready`, activation atomically retires the old active generation, and search reads only active. Tests inject a mid-build interruption, assert no partial results, resume without duplicate parsing, and verify revoked requesters cannot be claimed. | **Verified / aligned for the bounded self-host profile.** Failed attempts leave rebuildable staging state, while the old generation keeps serving. |
| Authorization and scope before top-k | PostgreSQL RLS evaluates policy expressions for each row before ordinary query conditions (except leakproof-function optimizer cases), and no policy means default deny when RLS is enabled ([PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)). pgvector warns that approximate indexes may scan candidates before query filters, reducing filtered recall; iterative scans can continue until enough filtered results are found ([pgvector README](https://github.com/pgvector/pgvector#iterative-index-scans)). | Every Code Index table has RLS. Search includes Workspace, repository key, exact revision OID, current indexer revision, and path scope in the same SQL query before `ORDER BY ... LIMIT`. Public tests cover a second Workspace, shared-Workspace visibility, revoked Membership, read-only Agent search, revoked Agent grant, and write denial. | **Verified / aligned for current lexical search.** When dense retrieval is added, RLS still protects confidentiality, but ANN filtering can starve recall. Benchmark `EXPLAIN` plans and use exact-generation scoped candidates/partitioning or pgvector iterative scans; never fetch global ANN top-k and filter in application code. |
| Memory-to-code evidence and staleness | GitHub stores code citations with repository facts, checks them against the current branch, and uses only validated facts; facts from an unmerged PR do not affect behavior unless current code still substantiates them ([GitHub Copilot Memory](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/agents/copilot-memory)). This is strong first-party precedent, but GitHub publishes product behavior rather than a controlled outcome study. | `memory_code_evidence` stores immutable commit/path/symbol/declaration/declaration-chunk-ordinal/content anchors plus `supports`, `contradicts`, `implements`, or `rationale`. Declaration anchors also freeze a masked ordered-sequence context SHA-256: the cited chunk digest is replaced by a marker, so only the cited chunk may change while every surrounding partition remains identical. Side-effect-free assessment reports `current`, `moved`, `changed`, `deleted`, `ambiguous`, or `unverifiable`; explicit revalidation may persist the identical result but updates no Memory content. Changed partition counts and equal-count structural reorder/replacement abstain as ambiguous. Anchors survive pruning rebuildable Artifact rows. Private Memory/RLS and cross-Workspace denial are tested. | **Verified / aligned.** Automatic proposal generation remains intentionally outside v1; disagreement must go through owner-private Memory Proposals rather than mutating canonical Memory. |

## What was actually executed

On 2026-08-12, the following public-seam verification was run against the working
tree:

```text
bun run test

Test Files  65 passed (65)
TypeScript  459 passed (459)
Python SDK  9 passed (9)

bun run build
bun run packages:smoke
bun run lint
bun run typecheck
```

That run verifies the existing claims about:

- AST and fallback behavior across TypeScript, TSX, JavaScript, CSS, and HTML;
- exact source reconstruction and the 6,000-unit/Unicode adversarial boundary;
- deterministic Artifact identity/content across two commit OIDs containing the
  same source snapshot;
- punctuation-bearing literal intent (`fetch<User>`) ahead of a lexical
  `fetch User` distractor, punctuation-only `=>`, and exact handling of SQL
  wildcard characters; the latter two adversaries preserve exact semantics across
  the conditional trigram path and scan fallback;
- symbol/declaration identity, large declarations, multiple declarators, and
  destructuring;
- immutable Artifact tables through denied application-role updates;
- idempotent `(repository, commit OID, indexer revision)` reuse and deterministic
  OID/content conflict rejection;
- exact Git-object ingestion despite a dirty working tree, nonexistent full-OID
  rejection, independent tree digests, persisted entry outcomes, and manifest
  Workspace/revocation isolation;
- compatible unchanged-blob reuse across commits, rename identity remapping,
  changed-file reparsing, and indexer-revision invalidation;
- Workspace and Agent-grant isolation, including revocation; and
- installation of the complete RLS-backed baseline schema.

A checked-in source-derived harness now exercises the public module on real
PostgreSQL. On local PostgreSQL 18.4, Lore `HEAD^ -> HEAD` contained 333 manifest
entries, 332 indexed files, one exclusion, and about 4,463 Artifacts. Full indexing
took 68.1 s; an incremental revision with 328/332 reusable files took 4.16 s; an
exact tree-OID no-op took 45.6 ms. Two generations occupied 39.9 MiB of Artifact
table storage and 26.0 MiB of Artifact indexes. These are one-machine measurements,
not universal SLOs.

After `VACUUM (ANALYZE)`, warm public-module search at concurrency 8 recorded 160
samples per query. Representative p50 values were 21.7-36.8 ms. p95 was 24.1 ms
for `createMemoryModule`, 37.4 ms for `Memory Proposal`, 44.2 ms for a no-hit query,
and 103.3 ms for punctuation-only `=>`; isolation and suspended-Membership
tripwires both passed. One identifier run retained a 180 ms first-touch tail, so
the harness now warms every pool connection and reports cold/warm states
separately rather than hiding cache effects.

A reproducible real-PostgreSQL predicate microbenchmark is now checked in as
`scripts/benchmark-code-search.ts`. On local PostgreSQL 14.20 with warm cache,
100,000 visible / 200,000 total synthetic Artifacts, and a selective
`fetch<User>` query, replacing the unindexed content `position()` branch with the
trigram-backed exact `LIKE` branch reduced combined-query p95 from 56.517 ms to
4.453 ms. At 500,000 visible / 1,000,000 total Artifacts it reduced p95 from
314.563 ms to 22.513 ms. Conversely, the no-trigram `=>` case regressed from
72.745 ms to 538.136 ms when trigram lookup was forced, validating the conditional
exact-scan fallback. These are concurrency-one synthetic SQL results, not a public
module, RLS, cold-cache, network, or Hyperdrive SLO; the full benchmark design and
community evidence are recorded in `docs/research/code-search-benchmark-community.md`.

P0 correctness coverage now includes tracked generated/vendor policy,
deletion/mode-only incremental behavior, interruption/resume, atomic generation
cutover, and every Memory Code Evidence state. Dense/graph retrieval, claim-vs-
rationale proposal quality, and task/chunk-policy ablations remain P1 evaluation
work; their absence must not be disguised as a failed correctness invariant.

## Adversarial acceptance status and P1 experiments

These are outcome tests through public module/worker seams, not tests of private
chunker helpers.

### P0 — completed requirements for full-repository indexing

1. **OID authenticity trap**
   - Create a real temporary SHA-1 repository and index its full commit OID.
   - Mutate the working tree while retaining that OID: indexing must read the
     committed object bytes, not the working tree. A low-level supplied snapshot
     must not share the authenticated revision identity.
   - Supply a well-formed but nonexistent OID: indexing must reject it.
   - Repeat against a SHA-256 repository when the installed Git supports it.
   - **Current:** SHA-1 and SHA-256 exact-commit resolution,
     dirty-working-tree isolation, and nonexistent full-OID rejection pass.

2. **Tree completeness and exclusion accounting**
   - Include text, binary, symlink, submodule, generated, vendor, ignored,
     oversized, Unicode-path, and adversarial path entries.
   - The persisted manifest must account for every tree entry as indexed or with a
     typed exclusion reason; no silent omission is allowed.
   - **Current:** text, binary, empty, invalid-UTF-8, oversized, symlink, and
     submodule outcomes plus persistence/RLS pass. Paths that cannot be represented
     losslessly are explicitly rejected rather than normalized. Tracked generated
     and vendor source is indexed consistently rather than guessed from path names.

3. **Atomic cutover under injected failure**
   - Start from active generation A, inject failure after several persisted batches
     of generation B, and crash/restart the worker.
   - Searches must see all of A and none of B until B has exact manifest coverage.
   - Retry must converge without duplicate Artifacts; activation must expose all of
     B in one transaction and retain A for bounded rollback.
   - **Current:** injected second-file failure leaves search empty for the building
     revision; retry reuses the first persisted file and atomically publishes exact
     coverage. A separate tracer keeps the prior active generation serving.

4. **Tenant/top-k starvation trap**
   - Insert many higher-scoring forbidden-Workspace candidates and fewer lower-
     scoring visible candidates for the same query.
   - Every lexical, symbol, path, dense, and fusion channel must return only visible
     candidates and still fill the visible top-k when enough exist.
   - Repeat after Membership and Agent-grant revocation and with a restrictive path
     prefix.
   - **Current:** all four implemented channels share pre-top-k RLS/repository/
     revision/generation/path predicates. Cross-Workspace tripwires and Membership/
     Agent revocation pass; dense is not an enabled channel.

5. **Revision and generation confusion trap**
   - Put the same symbol/path in commits A and B with contradictory content and
     create two indexer revisions.
   - A query pinned to A/generation X must never return B or generation Y, even if
     the latter scores higher.
   - **Current:** exact-commit search and active-generation selection are enforced
     in the one-row selected-generation CTE and covered by contradictory revisions
     plus rolling-generation tests.

6. **Incremental reuse correctness**
   - Across consecutive commits test unchanged path/blob, renamed identical blob,
     changed content at same path, deletion, mode-only change, and parser revision
     bump.
   - Reuse must occur only for identical content plus compatible indexer revision;
     the revision manifest and result paths must still be exact.
   - **Current:** unchanged, rename, changed peer, deletion, mode-only change,
     exact reconstruction, generated/vendor inclusion, and parser-revision
     invalidation pass.

### P0 — completed requirements for code-aware Memory

7. **Evidence re-resolution matrix**
   - For one accepted Memory, exercise unchanged, moved, changed, deleted,
     duplicated/ambiguous, inaccessible, and repository-revoked code evidence.
   - Only `current` evidence may enter agent context by default. Other states must
     be explicit and must never auto-edit the Memory.
   - **Current:** `current`, `moved`, `changed`, `deleted`, `ambiguous`, and
     `unverifiable` are typed and tested with private-Memory/cross-Workspace denial;
     there is no implicit context injector or Memory rewrite.

8. **Claim/evidence disagreement**
   - Make current code contradict a still-valid historical rationale document.
   - Preserve both provenance tracks and surface a human-review Proposal; do not
     infer that current implementation proves historical intent.

### P1 — evaluation rather than architecture by assertion

9. **Retrieval ablation**
   - Compare symbol/path/FTS, dense only, rank-fused hybrid, hybrid plus precise
     references, and each variant plus reviewed Memory.
   - Pin repository commit, indexer revision, embedding/reranker, task set, top-k,
     token budget, and agent/model. Measure evidence Recall@k/Precision@k, relevant
     file/line recall, end-task success, stale-fact rate, no-answer false positives,
     latency, token cost, and tool calls.

10. **Chunk-policy ablation**
    - Compare Lore's 6,000 UTF-16-unit policy with token and non-whitespace budgets,
      with/without sibling merging and parent/signature expansion.
    - Optimize for end-task and exact answer-evidence recall, not chunk aesthetics or
      parent-file hits.

## Recommended build order

1. ~~Add a trusted local Git source adapter and a typed complete tree manifest.~~
   Completed for the local Node seam; public API/SDK/MCP jobs expose this path via
   an operator-configured repository key rather than caller-supplied snapshots.
2. ~~Add blob-level parse/chunk reuse keyed by content plus
   `CODE_INDEX_REVISION`.~~ Completed for trusted Git ingestion, including rename
   remapping and reconstruction validation. Content-addressed Artifact storage is
   deliberately still a separate optimization.
3. ~~Add leased resumable indexing jobs and `building -> ready -> active/failed`
   generations with atomic cutover.~~ Completed with durable job leases,
   checkpointed files, exact coverage, and rolling activation.
4. ~~Expose exact symbol/path/FTS search only after every channel has the same exact
   Workspace/repository/commit/generation predicates.~~ Completed with bounded
   literal/symbol/path/FTS channels and weighted RRF.
5. Add dense and compiler-graph retrieval only as versioned evaluation variants,
   not as assumed improvements. Rank fusion already has a deterministic baseline.
6. ~~Add typed Memory-to-Code evidence, re-resolution, and staleness states.~~
   Completed without coupling citation retention to rebuildable Artifact rows.
7. ~~Expose Code Index and Memory as separate MCP tool families.~~ Completed;
   indexing accepts only an operator-configured repository key plus exact commit,
   never a model-supplied path or Workspace override.

## Bottom line

Lore can now accurately say that it has a **best-practice-convergent bounded
full-revision Code Index**: authenticated Git snapshots, complete manifests,
AST-aware lossless chunks, incremental reuse, resumable atomic publication,
pre-top-k RLS, measured multi-channel RRF search, separate MCP/API families, and
typed Memory Code Evidence staleness.

It should not claim web-scale, dense-hybrid, or compiler-precise code intelligence.
Those are explicit P1 evaluation/scale extensions. They do not weaken the completed
v1 boundary or justify merging Code Index into canonical Memory.
