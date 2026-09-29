import { afterEach, expect, test } from "vitest";
import { createMemoryModule } from "@/modules/memories/service";
import { createApi } from "@/server/api/app";
import { createMemoryTestContext, type MemoryTestContext } from "../support/memory-context";

/**
 * Forgetting a Memory, Proposal, or Episode deletes the request-replay bodies that
 * carry its content. Two mechanisms do it until the second replay-scrub release:
 * 0009's triggers match the subject columns `completeMutation` writes, and the
 * baseline triggers match JSON paths (`{memory,id}`, `{proposal,id}`,
 * `{proposal,targetMemoryId}`, `{proposal,acceptedMemoryId}`, `{episode,id}`), which
 * is what finds a row an older app instance wrote without the columns. Each case
 * runs once per mechanism with the other one disabled, and proves no replay body
 * retains the content without querying by either.
 */

afterEach(() => {
  for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT"]) {
    delete process.env[key];
  }
});

async function setup(subject: string) {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = subject;
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
        body: JSON.stringify({ name: "Replay Lab" }),
      }),
    )
  ).json()) as { id: string };
  async function send(path: string, init: RequestInit & { key?: string } = {}) {
    const { key, headers, ...rest } = init;
    return app.request(
      new Request(`http://lore.local${path}`, {
        ...rest,
        headers: {
          "x-lore-workspace-id": workspace.id,
          ...(key ? { "idempotency-key": key } : {}),
          ...headers,
        },
      }),
    );
  }
  return { testContext, send };
}

async function replayBodiesContaining(testContext: MemoryTestContext, text: string) {
  return testContext.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM request_idempotency_records WHERE strpos(response_body::text, $1) > 0",
      [text],
    );
    return result.rows[0]?.count;
  });
}

/** The subject columns `completeMutation` wrote for one keyed request. */
async function subjectColumns(testContext: MemoryTestContext, key: string) {
  return testContext.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<Record<string, string | null>>(
      `SELECT subject_memory_id, subject_proposal_id, proposal_target_memory_id,
              proposal_accepted_memory_id, subject_episode_id
       FROM request_idempotency_records WHERE idempotency_key = $1`,
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

type Scrub = "subject columns" | "JSON paths";
const SCRUBS: Scrub[] = ["subject columns", "JSON paths"];

/** Leave only one scrub able to find the stored replay bodies. */
async function onlyScrubBy(testContext: MemoryTestContext, scrub: Scrub) {
  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query(
      scrub === "subject columns"
        ? // Every JSON path now misses, but the content is still in the body.
          "UPDATE request_idempotency_records SET response_body = jsonb_build_object('moved', response_body) WHERE response_body IS NOT NULL"
        : // What an app instance from before schema revision 7 writes.
          `UPDATE request_idempotency_records
           SET subject_memory_id = NULL, subject_proposal_id = NULL,
               proposal_target_memory_id = NULL, proposal_accepted_memory_id = NULL,
               subject_episode_id = NULL`,
    ),
  );
}

async function replayKeyPresent(testContext: MemoryTestContext, path: [string, string]) {
  return testContext.adminDatabase.transaction(async (transaction) => {
    const result = await transaction.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM request_idempotency_records WHERE response_body -> $1::text ? $2::text",
      path,
    );
    return result.rows[0]?.count;
  });
}

test.each(SCRUBS)("forgetting a Memory removes its create replay body, by %s", async (scrub) => {
  const { testContext, send } = await setup("replay-memory");
  const content = "Replay canary: memory create body.";
  const created = await send("/api/v1/memories", {
    method: "POST",
    key: "replay-memory-1",
    body: JSON.stringify({ content }),
  });
  expect(created.status).toBe(201);
  const memory = (await created.json()) as { id: string };
  const kept = "Replay canary: another memory's create body.";
  await send("/api/v1/memories", {
    method: "POST",
    key: "replay-memory-2",
    body: JSON.stringify({ content: kept }),
  });
  expect(await replayKeyPresent(testContext, ["memory", "id"])).toBe(2);
  expect(await replayBodiesContaining(testContext, content)).toBe(1);
  expect(await subjectColumns(testContext, "replay-memory-1")).toEqual([
    { ...NO_SUBJECTS, subject_memory_id: memory.id },
  ]);
  await onlyScrubBy(testContext, scrub);

  const forgotten = await send(`/api/v1/memories/${memory.id}`, {
    method: "DELETE",
    headers: { "if-match": '"memory-v1"' },
  });
  expect(forgotten.status).toBe(204);
  expect(await replayBodiesContaining(testContext, content)).toBe(0);
  // Only the forgotten Memory's replay goes; another Memory's stays replayable.
  expect(await replayBodiesContaining(testContext, kept)).toBe(1);
  await testContext.close();
});

test.each(SCRUBS)(
  "forgetting an update Proposal's target removes its replay body, by %s",
  async (scrub) => {
    const { testContext, send } = await setup("replay-proposal-target");
    const target = (await (
      await send("/api/v1/memories", {
        method: "POST",
        body: JSON.stringify({ content: "Replay target Memory." }),
      })
    ).json()) as { id: string };
    const content = "Replay canary: proposed update body.";
    const proposed = await send("/api/v1/memory-proposals", {
      method: "POST",
      key: "replay-proposal-update-1",
      body: JSON.stringify({
        kind: "update",
        targetMemoryId: target.id,
        expectedVersion: 1,
        content,
      }),
    });
    expect(proposed.status).toBe(201);
    const proposal = (await proposed.json()) as { id: string };
    for (const key of ["id", "targetMemoryId", "acceptedMemoryId"]) {
      expect(await replayKeyPresent(testContext, ["proposal", key])).toBe(1);
    }
    expect(await replayBodiesContaining(testContext, content)).toBe(1);
    expect(await subjectColumns(testContext, "replay-proposal-update-1")).toEqual([
      { ...NO_SUBJECTS, subject_proposal_id: proposal.id, proposal_target_memory_id: target.id },
    ]);
    const otherTarget = (await (
      await send("/api/v1/memories", {
        method: "POST",
        body: JSON.stringify({ content: "Another replay target Memory." }),
      })
    ).json()) as { id: string };
    const kept = "Replay canary: another target's proposed update.";
    await send("/api/v1/memory-proposals", {
      method: "POST",
      key: "replay-proposal-update-2",
      body: JSON.stringify({
        kind: "update",
        targetMemoryId: otherTarget.id,
        expectedVersion: 1,
        content: kept,
      }),
    });
    await onlyScrubBy(testContext, scrub);

    const forgotten = await send(`/api/v1/memories/${target.id}`, {
      method: "DELETE",
      headers: { "if-match": '"memory-v1"' },
    });
    expect(forgotten.status).toBe(204);
    expect(await replayBodiesContaining(testContext, content)).toBe(0);
    expect(await replayBodiesContaining(testContext, kept)).toBe(1);
    await testContext.close();
  },
);

test.each(SCRUBS)(
  "forgetting an accepted Proposal's Memory removes its replay body, by %s",
  async (scrub) => {
    const { testContext, send } = await setup("replay-proposal-accepted");
    const content = "Replay canary: accepted proposal body.";
    const proposal = (await (
      await send("/api/v1/memory-proposals", {
        method: "POST",
        key: "replay-proposal-create-1",
        body: JSON.stringify({ kind: "create", content }),
      })
    ).json()) as { id: string };
    const reviewed = await send(`/api/v1/memory-proposals/${proposal.id}/review`, {
      method: "POST",
      body: JSON.stringify({ decision: "accept" }),
    });
    expect(reviewed.status).toBe(200);
    const { memory } = (await reviewed.json()) as { memory: { id: string } };
    expect(await replayBodiesContaining(testContext, content)).toBe(1);
    const kept = "Replay canary: a pending proposal's body.";
    await send("/api/v1/memory-proposals", {
      method: "POST",
      key: "replay-proposal-create-2",
      body: JSON.stringify({ kind: "create", content: kept }),
    });
    await onlyScrubBy(testContext, scrub);

    const forgotten = await send(`/api/v1/memories/${memory.id}`, {
      method: "DELETE",
      headers: { "if-match": '"memory-v1"' },
    });
    expect(forgotten.status).toBe(204);
    expect(await replayBodiesContaining(testContext, content)).toBe(0);
    expect(await replayBodiesContaining(testContext, kept)).toBe(1);
    await testContext.close();
  },
);

test.each(SCRUBS)("forgetting an Episode removes its record replay body, by %s", async (scrub) => {
  const { testContext, send } = await setup("replay-episode");
  const content = "Replay canary: episode observation body.";
  const recorded = await send("/api/v1/episodes", {
    method: "POST",
    key: "replay-episode-1",
    body: JSON.stringify({
      kind: "conversation",
      observations: [{ kind: "message", content, observedAt: "2026-09-26T00:00:00Z" }],
    }),
  });
  expect(recorded.status).toBe(201);
  const episode = (await recorded.json()) as { id: string };
  expect(await replayKeyPresent(testContext, ["episode", "id"])).toBe(1);
  expect(await replayBodiesContaining(testContext, content)).toBe(1);
  expect(await subjectColumns(testContext, "replay-episode-1")).toEqual([
    { ...NO_SUBJECTS, subject_episode_id: episode.id },
  ]);
  const kept = "Replay canary: another episode's observation.";
  await send("/api/v1/episodes", {
    method: "POST",
    key: "replay-episode-2",
    body: JSON.stringify({
      kind: "conversation",
      observations: [{ kind: "message", content: kept, observedAt: "2026-09-26T00:00:00Z" }],
    }),
  });
  await onlyScrubBy(testContext, scrub);

  const forgotten = await send(`/api/v1/episodes/${episode.id}`, { method: "DELETE" });
  expect(forgotten.status).toBe(204);
  expect(await replayBodiesContaining(testContext, content)).toBe(0);
  expect(await replayBodiesContaining(testContext, kept)).toBe(1);
  await testContext.close();
});

// No route stores a replay whose Proposal names a Memory without the Proposal row
// also pointing at it, so forgetting that Memory removes the Proposal and its own
// trigger scrubs the replay too. These rows name the Memory only in one column
// each, with no Proposal and no JSON path, so only the Memory trigger's statement
// for that column can find them.
test("forgetting a Memory scrubs rows naming it only as a Proposal's target or accepted Memory", async () => {
  const testContext = await createMemoryTestContext();
  const memories = createMemoryModule(testContext.database);
  const forgotten = await memories.remember(testContext.alice, { content: "Scrubbed subject." });
  const kept = await memories.remember(testContext.alice, { content: "Kept subject." });
  const rows: Array<[string, "proposal_target_memory_id" | "proposal_accepted_memory_id", string]> =
    [
      ["target", "proposal_target_memory_id", forgotten.id],
      ["accepted", "proposal_accepted_memory_id", forgotten.id],
      ["other-target", "proposal_target_memory_id", kept.id],
      ["other-accepted", "proposal_accepted_memory_id", kept.id],
    ];
  await testContext.adminDatabase.transaction(async (transaction) => {
    for (const [key, column, memoryId] of rows) {
      await transaction.query(
        `INSERT INTO request_idempotency_records (
           id, workspace_id, actor_user_id, actor_kind, actor_id, operation, idempotency_key,
           request_sha256, status, response_status, response_body, completed_at, ${column}
         ) VALUES (
           gen_random_uuid(), $1, $2, 'user', $2, 'memory-proposal.create', $3,
           $4, 'completed', 201, $5, now(), $6
         )`,
        [
          testContext.alice.workspaceId,
          testContext.alice.userId,
          key,
          "0".repeat(64),
          JSON.stringify({ moved: { canary: `Replay canary: ${key}.` } }),
          memoryId,
        ],
      );
    }
  });

  await expect(memories.forget(testContext.alice, forgotten.id)).resolves.toBe(true);
  const remaining = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM request_idempotency_records ORDER BY idempotency_key",
    ),
  );
  expect(remaining.rows).toEqual([
    { idempotency_key: "other-accepted" },
    { idempotency_key: "other-target" },
  ]);
});
