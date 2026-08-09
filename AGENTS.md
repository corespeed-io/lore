# AGENTS.md — Lore

Orientation for AI coding agents (Claude Code, Codex, Cursor, Gemini, Copilot, …)
working in this repo. **This file is the single source of truth for agent-facing
project instructions.** `CLAUDE.md` is a symlink to it and
`.github/copilot-instructions.md` points to it — only ever edit this file, not a
copy. The canonical product vocabulary lives in [`CONTEXT.md`](CONTEXT.md).

## What Lore is

**Lore is an open-source, self-hostable memory system for users and their agents.**
It owns memory storage, retrieval, tenancy, authorization, and evaluation. It is
not a gbrain frontend and does not require a CoreSpeed multi-tenant service.

The product has one tenant concept: **Workspace**. There is no personal-workspace
mode and no separate Organization aggregate. A User may belong to many Workspaces
and may own many Agents.

## Implementation status — read before changing code

The earlier read-only gbrain proxy, admin proxy, and their product surfaces have
been removed. Lore now has a native implementation:

- migrations `0001_initial.sql` through `0007_agent_lifecycle.sql`
  define identity, tenancy, user-private Agents, Memory/chunks/links, pgvector
  state, versioned Evaluation tables, leased embedding jobs, replay-safe mutations,
  a content-free event outbox, Workspace portability, and embedding generations
  with RLS;
- `src/lib/identity.ts`, `access.ts`, `memory.ts`, and `evaluation.ts` are the
  domain modules; `request-context.ts` installs verified User/Workspace/Agent
  context for every request transaction;
- `/api/workspaces`, `/api/memories`, `/api/agents`, and `/api/evaluations` are
  native routes built through the pure handler seam in `src/lib/http.ts`;
- `src/components/App.tsx` owns the native Memory workflow and client routing,
  `src/components/Sidebar.tsx` owns the Lore shell, and
  `src/lib/lore-api.ts` is the typed browser transport for native routes;
- `src/lib/lore-swr.ts` owns Workspace-scoped SWR keys and hooks for Workspaces,
  paged Memories, search, Memory detail, graph reads, and mutations. Keep server
  data in this cache instead of restoring component-level `loaded`, request-id, or
  revision state. Memory writes patch the paged/detail cache and revalidate the
  paged list plus active search and graph keys. Browse eagerly fills at most 5,000
  Memories (50 × 100-row pages), aligned with the Graph read budget; ranked search
  is the access path beyond that browse window;
- `src/app/[...path]/page.tsx` serves the same shell for `/graph`,
  `/memories`, and Memory detail deep links so browser refresh never loses the
  client route;
- `src/lib/graph.ts` returns RLS-filtered, durable Memory Links and derives
  affinity only among otherwise isolated visible Memories; `/api/graph` exposes
  that native read model without a gbrain dependency. Graph nodes expose an
  Actor-visible Memory Reference (`metadata.reference`, imported legacy slug, or
  the Memory UUID) for native wikilink navigation;
- `src/lib/markdown.ts` renders `[[reference]]` and `[[reference|label]]` only
  when that reference resolves to one visible graph node. `MemoryView` intercepts
  the resulting native Memory-id link for client routing; unresolved or ambiguous
  references remain inert, and raw HTML stays escaped;
- `src/lib/viz/graph.ts` is the restored, performance-tuned D3 renderer. Keep its
  headless settle, delta-painted focus state, capped edge hit layer, label
  collision, drag focus hold, zoom/pan, and fit behavior when changing Graph UI;
- `src/lib/maintenance.ts` owns leased, idempotent document embedding and
  deployment-wide re-index discovery. A provider/model/revision change builds
  generation-scoped vectors beside the active generation without rewriting
  canonical chunks. Activation requires exact coverage and atomically moves the
  prior active generation to bounded rollback. Postgres is the durable job source;
  rollout maintenance drains both the serving and explicitly configured building
  provider/model generations, because request writes continue to enqueue serving
  jobs until cutover. The self-host Node worker polls both sequentially by default,
  while Cloudflare Queues are wake-up hints for both with a scheduled two-generation
  database sweep as the delivery backstop;
- `src/lib/idempotency.ts`, `portability.ts`, `operations.ts`, and `telemetry.ts`
  own the Portable Core seams. Memory mutation events are database triggers in the
  same transaction as source/link writes; deletion remains hard delete and leaves
  only a content-free, expiring tombstone. `/api/v1`, `/openapi.json`, `/livez`,
  `/readyz`, `/api/v1/actor`, and `/api/v1/capabilities` are the stable operational
  surface;
- `packages/typescript-sdk` generates its public types from the canonical OpenAPI
  document and owns the deep integration client. `packages/cli` and the external
  stdio `packages/mcp` adapter delegate API paths, Actor authentication, Workspace
  scoping, cursors, ETags, idempotency, bounded reads, and errors to that SDK. Keep
  MCP outside Portable Core and never accept a model-supplied Workspace override.
  `packages/python-sdk` provides the equivalent dependency-light Python seam from
  the same generated OpenAPI contract; keep both SDKs behaviorally aligned;
- Node/self-host exports privacy-filtered OTLP only when explicitly configured.
  Cloudflare uses Wrangler native observability; never load the Node `@vercel/otel`
  SDK inside workerd. Cloudflare handles `/livez` and `/readyz` before OpenNext so
  orchestration health does not depend on application auth or rendering;
- native Ollama query planning uses `/api/chat` with thinking disabled,
  deterministic decoding, a 4K default context, and a 256-token output cap; match
  `LORE_QUERY_PLANNER_NUM_CTX` to any benchmark reader sharing the same model server
  so Ollama does not reload between calls. Do not route local Qwen planners through
  the less controllable OpenAI-compatible surface;
- `src/lib/reranking.ts` defines the deployment-level second-stage contract;
  `src/lib/reranking/vllm.ts` implements strict vLLM and llama.cpp `/v1/rerank`
  plus vLLM-Metal `/score`, while `src/lib/reranking/hosted.ts` has concrete Cohere
  v2, Memos MemReranker, and Voyage v1 adapters. Search fuses exact simple/English
  FTS, a two-term relaxed
  English recall channel with query-side proper-name/identifier specificity
  weighting, and dense candidates before reranking only authorized evidence
  passages. Do not replace that bounded query heuristic with per-request corpus
  frequency scans; under RLS the measured scan doubled hybrid latency;
- `src/lib/query-planning.ts` defines optional deployment-level multi-query planning.
  Its OpenAI/vLLM and Google adapters see only the original question; search keeps
  that question, runs every generated query under the same Actor/RLS transaction,
  fuses only visible results, and then optionally reranks them;
- Docker/Compose targets OSS self-hosting; OpenNext + two cache-disabled Hyperdrive
  bindings target CoreSpeed Cloud on Cloudflare Workers.

Still incomplete: full Evaluation management UI. Workspace-scoped Agent creation,
grant and credential lifecycle management, plus global rename/disable/delete
controls are available in the native `/agents` surface. Agent deletion requires a
disabled Agent, removes every grant and credential, and preserves Memories while
clearing their creating-Agent reference. Human-only Workspace
export/download, checksum-backed import dry-run, explicit owner remap, import
receipts, and deployment readiness/capabilities are available in `/operations`.
Chunking and lexical indexing
are synchronous; document embedding, retry, and deployment-wide re-indexing are
background maintenance. The Ollama, Google Gemini, and OpenAI adapters are
configured once per deployment, and embedding failure is explicit (`NULL`) and
never blocks a Memory write. Local deployment defaults are Qwen3-Embedding 0.6B at
1024 dimensions with `OLLAMA_KEEP_ALIVE=0`.
The self-host worker defaults to one leased embedding job at a time; optional
`LORE_MAINTENANCE_CONCURRENCY` uses independent leases and must be sized with the
database pool and provider capacity. Keep local Ollama at one unless measured.
Invalid embedding configuration and provider request failures must warn server-side
and degrade to lexical/`NULL` behavior; they must not block Memory reads or writes.
Optional reranking is configured once per deployment. The llama.cpp, vLLM,
vLLM-Metal score, Cohere, Memos, and Voyage adapters consume their concrete official
rerank contracts; the Memory module must finish RLS-filtered candidate
retrieval before calling it, pass evidence passages rather than unrestricted Memory
content, and fail open to deterministic fused order on any reranker failure. Managed
reranking exports those authorized passages to the configured provider and therefore
requires an explicit operator privacy/compliance decision; use HTTPS outside localhost. A
llama.cpp reranker uses its GGUF model's embedded template and must never claim that
`LORE_RERANK_INSTRUCTION` was sent to or honored by that server. A
calibrated `LORE_RERANK_MIN_SCORE` may abstain after successful reranking, while
`LORE_RERANK_DIVERSITY_LAMBDA` may apply MMR-style lexical evidence diversity; both
default to behavior-neutral values and must be justified by versioned evaluation.
Require exactly one finite `[0,1]` score for every authorized rerank candidate;
duplicate, missing, foreign, or unnormalized results must fail open to the
deterministic first-stage order rather than enter calibration or rank fusion.
Rerank only the compact best authorized chunk plus configured neighbors; returned
answer evidence may be wider, but must not inflate the cross-encoder input.
Pin `RETRIEVAL_EVIDENCE_POLICY` in every benchmark report when either behavior
changes, so historical quality and latency remain comparable.
Treat provider, model, reranking revision, instruction, candidate budget, minimum
score, diversity lambda, and weighted first-stage/reranker rank fusion as one
reproducible deployment configuration. `LORE_RERANK_WEIGHT=1` is pure reranking;
smaller calibrated values retain more of the deterministic hybrid order.
`LORE_EVIDENCE_NEIGHBOR_CHUNKS` may include zero to two adjacent chunks around the
authorized anchor chunk for returned/reranked context. It defaults to zero and must
stay inside the same visible Memory; calibrate its quality/token tradeoff locally.
`LORE_EVIDENCE_TOP_CHUNKS` may retain one to five independently ranked chunks from
that visible Memory before neighbor expansion. It defaults to one; calibrate it on
evidence-level answer recall rather than Memory-id recall, and keep the bounded
reader/reranker context cost in evaluation metadata.
If `topChunks * (2 * neighborChunks + 1)` covers a visible Memory's entire chunk
count, evidence may include that whole Memory in ordinal order; never cross the
Memory/RLS boundary, and do not make this expansion unbounded. Evaluate this with
exact answer-evidence recall rather than treating a parent Memory-id hit as an
answerable result.
Equal lexical/dense candidate scores and final top-k scores prefer newer
`memory.updated_at`, then higher chunk ordinal, then id so ordered Memory logs keep
their latest equal-scoring fact. Optional
`LORE_RETRIEVAL_RECENCY_WEIGHT` widens to the configured second-stage candidate
budget and reciprocal-rank fuses relevance with visible Memory recency. It defaults
off and must be justified by a temporal/conflict-resolution benchmark; never enable
an unconditional recency boost for archival or timeless factual search.
`LORE_RETRIEVAL_FEEDBACK_QUERIES` is a zero-to-three deterministic chain-depth
budget. Each round extends the accumulated query with the strongest-overlap sentence
from one newly retrieved RLS-visible passage, excludes every prior anchor Memory,
and reapplies Actor context, Workspace, scope, time, metadata, and RLS filters.
Append only novel candidates without disturbing retained first-pass order. Keep the
leading 80% when the candidate pool is full, reserve at most the trailing 20% for
feedback, and never exceed the configured candidate budget; an explicitly configured
reranker may then reorder the expanded pool. It defaults to zero because
pseudo-relevance feedback can drift; benchmark each depth as a separate variant.
Optional query planning is configured once per deployment and defaults off. Keep the
original query, cap the total query count at five, deduplicate generated queries, and
run every expansion through the ordinary RLS-filtered candidate query. The planner
must never receive Memory content or broaden authorization. Planning failure must
fall back to the original query. Treat its provider, model, revision, instruction,
and query budget as versioned Evaluation metadata rather than a User/Workspace option.
Memory search/list may constrain `scope`, `updatedAfter`, and exclusive
`updatedBefore`, plus JSONB-containment `metadataFilter`. Apply these predicates to
every lexical and dense candidate source before top-k and keep them in the Actor/RLS
transaction; reranking must never restore a filtered result. Keep the GIN metadata
index when changing benchmark or application filter paths.
Dense candidate cosine distance defaults to `0.5`; a deployment may calibrate
`LORE_SEMANTIC_DISTANCE_THRESHOLD` from `0` through `2` without re-indexing. Do not
raise it merely to inflate candidate recall: no-answer false results are part of the
same quality gate.
The generation-scoped pgvector column and HNSW index are fixed at 1024 dimensions. Self-host operators
choose `LORE_EMBEDDING_PROVIDER` and `LORE_EMBEDDING_MODEL`; dimension and
preprocessing revision are Lore v1 protocol invariants. Never compare vectors unless
provider, model, and revision all match one active or rolling-deploy-compatible
generation. Embedding model selection is not a Workspace/User product setting. The
semantic query must keep its `MATERIALIZED` exact-generation CTE so global HNSW
traversal cannot mix incompatible spaces before top-k.
`lore-embedding-v2` is scoped to Qwen3/Ollama and applies Qwen3-Embedding's fixed
official retrieval instruction to query texts only; Qwen document texts and
canonical chunking remain unchanged. Google, OpenAI, and non-Qwen Ollama models
retain the v1 revision until their own preprocessing changes. Treat any future
query/document preprocessing change as a new protocol revision and deployment-wide
re-index, never as a benchmark-only or operator-tunable prompt.

Do not:

- reintroduce a generic upstream-tool or admin passthrough;
- add an upstream brain as Lore's persistence or authorization model;
- preserve the old “Lore never writes” assumption — the new product stores
  Memories;
- bypass native modules with direct route-level SQL.

Historical UI ideas may be reintroduced only when they serve the native product:

- the visual design, shell, memory browse/search UI, and Markdown rendering;
- security-header and Cloudflare Access JWT-verification techniques;
- pure utilities and tests whose behavior remains part of the new product.

The active frontend contract is [`DESIGN.md`](DESIGN.md). Keep one application
stylesheet (`src/app/globals.css`). Graph combines native durable Memory Links with
derived affinity for isolated Memories; never wire it back to the removed gbrain proxy.

The restored Dashboard/Graph/Memories interface consumes native `Workspace`,
`Memory`, `MemorySearchResult`, and `MemoryGraph` types directly. Do not add a
tool-shaped compatibility client, page/slug view model, `/api/call`, or any
generic upstream adapter to support the historical component structure.

The native Graph endpoint caps reads at 5,000 visible Memories. It returns all
RLS-visible Memory Links whose endpoints are in that node set, then derives at most
three affinities per Memory among the first 500 otherwise isolated nodes. The
optimized SVG renderer is measured against the migrated ~1,000-node / ~2,200-link
graph. At benchmark scale, preserve D3 as the layout engine but move static
simulation to a Web Worker and links to Canvas before increasing the SVG DOM budget.
The throwaway `/prototype/graph-scale` benchmark uses one compact radial layout and
one adaptive interaction model at every scale: at most 900 active nodes plus
pinned real boundary endpoints. Its Worker frames contain active coordinate deltas,
while Canvas culls the viewport and caps rendered links at 40,000. Do not describe
the interactive field as exact far-field physics; the initial Worker layout still
uses the complete D3 graph and remains the stress bottleneck. Cold layout starts
from a deterministic, collision-spaced low-discrepancy disk and runs at most 48
force ticks with accelerated alpha decay. Pre-layout coordinates stay hidden while
nodes that remain visually still across consecutive Worker ticks are progressively
revealed; the centered status card visualizes progress without a numeric counter,
and only relationships whose endpoints are both visible may appear. Newly revealed
nodes grow from zero to their final radius with a short non-bouncy Canvas transition;
the first meaningful revealed batch receives a visible-bounds camera fit, and
completion preserves the same Canvas while easing into the final fit. Reduced-motion
actors receive the final radius and camera fit immediately. Layout-time pointer input
stays blocked so drag messages cannot queue behind the synchronous cold simulation.

Build the native domain modules directly. Compatibility adapters, if ever needed,
must sit outside the Memory interface and may not weaken its ownership or RLS
invariants.

## Product scope

The v1 system must provide:

- Memory create, read, update, delete, and provenance;
- hybrid retrieval over only the Memories the caller may see;
- Users, Identities, Workspaces, Memberships, Agents, and agent Workspace grants;
- user-private and Workspace-shared Memory enforced with Postgres RLS;
- deterministic background maintenance: chunking, embedding, indexing, retries,
  re-indexing, and deletion/permission-change invalidation;
- a Benchmark/Evaluation suite covering retrieval quality, isolation, latency, and
  cost.

The v1 system does **not** include AutoDream / automated memory consolidation,
automatic summarization, automatic merging, or proactive insight generation. If
introduced later, consolidation must be an explicit opt-in extension, not a
requirement of the Memory interface.

## Domain model and invariants

Use the terms and definitions in [`CONTEXT.md`](CONTEXT.md). The central relations
are:

```text
User ──< Identity
User ──< Membership >── Workspace
User ──< Agent ──< Agent Workspace Grant >── Workspace
Workspace ──< Memory >── owner User
Agent ──< Memory.created_by_agent_id (provenance only)
```

Memory isolation rules:

- Agent records, Workspace grants, and credential metadata are user-private; a
  co-member cannot inspect another User's Agents merely because they share a
  Workspace.
- Every Memory belongs to exactly one Workspace and one owner User.
- `scope=shared` is visible to active members and granted Agents in that Workspace;
  `scope=private` is visible only to the owner User and that User's explicitly
  permitted Agents.
- Private means **user-private**, never agent-private. Two Agents owned by the same
  User may share that User's private Memories when both have the required Workspace
  grant.
- `created_by_agent_id` records provenance. It does not own the Memory and does not
  define visibility.
- Visibility and write authority are separate: sharing a Memory does not transfer
  ownership or grant other members permission to mutate it. Only the owner User or
  an authorized Agent acting for that User may mutate it.
- Shared is the default scope. A caller must explicitly request private scope.
- There is no cross-Workspace access and no cross-user private synthesis or batch.

The relational model centers on:

- `users`, `identities`, `workspaces`, `memberships`;
- `agents`, `agent_workspace_grants`, `agent_credentials`;
- `memories`, `memory_chunks`, `memory_links`, and embedding/index state;
- `evaluation_suites`, `evaluation_cases`, `evaluation_runs`, and
  `evaluation_results`.

Do not add tenant columns mechanically after building single-tenant features.
`workspace_id`, ownership, and scope are part of the domain and query design from
the first migration.

## Security and RLS

Lore is an OSS system that stores private, multi-tenant data. Authorization is a
database invariant, not a UI convention.

- Postgres is the primary store. RLS must cover every tenant-owned table, including
  chunks, embeddings, graph/relationship data, credentials, and evaluation data.
- A request resolves an authenticated User and an active Workspace, then installs
  that context for the database transaction. Never trust a caller-supplied user or
  Workspace id by itself.
- An Identity is an authentication-provider identity mapped to an internal User.
  Proxy headers, OIDC claims, or local credentials authenticate; Memberships and
  grants authorize.
- Request-path application code must not use an unrestricted service role. Workers
  and maintenance jobs must carry explicit Workspace/User/scope context and remain
  idempotent.
- Hybrid/vector search must apply Workspace and visibility filters **before top-k**.
  Fetching global top-k and filtering afterward is both a leak risk and incorrect
  retrieval.
- Graph results must authorize nodes and edges together. An allowed node must not
  reveal the id, title, existence, or degree of a private neighbor.
- Deleting a Memory or changing its scope must invalidate its chunks, embeddings,
  cached search results, and derived graph data.
- HTTP update/delete requires a strong Memory ETag through `If-Match`; retries may
  use actor/operation-scoped `Idempotency-Key`. Keep the lock, version check, source
  write, chunk/job changes, replay record, and mutation event in one transaction.
- Workspace export is always a human Actor/RLS-visible logical archive. Import must
  validate its checksum and limits, dry-run cleanly, require explicit owner remap,
  and record source provenance. It is not a PostgreSQL backup.
- Mutation events and deletion tombstones never retain Memory content, query text,
  credentials, or provider payloads and must expire. A future change feed/webhook/
  AutoDream consumer reads this outbox; it must not weaken source-table RLS.
- Credentials and secrets stay server-only, are stored hashed or encrypted as
  appropriate, and never use `NEXT_PUBLIC_*` variables.
- `AUTH_MODE=none` is only acceptable for explicit local development with
  `ALLOW_INSECURE=1`; production fails closed.
- `AUTH_MODE=password` is single-operator protection. A valid password always maps
  to `LORE_LOCAL_SUBJECT`; never turn the Basic username into an internal User id.

Every RLS feature needs positive and negative tests. At minimum test two
Workspaces, two Users in one Workspace, one User with multiple Agents, private and
shared Memories, revoked Memberships/grants, deletion, and scope changes.

## Deployment profiles

Lore owns one domain model and one Postgres schema across deployments. Avoid a
generic “pluggable database” abstraction: Postgres and RLS are architectural
requirements.

- **OSS self-host:** Node/Docker application plus Postgres. Operators may attach
  local, OIDC, or trusted-proxy identity adapters.
- **CoreSpeed Cloud:** Cloudflare is the only managed deployment target. Use Workers
  for the request path, Hyperdrive for Postgres, Queues for asynchronous work, and
  Workflows only when a job genuinely needs durable multi-step orchestration. D1 is
  not the primary relational store.

Cloudflare specifics:

- Deploy Next.js with `@opennextjs/cloudflare`; `wrangler.jsonc` is the checked-in
  adapter config and contains placeholder binding/auth values only.
- Hyperdrive **must have query caching disabled**. RLS depends on transaction-local
  settings and permission revocation must be immediately visible.
- Create a fresh `pg` client inside each Worker request context. Do not cache a
  socket-backed Pool/Client globally across Worker requests.
- Migrations and runtime credentials stay separate. Run migrations from a trusted
  environment, then connect Hyperdrive with a non-owner login that can `SET ROLE
  lore_app`.
- Use a second cache-disabled Hyperdrive configuration whose distinct non-owner
  login can `SET ROLE lore_maintenance` but not `lore_app`. Queue payloads contain
  only a job id; job identity, tenant scope, attempts, and leases live in Postgres.

Cloud-specific code is an adapter around shared domain modules. Do not make the
core depend on CoreSpeed control-plane tenancy, and do not create abstractions for
cloud providers we do not support.

## Target module seams

Prefer a small number of deep modules whose interfaces are also their test
surfaces:

- **Identity module:** authenticate credentials/claims and resolve a User.
- **Workspace access module:** select the active Workspace and validate Membership
  or Agent grant.
- **Memory module:** remember, retrieve, search, update, and forget while hiding
  chunking, indexing, provenance, and permission invalidation.
- **Graph module:** return visible Memory nodes, durable Memory Links, and derived
  affinities while guaranteeing that every relationship endpoint is present in the
  same authorized read model.
- **Maintenance module:** claim versioned embedding jobs with a short lease, update
  only the claimed generation's vectors, retry provider failures deterministically,
  discover stale deployment-wide embedding spaces, activate exact-coverage builds,
  and prune expired retiring generations without exposing job state to request actors.
- **Portability module:** produce checksummed Actor-visible Workspace archives and
  perform validated, dry-runnable, explicitly owner-remapped imports.
- **Operations module:** expose bounded capabilities/readiness state. Liveness is
  process-only; readiness validates DB/role/schema/vector/RLS, while embedding
  failure or the absence of an active/retiring generation matching the configured
  provider/model/dimensions/revision is degraded because lexical retrieval remains
  available.
- **Evaluation module:** run a versioned suite and return quality, isolation,
  latency, and cost results without mutating production Memories.

Keep RLS policy SQL and the query that relies on it local to the Memory/data module.
Do not expose storage-provider details at the product interface. Introduce an
adapter only where behavior actually varies (for example, a production embedding
provider and a deterministic test adapter).

## Benchmark / Evaluation

Benchmark is part of the product quality system even without AutoDream.

- Keep a deterministic synthetic suite in the repository for CI and version
  comparisons.
- `evaluation/suites/retrieval-v1.json` is the end-to-end retrieval fixture. Run
  `bun run benchmark:retrieval` only with `BENCHMARK_DATABASE_URL` pointing to a
  disposable migrated database whose name contains `bench` or `benchmark`; the
  runner resets tenant data, writes through the native Memory module, embeds through
  leased maintenance, and searches under RLS.
- The retrieval runner reports Recall@1, Recall@K, MRR, nDCG, no-answer accuracy,
  false-result count, warm mean/p50/p95 latency, misses, and threshold sweeps for
  the active deployment embedding space. Bob-owned private fixture Memories are
  forbidden tripwires in every query and any leak exits non-zero.
- When a reranker is configured, the runner also measures the pre-rerank candidate
  pool and can sweep minimum scores and diversity lambdas in one indexed run via
  `LORE_BENCHMARK_RERANK_MIN_SCORES` and
  `LORE_BENCHMARK_RERANK_DIVERSITY_LAMBDAS`; rank fusion uses
  `LORE_BENCHMARK_RERANK_WEIGHTS`, candidate depth uses
  `LORE_BENCHMARK_RERANK_CANDIDATE_LIMITS`, and identical reranker calls are
  memoized only inside the benchmark process. That cache uses hashed keys and a
  bounded LRU (`LORE_BENCHMARK_CACHE_ENTRIES`, default 2,000) so large sweeps cannot
  retain every candidate passage in key strings.
- Every retrieval variant records its provider calls and benchmark-cache deltas in
  `providerExecution`. Quality metrics remain valid on a cache hit, but only variants
  with `latencyComparableToOnline=true` may be reported as live provider latency.
- `LORE_BENCHMARK_RETRIEVAL_FEEDBACK_QUERIES=1..3` adds hybrid feedback,
  planner+feedback, reranker+feedback, and combined variants while preserving the
  no-feedback baselines and RLS hard gate.
- Benchmark reports record exact planner/reranker instructions and retrieval knobs,
  plus actual embedding, planning, and reranking request/input character counts as
  provider-neutral cost drivers. Reader and judge transports report provider token
  counts when their APIs return usage; character counts are not presented as billing tokens.
- `LORE_BENCHMARK_RETRIEVAL_LIMITS` adds first-stage depth variants without a
  reranker. Use it to measure candidate recall ceilings before spending model time
  on wider cross-encoder pools; it is a benchmark setting, not a deployment limit.
- LongMemEval-V2 `--retrieval-only` is a local diagnostic over questions with a
  literal reference-answer trajectory anchor. It reports anchor Recall@1/Recall@K/MRR,
  leaves reader/accuracy null and `scoreComplete=false`, and must never be presented
  as the official end-answer benchmark score.
- `bun run benchmark:memoryagentbench:accurate` runs a pinned Accurate Retrieval
  diagnostic. RULER `Document N` boundaries are preserved before each document is
  split into independent 1,200-character Lore Memories, preventing cross-document
  false anchors; other sources use ordinary 1,200-character chunking. It chooses one
  literal-answer anchor using query overlap, the most specific accepted reference,
  answer/query proximity, and conservative English subject normalization; it skips
  nonliteral questions and records anchor
  coverage. The default is one 20-question RULER row; do not present its retrieval
  metrics as the official generated-answer score.
- External benchmark answer tripwires are Bob-private RLS canaries. Keep their exact
  synchronous chunks and ownership validation, but do not enqueue document embeddings
  for evidence the evaluating Alice Actor is forbidden to see.
- Synthetic benchmark reruns may set `LORE_BENCHMARK_REUSE_INDEXED=1`; the runner
  validates exact content/owner/scope and active embedding-space completeness before
  reusing data. LongMemEval exposes the same behavior as `--reuse-indexed`.
- `bun run benchmark:longmemeval` runs the official cleaned LongMemEval data fully
  locally through the same native benchmark path. Dataset manifests pin the
  upstream revision, byte length, SHA-256, license, and session granularity;
  downloaded data stays ignored under `evaluation/datasets/`. Every question is a
  separate Workspace, every conversation session is an Alice-owned private Memory,
  and a Bob-owned private answer tripwire preserves the RLS hard gate. The oracle
  split is only a low-cost smoke test; comparable retrieval scores use the `s` or
  `m` cleaned haystack split. `--reuse-indexed` verifies the exact selected corpus
  before rerunning retrieval-only ablations. Official retrieval comparison skips 30 abstention
  questions; Lore reports positive retrieval and no-answer accuracy separately.
- `evaluation/external/longmemeval-v2.json` pins the newer V2 questions, haystacks,
  and 1.2 GB textual trajectory file. `benchmark:longmemeval-v2:fetch` defaults to
  metadata-only and requires an explicit `small`/`medium` argument before fetching
  trajectories. `benchmark:longmemeval-v2` is a local fixed-reader run: it deduplicates
  shared trajectories, constrains each question with the pre-top-k metadata filter,
  uses Bob-private tripwires, and reports deterministic answer accuracy, latency,
  and tokens. Metadata fetches also pin and verify all 29 question screenshots. It
  defaults to all 295 deterministic cases, including the one image-backed case. The reader's
  domain-specific protocol and the abstention/gotcha judge rubrics are pinned to an
  upstream commit. Under `--include-judge-cases`, a separately configured benchmark
  judge adds all 128 abstention cases and 28 image-backed gotcha cases (451 total)
  and records its model, latency, reasons, and tokens. Fixed-reader adapters send
  verified question images inline to vision-capable OpenAI-compatible or Google
  models; without a judge, judge cases remain unresolved and `scoreComplete` is false.
  The built-in `lore-portable-deterministic-v2` reader profile uses a character
  budget and temperature 0, so reports must not label it as the paper's sampled,
  Qwen-token-budgeted official reader. Record prompt hashes, decoding, transport,
  image routing, and context-budget units in every result.
- `evaluation/external/memoryagentbench.json` pins the MIT-licensed
  MemoryAgentBench Conflict Resolution split. The fetcher materializes only its
  verified 3.2 MB JSONL form. The local runner preserves fact order in incremental
  private Memories, alternates multi-hop/single-hop sources by default, plants
  Bob-private answer tripwires, and reports the official normalized
  `substring_exact_match`. Full 800-question runs are explicit; the default plan is
  a low-resource 40-question / 58-Memory evaluation. `--retrieval-only` requires no
  generative reader and reports the latest literal-answer fact Memory's Recall@1,
  Recall@K, and MRR as a non-official retrieval diagnostic; all public questions
  have a verified literal anchor.
- `evaluation/external/locomo.json` pins the final ACL 2024 ten-conversation
  LoCoMo release by commit, byte length, and SHA-256. The CC BY-NC 4.0 dataset
  remains under ignored local benchmark storage and requires license review for
  commercial evaluation. `benchmark:locomo:retrieval` maps dialog turns to
  Alice-private Memories and runs annotated-evidence retrieval variants. The
  canonical `benchmark:locomo` profile scores only categories 1-4 (1,540 cases)
  with the original normalized token-F1 semantics and an NLTK 3.8.1-compatible
  Porter stemmer; it is not the complete three-task LoCoMo benchmark. Category 5
  is excluded: 444 of 446 upstream rows omit the `answer` field, the released
  option order is unseeded, and every repaired item has the same unanswerable gold
  label, so an always-abstain reader scores 100%. Preserve raw and unresolved
  evidence annotations and report retrieval recall separately from answer F1.
  `--skip-retrieval-diagnostic` may avoid a
  duplicate setup sweep only when an exact retrieval report is retained
  separately; the QA run must still execute real search for every question and
  must record `setupDiagnosticSkipped: true` rather than importing unverified
  setup metrics.
- The pinned local 4B LoCoMo ablation found Qwen3-Reranker-0.6B Q8 improved answer
  F1 on both `conv-26` and held-out `conv-30`, while planner+reranker was slower and
  worse than reranker alone. Treat this as a named 35-question quality profile, not
  a deployment default; reranking still regressed the Conflict workload.
- LoCoMo may run the off-by-default explicit context-group ablation with source
  `sessionNumber` plus numeric `sessionTurn`. It preserves a configured count of
  ordinary hybrid candidates, expands only groups seeded by visible results, and
  reapplies Workspace, scope, time, metadata, and RLS filters. This is a Lore
  adaptation of HiGMem's natural hierarchy idea, not its generated Event hierarchy;
  do not generalize it into a deployment default until full-category retrieval and
  answer runs pass without hiding multi-hop regressions.
- `ollama-listwise` is an experimental deployment-wide reranker, adapted from
  HiGMem's flat evidence selector without its automatic Event summaries. It sends
  only authorized compact passages under opaque ids, requires exactly one finite
  `[0,1]` score per id, pins deterministic Ollama controls, and fails open. Keep it
  off by default until a versioned suite proves quality, latency, and resident-memory
  gains over the 0.6B pairwise profile.
- Retrieval metrics may include Recall@K, MRR, and nDCG; isolation failures are
  hard failures, not a score that can be averaged away.
- Workspace-owned evaluation suites follow the same RLS rules as Memories.
- Never centralize or export private production Memories for evaluation by default.
- Evaluation runs are read-only against production data. Any write/replay test uses
  an isolated evaluation Workspace or disposable database.
- Benchmark-only readers support native Ollama. Pin its model digest and deterministic
  request controls in the report, require loopback plus a locally listed non-cloud
  model, use bounded residency during warm runs, explicitly unload on exit, and never
  download a model as an implicit benchmark side effect.
- MemoryAgentBench may enable benchmark-only structured post-retrieval assembly for
  explicitly versioned current-value questions. Store exactly one numbered fact per
  Memory for that profile, then compact only RLS-authorized returned Memory evidence
  to a fact-level BM25 top-10 pool; validate copied fact text
  against that pool, derive freshness serials from source evidence rather than trusting
  model-generated numbers, and then apply max(serial) deterministically. Multi-hop CAR
  must run a fresh RLS-authorized Lore search for every resolved hop and cap the
  decomposition at six hops. Reports retain decomposition, per-hop trace, extra search
  latency, raw extraction, source/pool counts, and the original paper plus official-code
  commit. Do not apply it to general temporal questions or present this evaluator path
  as automatic production consolidation.

## Current stack and development loop

The existing application uses:

- Next.js 16 (App Router), React 19, Bun 1.3.14+ for package management,
  Node 24 LTS for self-hosted execution, TypeScript 7, and Python 3.12+ for the
  generated Python SDK and source verification;
- SWR 2 for the native browser read/mutation cache, jose, Biome, and Vitest;
- a Vercel/Geist visual system: `#fafafa` canvas, `#171717` ink, `#ebebeb`
  hairlines, Geist Sans/Mono, flat 12px cards, and 6px controls.

`bun.lock` is the only dependency lockfile. Bun installs dependencies and dispatches
scripts; Next.js self-hosting and migration scripts execute on Node 24, and the
Cloudflare bundle executes on Workerd. Do not add an npm/pnpm/Yarn lockfile or claim
that Cloudflare runs Bun/Node as a process.

These commands remain the current verification loop:

```bash
bun run dev        # localhost:3000
bun run db:migrate # apply checksum-protected SQL migrations
bun run db:preflight # validate server/schema/history before migration
bun run db:bootstrap # migrate + provision separate request/maintenance logins
bun run db:backup # create an operator-owned PostgreSQL custom-format backup
bun run db:restore # restore into an explicitly named target database
bun run db:pitr:check # verify PostgreSQL WAL/PITR prerequisites
bun run db:embedding:report # report build-generation coverage
bun run db:embedding:activate # atomically activate one complete generation
bun run benchmark:graph:seed # rebuild an isolated renderer stress database
bun run benchmark:retrieval # benchmark retrieval in an isolated migrated database
bun run benchmark:longmemeval:fetch # download and verify the pinned cleaned S split
bun run benchmark:longmemeval # run LongMemEval-S locally against Lore
bun run benchmark:longmemeval-v2:fetch # fetch pinned V2 metadata or an explicit trajectory tier
bun run benchmark:longmemeval-v2 # run the fixed-reader V2 profile locally
bun run benchmark:locomo:fetch # fetch the pinned CC BY-NC ACL 2024 dataset
bun run benchmark:locomo # run the local categories 1-4 QA/F1 profile
bun run benchmark:memoryagentbench:fetch # fetch the pinned Conflict Resolution slice
bun run benchmark:memoryagentbench # run the local conflict/multi-hop profile
bun run typecheck  # generate Next types, then tsc --noEmit
bun run lint       # biome check .
bun run format     # biome check --write .
bun run design:check # enforce and self-test the Lore UI contract
bun run sdk:generate # regenerate TypeScript/Python contracts and package versions
bun run sdk:check  # fail when generated developer contracts drift
bun run test:python # run the Python 3.12+ SDK tests
bun run test       # vitest plus the Python SDK tests
bun run build:packages # build the TypeScript SDK, CLI, and external MCP packages
bun run packages:smoke # pack/install/import the release artifacts
bun run build      # Next production, maintenance, and developer-package builds
bun run build:maintenance # bundle the self-host Node maintenance entrypoint
bun audit --audit-level=high # dependency vulnerability gate
bun run preview:cloudflare # build and preview through workerd
```

The renderer stress dataset is intentionally separate from the product schema.
Create a disposable database whose name contains `bench` or `benchmark`, then run:

```bash
BENCHMARK_DATABASE_URL=postgres://localhost:5432/lore_graph_benchmark \
  bun run benchmark:graph:seed
```

The default dataset contains 5,000 nodes and 105,000 unique undirected links in
the `graph_benchmark` schema. The seeder refuses to rebuild its schema in a
database without `bench` or `benchmark` in the name. It is renderer load data,
not a persisted Memory Affinity model and not an Evaluation Suite.

Before opening a PR, design:check, typecheck, lint, test, build, packages:smoke,
and the deployment dry runs must all pass. `bun run test` requires Python 3.12+
because it includes the generated Python SDK suite.

Next.js 16 keeps development output in `.next/dev`, separate from production
build output. A production build no longer clobbers the running dev manifest, but
do not treat generated `.next` or `.open-next` output as source or commit it.

`cloudflare-env.d.ts` is the exception: it is the checked-in generated binding and
Workerd type contract. Regenerate it with `bun run cf:typegen` after changing
`wrangler.jsonc` or `.dev.vars.example`.

## Existing UI/test gotchas

- Setting an input's `.value` and dispatching `input` does not trigger React 19's
  `onChange`; use real keystrokes or the native value setter.
- Date strings are UTC; render date labels with `timeZone: "UTC"`.

## Commit / PR conventions

- Conventional commits: `feat(scope): …`, `fix: …`, `chore: …`, `docs: …`.
- `main` is protected; changes land through PRs.
- Preserve unrelated user changes and untracked files.
- If behavior, commands, architecture, or a gotcha changes, update this file in the
  same PR. Update [`CONTEXT.md`](CONTEXT.md) whenever canonical domain language
  changes.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
