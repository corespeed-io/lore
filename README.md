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

- native Memory create, read, update, delete, list, provenance, shared/private
  scope, replay-safe writes, and optimistic concurrency;
- durable directed Memory Links, clickable `[[reference]]` wikilinks, and derived
  affinity for otherwise isolated Memories;
- lexical + optional vector retrieval with visibility filtered before top-k;
- Users, Identities, Workspaces, Memberships, Agents, Workspace grants, and hashed
  one-time Agent credentials;
- Postgres RLS over all tenant-owned source, chunk, credential, and Evaluation data;
- versioned Evaluation Suites with Recall@K, MRR, nDCG, latency, cost, and hard
  isolation failures;
- crash-safe background embedding, retry, and atomic embedding-generation rollout;
- content-free transactional mutation events and expiring deletion tombstones;
- checksummed RLS-visible Workspace export/import plus PostgreSQL backup/restore
  tooling;
- a working Memory console, versioned HTTP APIs, OpenAPI, health probes, and
  privacy-safe optional OpenTelemetry;
- OSS Docker/Postgres deployment and a Cloudflare Workers + Hyperdrive adapter.

AutoDream, automatic consolidation, summarization, and proactive insight generation
are intentionally outside v1. Lore includes Ollama, Google Gemini, and OpenAI
embedding adapters. Chunking and lexical indexing complete inside the Memory write;
document embedding runs asynchronously and never blocks that write. Embedding
configuration is set once per deployment. Local deployments default to
Qwen3-Embedding 0.6B at 1024 dimensions.

## Run with Docker

Bun 1.3.14+, Node 24 LTS, and a Postgres distribution with pgvector are required. The fastest
self-hosted setup is:

```bash
cp .env.example .env
# Set unique admin, request-runtime, and maintenance passwords in .env.
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). The Compose stack runs every
SQL migration, provisions separate non-owner request and maintenance logins, and
starts both Lore and its embedding worker under narrow RLS roles. The example binds
to `127.0.0.1` and opts into
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
deployment's provider or model creates a separate embedding generation. Set
`LORE_EMBEDDING_BUILD_PROVIDER` and `LORE_EMBEDDING_BUILD_MODEL` on the maintenance
process as a complete pair to build it beside the active generation. Keep the
serving `LORE_EMBEDDING_PROVIDER` and `LORE_EMBEDDING_MODEL`, their credentials, and
any provider endpoint available to that process too: during rollout, request writes
still enqueue the serving generation while the maintenance worker drains both
serving and building generations. The self-host worker keeps one sequential drain
loop by default. Cloudflare Queue hints and the scheduled database sweep cover both
generations. After exact coverage validation, `bun run db:embedding:activate`
atomically switches generations and retains the prior space for bounded rollback.
Lore never compares vectors across incompatible generations.

Invalid deployment embedding configuration disables semantic embedding with a
server-side warning instead of blocking Memory reads or writes. Provider request
failures are also warned server-side; writes preserve the Memory with an explicit
`NULL` vector while the database-backed job retries with exponential backoff. Jobs
survive process restarts, and a short lease prevents two workers from completing the
same attempt.

After eight failed attempts a job remains `dead` for operator inspection instead of
retrying forever. Updating that Memory or changing the deployment embedding space
creates a fresh versioned job. After fixing a transient outage, a database operator
can explicitly retry that same version:

```sql
UPDATE memory_embedding_jobs
SET status = 'pending',
    attempt_count = 0,
    available_at = now(),
    lease_token = NULL,
    leased_at = NULL,
    last_error = NULL,
    completed_at = NULL,
    updated_at = now()
WHERE id = 'replace-with-exact-job-id'
  AND status = 'dead';
```

The deployment sweep prunes succeeded/cancelled history after 7 days and dead-job
diagnostics after 30 days.

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
export LORE_MAINTENANCE_ROLE=lore_maintenance_runtime
export LORE_MAINTENANCE_PASSWORD=maintenance-password
bun run db:bootstrap
```

Set `DATABASE_URL` to the new runtime login, copy the remaining local values from
`.env.example`, and run:

```bash
bun run dev
```

Run the self-host maintenance process in a second terminal using its own login:

```bash
bun run build:maintenance
LORE_MAINTENANCE_DATABASE_URL=postgres://lore_maintenance_runtime:maintenance-password@localhost:5432/lore \
  bun run start:maintenance
```

## HTTP surface

Human requests select a Workspace using `x-lore-workspace-id`. Agents use
`Authorization: Bearer lore_agent_…` plus the same Workspace header; the token is
accepted only while both the credential and Workspace grant remain active.

- `/api/workspaces`
- `/api/memories` and `/api/memories/:id`
- `/api/agents`, `/api/agents/:id/credentials`, and grant/credential revocation
- `/api/evaluations/suites`, suite runs, and run results
- stable aliases under `/api/v1`, with `/openapi.json` and
  `/api/v1/capabilities` (verified Actor plus `x-lore-workspace-id`)
- `/livez` for process liveness and `/readyz` for database, role, schema, vector,
  and RLS readiness

Memory reads return a strong ETag such as `"memory-v2"`. HTTP update and delete
require that value in `If-Match`; stale writes fail with `412 version_conflict`.
Mutation retries may send `Idempotency-Key`, scoped by Actor and operation. Memory
list responses expose `x-lore-next-cursor` for stable cursor pagination.

Agent tokens are returned only at creation time. Lore stores only their SHA-256
hash and a short display prefix. Embedding selection is deployment-wide and is not
exposed to Workspace members or Agents.

## Operations and portability

`bun run db:preflight` validates migration history and application/schema
compatibility. `bun run db:backup`, `db:restore`, and `db:pitr:check` cover the
operator PostgreSQL plane; Workspace export/import is a separate RLS-scoped logical
plane. See [`docs/operations.md`](docs/operations.md) for backup ownership,
restore drills, generation activation, degraded readiness, and telemetry privacy.

## CoreSpeed Cloud / Cloudflare

Cloudflare is the only managed deployment target. Lore uses OpenNext on Workers,
Queues for low-latency job wake-ups, and two cache-disabled Hyperdrive bindings to
the same Postgres schema:

```bash
# Run migrations from a trusted environment first.
bun run db:migrate

# Use the non-owner runtime database login created by db:bootstrap.
bunx wrangler hyperdrive create lore \
  --connection-string="postgres://lore_runtime:...@db.example.com:5432/lore" \
  --caching-disabled

bunx wrangler hyperdrive create lore-maintenance \
  --connection-string="postgres://lore_maintenance_runtime:...@db.example.com:5432/lore" \
  --caching-disabled

bunx wrangler queues create lore-memory-maintenance
bunx wrangler queues create lore-memory-maintenance-dead-letter

# Put the returned id and Cloudflare Access values in wrangler.jsonc.
bun run deploy:cloudflare
```

Do not enable Hyperdrive query caching for either Lore binding. Authorization, job
leases, and RLS reads depend on transaction-local context and must always be fresh.
The checked-in Hyperdrive ids and Access values are deliberate placeholders. Set
provider API keys with `wrangler secret put`; `.dev.vars.example` is only a local
Workerd template.

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

The deterministic Evaluation fixture is
[`evaluation/suites/synthetic-v1.json`](evaluation/suites/synthetic-v1.json). The
end-to-end retrieval benchmark uses
[`evaluation/suites/retrieval-v1.json`](evaluation/suites/retrieval-v1.json) to
measure paraphrase retrieval, multilingual retrieval, no-answer abstention, RLS
isolation, and warm latency against the configured deployment embedding model.

Run it only against a fresh disposable database:

```bash
createdb lore_retrieval_benchmark
DATABASE_URL=postgres://localhost:5432/lore_retrieval_benchmark \
  bun run db:migrate
BENCHMARK_DATABASE_URL=postgres://localhost:5432/lore_retrieval_benchmark \
  OLLAMA_KEEP_ALIVE=5m \
  bun run benchmark:retrieval
dropdb lore_retrieval_benchmark
```

The runner refuses database names without `bench` or `benchmark`, resets all User
and Workspace data in that database, exercises native Memory writes and leased
embedding maintenance, then compares lexical search with the suite's hybrid
distance thresholds. Override the sweep with comma-separated cosine distances in
`LORE_BENCHMARK_THRESHOLDS`. Any private-memory retrieval or embedding-provider
failure exits non-zero. The connection must be able to `SET ROLE lore_app` and
`lore_maintenance`; a local Postgres owner works for this disposable workflow.

Query/document preprocessing is part of the versioned embedding protocol. Testing
a different preprocessing strategy requires a new revision and re-index, not a
hidden benchmark-only prompt. See [`AGENTS.md`](AGENTS.md) for architecture and
working agreements and [`CONTEXT.md`](CONTEXT.md) for canonical domain terminology.

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
