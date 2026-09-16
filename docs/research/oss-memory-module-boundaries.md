# OSS memory-engine module boundaries

Research and implementation update: 2026-09-16. The source audit below informed
Lore's subsequent module changes recorded at the end of this report. The user
clarified that Core should contain memory capabilities and their algorithms,
and that database implementation may remain in Core.
The user's latest direction is to retain existing multi-tenancy in Lore OSS.
This supersedes the intermediate proposal to remove it from OSS or require one
deployment per Workspace. Core should remain focused on memory, algorithms and
database mechanics; OSS owns Workspace lifecycle, memberships and authorization.
The existing isolation must remain effective while those responsibilities are
decoupled. No tenant-removal migration is part of the current direction.

The comparison distinguishes three decisions: internal module interfaces, where
dependencies are constructed, and what ships in one package. A model SDK in a
package establishes installation coupling; it does not by itself establish the
absence of modular design. Findings concern the public OSS implementations,
not the vendors' hosted products or benchmark scores.

## Source snapshots

| Project | Inspected revision | Revision date |
| --- | --- | --- |
| Mem0 | [`b51f7692`](https://github.com/mem0ai/mem0/tree/b51f7692f002d4f8719dd5c0f23d4d129003757d), Python package 2.0.20 | 2026-09-15 |
| Graphiti | [`c035afb7`](https://github.com/getzep/graphiti/tree/c035afb7990b6077331a81e98b04efcfd9bf8184), package 0.30.2 | 2026-09-11 |
| Cognee | [`c0d18c80`](https://github.com/topoteretes/cognee/tree/c0d18c80e24b7b78918e7642c03f6f128fdd2aee), package 1.5.4 | 2026-09-09 |
| Hindsight | [`be0e9399`](https://github.com/vectorize-io/hindsight/tree/be0e93997a35d517250181c4dfb2d86c2dd95bc1), hindsight-api-slim 0.10.0 | 2026-09-15 |

## Mem0: modules within a library, with an outer server

`Memory` and `AsyncMemory` orchestrate memory operations, using factories for
embedding, LLM, vector-store and reranking implementations. Embeddings, LLMs,
rerankers and vector stores have distinct modules and capability interfaces.
The `Memory` constructor also constructs dependencies and directly uses SQLite
history; it is both a memory interface and an assembly point.
[Memory implementation](https://github.com/mem0ai/mem0/blob/b51f7692f002d4f8719dd5c0f23d4d129003757d/mem0/memory/main.py),
[provider factories](https://github.com/mem0ai/mem0/blob/b51f7692f002d4f8719dd5c0f23d4d129003757d/mem0/utils/factory.py).

Storage belongs to the reusable library. `VectorStoreBase` exposes collection
management, CRUD, search and listing, while concrete implementations live beside
it. Model interfaces also live in that library. The wheel packages these modules
together and requires OpenAI and Qdrant dependencies, with additional integrations
available through extras.
[Storage interface](https://github.com/mem0ai/mem0/blob/b51f7692f002d4f8719dd5c0f23d4d129003757d/mem0/vector_stores/base.py),
[embedding interface](https://github.com/mem0ai/mem0/blob/b51f7692f002d4f8719dd5c0f23d4d129003757d/mem0/embeddings/base.py),
[manifest](https://github.com/mem0ai/mem0/blob/b51f7692f002d4f8719dd5c0f23d4d129003757d/pyproject.toml).

The separately assembled self-hosted server supplies FastAPI, login, API keys,
deployment configuration, request logs and a dashboard. Applications can embed
the library without that server.
[Server documentation](https://github.com/mem0ai/mem0/blob/b51f7692f002d4f8719dd5c0f23d4d129003757d/server/README.md).

**Lesson for Lore:** keep storage with the memory engine when it serves memory
operations; distinguish that from product authentication, HTTP and UI. Mem0's
factory-aware memory constructor is a tradeoff, not a requirement to copy.

## Graphiti: retrieval policy and model execution have separate interfaces

`Graphiti` accepts a graph driver, LLM client, embedder and cross-encoder client.
These interfaces and their concrete implementations live inside `graphiti_core`.
Its constructor also supplies concrete Neo4j and OpenAI defaults, so replaceable
implementations do not make this a provider-independent package.
[Constructor](https://github.com/getzep/graphiti/blob/c035afb7990b6077331a81e98b04efcfd9bf8184/graphiti_core/graphiti.py#L137-L274),
[core modules](https://github.com/getzep/graphiti/tree/c035afb7990b6077331a81e98b04efcfd9bf8184/graphiti_core).

Search coordinates full-text, vector and graph-traversal channels and applies
RRF, MMR, graph-distance or episode-mention policies. Its cross-encoder path
bounds and fuses candidates before calling the injected client's `rank` method.
This gives a useful distinction between retrieval algorithms and the protocol
used to obtain model scores. Database-specific search code still exists below
this layer; the interfaces are not a claim of complete storage independence.
[Search orchestration](https://github.com/getzep/graphiti/blob/c035afb7990b6077331a81e98b04efcfd9bf8184/graphiti_core/search/search.py).

The library requires Neo4j and OpenAI dependencies, with other integrations in
extras. REST and MCP are separate host projects that assemble configuration,
clients, transports and lifecycle around the library.
[Manifest](https://github.com/getzep/graphiti/blob/c035afb7990b6077331a81e98b04efcfd9bf8184/pyproject.toml#L1-L53),
[REST host](https://github.com/getzep/graphiti/tree/c035afb7990b6077331a81e98b04efcfd9bf8184/server),
[MCP host](https://github.com/getzep/graphiti/tree/c035afb7990b6077331a81e98b04efcfd9bf8184/mcp_server).

**Lesson for Lore:** keep candidate selection, fusion and diversity in the memory
engine, with model execution behind small injected interfaces. Persistence can
remain there too; this does not require copying Graphiti's concrete defaults or
its support for multiple databases.

## Cognee: useful task and algorithm modules, broader package coupling

Cognee assembles its default ingestion pipeline from classification, chunking,
graph extraction/summarization and persistence tasks. Task implementations and
pipeline execution have separate modules. Its default hybrid retrieval likewise
separates chunks, entities, facts, merging and ranking. The inspected ranking
path combines ranks with RRF and deterministic weights; it does not invoke an
external model reranker.
[Task assembly](https://github.com/topoteretes/cognee/blob/c0d18c80e24b7b78918e7642c03f6f128fdd2aee/cognee/api/v1/cognify/cognify.py#L477),
[Hybrid ranking](https://github.com/topoteretes/cognee/blob/c0d18c80e24b7b78918e7642c03f6f128fdd2aee/cognee/modules/retrieval/hybrid/ranking.py#L8).

Database interfaces and implementations remain inside the library. A unified
store composes graph and vector capabilities. Embeddings have an interface and
concrete providers, but their factory reads library configuration; this is not
strict host-only construction. The LLM gateway centralizes model protocols while
also importing product memory-context and usage-tracking modules.
[Unified store](https://github.com/topoteretes/cognee/blob/c0d18c80e24b7b78918e7642c03f6f128fdd2aee/cognee/infrastructure/databases/unified/unified_store_engine.py#L14),
[Embedding factory](https://github.com/topoteretes/cognee/blob/c0d18c80e24b7b78918e7642c03f6f128fdd2aee/cognee/infrastructure/databases/vector/embeddings/get_embedding_engine.py#L8),
[LLM gateway](https://github.com/topoteretes/cognee/blob/c0d18c80e24b7b78918e7642c03f6f128fdd2aee/cognee/infrastructure/llm/LLMGateway.py#L18).

The main distribution includes model SDKs, database libraries, FastAPI and user
management dependencies together. Its internal modules are more granular than
its package boundary.
[Manifest](https://github.com/topoteretes/cognee/blob/c0d18c80e24b7b78918e7642c03f6f128fdd2aee/pyproject.toml#L24).

**Lesson for Lore:** borrow the explicit memory-processing steps and retrieval
modules. Directory names such as `infrastructure` or `engine` do not prove that
product concerns or deployment configuration have been isolated.

## Hindsight: memory storage and retrieval algorithms stay together

Hindsight places memory persistence inside its engine. `PostgresMemories`
implements the memory-store interface and delegates SQL to concern-specific
read, write, curation and graph modules. This keeps database knowledge close to
the memory operations that depend on it.
[PostgreSQL memory store](https://github.com/vectorize-io/hindsight/blob/be0e93997a35d517250181c4dfb2d86c2dd95bc1/hindsight-api-slim/hindsight_api/engine/memories/postgres.py).

Its search code separates rank fusion from model execution. `search/fusion.py`
contains candidate caps and fusion functions; `search/reranking.py` contains
combined scoring and a reranker that calls a cross-encoder. The cross-encoder
module owns its model interface and concrete implementations. This is an
internal separation within the engine, not separate distributions.
[Fusion](https://github.com/vectorize-io/hindsight/blob/be0e93997a35d517250181c4dfb2d86c2dd95bc1/hindsight-api-slim/hindsight_api/engine/search/fusion.py),
[reranking policy](https://github.com/vectorize-io/hindsight/blob/be0e93997a35d517250181c4dfb2d86c2dd95bc1/hindsight-api-slim/hindsight_api/engine/search/reranking.py),
[cross-encoder implementations](https://github.com/vectorize-io/hindsight/blob/be0e93997a35d517250181c4dfb2d86c2dd95bc1/hindsight-api-slim/hindsight_api/engine/cross_encoder.py).

`MemoryEngine` accepts injected embeddings and a cross-encoder, but also reads
configuration, supplies defaults and creates a database backend. The containing
package depends on database drivers, model SDKs and the web framework together.
It is not a dependency-free algorithm library.
[Engine construction](https://github.com/vectorize-io/hindsight/blob/be0e93997a35d517250181c4dfb2d86c2dd95bc1/hindsight-api-slim/hindsight_api/engine/memory_engine.py#L2152),
[manifest](https://github.com/vectorize-io/hindsight/blob/be0e93997a35d517250181c4dfb2d86c2dd95bc1/hindsight-api-slim/pyproject.toml).

**Lesson for Lore:** retain PostgreSQL and memory indexing in the engine, and
separate retrieval policies from inference execution internally. Do not infer
that Hindsight has no storage interfaces from the older wording on its live
[storage page](https://hindsight.vectorize.io/developer/storage): the inspected
source has explicit backend/store interfaces, and the page itself also describes
Oracle support. Nor should Lore inherit Hindsight's broader environment-aware
engine construction just because its storage placement is useful.

## Implications for Lore

The following are recommendations from the comparison, not claims that the
projects implement Lore's exact architecture:

1. **Keep memory persistence in Core.** Memory CRUD, chunk storage, Memory Links,
   PostgreSQL queries and the `pg` adapter can remain there. Atomic memory
   operations and storage consistency belong to the engine. Its host owns tenant
   schema, authorization policies and identity-context installation; Lore OSS is
   one such host, and CoreSpeed has its own implementation.
   No generic multi-database abstraction is needed for this cleanup.
2. **Separate algorithms inside Core.** Query-term preparation, candidate SQL,
   evidence selection, reciprocal-rank fusion, recency and diversity policies
   have distinct reasons to change. Internal modules can own those algorithms
   while `createMemoryModule` remains the memory-operation interface.
3. **Separate ranking policy from model protocol.** Choosing eligible passages,
   validating scores, combining ranks and handling model failure belong to the
   memory algorithm. SDK construction, credentials, vendor request formats and
   deployment defaults belong to the OSS provider modules under the user's
   chosen narrower Core scope. This is Lore's design choice, not an industry
   rule that every SDK must live in a different package.
4. **Separate memory maintenance from process operation.** Chunk/vector generation
   identity, lease fencing and atomic activation concern memory correctness.
   Worker startup, polling, Cloudflare queue delivery and deployment settings
   concern the host. Moving all maintenance out of Core would erase this useful
   distinction.
5. **Keep self-hosted product assembly and tenant management in OSS.**
   HTTP/OpenAPI, SDK/CLI/MCP transport, UI, model configuration and deployment
   wiring belong to OSS alongside Workspace creation, memberships, Agent grants,
   and sharing rules. A caller-supplied Workspace ID is a selector, not proof of
   authorization. The host must constrain storage access before candidate
   selection and model calls and within writes. Filtering results after retrieval
   would not preserve the existing isolation contract.

### Implemented Lore separation

Core factories now bind a `MemoryStorageContext` containing `database`,
`partitionId`, `ownerId`, and optional `sourceId`. Memory operations no longer take
an Actor, and their result fields use those storage keys. They are attribution
and partition selectors, not proof of authentication or a tenant-management model.
Core keeps memory SQL, version checks, transactions, content/chunk invariants,
retrieval, and embedding maintenance. Pure query preparation and ranking moved
into internal `retrieval/query.ts`, `ranking.ts`, and `policy.ts`; candidate SQL
remains in the engine. Concrete model adapters and SDK dependencies remain in OSS.
[Storage context](../../packages/lore-core/src/memory-storage.ts),
[Memory implementation](../../packages/lore-core/src/memory.ts),
[retrieval modules](../../packages/lore-core/src/retrieval).

OSS now owns the authenticated Actor type and transaction-context installation,
its named request/maintenance roles, and request replay. A host-bound database
installs verified context inside **every** engine transaction; this includes
subsequent feedback searches, not only the first read. Core's `pg` adapter accepts
an initialization callback instead of choosing an OSS role. The OSS Memory
module keeps pre-write authorization and replay bookkeeping in the mutation
transaction and maps storage keys back to the unchanged Workspace/User/Agent
wire fields. Graph and Episode modules use the same host composition.
[Host storage binding](../../src/server/database/memory-storage.ts),
[OSS Memory module](../../src/modules/memories/service.ts),
[OSS role selection](../../src/server/database/postgres.ts),
[Core Postgres adapter](../../packages/lore-core/src/postgres.ts).

The existing physical schema still has `workspace_id`, `owner_user_id`, and
Agent-named provenance columns. No tenant or memory migration accompanied this
module refactor. Workspace APIs, SDK selection, memberships, grants, private/shared
visibility, caches, exports, and existing tenant data remain in Lore OSS. Scope
selectors and metadata context groups do not authorize access; the host's
transaction policy constrains candidates before top-k and model calls. The
[earlier tenant-removal plan](oss-tenancy-transition-plan.md) remains withdrawn.
This implementation does not introduce a generic external tenancy plugin.

Episode validation and evidence algorithms remain in Core. OSS owns authenticated
recording through the schema's `lore.record_episode` function and request replay;
Core's Observation interface handles normalized validation, reads, and deletion.
Expired request replay/event cleanup moved to OSS operations maintenance, while
embedding leases, generation activation, and pruning remain engine operations.
[Episode host](../../src/modules/episodes/service.ts),
[Episode evidence host](../../src/modules/episodes/evidence.ts),
[OSS cleanup](../../src/modules/operations/maintenance.ts),
[Core maintenance](../../packages/lore-core/src/maintenance.ts).

The package contract kit now accepts host-bound stores. Its `testDatabase` helper
accepts transaction initialization instead of a hardcoded Lore role. Verification
on 2026-09-16 passed 11 package tests, covering the existing OSS RLS and embedding
contract, an isolated consumer without OSS/model SDKs, and real Memory
CRUD/retrieval against a minimal independent PGlite schema. That schema contains
no Users, Workspaces, Agents, Memberships, or OSS permission functions; it retains
the memory storage tables and pure lexical helper required by engine SQL. This
proves host identity is not an engine prerequisite, not that an unrestricted
store is suitable for a multi-user deployment.
[Independent host test](../../packages/lore-core/tests/independent-host.test.ts),
[test kit](../../packages/lore-core/src/testing.ts).

The current ownership contract is documented in the
[architecture guide](../architecture.md#memory-engine-and-host-policy).
