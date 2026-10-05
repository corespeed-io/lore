import { type PostgresStatement, type PostgresTransaction, statement } from "@corespeed/lore-core";
import { DomainError } from "@/server/errors";

export interface IdempotencyRequest {
  key: string;
  operation: string;
  requestHash: string;
}

interface IdempotencyRow {
  id: string;
  request_sha256: string;
  status: "in_progress" | "completed";
  response_body: unknown;
  expires_at: string;
}

export interface MutationClaim<Result> {
  requestId: string;
  /** The stored result of the first attempt; the route derives its response from it. */
  replay?: Result;
}

/** What a completed mutation did, in domain terms. Routes choose the HTTP status. */
export type MutationOutcome = "created" | "ok" | "deleted" | "not_found";

/**
 * The ledger's `response_status` column, which replay no longer reads. App
 * instances from before schema revision 7 still require it on every completed row
 * they replay, so it is written until the release that drops it.
 */
const LEGACY_RESPONSE_STATUS: Readonly<Record<MutationOutcome, number>> = {
  created: 201,
  ok: 200,
  deleted: 204,
  not_found: 404,
};

export class IdempotencyConflictError extends DomainError {
  override name = "IdempotencyConflictError";
  readonly code = "idempotency_conflict";
}

/** The ledger's actor columns, read from the Actor bound to the transaction. */
const ACTOR_KIND_SQL = "CASE WHEN lore.current_agent_id() IS NULL THEN 'user' ELSE 'agent' END";
const ACTOR_ID_SQL = "COALESCE(lore.current_agent_id(), lore.current_user_id())";

/** The request id travels with the transaction's next statement; no round trip of its own. */
function installRequestId(transaction: PostgresTransaction, requestId: string): void {
  transaction.setLocal({ "lore.request_id": requestId });
}

/**
 * Claim `request`'s key for this transaction, or find the stored result of the
 * attempt that holds it. The ledger's Workspace and actor columns come from the
 * Actor bound to the transaction (`lore.current_*`), not from parameters, so the
 * claim can travel in the same round trip as a pending Actor's admission: it is
 * sent when this is called, before its result is awaited.
 */
export async function beginMutation<Result>(
  transaction: PostgresTransaction,
  request?: IdempotencyRequest,
): Promise<MutationClaim<Result>> {
  // A fresh id is the request id unless an expired key is reclaimed or replayed.
  const requestId = crypto.randomUUID();
  installRequestId(transaction, requestId);
  if (!request) return { requestId };

  // The claim and the lookup share one round trip. The lookup runs after the
  // insert, so it finds this request's own row when the insert claimed the key,
  // and otherwise the row that holds it, locked until this transaction ends.
  const [inserted, existing] = await transaction.batch([
    statement<{ id: string }>(
      `INSERT INTO request_idempotency_records (
         id, workspace_id, actor_user_id, actor_kind, actor_id,
         operation, idempotency_key, request_sha256
       ) VALUES (
         $1, lore.current_workspace_id(), lore.current_user_id(), ${ACTOR_KIND_SQL},
         ${ACTOR_ID_SQL}, $2, $3, $4
       )
       ON CONFLICT (workspace_id, actor_kind, actor_id, operation, idempotency_key)
         DO NOTHING
       RETURNING id`,
      [requestId, request.operation, request.key, request.requestHash],
    ),
    statement<IdempotencyRow>(
      `SELECT id, request_sha256, status, response_body, expires_at
       FROM request_idempotency_records
       WHERE workspace_id = lore.current_workspace_id()
         AND actor_kind = ${ACTOR_KIND_SQL}
         AND actor_id = ${ACTOR_ID_SQL}
         AND operation = $1
         AND idempotency_key = $2
       FOR UPDATE`,
      [request.operation, request.key],
    ),
  ]);
  if (inserted.rows[0]) return { requestId };

  const row = existing.rows[0];
  if (!row) throw new Error("Idempotency record became unavailable");

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await transaction.query(
      `UPDATE request_idempotency_records
       SET request_sha256 = $2,
           status = 'in_progress',
           response_status = NULL,
           response_body = NULL,
           subject_memory_id = NULL,
           subject_proposal_id = NULL,
           proposal_target_memory_id = NULL,
           proposal_accepted_memory_id = NULL,
           subject_episode_id = NULL,
           completed_at = NULL,
           created_at = now(),
           expires_at = now() + interval '24 hours'
       WHERE id = $1`,
      [row.id, request.requestHash],
    );
    installRequestId(transaction, row.id);
    return { requestId: row.id };
  }

  if (row.request_sha256 !== request.requestHash) {
    throw new IdempotencyConflictError(
      "Idempotency-Key was already used with a different request payload",
    );
  }
  if (row.status !== "completed" || row.response_body === null) {
    throw new Error("Idempotent mutation did not reach a terminal state");
  }
  installRequestId(transaction, row.id);
  return { requestId: row.id, replay: row.response_body as Result };
}

/**
 * Every replay body a mutation may store. A body that carries canonical content is
 * deleted when its subject is forgotten. `completeMutation` records each subject in
 * its own column, and 0009's triggers scrub by those columns. Until the release that
 * retires them, the baseline triggers also scrub by these JSON paths
 * (`{memory,id}`, `{proposal,id}`, `{proposal,targetMemoryId}`,
 * `{proposal,acceptedMemoryId}`, `{episode,id}`), which is what finds rows older app
 * instances write, so the key names stay a storage contract until then. A new
 * content-carrying body needs a subject column. tests/server/replay-scrub.test.ts
 * proves the scrub end to end.
 */
export type ReplayBody =
  | { memory: { id: string } | null }
  | {
      proposal: {
        id: string;
        targetMemoryId: string | null;
        acceptedMemoryId: string | null;
      };
    }
  | { episode: { id: string } }
  | { deleted: boolean };

/**
 * The subjects whose deletion must scrub a stored body, one column each. Only
 * submission replays a Proposal, so its `acceptedMemoryId` is null today; the column
 * mirrors the JSON path so a replayed body that names one needs no migration.
 */
function replaySubjects(body: ReplayBody): (string | null)[] {
  const memory = "memory" in body ? (body.memory?.id ?? null) : null;
  const proposal = "proposal" in body ? body.proposal : null;
  const episode = "episode" in body ? body.episode.id : null;
  return [
    memory,
    proposal?.id ?? null,
    proposal?.targetMemoryId ?? null,
    proposal?.acceptedMemoryId ?? null,
    episode,
  ];
}

/** Binds a parameter while a statement's SQL is composed, returning its placeholder. */
export type SqlParameter = (value: unknown) => string;

/**
 * A response body PostgreSQL builds as the completion runs, so the completion can
 * travel in the same batch as the write whose row it describes. `sql` composes a
 * jsonb expression, binding its parameters through `p`; `subjects` names what the
 * body describes, for the scrub columns.
 */
export interface SqlReplayBody {
  sql: (p: SqlParameter) => string;
  subjects: ReplayBody;
}

/** One way a mutation may end, as its ledger row records it. */
export interface MutationCompletion {
  outcome: MutationOutcome;
  body: ReplayBody | SqlReplayBody;
}

function composed(build: (p: SqlParameter) => string): PostgresStatement<{ id: string | null }> {
  const params: unknown[] = [];
  const sql = build((value) => {
    params.push(value);
    return `$${params.length}`;
  });
  return statement<{ id: string | null }>(sql, params);
}

/** The ledger update that completes the row, held to `condition` when there is one. */
function completedRow(
  p: SqlParameter,
  requestId: string,
  { outcome, body }: MutationCompletion,
  condition?: string,
): string {
  const built = "sql" in body ? body : null;
  const [memory, proposal, target, accepted, episode] = replaySubjects(
    built ? built.subjects : (body as ReplayBody),
  );
  return `completed AS (
       UPDATE request_idempotency_records
       SET status = 'completed',
           response_status = ${p(LEGACY_RESPONSE_STATUS[outcome])},
           response_body = ${built ? built.sql(p) : `${p(JSON.stringify(body))}::jsonb`},
           subject_memory_id = ${p(memory)},
           subject_proposal_id = ${p(proposal)},
           proposal_target_memory_id = ${p(target)},
           proposal_accepted_memory_id = ${p(accepted)},
           subject_episode_id = ${p(episode)},
           completed_at = now()
       WHERE id = ${p(requestId)}
         AND status = 'in_progress'${condition ? `\n         AND (${condition})` : ""}
       RETURNING id
     )`;
}

/**
 * The statement that completes this request's ledger row. COMMIT may travel behind
 * it, so its guard fails inside the statement: a row this request no longer holds
 * raises (22012), and the transaction ends in ROLLBACK instead of committing a key
 * stuck in progress.
 */
export function completionStatement(
  requestId: string,
  outcome: MutationOutcome,
  body: ReplayBody | SqlReplayBody,
): PostgresStatement<{ id: string | null }> {
  return composed(
    (p) => `WITH ${completedRow(p, requestId, { outcome, body })}
     SELECT (SELECT id FROM completed) AS id,
            1 / (SELECT count(*) FROM completed)::integer AS guard`,
  );
}

/**
 * Two statements that complete this request's ledger row as `applied` when
 * `condition` holds once the write ran, and as `otherwise` when it does not, for a
 * write sent in the same batch that may match no row. Exactly one completes it;
 * the second's guard raises (22012) when neither did, as `completionStatement`'s.
 */
export function conditionalCompletionStatements(
  requestId: string,
  condition: (p: SqlParameter) => string,
  applied: MutationCompletion,
  otherwise: MutationCompletion,
): PostgresStatement<{ id: string | null }>[] {
  return [
    composed(
      (p) => `WITH ${completedRow(p, requestId, applied, condition(p))}
     SELECT (SELECT id FROM completed) AS id`,
    ),
    composed(
      (p) => `WITH ${completedRow(p, requestId, otherwise, `NOT (${condition(p)})`)}
     SELECT (SELECT id FROM completed) AS id,
            1 / (
              (SELECT count(*) FROM completed)
              + (SELECT count(*) FROM request_idempotency_records
                 WHERE id = ${p(requestId)} AND status = 'completed')
            )::integer AS guard`,
    ),
  ];
}

export async function completeMutation(
  transaction: PostgresTransaction,
  requestId: string,
  outcome: MutationOutcome,
  body: ReplayBody,
  idempotent: boolean,
  options: { commit?: boolean } = {},
): Promise<void> {
  if (!idempotent) return;
  const [completed] = await transaction.batch([completionStatement(requestId, outcome, body)], {
    commit: options.commit === true,
  });
  if (!completed.rows[0]?.id) throw new Error("Idempotency record completion failed");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export async function mutationRequestHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
