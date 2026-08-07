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

- the squashed `0001_initial.sql` migration defines identity, tenancy, user-private
  Agents, Memory/chunks/links, pgvector state, and versioned Evaluation tables with RLS;
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
- Docker/Compose targets OSS self-hosting; OpenNext + a cache-disabled Hyperdrive
  binding targets CoreSpeed Cloud on Cloudflare Workers.

Still incomplete: background retry/re-index queue workers and full Agent/Evaluation
management UI. Chunking and lexical indexing are synchronous; the Ollama, Google
Gemini, and OpenAI adapters are configured once per deployment, and embedding
failure is explicit (`NULL`) and never blocks a Memory write. Local deployment
defaults are Qwen3-Embedding 0.6B at 1024 dimensions with `OLLAMA_KEEP_ALIVE=0`.
Invalid embedding configuration and provider request failures must warn server-side
and degrade to lexical/`NULL` behavior; they must not block Memory reads or writes.
The pgvector column and HNSW index are fixed at 1024 dimensions. Self-host operators
choose `LORE_EMBEDDING_PROVIDER` and `LORE_EMBEDDING_MODEL`; dimension and
preprocessing revision are Lore v1 protocol invariants. Never compare vectors unless
provider, model, and revision all match the active deployment. Embedding model
selection is not a Workspace/User product setting. Until embedding storage is
partitioned by space, the semantic query must keep its `MATERIALIZED` active-space
CTE so global HNSW traversal cannot mix incompatible spaces before top-k.

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
- Retrieval metrics may include Recall@K, MRR, and nDCG; isolation failures are
  hard failures, not a score that can be averaged away.
- Workspace-owned evaluation suites follow the same RLS rules as Memories.
- Never centralize or export private production Memories for evaluation by default.
- Evaluation runs are read-only against production data. Any write/replay test uses
  an isolated evaluation Workspace or disposable database.

## Current stack and development loop

The existing application uses:

- Next.js 16 (App Router), React 19, Bun 1.3.14+ for package management,
  Node 24 LTS for self-hosted execution, and TypeScript 7;
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
bun run db:bootstrap # migrate + provision a non-owner runtime login
bun run benchmark:graph:seed # rebuild an isolated renderer stress database
bun run typecheck  # generate Next types, then tsc --noEmit
bun run lint       # biome check .
bun run format     # biome check --write .
bun run design:check # enforce and self-test the Lore UI contract
bun run test       # vitest run
bun run build      # next build (production)
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

Before opening a PR, design:check, typecheck, lint, test, and build must all pass.

Next.js 16 keeps development output in `.next/dev`, separate from production
build output. A production build no longer clobbers the running dev manifest, but
do not treat generated `.next` or `.open-next` output as source or commit it.

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
