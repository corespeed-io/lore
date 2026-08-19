import type { ActorContext } from "./actor-context";
import type { PostgresTransaction } from "./db";

export interface IdempotencyRequest {
  key: string;
  operation: string;
  requestHash: string;
}

interface IdempotencyRow {
  id: string;
  request_sha256: string;
  status: "in_progress" | "completed";
  response_status: number | null;
  response_body: unknown;
  expires_at: string;
}

export interface MutationClaim<Result> {
  requestId: string;
  replay?: {
    body: Result;
    status: number;
  };
}

export class IdempotencyConflictError extends Error {
  override name = "IdempotencyConflictError";
  readonly status = 409;
}

function actorIdentity(actor: ActorContext): { id: string; kind: "agent" | "user" } {
  return actor.agentId ? { id: actor.agentId, kind: "agent" } : { id: actor.userId, kind: "user" };
}

async function installRequestId(
  transaction: PostgresTransaction,
  requestId: string,
): Promise<void> {
  await transaction.query("SELECT set_config('lore.request_id', $1, true)", [requestId]);
}

export async function beginMutation<Result>(
  transaction: PostgresTransaction,
  actor: ActorContext,
  request?: IdempotencyRequest,
): Promise<MutationClaim<Result>> {
  if (!request) {
    const requestId = crypto.randomUUID();
    await installRequestId(transaction, requestId);
    return { requestId };
  }

  const identity = actorIdentity(actor);
  const requestId = crypto.randomUUID();
  const inserted = await transaction.query<{ id: string }>(
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
  );
  if (inserted.rows[0]) {
    await installRequestId(transaction, requestId);
    return { requestId };
  }

  const existing = await transaction.query<IdempotencyRow>(
    `SELECT id, request_sha256, status, response_status, response_body, expires_at
     FROM request_idempotency_records
     WHERE workspace_id = $1
       AND actor_kind = $2
       AND actor_id = $3
       AND operation = $4
       AND idempotency_key = $5
     FOR UPDATE`,
    [actor.workspaceId, identity.kind, identity.id, request.operation, request.key],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Idempotency record became unavailable");

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await transaction.query(
      `UPDATE request_idempotency_records
       SET request_sha256 = $2,
           status = 'in_progress',
           response_status = NULL,
           response_body = NULL,
           completed_at = NULL,
           created_at = now(),
           expires_at = now() + interval '24 hours'
       WHERE id = $1`,
      [row.id, request.requestHash],
    );
    await installRequestId(transaction, row.id);
    return { requestId: row.id };
  }

  if (row.request_sha256 !== request.requestHash) {
    throw new IdempotencyConflictError(
      "Idempotency-Key was already used with a different request payload",
    );
  }
  if (row.status !== "completed" || row.response_status === null) {
    throw new Error("Idempotent mutation did not reach a terminal state");
  }
  await installRequestId(transaction, row.id);
  return {
    requestId: row.id,
    replay: { body: row.response_body as Result, status: row.response_status },
  };
}

export async function completeMutation(
  transaction: PostgresTransaction,
  requestId: string,
  status: number,
  body: unknown,
  idempotent: boolean,
): Promise<void> {
  if (!idempotent) return;
  const completed = await transaction.query<{ id: string }>(
    `UPDATE request_idempotency_records
     SET status = 'completed',
         response_status = $2,
         response_body = $3::jsonb,
         completed_at = now()
     WHERE id = $1
       AND status = 'in_progress'
     RETURNING id`,
    [requestId, status, JSON.stringify(body)],
  );
  if (!completed.rows[0]) throw new Error("Idempotency record completion failed");
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
