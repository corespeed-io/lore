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
active embedding generation without tenant data. Existing unversioned routes remain
available to the bundled UI, but clients should generate integrations from the v1
document.

Memory responses carry a strong ETag such as `"memory-v3"`. `PATCH` and `DELETE`
require that exact value in `If-Match`; a missing precondition returns
`precondition_required` (428), while a stale version returns `version_conflict`
(412). `POST`, `PATCH`, and `DELETE` accept an optional `Idempotency-Key`. Keys are
scoped by Workspace, Actor, and operation, expire after 24 hours, and store only a
request hash plus the bounded response. Reusing a key with a different request
returns `idempotency_conflict` (409).

Memory browse pagination accepts an opaque `cursor` and returns the next value in
`x-lore-next-cursor`. Do not parse or persist assumptions about the cursor format.

## Workspace export and import

`GET /api/v1/workspaces/export` requires a human Actor and
`x-lore-workspace-id`. The JSON archive contains:

- a versioned manifest, source deployment/Workspace ids, counts, and SHA-256;
- shared Memories plus private Memories owned by the requesting User;
- Links only when both endpoints are present;
- source ownership/timestamps for explicit import provenance.

It never includes another member's private Memory, credentials, Memberships,
Agents, embeddings, jobs, evaluations, idempotency records, or mutation events.

`POST /api/v1/workspaces/import` accepts `{ archive, ownerMap, dryRun,
conflictPolicy }`. Every source owner must be explicitly mapped to the importing
User; Lore does not guess ownership. Always run with `dryRun: true` first. The
default `remap` policy always creates fresh ids, `skip` omits visible colliding rows,
and `error` rejects visible collisions. Checksum, counts, field limits, link endpoints, and
owner mapping are validated before writes. A completed archive checksum is
replay-safe for that importer and Workspace.

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
`scripts/create-runtime-role.mjs` against the restored database to provision fresh
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

## Embedding generation rollout

Vectors are stored by immutable `(provider, model, dimensions, preprocessing
revision)` generation. A new generation starts as `building`; the active generation
continues serving reads. To build a replacement, set these only on the maintenance
worker:

```bash
LORE_EMBEDDING_BUILD_PROVIDER=google
LORE_EMBEDDING_BUILD_MODEL=gemini-embedding-2
```

The scheduled sweep discovers every missing chunk. Inspect exact coverage with:

Each bounded discovery sweep takes a brief database write barrier on `memories`
while it reconciles stale jobs and seeds at most the configured batch. Embedding
HTTP work runs after that transaction and never holds the barrier.

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

## Probes and telemetry

- `GET /livez` is process-only and never checks external dependencies.
- `GET /readyz` verifies database access, the `lore_app` runtime role, schema/app
  compatibility, pgvector, and a fail-closed RLS probe.
- An embedding-provider failure produces `status: degraded` but HTTP 200 because
  lexical retrieval remains available. Database, role, schema, vector, or RLS
  failure produces `status: unready` and HTTP 503.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (and
optionally `OTEL_EXPORTER_OTLP_HEADERS`) to export Next.js and Lore spans through OTLP. Lore's
custom span attributes contain only bounded operation/outcome/error-class names.
They never add Memory content, retrieval queries, Workspace/User/Agent/Memory ids,
archive payloads, or provider error messages.

Those OTLP variables apply to the Node application and self-host maintenance
worker. CoreSpeed Cloud uses Cloudflare Workers native observability from
`wrangler.jsonc`; the Node OTLP SDK is deliberately not loaded inside workerd.

## Migration preflight

`bun run db:migrate` runs the same preflight as `bun run db:preflight` before taking
the migration lock. It blocks unsupported PostgreSQL versions, missing pgvector,
insufficient create privilege, changed/unknown applied migration checksums, and a
database schema newer than this application. For production, set
`LORE_MIGRATION_BACKUP_CONFIRMED=1` only after verifying a restorable backup; the
flag is recorded as an advisory, never as proof that the backup exists.
