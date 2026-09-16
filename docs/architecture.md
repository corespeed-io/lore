# Project organization

Lore has two implementation layers: `packages/lore-core` is the reusable memory
engine; the application under `src` supplies identity, transport, deployment,
product workflows, and UI. Product terminology is defined in [CONTEXT.md](../CONTEXT.md).

## Directory map

| Directory | Responsibility |
| --- | --- |
| `src/app/` | Next.js pages, route entrypoints, global styles, and framework composition |
| `src/shell/` | App routing, Sidebar, and workflows that compose multiple domains |
| `src/modules/` | Product domains, each owning its implementation and interfaces |
| `src/server/auth/` | Authentication, identity storage, access policy, and Actor request context |
| `src/server/database/` | Request database construction |
| `src/server/providers/` | Environment configuration, factories, and runtime provider instances |
| `src/server/http/` | Shared input handling, idempotency headers, and error responses |
| `src/server/openapi/` | Shared contract helpers and assembly of the public OpenAPI document |
| `src/server/telemetry/` | Server instrumentation and privacy filtering |
| `src/shared/browser/` | Browser SDK configuration, SWR cache keys, request logs, and common hooks |
| `src/shared/ui/` | Shared visual helpers |
| `src/worker/` | Node maintenance entrypoint |
| `packages/` | Memory engine, TypeScript/Python SDKs, CLI, and external MCP adapter |
| `db/` | Immutable applied migrations and database setup |
| `tools/sdk-codegen/` | Isolated OpenAPI code-generation toolchain |
| `scripts/` | Development, operational, validation, benchmark, and evaluation commands |
| `tests/` | Automated tests grouped by the code they exercise |
| `evaluation/` | Versioned evaluation inputs and results |

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
may finish; further pages from an old or inactive view are not requested. The hidden Graph renderer stays mounted
to retain its viewport, while its search requests pause.

The active Dashboard and browse views still fill at most 50 × 100 Memories:
their current statistics and type counts use that complete browse window.
Scroll-driven network pagination requires separate summary/statistics reads;
this page-demand policy does not change the existing counts or browse limit.

`src/shared/browser/sdk.ts` constructs the same-origin SDK client with browser
credentials and connects its `onRequest` observer to the request log. The SDK owns
API paths, Workspace headers, serialization, response parsing, cancellation, and
errors. There is no separate shared browser HTTP transport or custom SDK fetch
wrapper. Components do not call `fetch` directly. Browser Memory types are aliases
of the SDK's generated contract; server Zod schemas remain the validation and
OpenAPI source. Human-only SDK methods for Agent administration and Workspace
portability do not add CLI commands or MCP tools.

The development Graph benchmark is a separate measurement endpoint, outside the
public SDK/OpenAPI contract, and returns 404 in production. Its isolated
`prototype-client.ts` reads response text directly to measure the original decoded
UTF-8 payload, including whitespace. `GraphScalePrototype.tsx` owns prototype
routing and the SVG control separately from `WorkerCanvasGraph.tsx`.
`prototype-hooks.ts` still keeps its remote state in SWR with a separate benchmark
cache key and disables focus/reconnect refresh and error retries so a renderer
comparison keeps its dataset stable. SDKs and Node scripts do not import SWR.

Provider adapters and benchmark readers/judges use the official OpenAI, Google
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

MemOS and the vLLM/llama.cpp reranking contracts (including `/score`) retain their
specific HTTP adapters because the selected SDKs do not cover those exact
contracts. Their small `packages/lore-core/src/provider-http.ts` boundary checks
status and consumes bounded JSON; it does not implement a generic HTTP client.
Dataset streaming, checksum verification, and temporary-file promotion belong to
`scripts/benchmarks/lib/dataset-download.ts`; the MemoryAgentBench row-to-JSONL
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
2. Browser modules may import browser helpers, domain types, presentation, clients,
   and hooks. Imports of server contracts must be type-only. Never import server
   provider construction, database adapters, or native parsing into a client module.
3. Server implementation depends on the reusable engine and host runtime through
   the existing interfaces. Keep environment reads out of `packages/lore-core`.
4. Each domain owns its OpenAPI paths and components; `src/server/openapi/document.ts`
   assembles them. SDK generation reads that assembled document. Zod owns Memory
   validation and its OpenAPI schemas; browser Memory types come from the generated
   SDK contract, without a second handwritten wire model.
5. Do not add compatibility re-export files at the retired `src/lib` paths. Update
   callers when moving an interface.

## Scripts and tests

Script groups are `database`, `dev`, `build`, `checks`, `benchmarks`, and
`evaluation`. Shared benchmark/evaluation helpers and their fixtures live within
the corresponding group. Package-script names remain the supported command surface:
`bun run service:up`, `bun run db:migrate`, `bun run sdk:check`, and the existing
benchmark commands still work from the repository root.

Tests are grouped under `tests/modules/<domain>`, `tests/core`, `tests/server`,
`tests/ui`, `tests/packages`, `tests/benchmarks`, and `tests/integration`.
Shared database fixtures remain in `tests/support`; runnable worker fixtures remain
in `tests/fixtures`. Vitest discovers all groups recursively.

Use the ordinary verification commands:

```sh
bun run typecheck
bun run lint
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
