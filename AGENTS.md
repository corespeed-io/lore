# AGENTS.md — Lore

Orientation for AI coding agents (Claude Code, Codex, Cursor, Gemini, Copilot, …)
working in this repo. **This file is the single source of truth for agent-facing
project instructions.** `CLAUDE.md` is a symlink to it and
`.github/copilot-instructions.md` points to it — only ever edit this file, not a
copy. The canonical product vocabulary lives in [`CONTEXT.md`](CONTEXT.md).
The directory map and import conventions live in [`docs/architecture.md`](docs/architecture.md).
Start at [`docs/README.md`](docs/README.md) for current guides and retained research.

## What Lore is

**Lore is an open-source, self-hostable memory system for users and their agents.**
It owns memory storage, retrieval, tenancy, authorization, and evaluation. It is
not a gbrain frontend and does not require a CoreSpeed multi-tenant service.

The product has one tenant concept: **Workspace**. There is no personal-workspace
mode and no separate Organization aggregate. A User may belong to many Workspaces
and may own many Agents.

## Implementation status — read before changing code

The earlier read-only gbrain proxy, admin proxy, and their product surfaces have
been removed. Lore now has a native implementation, split into two concepts
(Linear HAAS-71):

- **lore core** — `packages/lore-core` (`@corespeed/lore-core`) is the
  reusable memory engine: Memory CRUD + hybrid retrieval, content bounds,
  chunking v2, Memory Links/graph reads, leased embedding maintenance,
  the `PostgresDatabase` seam and its `pg` adapter
  (`./postgres`), the optional Episode/Observation capability group
  (`./episodes`), embedding/reranking/query-planning capability interfaces,
  and a host-pluggable schema-contract test kit (`./testing`). Factories bind a
  `MemoryStorageContext`; methods take no Actor. The host initializes and
  authorizes every storage transaction. Host-baked invariants are module
  options: `embeddingDimensions` (lore oss pins 1024) and
  `defaultMemoryScope` (lore oss keeps "shared"). The package is written at
  the union strictness of its hosts (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`) and is consumed in-repo as workspace
  TypeScript source (root tsconfig paths, vitest aliases, Next
  `transpilePackages`). **Distribution is an upstream/fork convention** (Yunpeng, 2026-09-15):
  CoreSpeed HaaS retains its existing `packages/memory-core` vendored fork;
  the planned cutover to a verbatim `packages/lore-core` copy was cancelled.
  Lore changes land here; HaaS ports selected changes manually and records their
  provenance. Do not require an automatic same-task mirror or assume semantic
  identity between the packages. npm publishing remains out of scope.
- **lore oss** — everything else in this repository: identity/tenancy,
  request context and authorization, request idempotency, HTTP/OpenAPI,
  TypeScript SDK/CLI/MCP, web UI, Memory Proposals
  (`src/modules/proposals/service.ts`, layered on the engine's exported
  `createMemoryMutationPrimitives`), code-aware memory, portability,
  evaluation, deployment profiles, and concrete model adapters under
  `src/server/providers`. The adapters, model SDK dependencies, model-specific
  protocols, defaults, environment parsing, and provider factories belong to OSS;
  the engine accepts injected capabilities. See `docs/architecture.md` for this
  dependency contract.

- the `0001_v1_baseline.sql` migration defines identity, tenancy,
  user-private Agents, Memory/chunks/links, pgvector
  state, versioned Evaluation tables, leased embedding jobs, replay-safe mutations,
  a content-free event outbox, Workspace portability, embedding generations, Agent
  lifecycle, owner-private Memory Proposals, and immutable Episode/Observation
  evidence with RLS, plus revision-bound Code Repositories/Revisions/Index
  Generations/Artifacts as rebuildable AST-aware evidence;
  `0002_drop_memory_chunks_search_indexes.sql` removes the two `memory_chunks`
  FTS GIN indexes that the RLS request path can never use, and
  `0003_drop_memory_chunks_entity_aliases_index.sql` removes the entity-aliases
  GIN on the same proof (`arraycontains` is equally non-leakproof; the
  generated column stays for the scan predicate). Every new migration
  must update `lore_system_state.schema_revision` to its own version number —
  the wrapper's postflight fails on the mismatch otherwise — and must bump both
  `LATEST_SCHEMA_REVISION` (`scripts/database/lib/migration-preflight.ts`) and
  `LORE_SCHEMA_REVISION` (`src/modules/operations/service.ts`) in the same change: the
  wrapper tolerates an older application constant, but readiness requires exact
  equality and reports the schema incompatible. `tests/integration/portable-core.test.ts`,
  `tests/integration/api.test.ts`, and `scripts/checks/smoke-memory-core.ts` pin the current
  revision;
- dbmate 2.35 parses and applies those plain-SQL migrations; it is migration tooling,
  not Lore's runtime ORM. `pg` remains the runtime adapter behind the narrow
  transaction interface in `packages/lore-core/src/db.ts`. The deployment wrapper serializes
  dbmate with a PostgreSQL advisory lock and stores SHA-256 values beside dbmate's
  versions in `lore_schema_migrations`. The schema is live in production
  (CoreSpeed HaaS), so the recorded baseline is frozen: never edit an applied
  migration file — its stored SHA-256 makes every existing deployment fail
  closed — and ship schema changes as new forward-only migrations instead. Keep
  migration `down` sections empty: production recovery is forward-only;
- `src/server/auth/actor-context.ts` owns OSS Actor identity;
  `src/server/database/memory-storage.ts` binds it inside every engine transaction,
  and `src/server/database/postgres.ts` selects OSS roles. The Memory, Graph, and
  Episode modules under `src/modules` enforce product policy and map engine storage
  keys to the unchanged Workspace/User/Agent wire fields. Core storage and retrieval
  remain in `packages/lore-core`; see `docs/architecture.md` for the split;
- `packages/lore-core/src/memory-content.ts` owns the canonical Memory content boundary. A Memory
  is one coherent knowledge record, recommended at no more than 8,000 Unicode
  characters and hard-limited to 32,000 characters and 64 derived chunks. Direct
  writes, Proposals, and imports must share this validator. Route longer raw
  documents to bounded `document_fragment` Observations in a document Episode;
  never auto-split them into canonical Memories;
- `packages/lore-core/src/memory-chunking.ts` owns `lore-memory-chunking-v2`: deterministic,
  non-overlapping, maximum 1,200-code-point chunks that exactly reconstruct the
  canonical Memory while preferring paragraph, Markdown, sentence, line, and
  whitespace boundaries. Every `memory_chunks` row records the revision and
  benchmark reuse must verify it. Keep overlap in the explicit bounded neighbor
  evidence policy. A future chunking change requires a new revision, forward
  re-chunk/re-embedding migration, and versioned evaluation;
- `src/modules/code/indexing/service.ts` owns the revision-bound Code Index module. It accepts
  complete 40- or 64-character Git OIDs. Its trusted local-Git path resolves the
  exact commit and reads its object database rather than the working tree, binds
  an independent tree digest, and persists one typed `code_revision_files`
  manifest outcome for every tree entry. The prepared `indexRevision(files[])`
  seam is not Git-authenticated and must never be the future MCP/job ingestion
  surface or silently share one repository/OID identity with authenticated input.
  Git ingestion reuses immutable parse/chunk/dependency outputs from any RLS-visible prior
  Artifact in the same Workspace only when Git object OID, full content SHA-256,
  and `CODE_INDEX_REVISION` all match. Reuse must revalidate exact source
  reconstruction, remap path-qualified symbol/declaration identities on rename,
  and report parsed/reused file counts. A parser/indexer revision mismatch must
  parse again. Artifact text and its content-only FTS/trigram indexes are stored
  once per Workspace, `CODE_INDEX_REVISION`, and SHA-256 in immutable
  `code_artifact_payloads`; the database verifies each text digest and each
  revision/path Artifact membership references the matching payload. Immutable
  path-free ordered Symbol Sets and Dependency Sets are likewise stored once per
  Workspace, `CODE_INDEX_REVISION`, and derivation SHA-256. Rename/current-path
  identity is projected by the Artifact membership at read time. Dependency edge
  rows retain only the source Artifact/set ordinal plus exact-generation
  resolution overlay; a database trigger proves that ordinal belongs to the
  source Artifact's Dependency Set. Artifact memberships and resolution overlays
  remain generation-local because path and target resolution may change even when
  source bytes do not. Call this content-addressed derived payload storage, not a
  fully content-addressed Code Index.
  The module rejects source/tree conflicts, extracts AST/symbol-aware Code
  Artifacts for its built-in web languages, and preserves
  bounded formatted-text fallback artifacts for unsupported or substantially
  malformed sources. Code Repositories, Revisions, Index Generations, and
  Artifacts/Artifact Symbols are Workspace/RLS-scoped, rebuildable evidence and
  never canonical Memory. Structural chunks partition source without dropping
  delimiters, keep logical `symbolKey`, declaration-level `declarationKey`, and
  `declarationChunkOrdinal` distinct, and represent destructuring as one exact
  Artifact with multiple Artifact Symbols. Its 6,000-unit bound is explicitly
  UTF-16 code units and hard fallback splits must preserve Unicode code points.
  Content-literal search preserves exact SQL wildcard semantics: queries with
  word trigrams target the `lower(content/path/symbol)` `pg_trgm` GIN indexes,
  while punctuation-only queries retain the exact revision-scoped scan and must
  remain an adversarial latency class. Caveat under audit: these tables are
  RLS-protected, and the same non-leakproof restriction proven on
  `memory_chunks` (`LIKE`/`@@` cannot be index conditions under `lore_app`)
  likely keeps these GINs off the request path too — verify before citing them
  in any latency claim. Search bounds symbol, literal, simple-FTS, and path
  channels independently under the same active generation before weighted RRF.
  Durable leased jobs are replay-safe and atomically activate a completed generation
  while retaining the prior generation as `retiring`. The current maintenance path
  still assembles a complete revision's source, Artifacts, and dependency arrays in
  memory before one generation transaction; it does not yet checkpoint complete
  files into `building`. Do not call jobs resumable until file-level checkpoints,
  exact manifest-coverage validation, and bounded-memory resume are implemented.
  `src/modules/code/graph.ts` owns bounded exact-revision
  callers/callees reads over immutable `calls`/`imports`/`references` edges.
  It keeps file-level imports separate from symbol-level dependencies and returns
  explicit `resolved`/`ambiguous`/`unresolved` states instead of guessing between
  same-name definitions. Its stable public read is
  `GET /api/v1/code/dependencies`, surfaced through the TypeScript SDK, CLI, and
  single read-only `lore_code_dependencies` MCP tool; it accepts exactly one
  symbol or repository-relative path and caps both edges and ambiguity candidates
  at 200 with explicit truncation. `src/modules/code/evidence.ts` owns immutable typed
  Memory-to-Code anchors and explicit `current/moved/changed/deleted/ambiguous/
  `unverifiable` assessment. `assess` is side-effect-free and is the only path joint
  retrieval may use; explicit `revalidate` persists the same result and must prove
  Memory write authority from the rows returned by its RLS-filtered update. Each
  declaration anchor freezes a SHA-256 fingerprint
  of the ordered declaration chunk sequence with the cited chunk masked out. A
  changed chunk may follow its ordinal only when that surrounding sequence still
  matches; equal-count reorder/replacement must abstain as `ambiguous`. Artifact
  pruning must not delete citation anchors.
  `src/modules/context/policy.ts` owns the pure versioned route/packet policy and
  `src/modules/context/retrieval.ts` owns its production read-only orchestration.
  `POST /api/v1/context/retrieve`, the TypeScript SDK, and `lore_retrieve_context`
  expose one bounded packet with separate Memory, exact-revision Code, anchor, conflict, and
  receipt fields. The joint path may call only side-effect-free evidence `assess`,
  never persisted `revalidate`; repository key and full commit OID are paired,
  Workspace remains process/header context, and repository paths stay server-only.
  The original question determines the route. Optional bounded `memoryQuery` and
  `codeQuery` are agent-planned channel queries, must pass the same authorization
  filters, and must be echoed in the receipt for reproducibility.
  `planRetrievalGrounding` (`retrieval-grounding-v5`) is the pure host-side
  required/auto/off gate over the original question plus a three-state
  `repositoryContext` (`exact`, `configured`, `none`). When it returns
  `shouldClarify`, hosts must return a clarification deterministically without a
  model turn. Every plan carries a stable `reasonCode`; hosts switch on it to
  render their own copy in the user's language and must not match on the English
  `reasons` strings, which are log/receipt text. The bundled `clarification` is
  the English default, and `missing_commit_oid` and `repository_unconfigured`
  are the two codes a host must be able to present. Memory search is never a substitute for missing
  exact-revision Code context, but deliberative-recall wording or first-person-
  plural team framing keeps Memory retrieval required even when the question
  also uses generic code vocabulary ("what is our commit message convention?").
  The gate's source of truth is the import-free `src/modules/context/grounding.ts`;
  `sdk:generate` copies it verbatim into the TypeScript SDK
  (`@corespeed/lore-sdk` exports it for hosts). Gate changes must regenerate the
  SDK copy and bump the policy revision.
  `joint-memory-code-v2` keeps local anchor freshness separate from contextual
  impact. For change routes it compares at most five cited declarations across the
  cited and requested exact revisions, follows at most 25 direct callee/import/
  reference edges per declaration, and fingerprints the target's complete logical
  declaration chunk sequence. Use path-qualified symbol keys so unrelated
  same-name definitions cannot create false ambiguity. Truncation, unresolved
  targets, or missing historical generations must remain explicit `unknown` or
  `possibly_affected`; never infer `unaffected` from incomplete traversal.
  Public Code HTTP/SDK/MCP surfaces are a separate family from Memory. Indexing may
  accept only an operator-configured `repositoryKey` plus exact commit OID; never
  accept a model-supplied local path, credential, or Workspace override. Configure
  the self-host registry with `LORE_CODE_REPOSITORIES`; an empty registry disables
  public enqueue. Keep native Git/AST parsing out of Cloudflare request bundles;
  it runs only in the Bun/self-host maintenance worker. Parser, symbol, or chunking
  changes must bump `CODE_INDEX_REVISION` so old and new Artifacts never masquerade
  as the same generation;
- the `workspaces` module owns the active-session surface: Workspace list/create
  plus `GET /api/v1/actor`, which resolves the verified human Actor *inside* the
  active Workspace. There is no separate `identity` module — the Identity
  aggregate's storage and policy live in `src/server/auth/`, and a four-file domain
  folder for one workspace-scoped endpoint was scaffolding, not a seam;
- `/api/workspaces`, `/api/memories`, `/api/agents`, and `/api/evaluations` are
  Hono subrouters exported directly by `src/modules/*/routes.ts` and composed by
  `src/server/api/app.ts` through `app.route()`. Route handlers call domain services
  directly; do not add handler factories or forwarding router layers.
  Next.js mounts Hono directly through `hono/vercel`;
  the application stays one Next.js service running on Bun. Cloudflare dispatches APIs directly
  to Hono on workerd;
- `src/shell/App.tsx` owns the native Memory workflow and client routing,
  `src/shell/Sidebar.tsx` owns the Lore shell, `src/shell/overview/` owns the
  Dashboard view (it composes several domains and owns no domain of its own, so it
  is not a `src/modules` entry), and
  `src/shared/browser/sdk.ts` configures the same-origin TypeScript SDK client,
  browser credentials, and `onRequest` request logging without a custom fetch wrapper.
  UI remains a distinct module within Next.js; it does not need a separate package
  or service. UI, CLI, and MCP depend on the TypeScript SDK, which calls the OSS API;
  the API supplies authorization and tenancy before composing Core and PostgreSQL.
  `bun run architecture:check` guards these dependency boundaries in CI. Every
  browser-side file of a domain lives under `src/modules/*/browser/`, and that
  directory glob — not a list of blessed file names — is what the guard matches.
  Adding a browser file must never require editing `biome.json`.
  `browser/data.ts` owns a domain's SDK calls together with its SWR hooks; API
  paths, Workspace headers, serialization, parsing, cancellation, and errors
  belong to the SDK. Do not reintroduce a per-domain `client.ts` layer that only
  forwards to the SDK. Components must not call `fetch`
  directly or recreate a shared browser HTTP transport. Development Graph benchmark
  requests are the isolated exception: `src/modules/graph/browser/prototype.ts`
  directly reads text to measure the original decoded UTF-8 payload, including
  whitespace. This endpoint is outside the public SDK/OpenAPI contract and returns
  404 in production. `GraphScalePrototype.tsx` owns
  prototype routing and the SVG control separately from `WorkerCanvasGraph.tsx`;
  the same file keeps benchmark remote state in SWR under its own cache key,
  with focus/reconnect refresh and error retries disabled during measurements;
  Sidebar's labelled Semantic search form reuses the Workspace-scoped hybrid search
  through the shared cancelable debounce hook (`src/shared/browser/use-debounced-callback.ts`);
  App drops the pending query via `searchCancelRef` on every query-context reset
  (Workspace, tab, type drill, route navigation, opening a Memory). Behavioral
  contract (normative copy in DESIGN.md): typing debounces, explicit submission is
  immediate and closes the mobile drawer, an Enter consumed by IME composition
  never submits, and a deliberate Enter always searches;
- `src/shared/browser/cache-keys.ts` owns Workspace-scoped SWR keys; domain
  `src/modules/*/browser/data.ts` own hooks for Workspaces,
  paged Memories, search, Memory detail, graph reads, and mutations. Keep server
  data in this cache instead of restoring component-level `loaded`, request-id, or
  revision state. Memory writes patch the paged/detail cache and revalidate the
  paged list plus active search and graph keys. Browse eagerly fills at most 5,000
  Memories (50 × 100-row pages), aligned with the Graph read budget; ranked search
  is the access path beyond that browse window;
- code-aware Memory has exactly two human surfaces, both read-only. `MemoryView.tsx`
  renders a Memory's Code citations from `GET /api/v1/memories/{id}/code-evidence`
  and `WorkspaceOperationsView.tsx` renders this Workspace's Code Index queue from
  the bounded newest-first `GET /api/v1/code/index-jobs`. `src/modules/code/browser/evidence-presentation.ts`
  and `src/modules/code/browser/job-presentation.ts` own their pure presentation models: the six
  validation states rank `changed`/`deleted`/`ambiguous` first, job tones rank `dead`
  first, and each state is stated in words as well as tone. Repository identity in the
  browser is a `repositoryKey` plus a commit OID; the operator-configured
  `repositoryPath` is server-only and must never reach a response body or the DOM.
  Do not grow these into a code browser, a code-search UI, or a dependency-graph
  visualization — Code Artifacts are agent-facing rebuildable evidence by design;
- `src/app/[...path]/page.tsx` serves the same shell for `/graph`,
  `/memories`, and Memory detail deep links so browser refresh never loses the
  client route;
- `packages/lore-core/src/graph.ts` reads through the host-bound store, returning
  durable Memory Links and deriving
  affinity only among otherwise isolated visible Memories; `/api/graph` exposes
  that native read model without a gbrain dependency. Graph nodes expose an
  Actor-visible Memory Reference (`metadata.reference`, imported legacy slug, or
  the Memory UUID) for native wikilink navigation;
- `src/modules/memories/browser/markdown.ts` renders `[[reference]]` and `[[reference|label]]` only
  when that reference resolves to one visible graph node. `MemoryView` intercepts
  the resulting native Memory-id link for client routing; unresolved or ambiguous
  references remain inert, and raw HTML stays escaped;
- `src/modules/graph/browser/WorkerCanvasGraph.tsx` and its colocated Worker own the production
  Graph renderer: D3 simulation runs off the main thread, links and nodes paint on
  one Canvas, cold layout reveals progressively, and interaction frames transfer
  coordinate deltas. Preserve viewport culling, the 40,000-link paint cap, label
  collision, elastic drag, user zoom/pan across hide/show and resize, and fit behavior.
  Labels are intentionally interaction-driven (hover, selection, or filtering),
  while centrality is expressed through node size and physics rather than persistent
  degree annotations. `src/modules/graph/browser/rendering/graph.ts` retains the shared Graph instance contract,
  label helpers, and the legacy SVG benchmark control;
- `packages/lore-core/src/maintenance.ts` owns leased, idempotent document embedding and
  deployment-wide re-index discovery. A provider/model/revision change builds
  generation-scoped vectors beside the active generation without rewriting
  canonical chunks. Activation requires exact coverage and atomically moves the
  prior active generation to bounded rollback. Postgres is the durable job source;
  rollout maintenance drains both the serving and explicitly configured building
  provider/model generations, because request writes continue to enqueue serving
  jobs until cutover. The self-host Bun worker polls both sequentially by default,
  while Cloudflare Queues are wake-up hints for both with a scheduled two-generation
  database sweep as the delivery backstop;
- `src/server/api/idempotency.ts`, `src/modules/operations/maintenance.ts`,
  `src/modules/{portability,operations}/service.ts`, and `src/server/telemetry/telemetry.ts`
  own OSS replay, expired replay/event cleanup, and operational integration.
  Memory mutation events are database triggers in the
  same transaction as source/link writes; deletion remains hard delete and leaves
  only a content-free, expiring tombstone. `/api/v1`, `/openapi.json`, `/livez`,
  `/readyz`, `/api/v1/actor`, and `/api/v1/capabilities` are the stable operational
  surface;
- Memory Proposals are the safe boundary for suggested create/update operations:
  an Actor with write authority may submit complete proposed content and up to 50
  total visible Memory/Observation evidence ids and typed Code Artifact anchors,
  but only the owner human may accept or reject it. A Code anchor snapshots its
  exact commit/path/symbol/declaration/chunk-ordinal/declaration-context/content
  digests under submission-time RLS and acceptance copies
  it transactionally to Memory Code Evidence without re-resolution; it must survive
  rebuildable Artifact pruning.
  Pending proposals never enter Memory browse/search/Graph/export/outbox. Update
  acceptance is exact-version and never silently rebases; future opt-in AutoDream
  work must use this boundary instead of silently persisting generated content.
  Proposal content expires after 30 days, and hard-deleting a target or accepted
  Memory removes its associated proposals and replay bodies immediately;
- Episodes are bounded, ordered evidence envelopes; their immutable Observations
  preserve message, tool, document-fragment, or event content until the owner User
  or an authorized Agent explicitly forgets the Episode. They default private, never enter ordinary
  Memory retrieval or Graph, and may be read as Proposal evidence only through
  current Actor/RLS visibility. An Agent records provenance; it is not a generic
  Source. `src/modules/episodes/service.ts` owns authorized recording through
  `lore.record_episode` and request replay; Core owns normalized Episode validation,
  storage reads/deletion, and the separate, rebuildable hybrid
  retrieval index: exact Observation partitions and generation-scoped vectors stay
  under Episode RLS, may be source-scoped before top-k, and never become canonical
  Memory. Any future automatic retention must be an explicit opt-in deployment policy;
- The API route handlers and canonical OpenAPI document define one public API contract.
  `packages/typescript-sdk` generates its public types from that document and owns
  the integration client used by the frontend. `packages/cli` and the external
  stdio `packages/mcp` adapter delegate API paths, Actor authentication, Workspace
  scoping, cursors, ETags, idempotency, bounded reads, and errors to that SDK. Keep
  MCP outside Portable Core and never accept a model-supplied Workspace override.
  Clients in other languages use the HTTP API described by OpenAPI.
  Human-only TypeScript SDK Agent administration and Workspace portability methods
  do not imply new CLI commands or MCP tools;
- `src/modules/memories/schemas.ts` defines the OSS Memory wire contract with Zod 4.
  HTTP Memory writes validate with these schemas, and OpenAPI generates its
  Memory/create/update components from them. Browser wire types and public content
  limits are imported directly from the generated TypeScript SDK contract; browser
  modules must not import server/Core modules or run canonical chunk previews.
  Keep canonical content validation and chunking in server/Core code.
  Metadata uses `z.record(z.string(),
  z.json())` with a serialized-size refinement; do not restore a handwritten JSON
  walker or separate depth/node-count policies. The shared HTTP input boundary maps
  Zod/parser stack exhaustion to 400 for excessively nested JSON. PostgreSQL enforces
  its Unicode restrictions and HTTP maps invalid-text SQLSTATEs to 400. Register
  recursive JSON with Zod when generating OpenAPI so references target `#/components/schemas`.
  The reusable engine retains storage types and content invariants; OSS owns
  authorization policy and the public wire mapping;
- Self-hosting exports privacy-filtered OTLP only when explicitly configured.
  Cloudflare uses Wrangler native observability; never load the Node `@vercel/otel`
  SDK inside workerd. Cloudflare handles `/livez` and `/readyz` before OpenNext so
  orchestration health does not depend on application auth or rendering;
- native Ollama query planning uses `/api/chat` with thinking disabled,
  deterministic decoding, a 4K default context, and a 256-token output cap; match
  `LORE_QUERY_PLANNER_NUM_CTX` to any benchmark reader sharing the same model server
  so Ollama does not reload between calls. Do not route local Qwen planners through
  the less controllable OpenAI-compatible surface;
- `packages/lore-core/src/capabilities.ts` defines the embedding, reranking, and
  query-planning capability contracts in one file;
  `src/server/providers/reranking/vllm.ts` implements strict vLLM and llama.cpp `/v1/rerank`
  plus vLLM-Metal `/score`, while `src/server/providers/reranking/hosted.ts` has concrete Cohere
  v2, Memos MemReranker, and Voyage v1 adapters. Search fuses exact simple/English
  FTS, a two-term relaxed
  English recall channel with query-side proper-name/identifier specificity
  weighting, a deterministic CJK substring channel
  (`deterministic-cjk-substring-rrf-v1`), and dense candidates before reranking
  only authorized evidence passages. Do not replace those bounded query heuristics
  with per-request corpus frequency scans; under RLS the measured scan doubled
  hybrid latency. The CJK channel exists because Postgres `simple`/`english` FTS
  cannot segment CJK — an entire punctuation-bounded run indexes as one token — so
  query-side Han/Hiragana/Katakana/Hangul runs become at most 24 three-code-point
  grams probed with `LIKE` against chunk content under the same pre-top-k
  Actor/RLS/scope/time/metadata filters, requiring two matched grams whenever the
  query yields two or more. Grams are CJK-script letters by construction, so they
  need no `LIKE` escaping. `memory_chunks` deliberately carries no content GIN
  indexes — migration 0002 dropped the baseline `search_vector`/
  `search_vector_english` GINs, and a proposed trigram index was rejected, once
  `enable_seqscan=off` under `SET ROLE lore_app` proved RLS keeps non-leakproof
  operators (`@@`, `LIKE`) out of index conditions, making every lexical channel
  an RLS-bounded workspace scan regardless. Measured at 20k chunks: a selective
  12-gram probe ~150ms beside ~95ms for one FTS channel, but cost tracks gram
  selectivity, not the LIMIT — 14 common-connective grams materialized 200k
  intermediate rows and ~590ms, the same shape as the relaxed-English channel.
  The tsvector columns remain — they power the scan predicates. Do not add
  content GIN indexes here without first fixing that request-path restriction
  and proving the win under `SET ROLE lore_app`;
- provider adapters and benchmark readers/judges prefer official OpenAI, Google Gen AI,
  Ollama, Cohere, and Voyage SDKs with their default transport. Use SDK-native timeout
  and retry configuration; do not wrap their fetch. Direct optional fetch injection
  is a test seam only. The accepted 2026-09-15 tradeoff is no Lore-enforced SDK response
  byte cap and no Ollama SDK non-streaming timeout (provider timeout settings apply to
  other providers). Maintenance leases do not cancel requests; a stalled native
  Ollama call may hold the worker until recovery. Follow
  [`docs/operations.md`](docs/operations.md#stalled-ollama-maintenance) and do not
  describe a lease as a provider deadline. Ollama adapters reject the SDK cloud host to prevent implicit
  environment credential use. Keep application-level embedding/result/score validation. MemOS and
  vLLM/llama.cpp reranking retain exact-contract HTTP adapters through
  `src/server/providers/request.ts` with status handling and bounded reads.
  `tools/evaluation/shared/dataset-download.ts` owns streaming, checksum-verified
  downloads and atomic promotion. MemoryAgentBench's row-to-JSONL adapter lives in
  `memoryagentbench-download.ts`. Local service probes live in `scripts/dev/lib/health-check.ts`;
- Optional multi-query planning is the `QueryPlanningProvider` capability.
  OSS adapters in `src/server/providers/query-planning` see only the original question; search keeps
  that question, runs every generated query under the same Actor/RLS transaction,
  fuses only visible results, and then optionally reranks them;
- Docker/Compose targets OSS self-hosting; OpenNext + two cache-disabled Hyperdrive
  bindings target CoreSpeed Cloud on Cloudflare Workers;
- `scripts/dev/local-service.ts` owns the native Apple Silicon development loop exposed
  by `bun run service:{up,down,restart,status,logs}`; keep its tests in
  `bun run service:test` and CI. It may idempotently extend an existing `.env` only
  when the complete native database block is absent, provisions distinct request and
  maintenance Postgres roles, and gives each managed process only its own database
  credential. The app and an optional managed llama.cpp reranker bind to
  `127.0.0.1` regardless of `LORE_BIND_ADDRESS`; use Docker or a manual deployment
  for network-reachable service. Keep native overrides under
  `LORE_LOCAL_POSTGRES_*`, `LORE_LOCAL_RERANK_*`, `LORE_LOCAL_SEARCH_MODE`, and
  `LORE_PORT`.

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
Lexical degradation quality is language-dependent: FTS carries English, while CJK
content is carried by the substring channel — before that channel existed, an
embedding outage left CJK Memories near-unsearchable while readiness still
reported merely degraded. Keep the versioned CJK suite categories green when
changing any lexical channel.
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
Worker + Canvas renderer is measured against the migrated ~1,000-node / ~2,200-link
graph. Preserve D3 as the layout engine without moving the simulation or links back
onto the main-thread SVG DOM. The `/prototype/graph-scale` benchmark shell reuses
the production renderer and compares it with static Canvas and legacy SVG controls.
It uses one compact radial layout and one adaptive interaction model at every scale:
at most 900 active nodes plus
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
- immutable, durable Observation evidence grouped into bounded Episodes;
- hybrid retrieval over only the Memories the caller may see;
- Users, Identities, Workspaces, Memberships, Agents, and agent Workspace grants;
- user-private and Workspace-shared Memory enforced with Postgres RLS;
- owner-private Memory Proposals with human-only acceptance into canonical Memory;
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
Workspace ──< Memory Proposal >── owner User
Agent ──< Memory Proposal.proposed_by_agent_id (provenance only)
Workspace ──< Episode >── owner User
Episode ──< Observation
Agent ──< Episode.recorded_by_agent_id (provenance only)
Workspace ──< Code Repository ──< Code Revision ──< Code Revision File
                                       └──────────< Code Index Generation ──< Code Artifact ──< Code Artifact Symbol
                                                                        └──< Code Dependency Edge
                 └──────────────< Code Index Job
Memory ──< Memory Code Evidence >── Code citation anchor
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
- A Memory Proposal is owner-private review state, not a draft Memory. Write-authorized
  Actors may submit it, but only its owner human may accept or reject it. Until
  acceptance it is absent from canonical retrieval, Graph, export, and outbox.
  Its Memory, Observation, and typed Code evidence share one 50-record limit;
  accepted Code anchors are copied atomically onto the canonical Memory.
- An Observation is immutable evidence, not Memory. It inherits owner/scope
  visibility from its Episode, remains until explicit Episode forget, and never
  enters ordinary Memory retrieval or Graph.
- Visibility and write authority are separate: sharing a Memory does not transfer
  ownership or grant other members permission to mutate it. Only the owner User or
  an authorized Agent acting for that User may mutate it.
- Shared is the default scope. A caller must explicitly request private scope.
- There is no cross-Workspace access and no cross-user private synthesis or batch.
- Code Artifacts are derived from a versioned Code Index Generation of an exact
  immutable Code Revision, remain Workspace-scoped, and never enter canonical
  Memory. Retrieval must select the requested repository and full commit OID
  before ranking. An index refresh may
  update derived evidence but cannot silently change a Memory claim or rationale.
- Memory Code Evidence preserves an immutable historical locator, content digest,
  and masked declaration-sequence context digest even after rebuildable Artifact
  rows are pruned. Side-effect-free assessment computes freshness for retrieval;
  explicit revalidation updates only its typed state and selected target, never
  canonical Memory.

The relational model centers on:

- `users`, `identities`, `workspaces`, `memberships`;
- `agents`, `agent_workspace_grants`, `agent_credentials`;
- `memories`, `memory_chunks`, `memory_links`, Memory Proposals/evidence, and
  embedding/index state;
- `episodes` and `observations` for durable non-canonical evidence;
- `code_repositories`, `code_revisions`, `code_revision_files`,
  `code_index_generations`, `code_artifact_payloads`, `code_symbol_sets`,
  `code_symbol_payloads`, `code_dependency_sets`, `code_dependency_payloads`,
  `code_artifacts`, and `code_dependency_edges` for rebuildable, revision-bound
  code evidence;
- `code_index_jobs` for leased, bounded-attempt indexing and `memory_code_evidence` for
  typed durable citation anchors;
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
- Code search must apply Workspace, repository, and exact commit-OID predicates
  before top-k. A full Git OID may be indexed only once for one deterministic
  source/tree digest identity; authenticated/unauthenticated disagreement is a
  conflict, not an in-place rewrite. Every authenticated tree entry needs one
  persisted indexed/excluded manifest outcome under the same RLS boundary.
- Code dependency reads must select the same Workspace, repository, full commit OID,
  and active generation before traversing callers or callees. Unresolved and
  ambiguous targets remain explicit and never become guessed cross-file edges.
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

- **OSS self-host:** Next.js + Hono, maintenance, and database tooling run on
  Bun/Docker, with Postgres. Operators may attach local, OIDC, or
  trusted-proxy identity adapters.
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
- **Observation module:** atomically record, list, retrieve, and explicitly forget
  bounded immutable Episodes while keeping their Observations outside canonical
  Memory retrieval and enforcing the same owner/scope/RLS rules.
- **Code Index module:** atomically index an immutable repository revision and
  search its RLS-visible Code Artifacts while hiding language detection, AST
  traversal, structural splitting, symbol breadcrumbs, parser recovery, formatted
  fallback, exact Git object reads, complete manifest accounting, hashing, and
  revision-conflict handling. Native Git access and parsing are Bun indexing
  concerns, not Cloudflare request-path dependencies.
- **Code Dependency Graph module:** return bounded callers/callees from one exact
  active Code Index Generation while hiding edge storage, path-versus-symbol
  subject resolution, ambiguity handling, and RLS-safe traversal.
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
  provider/model/dimensions/revision is degraded because lexical retrieval —
  English FTS plus the CJK substring channel — remains available.
- **Evaluation module:** run a versioned suite and return quality, isolation,
  latency, and cost results without mutating production Memories.

Keep OSS RLS policy SQL and storage-context installation with the host schema and
database modules; Core queries use the host-constrained store.
Do not expose storage-provider details at the product interface. Introduce an
adapter only where behavior actually varies (for example, a production embedding
provider and a deterministic test adapter).

## Benchmark / Evaluation

Benchmark is part of the product quality system even without AutoDream.

- Keep a deterministic synthetic suite in the repository for CI and version
  comparisons.
- `evaluation/suites/retrieval-v1.json` is the end-to-end retrieval fixture
  (suite version 2 adds `cjk`, `cjk-mixed`, and `cjk-no-answer` categories plus a
  Bob-private Chinese tripwire aimed at the CJK substring channel). Run
  `bun run benchmark:retrieval` only with `BENCHMARK_DATABASE_URL` pointing to a
  disposable migrated database whose name contains `bench` or `benchmark`; the
  runner resets tenant data, writes through the native Memory module, embeds through
  leased maintenance, and searches under RLS.
- `evaluation/suites/retrieval-policy-v1.json` is the versioned model-facing
  retrieval invocation suite: must-call/must-not-call/must-clarify/drill-down
  cases with expected route, exact-revision binding, assistant outcome, and
  answer-evidence substrings. `bun run benchmark:retrieval-policy` runs live
  model trials against deterministic fixture evidence through Lore's real MCP
  schemas via Codex exec or `--runner claude` (Claude Code CLI). The
  `host-policy` variant applies the production grounding gate, including the
  deterministic clarification short-circuit; reports pin the grounding policy
  revision and score invocation behavior separately from outcome and
  answer-evidence checks. It never measures retrieval quality below the
  orchestration layer — that remains `benchmark:retrieval`.
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
  split into independent Lore Memories with the versioned, structure-aware
  1,200-code-point chunker, preventing cross-document false anchors. It chooses one
  literal-answer anchor using query overlap, the most specific accepted reference,
  answer/query proximity, and conservative English subject normalization; it skips
  nonliteral questions and records anchor
  coverage. The default is one 20-question RULER row; do not present its retrieval
  metrics as the official generated-answer score.
- External benchmark answer tripwires are Bob-private RLS canaries. Keep their exact
  chunks and ownership validation. Memory-based tripwires do not enqueue embeddings
  that Alice cannot see. LongMemEval-V2 is the deliberate exception: its Bob-private
  Episode tripwire uses the same vector path and is included in the candidate source
  scope so semantic RLS is tested rather than bypassed by benchmark filtering.
- `LORE_BENCHMARK_EMBEDDING_DIMENSIONS` runs a retrieval benchmark against a
  disposable database whose schema was generated at a non-lore width through
  `tools/evaluation/retrieval/migrate-dimensions.ts` (the audited 1024→N transform of
  the baseline; the four `length(path) <= 1024` checks stay). It exercises the
  engine's host-baked `embeddingDimensions` option the way a non-lore host's
  own chain does (CoreSpeed HaaS: 1536). It is a benchmark setting: deployments
  keep the 1024 protocol invariant and still reject `LORE_EMBEDDING_DIMENSIONS`.
- Synthetic benchmark reruns may set `LORE_BENCHMARK_REUSE_INDEXED=1`; the runner
  validates exact content/owner/scope and active embedding-space completeness before
  reusing data. LongMemEval exposes the same behavior as `--reuse-indexed`.
- `bun run benchmark:longmemeval` runs the official cleaned LongMemEval data fully
  locally through the same native benchmark path. Dataset manifests pin the
  upstream revision, byte length, SHA-256, license, and session granularity;
  downloaded data stays ignored under `evaluation/datasets/`. Every question is a
  separate Workspace, every conversation session is an Alice-owned private Memory,
  and a Bob-owned private answer tripwire preserves the RLS hard gate. A session
  larger than the canonical 32k-character content bound (five exist in the S
  split) splits greedily at turn boundaries into part Memories; the first part
  keeps the session key and later parts carry `anchorKey` back to it, which the
  runner resolves at scoring time so any-part retrieval counts as the session at
  that rank without inflating the expected-id denominator. The oracle
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
  image routing, and context-budget units in every result. The runner preserves
  each rendered trajectory exactly across bounded workflow Episodes/Observations,
  indexes them through the separate revisioned Episode-evidence module, groups
  results back by trajectory identity, and includes Bob-private Episode tripwires
  inside the pre-top-k source scope. It never stores a raw trajectory as Memory.
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

- Next.js 16 (App Router), React 19, Hono, Bun 1.4.2+ for self-host runtimes,
  package management, tooling, and tests; TypeScript 7;
- dbmate 2.35 for plain-SQL migration parsing/application and `pg` for runtime
  PostgreSQL transactions; Lore has no runtime ORM;
- SWR 2 for the native browser read/mutation cache, jose, Biome, and Vitest;
- a Vercel/Geist visual system: `#fafafa` canvas, `#171717` ink, `#ebebeb`
  hairlines, Geist Sans/Mono, flat 12px cards, and 6px controls.

`bun.lock` is the only dependency lockfile. Bun installs dependencies and runs
self-host application/maintenance processes, TypeScript scripts, builds, and tests.
CLI commands use `bun --bun` where needed to override dependency Node shebangs;
`bunfig.toml` also sets `[run] bun = true`. Docker uses the pinned Bun image and
runs the generated standalone `server.js` and maintenance bundle with Bun.
The Cloudflare bundle executes on workerd. Do not add an
npm/pnpm/Yarn lockfile or claim that Cloudflare runs Bun/Node as a process.
Keep credential-sensitive script and CLI/MCP entrypoints on `--no-env-file`;
the local service manager explicitly reads its environment and filters credentials
for each child. `node:` compatibility imports do not require a Node process.
Core and the TypeScript SDK remain reusable libraries: preserve their standard
module contracts and do not introduce Bun-only APIs into their portable code.

Under `tools/` and `scripts/`, an executable entrypoint is named as a verb phrase
(`run-retrieval.ts`, `fetch-locomo.ts`, `seed-graph-benchmark.ts`,
`evaluate-code-aware-memory.ts`, `check-design-system.ts`, `migrate-dimensions.ts`)
and a library is named as a noun phrase (`retrieval.ts`, `retrieval-suite.ts`,
`locomo.ts`, `retrieval-policy.ts`). Never distinguish the two by word order alone:
`benchmark-retrieval.ts` beside `retrieval-benchmark.ts` is the failure this rule
exists to prevent, because "benchmark" reads as both verb and noun.

`src/server/api/app.ts` composes domain subrouters exported by `src/modules/*/routes.ts`
with Hono's `app.route()`. Keep route callbacks inline for parameter inference and
use `.get()`/`.post()`/etc.; Hono-owned responses use `c.json()`/`c.body()`.
Mount shared subrouters at both `/api` and `/api/v1`, and keep versioned-only
resources under `/api/v1`. Hosts inject lazy dependencies through
`src/server/api/dependencies.ts` and Hono context variables. Route modules own
Hono routing, parsing, authorization, and responses; domain services remain
framework-independent. Use `app.request()` for API tests, including middleware
and routing. Preserve the unversioned aliases and v1 contract, HEAD/OPTIONS/405
behavior, and shared admission policy in
`src/server/auth/auth.ts`. Domain handlers still authorize Actors and install RLS.
Next mounts Hono through its API catch-all via `hono/vercel`. Cloudflare uses
request-local Hyperdrive adapters and `waitUntil` queue notifications, before
OpenNext routing. Default dev/start/local-service commands remain single-service
Next.js on Bun with native hot reload; do not add an internal HTTP proxy, custom
outer server, or second API process to this profile.

TypeScript 7.0.2 is the workspace compiler. `tools/sdk-codegen` deliberately keeps
TypeScript 5.9.3 isolated as a library dependency: `openapi-typescript` 7.13 uses
the legacy compiler API (`factory`/`createPrinter`), which the TypeScript 7 package
does not expose. Do not replace that dependency with the workspace compiler until
the generator supports its API.

All handwritten JavaScript-family source, including tooling and `next.config.ts`,
must use TypeScript/TSX. Keep generated JavaScript outputs in their native format.
`bun run typecheck` checks both the application and
`scripts/tsconfig.json`; tooling uses Bun types with ESNext/bundler resolution,
checked indexed access, exact optional properties, erasable syntax, and explicit
`.ts` imports. Keep Next/Cloudflare ambient declarations out of that tooling
configuration: their global `ProcessEnv` augmentation incorrectly requires
deployment variables in isolated child environments. The two scripts that import
application modules
(`smoke-memory-core.ts` and `embedding-generation.ts`) stay in the app typecheck.
Do not substitute `any`, unchecked casts, or suppressed diagnostics for input
validation or accurate types.

These commands remain the current verification loop:

```bash
bun run dev        # localhost:3000
bun run db:migrate # preflight/adopt, then apply checksum-protected dbmate migrations
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
bun run typecheck  # generate Next types, then check application and Bun scripts
bun run lint       # biome check .
bun run format     # biome check --write .
bun run architecture:check # enforce UI/SDK/API/Core dependency boundaries
bun run design:check # enforce and self-test the Lore UI contract
bun run sdk:generate # regenerate TypeScript contracts and package versions
bun run sdk:check  # fail when generated developer contracts drift
bun run test       # application and Core tests with Vitest
bun run build:packages # build the TypeScript SDK, CLI, and external MCP packages
bun run packages:smoke # pack/install/import the release artifacts
bun run build      # Next production, maintenance, and developer-package builds
bun run build:maintenance # bundle the self-host Bun maintenance entrypoint
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
and the deployment dry runs must all pass.

Next.js 16 keeps development output in `.next/dev`, separate from production
build output. A production build no longer clobbers the running dev manifest, but
do not treat generated `.next` or `.open-next` output as source or commit it.

`cloudflare-env.d.ts` is the exception: it is the checked-in generated binding and
Workerd type contract. Regenerate it with `bun run cf:typegen` after changing
`wrangler.jsonc` or `.dev.vars.example`.

## Testing scope and gotchas

Test Lore's own logic: validation, parsing, retrieval, authorization, state
transitions, and API contracts. Do not add component rendering, DOM interaction,
or database-connectivity tests. Pure browser logic such as pagination, cache
isolation, and routing still belongs in tests. Use a database when the behavior
under test is our SQL, transaction policy, migration, or RLS rule; do not replace
those rules with mocks that merely repeat their implementation.

- `tests/support/memory-context.ts` caches a migrated, seeded PGlite snapshot per
  isolated test module and restores a fresh database for every context. Preserve
  that isolation; migration tests must still execute migrations on empty databases.
  Both Vitest configs enable `experimental.fsModuleCache` (the Vitest 4 API).
  Clear stale module caches with `bun --bun vitest --clearCache`; cached modules never
  replace test execution. CI's stable `check` gate requires every validation
  job to succeed; cache hits must not skip their checks.
- Date strings are UTC; render date labels with `timeZone: "UTC"`.
- `tests/modules/code/code-index.test.ts` builds real Git fixtures with `git add`, so a
  user-level global gitignore (`~/.config/git/ignore` or `core.excludesfile`)
  that excludes fixture paths like `dist/` silently drops files from the
  committed tree and fails the manifest test. GitHub runners have no such
  file; a dev box or agent VM might. Neutralize with
  `XDG_CONFIG_HOME=/tmp/empty` when the failure reproduces on `main`.
- `bun run lint` silently checks nothing when the working tree sits under a path
  containing `/tmp`, because `biome.json` excludes `**/tmp`. The same happens in
  every agent worktree under `.claude/worktrees/` — `biome.json` also excludes
  `**/.claude` and `**/.worktrees` — so lint from such a checkout must run from a
  worktree added at a neutral path. "Checked 0 files" means the path excluded
  everything, not that the tree is clean.
- Running `bun run build` while `next dev` is live can still break an individual
  route in the dev server even though Next 16 keeps dev output under `.next/dev`.
  Observed symptom: one API route starts returning the catch-all page — HTTP 200
  with `content-type: text/html` — so the browser fails on
  `Unexpected token '<', "<!DOCTYPE "… is not valid JSON` while every neighbouring
  route still serves JSON. `bun run service:restart` clears it. Check
  `tmp/local-service/app.log` for the dev server's own output; `service:logs` shows
  the maintenance worker only.
- `service:restart` kills the maintenance worker mid-job, leaving a leased Code
  Index job stranded in `processing` until its lease expires. A `processing` row is
  not proof of active work — check the worker's CPU before concluding it is indexing.
- `tsconfig.json` sets `incremental: true`, so `bun run typecheck` can report success
  purely from a stale `tsconfig.tsbuildinfo`. Any bisect over dependency, generated-type,
  or `tsconfig` changes must `rm -f tsconfig.tsbuildinfo .next/cache/.tsbuildinfo` between
  runs, or it measures the cache instead of the change. `skipLibCheck: true` compounds
  this: a conflict between two `.d.ts` files is silent at the declaration site and only
  surfaces as errors at unrelated call sites.
- Wrangler upgrades must regenerate `cloudflare-env.d.ts` and pass a fresh
  typecheck. Wrangler 4.123.0's workerd generated `declare const Buffer: any`,
  which collided with the runtime types and broke `Buffer.toString(encoding)`.
  Wrangler 4.134.0 / workerd `1.20260917.1` no longer emits that declaration;
  the generated types work without declaration patches or type suppressions.
- Voyage's SDK stays at `voyageai` 0.1.0. Releases 0.2.0 through 0.4.0 route
  the public client through local inference exports, causing Wrangler to resolve
  the optional `@huggingface/transformers` dependency even for hosted reranking.
  Do not add local ONNX/transformer dependencies or bundler stubs to the Worker;
  require a successful Cloudflare dry run before upgrading this SDK.

## Commit / PR conventions

- Conventional commits: `feat(scope): …`, `fix: …`, `chore: …`, `docs: …`.
- `main` is protected; changes land through PRs.
- Automatic Ensemble review and the `/ship` workflow are disabled for this
  repository. Use the repository checks and ordinary PR workflow for commit,
  PR, and release requests. Run Ensemble review only when the user explicitly
  requests it.
- Preserve unrelated user changes and untracked files.
- If behavior, commands, architecture, or a gotcha changes, update this file in the
  same PR. Update [`CONTEXT.md`](CONTEXT.md) whenever canonical domain language
  changes.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
