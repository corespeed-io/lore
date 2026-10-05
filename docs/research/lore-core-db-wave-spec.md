# Spec: lore-core database wave (v3)

Status: **implemented as PRs 0, 1, and 2** in the stack #135 → #138 → #139 → #141 → #140 → #137 → #136 → #142 (2026-10-04). Each PR was reviewed and approved on its own, and all of them merge into `main` through #135. The design text below is kept as reviewed; where the build differs, an *As built* note says how (§4.3a, §5, §6, §10). **Not done:** the Hyperdrive prototype and verification (§4.4, §9.2), so Workers keep pipelining off; and PR 3, which waits on those measurements.
Author: Claude (Agent Ensemble session), for Yunpeng. Dates: 2026-10-03 to 2026-10-04. Base: `main` at `ed9c5c8`.
v3 replaces v2 after an independent Codex review, summarized in §14.

## Summary

A Lore request today makes 9 to 20 database statements, one after another. On Workers it also opens a new pg connection for every transaction. Each statement waits for the one before it, so latency scales with the number of statements times the round-trip time to Hyperdrive.

v2 proposed moving every engine operation into a SQL function so each request would be a single statement. The review showed three problems with that plan:

- The `pg` version we pin already supports pipelining, which v2 said it didn't. With pipelining, statements and network waits are no longer the same thing.
- A one-call search would run paid provider calls before authenticating the Agent.
- Some operations depend on TypeScript decisions in the middle of the operation, so they can't move into SQL verbatim. Search fusion, context-group expansion, and the Graph fallback are examples.

v3 therefore measures before it moves engine SQL:

0. **PR 0, readiness that tolerates compatible schemas.** App-only, no migration. After this, a migration can declare which older app revisions it stays compatible with, so a rolling deploy keeps old instances ready (§9.1).
1. **PR 1, connections and pipelining.** No schema change.
   - lore oss owns connection lifetime; core's `./postgres` adapter moves to oss.
   - `pg` goes to 8.23.1 and `pg-cloudflare` to 1.4.1.
   - Admission moves into the business transaction as its first pipelined statements, using the functions `lore_app` already executes. A typical read becomes 1 network wait instead of 11, with no schema change and no new grants (§4.3).
   - Dense search costs one extra database wait after the embedding call. For humans, admission runs concurrently with the embedding call; Agents are admitted first, because their token is verified only in the database.
   - Writes take 2 waits.
   - Budget tests count statements and waits separately.
   - A prototype on a real Hyperdrive binding measures pipelined writes against SQL write functions (§4.4).
2. **PR 2, write-path semantics and safe schema changes.** The engine SQL stays in TypeScript.
   - A no-op PATCH writes nothing, and a scope-only PATCH keeps chunks and vectors.
   - Chunks are reused by ordinal, and the embedding claim returns only missing chunks.
   - Forget now emits an event for outbound Links, and Agent `last_used_at` writes are throttled.
   - Dead indexes and columns are dropped, and the chunk→vector cascade gets its missing index.
3. **PR 3, SQL write functions, only if PR 1's numbers favor them.**
   - Keyed create, update, forget, and Link connect become SQL functions that run after the same pipelined admission prefix, so every write is 1 wait.
   - The functions are core `_in_scope` functions plus oss ledger wrappers, executed by `lore_app`.
   - No hook, no login grants, and no new schema are needed.
   - The PR includes the grant guard and the canonical definitions for the core SQL it installs.

Out of the wave, as separate PRs: the embedding-maintenance API consolidation (§11) and dependency upgrades other than `pg` and `pg-cloudflare`. *As built:* both stayed separate PRs (#137, #136), stacked on the wave so that they merge with it in one step.

### Decision log

| Date | Decision | By |
| --- | --- | --- |
| 2026-10-03 | Scope-only updates stop re-chunking and re-embedding; the AGENTS.md scope invariant is rewritten (§6.3). | Yunpeng |
| 2026-10-03 | Admission runs inside the database, and request logins receive the grants it needs. *Superseded 2026-10-04 (below): admission runs in the transaction's pipelined prefix and needs no new grants.* | Yunpeng |
| 2026-10-03 | Core owns its SQL and a narrow, driver-free database seam. Connection lifetime belongs to the host. Core's `./postgres` adapter moves to oss, and core drops `pg`. Came from comparing with mem0 OSS. | Yunpeng |
| 2026-10-03 | Per-owner Link capacity counting stays as it is. | Yunpeng |
| 2026-10-04 | Measure before moving engine SQL into functions. PR 1 compares pipelined writes with SQL write functions on real Hyperdrive, and PR 3 follows the numbers. Came from the Codex review. | Yunpeng |
| 2026-10-04 | Admission runs as the first pipelined statements of the business transaction (role switch, then admission that sets the RLS settings from its own result, then a membership check read after the batch), with the existing `register_identity` and `authenticate_agent_credential`. Reads are 1 wait in PR 1. This supersedes the 2026-10-03 direct grants to request logins and the `lore.enter` hook: neither is needed. | Yunpeng |
| 2026-10-04 | Search: human callers, whose credential the app has already verified, run admission concurrently with the provider calls. Agent callers are admitted before any provider call. Lexical-only search batches like a read. | Yunpeng |
| 2026-10-04 | `pg` → 8.23.1 and `pg-cloudflare` → 1.4.1 go into PR 1. Other dependency upgrades are a separate PR. | Yunpeng |
| 2026-10-04 | *As built* (amends the two admission and search rows above; details in §4.3a): <br>• Humans are admitted with `lore.resolve_identity`, never `register_identity`. Membership needs a registered User, and a read-only prefix fits the read-only snapshots. <br>• A human's search sends its prefix with the first pass after the provider calls. That is still 1 wait after the embedding call. <br>• Agents are also admitted first before a read-only or repeatable-read snapshot. <br>• Workers keep pipelining off (`LORE_POSTGRES_PIPELINE=0`) until §9.2 is measured. | Claude, in review |

## 1. Background and measurements

**Method.**

- A throwaway PGlite probe wrapped `PostgresDatabase` with a statement counter and drove the real Hono API (`createApi` + `app.request`).
- The review reproduced these counts independently with Bun 1.4.2 and PGlite 0.5.8.
- The counts include the `BEGIN`, `SET LOCAL ROLE`, and `COMMIT` that production sends for every transaction.
- The SDK attaches an `Idempotency-Key` to every Memory write. `normalizedIdempotencyKey` generates one when the caller passes none, so SDK writes carry the ledger `INSERT` and its completion `UPDATE`.

| Request (human Actor unless noted) | Statements today | Workers connections today |
| --- | --- | --- |
| GET actor | 6 | 1 |
| GET workspaces | 9 | 2 |
| GET memory, list | 11 | 2 |
| Search, no planner, feedback, or expansion | 11 | 2 |
| Search, general | ≈ 11 + (planned queries − 1) + expansion + 6 × feedback rounds | 2 + 1 per feedback round |
| GET graph | 12; 13 when a node's label needs full content | 2 |
| GET links | 12 | 2 |
| POST memory (SDK, provider on) | 18 | 2 |
| PATCH (SDK, provider on), including identical content | 18–20 | 2 |
| DELETE memory (SDK) | 15 | 2 |
| PUT link | 14 | 2 |
| DELETE link | 12 | 2 |
| Agent GET memory | 9 | 2 |

A read's 11 statements break down as:

| Statements | Count | Owner |
| --- | --- | --- |
| Admission transaction: `BEGIN`, `SET ROLE`, `register_identity`, `set_config`, `is_active_member`, `COMMIT` | 6 | oss |
| Business transaction: `BEGIN`, `SET ROLE`, actor `set_config` | 3 | oss |
| The engine read | 1 | core |
| `COMMIT` | 1 | core adapter |

**Every statement is a separate network wait today**, because each `await tx.query` waits for its reply before sending the next.

**Connections.** `createRequestPostgresDatabase` (core `postgres.ts:83`) opens a new `pg.Client` for every transaction. On the same adapter shape, HaaS measured about 13 ms per Hyperdrive connect.

**Write-path findings** (lifecycle probe on PGlite with the real roles; the review confirmed them):

- Identical content and scope-only updates replace every chunk (`memory.ts:964`). That drops every vector and queues a new job, and the version and ETag still change. Identical content also writes an event with `changed_fields = []`.
- A content edit replaces and re-embeds every chunk.
- Forget emits `memory_link.deleted` only for inbound Links. When an outbound Link cascades, its source row is already gone and the trigger skips it.
- The chunk→vector cascade (`memory_chunk_embeddings_chunk_id_fkey`) has no index that leads with `chunk_id`. Each deleted chunk therefore reads the whole primary-key index `(generation_id, chunk_id)` or the whole table.
- Under `lore_app`, the `memories_metadata_gin_idx` predicate stays a filter and never becomes an index condition. `@>` is not leakproof, the same reason migrations 0002 and 0003 dropped the chunk GINs.

**Facts this spec relies on:**

- **`pg` 8.23.0 added query pipelining** (`client.js:101/617/643`; [docs](https://node-postgres.com/features/pipelining)). 8.23.1, released 2026-09-30, fixes three things I compared in the published packages:
  - a query that keeps a portal open (for example one using `rows` or a cursor) is now refused in pipeline mode, where it used to misroute rows to other queries;
  - `sync()` no longer marks the connection as ending;
  - TLS hostname validation works again for IP hosts.
- **`pg-cloudflare` 1.4.1** fixes the Workers socket's `write(data, callback)` overload.
- **Admission can share the read's transaction** (verified on the migrated chain as a NOINHERIT login, 2026-10-04). Run these in one transaction, each statement independent of the previous one's result:
  1. `set_config('role','lore_app',true)`.
  2. `SELECT set_config('lore.workspace_id',$ws,true), set_config('lore.user_id', identity.id::text, true), set_config('lore.agent_id','',true) FROM lore.register_identity(…) identity`.
  3. `SELECT lore.is_active_member($ws)`.
  4. The read.

  For a member, this returned `active: true` and the row. For a non-member, it returned `active: false` and zero rows, because RLS filtered the read.
- **PostgreSQL executes pipelined statements in order.** Under READ COMMITTED each statement takes its own snapshot when it starts. A lock statement followed by a read in the same batch therefore keeps today's semantics: the read sees what was committed before the lock was granted.
- **An invoker-rights hook can switch the role.** A hook that runs `set_config('role', …, true)` changes the effective role for the caller's later statements, and those statements see RLS, including the UPDATE policy on `SELECT … FOR UPDATE`. The role and settings reset at the end of an autocommit statement and last until COMMIT inside an explicit transaction. Verified twice on PGlite.

## 2. Goals and non-goals

**Goals**

- **Network waits per request after PR 1:**
  - 1 for reads and lexical search;
  - for dense search, 1 database wait after the embedding call (human callers), or 2 (Agent callers);
  - 2 for writes.

  If PR 3 adopts SQL write functions, writes drop to 1. Statements and waits are counted separately, and budget tests pin both.
- **Connections.** At most one per Workers request, or two when work runs concurrently.
- **No provider spend for unverified callers.** An Agent's token is checked only in the database, so no planner or embedding call is made before its database admission. A human's credential is verified by the app before any call. Only their Workspace membership check may overlap the provider call, and a failed check then answers 403.
- **Writes change only what changed.** Unchanged chunks keep their vectors.
- **Ownership.** lore-core owns its SQL, a driver-free seam, and embedding mechanics. lore oss owns identity, admission, RLS policy, roles, idempotency, and connection lifetime.
- **Rolling deploys stay safe.** Old instances stay ready through compatible migrations (PR 0).

**Non-goals**

- No change to retrieval quality, ranking, the chunking revision, or the embedding protocol revision.
- No new product surface beyond the no-op PATCH semantics (§6.2).
- Moving fusion, context-group expansion, or reranking out of TypeScript.
- Single-call functions for the oss domains that aren't hot (Agents, Proposals, Evaluations, Episodes, Code, portability). They get connection reuse and pipelining.
- Requiring HaaS to adopt anything. Its fork ports changes manually, at its own pace (AGENTS.md distribution convention).

## 3. PR 0 — readiness for compatible schemas

Today readiness requires `schema_revision === LORE_SCHEMA_REVISION` (`src/modules/operations/service.ts:6, :236`). Once a migration commits, every old instance therefore reports `incompatible` before any new code is deployed. `docs/operations.md` already documents the consequence for 0007–0009: either take a maintenance window or relax gating until the whole chain lands.

PR 0 is app-only:

- **Readiness rule.** An instance is ready when `db.schema_revision ≥ app_revision` and `db.compatible_from ≤ app_revision`.
- **`compatible_from`** is a new `lore_system_state` column, published as `compatibleFrom` by `lore.portable_core_capabilities()`.
  - That function is the `SECURITY DEFINER` function readiness already calls; `lore_app` has no direct SELECT on `lore_system_state`.
  - PR 0 reads `capabilities.compatibleFrom` when it is present, and treats a missing field as equal to `schemaRevision`, which is today's exact rule.
  - 0010 adds the column and republishes the function with the field, the way 0006 did with `CREATE OR REPLACE`. `tests/server/schema-drift.test.ts` covers the new field.
- **Migrations declare compatibility.** From PR 2 on, each migration sets `compatible_from` to the oldest app revision it stays compatible with. A migration that is additive for old instances keeps it; one that removes something old instances use raises it.
- **Malformed values fail closed.** A `compatibleFrom` that is present but null, not a positive integer, or above `schemaRevision` makes readiness report `incompatible`, even at the application's own revision. It is not treated as absent.
- **Capabilities stay inside each instance's contract.** Once an older instance stays ready on a newer schema, spreading the database's capabilities would serve fields that instance's OpenAPI schema forbids (`additionalProperties: false`), starting with `compatibleFrom` itself. The capabilities response therefore copies only the fields the application publishes. Features come from an application constant, `DEPLOYMENT_FEATURES`, the way limits already do, and `schema-drift.test.ts` keeps the SQL restatement equal to it. *(Added during PR 0 implementation.)*
- **Preflight is unchanged.** It still refuses a database newer than the application for migration purposes. The tolerance applies only to readiness.
- **Deploy order:** ship PR 0, and only then migrate PR 2. PR 0 has no migration, so it needs no window.

## 4. PR 1 — connections, pipelining, budgets, prototype

### 4.1 Seam (lore-core, no driver)

```ts
export interface PostgresDatabase {
  /** BEGIN, pending settings, every statement, COMMIT: sent as one pipelined batch. */
  batch<Rows extends unknown[][]>(statements: readonly Statement[],
                                  options?: PostgresTransactionOptions): Promise<Rows>;
  /** Multi-statement work with decisions between statements. */
  transaction<Result>(use: (tx: PostgresTransaction) => Promise<Result>,
                      options?: PostgresTransactionOptions): Promise<Result>;
}

export interface PostgresTransaction {
  query<Row>(sql: string, params?: unknown[]): Promise<PostgresQueryResult<Row>>;
  /** Several statements whose inputs are already known, sent without waiting in between. */
  batch<Rows extends unknown[][]>(statements: readonly Statement[]): Promise<Rows>;
  /** Transaction-local settings (role included), sent ahead of the next statement. */
  setLocal(settings: Readonly<Record<string, string>>): void;
  /** Runs after COMMIT succeeds, never on rollback; a throwing effect is ignored. */
  afterCommit(effect: () => void): void;
}
```

- **`transaction` sends `BEGIN` and pending settings together with the first statement**, so opening a transaction costs no wait of its own. `COMMIT` waits once.
- **`batch` exists so callers say which statements are independent.** An operation whose statements don't depend on each other's results, such as a read or the tail of a write, becomes one wait including `COMMIT`.
- **Errors.** If any statement in a pipelined batch fails, the transaction aborts. The later statements fail with "current transaction is aborted", and the adapter rolls back and rethrows the first error.
- **`transactionHandle(send)`** implements `setLocal`, `batch`, and `afterCommit` once over any "send one statement" function, so adapters stay thin. It is exported for HaaS's own adapter.
- **`afterCommit` replaces job-id threading.** Core's write primitives stop returning `jobId`. Core records the jobs a transaction queued and, after COMMIT, sends at most 1,000 queue messages; the sweep picks up the rest. Hosts no longer see embedding job ids.
- **Core drops `pg`.** Core's own tests implement the seam over PGlite (`./testing`), and `pg` leaves `packages/lore-core/package.json`. The boundary check gains `pg` as a forbidden import for `packages/lore-core`.

*As built* (`packages/lore-core/src/db.ts`):

- **No `PostgresDatabase.batch`.** `PostgresDatabase` keeps only `transaction(use, options)`. A one-batch operation is `transaction(tx => tx.batch(statements, { commit: true }))`, and `commit` puts COMMIT behind the statements.
- **What `transactionHandle(send, { opening })` returns.** Its handle also carries:
  - `started()`;
  - `commit()`;
  - `rollback()`, which returns false when ROLLBACK itself failed, so the adapter destroys the client;
  - `isCommitted()`, which lets an adapter run the effects of a transaction that committed inside a batch even when the callback threw (#142);
  - `committed()`.
- **Two more helpers.** `managedTransactionDatabase` wraps PGlite-style drivers, and `transactionThrough` is for wrappers that observe statements.
- **Write primitives** take `{ commit, finish }`.
- **Update** is split into `lockMemoryInTransaction` and `updateLockedMemoryInTransaction`, and keyed forget uses `forgetLockedMemoryInTransaction` (§4.3a).

### 4.2 oss adapters (`src/server/database/postgres.ts`)

| Runtime | Factory | Behavior |
| --- | --- | --- |
| Bun / self-host / tools | `createPostgresPool(config, { role })` | `pg.Pool({ ...config, pipeline: true })` for the process lifetime. A client whose `BEGIN` or `ROLLBACK` failed is released with its error, so the pool destroys it. Today it goes back into the pool. |
| Workers request, queue batch, cron | `createRequestPool(config, { role })` | A `pg.Pool` with `max: 2`, `pipeline: true`, and `idleTimeoutMillis: 0`, created inside the request. |

The request pool's default 10-second idle eviction would open a second connection after a long planner or embedding call, so the request pool disables it. It also installs an `error` listener and closes in `finally`. Using it after `close()` throws.

*As built:* the factories keep their names, `createPostgresDatabase` and `createRequestPostgresDatabase`. `LORE_POSTGRES_PIPELINE` (`1`/`0`) chooses pipelining. It defaults on for Bun and self-host. It defaults off for the Workers request, queue, and cron pools, which then send one statement at a time, until §9.2 verifies Hyperdrive. The real-PostgreSQL smoke proves that an idle pause past 10 seconds keeps the request pool's one connection.

- **Closing.** `fetchCloudflareApi` closes the request pool in `waitUntil` after the response resolves. The queue and cron handlers close theirs in `finally`.
- **Hyperdrive.** Closing a Worker's client doesn't close Hyperdrive's pooled origin connection. Hyperdrive pools by transaction, so consecutive transactions may run on different backends. Tests therefore count client connections, never backend PIDs.
- **Role.** `{ role }` is applied with `setLocal` at the start of each transaction. That is `lore_maintenance` on the worker and `lore_app` on request paths.
- **No leakage across reuse.** Settings are always transaction-local, so a reused connection can't carry a role or identity forward.

### 4.3 What PR 1 changes on the request path

- **Admission becomes the business transaction's prefix.** Every request transaction on a hot route starts with three pipelined statements, verified in §1:
  1. `set_config('role', 'lore_app', true)`;
  2. the admission function, whose result sets the RLS settings in the same statement:
     - human: `SELECT set_config('lore.workspace_id', $ws, true), set_config('lore.user_id', identity.id::text, true), set_config('lore.agent_id', '', true), identity.id FROM lore.register_identity(…) identity`;
     - Agent: the same shape over `lore.authenticate_agent_credential($hash, $ws)`, which returns no row for an invalid or ungranted token;
  3. for humans, `SELECT lore.is_active_member($ws)`.

  Nothing in the prefix needs an earlier result, so it travels with whatever follows.
  - **The host owns the prefix.** The oss storage wrapper prepends it to the engine's batch or transaction, and core never sees it.
  - **The verdict comes after the batch returns.** A non-member, or an Agent token with no row, gets a 403. Whatever ran in the same batch is discarded. For reads that's harmless, because RLS already returned nothing (§1). For writes, RLS rejects the write itself (`memories_insert`/`update`/`delete` require membership), so the transaction aborts.
  - **No new grants.** The login switches role first, and then runs only functions `lore_app` already executes.
  - **The prefix returns the Actor ids.** A later batch in the same transaction can therefore use them as parameters.
- **Reads are one batch.** `BEGIN`, the prefix, the engine read, and `COMMIT` cost 1 wait. That covers actor, workspaces, get, list, Links, Graph (plus its rare fallback batch), and Link disconnect, which needs only a source lock and a delete.
- **Writes are two batches.**
  - The first: `BEGIN`, the prefix, and every statement that needs no earlier result. That means the ledger claim, whose actor columns come from `lore.current_user_id()` and `lore.current_agent_id()` in oss's own SQL, plus the locking read and the stored chunks.
  - The second: the dependent tail, the ledger completion, and `COMMIT`. On replay the second batch is only `COMMIT`.
  - Forget fits the same two batches. The first batch's claim result settles any expired-key reclaim, and its locking read settles whether the row can be deleted. So the second batch knows the completion body before it sends the delete.
- **Search.**
  - Humans: the prefix and the planner/embedding calls start concurrently, and the first-pass batch follows once both return.
  - Agents: the prefix runs first, because their token is verified only in the database. The provider calls run after it.
  - With no embedding provider configured (lexical only), the prefix and the first pass are one batch.
  - Context-group expansion and feedback rounds add one batch each, as today.
- **Routes that aren't hot** keep resolving the Actor first: one prefix batch, then their own transaction, which is pipelined where it can be.
- **The redundant OSS prechecks go.** Under RLS, `SELECT … FOR UPDATE` already applies the `memories_update` `USING` clause (verified), and the `memories_insert` policy already enforces write authority. The `can_write_memory` prechecks before update, forget, and remember are therefore removed. Write authority is still checked before the version comparison, so a caller who can't write gets 404 with no version leak.
- **Embedding generation lookup.** `lore.ensure_embedding_generation` folds into the job `INSERT … SELECT`, one statement instead of two.
- **Link connect.** Today's statements stay separate statements, but they are sent pipelined:
  - locking the source;
  - reading the existing Link;
  - the four counts;
  - the insert, which depends on the counts.

  Pipelining keeps per-statement snapshots, so the existing-Link read still starts after the lock is granted. Merging them into one statement would break that (review finding 7).

  *As built:* the lock and the existing-Link read stay separate statements in one batch. The four counts and the insert became one data-modifying CTE, sent with COMMIT. The insert depends on the counts, and inside one statement it needs no TypeScript decision; the source lock is already held. A connect that finds the key taken, by a Link its first read could not see, now runs whole once more under a fresh lock (#142). So a disconnect that slips in between no longer turns a valid PUT into a 404.
- **Graph keeps its version-checked full-content reread.** It runs only when a node needs it.

### 4.3a As built (PR 1b)

Measured by `tests/server/round-trip-budget.test.ts` through the real `pg` adapter. Every §5 budget holds. Five details differ from §4.3:

- **The human prefix resolves the Identity and never registers it.** It uses `lore.resolve_identity` plus `lore.is_active_member`. Membership needs a registered User, so an unregistered Identity is refused either way. The prefix stays read-only, so it also fits the Graph's and context packets' read-only REPEATABLE READ snapshots. Registration happens in `GET /workspaces`, as that request's own prefix.
- **An Agent is admitted in a transaction of its own before a read-only or repeatable-read snapshot.** `authenticate_agent_credential` may write `last_used_at`. That write would fail under READ ONLY and could fail to serialize under REPEATABLE READ. An Agent's Graph read therefore costs 2 waits.
- **A human's search sends its prefix with the first pass, after the provider calls, not concurrently with them.** That is still 1 wait after the embedding call, and one round trip fewer overall. An Agent's search that pays an embedding or planning provider is admitted first, as specified.
- **A refused write costs a second wait for its ROLLBACK.** Its claim travelled with the admission. A refused read stays 1 wait.
- **Writes split into two phases.** The core update primitive is a locking phase (`lockMemoryInTransaction`) and an apply phase (`updateLockedMemoryInTransaction`), so OSS can check the claim between them. The write primitives take a `finish` hook that appends the ledger completion to their final batch. The completion's body is built in SQL from the row just written (`writtenMemoryReplayBody`). Write authority can be revoked between the lock and the write, so the write may match no row. The completion is therefore two statements: one records the outcome only when the Memory is as the write meant to leave it (at the written version, or gone), and the other records `not_found`, which is also what the first response said. A content update refused at its chunk rewrite (42501) rolls back whole and answers 404 (found in the ship review).
- **A keyed forget locks first.** It locks with its claim and deletes in the second batch (`forgetLockedMemoryInTransaction`). A replay therefore deletes nothing, and a reclaimed key's events carry the ledger row's request id. An unkeyed forget sends its delete, version read, and COMMIT in one batch.
- **One admission per request.** Of a request's concurrent transactions, the first to run sends the admission. The others wait for its outcome and bind it before sending anything (found in review).
- **Memory-only context packets** take a pending Actor, as search does. A packet with a repository admits first, because Code reads need the Actor's ids.

### 4.4 Write-path prototype

PR 1 ships a prototype harness, not production code. It applies a scratch migration to a staging database behind a real Hyperdrive binding. For each write route it measures p50 and p95 latency, plus statements, waits, and connections, for two variants:

- **Pipelined writes:** PR 1 as shipped, 2 waits per write.
- **SQL write functions:** `lore.memory_*_in_scope` and oss ledger wrappers after the same prefix, 1 wait per write.

PR 3 adopts the functions only if the measured difference justifies moving write control flow into plpgsql.

The harness also checks that Hyperdrive handles pipelined extended-protocol queries correctly, including errors and aborts. If it doesn't, the spec is amended: the prefix then costs its own wait, and SQL functions become the way to reach 1 wait.

*As built:* **not done.** It needs a Cloudflare account with a Hyperdrive binding and a staging database. Until then Workers run with `LORE_POSTGRES_PIPELINE=0`, and PR 3 stays undecided.

## 5. Statement and wait budgets

Waits are network round trips. Statements are shown where they differ. W = Workers client connections.

| Request | Today: statements = waits (W) | PR 1 waits (W) | With PR 3 write functions |
| --- | --- | --- | --- |
| GET actor | 6 (1) | 1 (1) | 1 |
| GET workspaces | 9 (2) | 1 (1) | 1 |
| GET memory, list, links | 11–12 (2) | 1 (1) | 1 |
| GET graph | 12–13 (2) | 1, +1 for fallback (1) | same |
| Search, lexical only | 11 (2) | 1 (1) | 1 |
| Search, dense, human | 11 (2) | 1 after the embedding call; the prefix overlaps it (1) | same |
| Search, dense, Agent | 9 (2) | 2 (1): prefix, then provider calls, then first pass | same |
| Search, planner / expansion / feedback | see §1 | as above, +1 if expanding, +1 per feedback round | same |
| POST memory (SDK) | 18 (2) | 2 (1) | 1 |
| PATCH (SDK) | 18–20 (2) | 2 (1) | 1 |
| DELETE memory (SDK) | 15 (2) | 2 (1) | 1 |
| PUT link | 14 (2) | 2 (1) | 1 |
| DELETE link | 12 (2) | 1 (1) | 1 |
| Context retrieve, memory-only | 11 (2) | as search (1) | same |
| Routes that aren't hot | 9–15 (2) | 2–4 (1) | — |

- **Provider calls and admission** (review finding 1): a dense search for an Agent costs one more wait than for a human. The Agent's token is verified only in the database, so no provider call starts before the prefix returns. A human's credential was verified by the app, so their prefix overlaps the provider call, and a non-member's search ends in 403 after the provider was paid. That cost is accepted (§13).
- **Within the first pass, fusion stays in TypeScript.** The planned queries run as one batch, and context-group expansion runs after TypeScript fuses the results (`memory.ts:1341, :1365`).
- **Feedback rounds** return both the candidates and the still-visible ids, as they do today (`memory.ts:1400, :1437`).
- **Graph's fallback stays version-checked** (`graph.ts:958, :973`).
- **Write waits explained.**
  - The first batch is `BEGIN`, the prefix, the ledger claim, and the locking read plus stored chunks.
  - The second is the dependent tail, the ledger completion, and `COMMIT`.
  - Replay is the same two batches, and the second is only `COMMIT`.
- **What the tests check.** Budget tests assert waits and statements per route and per configuration (planner, expansion, feedback) for human and Agent callers, and both baseline and worst case. Latency is measured separately (§4.4).

*As built,* measured through the real `pg` adapter with pipelining on (`tests/server/round-trip-budget.test.ts`):

| Request | Human: statements / waits | Agent: statements / waits |
| --- | --- | --- |
| GET actor, GET workspaces | 5 / 1 | — |
| GET memory, list | 6 / 1 | 5 / 1 |
| GET links | 7 / 1 | — |
| GET graph | 7 / 1 | 9 / 2 (admitted before the snapshot) |
| Search, lexical | 6 / 1 | 5 / 1 |
| Search, dense | 6 / 1 after the embedding call | 8 / 2 |
| Search, planner + dense | 8 / 1 | 10 / 2 |
| Search, one feedback round | 11 / 2 | 10 / 2 |
| Search, context-group expansion | 7 / 2 | 6 / 2 |
| Context retrieve, Memory-only | as search | — |
| POST memory, keyed / unkeyed | 12 / 2, 8 / 2 | 11 / 2 |
| PATCH, keyed | 15 / 2 | — |
| DELETE memory, keyed / unkeyed | 12 / 2, 8 / 1 | 11 / 2 |
| PUT link | 8 / 2 | — |
| DELETE link | 7 / 1 | — |
| A refused read | 6 / 1 | 5 / 1 |
| A refused write | 2 waits (the second is its ROLLBACK) | 2 waits |

On Workers, with pipelining off until §9.2, every statement is a wait. For example, a Memory read costs 6 statements, where it cost 11–12 before.

## 6. PR 2 — write-path semantics and safe schema changes

### 6.1 Remember

- One batch inserts the Memory, its chunks, and the job; the generation lookup is folded into the job insert.
- The `memories_insert` policy enforces write authority, and a violation still maps to `MemoryAccessDeniedError`.

### 6.2 Update

1. A `SELECT … FOR UPDATE` (RLS) locks the row. A row the caller can't write reads as absent before the version check, so the answer is 404 with no version leak. A stale `If-Match` still gets 412 (`version_conflict`).
2. The `UPDATE` runs only when `content`, `scope`, or `metadata` actually differ (`IS DISTINCT FROM`). When none differs, the locked row comes back with the same version, `updated_at`, and ETag, with no event and no job. Idempotent replay keeps today's semantics.
3. **Empty PATCH.** A PATCH with no fields keeps today's bypass (`src/modules/memories/service.ts:205`) and returns the current row. It is covered by a test.

   *As built:* Memory Proposal acceptance passes `versionUnchanged`, so an accepted Proposal that changes nothing still records the next version. The reason is that `lore.protect_memory_proposal_review` accepts an update receipt only at base version + 1. Chunks and jobs still follow the rules below.
4. **Content changes.** The new chunks (chunking v2, computed in TypeScript) are compared with the stored ones by ordinal. Only differing ordinals and the removed tail are deleted and inserted. Unchanged ordinals keep their ids and vectors.
5. **Scope-only and metadata-only changes** don't touch chunks.
6. **Jobs.** A job is queued only when some chunk lacks a vector in the serving generation. Jobs stay fenced by version and scope, so a stale job is still cancelled at claim time.
7. **Claim.** `lore.claim_memory_embedding_job` returns only the chunks that are missing a vector. A job with nothing missing finishes without calling the provider. Old workers accept non-contiguous ordinals and write by chunk id, and empty input already works with the concrete providers (both verified by the review).

Chunks are matched by ordinal, not content: moving an ordinal would need `UPDATE … SET ordinal` against a non-deferrable unique key. A prepend still re-embeds.

### 6.3 Scope invariant (AGENTS.md)

> Deleting a Memory removes its chunks, embeddings, jobs, and Links in the same transaction. A scope change takes effect immediately and rewrites nothing: chunk, embedding, Link, and Graph reads authorize through the parent Memory row's RLS policy, and none of them stores scope.

### 6.4 Forget, Links, Agent credentials

- **Forget** runs `DELETE … [AND version = $expected] RETURNING`. When it deletes nothing, one locking read decides between 404 and 412. *As built:* the unkeyed path sends the locking version read in the same batch as the delete, so it costs no extra wait. The keyed path locks with its claim and deletes in the second batch (§4.3a).
- **Forget's events.** The `memories` BEFORE DELETE trigger also writes `memory_link.deleted` for each outbound Link, using the owner and scope from `OLD`. 0009's JSON-path replay scrub is kept verbatim.
- **Agent `last_used_at`** is updated only when it is NULL or more than 60 s old, with the age condition in the `UPDATE` predicate. A `CASE` would still lock and write the row. Authentication still returns the Actor when no update happens, and revocation is checked on every request.

### 6.5 Migrations and lock analysis

All are forward-only. Revisions continue from 9, and each migration sets `compatible_from` (PR 0).

The transactional migration runs first, because it adds the `compatible_from` column that both migrations' final UPDATE writes. (v3 of this spec listed the concurrent index migration first; it could not set `compatible_from` before the column existed.)

**Migration 0010 (transactional, `SET LOCAL lock_timeout = '5s'`).** Statements run in this order:

| # | Statement | Lock |
| --- | --- | --- |
| 1 | `ALTER TABLE memory_chunks DROP COLUMN embedding, embedding_provider, embedding_model, embedding_revision, embedded_at` (also drops their CHECK and `memory_chunks_embedding_cosine_idx`) | ACCESS EXCLUSIVE on `memory_chunks`; catalog-only, so it's brief |
| 2 | `DROP POLICY memory_chunks_update ON memory_chunks` | Same lock, already held |
| 3 | `REVOKE UPDATE ON memory_chunks FROM lore_app` | Catalog only |
| 4 | `CREATE OR REPLACE FUNCTION` claim, `append_memory_event`, `authenticate_agent_credential` | Function objects only; no table lock |
| 5 | `ALTER TABLE lore_system_state ADD COLUMN compatible_from integer` with a CHECK (`NULL` or 1 to `schema_revision`) | ACCESS EXCLUSIVE on `lore_system_state` |
| 6 | `CREATE OR REPLACE FUNCTION lore.portable_core_capabilities()` publishing `compatibleFrom` (`COALESCE(compatible_from, schema_revision)`) | Validating the SQL body takes ACCESS SHARE on `embedding_generations` and `lore_system_state` |
| 7 | `UPDATE lore_system_state SET schema_revision = 10, compatible_from = 9` | Row lock |

`memory_chunks` is locked before `lore_system_state`: a request write may hold `memory_chunks` for up to the 5 s timeout, and readiness reads `lore_system_state` under a 2 s statement timeout, so it must not wait behind that.

**Migration 0011 (`transaction:false`, one statement at a time via the existing runner `scripts/database/lib/migration-statements.ts:45`):**

| # | Statement | Lock | Blocks |
| --- | --- | --- | --- |
| 1 | `DROP INDEX CONCURRENTLY IF EXISTS memory_chunk_embeddings_chunk_idx`, then `CREATE INDEX CONCURRENTLY memory_chunk_embeddings_chunk_idx ON memory_chunk_embeddings (chunk_id)` | SHARE UPDATE EXCLUSIVE on `memory_chunk_embeddings`; waits for open transactions | No reads or writes |
| 2 | `DROP INDEX CONCURRENTLY IF EXISTS memories_metadata_gin_idx` | SHARE UPDATE EXCLUSIVE on `memories`; waits for open transactions | No reads or writes |
| 3 | `DROP INDEX CONCURRENTLY IF EXISTS memory_links_workspace_source_idx` | Same, on `memory_links` | No reads or writes |
| 4 | `UPDATE lore_system_state SET schema_revision = 11, compatible_from = 9` | Row lock | — |

Rerun safety: every create is preceded by a drop of its leftover, so an interrupted run replaces any `INVALID` index (the 0005 pattern). `memory_chunks_embedding_cosine_idx` needs no concurrent drop: it goes with its column in 0010.

- **Lock order.** 0010 takes only one exclusive lock that request traffic contends for, on `memory_chunks`, and never locks `memories`, so it can't form a lock cycle with request writes, which lock `memories` before `memory_chunks`.
- **Blocking and retry.** A write that already holds a `memory_chunks` lock delays 0010 by up to 5 s, and requests that arrive meanwhile queue behind it. If the timeout expires, nothing is recorded and the rerun repeats it.
- **Old instances keep working.** They never read the dropped columns (verified by search), so `compatible_from` stays 9.

**Composite FK: deferred.** It would add relational integrity: a vector's `memory_id` would have to match its chunk's Memory. That costs SHARE ROW EXCLUSIVE on both tables to add, a separate `VALIDATE`, and a pre-check for mismatched rows. The `chunk_id` index in 0011 fixes the cascade cost without blocking writes. Integrity becomes its own follow-up if wanted (question 2).

**PR 3 migrations** create functions and grants only, with no table locks. Each one raises `compatible_from` only if it removes something old instances call. It doesn't: `register_identity`, `is_active_member`, and `SET LOCAL ROLE` all remain.

## 7. PR 3 — SQL write functions (only if PR 1's numbers favor them)

### 7.1 Shape

- **Two kinds of functions:**
  - core `lore.memory_remember_in_scope`, `lore.memory_update_in_scope`, `lore.memory_forget_in_scope`, `lore.memory_link_connect_in_scope`;
  - oss `lore.memory_create_keyed`, `lore.memory_update_keyed`, `lore.memory_forget_keyed`, which wrap them with the idempotency ledger.
- **How they're called.** Each is called as the statement after the pipelined prefix (§4.3), in the same batch, so a write is 1 wait.
- **Rights.** The functions are `SECURITY INVOKER` and run as `lore_app` under RLS. There is no `lore.enter` hook and no grant to request logins, and the login reaches them only after the prefix switches role.
- **Admission inside the batch.** A non-member's write is rejected by RLS inside the function. The transaction aborts, and the prefix's membership result turns the response into the existing 403.
- **What stays in TypeScript and what moves.**
  - In TypeScript: validation, chunking, query embedding, fusion, and expansion.
  - In the functions: the control flow from today's write transaction. That is the claim/replay decision, the version check, the `IS DISTINCT FROM` no-op decision, the ordinal chunk diff, the job queueing, and the ledger completion.
- **Link connect keeps separate statements inside its function:** the source lock, the existing-Link read, the counts, and the insert. Each gets its own READ COMMITTED snapshot, as today (review finding 7).
- **The keyed write seam** (review finding 11):
  - Core prepares the write through `prepareMemoryWrite`, covering validation, chunks, and the embedding identity, and returns the arguments only. oss calls its `_keyed` function with them.
  - The function returns `{ replayed, outcome, body, jobIds }`, and oss passes `jobIds` to core's `notifyCommittedJobs`. Core never learns wrapper names or replay formats. oss never duplicates preparation or embedding mechanics.
  - **The ledger keeps everything it records today:**
    - the actor kind (`user`/`agent`);
    - operation names and request hashes;
    - the original request id on replay;
    - microsecond timestamps;
    - the legacy `response_status`;
    - the 0007 subject columns (`src/server/api/idempotency.ts:43, :107, :129, :183`).

    A test holds the body SQL builds equal to the body TypeScript builds.
- **Proposal acceptance and import** call the `_in_scope` functions inside their own transactions. Their notifications go through `afterCommit`.

### 7.2 Grants

| Role | Gets | Never gets |
| --- | --- | --- |
| request login(s), NOINHERIT | Membership in `lore_app`, as today | Any table privilege, or `EXECUTE` on any `lore` function, before it switches role |
| `lore_app` | As today, plus `EXECUTE` on the new write functions | Maintenance functions |
| `lore_maintenance` | As today | The new write functions |
| `PUBLIC` | Nothing in `lore` | `EXECUTE` on any `lore` function |

- **Revoke `PUBLIC` explicitly.** A schema-scoped `ALTER DEFAULT PRIVILEGES … IN SCHEMA` cannot remove the global default `EXECUTE` that `PUBLIC` gets on new functions (review probe), and default privileges belong to the function's creating role. So:
  - every migration that creates a function revokes `PUBLIC` explicitly and grants `lore_app` explicitly;
  - the migration role runs a global `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`.
- **A guard test enforces the "never" column on the full migration chain.** It also runs in PR 1, over today's functions.
- **SQLSTATE 42501** inside a write function is answered as 403, as today. When the matrix says it can't happen for a correctly deployed role, it is also logged as a deployment fault.

### 7.3 Canonical definitions and name resolution

Only the core functions PR 3 installs get canonical definitions:

- **Source of truth.** One `.sql` file per function under `packages/lore-core/sql/`.
- **Name resolution.** Every function declares `SET search_path` from a host-rendered trusted list with `pg_temp` last, so no function inherits the caller's path. Lore OSS uses `pg_catalog, public, lore, pg_temp`, and the independent-host fixture renders its alternate schema (`packages/lore-core/tests/independent-host.test.ts:111`).
- **What the contract compares.** For each function: `prosrc`, language, volatility, strictness, parallel safety, security mode, `proconfig` (including `search_path`), argument defaults, and the full input and output signature.
- **Dimensions are rendered from the host's `embeddingDimensions`.** That covers `vector(n)` casts, `generation.embedding_dimensions = n` (`memory.ts:593`), and maintenance's hard-coded 1024 (`0001_v1_baseline.sql:916, :934, :1123`).
  - The contract compares against the rendered text.
  - Tests cover the 8-dimension independent fixture and a 1536-dimension lifecycle.
- **The engine-source scanner** (`packages/lore-core/tests/schema-contract.test.ts:14`) extends to the `.sql` files.
- **The contract describes the core revision a host has adopted.** HaaS's fork doesn't fail until it adopts this wave.
- **Required tests:**
  - Calls by owner and superuser roles: invoker rights don't impose RLS on them, and only `lore_app` is a supported caller.
  - A failure inside a function, and a savepoint rollback.

## 8. Embedding mechanics that move into core

These are the parts of v1 and v2 that stay in the wave:

- **Job notification through `afterCommit`** (PR 1, §4.1).
- **Dimension validation.** oss stops duplicating core's check.
- **Readiness.** `embeddingGenerationServing(tx, identity)` replaces oss's direct `embedding_generations` SQL in readiness.

The maintenance runner, lease rule, and generation admin API are consolidated in a separate PR (§11).

## 9. Rollout

### 9.1 Order and compatibility

1. **PR 0** (app only), deployed everywhere as a release of its own. A revision-9 build without it requires exact equality and goes unready when 0010 commits, so 0010 must wait until no such build serves traffic (or run in a maintenance window).
2. **PR 1** (app only).
3. **PR 2:** migrate 0010 → 0011, then deploy. With PR 0 in place, old instances stay ready, because both migrations keep `compatible_from = 9`.
4. **PR 3:** migrate, then deploy.

Old and new instances are exercised against each migration in the chain, including a chain that stopped part-way. The test plan covers this (§10).

*As built:* the whole wave merges in one step, through #135. For a rolling multi-instance deployment:

1. Deploy commit `e7fb471` (PR 0, readiness only) everywhere.
2. Run `bun run db:migrate` from the merged release, and deploy it.

Otherwise, migrate in a maintenance window. Workers keep `LORE_POSTGRES_PIPELINE=0` until §9.2 passes.

### 9.2 Hyperdrive verification (in PR 1, before PR 3 is decided)

- Pipelined extended-protocol queries are correct through Hyperdrive, including error and abort behavior.
- One Worker client connection per request.
- The admission prefix (`set_config('role', …, true)` and settings computed from the admission function) behaves correctly under Hyperdrive's transaction pooling.
- Write latency for pipelined writes and for SQL write functions, measured on the same routes.

*As built:* **not done**; see §4.4.

### 9.3 HaaS

Manual port, per the distribution convention:

- the seam (`batch`, `setLocal`, `afterCommit`) in HaaS's own adapter, through `transactionHandle`;
- the write-path semantics;
- an admission prefix over HaaS's own identity functions;
- any canonical SQL it installs.

## 10. Test plan

**lore-core** (`packages/lore-core check`, minimal PGlite host):

- **Seam.** Covers `transactionHandle` over a fake sender and over PGlite:
  - settings and `BEGIN` go out with the first statement;
  - `batch` is pipelined, and the first error aborts the batch and is the one rethrown;
  - `afterCommit` runs in order, never on rollback, and survives an effect that throws.
- **Boundary check.** No database driver is imported under `packages/lore-core`.
- **Budgets.** Statements per engine operation are pinned.
- **Update semantics:**
  - no-op update, stale `If-Match`, empty PATCH;
  - scope-only update;
  - partial chunk reuse and tail delete.
- **Forget.** 404 versus 412.
- **Embedding claim:**
  - a partial claim;
  - an empty claim finishes without a provider call;
  - claim versus a concurrent update or scope change, fenced by version.
- **Notification.** At most 1,000 per transaction; none on rollback, and none for a no-op update.

**lore oss** (PGlite with the real migrations and roles):

- **API budgets.** Waits and statements per route and configuration, for human and Agent callers.
- **Admission prefix:**
  - A member's read returns rows. A non-member's read answers 403 with the batch's read empty.
  - An unknown or ungranted Agent token returns no prefix row and answers 403.
  - A non-member's write is rejected by RLS and answers 403.
- **Provider calls:**
  - An Agent's dense search makes zero planner or embedding calls before its prefix returns.
  - A human's search starts the prefix and the provider call concurrently; a non-member then gets 403.
  - A lexical-only search is one batch.
- **RLS suites** pass unchanged, and scope-change visibility holds at the Memory, chunk, vector, search, and Graph levels.
- **Events.** Forget emits an event for both inbound and outbound Links.
- **Agent throttle.** NULL `last_used_at`, an update older than 60 s, an update within 60 s that writes nothing, and a revoked credential.
- **Migrations:**
  - The chain applies from empty and from revision 9 with data, and an interrupted 0010 reruns cleanly.
  - Lock sets are asserted (pattern: `replay-subject-upgrade.test.ts`).
  - PR 0 readiness reports correctly for old and new app revisions across the chain.
- **Adapters:**
  - role per transaction, close and use-after-close, error-listener cleanup;
  - a pause longer than 10 s within a request still uses one client.
- **Grant guard (from PR 1):** no function in `lore` is executable by `PUBLIC`, by a login before its role switch, or by `lore_maintenance` where the matrix forbids it.
- **PR 3, if adopted:**
  - the search_path contract;
  - a failure and a savepoint rollback inside a function;
  - SQL and TypeScript ledger bodies are equal.

**Real PostgreSQL** (`smoke-memory-core`, CI `database` job). PGlite runs a single session, so it can't show these races:

- concurrent identity registration;
- keyed writes versus forget;
- concurrent same-key Link PUTs at full capacity;
- a partial embedding completion racing an update or scope change;
- migration locks against live traffic;
- old and new application and worker processes on one database.

Also on real PostgreSQL: both vector widths, a provider-backed search configuration, and the request login's grants (it can reach only what the matrix allows).

**Retrieval benchmark** (only if PR 3 moves search SQL; not planned). Metrics must be identical and latency within noise.

*As built — status of this plan:*

- **Done.** Each item is listed with the test that covers it:
  - core seam, boundary, and budgets: `packages/lore-core/tests/transaction-handle.test.ts`;
  - update semantics: `update-semantics.test.ts`;
  - forget 404 versus 412;
  - partial and empty claims, and the claim fenced by version (also in the real-PostgreSQL smoke race);
  - notifications: at most 1,000, none on rollback, none for a no-op update, and effects after a committed throw.
- **Done in OSS:**
  - API budgets per route and per search configuration, for humans and Agents;
  - the admission prefix: members, non-members, unknown and ungranted tokens, refused writes, and concurrent transactions of one request;
  - provider ordering: an Agent pays nothing before its admission;
  - RLS suites and scope-change visibility at every level;
  - forget events in both directions;
  - the Agent throttle;
  - migrations from empty and from revision 9 with data, 0010's lock set, and a stopped 0011 rerun;
  - readiness across compatible revisions;
  - adapters: role per transaction, close and use-after-close, the error listener, and ROLLBACK failure;
  - the grant guard (`tests/server/function-grants.test.ts`): the full grant map of all 75 `lore` functions is pinned (no `PUBLIC`; each one with `lore_app`, `lore_maintenance`, both, or only its owner), and a NOINHERIT login holds nothing before its role switch.
- **Done on real PostgreSQL** (smoke):
  - concurrent same-key Link PUTs;
  - Proposals versus forget;
  - an embedding completion racing chunk-reusing updates;
  - a provider-backed search that only the dense channel can satisfy;
  - a request pool kept across an idle pause past 10 seconds.
- **Differs.** A human's search starts its prefix after the provider call, not concurrently with it (§4.3a). The test asserts that order.
- **Not done:**
  - old and new application processes on one real database;
  - migration locks under live traffic;
  - both vector widths on real PostgreSQL;
  - everything that needs Hyperdrive (§9.2).

  The upgrade from revision 9 and the compatible-readiness tests on PGlite cover the first two in part.

## 11. Separate PRs, outside this wave

- **Embedding maintenance consolidation.**
  - `createEmbeddingMaintenance` (`run`, `sweep`, `pending`), which replaces the coordinator, lease, and prune wiring in both hosts.
  - `EmbeddingProvider.requestTimeoutMs?`, which replaces the `provider === "ollama"` lease branches.
  - `createEmbeddingGenerationAdmin` (`findReport`, `activate`, `requeueDeadJobs`) for the `db:embedding:*` scripts.

  The review advised keeping this out of the adapter move. *As built:* #137, stacked on the wave so that it merges with it.
- **Dependency upgrades other than `pg`/`pg-cloudflare`:**
  - patch and minor bumps: next, hono, wrangler 4.147 (regenerate `cloudflare-env.d.ts`, run the Cloudflare dry run), openai, @google/genai, MCP SDK, opennext;
  - major bumps, each evaluated alone: vitest 5, @types/node 26, es-module-lexer 3;
  - voyageai stays 0.1.0, per AGENTS.md.

  *As built:* #136, stacked on the wave, with patch and minor bumps only.
- **Composite FK** for vector→chunk integrity, if wanted.

## 12. Alternatives

| Alternative | Status |
| --- | --- |
| v1: trim statements, sequential awaits | Superseded. Pipelining gets the same statements to far fewer waits. |
| v2: every engine operation as a SQL function | Rejected as a blanket rule. Search needs admission before providers, and fusion, expansion, and the Graph fallback depend on TypeScript decisions. PR 3 keeps functions only for write control flow, and only if measured worthwhile. |
| A `lore.enter(ctx)` hook with `EXECUTE` granted to request logins (v2, early v3) | Superseded. The pipelined prefix gets the same single wait from functions `lore_app` already runs. No new grants, no exception to "a login has no privilege until it switches role". |
| A connection layer inside core | Rejected. Connection lifetime depends on the runtime, and RLS setup already puts the host in every call. Core's own factory caused today's per-transaction client. mem0 also keeps connections in the storage adapter. |
| One statement combining lock + existing-Link read | Rejected. It breaks per-statement snapshot semantics (review finding 7). Pipelining gets the same wait count. |
| Schema-scoped default privileges for revocation | Rejected. They can't remove `PUBLIC`'s global default (review probe). |
| Readiness unchanged, maintenance window per migration | Possible fallback. PR 0 removes the need. |
| Cache identity or membership | Rejected. It breaks immediate revocation. |
| Core-owned migrations | Rejected. It breaks host-owned migration chains, including HaaS's. |

## 13. Risks

- **Pipelining through Hyperdrive is unverified.** PR 1 measures it before anything depends on it. If it fails, the prefix costs its own wait, and SQL functions become the way to reach 1 wait.
- **Error handling in pipelined batches.** The first error is the one surfaced. Aborted-transaction errors from later statements are swallowed, but they can't be confused with success. Covered by tests.
- **Readiness range (PR 0).** A migration that sets `compatible_from` too low lets an incompatible old instance report ready. Each migration's `compatible_from` is reviewed together with its rolling-deploy test.
- **Non-members' work runs before they are rejected.** A non-member's read executes before the 403. RLS returns nothing, so no data leaks, but the database does the work.
- **Paid provider calls for human non-members.** A human non-member's search calls the provider before the 403. Their credential is verified by the app, so this costs money but leaks nothing.
- **PR 3** puts write control flow in plpgsql. It is harder to debug; canonical definitions, parity tests, and the grant guard mitigate that.
- **HaaS port size**, smaller than in v2.

## 14. Codex review (2026-10-04) and how v3 answers it

| # | Finding | v3 |
| --- | --- | --- |
| 1 | One-call search runs provider work before Agent authentication | Agents are admitted before any provider call. Humans, verified by the app, overlap admission with the provider call (§4.3, §5). *As built:* a human's prefix travels with the first pass after the provider call (§4.3a) |
| 2 | Grant recipe incomplete; schema default privileges can't revoke `PUBLIC` | No login grants needed at all. Explicit `PUBLIC` revokes and a guard test (§7.2) |
| 3 | Migrate-first makes old instances unready | PR 0 readiness range (§3) |
| 4 | `pg` 8.23 already pipelines | Pipelining is PR 1; reads reach 1 wait; writes are measured against SQL functions (§4.3, §4.4) |
| 5 | Search fusion and expansion are TypeScript; feedback needs visible ids | Stay in TypeScript; budgets reflect them (§5) |
| 6 | Graph fallback needs version checks | Kept (§4.3) |
| 7 | Combined lock + read breaks Link concurrency | Separate statements, pipelined (§4.3). *As built:* the lock and the read stay separate; the counts and the insert are one CTE |
| 8 | Hook order, single row, settings overwrite, search_path | Hook dropped. The prefix sets every setting from the admission function's single result. The search_path contract applies to canonical functions (§4.3, §7.3) |
| 9 | Lock analysis must be in the spec; compare with a plain `chunk_id` index | Written out; plain index chosen, FK deferred (§6.5) |
| 10 | Dimensions beyond vector casts | Rendered definitions (§7.3) |
| 11 | Keyed-write seam undefined | Specified for PR 3 (§7.1) |
| 12 | Pool idle eviction, error listener, Hyperdrive backend semantics | Request pool settings and tests (§4.2) |
| 13 | Budgets: fixtures, formulas, waits versus statements | §1 and §5 |
| 14 | Definition equality attributes; scanner | §7.3 |

Verified by the review and not re-litigated:

- the invoker role switch and FOR UPDATE under RLS;
- role and settings reset after autocommit;
- the per-transaction Workers client;
- the SDK's generated keys;
- the chunk-replacement findings;
- partial-claim compatibility with old workers;
- the GIN index being unusable under RLS;
- `EXECUTE … USING` replanning;
- host-owned connections fitting Lore's boundary;
- canonical SQL with migration copies being workable.

## 15. Questions for the reviewer

*Resolved 2026-10-04:* PR 0 first; a plain `chunk_id` index, with the composite FK deferred; a no-op PATCH keeps its version and ETag; a fixed 60-second throttle on `last_used_at`. The questions are kept below as they were asked.

1. **PR 0 first?**
   - It changes readiness so a migration can declare which older app revisions it stays compatible with. Old instances then stay ready through compatible migrations.
   - The alternative is a maintenance window for PR 2's and PR 3's migrations, as `docs/operations.md` did for 0007–0009.
   - *Recommendation: PR 0.*
2. **Cascade fix.**
   - The plan is a plain concurrent index on `memory_chunk_embeddings (chunk_id)`. It never blocks writes.
   - The composite FK would additionally guarantee a vector's Memory matches its chunk's, but it needs locks that briefly block writes, plus a validation step.
   - *Recommendation: plain index now; the FK only if integrity is wanted as its own goal.*
3. **Settled from v2, unless you object:**
   - a no-op PATCH keeps the version and ETag;
   - a fixed 60 s throttle on `last_used_at`;
   - `extract_entity_aliases` joins the definition check if PR 3 installs canonical SQL. The review adds that a semantic change to it needs a data migration, because stored generated values aren't recomputed.
   - No `lore_api` schema is needed any more: PR 3's functions live in `lore` and run as `lore_app`.
