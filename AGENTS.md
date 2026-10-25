# AGENTS.md — Lore

Orientation for AI coding agents (Claude Code, Codex, Cursor, Gemini, Copilot, …)
working in this repo. **This file is the single source of truth for agent-facing
project instructions.** `CLAUDE.md` is a symlink to it and
`.github/copilot-instructions.md` points to it — edit this file or the reference
below, never a copy. The detailed conventions for each area live in
[`docs/agent-conventions.md`](docs/agent-conventions.md). They are part of these
instructions. Before you change or review an area, read its section there; the
"Reference topics" table below shows which section covers which area. The file is
too large to read whole: find the section with `grep -n '^## '
docs/agent-conventions.md` and read only that range. Where a summary here and its
section differ, the section is correct. Do not import that reference
automatically, and do not copy its details back into this file.
The canonical product vocabulary lives in [`CONTEXT.md`](docs/CONTEXT.md).
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

- **lore core** — `packages/lore-core` (`@corespeed/lore-core`) is the reusable
  memory engine. It contains Memory CRUD, hybrid retrieval, content bounds,
  chunking, Memory Links and Graph reads, leased embedding maintenance, and the
  optional Episode/Observation capability group. It also defines the embedding,
  reranking, and query-planning capability interfaces and a schema-contract test
  kit (`./testing`). Its methods take no Actor. The host starts and authorizes
  every storage transaction.
- **lore oss** — everything else in this repository: identity and tenancy, request
  context and authorization, request idempotency, HTTP/OpenAPI, the TypeScript
  SDK, CLI, and MCP, the web UI, Memory Proposals, code-aware memory, portability,
  evaluation, deployment profiles, and the concrete model adapters in
  `src/server/providers`. See `docs/architecture.md` for the dependency contract.

Main rules (the reference sections have the full text):

- **Core owns its SQL; the host owns connections** (Yunpeng, 2026-10-03). Core
  imports no database driver. The OSS `pg` adapters live in
  `src/server/database/postgres.ts`.
- `packages/lore-core` is a package to enforce a boundary, not to ship an artifact.
  It is private and has no build. Its `tsconfig.json` has no `@/*` mapping, and
  `biome.json` denies it OSS paths, host frameworks, Zod, and model SDKs. Keep both
  guards. No file under `packages/lore-core` may import a file outside that package.
- `packages/lore-core/src/schema-contract.ts` lists every table, column, function,
  and setting that the engine uses. A test fails when a table, function, setting,
  INSERT column list, or ON CONFLICT target differs from it; keep read-only
  column lists by hand.
- CoreSpeed HaaS keeps its own fork, `packages/memory-core`, and ports changes
  manually (Yunpeng, 2026-09-15). Lore changes land here. Do not mirror them
  automatically, and do not assume that the two packages are the same.
- lore-core owns the domain contract: types, `as const` vocabularies, limit
  objects, and plain validators that throw `LoreValidationError`. Core does not use
  Zod (the user's 2026-09-26 decision). OSS derives its Zod schemas and OpenAPI
  from these exports and never restates an engine rule. The engine refuses an
  out-of-range value. It never clamps or trims the value into range.
- The schema is live in production (CoreSpeed HaaS). Never edit an applied
  migration: its stored SHA-256 makes every deployment fail closed. Ship each
  schema change as a new forward-only migration, and keep its `down` section empty.
- Each new migration must set `lore_system_state.schema_revision` to its own
  number (currently 20) and set `compatible_from` in the same final UPDATE. In the
  same change, bump `LATEST_SCHEMA_REVISION`
  (`scripts/database/lib/migration-preflight.ts`) and `LORE_SCHEMA_REVISION`
  (`src/modules/operations/service.ts`).
- Put `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` in their own
  `-- migrate:up transaction:false` migration, never in a transactional one. Drop
  each such index before you build it. Never apply a migration file with one
  `exec(fileContents)`; use `applyMigrationChain` or `migrationQueries`.
- Every engine transaction binds the Actor
  (`src/server/database/memory-storage.ts`). Route handlers call domain services.
  Do not put SQL in a route.
- A Memory is one coherent knowledge record: at most 32,000 characters and 64
  chunks, with 8,000 characters recommended. Direct writes, Proposals, and imports
  use one validator. Send a longer document to `document_fragment` Observations in
  a document Episode. Never split it into Memories automatically. A Memory chunking
  change needs a new chunking revision, a forward re-chunk and re-embedding
  migration, and a versioned evaluation. Its optional title (at most 256 characters)
  and English gloss (at most 512, for content in another language) are each one line,
  held to `validateMemoryTitle`/`validateMemoryGloss` and matching CHECKs; lexical
  search reads them, but they are never chunked or embedded. Its optional
  `occurredAt` (`validateMemoryOccurredAt`) is when its event happened, never
  inferred from content.
- UI, CLI, and MCP use the TypeScript SDK, which calls the OSS API. Components must
  not call `fetch` directly. Every bound, vocabulary, and default that a client
  checks comes from the SDK's `LORE_CONTRACT`.
- Browser files of a domain live under `src/modules/*/browser/`.
  `bun run architecture:check` enforces the layers and the module graph.
- Native Git and AST parsing run only in the Bun maintenance worker, never in the
  Cloudflare request bundle. A Code Index parser, symbol, or chunking change must bump
  `CODE_INDEX_REVISION` and append the old value to
  `SUPERSEDED_CODE_INDEX_REVISIONS`.
- Embedding configuration errors and provider failures must log a warning on the
  server and fall back to lexical search. They must not block Memory reads or
  writes. A reranker failure must fall back to the deterministic fused order.
- lore oss pins vectors at 1024 dimensions; lore-core takes the width as the host
  option `embeddingDimensions`. Never compare vectors unless provider, model, and
  revision all match one compatible generation.

Still incomplete: the full Evaluation management UI and Workspace member
management. A second User can join a Workspace only through direct SQL. The
reference section "Workspaces, Agents, API routes, and the public contract" gives
the current state of each surface.

Do not:

- reintroduce a generic upstream-tool or admin passthrough;
- add an upstream brain as Lore's persistence or authorization model;
- preserve the old “Lore never writes” assumption — the new product stores
  Memories;
- bypass native modules with direct route-level SQL.

The active frontend contract is [`DESIGN.md`](docs/DESIGN.md). Keep one application
stylesheet (`src/app/globals.css`). Graph combines native durable Memory Links with
derived affinity for isolated Memories; never wire it back to the removed gbrain proxy.

Reintroduce a historical UI idea only when it serves the native product. Do not
add a compatibility client or an upstream adapter for it. The reference section
"Browser shell, cache, and import boundaries" lists what you can reintroduce.

Build the native domain modules directly. Compatibility adapters, if ever needed,
must sit outside the Memory interface and may not weaken its ownership or RLS
invariants.

### Reference topics

| Area | Section in `docs/agent-conventions.md` |
| --- | --- |
| Core/OSS split, `lore-core` package rules, schema contract, domain contract | Engine and host boundary |
| Module seams and what each module hides | Target module seams |
| Migrations, schema revisions, `compatible_from`, replay ledger, dbmate, readiness, capabilities, restore verification | Schema migrations and revisions |
| Memory content bounds and chunking | Memory content and chunking |
| Code Index, Code Evidence, Code dependency graph, context packets, grounding gate | Code Index, Code Evidence, and context packets |
| Workspaces, Agents, Hono routes, admission, errors, idempotency, OpenAPI/SDK/CLI/MCP, Zod schemas, Workspace export and import, current gaps | Workspaces, Agents, API routes, and the public contract |
| Browser shell, search UI, SWR cache, browse window, historical UI, `architecture:check` import guard | Browser shell, cache, and import boundaries |
| Memory Markdown rendering and plain-text titles | Memory Markdown rendering |
| Graph reads, Memory Links, Graph renderer | Graph and Memory Links |
| Embedding jobs, generations, re-indexing | Embedding maintenance |
| Memory Proposals, Episodes, Observations, Episode evidence search, Memory Observation Evidence | Memory Proposals and Episodes |
| Model providers, lexical channels, reranking, retrieval knobs, embedding protocol, benchmark reader and judge credentials | Providers, search, reranking, and retrieval knobs |
| OTLP, Docker/Compose, native local service, Worker request pool, pg pipelining | Deployment, observability, and the local service |
| Suites, external datasets, benchmark runners, the `bun run eval` harness, the Graph stress dataset, and their rules | Benchmark and evaluation |
| Toolchain, commands, generated files, test and build traps, why an agent cannot merge | Toolchain, tests, and pull requests |

## Product scope

The v1 system must provide:

- Memory create, read, update, delete, and provenance;
- immutable, durable Observation evidence grouped into bounded Episodes;
- hybrid retrieval over only the Memories the caller may see;
- Users, Identities, Workspaces, Memberships, Agents, and agent Workspace grants;
- user-private and Workspace-shared Memory enforced with Postgres RLS;
- owner-private Memory Proposals with human-only acceptance into canonical Memory;
- deterministic background maintenance: chunking, embedding, indexing, retries,
  re-indexing, and cancelling jobs a later write made stale;
- a Benchmark/Evaluation suite covering retrieval quality, isolation, latency, and
  cost.

The v1 system does **not** include AutoDream / automated memory consolidation,
automatic summarization, automatic merging, or proactive insight generation. If
introduced later, consolidation must be an explicit opt-in extension, not a
requirement of the Memory interface.

## Domain model and invariants

Use the terms and definitions in [`CONTEXT.md`](docs/CONTEXT.md). The central relations
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
Memory ──< Memory Observation Evidence >── Observation
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
  enters ordinary Memory retrieval or Graph. A Memory's citation of an Observation
  is visible only while both are visible, so a shared Memory never reveals a private
  Observation, not even its id.
- Visibility and write authority are separate: sharing a Memory does not transfer
  ownership or grant other members permission to mutate it. Only the owner User or
  an authorized Agent acting for that User may mutate it.
- Shared is the default scope. A caller must explicitly request private scope.
- There is no cross-Workspace access and no cross-user private synthesis or batch.
- Code Artifacts and Memory Code Evidence are Workspace-scoped, revision-bound
  evidence and never enter canonical Memory. The reference section "Code Index,
  Code Evidence, and context packets" has their rules.

The reference section "Schema migrations and revisions" lists the main tables.

Do not add tenant columns mechanically after building single-tenant features.
`workspace_id`, ownership, and scope are part of the domain and query design from
the first migration.

## Security and RLS

Lore is an OSS system that stores private, multi-tenant data. Authorization is a
database invariant, not a UI convention.

- Postgres is the primary store. RLS must cover every tenant-owned table, including
  chunks, embeddings, graph/relationship data, credentials, and evaluation data.
- A request resolves an authenticated User and an active Workspace, then installs
  that context for the database transaction; on hot routes the resolution is the
  first transaction's prefix and binds the context from the database's own answer.
  Never trust a caller-supplied user or Workspace id by itself.
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
- Code search and Code dependency reads must select the Workspace, repository, and
  full commit OID (dependency reads also the active generation) before top-k or
  traversal. The reference section "Code Index, Code Evidence, and context
  packets" has the indexing and edge rules.
- Deleting a Memory removes its chunks, embeddings, jobs, and Links in the same
  transaction. A scope change takes effect immediately and rewrites nothing: chunk,
  embedding, Link, and Graph reads authorize through the parent Memory row's RLS
  policy, and none of them stores scope.
- HTTP update/delete requires a strong Memory ETag through `If-Match`; retries may
  use actor/operation-scoped `Idempotency-Key`. Keep the lock, version check, source
  write, chunk/job changes, replay record, and mutation event in one transaction.
- Workspace export is always a human Actor/RLS-visible logical archive. Import must
  validate its checksum and limits, dry-run cleanly, require explicit owner remap,
  and record source provenance. Import is human-only and writes fresh
  host-generated ids, never an archive's. It is not a PostgreSQL backup. The
  archive checksum is a permanent format: change it only with a new archive
  format. The reference section "Workspaces, Agents, API routes, and the public
  contract" has the size, validation, timestamp, and format rules.
- Mutation events and deletion tombstones never retain Memory content, query text,
  credentials, or provider payloads and must expire. A future change feed/webhook/
  AutoDream consumer reads this outbox; it must not weaken source-table RLS.
- Credentials and secrets stay server-only, are stored hashed or encrypted as
  appropriate, and never use `NEXT_PUBLIC_*` variables. `create-runtime-role.ts`
  sends only SCRAM-SHA-256 verifiers, never cleartext passwords, so runtime
  passwords must be printable ASCII.
- Memory, Proposal, metadata, and Observation text is untrusted input from other
  users and Agents. Render it only through `renderMemoryMarkdown`, `plainInline`,
  or `plain`; never set `innerHTML` from another path.
- Readiness and restore verification require RLS on every public table except
  `lore_system_state`, `lore_schema_migrations`, and extension-owned tables. Every
  `REQUIRED_TENANT_TABLES` entry must still exist with RLS, whoever owns it.
- `AUTH_MODE=none` is only acceptable for explicit local development with
  `ALLOW_INSECURE=1`; production fails closed. Compose supplies no default for
  `AUTH_MODE` or `ALLOW_INSECURE`; the local no-auth opt-in lives only in `.env`,
  and removing it fails closed.
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
- Create the request pool inside each Worker request, queue batch, or cron run, and
  close it when that context ends. Do not cache a socket-backed Pool/Client
  globally across Worker requests.
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
surfaces. The reference section "Target module seams" lists each module and what
it hides. Read it before you add a module or change what a module owns.

Keep OSS RLS policy SQL and storage-context installation with the host schema and
database modules; Core queries use the host-constrained store.
Do not expose storage-provider details at the product interface. Introduce an
adapter only where behavior actually varies (for example, a production embedding
provider and a deterministic test adapter).

## Benchmark / Evaluation

Benchmark is part of the product quality system even without AutoDream. The
suites, datasets, runners, and their rules are in the reference section
"Benchmark and evaluation".

- Keep a deterministic synthetic suite in the repository for CI and version
  comparisons.
- Run a `benchmark:*` runner only against a disposable database whose name contains
  `bench` or `benchmark`. The `bun run eval` harness uses the shared
  `LORE_EVAL_SERVER_URL` server, whose databases are not disposable.
- Isolation failures are hard failures, not a score. Bob-private tripwires guard
  the suites, and a leak exits non-zero.
- Evaluation runs are read-only against production data. Never centralize or
  export private production Memories for evaluation by default.
- Workspace-owned evaluation suites follow the same RLS rules as Memories.
- Record the exact providers, models, instructions, and retrieval knobs in every
  benchmark report.
- Do not present a diagnostic run (for example `--retrieval-only`) as an official
  benchmark score.

## Current stack and development loop

The stack is Next.js 16 (App Router), React 19, Hono, Bun 1.4.2+, TypeScript 7,
dbmate, and `pg`, with no runtime ORM. The reference section "Toolchain, tests,
and pull requests" lists the rest.

`bun.lock` is the only dependency lockfile. Do not add an npm, pnpm, or Yarn
lockfile. Bun runs the self-host processes, scripts, builds, and tests. The
Cloudflare bundle runs on workerd, not on Bun or Node. Keep credential-sensitive
scripts and CLI/MCP entrypoints on `--no-env-file`. Keep Bun-only APIs out of the
portable code of Core and the TypeScript SDK.

Under `tools/` and `scripts/`, name an executable entrypoint with a verb phrase and
a library with a noun phrase. Word order alone must never tell the two apart.

API routes (the reference section "Workspaces, Agents, API routes, and the public
contract" has the full routing, admission, and error rules):

- `src/server/api/app.ts` composes the domain subrouters from
  `src/modules/*/routes.ts` with Hono's `app.route()`. Route handlers call domain
  services directly.
- Use `app.request()` for API tests, including middleware and routing.
- A failure that a caller can see extends `DomainError` in `src/server/errors.ts`
  and declares its `code`. Domain modules name no HTTP status. A route never
  writes `c.json({ code })`.
- `admitRequest` (`src/server/auth/auth.ts`) answers 403 to an unsafe cross-site
  request (`Sec-Fetch-Site` or `Origin`); only a well-formed `Bearer lore_agent_…`
  token on `/api/` skips that check. A route answers a missing or invisible
  resource with `NotFoundError`. Domain handlers authorize Actors and install RLS.
  Only `lore_app`, `lore_maintenance`, or its owner may execute a `lore` function,
  never `PUBLIC`.
- Every API endpoint is a Hono route (`src/modules/*/routes.ts`). A Next route
  handler under `src/app/api/` gets no middleware and no admission; only
  `/api/prototype/*` (development only) stays in Next.
- Every JSON request body goes through `jsonObject` (`src/server/api/input.ts`).
- The default dev, start, and local-service commands run one Next.js service on
  Bun. Do not add an internal HTTP proxy, a custom outer server, or a second API
  process.

All handwritten JavaScript-family source must use TypeScript/TSX. Do not substitute
`any`, unchecked casts, or suppressed diagnostics for input validation or accurate
types. TypeScript 7 is the workspace compiler, but `tools/sdk-codegen` keeps
TypeScript 5.9.3 on purpose. The reference section "Toolchain, tests, and pull
requests" gives the reason and the tooling `tsconfig` rules.

The reference section "Toolchain, tests, and pull requests" lists the commands: the
verification loop, database (`db:*`), benchmark (`benchmark:*`), and evaluation
(`eval`). "Commit / PR conventions" below names the checks that must pass before
a PR.

Do not commit generated `.next` or `.open-next` output. The exception is
`src/types/cloudflare-env.d.ts`: regenerate it with `bun run cf:typegen` after you
change `wrangler.jsonc` or `.dev.vars.example`, or upgrade Wrangler.

## Testing scope and gotchas

Test Lore's own logic: validation, parsing, retrieval, authorization, state
transitions, and API contracts. Do not add component rendering, DOM interaction,
or database-connectivity tests. Pure browser logic such as pagination, cache
isolation, and routing still belongs in tests. Use a database when the behavior
under test is our SQL, transaction policy, migration, or RLS rule; do not replace
those rules with mocks that merely repeat their implementation.

- Date strings are UTC; render date labels with `timeZone: "UTC"`.
- Keep the per-module PGlite snapshot isolation in `tests/support/memory-context.ts`.
  Migration tests must still run migrations on empty databases.
- Use Bun 1.4.2 or later. Bun 1.3.x segfaults in `next build` and can kill a Vitest
  worker.
- `src/middleware.ts` is the page authentication gate. Keep that name: rename it to
  `proxy.ts` only together with a green Cloudflare build. After a change,
  `bun run smoke:next` must still get 401 for an unauthenticated `GET /`.
- `bun run lint` checks nothing under a path that contains `/tmp`, `.claude`, or
  `.worktrees`. "Checked 0 files" does not mean that the tree is clean.
- Keep `voyageai` at 0.1.0 until a newer version passes the Cloudflare dry run.

The reference section "Toolchain, tests, and pull requests" has the full text of
these rules and the other known traps: a stale `tsbuildinfo`, a build during `next
dev`, a global gitignore with Git fixtures, the SDK fetch receiver, Wrangler type
generation, and a Code Index job left in `processing`. Read it before you upgrade a
dependency, regenerate types, or bisect, and when a check behaves unexpectedly.

## Commit / PR conventions

- Conventional commits: `feat(scope): …`, `fix: …`, `chore: …`, `docs: …`.
- Preserve unrelated user changes and untracked files.
- If behavior, commands, architecture, or a gotcha changes, update the rule in the
  same PR: its section in [`docs/agent-conventions.md`](docs/agent-conventions.md)
  and, if this file summarizes it, the summary too. Update [`CONTEXT.md`](docs/CONTEXT.md) whenever canonical domain language
  changes.
- `/ship` is the supported flow for turning finished work into a merge-ready PR
  (Yunpeng, 2026-09-20; it was previously disabled here). It commits, merges the
  base, runs the repository checks, opens or updates the PR, and loops with an
  independent reviewer until CI is green and the reviewer posts `APPROVE`.
  **`/ship` never merges** — see the next item for why nothing else can either.
- **An agent cannot merge this repository, and that is not a misconfiguration.**
  When `gh pr view` reports `mergeable=MERGEABLE` with `mergeStateStatus=BLOCKED`
  and `reviews=0`, the work is finished. Only a human `Approve` or an independent
  reviewer identity is missing. Say so and stop; do not look for a bypass. The
  reference section "Toolchain, tests, and pull requests" gives the reason.
- Ship's reviewer loop is how an agent-authored PR gets that approval. Do not run
  it as a rubber stamp: it is an independent session, and a `REQUEST_CHANGES`
  verdict is work to do, not an obstacle to route around.
- Every CI job must pass before merge: `static`, `tests`, `database`, `packages`,
  `build`, and the aggregate `check` gate that requires the other five. Run these
  locally first: `bun run design:check`, `bun run typecheck`, `bun run lint`,
  `bun run test` (Vitest plus the lore-core check; never bare `bun test`),
  `bun run build`, `bun run packages:smoke`, and the deployment dry runs.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
