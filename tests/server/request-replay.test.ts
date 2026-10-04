import { afterEach, expect, test } from "vitest";
import { createMemoryModule } from "@/modules/memories/service";
import { createApi } from "@/server/api/app";
import { beginMutation, mutationRequestHash } from "@/server/api/idempotency";
import { installActorContext } from "@/server/auth/actor-context";
import { createMemoryTestContext, type MemoryTestContext } from "../support/memory-context";

/**
 * A replay answers from the stored body of the first attempt. Services record what
 * a mutation did as an outcome, and routes derive the HTTP status from the replayed
 * body; the ledger's `response_status` is written only for app instances from
 * before schema revision 7, which still require it, and replay never reads it.
 */

afterEach(() => {
  for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT"]) {
    delete process.env[key];
  }
});

interface LedgerRow {
  id: string;
  status: string;
  response_status: number | null;
  response_body: unknown;
  expires_at: string;
  subject_memory_id: string | null;
  subject_proposal_id: string | null;
  proposal_target_memory_id: string | null;
  proposal_accepted_memory_id: string | null;
  subject_episode_id: string | null;
}

const LEDGER_COLUMNS = `id, status, response_status, response_body, expires_at,
  subject_memory_id, subject_proposal_id, proposal_target_memory_id,
  proposal_accepted_memory_id, subject_episode_id`;

async function ledger(testContext: MemoryTestContext, key: string): Promise<LedgerRow[]> {
  return testContext.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<LedgerRow>(
      `SELECT ${LEDGER_COLUMNS} FROM request_idempotency_records WHERE idempotency_key = $1`,
      [key],
    );
    return result.rows;
  });
}

const NO_SUBJECTS = {
  subject_memory_id: null,
  subject_proposal_id: null,
  proposal_target_memory_id: null,
  proposal_accepted_memory_id: null,
  subject_episode_id: null,
};

test("a key reused after its record expires forgets the earlier subjects and completes anew", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const operation = "memory.create";
  const key = "reused-after-expiry";
  const request = async (content: string) => ({
    idempotency: {
      key,
      operation,
      requestHash: await mutationRequestHash({ operation, payload: { content } }),
    },
  });

  const firstContent = "The first use of this key.";
  const first = await memories.remember(
    testContext.alice,
    { content: firstContent },
    await request(firstContent),
  );
  const [firstRecord] = await ledger(testContext, key);
  if (!firstRecord) throw new Error("The first use recorded no replay row");
  expect(firstRecord).toMatchObject({
    status: "completed",
    response_status: 201,
    ...NO_SUBJECTS,
    subject_memory_id: first.id,
  });
  // Expire the record, and give it every subject a replayed body can name, so the
  // reset has something to clear in each column.
  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE request_idempotency_records
       SET expires_at = now() - interval '1 second',
           subject_proposal_id = $1, proposal_target_memory_id = $1,
           proposal_accepted_memory_id = $1, subject_episode_id = $1
       WHERE id = $2`,
      [first.id, firstRecord.id],
    ),
  );

  // The claim itself, inspected before anything completes it: the same row, back in
  // progress, holding nothing from the first use.
  const secondContent = "The second use of this key, after it expired.";
  const inspected = new Error("roll back the inspected claim");
  await expect(
    testContext.database.transaction(async (transaction) => {
      installActorContext(transaction, testContext.alice);
      const claim = await beginMutation(transaction, (await request(secondContent)).idempotency);
      expect(claim).toEqual({ requestId: firstRecord.id });
      const reset = await transaction.query<Omit<LedgerRow, "id" | "expires_at">>(
        `SELECT status, response_status, response_body, subject_memory_id,
                subject_proposal_id, proposal_target_memory_id,
                proposal_accepted_memory_id, subject_episode_id
         FROM request_idempotency_records WHERE id = $1`,
        [claim.requestId],
      );
      expect(reset.rows).toEqual([
        { status: "in_progress", response_status: null, response_body: null, ...NO_SUBJECTS },
      ]);
      throw inspected;
    }),
  ).rejects.toBe(inspected);

  // A different payload is a new mutation once the key has expired, not a conflict.
  const second = await memories.remember(
    testContext.alice,
    { content: secondContent },
    await request(secondContent),
  );
  expect(second.id).not.toBe(first.id);
  expect(second.content).toBe(secondContent);
  const [secondRecord] = await ledger(testContext, key);
  expect(secondRecord).toMatchObject({
    id: firstRecord.id,
    status: "completed",
    response_status: 201,
    response_body: { memory: { id: second.id } },
    ...NO_SUBJECTS,
    subject_memory_id: second.id,
  });
  expect(new Date(secondRecord?.expires_at ?? 0).getTime()).toBeGreaterThan(Date.now());
  await expect(
    memories.remember(testContext.alice, { content: secondContent }, await request(secondContent)),
  ).resolves.toEqual(second);

  // The row now carries only the second Memory, so only forgetting that one scrubs it.
  await expect(memories.forget(testContext.alice, first.id)).resolves.toBe(true);
  expect(await ledger(testContext, key)).toHaveLength(1);
  await expect(memories.forget(testContext.alice, second.id)).resolves.toBe(true);
  expect(await ledger(testContext, key)).toEqual([]);
});

test("each replayed outcome answers with its first status, whatever response_status holds", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "replay-outcomes";
  const testContext = await createMemoryTestContext();
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });
  const workspace = (await (
    await app.request(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Replay Outcomes" }),
      }),
    )
  ).json()) as { id: string };
  function send(path: string, init: RequestInit & { key: string }) {
    const { key, headers, ...rest } = init;
    return app.request(
      new Request(`http://lore.local${path}`, {
        ...rest,
        headers: { "x-lore-workspace-id": workspace.id, "idempotency-key": key, ...headers },
      }),
    );
  }
  /**
   * Send one request twice under its key. Between the attempts the stored status is
   * replaced by one no route answers, so the replay's status can only come from the
   * stored body. Returns the status the first attempt recorded for older instances.
   */
  async function twice(path: string, init: RequestInit & { key: string }) {
    const first = await send(path, init);
    const [record] = await ledger(testContext, init.key);
    await testContext.adminDatabase.transaction((transaction) =>
      transaction.query(
        "UPDATE request_idempotency_records SET response_status = 599 WHERE idempotency_key = $1",
        [init.key],
      ),
    );
    const replay = await send(path, init);
    return { first, replay, legacyStatus: record?.response_status };
  }
  const missingId = "30000000-0000-4000-8000-0000000000ff";

  const created = await twice("/api/v1/memories", {
    method: "POST",
    key: "outcome-created",
    body: JSON.stringify({ content: "Replay outcome canary." }),
  });
  expect([created.first.status, created.replay.status, created.legacyStatus]).toEqual([
    201, 201, 201,
  ]);
  const memory = (await created.first.json()) as { id: string };
  await expect(created.replay.json()).resolves.toEqual(memory);

  // Run again, this update would be stale (412); the replay answers as the first did.
  const updated = await twice(`/api/v1/memories/${memory.id}`, {
    method: "PATCH",
    key: "outcome-ok",
    headers: { "if-match": '"memory-v1"' },
    body: JSON.stringify({ content: "Replay outcome canary, revised." }),
  });
  expect([updated.first.status, updated.replay.status, updated.legacyStatus]).toEqual([
    200, 200, 200,
  ]);
  expect(updated.replay.headers.get("etag")).toBe('"memory-v2"');
  await expect(updated.replay.json()).resolves.toEqual(await updated.first.json());

  const missingUpdate = await twice(`/api/v1/memories/${missingId}`, {
    method: "PATCH",
    key: "outcome-update-not-found",
    headers: { "if-match": '"memory-v1"' },
    body: JSON.stringify({ content: "No such Memory." }),
  });
  expect([
    missingUpdate.first.status,
    missingUpdate.replay.status,
    missingUpdate.legacyStatus,
  ]).toEqual([404, 404, 404]);

  // Run again, this delete would find nothing (404); the replay answers as the first did.
  const deleted = await twice(`/api/v1/memories/${memory.id}`, {
    method: "DELETE",
    key: "outcome-deleted",
    headers: { "if-match": '"memory-v2"' },
  });
  expect([deleted.first.status, deleted.replay.status, deleted.legacyStatus]).toEqual([
    204, 204, 204,
  ]);

  const missingDelete = await twice(`/api/v1/memories/${missingId}`, {
    method: "DELETE",
    key: "outcome-delete-not-found",
    headers: { "if-match": '"memory-v1"' },
  });
  expect([
    missingDelete.first.status,
    missingDelete.replay.status,
    missingDelete.legacyStatus,
  ]).toEqual([404, 404, 404]);

  const episode = (await (
    await send("/api/v1/episodes", {
      method: "POST",
      key: "outcome-episode-record",
      body: JSON.stringify({
        kind: "conversation",
        observations: [{ kind: "message", content: "Replay outcome observation." }],
      }),
    })
  ).json()) as { id: string };
  const forgotten = await twice(`/api/v1/episodes/${episode.id}`, {
    method: "DELETE",
    key: "outcome-episode-deleted",
  });
  expect([forgotten.first.status, forgotten.replay.status, forgotten.legacyStatus]).toEqual([
    204, 204, 204,
  ]);
  const missingEpisode = await twice(`/api/v1/episodes/${missingId}`, {
    method: "DELETE",
    key: "outcome-episode-not-found",
  });
  expect([
    missingEpisode.first.status,
    missingEpisode.replay.status,
    missingEpisode.legacyStatus,
  ]).toEqual([404, 404, 404]);
}, 60_000);
