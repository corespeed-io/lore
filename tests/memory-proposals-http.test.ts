import { sql } from "drizzle-orm";
import { afterEach, expect, test } from "vitest";
import {
  createAgentCredentialHandlers,
  createAgentHandlers,
  createMemoryByIdHandlers,
  createMemoryHandlers,
  createMemoryProposalHandlers,
  createMemoryProposalReviewHandlers,
  createWorkspaceHandlers,
} from "@/lib/http";
import { createMemoryTestContext } from "./support/memory-context";

afterEach(() => {
  for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT"]) {
    delete process.env[key];
  }
});

test("Agent submits a Proposal over v1 and only the human owner can accept it", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "proposal-http-owner";
  const testContext = await createMemoryTestContext();
  const workspaces = createWorkspaceHandlers(testContext.database);
  const agents = createAgentHandlers(testContext.database);
  const credentials = createAgentCredentialHandlers(testContext.database);
  const proposals = createMemoryProposalHandlers(testContext.database);
  const reviews = createMemoryProposalReviewHandlers(testContext.database);
  const memories = createMemoryHandlers(testContext.database);

  const workspace = (await (
    await workspaces.POST(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Proposal Lab" }),
      }),
    )
  ).json()) as { id: string };
  const humanHeaders = { "x-lore-workspace-id": workspace.id };
  const agent = (await (
    await agents.POST(
      new Request("http://lore.local/api/v1/agents", {
        method: "POST",
        headers: humanHeaders,
        body: JSON.stringify({ name: "Dream assistant", permission: "write" }),
      }),
    )
  ).json()) as { id: string };
  const credential = (await (
    await credentials.POST(
      new Request(`http://lore.local/api/v1/agents/${agent.id}/credentials`, {
        method: "POST",
        headers: humanHeaders,
      }),
      agent.id,
    )
  ).json()) as { token: string };
  const agentHeaders = {
    authorization: `Bearer ${credential.token}`,
    "idempotency-key": "proposal-http-1",
    "x-lore-workspace-id": workspace.id,
  };

  const submittedResponse = await proposals.POST(
    new Request("http://lore.local/api/v1/memory-proposals", {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify({
        kind: "create",
        content: "The assistant proposes this fact.",
        scope: "private",
      }),
    }),
  );
  const submitted = (await submittedResponse.json()) as { id: string; status: string };

  expect(submittedResponse.status).toBe(201);
  expect(submittedResponse.headers.get("cache-control")).toBe("private, no-store");
  expect(submitted.status).toBe("pending");
  const replayResponse = await proposals.POST(
    new Request("http://lore.local/api/v1/memory-proposals", {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify({
        kind: "create",
        content: "The assistant proposes this fact.",
        scope: "private",
      }),
    }),
  );
  await expect(replayResponse.json()).resolves.toMatchObject({ id: submitted.id });
  const conflictingReplay = await proposals.POST(
    new Request("http://lore.local/api/v1/memory-proposals", {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify({ kind: "create", content: "A different proposal." }),
    }),
  );
  expect(conflictingReplay.status).toBe(409);
  await expect(conflictingReplay.json()).resolves.toMatchObject({
    code: "idempotency_conflict",
  });
  const agentListResponse = await proposals.GET(
    new Request("http://lore.local/api/v1/memory-proposals", {
      headers: {
        authorization: `Bearer ${credential.token}`,
        "x-lore-workspace-id": workspace.id,
      },
    }),
  );
  expect(agentListResponse.status).toBe(403);
  expect(agentListResponse.headers.get("cache-control")).toBe("private, no-store");

  const pendingResponse = await proposals.GET(
    new Request("http://lore.local/api/v1/memory-proposals?status=pending", {
      headers: humanHeaders,
    }),
  );
  expect(pendingResponse.status).toBe(200);
  expect(pendingResponse.headers.get("cache-control")).toBe("private, no-store");
  await expect(pendingResponse.json()).resolves.toMatchObject([{ id: submitted.id }]);

  const forbiddenReview = await reviews.POST(
    new Request(`http://lore.local/api/v1/memory-proposals/${submitted.id}/review`, {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify({ decision: "accept" }),
    }),
    submitted.id,
  );
  expect(forbiddenReview.status).toBe(403);

  const acceptedResponse = await reviews.POST(
    new Request(`http://lore.local/api/v1/memory-proposals/${submitted.id}/review`, {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({ decision: "accept" }),
    }),
    submitted.id,
  );
  const accepted = (await acceptedResponse.json()) as {
    memory: { content: string; id: string };
    proposal: { acceptedMemoryId: string; status: string };
  };
  expect(acceptedResponse.status).toBe(200);
  expect(acceptedResponse.headers.get("cache-control")).toBe("private, no-store");
  expect(acceptedResponse.headers.get("etag")).toBe('"memory-v1"');
  expect(accepted.proposal).toMatchObject({
    acceptedMemoryId: accepted.memory.id,
    status: "accepted",
  });
  expect(accepted.memory.content).toBe("The assistant proposes this fact.");

  const acceptedReplay = await reviews.POST(
    new Request(`http://lore.local/api/v1/memory-proposals/${submitted.id}/review`, {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({ decision: "accept" }),
    }),
    submitted.id,
  );
  expect(acceptedReplay.status).toBe(200);
  await expect(acceptedReplay.json()).resolves.toMatchObject({
    memory: { id: accepted.memory.id },
    proposal: { id: submitted.id, status: "accepted" },
  });
  const oppositeDecision = await reviews.POST(
    new Request(`http://lore.local/api/v1/memory-proposals/${submitted.id}/review`, {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({ decision: "reject" }),
    }),
    submitted.id,
  );
  expect(oppositeDecision.status).toBe(409);
  expect(oppositeDecision.headers.get("cache-control")).toBe("private, no-store");
  await expect(oppositeDecision.json()).resolves.toMatchObject({
    code: "proposal_review_conflict",
  });

  const listedMemories = await memories.GET(
    new Request("http://lore.local/api/v1/memories", { headers: humanHeaders }),
  );
  await expect(listedMemories.json()).resolves.toMatchObject([{ id: accepted.memory.id }]);

  const forgotten = await createMemoryByIdHandlers(testContext.database).DELETE(
    new Request(`http://lore.local/api/v1/memories/${accepted.memory.id}`, {
      method: "DELETE",
      headers: { ...humanHeaders, "if-match": '"memory-v1"' },
    }),
    accepted.memory.id,
  );
  expect(forgotten.status).toBe(204);
  await expect(
    proposals
      .GET(
        new Request("http://lore.local/api/v1/memory-proposals?status=accepted", {
          headers: humanHeaders,
        }),
      )
      .then((response) => response.json()),
  ).resolves.toEqual([]);
  await testContext.adminDatabase.transaction(async (transaction) => {
    await expect(
      transaction.execute(
        sql`SELECT id FROM request_idempotency_records WHERE response_body #>> '{proposal,id}' = ${submitted.id}`,
      ),
    ).resolves.toMatchObject({ rows: [] });
  });

  await testContext.close();
});

test("HTTP refuses a stale update Proposal with 412 and keeps it pending", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "proposal-http-stale";
  const testContext = await createMemoryTestContext();
  const workspace = (await (
    await createWorkspaceHandlers(testContext.database).POST(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Stale Proposal Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };
  const memories = createMemoryHandlers(testContext.database);
  const memoryById = createMemoryByIdHandlers(testContext.database);
  const proposals = createMemoryProposalHandlers(testContext.database);
  const reviews = createMemoryProposalReviewHandlers(testContext.database);

  const created = (await (
    await memories.POST(
      new Request("http://lore.local/api/v1/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "Launch Monday", scope: "private" }),
      }),
    )
  ).json()) as { id: string };
  const proposed = (await (
    await proposals.POST(
      new Request("http://lore.local/api/v1/memory-proposals", {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "update",
          targetMemoryId: created.id,
          expectedVersion: 1,
          content: "Launch Tuesday",
        }),
      }),
    )
  ).json()) as { id: string };

  const changed = await memoryById.PATCH(
    new Request(`http://lore.local/api/v1/memories/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "if-match": '"memory-v1"' },
      body: JSON.stringify({ content: "Launch Wednesday" }),
    }),
    created.id,
  );
  expect(changed.status).toBe(200);

  const stale = await reviews.POST(
    new Request(`http://lore.local/api/v1/memory-proposals/${proposed.id}/review`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "accept" }),
    }),
    proposed.id,
  );
  expect(stale.status).toBe(412);
  expect(stale.headers.get("cache-control")).toBe("private, no-store");
  await expect(stale.json()).resolves.toMatchObject({ code: "version_conflict" });
  await expect(
    proposals
      .GET(new Request("http://lore.local/api/v1/memory-proposals?status=pending", { headers }))
      .then((response) => response.json()),
  ).resolves.toMatchObject([{ id: proposed.id, status: "pending" }]);

  await testContext.close();
});

test("Proposal HTTP validation is bounded and stable", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "proposal-http-validation";
  const testContext = await createMemoryTestContext();
  const workspace = (await (
    await createWorkspaceHandlers(testContext.database).POST(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Validation Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };
  const proposals = createMemoryProposalHandlers(testContext.database);

  const responses = await Promise.all([
    proposals.GET(
      new Request("http://lore.local/api/v1/memory-proposals?status=unknown", { headers }),
    ),
    proposals.POST(
      new Request("http://lore.local/api/v1/memory-proposals", {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "create" }),
      }),
    ),
    proposals.POST(
      new Request("http://lore.local/api/v1/memory-proposals", {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "update",
          targetMemoryId: crypto.randomUUID(),
          expectedVersion: 1,
        }),
      }),
    ),
    proposals.POST(
      new Request("http://lore.local/api/v1/memory-proposals", {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "create",
          content: "Too much evidence",
          evidenceMemoryIds: Array.from({ length: 51 }, () => crypto.randomUUID()),
        }),
      }),
    ),
  ]);

  expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
  for (const response of responses) {
    await expect(response.clone().json()).resolves.toMatchObject({ code: "invalid_request" });
  }

  const owner = await testContext.adminDatabase.transaction((transaction) =>
    transaction.execute<{ user_id: string }>(
      sql`SELECT user_id FROM memberships WHERE workspace_id = ${workspace.id} AND role = 'owner'`,
    ),
  );
  await testContext.adminDatabase.transaction((transaction) =>
    transaction.execute(sql`INSERT INTO memory_proposals (
         id, workspace_id, owner_user_id, proposed_by_actor_kind,
         proposed_by_agent_id, kind, target_memory_id, base_memory_version,
         proposed_content, proposed_scope, proposed_metadata,
         changes_content, changes_scope, changes_metadata
       )
       SELECT gen_random_uuid(), ${workspace.id}, ${owner.rows[0].user_id}, 'human', NULL, 'create', NULL, NULL,
              'Pending HTTP proposal ' || ordinal, 'shared', '{}'::jsonb,
              true, true, true
       FROM generate_series(1, 100) ordinal`),
  );
  const capacity = await proposals.POST(
    new Request("http://lore.local/api/v1/memory-proposals", {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "create", content: "Inbox is full" }),
    }),
  );
  expect(capacity.status).toBe(409);
  expect(capacity.headers.get("cache-control")).toBe("private, no-store");
  await expect(capacity.json()).resolves.toMatchObject({
    code: "proposal_capacity_exceeded",
  });

  await testContext.close();
});
