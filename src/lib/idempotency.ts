import { sql } from "drizzle-orm";
import type { ActorContext } from "./actor-context";
import type { LoreTransaction } from "./db";

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

async function installRequestId(transaction: LoreTransaction, requestId: string): Promise<void> {
  await transaction.execute(sql`SELECT set_config('lore.request_id', ${requestId}, true)`);
}

export async function beginMutation<Result>(
  transaction: LoreTransaction,
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
  const inserted = await transaction.execute<{ id: string }>(
    sql`INSERT INTO request_idempotency_records (
       id, workspace_id, actor_user_id, actor_kind, actor_id,
       operation, idempotency_key, request_sha256
     ) VALUES (
       ${requestId}, ${actor.workspaceId}, ${actor.userId}, ${identity.kind},
       ${identity.id}, ${request.operation}, ${request.key}, ${request.requestHash}
     )
     ON CONFLICT (workspace_id, actor_kind, actor_id, operation, idempotency_key)
       DO NOTHING
     RETURNING id`,
  );
  if (inserted.rows[0]) {
    await installRequestId(transaction, requestId);
    return { requestId };
  }

  const existing = await transaction.execute<IdempotencyRow>(
    sql`SELECT id, request_sha256, status, response_status, response_body, expires_at
     FROM request_idempotency_records
     WHERE workspace_id = ${actor.workspaceId}
       AND actor_kind = ${identity.kind}
       AND actor_id = ${identity.id}
       AND operation = ${request.operation}
       AND idempotency_key = ${request.key}
     FOR UPDATE`,
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Idempotency record became unavailable");

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await transaction.execute(
      sql`UPDATE request_idempotency_records
       SET request_sha256 = ${request.requestHash},
           status = 'in_progress',
           response_status = NULL,
           response_body = NULL,
           completed_at = NULL,
           created_at = now(),
           expires_at = now() + interval '24 hours'
       WHERE id = ${row.id}`,
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
  transaction: LoreTransaction,
  requestId: string,
  status: number,
  body: unknown,
  idempotent: boolean,
): Promise<void> {
  if (!idempotent) return;
  const completed = await transaction.execute<{ id: string }>(
    sql`UPDATE request_idempotency_records
     SET status = 'completed',
         response_status = ${status},
         response_body = ${JSON.stringify(body)}::jsonb,
         completed_at = now()
     WHERE id = ${requestId}
       AND status = 'in_progress'
     RETURNING id`,
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
