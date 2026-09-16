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
| `src/shared/browser/` | Browser HTTP transport, SWR cache keys, request logs, and common hooks |
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
  schemas.ts       # Zod wire schemas and inferred types
  types.ts         # Additional browser-facing result types
  input.ts         # Memory-specific HTTP input handling
  http.ts          # Testable request handlers
  client.ts        # Typed browser requests
  hooks.ts         # Memory reads and cache behavior
  display.ts       # Memory title/type presentation
  markdown.ts      # Memory content rendering
  openapi.ts       # Memory paths and schema components
  components/      # MemoryView and SearchResults
```

Modules with their own application persistence use `service.ts`. Canonical Memory
persistence stays in `packages/lore-core`. A feature does not need a service file,
client file, or new package unless it has behavior to own.

Callers import the specific interface they use. There is no aggregate barrel that
re-exports server code alongside browser code. Domain hooks share the central
cache-key vocabulary so mutations can invalidate related views consistently.
Cross-domain UI composition belongs in `src/shell`.

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
   assembles them. SDK generation reads that assembled document. Zod owns the Memory
   input schema; other existing contracts retain their behavior during this refactor.
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
