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
- durable directed Memory Links, clickable `[[reference]]` wikilinks, and derived
  affinity for otherwise isolated Memories;
- lexical + optional vector retrieval with visibility filtered before top-k;
- Users, Identities, Workspaces, Memberships, Agents, Workspace grants, and hashed
  one-time Agent credentials;
- Postgres RLS over all tenant-owned source, chunk, credential, and Evaluation data;
- versioned Evaluation Suites with Recall@K, MRR, nDCG, latency, cost, and hard
  isolation failures;
- a working Memory console plus native HTTP APIs;
- OSS Docker/Postgres deployment and a Cloudflare Workers + Hyperdrive adapter.

AutoDream, automatic consolidation, summarization, and proactive insight generation
are intentionally outside v1. Lore includes Ollama, Google Gemini, and OpenAI
embedding adapters; background retry and re-index workers are the next
retrieval-maintenance layer, and writes remain available when embeddings are
unavailable. Embedding configuration is set once per deployment. Local deployments
default to Qwen3-Embedding 0.6B at 1024 dimensions.

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

For local semantic retrieval, install Ollama on the host and pull the lightweight
default model before starting Lore:

```bash
ollama pull qwen3-embedding:0.6b
```

The example configuration uses `OLLAMA_KEEP_ALIVE=0`, so Ollama unloads the model
after each request instead of holding roughly 1.4 GB of unified memory. Set a
duration such as `5m` when lower query latency matters more than idle RAM.

Self-host operators choose the deployment-wide provider and model. Lore v1 fixes
the vector protocol at 1024 dimensions, so the database and every adapter share
one exact storage contract. The default local recipe is:

```bash
LORE_EMBEDDING_PROVIDER=ollama
LORE_EMBEDDING_MODEL=qwen3-embedding:0.6b
```

Google Gemini is a native alternative and does not require Ollama:

```bash
LORE_EMBEDDING_PROVIDER=google
LORE_EMBEDDING_MODEL=gemini-embedding-2
GEMINI_API_KEY=replace-with-a-server-side-key
```

OpenAI is also available through its native Embeddings API:

```bash
LORE_EMBEDDING_PROVIDER=openai
LORE_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_API_KEY=replace-with-a-server-side-key
```

Lore calls each provider directly and sends API keys only from the server. The
Google adapter distinguishes document indexing from retrieval queries using the
model's documented retrieval preprocessing; OpenAI and Ollama use the same text
for both roles. Every adapter must return exactly 1024 values. Changing a running
deployment's provider or model creates a different embedding space, so existing
vectors are excluded from semantic retrieval until re-embedded. Automated
background re-indexing is not implemented yet.

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
hash and a short display prefix. Embedding selection is deployment-wide and is not
exposed to Workspace members or Agents.

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
