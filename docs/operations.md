# Lore operations and portability

Lore has two deliberately separate portability planes:

- **database operations** preserve the complete PostgreSQL database for disaster
  recovery, including tenant data, event history, jobs, and embedding generations;
- **Workspace portability** exports only the Memories and Links visible to the
  requesting human Actor under RLS, then imports them through Lore's domain rules.

Never treat a Workspace archive as a database backup, or expose a database dump as
a Workspace export.

## Stable HTTP contract

`/api/v1` is the stable API prefix. `/openapi.json` publishes the OpenAPI 3.1.1
document, while `GET /api/v1/capabilities` reports the live schema revision and
active embedding generation without tenant data. Capabilities still requires a
verified Actor and `x-lore-workspace-id`; a bearer token's shape alone never grants
access. `GET /api/v1/actor` is human-only and returns the verified importing User id
for explicit owner remap; an archive-provided identity is never trusted as that
target. Existing unversioned routes remain available to the bundled UI, but clients
should generate integrations from the v1 document.

Lore uses a forward-only migration chain beginning with `0001_v1_baseline.sql`.
`bun run db:migrate` initializes an empty database or upgrades an existing database
whose migration ledger and checksums pass preflight. Applied migration files,
including the production baseline, are immutable; schema changes require a new
numbered migration. Readiness requires the database schema revision to match the
running application.

Memory responses carry a strong ETag such as `"memory-v3"`. `PATCH` and `DELETE`
require that exact value in `If-Match`; a missing precondition returns
`precondition_required` (428), while a stale version returns `version_conflict`
(412). `POST`, `PATCH`, and `DELETE` accept an optional `Idempotency-Key`. Keys are
scoped by Workspace, Actor, and operation, expire after 24 hours, and store only a
request hash plus the bounded response. Reusing a key with a different request
returns `idempotency_conflict` (409).

A 409 carries more than one `code`, so clients must branch on `code`, not status:
`idempotency_conflict` must not be retried with the same key, while
`transaction_conflict` (a deadlock or serialization failure the database resolved
by aborting this request) is safe to retry after its `Retry-After` delay with the
same `Idempotency-Key`.

Memory browse pagination accepts an opaque `cursor` and returns the next value in
`x-lore-next-cursor`. Do not parse or persist assumptions about the cursor format.

## Workspace export and import

`GET /api/v1/workspaces/export` requires a human Actor and
`x-lore-workspace-id`. The JSON archive contains:

- a versioned manifest, source deployment/Workspace ids, counts, and SHA-256;
- shared Memories plus private Memories owned by the requesting User;
- Links only when both endpoints are present;
- source ownership/timestamps for explicit import provenance.

An archive is bounded to 10,000 visible Memories, 50,000 visible Links, and
48,000,000 serialized bytes, so every archive export produces fits the
50,000,000-byte import request limit. Export keeps a running size sum and reads only
a one-row sentinel beyond each bound, so a Worker never materializes an unbounded
number of Workspace rows. If any bound is exceeded, export returns
`workspace_export_limit_exceeded` (409) and does not emit a partial archive. The
row limits are published by `/api/v1/capabilities`.

It never includes another member's private Memory, credentials, Memberships,
Agents, embeddings, jobs, evaluations, idempotency records, or mutation events.

`POST /api/v1/workspaces/import` accepts `{ archive, ownerMap, dryRun,
conflictPolicy }`. Every source owner must be explicitly mapped to the importing
User; Lore does not guess ownership. Always run with `dryRun: true` first. The
default `remap` policy always creates fresh ids, `skip` omits visible colliding rows,
and `error` rejects visible collisions. Checksum, counts, field limits, link endpoints, and
owner mapping are validated before writes; metadata is checked with the same
100,000-character rule as the Memory API, so anything export produced imports. An
import request larger than 50,000,000 bytes is refused with 413
`payload_too_large` before it is parsed, whether it declares `Content-Length` or
streams. Imported Memories get embedding jobs in the import transaction, so dense
retrieval does not wait for the sweep.

A completed archive checksum is replay-safe for that importer and Workspace while
every Memory it imported still exists. If some or all of them were deleted,
importing the same archive again restores the missing Memories, reuses the
survivors, and re-creates Links that touch a restored Memory, on the same receipt.

The import limit counts UTF-8 bytes of the request body. Archives exported before
the 48,000,000-byte export bound existed can exceed it, especially CJK or other
non-ASCII-heavy Workspaces; re-export them from an upgraded deployment, or split
the Workspace, rather than raising the limit.

Every imported Memory receives a fresh target id. `error` and `skip` apply only to
source-id collisions the importing Actor can already see; Lore never probes or
preserves a source id in a way that could reveal an RLS-hidden Memory.

## Logical backup and restore drill

Use a trusted migration-owner/admin connection. The backup is a PostgreSQL custom
archive plus a mode-0600 SHA-256 manifest:

```bash
DATABASE_URL=postgres://lore_admin:...@db.example/lore \
LORE_BACKUP_PATH=./backups/lore-$(date +%Y%m%d).dump \
  bun run db:backup
```

Treat both files as secrets and move them to encrypted, access-controlled storage.
A PostgreSQL archive is trusted input: restoring it executes database definitions.
See PostgreSQL's [`pg_dump`](https://www.postgresql.org/docs/18/app-pgdump.html)
and [`pg_restore`](https://www.postgresql.org/docs/18/app-pgrestore.html) security
notes.

Restore only into a new empty database whose name is explicitly confirmed:

```bash
createdb lore_restore_drill
LORE_BACKUP_PATH=./backups/lore-20260807.dump \
LORE_RESTORE_DATABASE_URL=postgres://lore_admin:...@localhost/lore_restore_drill \
LORE_RESTORE_CONFIRM=lore_restore_drill \
  bun run db:restore
```

The restore verifies the manifest, schema revision, pgvector, RLS, and request/
maintenance role privileges. Use an isolated drill/recovery cluster. The restore
rejects any pre-existing member of either Lore group role so a production runtime
credential cannot silently inherit access to restored private data. On a new
cluster, the admin must have `CREATEROLE` so the restore can create Lore's two
NOLOGIN group roles. Afterwards run
`scripts/database/create-runtime-role.ts` against the restored database to provision fresh
login credentials; never copy production runtime passwords into a drill.

A restore drill is complete only after all of these pass against the restored
database:

```bash
bun run db:preflight
bun run typecheck
bun run test
curl --fail http://127.0.0.1:3000/readyz
```

Record the backup checksum, PostgreSQL/Lore versions, recovery time, row-count
checks, and drill date outside the restored database. Delete the drill database only
after verification.

## Point-in-time recovery

PITR is a PostgreSQL cluster capability, not a Lore HTTP feature. Managed Postgres
operators should enable and test the provider's continuous-backup policy. Self-host
operators need periodic physical base backups and continuous WAL archiving to
durable off-host storage. Validate the server first:

```bash
DATABASE_URL=postgres://lore_admin:...@db.example/lore \
LORE_PITR_ARCHIVE_DIRECTORY=/secure/lore-wal-archive \
LORE_PITR_RESTORE_DRILL_CONFIRMED_AT=2026-08-01T12:00:00Z \
  bun run db:pitr:check
```

The check requires `wal_level=replica|logical`, `archive_mode=on|always`, a
non-no-op `archive_command` containing PostgreSQL's `%p` WAL-path placeholder, at
least one observed successful archive newer than the latest failure, the exact
latest WAL name as a non-empty regular file under `LORE_PITR_ARCHIVE_DIRECTORY`,
one WAL sender, and a restore drill recorded within the last 90 days. The command
and archive path are always redacted because they may expose storage details. This
bounded checker intentionally supports a locally visible, uncompressed archive
directory. WAL-G, pgBackRest, object-storage, and managed-service archives require
their provider's artifact verification plus a restore drill instead of this script.
Only a successful restore drill proves recoverability. Data checksums are reported
as a strong advisory. A representative base-backup command is:

```bash
pg_basebackup --dbname="$DATABASE_URL" --pgdata=/secure/lore-base-20260807 \
  --format=plain --wal-method=stream --checkpoint=fast \
  --manifest-checksums=SHA256 --progress
pg_verifybackup /secure/lore-base-20260807
```

For recovery, stop Lore and its maintenance worker, restore a verified base backup
into a new cluster, configure `restore_command`, create `recovery.signal`, and set
one exact `recovery_target_time` or `recovery_target_lsn`. Start PostgreSQL, confirm
the recovery target and data, promote, then repoint Lore and require `/readyz` plus
an isolation smoke test before traffic. Preserve the failed cluster until the drill
is signed off. The canonical procedure is PostgreSQL's
[continuous archiving and PITR](https://www.postgresql.org/docs/18/continuous-archiving.html).

## Stalled Ollama maintenance

The native Ollama SDK has no non-streaming request deadline. A connected server
that stops answering can leave `provider.embed()` pending indefinitely. The
self-host worker's embedding loop waits for its current round before polling again,
so this can delay other embedding generations. Code Index jobs and the discovery and
retention sweep run in their own loops and keep making progress. This is an accepted
consequence of using the SDK's default transport.

The embedding lease is an ownership/reclaim window, not a watchdog. Ollama uses
the default seven-minute window regardless of `LORE_EMBEDDING_TIMEOUT_MS`;
expiry does not interrupt its HTTP request or record a timeout failure. Another
worker can reclaim the job after expiry, while the lease token fences late
completion by the old worker. SDK-backed providers with deadlines use their
configured timeout to estimate a lease; retries and batching can still exceed it.

Inspect the maintenance logs and `bun run db:embedding:report` for a lack of
progress, and verify that Ollama itself responds. Restore or restart Ollama with
the service manager used by the deployment, then restart a stuck maintenance
worker through its supervisor (native development: `bun run service:restart`).
The existing expired-lease claim path recovers the job while its retry budget
remains; inspect the report's dead-job count for exhausted jobs and re-arm them with
`bun run db:embedding:requeue-dead` (see [dead embedding jobs](#dead-embedding-jobs)).
When the stalled run finally returns, its late write is fenced by the replacement
lease and it logs `job_lost`, a normal outcome rather than an infrastructure error.
Do not clear lease tokens manually or mark unfinished jobs successful. `/livez` and `/readyz` are not worker
liveness checks and do not prove this polling loop is progressing. Deployments
that require bounded provider waits should use an SDK with native deadlines.

## Embedding generation rollout

Changing preprocessing revision is a generation rollout even when provider and
model strings stay the same. In particular, the release that introduces
`lore-embedding-v2` for Ollama/Qwen3 adds the official query-side instruction;
existing `lore-embedding-v1` document vectors are not relabeled or mixed into that
space. Start the new maintenance worker, allow it to build the v2 generation,
inspect coverage with `bun run db:embedding:report`, activate it, and only then
finish rolling the request application to the new release. Until an active or
retiring generation exactly matches the configured provider, model, dimensions,
and revision, `/readyz` reports embedding as degraded while lexical retrieval
remains available.

Vectors are stored by immutable `(provider, model, dimensions, preprocessing
revision)` generation. A new generation starts as `building`; the active generation
continues serving reads. To build a replacement, set these only on the maintenance
worker:

```bash
LORE_EMBEDDING_BUILD_PROVIDER=google
LORE_EMBEDDING_BUILD_MODEL=gemini-embedding-2
```

Each discovery sweep scans without blocking Memory writes, then locks only the
bounded cleanup/candidate Memory rows in UUID order. It reconciles at most one
configured batch each of terminal jobs, stale jobs, and new candidates. Embedding
HTTP work runs after that transaction and holds none of those locks.

Inspect exact coverage with the read-only report. It never creates a generation
or seeds jobs; before the worker's first sweep for that identity it prints
`not initialized`. The `db:embedding:*` commands run with `--no-env-file`, so pass
every variable explicitly:

```bash
LORE_MAINTENANCE_DATABASE_URL=postgres://... \
LORE_EMBEDDING_BUILD_PROVIDER=google \
LORE_EMBEDDING_BUILD_MODEL=gemini-embedding-2 \
  bun run db:embedding:report
```

Activation refuses any missing chunk, unfinished job, or dead job. Once the report
is complete, activate in one database transaction, then deploy the request process
with the new provider/model:

```bash
bun run db:embedding:activate
```

The former generation becomes `retiring` and remains queryable by the previous app
configuration during a rolling deploy. Roll back by selecting the former
provider/model as the build target and running the same activation command.
`LORE_EMBEDDING_ROLLBACK_SECONDS` defaults to seven days; after that window the
maintenance sweep prunes an idle retiring generation and its vectors. Canonical
Memory chunks are not rewritten during a model switch.

### Dead embedding jobs

A job that fails eight times stays `dead`, and a dead job blocks activation of its
generation. After fixing the cause, count and then re-arm one generation's dead jobs
with the maintenance login; take the id from `db:embedding:report`:

```bash
LORE_MAINTENANCE_DATABASE_URL=postgres://... \
  bun run db:embedding:requeue-dead -- --generation <generation-id>
LORE_MAINTENANCE_DATABASE_URL=postgres://... \
  bun run db:embedding:requeue-dead -- --generation <generation-id> --apply
```

The first form is a dry run that only counts. `--apply` resets every dead job of
that building or active generation whose Memory still matches the job's version,
owner, and scope to `pending` with `attempt_count` 0, in one transaction that takes
the generation lock first, as retention and activation do. Jobs for a Memory that has
changed since stay dead for the sweep to cancel. The command refuses a retiring,
failed, or unknown generation.

## Code Index jobs

Code Index jobs index one exact commit of an operator-configured repository.
`LORE_CODE_REPOSITORIES` maps each repository key to a display name, a local path,
and optionally the Workspaces allowed to index it:

```bash
LORE_CODE_REPOSITORIES='{"corespeed/lore":{"displayName":"Lore","repositoryPath":"/srv/lore","workspaceIds":["<workspace-uuid>"]}}'
```

- **Workspace binding.** With `workspaceIds`, only Actors in those Workspaces can
  enqueue or index the repository. An entry without `workspaceIds` is served to
  every Workspace, so Lore keeps it only when `AUTH_MODE` is explicitly `password`
  or `none` (single-operator deployments). With `AUTH_MODE=proxy`, or when
  `AUTH_MODE` is unset, such an entry is ignored with a warning. A Workspace
  outside the binding receives exactly the same `400` as an unconfigured key, so
  the response cannot enumerate the registry.
- **The worker needs the registry too.** The maintenance worker resolves each job's
  repository path from its own `LORE_CODE_REPOSITORIES` by key and re-checks the
  Workspace binding when it processes the job. It never reads the path stored in
  the job row. Give the worker the same `LORE_CODE_REPOSITORIES` and `AUTH_MODE`
  as the application. A worker with an empty registry logs
  `code-index-maintenance disabled` and leaves jobs pending; a job whose key was
  removed, or is no longer bound to its Workspace, ends `dead` with
  `repositoryKey is not configured by this deployment`.
- **Terminal failures.** Invalid input (for example a commit that is not in the
  local clone), an OID whose source conflicts with an earlier index, and an
  incomplete generation fail identically on every attempt, so the job ends `dead`
  on its first attempt with that message. Messages never contain the repository
  path. Any other failure keeps the five-attempt retry budget with exponential
  backoff and the generic `Code Index processing failed`. Logs carry the error
  class and SQLSTATE, never the message.
- **Expired final attempts.** A worker that dies during a job's last attempt leaves
  an expired lease; the next claim marks that job `dead` with
  `Code Index job lease expired during its final attempt`.
- **Re-enqueue re-arms.** Enqueueing the same repository and commit again re-arms
  a `dead` or `cancelled` job for the new requester with a fresh retry budget. It
  also takes over a job whose requester can no longer run it (a revoked grant, a
  disabled Agent, or a suspended Membership). A job that can still run is left
  as it is.
- **Agent lifecycle.** Disabling or deleting an Agent cancels its pending and
  processing Code Index jobs, so a job requested by an Agent never runs under
  the human owner's authority after the Agent is deleted. A worker holding such a
  job's lease logs `job_lost`. Re-enqueue the commit to index it under a current
  Actor.

Two jobs that finish different generations of the same revision serialize on the
revision row during activation, and the one-active-generation-per-revision index
remains the correctness backstop.

## Probes and telemetry

- `GET /livez` is process-only and never checks external dependencies.
- `GET /readyz` verifies database access, the `lore_app` runtime role, schema/app
  compatibility, pgvector, and a fail-closed RLS probe. The RLS check reads
  `pg_catalog`: every public table except the non-tenant `lore_system_state` and
  `lore_schema_migrations` must enable RLS, so a table added by a later migration
  is covered without editing a list. `db:restore` verifies restored databases the
  same way.
- An embedding-provider failure produces `status: degraded` but HTTP 200 because
  lexical retrieval remains available. Database, role, schema, vector, or RLS
  failure produces `status: unready` and HTTP 503.

### Memory Core product smoke

`bun run smoke:memory-core` exercises the complete migration chain and the stable
API routes against a real Postgres/pgvector database. It covers the runtime
`lore_app` role, readiness and capabilities, Workspace and private-Memory RLS,
Agent credentials, Observation evidence, human-only Proposal review, lexical
retrieval without a working embedding generation, Graph visibility, and explicit
Episode forgetting.

The command is intentionally mutation-only: it never resets or drops a database.
Provide a fresh, empty disposable database whose name contains `smoke` as a
distinct `-` or `_` token; the command refuses any other target or a non-empty
database. The caller owns database cleanup after the run.
The bootstrap also configures two login roles derived from the smoke database name;
on a persistent local Postgres cluster, remove those roles when the smoke fixture is
no longer needed.

The URL must authenticate a trusted migration administrator that owns the fresh
database and can install pgvector, create the schema, create or alter login roles,
and grant the `lore_app` and `lore_maintenance` roles. Do not supply a Lore runtime
login.

```bash
LORE_SMOKE_DATABASE_URL=postgres://postgres:password@localhost:5432/lore_memory_core_smoke_local \
  bun run smoke:memory-core
```

Set `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (and
optionally `OTEL_EXPORTER_OTLP_HEADERS`) to export Next.js and Lore spans through OTLP. Lore's
custom span attributes contain only bounded operation/outcome/error-class names.
They never add Memory content, retrieval queries, Workspace/User/Agent/Memory ids,
archive payloads, or provider error messages.

Those OTLP variables apply to the self-host application and maintenance worker
on Bun. CoreSpeed Cloud uses Cloudflare Workers native observability from
`wrangler.jsonc`; the Node OTLP SDK is deliberately not loaded inside workerd.

## Migration preflight

`bun run db:migrate` runs the same preflight as `bun run db:preflight` before taking
the migration lock. dbmate owns SQL parsing and application; Lore owns the advisory
lock, schema compatibility checks, and SHA-256 values stored beside dbmate versions
in `lore_schema_migrations`. An existing Lore schema without a recognized ledger,
or with missing or changed checksums, is rejected. Investigate the ledger mismatch
against the deployed release and backup before proceeding; do not edit applied
migrations or replace a production database to bypass preflight.

The preflight blocks unsupported PostgreSQL versions, missing pgvector, insufficient
create privilege, changed/unknown applied migration checksums, migration gaps, and a
database schema newer than this application. For production, set
`LORE_MIGRATION_BACKUP_CONFIRMED=1` only after verifying a restorable backup; the
flag is recorded as an advisory, never as proof that the backup exists.

Always invoke migrations through `bun run db:migrate`. Production recovery is
forward-only: the `down` sections are intentionally empty, so running `dbmate down`
directly would remove a ledger version without reverting its schema changes.
