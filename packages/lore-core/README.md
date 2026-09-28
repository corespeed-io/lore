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
`./testing` checks a host schema's catalog against the groups it provides. It
counts a unique key only as a whole, non-partial unique index on plain columns:
an expression or partial index cannot match an ON CONFLICT target.

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
  `field`; `MemoryVersionConflictError` is 412; `MemoryAccessDeniedError` is 403;
  `MemoryLinkCapacityError` is 409 and names the `limit` it hit.
  A host that read a `.status` property from engine errors now gets none. An
  out-of-range Episode evidence retrieval knob (neighbor chunks, top Observations,
  planner queries, rerank candidate limit, minimum score, and weight, and the
  distance threshold) throws `LoreConfigurationError`, a server failure that names
  its `option`, not a 400.
- **Input is refused, never trimmed or clamped.** Link kind (non-blank, at most
  `MEMORY_LINK_LIMITS.maximumKindLength`, stored as given) and weight (0 through 1;
  a nonzero value PostgreSQL `real` would round to zero is refused, while the
  `1e-45` PostgreSQL prints for its smallest `real` is accepted), list/search/Graph
  limits and offsets, scope, metadata, and Episode evidence search inputs all throw
  `LoreValidationError`.
  `graph.connect` used to trim its kind and clamp its weight.
- **`graph.connect` is an upsert by natural key; `graph.disconnect` deletes by it.**
  A Link is identified by (source, target, kind). `connect` creates it, or replaces
  an existing one's weight and metadata (omitted fields return to their defaults),
  and returns `{ link, created }`; a repeat with the same values writes nothing and
  emits no Link event. `disconnect({ sourceMemoryId, targetMemoryId, kind? })`
  returns whether it deleted a Link. Both lock the source Memory `FOR NO KEY UPDATE`
  and read the target through the host store, and answer `null`/`false`, not an
  error, when the store cannot lock the source or see the target; under RLS that
  lock admits only a source the caller may write. `connect` used to insert only,
  failing on a duplicate natural key or an unreachable endpoint. If the store stops
  showing an existing Link before its replacement lands, `connect` answers `null`;
  if the target vanishes before a new Link's insert, the database's error (under
  OSS, an RLS refusal or a foreign-key violation) surfaces for the host to map.
  `connect` throws `MemoryLinkCapacityError` (a fourth public failure class, a 409,
  whose `limit` names the bound) rather than create a Link past a
  `MEMORY_LINK_LIMITS` bound: kinds per directed pair, Links per source, Links per
  target, and Links per partition. Each count stops at its bound and runs through
  the host store, so under RLS it counts only the writer's visible Links. Replacing
  an existing Link never counts.
  These writes need UPDATE and DELETE on `memory_links` and a row-lockable
  `memories`, which `missingSchemaContract` cannot check: under RLS the source lock
  applies the `memories` UPDATE policy, and a Link's rewrite or deletion applies the
  `memory_links` UPDATE or DELETE policy.
- **A Graph read is bounded in links as well as nodes.** `read()` returns the newest
  `MEMORY_GRAPH_LIMITS.maximumLinks` durable Links at most (in creation order, no
  metadata) and `linksTruncated`; a cut suppresses affinity. Every `MemoryGraphLink` carries
  `derived`, true only for affinity edges. A port that read every Link, or told
  affinity apart by `kind`, must adopt both.
- **Batch primitives validate every record before any statement**, and a refusal
  names the record: `records[i].content`, `links[i].weight`. `insertMemoriesInTransaction`
  takes the ids it inserts; give it fresh UUIDs, never ids from an archive, or a
  collision with an invisible Memory reveals that it exists.
