# Project organization

Lore has two implementation layers: **Lore Core** (`packages/lore-core`) is the
reusable memory engine; **Lore OSS** supplies identity, transport, deployment,
concrete model adapters, product workflows, and UI. OSS depends on Core; Core does
not import OSS or model SDKs. Product terminology is defined in [CONTEXT.md](../CONTEXT.md).

## Interface boundaries

Web UI, CLI, and MCP are separate modules that depend on the TypeScript SDK.
The request path is `UI / CLI / MCP → TypeScript SDK → OSS API → Core → Postgres`;
the Python SDK calls the same OSS API independently.

| Module | Location | Responsibility |
| --- | --- | --- |
| Web UI | `src/shell/`, browser-facing domain files in `src/modules/`, and `src/shared/browser/` | Views, presentation, navigation, and SDK-backed remote state |
| TypeScript SDK | `packages/typescript-sdk/` | Generated wire types, public content limits, and API client transport |
| Python SDK | `packages/python-sdk/` | Generated Python contract and equivalent API client |
| CLI | `packages/cli/` | Command parsing and output through the TypeScript SDK |
| MCP | `packages/mcp/` | External stdio tools through the TypeScript SDK |
| OSS API | `src/app/api/`, domain HTTP/services, and `src/server/` | Authentication, tenancy, authorization, request replay, and engine composition |
| Core | `packages/lore-core/` | Memory algorithms and PostgreSQL storage mechanics |

The UI remains a module of the Next.js application; this boundary does not require
a separate UI package or service. Browser wire types and public content limits
come from the SDK. Canonical content validation and chunking stay in server/Core
code; the UI does not run a chunk preview. OSS model providers are injected into
Core. `bun run architecture:check` guards these dependency boundaries in CI.

## Directory map

| Directory | Responsibility |
| --- | --- |
| `src/app/` | Next.js pages, route entrypoints, global styles, and framework composition |
| `src/shell/` | App routing, Sidebar, and workflows that compose multiple domains |
| `src/modules/` | Product domains, each owning its implementation and interfaces |
| `src/server/auth/` | Authentication, identity storage, access policy, and Actor request context |
| `src/server/database/` | OSS role selection, database construction, and identity-bound engine stores |
| `src/server/providers/` | Concrete model adapters, SDK/protocol handling, model configuration, factories, and runtime provider instances |
| `src/server/http/` | Shared input handling, idempotency headers, and error responses |
| `src/server/openapi/` | Shared contract helpers and assembly of the public OpenAPI document |
| `src/server/telemetry/` | Server instrumentation and privacy filtering |
| `src/shared/browser/` | Browser SDK configuration, SWR cache keys, request logs, and common hooks |
| `src/shared/ui/` | Shared visual helpers |
| `src/worker/` | Node maintenance entrypoint |
| `packages/` | Memory engine, TypeScript/Python SDKs, CLI, and external MCP adapter |
| `db/` | Immutable applied migrations and database setup |
| `tools/sdk-codegen/` | Isolated OpenAPI code-generation toolchain |
| `tools/evaluation/` | Quality and performance tools grouped by retrieval, code, context, policy, chunking, and graph |
| `scripts/` | Development, build, validation, and database operations |
| `tests/` | Automated tests grouped by the code they exercise |
| `evaluation/` | Versioned evaluation inputs and results |

Use the [script index](../scripts/README.md) for daily development and operations,
and the [evaluation tool index](../tools/evaluation/README.md) for repeatable quality
and performance measurements. Keep the harnesses used by retained research
baselines; retire superseded interactive demos and compatibility exports. Run the
stable package commands from the repository root. Evaluation inputs and reports
stay in `evaluation/`; the Docker runtime copies only `scripts/database/`.

## Domain modules

`src/modules` contains `memories`, `proposals`, `episodes`, `agents`, `workspaces`,
`identity`, `graph`, `code`, `context`, `evaluations`, `operations`, `portability`,
and `overview`.

A module contains the files its implementation needs. For example:

```text
src/modules/memories/
  schemas.ts       # Server Zod validation and OpenAPI schema source
  types.ts         # SDK-generated Memory aliases and browser presentation types
  input.ts         # Memory-specific HTTP input handling
  http.ts          # Testable request handlers
  service.ts       # OSS authorization, request replay, and engine wire mapping
  client.ts        # Domain adapter for the TypeScript SDK
  hooks.ts         # Memory reads and cache behavior
  display.ts       # Memory title/type presentation
  markdown.ts      # Memory content rendering
  openapi.ts       # Memory paths and schema components
  components/      # MemoryView and SearchResults
```

Modules with their own application persistence use `service.ts`. Canonical Memory
persistence stays in `packages/lore-core`. A feature does not need a service file,
client file, or new package unless it has behavior to own.

Callers import the specific interface they use. Do not recreate aggregate `lib`,
`types`, HTTP-handler, browser-client, or hook files spanning unrelated domains,
or barrels that re-export server code alongside browser code. Domain hooks share the central
cache-key vocabulary so mutations can invalidate related views consistently.
Cross-domain UI composition belongs in `src/shell`.

HTTP handlers and the canonical OpenAPI document define the API contract consumed
by the TypeScript and Python SDKs. The CLI and external MCP adapter delegate to the
TypeScript SDK. The frontend follows `SWR hook → domain client → TypeScript SDK`:
SWR owns remote state and cache invalidation, while domain clients preserve UI
defaults and adapt results to their views.

The shell restores its URL for the selected Workspace before enabling domain
reads. Dashboard and unqueried Memory browse enable the paged Memory window;
Dashboard, Graph, and Memory detail enable Graph reads. Management pages and
ranked search do not load that browse window. Inactive Memory and Graph hooks
retain their Workspace-scoped SWR cache but pause requests, focus/reconnect
refreshes, and background page advancement. Returning to a consuming view
revalidates its cache after any in-flight batch finishes. Already-issued requests
may finish; further pages from an old or inactive view are not requested. The
hidden Graph renderer stays mounted to retain its viewport, while its search
requests pause.

The active Dashboard and browse views still fill at most 50 × 100 Memories:
their current statistics and type counts use that complete browse window.
Scroll-driven network pagination requires separate summary/statistics reads;
this page-demand policy does not change the existing counts or browse limit.

`src/shared/browser/sdk.ts` constructs the same-origin SDK client with browser
credentials and connects its `onRequest` observer to the request log. It explicitly
disables the SDK deadline with `timeoutMs: null`, retaining the browser's previous
unbounded wait for long-running operations and support for caller cancellation.
The SDK owns
API paths, Workspace headers, serialization, response parsing, cancellation, and
errors. There is no separate shared browser HTTP transport or custom SDK fetch
wrapper. Components do not call `fetch` directly. Browser Memory types and public
content limits come from the SDK; server Zod schemas remain the validation and
OpenAPI source, backed by Core's content and chunk invariants. Human-only SDK methods for Agent administration and Workspace
portability do not add CLI commands or MCP tools.

The development Graph benchmark is a separate measurement endpoint, outside the
public SDK/OpenAPI contract, and returns 404 in production. Its isolated
`prototype-client.ts` reads response text directly to measure the original decoded
UTF-8 payload, including whitespace. `GraphScalePrototype.tsx` owns prototype
routing and the SVG control separately from `WorkerCanvasGraph.tsx`.
`prototype-hooks.ts` still keeps its remote state in SWR with a separate benchmark
cache key and disables focus/reconnect refresh and error retries so a renderer
comparison keeps its dataset stable. SDKs and Node scripts do not import SWR.

### Memory engine and host policy

Core factories bind `MemoryStorageContext`: `{ database, partitionId, ownerId,
sourceId? }`. `createMemoryModule(storage, options)` returns methods without an
Actor parameter; Memory results use `partitionId`, `ownerId`, and nullable
`sourceId`. These values identify stored data and attribution. They do not
authenticate a caller or define Workspace membership. Core retains PostgreSQL
queries and transactions, version checks, content/chunk invariants, Memory Links,
and retrieval algorithms. Its internal `retrieval/query.ts`, `ranking.ts`, and
`policy.ts` separate query preparation, feedback, fusion, recency, diversity, and
versioned policy from the Memory module's storage orchestration.

The supplied database must constrain every transaction before Core uses it.
OSS `src/server/auth/actor-context.ts` owns User/Workspace/Agent context;
`src/server/database/memory-storage.ts` installs it for every engine transaction,
including later retrieval-feedback rounds. `src/server/database/postgres.ts`
chooses `lore_app` or `lore_maintenance`. Core's `./postgres` adapter only handles
connections, transactions, and a host-supplied `initializeTransaction` callback.
An existing host transaction can be bound through `memoryStorageInTransaction`;
its caller remains responsible for context, authorization, commit, and notification.

OSS modules `memories/service.ts`, `graph/service.ts`, and
`episodes/{service,evidence}.ts` compose those stores with product policy and map
Core keys to the existing `workspaceId`, `ownerUserId`, and Agent provenance
fields. Memory writes keep permission checks before version checks and mutate
replay records inside the same transaction through
`src/server/http/idempotency.ts`. Workspace lifecycle, memberships, grants,
private/shared visibility, HTTP/SDK contracts, and existing tenant data remain
OSS responsibilities. Metadata filters, scope selectors, and context-group
expansion are retrieval inputs, never proof of authorization.

Physical storage still uses columns such as `workspace_id`, `owner_user_id`, and
`created_by_agent_id`. Their legacy names are part of the existing SQL schema;
this interface change does not rename stored columns or require a migration.
The engine does not call OSS membership/grant policy functions or install identity GUCs.
Its pure lexical schema helper and embedding lease/generation functions remain
storage requirements for the capabilities that use them.

Episode admission is an OSS operation: `episodes/service.ts` validates with Core's
`normalizedEpisode`, then calls the authorization-bearing `lore.record_episode`
function and records request replay. Core's Observation module provides validation,
store-bound reads, and deletion; its Episode evidence index still owns partitioning,
embedding, and retrieval algorithms. Core maintenance keeps embedding leases and
generation activation/pruning. Expired request replay and event cleanup,
`purgeExpiredPortableCoreRecords`, lives in `src/modules/operations/maintenance.ts`.

The `./testing` contract kit accepts host-bound contexts and a `testDatabase`
helper with optional transaction initialization. Tests exercise both the OSS RLS
schema and real CRUD/retrieval on a minimal independent PGlite schema without
identity tables or authorization functions. The latter verifies the engine can
operate without importing OSS policy; it does not supply a replacement security
policy for a multi-user host.

### Model capabilities

Core defines the capabilities needed by its retrieval and maintenance modules:
`EmbeddingProvider` embeds query/document text, `RerankingProvider` scores supplied
candidate passages, and `QueryPlanningProvider` generates alternate queries. Core
owns candidate selection within the host-constrained store, retrieval fusion, failure behavior, vector
validation, and embedding-generation storage. Embedding provider/model/revision
identity and dimensions remain part of its contract because incompatible vector
spaces must never mix.

OSS implements those interfaces in `src/server/providers/{embedding,reranking,query-planning}`.
It owns model SDK dependencies, model selection and defaults, model-specific
instructions and preprocessing, decoding, transport, response parsing, timeout and
retry configuration, environment reads, and provider construction. Rich configured
provider metadata used by benchmarks belongs to OSS types; the engine's reranking
and planning interfaces expose only their operations. Shared exact-contract HTTP
handling and response validation also live under `src/server/providers`.

The factories inject these implementations into Core. A host can supply its own
model adapters without changing Core or installing the OSS model SDKs. There is no
separate providers package and no `@corespeed/lore-core/providers` entrypoint.
Moving adapters does not change model protocols or their recorded revisions;
stored vector identity and benchmark receipts remain reproducible.

OSS provider adapters and benchmark readers/judges use the official OpenAI, Google
Gen AI, Ollama, Cohere, and Voyage SDKs with their default transport. Use native
SDK timeout and retry options; do not add a custom fetch wrapper around an SDK.
Optional fetch injection on adapters that support it is a test seam, not a
production transport layer. Embedding allows two SDK retries by default for
OpenAI/Google; planners, readers, judges, and hosted rerankers disable retries.
Ollama adapters support self-hosted servers and reject the SDK cloud host so that
ambient `OLLAMA_API_KEY` cannot silently authenticate a cloud request. Ollama
performs one attempt and its SDK has no non-streaming request timeout.
Provider/benchmark timeout settings therefore apply only to the other providers; the local
Ollama model probe also uses the SDK without a deadline. SDK responses have no
Lore-enforced byte cap. These differences were explicitly accepted on 2026-09-15
to keep SDK transport behavior native. Result counts, embedding dimensions,
finite values, and normalized reranking scores are still validated by Lore.
Maintenance leases do not cancel provider calls. A stalled Ollama request can
hold the worker after lease expiry; the [operations runbook](operations.md#stalled-ollama-maintenance)
documents the accepted liveness limit and recovery procedure.

MemOS and the vLLM/llama.cpp reranking contracts (including `/score`) retain their
specific HTTP adapters because the selected SDKs do not cover those exact
contracts. Their small `src/server/providers/provider-http.ts` boundary checks
status and consumes bounded JSON; it does not implement a generic HTTP client.
Dataset streaming, checksum verification, and temporary-file promotion belong to
`tools/evaluation/shared/dataset-download.ts`; the MemoryAgentBench row-to-JSONL
protocol stays in its own download adapter. Native development health probes live
in `scripts/dev/lib/local-http.mjs`. These downloads, generic health probes, Lore's
own SDK transport, and the isolated development Graph benchmark remain direct HTTP
boundaries.

Voyage is pinned to the official remote-only SDK 0.1.0. Newer releases pull optional
local-inference modules into their public entrypoint and fail the Cloudflare build
without unused native dependencies. The pinned release supports the full rerank
contract used here; upgrade only after both Node and Cloudflare builds pass.

CoreSpeed HaaS retains a separate vendored `packages/memory-core` fork. The planned
verbatim-copy cutover was cancelled on 2026-09-15; selected Lore changes are ported
manually with provenance, rather than mirrored automatically in every task.

### Code indexing

`src/modules/code/indexing` separates the existing indexing implementation into:

- `types.ts`, `limits.ts`, `protocol.ts`, and `errors.ts`: contracts and invariants.
- `git.ts`: authenticated commit and tree-object ingestion.
- `parser.ts`: native AST parsing and deterministic artifact preparation.
- `validation.ts`: source validation, hashing, and preparation utilities.
- `storage.ts`: artifact reuse and transactional payload/dependency persistence.
- `read.ts` and `queue.ts`: request-safe reads and enqueue operations.
- `service.ts`: indexing transaction orchestration.
- `maintenance.ts`: leased background processing.

HTTP handlers import the read and queue interfaces. Native parsing and local Git
run only through the Node worker and operator tooling. Moving implementation files
does not change the code-index revision or stored artifact format.

## Import and runtime rules

1. Keep framework route files thin: construct runtime dependencies and delegate to
   a domain handler.
2. Browser modules may import browser helpers, SDK wire types and public limits,
   domain presentation, clients, and hooks. Do not import server or Core modules,
   including their types, into browser code. CLI and MCP depend on the SDK, not
   OSS server modules or Core.
3. Server implementation depends on the reusable engine and host runtime through
   the existing interfaces. Keep concrete model adapters, model SDK dependencies,
   identity/tenant policy, request idempotency, and environment reads out of
   `packages/lore-core`.
4. Each domain owns its OpenAPI paths and components; `src/server/openapi/document.ts`
   assembles them. SDK generation reads that assembled document. Zod owns Memory
   validation and its OpenAPI schemas; browser Memory types come from the generated
   SDK contract, without a second handwritten wire model.
5. Do not add compatibility re-export files at the retired `src/lib` paths. Update
   callers when moving an interface.

## Scripts and tests

Operational scripts are grouped under `scripts/{database,dev,build,checks}`;
benchmarks, evaluations, and their shared helpers live in `tools/evaluation`.
Package-script names remain the supported command surface:
`bun run service:up`, `bun run db:migrate`, `bun run sdk:check`, and the existing
benchmark commands still work from the repository root.

Tests are grouped under `tests/modules/<domain>`, `tests/core`, `tests/server`,
`tests/ui`, `tests/packages`, `tests/benchmarks`, and `tests/integration`.
Shared database fixtures remain in `tests/support`; runnable worker fixtures remain
in `tests/fixtures`. Vitest discovers all groups recursively.

The shared database fixture builds a migrated, seeded PGlite snapshot once per
test module and restores it into a fresh database for each context. Tests share
only the immutable snapshot, never a live connection or mutable database. Migration
tests still initialize empty databases and execute the migration chain directly.
Both Vitest configurations enable persistent module transformation caching through
Vitest 4's `experimental.fsModuleCache`. CI restores
`node_modules/.experimental-vitest-cache` across commits with the same lockfile;
Vitest invalidates entries when source or configuration changes. Every test and
its database fixture still executes on each run.

CI has three job groups: `tests` runs quality checks, application/Core tests, and
PostgreSQL smoke; `build` runs package smoke plus Node and Cloudflare builds;
`python-sdk` tests Python 3.12 and 3.14. The stable `check` job requires all three
groups to succeed. PR updates cancel older runs; branch pushes run CI only on
`main`. The Cloudflare build reuses that job's fresh Next build through
`--skipNextBuild` before the Wrangler deployment dry run.
The two Bun jobs share the package download cache keyed by OS, architecture, Bun
version, and lockfile; both still run `bun install --frozen-lockfile`. The build
job also restores `.next/cache` for incremental compilation. Build and test
caches get a new entry per commit with a same-lockfile restore prefix; dependency
downloads reuse one entry until the lockfile changes. Cache hits never skip a
test, installation, or production build.

Use the ordinary verification commands:

```sh
bun run typecheck
bun run lint
bun run architecture:check
bun run design:check
bun run service:test
bun run test
bun run build
bun run packages:smoke
```

The [documentation index](README.md) separates current guides, architecture decisions,
and retained research. Research reports describe their recorded revisions and may
cite historical source paths; use this guide for the current layout. Superseded
reports and completed handoffs are available in Git history.
