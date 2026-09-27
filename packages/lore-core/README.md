# @corespeed/lore-core

Lore's reusable memory engine: Memory storage, canonical content
bounds, deterministic chunking (`lore-memory-chunking-v2`), hybrid retrieval
(simple/English FTS, relaxed English recall, deterministic CJK substring,
dense vectors, RRF fusion, optional reranking), Memory Links/graph reads,
and leased embedding maintenance over host-constrained PostgreSQL transactions.

This package is the **lore core** half of the lore core / lore oss split
(Linear HAAS-71). The lore repository's application — identity/tenancy, HTTP
API, OpenAPI, TypeScript SDK, web UI, Memory Proposals, code-aware memory,
portability, evaluation, and concrete model adapters — is **lore oss**, the host of this
engine. CoreSpeed HaaS maintains a separate vendored fork as described below.

## The contract

- **Factories bind a store.** `createMemoryModule(storage, options)` accepts
  `MemoryStorageContext`: `{ database, partitionId, ownerId, sourceId? }`.
  Its methods are `remember(input)`, `retrieve(id)`, `update(id, input, options)`,
  `forget(id, options)`, `list(input)`, and `search(input)`. They do not accept
  an Actor. Returned Memories expose `partitionId`, `ownerId`, and nullable
  `sourceId`; these are storage and attribution keys, not authentication.
- **The host owns access policy.** Every transaction from `storage.database`
  must already enforce the caller's access, including later retrieval-feedback
  rounds. Core does not resolve Users, memberships or grants, select product
  roles, or install identity GUCs. Lore OSS supplies those rules through its
  RLS schema and transaction wrappers. A different host supplies its own policy.
  Metadata filters and context-group expansion only narrow or group eligible
  evidence; they never authorize access.
- **PostgreSQL remains part of the engine.** Core owns SQL persistence and the
  narrow `PostgresDatabase` transaction interface. Its storage schema still uses
  physical names such as `workspace_id`, `owner_user_id`, and
  `created_by_agent_id`; the module maps opaque keys to those existing columns.
  Memory tables, lexical helper
  functions, and the selected embedding/maintenance capabilities remain a host
  schema contract; OSS identity tables and request replay tables are not engine
  prerequisites.
- **Model capabilities are injected.** Hosts supply `EmbeddingProvider`,
  `RerankingProvider`, and `QueryPlanningProvider` implementations. The engine
  owns vector-space identity and dimension validation, candidate
  selection, fusion, and failure behavior. Model SDKs, request protocols,
  prompts, defaults, decoding parameters, and deployment configuration belong
  to the host; using this package does not require installing model SDKs.

## Entry points

| Entry | Contents |
| --- | --- |
| `.` | Memory storage, retrieval, graph, maintenance, content/chunking, the domain contract (`LoreValidationError`, vocabularies, limits, and input validators), `MemoryStorageContext`, db seam, and model capability interfaces |
| `./postgres` | Pooled and per-transaction `pg` database factories with an optional host-supplied `initializeTransaction` callback |
| `./episodes` | Episode/Observation vocabularies (`EPISODE_KINDS`, `OBSERVATION_KINDS`), bounded admission validation, store-bound reads/deletion, and the separate rebuildable hybrid evidence index; the host schema must keep `episodes.id` as its primary key |
| `./testing` | Host-pluggable schema-contract test kit, `CORE_SCHEMA_CONTRACT`, and `missingSchemaContract` |

Lore OSS implements model capabilities under `src/server/providers`. Its domain
modules map Core results to the unchanged Workspace/User/Agent wire fields.
Authenticated Episode recording through `lore.record_episode`, request idempotency,
and expired replay/event cleanup also belong to OSS. Core retains normalized
Episode validation, evidence algorithms, and embedding lease/generation maintenance.
See the [architecture guide](../../docs/architecture.md#memory-engine-and-host-policy)
for host assembly and model transport policy.

## Schema contract

`src/schema-contract.ts` is the engine's whole storage dependency, grouped by
capability: `memory` (CRUD and retrieval), `graph` (Memory Links), `maintenance`
(embedding jobs and generations), and `episodes`. Each group names its tables with
the columns the engine reads and inserts, generated columns, ON CONFLICT unique
keys, and cascading foreign keys, plus types, `lore.*` function signatures, enum
labels and compared values, and the transaction settings the engine writes.
`tests/schema-contract.test.ts` fails when a table, function, setting, INSERT
column list, or ON CONFLICT target in the engine's SQL differs from the contract
(read-only column lists are kept by hand), and `missingSchemaContract` from
`./testing` checks a host schema's catalog against the groups it provides.

Maintenance leases fence ownership and allow reclamation; they do not cancel
provider calls. `embeddingMaintenanceLeaseSeconds` estimates a reservation from
nominal attempts, not worst-case provider wall time. Hosts are responsible for
provider deadlines and recovery from stalled requests.

## Host extension seams

`createMemoryMutationPrimitives` exposes the transaction-scoped insert/update
primitives plus maintenance notification so a host module can create or update
canonical Memories inside its own transaction with identical chunking and
embedding-job semantics. The host owns authorization, replay bookkeeping, commit,
and post-commit notification; Lore OSS's Memory Proposals review is a consumer.
A primitive's `jobId` is non-null only when it inserted an embedding job, so a
host notifies maintenance for any non-null id and for nothing else.
`memoryFromRow`, `MemoryRow`, `memorySelectColumns`, and `serializedTimestamp`
support hosts that map their own row selections. Select Memory rows with
`memorySelectColumns` so their timestamps keep the engine's canonical
microsecond UTC form; a `SELECT *` row carries the driver's millisecond `Date`.

Pure query preparation, feedback-query generation, fusion, recency, and diversity
live in internal `retrieval/` modules. SQL and storage orchestration remain part
of the engine; these modules do not add public package entrypoints.

## How hosts consume this package

The lore app consumes it as TypeScript source through the Bun workspace
(`workspace:*`), root `tsconfig.json` paths, the vitest aliases, and Next
`transpilePackages`.

There is deliberately no npm publishing, submodule, mirror, or sync script.
CoreSpeed HaaS retains its existing vendored `packages/memory-core` fork.
Lore remains upstream; HaaS ports selected changes manually and records their
provenance. The packages are not assumed to be semantically identical, and Lore
tasks do not require automatic changes to the HaaS fork. Hosts adopting this
package can run `./testing` against their own schema. Its `testDatabase` helper
applies host transaction initialization; it chooses no database role.
Package tests also exercise real CRUD/retrieval against a minimal independent
PGlite schema without OSS identity tables or authorization functions, alongside
the OSS schema's isolation and embedding-maintenance contract.

### Behavior a port must carry

These engine rules changed the public API in ways a hand port does not surface on
its own:

- **Errors carry no HTTP status.** Map them by class: `LoreValidationError`
  (including `MemoryContentValidationError`) is a 400 input refusal that names its
  `field`; `MemoryVersionConflictError` is 412; `MemoryAccessDeniedError` is 403.
  A host that read a `.status` property from engine errors now gets none. An
  out-of-range deployment option (the Episode evidence knobs) throws
  `LoreConfigurationError`, a server failure that names its `option`, not a 400.
- **Input is refused, never trimmed or clamped.** Link kind (non-blank, at most
  `MEMORY_LINK_LIMITS.maximumKindLength`, stored as given) and weight (0 through 1,
  representable as PostgreSQL `real`), list/search/Graph limits and offsets, scope,
  metadata, and Episode evidence search inputs all throw `LoreValidationError`.
  `graph.connect` used to trim its kind and clamp its weight.
- **Batch primitives validate every record before any statement**, and a refusal
  names the record: `records[i].content`, `links[i].weight`.
