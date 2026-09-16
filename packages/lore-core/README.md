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

Provider adapters use official SDKs with their default transport. OpenAI and Google
embedding use SDK retries (two by default); query planners and hosted rerankers
explicitly disable them. Lore still validates embedding dimensions/counts and
reranker scores. SDK response bodies have no Lore-specific byte cap, and the
Ollama SDK has no non-streaming request deadline. Timeout options on the other
providers use the SDK's native policy. MemOS and vLLM/llama.cpp reranking retain
bounded HTTP adapters for their provider-specific contracts.

## Host extension seams

`createMemoryMutationPrimitives` exposes the transaction-scoped insert/update
primitives plus maintenance notification so a host module can create or update
canonical Memories inside its own transaction with identical chunking and
embedding-job semantics — lore oss's Memory Proposals review is the canonical
consumer. `memoryFromRow`, `MemoryRow`, and `serializedTimestamp` support host
modules that map their own row selections.

## How hosts consume this package

The lore app consumes it as TypeScript source through the Bun workspace
(`workspace:*`), root `tsconfig.json` paths, the vitest aliases, and Next
`transpilePackages`.

There is deliberately no npm publishing, submodule, mirror, or sync script.
CoreSpeed HaaS retains its existing vendored `packages/memory-core` fork. The
planned cutover to a verbatim copy of this package was cancelled on 2026-09-15.
Lore remains upstream; HaaS ports selected changes manually and records their
provenance. The packages are not assumed to be semantically identical, and Lore
tasks do not require automatic changes to the HaaS fork. Hosts adopting this
package can run `./testing` against their own migration chain.
