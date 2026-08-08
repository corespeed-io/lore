# Lore Portable Core gap analysis

Date: 2026-08-07

Lore baseline inspected: `e26fd90c7f9e0b4ec5423f8b78d63dbec0d6778c` plus the current working-tree implementation described below.
Scope: the durable, portable Memory data plane. Automatic summarization, merging, consolidation, insight generation, entity extraction, and AutoDream are explicitly out of scope.

## Executive conclusion

Lore already has the hardest security foundation: one Postgres schema, transaction-local Actor context, RLS on tenant-owned tables, user-private and Workspace-shared Memories, pre-top-k authorization, a durable embedding-job state machine, and native CRUD/search/graph APIs. It does **not** need another storage abstraction or an intelligence pipeline to become a credible portable core.

The highest-value gaps are reliability and operability:

1. **P0 — replay-safe and concurrency-safe mutation:** idempotency keys, `ETag`/`If-Match`, and a single-transaction update path.
2. **P0 — two portability planes:** an operator-grade Postgres backup/restore path and an RLS-scoped, versioned Workspace export/import format.
3. **P0 — transactional mutation/audit events with explicit deletion semantics.**
4. **P0 — generation-based embedding reindex:** keep the old semantic index serving until the new generation is complete, then atomically switch.
5. **P0 — real liveness/readiness and privacy-safe observability.**
6. **P0 — an explicit API/schema compatibility contract and migration preflight.**
7. **P1 — authorized change feeds/webhooks, attachments, public SDK/protocol surfaces, quotas, and an air-gapped deployment profile.**

Full content revision restore and bidirectional offline sync are P2. They should not delay the reliability substrate. None of the recommended P0/P1 work requires AutoDream.

## Method and source boundary

The Lore inventory was made from `AGENTS.md`, `CONTEXT.md`, `README.md`, all six SQL migrations, the requested domain modules, `src/lib/http.ts`, Actor/request context, migration tooling, and every current API route. External evidence is limited to official specifications, official product documentation, and official source repositories. Marketing benchmark claims and third-party summaries are not used.

The external systems are design evidence, not drop-in architectures. In particular, Lore must not copy a vector database's tenancy model, bypass Postgres RLS, or expose raw PostgreSQL logical replication to request actors.

## Current Lore inventory

| Area | Present now | Material gap |
|---|---|---|
| Tenant/security model | Workspace tenancy; user-owned Memories; shared/private scopes; Agent grants; RLS on identity, Memory, chunk, link, job, and Evaluation data (`db/migrations/0001_initial.sql:610-623`, `0002_memory_embedding_jobs.sql:459-493`) | Any new event, attachment, quota, export, or delivery table must receive equivalent RLS and negative isolation tests |
| Mutation | Native create/update/delete; server UUID; transactionally inserted chunks and embedding job; `memories.version` increments (`src/lib/memory.ts:1178-1283`) | No request idempotency contract, client precondition, or replay ledger; update pre-reads content in a separate transaction, so a concurrent content write can make a scope-only re-chunk stale |
| Search | RLS-filtered lexical/dense candidate generation, deterministic fusion, optional planning/feedback/recency/reranking (`src/lib/memory.ts:683-1026`, `1324-1511`) | No change to the retrieval architecture is required for Portable Core |
| Background maintenance | Persistent leased jobs, `SKIP LOCKED`, retries/dead state, stale-job cancellation; one Memory's replacement chunks are swapped atomically (`0002_memory_embedding_jobs.sql`; `src/lib/maintenance.ts:111-244`) | Deployment-wide model/revision transition excludes old vectors as each row is rebuilt; there is no active/building generation or atomic fleet cutover |
| Graph | RLS-safe durable links and visible-endpoint graph reads (`src/lib/graph.ts:298-409`; link policies at `0001_initial.sql:811-871`) | No public link mutation route or external event contract; neither is an intelligence requirement |
| Version/audit/delete | Current Memory has an integer version; credential revocation and Evaluation versions exist | No immutable mutation event, old version record, deletion tombstone, retention/purge contract, or history API; delete is a cascading hard delete |
| Bulk portability | A Docker Postgres volume is persisted | No Lore backup/restore command or verified runbook; no Workspace export/import, dry run, manifest, checksum, or ownership remap |
| Attachments | Text content plus JSON metadata | No binary/original-object relation, checksum, MIME/size, upload state, or lifecycle |
| API/SDK/protocol | Native HTTP handlers and a typed in-repo browser client | No versioned OpenAPI document, public SDK, capabilities endpoint, MCP adapter, batch write, or stable error/idempotency contract |
| Operations | Migration checksum table and advisory migration lock (`scripts/migrate.mjs:20-94`); bounded content, result, and worker-concurrency settings | `/api/health` returns static `{status:"ok"}` without checking DB/schema; no readiness split, telemetry contract, per-Workspace quotas, rate governance, or recovery drill |
| Local/offline | Docker/Postgres deployment can use local Ollama; provider failures degrade to lexical search | No explicit no-egress profile, offline artifact manifest, digest-pinned installation path, or fail-closed managed-provider guard; no disconnected client sync |

## Priority map

| Priority | Capability | Core decision | Complexity |
|---|---|---|---|
| P0 | Idempotent writes + optimistic concurrency | Required Portable Core | M |
| P0 | Operational backup/restore + portable export/import | Required Portable Core | L |
| P0 | Transactional audit/change event + deletion contract | Required Portable Core | L |
| P0 | Generation-based zero-downtime embedding reindex | Required Portable Core | L |
| P0 | Liveness/readiness + privacy-safe telemetry | Required Portable Core | M |
| P0 | API/schema compatibility + migration preflight | Required Portable Core | M |
| P1 | RLS-safe change feed and optional webhooks | Core integration surface, after the P0 outbox | L |
| P1 | Attachment/original-object lifecycle | Core storage primitive; interpretation is an extension | L |
| P1 | OpenAPI-generated SDKs and external MCP adapter | Core access surface; MCP remains an adapter | M |
| P1 | Quotas, rate limits, and resource budgets | Core for hosted/multi-tenant operation | L |
| P1 | Explicit air-gap profile | Core deployment profile | M |
| P2 | Full content revision browse/restore | Optional core feature, retention-sensitive | L |
| P2 | Bidirectional disconnected client sync | Not a v1 core requirement | XL |

## P0. Replay-safe and concurrency-safe mutation

### Current evidence and risk

`remember` creates a fresh UUID, so an HTTP retry can create a second Memory. `update` increments `version`, but HTTP does not expose an entity tag or require an expected version. More importantly, `writableMemoryContent` runs before the update transaction (`src/lib/memory.ts:1162-1176`, `1232-1275`); a scope-only update can therefore reinsert chunks derived from an older content read after another writer has changed the Memory.

### Primary evidence

- HTTP defines `If-Match` as a conditional mutation precondition; failure is `412 Precondition Failed` unless the server can prove the requested state change already succeeded ([RFC 9110 §13.1.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1)).
- Qdrant's official point API documents idempotent point loading: the same point ID overwrites the previous point, and mutations enter the write-ahead log before asynchronous application ([Qdrant Points](https://qdrant.tech/documentation/concepts/points/#idempotency)). This supports stable operation identity and durable admission; it does not replace Lore's transaction/RLS design.

### Portable Core contract

- Accept `Idempotency-Key` on create, update, delete, and each item in a batch. Persist `(workspace_id, actor identity, operation, key, request_sha256, status, response reference, expires_at)` in an RLS-covered table.
- Same key plus same hash returns the original result. Same key plus a different hash returns `409`. The record and domain mutation commit in one transaction.
- Return `ETag: "memory-v{version}"`. Require or strongly support `If-Match` on update/delete; include `WHERE id = ? AND version = ?` in the mutation and return `412` when zero rows match.
- Lock/read the current row and perform authorization, patch merge, version increment, chunk replacement, job enqueue, and audit-event append in one Actor transaction. Do not hold the transaction across provider calls.
- A bulk API is a streaming envelope over these same per-item rules, not a privileged path. Make all-or-nothing and per-item modes explicit.

### Deployment, RLS, and complexity

Implementation is identical in self-host and Cloud; Cloud additionally benefits because edge/client retries are common. Idempotency records must never be globally keyed or readable across actors. TTL cleanup is maintenance work with no content payload. **Priority P0; complexity M.**

## P0. Two portability planes: database recovery and logical data transfer

### Current evidence and risk

Lore persists a Postgres volume, but the repository has no verified backup/restore workflow. A raw database dump and a safe Workspace transfer solve different problems and must not be conflated.

### Primary evidence

- PostgreSQL 18 states that `pg_dump` makes a consistent export even while the database is in use; custom/directory archives support selective and parallel `pg_restore`. It also warns that restoring a dump executes source-superuser-selected code ([PostgreSQL 18 `pg_dump`](https://www.postgresql.org/docs/18/app-pgdump.html)).
- Weaviate's official backup API supports selected collections, asynchronous status, and object-store/filesystem backends while documenting version and multi-tenancy restrictions ([Weaviate backups](https://docs.weaviate.io/deploy/configuration/backups)). This is evidence for explicit jobs/status/manifests, not for adopting its storage model.
- Docker documents that volumes outlive containers and require a separate backup/migration procedure ([Docker volumes](https://docs.docker.com/engine/storage/volumes/)). Persistence alone is not recovery.

### Portable Core contract

**Operational recovery:** ship a documented, tested `pg_dump -Fc`/`pg_restore` workflow, a schema/version manifest, role/extension preflight, checksum, restore validation, and a recurring recovery drill. Treat dump input as trusted administrative material. Do not include secrets in documentation or application-visible output.

**Logical transfer:** define a versioned, streaming archive (manifest plus NDJSON and optional object files) scoped to one authorized Workspace. Include stable export-local IDs, Memory content/scope/metadata/provenance/timestamps, durable links, attachment descriptors, SHA-256 hashes, schema version, and source deployment ID. Exclude credentials, sessions, job leases, derived chunks, vectors, Evaluation runs, and idempotency records by default.

Import must support dry-run and an explicit conflict policy; remap owners/Agents through an administrator-approved mapping, never trust source tenant IDs, validate every link endpoint, and enqueue the active embedding generation. Import events should retain non-authoritative source provenance without impersonating the source actor.

### Deployment, RLS, and complexity

Self-host can use filesystem archives; Cloud should stream to operator-controlled R2/S3-compatible storage through a short-lived administrative job. Logical exports must query through an explicitly authorized export role and preserve private/shared boundaries; a Workspace admin must not silently gain the content of another user's private Memories unless the product defines a separately audited recovery authority. **Priority P0; complexity L.**

## P0. Transactional events, auditability, and deletion semantics

### Current evidence and risk

`memories.version` records only the current counter. Updates and hard deletes leave no immutable causal record, and cascading deletion removes chunks, links, and jobs. That is simple and privacy-friendly, but insufficient for replay-safe integrations, incident analysis, or an authorized change cursor.

Mem0 OSS has a separate history table with old/new content and event metadata, but its vector-store mutation and SQLite history write are separate operations ([fixed source: storage history schema](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/memory/storage.py), [mutation/history calls](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/memory/main.py)). Lore should take the capability, not the non-atomic split-store implementation.

### Portable Core contract

- Append a `memory_events`/outbox row in the same transaction as every create/update/delete/scope/link/attachment mutation.
- Store monotonic sequence, Workspace/Memory, actor kind/id, request/idempotency correlation, before/after version, event type, changed-field names, content hashes, and timestamp. Content snapshots are **not** required for the P0 event.
- A hard delete removes primary content, chunks, vectors, links, and attachment objects. Retain only a minimal tombstone event for a documented period, then purge it. A future legal-hold feature must be explicit, access-controlled, and separable.
- Define delete versus unlink versus credential revoke precisely. Return a replay-safe terminal result for a repeated delete.

### Deployment, RLS, and complexity

One Postgres implementation serves both profiles. Cloud queues and self-host pollers consume committed outbox rows; neither is the source of truth. Event rows carry the same Workspace/owner/scope authorization necessary to avoid revealing a private Memory's existence. Audit payloads and observability logs must not duplicate content. **Priority P0; complexity L.**

## P0. Generation-based embedding upgrade and atomic cutover

### Current evidence and risk

Lore already gets single-Memory replacement right: maintenance computes outside the transaction, then verifies its lease and atomically replaces chunks (`src/lib/maintenance.ts:135-244`). However, search compares only the active provider/model/revision. During a deployment-wide change, a Memory disappears from dense retrieval until its new vector is ready; there is no fleet-level active/building cutover.

### Primary evidence

- Qdrant recommends either adding a named vector and reindexing, or creating a new collection and atomically switching a collection alias to achieve zero-downtime model migration ([Qdrant collections and aliases](https://qdrant.tech/documentation/concepts/collections/#collection-aliases), [upgrade guidance](https://qdrant.tech/documentation/faq/qdrant-fundamentals/#how-to-update-my-embedding-model-without-downtime)).

### Portable Core contract

- Add an immutable embedding-generation record with provider, model, dimension, preprocessing revision, index parameters, status (`building`, `active`, `retiring`, `failed`), coverage, and timestamps.
- Continue querying the current active generation while jobs build the candidate generation. New/updated Memories should be indexed into the active generation and, when practical, the building generation.
- Gate promotion on exact eligible-Memory coverage, zero nonterminal/dead jobs or an explicit waiver, vector/index readiness, dimension/revision validation, and a smoke retrieval check.
- Flip the deployment's active generation in one transaction. Keep the previous generation for a bounded rollback interval, then prune it asynchronously.
- Never merge scores from incompatible vector spaces. Lexical retrieval remains available during every state.

### Deployment, RLS, and complexity

The database state machine is shared. Self-host uses the Node maintenance worker; Cloud uses the existing Postgres job truth with Queue wakeups. Coverage checks run in maintenance context but expose only aggregate state to operators. Per-Workspace coverage labels can leak tenant activity and should not become public metrics. **Priority P0; complexity L.**

## P0. Liveness, readiness, and privacy-safe observability

### Current evidence and risk

`/api/health` always returns `{status:"ok"}` (`src/app/api/health/route.ts:4`) and therefore cannot distinguish a live process from a request path unable to open Postgres, assume the application role, or find the expected schema.

### Primary evidence

- Kubernetes defines liveness as restart eligibility, readiness as traffic eligibility, and startup probes as a gate that prevents liveness/readiness from running too early ([Kubernetes probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/)).
- PostgreSQL provides `pg_isready` for server connection status ([PostgreSQL 18 `pg_isready`](https://www.postgresql.org/docs/18/app-pg-isready.html)). Lore additionally needs an application-role transaction because network reachability alone does not prove RLS/runtime readiness.
- OpenTelemetry semantic conventions provide stable names for traces, metrics, logs, HTTP, and database operations; the pinned semantic-conventions release audited here is `v1.43.0` ([official specification](https://opentelemetry.io/docs/specs/semconv/)).

### Portable Core contract

- `/livez`: process/event-loop only; no provider or database dependency.
- `/readyz`: short, timeout-bounded application-role transaction; verify expected migration version/checksums, required extensions, role assumption, and a harmless RLS-context probe. Return machine-readable failed component names, never secrets.
- Provider outages should report `degraded`, not make the request path unready, because Lore intentionally degrades to lexical/`NULL` embeddings.
- Instrument HTTP/search/job/reindex/export/import operations and provider calls. Minimum metrics: request/error/latency, pool wait, job depth/oldest age/retries/dead, reindex coverage, provider timeouts, import/export bytes and failures.
- Never put Workspace/User/Agent/Memory IDs, content, query text, metadata, credentials, or high-cardinality idempotency keys in metric labels. Correlation IDs belong in access-controlled traces/logs with retention limits.

### Deployment, RLS, and complexity

Self-host exposes endpoints and optional OTLP; Cloud integrates Workers telemetry and still emits provider-neutral OTel where possible. Cloud readiness must not perform migrations. **Priority P0; complexity M.**

## P0. API/schema compatibility and migration safety

### Current evidence and risk

Lore checksum-protects migrations and serializes them with a PostgreSQL advisory lock, which is a strong start. The external API has no machine-readable version/capability contract, and there is no documented major-Postgres upgrade or restore preflight.

### Primary evidence

- OpenAPI 3.1.1 is a language-agnostic HTTP API description with explicit API version, security schemes, webhooks, and binary schemas ([OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)).
- PostgreSQL 18 documents dump/restore, `pg_upgrade`, or logical replication as the supported major-version upgrade families; the method and extension compatibility must be planned rather than inferred from the data directory ([PostgreSQL 18 upgrading](https://www.postgresql.org/docs/18/upgrading.html)).

### Portable Core contract

- Publish `/openapi.json`, semantic API version, stable error codes, and `/api/capabilities` containing schema revision and enabled **deployment** features without tenant data.
- Adopt expand/backfill/contract migrations for rolling Cloud releases. Mark minimum compatible app/schema revisions and refuse unsafe starts with a useful readiness error.
- Add migration preflight: Postgres major version, required extensions, available disk, role capabilities, expected checksums, and recent-backup acknowledgement for destructive/large rewrites.
- Restore testing, not successful dump creation, is the acceptance gate.

### Deployment, RLS, and complexity

Self-host may offer an explicit migrate command and maintenance window; Cloud runs migrations from the trusted migration environment, never a request Worker. Capability output must not include provider secrets, tenant counts, or private feature use. **Priority P0; complexity M.**

## P1. Authorized change feed and optional webhooks

### Current evidence and external boundary

Lore has no change cursor or webhook. PostgreSQL logical decoding can stream database changes and is useful for replication/auditing, but it requires replication privileges and replica identity for prior update/delete values ([PostgreSQL 18 logical decoding](https://www.postgresql.org/docs/18/logicaldecoding.html)). It is an operator mechanism, not a safe public RLS API.

[CloudEvents 1.0.2](https://github.com/cloudevents/spec/tree/v1.0.2) supplies a portable event envelope. OpenAPI 3.1.1 can describe webhooks. Neither standard supplies Lore authorization, delivery semantics, or privacy boundaries.

### Portable Core contract

- Build `/api/changes?cursor=` over the committed P0 event/outbox table, with stable cursor, bounded pages, retention horizon, and an explicit `410 cursor_expired` resync path.
- Re-authorize each event at read time. A scope change/revocation must not leave an old cursor capable of disclosing content; deleted/private events expose only the minimum allowed terminal metadata.
- Optional administrator-created webhooks select event types and Workspace, use HTTPS, signed timestamped deliveries, rotation, bounded retry/dead-letter status, and redacted delivery logs. Queue messages carry only event/delivery IDs.

Self-host uses a Postgres poller; Cloud uses Queue wakeups plus a scheduled outbox sweep. Both have the same source of truth. **Priority P1; complexity L.**

## P1. Attachments and multimodal originals

### Current evidence and primary evidence

Memory content is text and metadata JSON. There is no lifecycle for an original image, audio, PDF, or arbitrary file. Weaviate's blob type demonstrates that base64 binary can be a distinct non-indexed data primitive, while explicitly leaving application size limits to the operator ([Weaviate blob datatype](https://docs.weaviate.io/weaviate/config-refs/datatypes#datatype-blob)). S3 exposes durable object metadata, checksums, and version IDs ([Amazon S3 object metadata](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html)). These are storage primitives, not evidence that large blobs belong in Lore's JSON or Postgres rows.

### Portable Core contract

- Add `memory_attachments` with Workspace/Memory/owner, opaque storage key, filename, MIME, byte length, SHA-256, upload status, provenance, created/deleted timestamps, and optional storage version.
- Use a narrow object-store seam for original bytes: filesystem/object directory for self-host, R2/S3-compatible storage for Cloud. Postgres remains the authorization and lifecycle source of truth.
- Use create-upload-finalize with short-lived authorization and server verification of size/hash. An attachment is readable only after finalization; orphan cleanup and deletion are idempotent maintenance jobs.
- Export/import includes verified object files. Hard Memory deletion eventually removes the object and keeps only the minimal tombstone described above.
- OCR, transcription, captioning, thumbnails, modality embeddings, and generated summaries are **Intelligence Extensions**, not Portable Core.

Never log signed URLs or object keys; authorize both attachment and parent Memory; prevent filename/MIME trust and decompression bombs; account quota before finalization. **Priority P1; complexity L.**

## P1. Public SDKs and an MCP adapter

### Current evidence and primary evidence

The in-repo TypeScript browser transport is not a versioned public SDK. MCP revision `2025-06-18` distinguishes application-controlled resources from model-controlled tools; it defines cursor-paginated resources and text/blob/image/audio content ([MCP server concepts](https://modelcontextprotocol.io/specification/2025-06-18/server), [MCP schema](https://modelcontextprotocol.io/specification/2025-06-18/schema)). Its HTTP authorization specification treats the server as an OAuth resource server and forbids token passthrough ([MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)).

### Portable Core contract

- Make OpenAPI the public contract and generate thin TypeScript/Python clients. Handwritten convenience helpers may wrap, but not redefine, HTTP behavior.
- Keep MCP outside the Memory domain. Expose authorized Memory reads/search as resources and create/update/delete as tools, all through ordinary Actor context and RLS. Use opaque Lore URIs; never encode secrets or private titles.
- HTTP MCP uses resource-bound OAuth tokens; STDIO uses operator-supplied environment credentials. Never accept a downstream token and pass it to another provider, and never use an unrestricted service role.

The adapter can run beside the Node app locally or at the Cloud edge, but must share the same contracts and limits. **Priority P1; complexity M.**

## P1. Quotas and resource governance

### Current evidence and primary evidence

Lore bounds content, query results, graph size, reranker candidates, and maintenance concurrency, but has no Workspace storage/attachment/job/provider budgets. Qdrant strict mode provides official examples of caps on query limits, timeouts, filter complexity, batch upserts, storage, and read/write rate ([Qdrant strict mode](https://qdrant.tech/documentation/guides/administration/#strict-mode)). PostgreSQL provides statement, lock, idle-transaction, and transaction timeouts and cautions against indiscriminate global settings for some of them ([PostgreSQL 18 client timeouts](https://www.postgresql.org/docs/18/runtime-config-client.html)).

### Portable Core contract

- Add deployment defaults and optional Workspace overrides for Memory count/content bytes, attachment bytes/count, batch items/bytes, concurrent jobs, job backlog, search complexity, and provider-call budget.
- Enforce storage/count quota transactionally with the mutation; maintain reconcilable counters rather than request-time corpus scans. Reconcile drift as maintenance.
- Apply transaction-local statement/lock timeouts to expensive request paths. Use stable `413`, `429`, and `503` codes and `Retry-After` where appropriate.
- Edge rate limiting may protect Cloud, but database-authoritative storage quotas remain necessary. Self-host defaults should be generous/configurable, not disabled by incompatible code paths.

Quota inspection is operator/authorized-administrator data. Metrics must not publish tenant identity or content. **Priority P1; complexity L.**

## P1. Explicit air-gapped local profile

### Current evidence, primary evidence, and decision

Lore can run with local Postgres and Ollama, but “can be configured locally” is weaker than a reproducible disconnected profile. Portable Core should support an explicit no-egress mode; it should **not** add PGlite or a browser database, because Postgres/RLS is an architectural invariant.

Docker's official CLI can save an image, all parent layers, tags, and versions to a streamable archive and load the image plus tags from a compressed archive ([`docker image save`](https://docs.docker.com/reference/cli/docker/image/save/), [`docker image load`](https://docs.docker.com/reference/cli/docker/image/load/)). This supplies the transport primitive; Lore must still publish the exact image digests, platform variants, configuration, database-extension, and model-artifact manifest needed for a verifiable installation.

### Contract

- `LORE_NO_EGRESS=1` rejects Google/OpenAI/managed reranker/planner endpoints at startup and prevents silent remote fallback.
- Publish digest-pinned OCI images, an offline artifact manifest/checksum procedure, required Postgres extensions, optional local model artifact instructions, and an offline upgrade/rollback runbook.
- Health/capabilities report local/degraded states without names, keys, or endpoint secrets.
- Backup, export/import, SDK, and MCP STDIO work with no network dependency.

This is the same product/schema on both profiles; Cloud never enables this flag. It is not bidirectional client sync. **Priority P1; complexity M.**

## P2 and explicit non-goals

### Full content revision restore — P2, optional core

Mem0 OSS demonstrates a user-facing history capability, but its separate vector-store mutation and SQLite history write also shows why Lore should not add history outside the primary transaction ([fixed source](https://github.com/mem0ai/mem0/blob/4debc58a83377b18be81ae1e5969a300736b2fac/mem0/memory/storage.py)). A complete immutable content snapshot per version can support user-visible diff/restore, but it multiplies private-data retention, erasure, export, encryption, and quota obligations. First ship content-free P0 mutation events. If snapshots are later added, make retention bounded/operator-configurable, RLS-identical to the current Memory, restorable only by an authorized owner, and purgeable with hard deletion. Self-host and Cloud can share the schema, but Cloud needs stronger operator access, retention, and key-management controls. Complexity L; priority P2.

### Bidirectional disconnected sync — P2/XL, not a v1 requirement

Apache CouchDB 3.5's official conflict model illustrates the hidden scope: bidirectional synchronization is two one-way replications, concurrent revisions are both retained, a deterministic winner hides but does not resolve the loser, old revision identifiers and deletion markers must survive pruning, and the application still owns conflict resolution ([fixed 3.5.0 conflict source](https://github.com/apache/couchdb/blob/11f0d36438afef9f2d30b4192d709feed908046e/src/docs/src/replication/conflicts.rst), [fixed replication-protocol source](https://github.com/apache/couchdb/blob/11f0d36438afef9f2d30b4192d709feed908046e/src/docs/src/replication/protocol.rst)). Multi-master Lore edits would therefore require globally stable operation IDs, cursors, causal/conflict semantics, attachment transfer, tombstone retention, and authorization-revocation behavior. A disconnected replica must not retain readable data after its User/Agent grant is revoked, yet it cannot learn the revocation while offline; this is a fundamental security/product decision, not a transport detail. P0 idempotency/OCC plus the P1 change feed are prerequisites, not a promise of sync. A local single-deployment/no-egress profile already satisfies self-host portability without inventing a second consistency model. Self-host and Cloud would share conflict semantics but need different relay/discovery infrastructure. Complexity XL; priority P2/not v1 core.

### Intelligence Extensions — not Portable Core

Do not put automatic summarization, consolidation, memory merging, generated entity graphs, proactive insights, OCR/transcription/captioning, or modality-specific embeddings into the core contract. They may consume authorized core APIs later, but their derived data needs separate provenance, lifecycle, versioning, RLS, quotas, and explicit opt-in.

## AutoDream-compatible foundations, without putting AutoDream in core

The following proposed capabilities are general data-plane primitives that a future opt-in AutoDream extension could reuse:

| General foundation | Core purpose today | Possible future extension use | Boundary that must remain |
|---|---|---|---|
| Idempotency + OCC | Safe ordinary writes and retries | Replay-safe derived writes | Extension cannot bypass owner authority or expected-version checks |
| Mutation outbox | Audit and integrations | Trigger an opt-in derivation job | Event is not authorization; re-resolve Actor/Workspace permissions |
| Embedding generations | Safe model upgrades | Version a derived embedding space | No automatic content consolidation is implied |
| Attachments | Preserve authorized originals | OCR/caption source | Generated text is a separate derived artifact with provenance |
| Quotas/telemetry | Protect operator resources | Bound model jobs/cost | No content/query text in metrics; no cross-tenant batching |
| Export/import | User data portability | Carry opted-in derived artifacts in a later format version | Base export remains usable without the extension |

This separation keeps the core useful even if AutoDream is never implemented.

## Recommended delivery sequence

1. **Mutation safety:** idempotency ledger, single-transaction update, `ETag`/`If-Match`, concurrency/RLS tests.
2. **Durable events and deletion:** transactional outbox, minimal tombstones, change schema, purge tests.
3. **Recovery and compatibility:** operational backup/restore drill, logical Workspace export/import, OpenAPI/capabilities, migration preflight.
4. **Operational continuity:** active/building embedding generations, atomic promotion/rollback, real readiness and OTel.
5. **P1 surfaces:** authorized changes/webhooks, attachments, SDK/MCP adapter, quotas, air-gap packaging.

Every phase needs positive and negative tests across two Workspaces, two Users in one Workspace, private/shared scope, revoked membership/Agent grant, deletion, and scope change. Isolation failures remain hard failures rather than aggregate quality metrics.

## Primary-source/version manifest

| Source | Version pinned for this audit | Relevance |
|---|---|---|
| PostgreSQL documentation | 18 | dump/restore, logical decoding, readiness, timeouts, major upgrades |
| HTTP Semantics | RFC 9110 | conditional mutation |
| OpenAPI | 3.1.1 | versioned HTTP/SDK/webhook contract |
| MCP | protocol revision 2025-06-18; official spec repository observed at `9d4a9115126f1356f4b189af3266c1839a4e9bbb` | resources/tools/content/auth boundary |
| CloudEvents | 1.0.2 | portable event envelope |
| OpenTelemetry semantic conventions | 1.43.0 | telemetry naming and attributes |
| Qdrant | official docs; source repository observed at `74f3e85b9473c62560006c043e13737ce6b48412` | idempotent point writes, strict-mode limits, alias-based cutover |
| Weaviate | official docs; server repository observed at `e6e3aa9e89786573fa2e97baf7347a2248ed50b7` | backup jobs and blob primitive |
| Mem0 OSS | `4debc58a83377b18be81ae1e5969a300736b2fac` | history capability and atomicity caution |
| Apache CouchDB | `3.5.0`, peeled tag `11f0d36438afef9f2d30b4192d709feed908046e` | disconnected replication/conflict scope |
| Docker CLI documentation | official documentation observed 2026-08-07 | offline image archive transport |

Repository HEAD observations make mutable source state auditable; the design claims above cite versioned standards or official documentation directly. No model, dataset, or proprietary service was used for this audit.
