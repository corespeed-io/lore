import { type PostgresTransaction, statement } from "@corespeed/lore-core";
import type { ActorContext } from "@/server/auth/actor-context";
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

function actorIdentity(actor: ActorContext): { id: string; kind: "agent" | "user" } {
  return actor.agentId ? { id: actor.agentId, kind: "agent" } : { id: actor.userId, kind: "user" };
}

/** The request id travels with the transaction's next statement; no round trip of its own. */
function installRequestId(transaction: PostgresTransaction, requestId: string): void {
  transaction.setLocal({ "lore.request_id": requestId });
}

export async function beginMutation<Result>(
  transaction: PostgresTransaction,
  actor: ActorContext,
  request?: IdempotencyRequest,
): Promise<MutationClaim<Result>> {
  // A fresh id is the request id unless an expired key is reclaimed or replayed.
  const requestId = crypto.randomUUID();
  installRequestId(transaction, requestId);
  if (!request) return { requestId };

  const identity = actorIdentity(actor);
  // The claim and the lookup share one round trip. The lookup runs after the
  // insert, so it finds this request's own row when the insert claimed the key,
  // and otherwise the row that holds it, locked until this transaction ends.
  const [inserted, existing] = await transaction.batch([
    statement<{ id: string }>(
      `INSERT INTO request_idempotency_records (
         id, workspace_id, actor_user_id, actor_kind, actor_id,
         operation, idempotency_key, request_sha256
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (workspace_id, actor_kind, actor_id, operation, idempotency_key)
         DO NOTHING
       RETURNING id`,
      [
        requestId,
        actor.workspaceId,
        actor.userId,
        identity.kind,
        identity.id,
        request.operation,
        request.key,
        request.requestHash,
      ],
    ),
    statement<IdempotencyRow>(
      `SELECT id, request_sha256, status, response_body, expires_at
       FROM request_idempotency_records
       WHERE workspace_id = $1
         AND actor_kind = $2
         AND actor_id = $3
         AND operation = $4
         AND idempotency_key = $5
       FOR UPDATE`,
      [actor.workspaceId, identity.kind, identity.id, request.operation, request.key],
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

export async function completeMutation(
  transaction: PostgresTransaction,
  requestId: string,
  outcome: MutationOutcome,
  body: ReplayBody,
  idempotent: boolean,
  options: { commit?: boolean } = {},
): Promise<void> {
  if (!idempotent) return;
  // With `commit`, COMMIT travels with the completion, so the guard must fail inside
  // the statement: a ledger row this request no longer holds raises (22012) and the
  // transaction ends in ROLLBACK instead of committing a key stuck in progress.
  const [completed] = await transaction.batch(
    [
      statement<{ id: string | null }>(
        `WITH completed AS (
           UPDATE request_idempotency_records
           SET status = 'completed',
               response_status = $2,
               response_body = $3::jsonb,
               subject_memory_id = $4,
               subject_proposal_id = $5,
               proposal_target_memory_id = $6,
               proposal_accepted_memory_id = $7,
               subject_episode_id = $8,
               completed_at = now()
           WHERE id = $1
             AND status = 'in_progress'
           RETURNING id
         )
         SELECT (SELECT id FROM completed) AS id,
                1 / (SELECT count(*) FROM completed)::integer AS guard`,
        [requestId, LEGACY_RESPONSE_STATUS[outcome], JSON.stringify(body), ...replaySubjects(body)],
      ),
    ],
    { commit: options.commit === true },
  );
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
