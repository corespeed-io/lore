import { afterEach, expect, test } from "vitest";
import { createApi } from "@/server/api/app";
import { createMemoryTestContext, type MemoryTestContext } from "../support/memory-context";

/**
 * Forgetting a Memory, Proposal, or Episode deletes the request-replay bodies that
 * carry its content. Two mechanisms do it until the second replay-scrub release:
 * 0007's triggers match the subject columns `completeMutation` writes, and the
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
  expect(await replayKeyPresent(testContext, ["memory", "id"])).toBe(1);
  expect(await replayBodiesContaining(testContext, content)).toBe(1);
  await onlyScrubBy(testContext, scrub);

  const forgotten = await send(`/api/v1/memories/${memory.id}`, {
    method: "DELETE",
    headers: { "if-match": '"memory-v1"' },
  });
  expect(forgotten.status).toBe(204);
  expect(await replayBodiesContaining(testContext, content)).toBe(0);
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
    for (const key of ["id", "targetMemoryId", "acceptedMemoryId"]) {
      expect(await replayKeyPresent(testContext, ["proposal", key])).toBe(1);
    }
    expect(await replayBodiesContaining(testContext, content)).toBe(1);
    await onlyScrubBy(testContext, scrub);

    const forgotten = await send(`/api/v1/memories/${target.id}`, {
      method: "DELETE",
      headers: { "if-match": '"memory-v1"' },
    });
    expect(forgotten.status).toBe(204);
    expect(await replayBodiesContaining(testContext, content)).toBe(0);
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
    await onlyScrubBy(testContext, scrub);

    const forgotten = await send(`/api/v1/memories/${memory.id}`, {
      method: "DELETE",
      headers: { "if-match": '"memory-v1"' },
    });
    expect(forgotten.status).toBe(204);
    expect(await replayBodiesContaining(testContext, content)).toBe(0);
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
  await onlyScrubBy(testContext, scrub);

  const forgotten = await send(`/api/v1/episodes/${episode.id}`, { method: "DELETE" });
  expect(forgotten.status).toBe(204);
  expect(await replayBodiesContaining(testContext, content)).toBe(0);
  await testContext.close();
});
