<h1 align="center">
  <img src="public/lore-mark.svg" alt="" width="36" height="36"><br>
  Lore
</h1>

<p align="center">
  <strong>Open-source memory infrastructure for users and their agents.</strong>
</p>

Lore is a self-hostable Memory System built on Postgres. A Workspace is the only
tenant boundary; Users can own multiple Agents, and private Memory belongs to the
User rather than to one Agent.

The old generic gbrain/admin proxy has been removed. Lore now owns persistence,
identity mapping, authorization, retrieval, and evaluation directly.

## What works

- native Memory create, read, update, delete, list, provenance, and shared/private
  scope;
- lexical + optional vector retrieval with visibility filtered before top-k;
- Users, Identities, Workspaces, Memberships, Agents, Workspace grants, and hashed
  one-time Agent credentials;
- Postgres RLS over all tenant-owned source, chunk, credential, and Evaluation data;
- versioned Evaluation Suites with Recall@K, MRR, nDCG, latency, cost, and hard
  isolation failures;
- a working Memory console plus native HTTP APIs;
- OSS Docker/Postgres deployment and a Cloudflare Workers + Hyperdrive adapter.

AutoDream, automatic consolidation, summarization, and proactive insight generation
are intentionally outside v1. Production embedding providers and background retry
workers are the next retrieval-maintenance layer; writes already remain available
when embeddings are unavailable. The v1 embedding contract is 1536 dimensions,
backed by an HNSW cosine index.

## Run with Docker

Bun 1.3.14+, Node 24 LTS, and a Postgres distribution with pgvector are required. The fastest
self-hosted setup is:

```bash
cp .env.example .env
# Set unique LORE_DB_ADMIN_PASSWORD and LORE_DB_RUNTIME_PASSWORD values in .env.
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). The Compose stack runs every
SQL migration, provisions a separate non-owner runtime login, and starts Lore under
the `lore_app` RLS role. The example binds to `127.0.0.1` and opts into
unauthenticated local access; never expose `AUTH_MODE=none` or `ALLOW_INSECURE=1`
to the internet.

For a temporary single-operator deployment, `AUTH_MODE=password` accepts HTTP
Basic but always maps an accepted login to `LORE_LOCAL_SUBJECT`; the Basic username
cannot be used to select or impersonate another internal User. Multi-user deployments
should use a verified identity proxy such as Cloudflare Access.

Lore keeps a single text lockfile, `bun.lock`. Bun owns dependency installation and
script dispatch; self-hosted application and migration code still execute on Node 24,
while the Cloudflare artifact executes on Workerd.

## Local development

Start Postgres/pgvector, then bootstrap the schema and runtime login with an admin
connection:

```bash
bun install --frozen-lockfile
export DATABASE_URL=postgres://lore_admin:password@localhost:5432/lore
export LORE_RUNTIME_ROLE=lore_runtime
export LORE_RUNTIME_PASSWORD=runtime-password
bun run db:bootstrap
```

Set `DATABASE_URL` to the new runtime login, copy the remaining local values from
`.env.example`, and run:

```bash
bun run dev
```

## HTTP surface

Human requests select a Workspace using `x-lore-workspace-id`. Agents use
`Authorization: Bearer lore_agent_…` plus the same Workspace header; the token is
accepted only while both the credential and Workspace grant remain active.

- `/api/workspaces`
- `/api/memories` and `/api/memories/:id`
- `/api/agents`, `/api/agents/:id/credentials`, and grant/credential revocation
- `/api/evaluations/suites`, suite runs, and run results

Agent tokens are returned only at creation time. Lore stores only their SHA-256
hash and a short display prefix.

## CoreSpeed Cloud / Cloudflare

Cloudflare is the only managed deployment target. Lore uses OpenNext on Workers and
a cache-disabled Hyperdrive binding to the same Postgres schema:

```bash
# Run migrations from a trusted environment first.
bun run db:migrate

# Use the non-owner runtime database login created by db:bootstrap.
bunx wrangler hyperdrive create lore \
  --connection-string="postgres://lore_runtime:...@db.example.com:5432/lore" \
  --caching-disabled

# Put the returned id and Cloudflare Access values in wrangler.jsonc.
bun run deploy:cloudflare
```

Do not enable Hyperdrive query caching for Lore. Authorization and RLS reads depend
on transaction-local User/Workspace context and must always be fresh. The checked-in
Hyperdrive id and Access values are deliberate placeholders.

## Verify changes

```bash
bun run typecheck
bun run lint
bun run test
bun run build
bun audit --audit-level=high
bunx opennextjs-cloudflare build
bunx wrangler deploy --dry-run
```

The deterministic synthetic benchmark is
[`evaluation/suites/synthetic-v1.json`](evaluation/suites/synthetic-v1.json). See
[`AGENTS.md`](AGENTS.md) for architecture and working agreements and
[`CONTEXT.md`](CONTEXT.md) for canonical domain terminology.

For graph renderer stress testing, use a separate disposable PostgreSQL database:

```bash
createdb lore_graph_benchmark
BENCHMARK_DATABASE_URL=postgres://localhost:5432/lore_graph_benchmark \
  bun run benchmark:graph:seed
```

This creates 5,000 deterministic nodes and 105,000 unique links under the
`graph_benchmark` schema. The dataset is deliberately separate from product
Memories, tenant authorization, and retrieval evaluation.

## License

[MIT](LICENSE) © CoreSpeed
