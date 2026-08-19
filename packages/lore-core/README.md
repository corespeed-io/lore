# @corespeed/lore-core

Lore's reusable memory engine: multi-tenant Memory storage, canonical content
bounds, deterministic chunking (`lore-memory-chunking-v2`), hybrid retrieval
(simple/English FTS, relaxed English recall, deterministic CJK substring,
dense vectors, RRF fusion, optional reranking), Memory Links/graph reads,
replay-safe idempotency, and leased embedding maintenance — all over a
PostgreSQL schema whose authorization is Postgres Row-Level Security.

This package is the **lore core** half of the lore core / lore oss split
(Linear HAAS-71). The lore repository's application — identity/tenancy, HTTP
API, OpenAPI, SDKs, web UI, Memory Proposals, code-aware memory, portability,
evaluation — is **lore oss**, the first host of this engine. CoreSpeed HaaS is
the second host.

## The contract

- **Identity is the host's job.** Every method takes an `ActorContext`
  (`workspaceId`, `userId`, optional provenance-only `agentId`) that the host
  has already authenticated and authorized. The engine installs it as
  transaction-local GUCs (`lore.workspace_id`, `lore.user_id`,
  `lore.agent_id`); the database enforces the boundary from there.
- **The database is the authorization model.** The host's schema must provide
  the kernel tables (`memories`, `memory_chunks`, `memory_links`,
  `memory_chunk_embeddings`, `embedding_generations`, `memory_embedding_jobs`,
  `request_idempotency_records`, `lore_system_state`), the `lore.*` GUC
  accessor and policy functions (`lore.can_read_memory`,
  `lore.can_write_memory`, maintenance lease checks), the two NOLOGIN runtime
  roles (`lore_app`, `lore_maintenance`), and RLS policies on every table.
  Policy *bodies* are host-owned: lore oss consults memberships and agent
  grants; a host with its own identity plane may use pure GUC comparisons.
- **Storage is not pluggable.** SQL, interactive transactions, and
  database-enforced RLS are part of the contract (`src/db.ts`); the seam is
  the 3-interface `PostgresDatabase` transaction surface, not a storage
  abstraction.

## Entry points

| Entry | Contents |
| --- | --- |
| `.` | Memory kernel: `createMemoryModule`, `createMemoryGraphModule`, maintenance module, idempotency, content/chunking, `ActorContext`, db seam, provider contracts |
| `./postgres` | `pg`-backed database factories: pooled (`createPostgresDatabase`) and per-request client (`createRequestPostgresDatabase`, for workerd/Hyperdrive) with `SET LOCAL ROLE` |
| `./episodes` | Optional capability group: bounded immutable Episode/Observation evidence plus its separate rebuildable hybrid index (adds the episode tables to the schema contract) |
| `./providers` | Embedding (Google/Ollama/OpenAI), reranking (Cohere/Memos/Voyage/vLLM/llama.cpp/Ollama-listwise), and query-planning adapters. Env parsing and provider selection stay host-side |

## Host extension seams

`createMemoryMutationPrimitives` exposes the transaction-scoped insert/update
primitives plus maintenance notification so a host module can create or update
canonical Memories inside its own transaction with identical chunking and
embedding-job semantics — lore oss's Memory Proposals review is the canonical
consumer. `memoryFromRow`, `MemoryRow`, and `serializedTimestamp` support host
modules that map their own row selections.

## Consuming from this repository

The lore app consumes this package as TypeScript source through the Bun
workspace (`workspace:*`), root `tsconfig.json` paths, the vitest aliases, and
Next `transpilePackages`. Publishing (built `dist` + `d.ts`) is wired
separately; see HAAS-71 for the release plan.
