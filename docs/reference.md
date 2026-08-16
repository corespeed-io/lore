# Lore technical reference

Detailed configuration, deployment, API, SDK, and benchmark notes for Lore. Start
with the [project README](../README.md) if you are new to Lore.

## Run with Docker

Bun 1.3.14+, Node 24 LTS, and a Postgres distribution with pgvector are required.
The source verification loop additionally requires Python 3.12+ for the Python SDK.
The fastest self-hosted setup is:

```bash
cp .env.example .env
# Set unique admin, request-runtime, and maintenance passwords in .env.
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). The Compose stack runs every
plain-SQL migration through dbmate, provisions separate non-owner request and
maintenance logins, and starts both Lore and its embedding worker under narrow RLS
roles. The example binds to `127.0.0.1` and opts into
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
model's documented retrieval preprocessing. For Qwen3-Embedding, the Ollama adapter
keeps documents unchanged and prefixes queries with Qwen's
[fixed, official retrieval instruction](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B).
That preprocessing is part of `lore-embedding-v2`, not an operator-tunable prompt.
The v2 revision is scoped to matching Qwen3/Ollama models. Google, OpenAI, and
other Ollama models remain on v1; OpenAI uses the same text for both roles. Canonical
Memory chunking is unchanged across these revisions. Every adapter
must return exactly 1024 values. Changing a running
deployment's provider or model creates a different embedding generation. Lore
materializes one exact compatible generation before semantic top-k, so vectors from
different providers, models, dimensions, or preprocessing revisions never mix. The
maintenance worker builds a complete replacement beside the active generation. Set
`LORE_EMBEDDING_BUILD_PROVIDER` and `LORE_EMBEDDING_BUILD_MODEL` as a complete pair
and keep both generations' credentials/endpoints available: request writes continue
to enqueue the serving generation while maintenance drains serving and building
jobs. The self-host worker remains sequential by default, while Cloudflare Queue
hints and the scheduled sweep cover both lanes. Activation is one transaction and
refuses missing, unfinished, or dead work. The old generation remains available for
bounded rolling-deploy compatibility and rollback. Model changes do not rewrite
canonical Memory chunks.

Canonical chunks use `lore-memory-chunking-v2`: non-overlapping partitions of at
most 1,200 Unicode code points that exactly reconstruct the Memory. The splitter
prefers paragraph and Markdown structure, then sentence, line, and whitespace
boundaries before a Unicode-safe hard split. The revision and zero-overlap policy
are reported by `/api/v1/capabilities`; changing them requires a forward
re-chunk/re-embedding rollout and a new evaluation profile.

Dense candidate search uses a deployment-wide cosine-distance gate of `0.5` by
default. `LORE_SEMANTIC_DISTANCE_THRESHOLD` accepts `0..2`; larger values favor
candidate recall but can add substantial no-answer noise, so change it only with a
versioned retrieval benchmark. This setting affects retrieval, not vector-space
compatibility, and does not require re-indexing.
Within an equal lexical or dense score, candidate and final top-k ordering prefers
the more recently updated Memory, then the higher chunk ordinal, then id. This
preserves the latest fact in ordered Memory logs instead of returning their oldest
equal-scoring item, and removes UUID-
driven ties and gives conflict-heavy recall a deterministic recency policy without
adding an unconditional recency score to otherwise unequal evidence.
The relaxed English channel also gives bounded query-side weight to proper names,
numbers, and long identifiers. This recovers specific entities without scanning
the entire RLS-visible corpus to estimate document frequency on every request.
`LORE_ENTITY_ALIAS_RECALL=1` adds a separate indexed, deterministic exact-alias
channel for names and identifiers. It remains off by default, applies the same
Workspace/scope/time/metadata/RLS filters before top-k, and never creates or infers
a Memory.

Invalid deployment embedding configuration disables semantic embedding with a
server-side warning instead of blocking Memory reads or writes. Provider request
failures are also warned server-side; writes preserve the Memory with an explicit
`NULL` vector while the database-backed job retries with exponential backoff. Jobs
survive process restarts, and a short lease prevents two workers from completing the
same attempt.

Lore also supports an optional deployment-wide second-stage reranker. The Memory
module first builds an RLS-visible candidate pool from simple/English lexical search
and the active dense embedding space, closes the database transaction, then sends
only a candidate's compact best-chunk-plus-neighbors passage to the reranker. The
expanded, bounded answer evidence is attached only after ranking, so a whole-small-
Memory reader profile does not dilute cross-encoder relevance or waste provider
context. A RAM-conscious local deployment
can serve Qwen3-Reranker-0.6B through llama.cpp's `/v1/rerank` API:

```bash
brew install llama.cpp
llama-server \
  --hf-repo ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF:Q8_0 \
  --reranking --ctx-size 8192 --host 127.0.0.1 --port 8080 \
  --no-webui --parallel 1 --n-gpu-layers all

LORE_RERANK_PROVIDER=llamacpp
LORE_RERANK_MODEL=ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF:Q8_0
LORE_RERANK_BASE_URL=http://127.0.0.1:8080
# Measured local starting point; recalibrate on your versioned suite.
LORE_RERANK_CANDIDATE_LIMIT=20
# Calibrate against your model and evaluation suite before enabling abstention.
# LORE_RERANK_MIN_SCORE=0.01
# Calibrate below 1.0 to trade a little relevance for less redundant evidence.
# LORE_RERANK_DIVERSITY_LAMBDA=0.85
# Blend reranker rank with first-stage hybrid rank; 1.0 is pure reranking.
# LORE_RERANK_WEIGHT=0.75
```

The Q8 GGUF is about 639 MB and remains an explicit operator download, not a Docker
default. llama.cpp uses the GGUF model's embedded rerank template, so Lore does not
send or report a configurable instruction for this adapter. Pin the GGUF artifact
and llama.cpp version in serious evaluation reports. A vLLM deployment remains
available for CUDA or another measured server:

```bash
vllm serve Qwen/Qwen3-Reranker-0.6B \
  --hf_overrides '{"architectures":["Qwen3ForSequenceClassification"],"classifier_from_token":["no","yes"],"is_original_qwen3_reranker":true}'

LORE_RERANK_PROVIDER=vllm
LORE_RERANK_MODEL=Qwen/Qwen3-Reranker-0.6B
LORE_RERANK_BASE_URL=http://127.0.0.1:8000
```

On Apple Silicon, the experimental vLLM-Metal pooling path has a different tested
contract: `/score`, not `/v1/rerank`. Lore's `vllm-score` adapter repeats the query
as one pair per already-authorized document, validates one normalized
`data[index].score` for every candidate, then sorts locally:

```bash
VLLM_ENABLE_V1_MULTIPROCESSING=0 \
VLLM_METAL_USE_PAGED_ATTENTION=1 \
VLLM_METAL_MEMORY_FRACTION=auto \
vllm serve mku64/Qwen3-Reranker-0.6B-mlx-8Bit \
  --revision ba80418a47fa1c4368a6c2287b0e449904063576 \
  --runner pooling --max-model-len 512 \
  --hf-overrides '{"architectures":["Qwen3ForSequenceClassification"],"classifier_from_token":["no","yes"],"is_original_qwen3_reranker":true}'

LORE_RERANK_PROVIDER=vllm-score
LORE_RERANK_MODEL=mku64/Qwen3-Reranker-0.6B-mlx-8Bit
LORE_RERANK_BASE_URL=http://127.0.0.1:8000
```

Treat vLLM-Metal as experimental until that exact model revision passes Lore's
quality, latency, and RLS benchmark on the deployment machine.

An experimental HiGMem-inspired setwise profile can reuse a local Ollama chat
model instead of loading another pairwise classifier. Lore sends only the already
authorized compact candidate passages, assigns opaque request-local ids, requires
one finite score for every id through native JSON Schema output, and fails open on
any missing, duplicate, foreign, or unbounded score:

```bash
LORE_RERANK_PROVIDER=ollama-listwise
LORE_RERANK_MODEL=qwen3.5:4b
LORE_RERANK_BASE_URL=http://127.0.0.1:11435
LORE_RERANK_CANDIDATE_LIMIT=50
LORE_RERANK_NUM_CTX=8192
LORE_RERANK_MAX_OUTPUT_TOKENS=2048
LORE_RERANK_MAX_DOCUMENT_CHARS=600
LORE_RERANK_KEEP_ALIVE=5m
```

This is a Lore adaptation of HiGMem's flat joint evidence selector, not a
reproduction of its automatically summarized Event hierarchy. Keep it disabled
until the exact local model digest, prompt hash, context budget, answer quality,
latency, and memory residency beat the smaller reranker on the target suite. See
the [primary-source query-time audit](research/query-time-memory-retrieval-audit.md).

Managed deployments can instead use [Cohere v2](https://docs.cohere.com/v2/reference/rerank),
[Memos MemReranker](https://memos-docs.openmem.net/cn/api_docs/core/rerank/), or
[Voyage v1](https://docs.voyageai.com/reference/reranker-api) without changing the
Memory interface:

```bash
# Quality-first multilingual Cohere reranking:
LORE_RERANK_PROVIDER=cohere
LORE_RERANK_MODEL=rerank-v4.0-pro
COHERE_API_KEY=...

# Memory-specific 0.6B or 4B hosted reranking:
LORE_RERANK_PROVIDER=memos
LORE_RERANK_MODEL=memos-reranker-0.6b
MEMOS_API_KEY=...

# Or Voyage's instruction-following reranker:
LORE_RERANK_PROVIDER=voyage
LORE_RERANK_MODEL=rerank-2.5
VOYAGE_API_KEY=...
```

These are concrete adapters for the providers' official APIs—not a caller-selected
URL passthrough. `LORE_RERANK_API_KEY` overrides the provider-specific key and
`LORE_RERANK_BASE_URL` supports a private deployment endpoint. A managed adapter
sends the already-authorized candidate evidence outside the Lore deployment; the
operator is responsible for that provider's retention/compliance terms. Managed
endpoints must use HTTPS outside loopback or the explicit Docker-host bridge.

The Memos adapter uses its required `Token` authorization scheme and conservatively
batches authorized evidence by 6,000 Unicode characters before globally sorting
the returned calibrated scores. This leaves conservative headroom against the
service's documented 8k-token documents budget for dense CJK text while preserving
the caller's final top-k.
For private local deployment, `IAAR-Shanghai/MemReranker-4B` can use the existing
vLLM `/v1/rerank` adapter.

`LORE_RERANK_INSTRUCTION` can override the vLLM `/v1/rerank` or `/score` Qwen task
instruction, or prefix the instruction-following Voyage query. llama.cpp owns its
model-embedded template, the Ollama listwise adapter pins Lore's scored-set prompt,
and Cohere v2 has no corresponding request field.
Invalid configuration,
timeouts, malformed responses, and provider errors warn server-side and fail open
to Lore's deterministic fused order. Lore accepts only one score per authorized
candidate with a finite value in `[0,1]`; duplicate, missing, foreign, or
unnormalized results are malformed. `LORE_RERANK_MIN_SCORE` optionally turns the
model score into an abstention gate; leave it unset until calibrated on a versioned
Evaluation Suite. `LORE_RERANK_DIVERSITY_LAMBDA` optionally applies MMR-style lexical
evidence diversity after reranking (`1` disables it). Reranker selection and
calibration are deployment settings, never User, Workspace, or Agent preferences.
`LORE_RERANK_WEIGHT` uses weighted reciprocal-rank fusion to retain strong hybrid
evidence when a small reranker is uncertain (`1` preserves pure reranker order).
Do not enable reranking merely because an adapter is available: Lore's local Qwen
reranker improved Accurate and LongMemEval diagnostics but reduced
MemoryAgentBench Conflict recall. Treat each retrieval workload, candidate budget,
and rank-fusion weight as one versioned calibration profile.
`LORE_EVIDENCE_NEIGHBOR_CHUNKS=1` or `2` can include adjacent chunks around the
best-matching chunk in returned and reranked evidence, which helps facts crossing a
chunk boundary at a proportional context/token cost. It defaults to `0`; measure it
locally with `LORE_BENCHMARK_EVIDENCE_NEIGHBOR_CHUNKS` before enabling it.
`LORE_EVIDENCE_TOP_CHUNKS=1..5` retains multiple independently high-scoring chunks
from the same visible Memory before adjacent expansion. This is useful for ordered
conflict logs and multi-fact Memories where a Memory-id hit is not enough to answer
the question. It defaults to `1`; sweep `LORE_BENCHMARK_EVIDENCE_TOP_CHUNKS` because
each extra chunk consumes reader/reranker context.
When `topChunks × (2 × neighborChunks + 1)` can cover every chunk in a small visible
Memory, Lore returns that whole Memory in ordinal order instead of wasting the
explicit budget on overlapping windows. The same bound prevents implicit expansion
for larger Memories. On the audited two-source/200-question MemoryAgentBench
Conflict slice, the explicit `topChunks=5`, `neighborChunks=2` profile raised exact
answer-evidence Recall@10 from `0.635` to `0.800` and MRR from `0.3697` to `0.4370`
without changing the parent-Memory result or causing an isolation failure. This is
a historical local ablation measured before the generation-scoped benchmark
validator; rerun it with the current runner before using it as a deployment
threshold. It is an aggressive evaluation profile, not the default context budget.

`LORE_RETRIEVAL_FEEDBACK_QUERIES=1..3` enables bounded pseudo-relevance feedback for
multi-hop recall without another chat model. Lore extracts the sentence with the
strongest meaningful-term overlap from one top RLS-visible evidence passage,
combines that focused bridge with the original question, excludes the source
Memory from its own follow-up query, and runs the same Workspace, scope, time,
metadata, and RLS predicates again. Values above one repeat this process from the
newly retrieved evidence, accumulating the query chain and excluding every prior
anchor, so a bounded three-hop path is possible without a planner model. Novel
feedback candidates are appended without disturbing the retained first-pass order;
when that pool is already full, Lore keeps its leading 80% and reserves at most the
trailing 20% for novel chain evidence. The total candidate budget never grows, and
only an explicitly configured reranker may reorder the expanded pool. Feedback can
also drift, so the default is `0`. Set
`LORE_BENCHMARK_RETRIEVAL_FEEDBACK_QUERIES=1` to add isolated feedback and
planner+feedback variants to a retrieval report before deployment.
On the same historical evidence-aware two-source Conflict run, depth two improved exact evidence
Recall@10 only from `0.635` to `0.640` while average latency rose from 179 ms to
269 ms and MRR fell; treat depth one as a provisional local Pareto point until the
current runner reproduces it.

`LORE_RETRIEVAL_RECENCY_WEIGHT=0..1` optionally performs a local temporal second
stage by reciprocal-rank fusing the hybrid relevance order with visible Memory
`updated_at` order. When enabled, it widens retrieval to
`LORE_RERANK_CANDIDATE_LIMIT` before returning the requested top-k, and it can run
alone or before a provider reranker. This is useful for conflict-resolution and
current-state workloads, but unconditional recency can damage archival or timeless
factual search, so it defaults to `0`. The synthetic benchmark adds an isolated
temporal variant when `LORE_BENCHMARK_RETRIEVAL_RECENCY_WEIGHT` is set; external
benchmarks record `LORE_RETRIEVAL_RECENCY_WEIGHT` and the shared second-stage
candidate budget.

For multi-hop, comparison, counting, and temporal questions, Lore can optionally
ask a deployment-level chat model for up to four additional evidence queries before
first-stage retrieval. The planner receives only the caller's question. Lore always
keeps the original query, runs every expansion inside the same Actor-scoped database
transaction, fuses the RLS-visible result lists, and only then invokes the optional
reranker:

```bash
# Local native Ollama server (thinking is disabled and output is bounded):
LORE_QUERY_PLANNER_PROVIDER=ollama
LORE_QUERY_PLANNER_MODEL=qwen3.5:4b
LORE_QUERY_PLANNER_BASE_URL=http://127.0.0.1:11434
LORE_QUERY_PLANNER_KEEP_ALIVE=0
LORE_QUERY_PLANNER_NUM_CTX=4096
LORE_QUERY_PLANNER_MAX_QUERIES=3

# Or use an OpenAI-compatible vLLM server:
# LORE_QUERY_PLANNER_PROVIDER=vllm
# LORE_QUERY_PLANNER_MODEL=your-instruct-model
# LORE_QUERY_PLANNER_BASE_URL=http://127.0.0.1:8001/v1

# Or use OpenAI by changing the provider/model and supplying a server-only key:
# LORE_QUERY_PLANNER_PROVIDER=openai
# LORE_QUERY_PLANNER_MODEL=your-chat-model
# LORE_QUERY_PLANNER_API_KEY=...

# Or use Gemini's non-stored Interactions API and the existing GEMINI_API_KEY:
# LORE_QUERY_PLANNER_PROVIDER=google
# LORE_QUERY_PLANNER_MODEL=your-gemini-model
```

The feature is disabled by default because it adds model latency and cost. Invalid
configuration, timeouts, or malformed output warn server-side and fall back to the
original query. Planner selection and query budget are deployment settings, not
User, Workspace, or Agent preferences.

The Ollama adapter uses native `/api/chat`, structured output, `think: false`, fixed
deterministic decoding, and bounded context/output. The Google adapter uses Gemini's
current structured-output Interactions API with `store: false`; OpenAI and vLLM use
`/v1/chat/completions` with bounded JSON output. Provider responses are always parsed
and bounded again by Lore rather than trusted directly.

Search and browse also accept deterministic pre-ranking filters:
`scope=shared|private`, `updated_after=<ISO-8601>`,
`updated_before=<ISO-8601>` (exclusive), and `metadata=<JSON object>`. Metadata uses
Postgres JSONB containment and a GIN index; array containment can select a benchmark
haystack or application-defined tag. Lore applies every filter inside every lexical
and dense candidate CTE before top-k, so reranking cannot restore a filtered Memory.
For example:

```text
GET /api/memories?q=deployment+status&scope=shared&updated_after=2026-01-01T00:00:00Z
```

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

Embedding generations follow `building → active → retiring`. Use
`LORE_EMBEDDING_BUILD_PROVIDER` and `LORE_EMBEDDING_BUILD_MODEL` on the maintenance
worker to build beside the active model, inspect coverage with
`bun run db:embedding:report`, and cut over with
`bun run db:embedding:activate`. Retiring vectors remain rollback-capable for
`LORE_EMBEDDING_ROLLBACK_SECONDS` (seven days by default).
Preprocessing revisions use the same rollout even when provider/model strings do
not change. An upgraded request process reports embedding as degraded and keeps
lexical retrieval available until its exact generation has been built and activated;
see [the operations runbook](operations.md#embedding-generation-rollout).

The self-host worker claims one leased job at a time by default. Remote embedding
services can often improve indexing throughput with `LORE_MAINTENANCE_CONCURRENCY`
(maximum 32); size `LORE_MAINTENANCE_POOL_SIZE` accordingly. Keep concurrency at 1
for memory-constrained local Ollama unless a benchmark proves the machine benefits.

For a temporary single-operator deployment, `AUTH_MODE=password` accepts HTTP
Basic but always maps an accepted login to `LORE_LOCAL_SUBJECT`; the Basic username
cannot be used to select or impersonate another internal User. Multi-user deployments
should use a verified identity proxy such as Cloudflare Access.

Lore keeps a single text lockfile, `bun.lock`. Bun owns dependency installation and
script dispatch; self-hosted application and migration code still execute on Node 24,
while the Cloudflare artifact executes on Workerd.

## Local development

### Native one-command service on Apple Silicon

Lore can run entirely against a local Postgres installation, with the frontend
and maintenance worker managed as background processes. The default search mode
is the low-latency Hybrid path: exact and relaxed lexical channels plus
Qwen3-Embedding 0.6B dense retrieval, fused with reciprocal rank fusion. Retrieval
settings continue to come from `.env`; the repository default semantic distance
is `0.5`.

```bash
brew install postgresql@18 pgvector ollama
brew services start postgresql@18
ollama pull qwen3-embedding:0.6b
bun run service:up
```

On first use, `service:up` creates an ignored `.env` with separate random request
and maintenance passwords, creates the local `lore` database if necessary, runs
migrations, and provisions narrow `lore_app` and `lore_maintenance` login roles.
If `.env` already exists without native database settings, `service:up` extends it
idempotently; a partial native configuration fails with the exact missing keys.
It then starts the loopback-only Next.js development server and maintenance worker.

Reranking remains available as an explicit deployment-level diagnostic mode. To
add a Qwen3-Reranker 0.6B Q8 llama.cpp server, install llama.cpp, set
`LORE_LOCAL_SEARCH_MODE=rerank` in `.env`, and restart:

```bash
brew install llama.cpp
bun run service:restart
```

The measured reranker profile uses `--parallel 2 --ctx-size 8192` and a
2,048-token physical batch. Manage and inspect the service with:

```bash
bun run service:status
bun run service:logs
bun run service:restart
bun run service:down
```

Postgres and Ollama remain system-managed and are deliberately left running by
`service:down`. Lore stops only its frontend, worker, and any reranker that it
started; an existing external llama-server is reused and left alone. Runtime state
and mode-0600 logs live under the ignored `tmp/local-service/` directory. The
service intentionally ignores `LORE_BIND_ADDRESS` and binds the app and managed
reranker to `127.0.0.1`; use the Docker or manual deployment profiles for anything
reachable beyond the local machine. Native process, port, database, and reranker
overrides use `LORE_LOCAL_POSTGRES_*`, `LORE_LOCAL_RERANK_*`, and `LORE_PORT`.

### Manual process setup

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
- `/api/v1/episodes`, `/api/v1/episodes/:id`, and bounded Observation evidence reads
- `/api/agents`, `/api/agents/:id/credentials`, and grant/credential revocation
- `/api/evaluations/suites`, suite runs, and run results
- `/api/v1/workspaces/export` and `/api/v1/workspaces/import`
- stable aliases under `/api/v1`, with `/openapi.json` and
  `/api/v1/capabilities` (verified Actor plus `x-lore-workspace-id`); human clients
  use `/api/v1/actor` for the verified target User in explicit import owner remaps
- `/livez` for process liveness and `/readyz` for database, role, schema, vector,
  and RLS readiness

One Memory represents one coherent canonical fact, decision, constraint,
procedure, or rationale. The recommended size is at most 8,000 Unicode characters;
the hard limits are 32,000 characters and 64 derived chunks. Create, update,
Proposal, and import enforce the same boundary. Longer raw documents belong in
bounded `document_fragment` Observations inside a document Episode rather than
being automatically split into canonical Memories.

The native `/operations` surface turns the stable portability contract into a
human-only workflow: download an actor-visible archive, inspect its manifest and
owner set, run checksum/limit/owner/collision validation as a dry check, then
explicitly remap every source owner to the verified importing human and import. It
also shows readiness, capability limits, and the active
deployment-level embedding generation without exposing them as Workspace settings.

Memory reads return a strong ETag such as `"memory-v2"`. HTTP update and delete
require that value in `If-Match`; stale writes fail with `412 version_conflict`.
Mutation retries may send `Idempotency-Key`, scoped by Actor and operation. Memory
list responses expose `x-lore-next-cursor` for stable cursor pagination.

Agent tokens are returned only at creation time. Lore stores only their SHA-256
hash and a short display prefix. Embedding selection is deployment-wide and is not
exposed to Workspace members or Agents.

## SDK, CLI, and MCP

Lore's developer tools share the stable `/api/v1` Memory contract plus the stable
`/readyz` probe. TypeScript and Python types come from the same OpenAPI document
served at `/openapi.json`; the CLI and external MCP server delegate authentication,
Workspace selection, pagination, ETags, idempotency, bounded response reads, and API
error handling to the TypeScript SDK.

Generate/check both language contracts and build the JavaScript packages:

```bash
bun run sdk:generate
bun run sdk:check
bun run build:packages
```

Use an Agent credential from the one-time `/agents` flow through environment
variables. Secrets are not accepted as CLI flags:

```bash
export LORE_URL=http://127.0.0.1:3000
export LORE_WORKSPACE_ID=10000000-0000-4000-8000-000000000001
export LORE_AGENT_TOKEN=lore_agent_...

printf %s "deployment notes" | node packages/cli/dist/bin.js memory search --stdin --limit 10
printf %s "Release approved" | node packages/cli/dist/bin.js memory remember --stdin \
  --scope private --idempotency-key release-approved-1
printf %s "Suggested release note" | node packages/cli/dist/bin.js memory propose create \
  --stdin --scope private --idempotency-key release-proposal-1
printf '%s' '{"kind":"conversation","observations":[{"kind":"message","content":"Release approved"}]}' \
  | node packages/cli/dist/bin.js episode record --stdin --idempotency-key release-episode-1
```

The stdio MCP adapter exposes bounded list/search/get, direct version-safe
remember/update/forget, `lore_observe` for non-canonical Episode evidence, and
`lore_propose` for owner-reviewed suggestions in exactly the configured Actor and
Workspace. Supply the same `idempotencyKey` when retrying a mutation whose response
was lost:

For combined retrieval, use `lore_retrieve_context`. The matching SDK methods are
`workspace.retrieveContext(...)` in TypeScript and
`workspace.retrieve_context(...)` in Python. They call
`POST /api/v1/context/retrieve` once, require repository key and exact commit OID
together for Code, preserve typed anchor states, and never persist assessment.
The original question controls routing; optional channel-specific Memory and Code
queries are returned in the receipt rather than hidden as planner state.

```json
{
  "mcpServers": {
    "lore": {
      "command": "node",
      "args": ["/absolute/path/to/lore/packages/mcp/dist/bin.js"],
      "env": {
        "LORE_URL": "http://127.0.0.1:3000",
        "LORE_WORKSPACE_ID": "10000000-0000-4000-8000-000000000001",
        "LORE_AGENT_TOKEN": "lore_agent_...",
        "LORE_REQUEST_TIMEOUT_MS": "120000"
      }
    }
  }
}
```

Do not commit the populated MCP configuration. The adapter is an integration
process outside Portable Core: it stores no Memory or authorization state and it
cannot widen the Agent grant enforced by Lore and Postgres RLS. See
[`docs/developer-integration.md`](developer-integration.md) for the complete
configuration and command surface.

## Operations and portability

`bun run db:preflight` validates dbmate history, Lore's stored migration checksums,
and application/schema compatibility. `bun run db:backup`, `db:restore`, and
`db:pitr:check` cover the operator PostgreSQL plane; Workspace export/import is a
separate RLS-scoped logical plane. See [`docs/operations.md`](operations.md) for
backup ownership, restore drills, generation activation, degraded readiness, and
telemetry privacy.

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
bun run sdk:check
bun run typecheck
bun run lint
bun run test
bun run test:python
bun run build
bun run build:packages
bun run packages:smoke
bun audit --audit-level=high
bunx opennextjs-cloudflare build
bunx wrangler deploy --dry-run
```

`test:python` selects Python 3.12 or newer, preferring 3.14, 3.13, then 3.12. Set
`LORE_PYTHON=/absolute/path/to/python` when a supported interpreter is not on the
usual command path.

The deterministic Evaluation fixture is
[`evaluation/suites/synthetic-v1.json`](../evaluation/suites/synthetic-v1.json). The
end-to-end retrieval benchmark uses
[`evaluation/suites/retrieval-v1.json`](../evaluation/suites/retrieval-v1.json) to
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
Set `LORE_BENCHMARK_EMBEDDING_CONCURRENCY` to measure safe parallel indexing without
changing the production worker setting.
`LORE_BENCHMARK_RERANK_MIN_SCORES=0,0.001,0.01` and
`LORE_BENCHMARK_RERANK_DIVERSITY_LAMBDAS=1,0.9,0.8` run a rerank/abstention/diversity
ablation over the same indexed corpus instead of paying the embedding cost again;
add `LORE_BENCHMARK_RERANK_CANDIDATE_LIMITS=10,20,50` to sweep candidate depth too.
`LORE_BENCHMARK_RERANK_WEIGHTS=0,0.25,0.5,0.75,1` sweeps first-stage/reranker rank
fusion while memoizing identical reranker requests within that local run.
The memoization key is SHA-256 hashed and the LRU is bounded to 2,000 entries by
default; lower `LORE_BENCHMARK_CACHE_ENTRIES` for especially constrained machines.
Each variant records provider calls, cache hits, cache misses, and a
`latencyComparableToOnline` flag under `providerExecution`. Cached variants retain
valid quality metrics, but their latency must not be treated as live provider latency.
Reports also pin the evidence-policy revision so compact cross-encoder passages and
expanded reader evidence cannot be confused across otherwise identical profiles.
Set `LORE_BENCHMARK_RETRIEVAL_LIMITS=10,20,50,100` to measure the first-stage
candidate recall ceiling without loading or calling a reranker. This benchmark-only
depth sweep helps choose a candidate budget before an expensive cross-encoder run.
Every retrieval variant also emits compact per-case metrics so sample/category
regressions cannot hide behind one aggregate score.
LoCoMo can separately test a HiGMem-inspired natural-boundary route using only its
explicit source sessions (no generated summaries or answer-derived links): set
`LORE_BENCHMARK_CONTEXT_GROUP_KEY=sessionNumber`,
`LORE_BENCHMARK_CONTEXT_GROUP_ORDINAL_KEY=sessionTurn`,
`LORE_BENCHMARK_CONTEXT_GROUP_BASE_LIMIT=20`, and
`LORE_BENCHMARK_CONTEXT_GROUP_MAX_GROUPS=3`. The route preserves a fixed count of
ordinary hybrid candidates, fills only a larger pool's remaining slots with nearby
members of already-visible groups, and reapplies Workspace, scope, time, metadata,
and RLS filters. It is an off-by-default ablation, not a reproduction of HiGMem's
automatically summarized Event hierarchy and not yet a deployment setting.
Use `LORE_BENCHMARK_OUTPUT=evaluation/results/retrieval.json` for the synthetic
suite or `--output evaluation/results/longmemeval-s.json` for LongMemEval to retain
the complete local report; the results directory is intentionally gitignored.
Set `LORE_BENCHMARK_REUSE_INDEXED=1` for the exact same synthetic suite after its
first run; LongMemEval uses the explicit `--reuse-indexed` flag.

### LongMemEval locally

Lore's LongMemEval adapter runs through the same local Postgres, RLS, Memory, and
maintenance modules as the deterministic suite. It does not require Mem0, Qdrant,
or a hosted benchmark service. Dataset files are downloaded once into the ignored
`evaluation/datasets/` directory, pinned to the official cleaned revision, and
verified by byte size and SHA-256 before every run.

Start with the evidence-only oracle split and ten cases to verify the complete
local pipeline with low disk and embedding cost:

```bash
bun run benchmark:longmemeval:fetch oracle
BENCHMARK_DATABASE_URL=postgres://localhost:5432/lore_retrieval_benchmark \
  OLLAMA_KEEP_ALIVE=5m \
  bun run benchmark:longmemeval:smoke
```

The oracle split is a smoke fixture, not a comparable retrieval score. For the
official LongMemEval-S retrieval run, fetch the cleaned haystack and run all 500
questions:

```bash
bun run benchmark:longmemeval:fetch s
BENCHMARK_DATABASE_URL=postgres://localhost:5432/lore_retrieval_benchmark \
  OLLAMA_KEEP_ALIVE=5m \
  bun run benchmark:longmemeval
```

Use `--cases-per-type 1`, `--max-cases 10`,
`--question-types knowledge-update,temporal-reasoning`, or `--limit 10` to run a
deterministic stratified sample, subset, or retrieval depth. Each question is
installed in its own Workspace to prevent cross-question contamination. Conversation
sessions become Alice-owned private Memories, while a semantically strong Bob-owned
private tripwire makes every query an RLS isolation test. Dataset parsing is
streaming, including for the multi-gigabyte `m` split.
After one indexed run, pass `--reuse-indexed` with the exact same dataset selection
to validate the persisted corpus and rerun retrieval/rerank ablations without
rewriting Memories or regenerating embeddings.

The official LongMemEval retrieval comparison excludes its 30 abstention questions.
Lore keeps positive-case Recall/MRR/nDCG separate from no-answer accuracy, so the
positive metrics remain comparable while abstention still receives an explicit
quality gate instead of disappearing from the report.

### LongMemEval-V2 preparation

LongMemEval-V2 is pinned separately because it measures final answer quality over
browser/enterprise trajectories rather than exposing gold retrieval ids. Download
and verify its questions, 29 question screenshots, and the 100-trajectory haystack
(about 4.2 MB) without pulling the large trajectory corpus:

The runner never turns a raw trajectory into canonical Memory. It preserves the
rendered trajectory exactly across bounded workflow Episodes/Observations, indexes
their immutable content through the separate revisioned Episode-evidence module,
and groups retrieved evidence back by trajectory identity. Workspace/RLS,
benchmark metadata, and the question's exact haystack source keys are all applied
before lexical or semantic top-k.

```bash
bun run benchmark:longmemeval-v2:fetch metadata
```

Use `bun run benchmark:longmemeval-v2 --plan --max-cases 12` to inspect a stratified
selection and its deduplicated trajectory count without a database, embedding call,
or reader call. Use `bun run benchmark:longmemeval-v2:fetch small` or `medium` only
when ready to download the pinned 1.2 GB textual trajectory file. Lore's streaming
parser renders goal/state/action/accessibility-tree evidence without requiring the
multi-gigabyte screenshot archives.

Run the local fixed-reader benchmark against a disposable, fully migrated database:

```bash
bun run benchmark:longmemeval-v2:fetch small
DATABASE_URL=postgres://localhost:5432/lore_retrieval_benchmark bun run db:migrate

BENCHMARK_DATABASE_URL=postgres://localhost:5432/lore_retrieval_benchmark \
  LORE_BENCHMARK_READER_PROVIDER=vllm \
  LORE_BENCHMARK_READER_MODEL=your-fixed-reader-model \
  LORE_BENCHMARK_READER_BASE_URL=http://127.0.0.1:8002/v1 \
  bun run benchmark:longmemeval-v2 --max-cases 12 \
    --output evaluation/results/longmemeval-v2-small.json
```

For a RAM-conscious local run, the benchmark also speaks Ollama's native chat API:

```bash
BENCHMARK_DATABASE_URL=postgres://localhost:5432/lore_retrieval_benchmark \
  LORE_BENCHMARK_READER_PROVIDER=ollama \
  LORE_BENCHMARK_READER_MODEL=qwen3.5:4b \
  LORE_BENCHMARK_READER_NUM_CTX=32768 \
  LORE_BENCHMARK_READER_THINKING=0 \
  LORE_BENCHMARK_READER_KEEP_ALIVE=5m \
  bun run benchmark:longmemeval-v2 --max-cases 12 \
    --output evaluation/results/longmemeval-v2-ollama.json
```

Lore does not pull a model automatically. Native Ollama runs pin `seed`, context,
thinking, and generation controls; record the server version and local model digest
before and after the run; include native token/timing counters; and unload the model
on normal exit. `5m` bounds warm-run residency for throughput. Use `0` only when
measuring deliberately cold latency, because model load time then affects every case.
Set `LORE_BENCHMARK_READER_THINKING=1` only as an explicitly reported reasoning
profile; it can improve multi-hop answers but changes latency and output-token cost.
The native local-reader mode accepts loopback URLs only and rejects Ollama cloud or
remote-model responses so a hosted run cannot be mislabeled as a local measurement.
See the [Ollama chat API](https://docs.ollama.com/api/chat) and
[`docs/research/ollama-benchmark-reader.md`](research/ollama-benchmark-reader.md).

The runner stores each shared trajectory once across the selected questions, uses
exact trajectory source keys plus indexed metadata before top-k, runs retrieval
under RLS, plants one Bob-private Episode-evidence tripwire per question, and records
answer accuracy, category metrics, search/reader latency, and token usage.
`--reuse-indexed` validates the
exact corpus/embedding space before avoiding re-indexing. The default uses all 295
deterministic phrase/ordered-phrase/multiple-choice cases, including
the one screenshot question. The fixed reader transport must use a vision-capable
model for that image case; screenshots are verified against the pinned manifest and
sent inline as base64 rather than exposed through a public URL.
Tripwires use the same lexical/vector evidence path and are included in each
question's candidate source scope, so both lexical and semantic RLS failures become
hard isolation failures rather than being hidden by benchmark filtering.

When a fixed reader cannot run locally, `--retrieval-only` skips reader and judge
configuration and reports Recall@1, Recall@K, and MRR only for questions whose
normalized reference answer occurs literally in at least one selected trajectory.
The report records every matching trajectory id and the first retrieved rank. This
is a local candidate-quality diagnostic, not the official LongMemEval-V2 answer
score; `reader` is `null`, answer accuracy is `null`, and `scoreComplete` remains
false so it cannot be mistaken for an end-to-end result.

The built-in reader is explicitly reported as `lore-portable-deterministic-v2`:
temperature 0, a character context budget, and provider-default image detail. It is
useful for controlled Lore ablations, but it is not mislabeled as the paper's exact
Qwen3.5-9B profile, which samples at temperature 0.6/top-p 0.95/top-k 20 and truncates
memory with the Qwen processor at 200,000 tokens. Reports include the actual decoding
settings, context-budget unit, transport, image routing, corrected prompt mode, and
prompt SHA-256. See [`docs/research/longmemeval-v2-multimodal.md`](research/longmemeval-v2-multimodal.md)
for the pinned official protocol and its upstream prompt-escape compatibility trap.

Reports also pin the Memory chunking revision and bind it into the reusable corpus
key, alongside the exact retrieval, planner, and reranker configuration. They include
actual provider request/input character counts as cost drivers. Reader and judge token
totals are included when returned by their APIs; character counts are never presented
as estimated billing tokens.
The runner also pins the benchmark's domain-specific reader prompt and memory-first
prompt layout. `--include-judge-cases` adds all 128 abstention cases and 28
screenshot-backed gotcha cases for the complete 451-question public suite. Configure
`LORE_BENCHMARK_JUDGE_PROVIDER`, `LORE_BENCHMARK_JUDGE_MODEL`, and
the corresponding base URL/key to score them with the pinned official binary-judge
rubrics; the report records judge model, protocol revision, latency, reasons, and
tokens separately from the reader. Without a judge, those cases remain explicitly
unresolved and `scoreComplete` is false, so partial accuracy cannot masquerade as a
full V2 score.

For example, an OpenAI-compatible local judge can be added to the command above:

```bash
LORE_BENCHMARK_JUDGE_PROVIDER=vllm \
  LORE_BENCHMARK_JUDGE_MODEL=your-evaluator-model \
  LORE_BENCHMARK_JUDGE_BASE_URL=http://127.0.0.1:8002/v1 \
  bun run benchmark:longmemeval-v2 --include-judge-cases --reuse-indexed \
    --output evaluation/results/longmemeval-v2-small-full.json
```

Query/document preprocessing is part of the versioned embedding protocol. Testing
a different preprocessing strategy requires a new revision and re-index, not a
hidden benchmark-only prompt. See [`AGENTS.md`](../AGENTS.md) for architecture and
working agreements and [`CONTEXT.md`](../CONTEXT.md) for canonical domain terminology.

### LoCoMo locally

Lore pins the final ACL 2024 ten-conversation LoCoMo release and evaluates it
through native Postgres, RLS, Memory search, optional planner/reranker stages, and
a fixed reader. The source data is CC BY-NC 4.0, so it is downloaded only into the
ignored `evaluation/datasets/` directory and is not redistributed with Lore:

```bash
bun run benchmark:locomo:fetch
createdb lore_locomo_benchmark
DATABASE_URL=postgres://localhost:5432/lore_locomo_benchmark bun run db:migrate
```

The retrieval-only runner measures annotated dialog-turn Recall@1/Recall@K/MRR and
nDCG independently of answer generation:

```bash
BENCHMARK_DATABASE_URL=postgres://localhost:5432/lore_locomo_benchmark \
  OLLAMA_KEEP_ALIVE=5m \
  bun run benchmark:locomo:retrieval --max-cases 20 --limit 10 \
    --output evaluation/results/locomo-retrieval.json
```

The canonical QA profile includes categories 1-4 (1,540 questions). It uses the
official programmatic normalized token-F1 semantics—no LLM judge—and reports
answer F1, annotated-evidence recall, latency, tokens, exact local model digest,
and Bob-private RLS tripwire failures separately. A RAM-conscious 4B smoke can
reuse the exact indexed selection from the retrieval command:

```bash
BENCHMARK_DATABASE_URL=postgres://localhost:5432/lore_locomo_benchmark \
  LORE_BENCHMARK_READER_PROVIDER=ollama \
  LORE_BENCHMARK_READER_MODEL=qwen3.5:4b \
  LORE_BENCHMARK_READER_BASE_URL=http://127.0.0.1:11435 \
  LORE_BENCHMARK_READER_NUM_CTX=8192 \
  LORE_BENCHMARK_READER_MAX_OUTPUT_TOKENS=32 \
  LORE_BENCHMARK_READER_THINKING=0 \
  bun run benchmark:locomo --max-cases 20 --limit 10 --reuse-indexed \
    --output evaluation/results/locomo-positive-4b.json
```

When an exact, immutable retrieval diagnostic for the same selection and provider
profile already exists, `--skip-retrieval-diagnostic` avoids repeating that setup
sweep before the QA run. It does not skip the per-question search used by the
reader, and the answer report records `setupDiagnosticSkipped: true` with no
embedded setup variants. Keep the separate retrieval JSON alongside that report.

The runner preserves the upstream raw evidence while applying only mechanical
dialog-ID repairs and exposing unresolved annotations. It ports the pinned NLTK
3.8.1 default Porter behavior instead of using a merely similar JavaScript
stemmer. LoCoMo's 446 adversarial questions are not scored: 444 released rows omit
the field that the official reader/scorer dereference, the official multiple-choice
order is unseeded, and every repaired case has the same unanswerable gold label. An
always-abstain reader would therefore score 100%, so `--categories 5` fails closed
instead of publishing a meaningless quality number. Event summarization and
multimodal dialog generation lack fixed official evaluators and are not claimed by
this QA runner. See the [original ACL paper](https://aclanthology.org/2024.acl-long.747/)
and the pinned [runner audit](research/locomo-runner-audit.md).

The first local 4B planner/reranker ablation, including fixed model digests,
latency, two conversation slices, and original-paper provenance, is recorded in
the [local LoCoMo ablation](research/locomo-local-qwen35-4b-ablation.md).
It recommends the Qwen3 0.6B reranker only as a named quality profile; it does not
turn a 35-question local result into a global default or a SOTA claim.

### MemoryAgentBench accurate retrieval

Lore pins the official 22-row Accurate Retrieval split separately from Conflict
Resolution. The fetch is about 38 MB of verified JSONL. Its local diagnostic preserves
RULER `Document N` boundaries and chunks within each document into isolated Lore
Memories using `lore-memory-chunking-v2`. It selects the
literal answer passage with query overlap, accepted-reference specificity,
answer/query proximity, and subject normalization, then installs
Bob-private answer tripwires:

```bash
bun run benchmark:memoryagentbench:fetch accurate
bun run benchmark:memoryagentbench:accurate --plan

BENCHMARK_DATABASE_URL=postgres://localhost:5432/lore_mab_accurate_benchmark \
  bun run benchmark:memoryagentbench:accurate \
    --output evaluation/results/memoryagentbench-accurate.json
```

The low-resource default runs 20 questions from one RULER source row (823 visible
Memory chunks). Use `--row-index`, `--source`, `--max-sources`, `--max-questions`,
and `--limit` to expand or isolate the workload; `--reuse-indexed` validates exact
content and active embedding space before reusing it. Questions without a literal
answer anchor are skipped rather than scored as misses, so this report is a
retrieval diagnostic—not the official generated-answer score. The report pins the
dataset/code revisions, file checksum, chunking revision, anchor coverage, RLS
failures, quality, latency, and provider workload.

### MemoryAgentBench conflict resolution

Lore also pins the MIT-licensed MemoryAgentBench Conflict Resolution split. This is
the important counterweight to pure retrieval benchmarks: facts arrive in order,
later facts may invalidate older ones, and multi-hop questions must follow the
current chain. Fetching this slice materializes about 3.2 MB of verified JSONL and
does not download the other benchmark categories:

```bash
bun run benchmark:memoryagentbench:fetch conflict
bun run benchmark:memoryagentbench --plan
```

The low-resource default alternates one 6k multi-hop source and one 6k single-hop
source, uses 40 questions, and creates 58 fact Memories. A local run uses the same
embedding, planner, reranker, and fixed-reader variables as LongMemEval-V2:

```bash
BENCHMARK_DATABASE_URL=postgres://localhost:5432/lore_retrieval_benchmark \
  LORE_BENCHMARK_READER_PROVIDER=vllm \
  LORE_BENCHMARK_READER_MODEL=your-fixed-reader-model \
  LORE_BENCHMARK_READER_BASE_URL=http://127.0.0.1:8002/v1 \
  bun run benchmark:memoryagentbench \
    --output evaluation/results/memoryagentbench-conflict.json
```

The native Ollama reader configuration above works here too; MemoryAgentBench has no
question images, so a text-only local reader is sufficient.

End-answer reports decompose failures instead of hiding them in one score: they show
literal answer-evidence recall, exact-match accuracy conditioned on that evidence
being present, reader failures despite present evidence, and answers recovered when
the literal anchor was absent. This separates retrieval headroom from reader headroom.

For the benchmark's explicitly versioned current-value questions, set
`LORE_MEMORYAGENTBENCH_CONFLICT_ASSEMBLY=1` to evaluate post-retrieval assembly. The
runner stores exactly one numbered fact per Memory for this profile, then compacts
only the RLS-authorized returned evidence into a fact-level BM25
top-10 pool, matching the original paper's retrieval granularity without performing a
global unauthorized fact search. The reader extracts every exact subject/predicate
candidate into a validated intermediate representation; Lore rejects candidates that
cannot be traced by a normalized exact source-fact match to retrieved evidence, derives freshness serials from
that evidence instead of trusting model-generated numbers, then applies the benchmark's
`max(serial)` policy deterministically. Multi-hop cases use a bounded CAR pipeline:
the 4B reader decomposes the question, each resolved hop performs a fresh RLS-authorized
Lore search, and the same validated fact assembly feeds the next hop. The report pins
both protocols and source revision, and each case records the decomposition, per-hop
trace, extra search latency, source/pool fact counts, raw extraction, candidate count,
and selected serial. This follows the
bounded result in [Reliable Post-Retrieval Assembly for Agent Memory](https://arxiv.org/abs/2606.01435):
it is for explicit current-value policies, not a generic replacement for temporal QA
or Memory consolidation. Treat it as an ablation until both single-hop and multi-hop
results are measured on a sufficiently large pinned sample.

When no generative reader is running, `--retrieval-only` still executes the real
Postgres/RLS pipeline and reports two distinct Recall@1/Recall@K/MRR families: the
rank of the Memory containing the latest numbered answer fact, and the rank where
that exact fact is actually present in returned evidence. All 800 public questions
have such a literal answer anchor. The evidence metric prevents a parent Memory hit
from being mistaken for answerable context after chunking. This diagnostic is not
the official end-answer score, but it lets local machines compare embedding,
threshold, planner, feedback, reranker, and fact-batch/evidence settings without
loading another model:

```bash
BENCHMARK_DATABASE_URL=postgres://localhost:5432/lore_retrieval_benchmark \
  LORE_RETRIEVAL_FEEDBACK_QUERIES=1 \
  bun run benchmark:memoryagentbench --retrieval-only --reuse-indexed \
    --output evaluation/results/memoryagentbench-retrieval.json
```

Use `--max-sources 8 --max-questions 100` for all 800 Conflict Resolution
questions (3,214 fact Memories at the default 16 facts per Memory), or `--source`
for one exact source. `--facts-per-memory` exposes the chunk-granularity ablation
when conflict assembly is off; assembly requires one fact per Memory.
`LORE_MEMORYAGENTBENCH_RETRIEVAL_LIMIT` controls evidence depth. The runner uses the
official normalized `substring_exact_match`, records per-source accuracy/latency/
tokens, validates the exact corpus before `--reuse-indexed`, and treats any access
to Bob-private answer tripwires as a hard failure. Tripwires retain exact chunks for
that RLS assertion but skip embedding; only visible fact Memories consume document-
embedding work.

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

[MIT](../LICENSE) © CoreSpeed
