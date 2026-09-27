import { afterEach, expect, test } from "vitest";
import {
  createMemoryProposalsModule,
  MemoryProposalValidationError,
} from "@/modules/proposals/service";
import { createApi } from "@/server/api/app";

import { createMemoryTestContext } from "../../support/memory-context";

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
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });

  const workspace = (await (
    await app.request(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Proposal Lab" }),
      }),
    )
  ).json()) as { id: string };
  const humanHeaders = { "x-lore-workspace-id": workspace.id };
  const agent = (await (
    await app.request(
      new Request("http://lore.local/api/v1/agents", {
        method: "POST",
        headers: humanHeaders,
        body: JSON.stringify({ name: "Dream assistant", permission: "write" }),
      }),
    )
  ).json()) as { id: string };
  const credential = (await (
    await app.request(
      new Request(`http://lore.local/api/v1/agents/${agent.id}/credentials`, {
        method: "POST",
        headers: humanHeaders,
      }),
    )
  ).json()) as { token: string };
  const agentHeaders = {
    authorization: `Bearer ${credential.token}`,
    "idempotency-key": "proposal-http-1",
    "x-lore-workspace-id": workspace.id,
  };

  const submittedResponse = await app.request(
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
  const replayResponse = await app.request(
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
  const conflictingReplay = await app.request(
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
  const agentListResponse = await app.request(
    new Request("http://lore.local/api/v1/memory-proposals", {
      headers: {
        authorization: `Bearer ${credential.token}`,
        "x-lore-workspace-id": workspace.id,
      },
    }),
  );
  expect(agentListResponse.status).toBe(403);
  expect(agentListResponse.headers.get("cache-control")).toBe("private, no-store");

  const pendingResponse = await app.request(
    new Request("http://lore.local/api/v1/memory-proposals?status=pending", {
      headers: humanHeaders,
    }),
  );
  expect(pendingResponse.status).toBe(200);
  expect(pendingResponse.headers.get("cache-control")).toBe("private, no-store");
  await expect(pendingResponse.json()).resolves.toMatchObject([{ id: submitted.id }]);

  const forbiddenReview = await app.request(
    new Request(`http://lore.local/api/v1/memory-proposals/${submitted.id}/review`, {
      method: "POST",
      headers: agentHeaders,
      body: JSON.stringify({ decision: "accept" }),
    }),
  );
  expect(forbiddenReview.status).toBe(403);

  const acceptedResponse = await app.request(
    new Request(`http://lore.local/api/v1/memory-proposals/${submitted.id}/review`, {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({ decision: "accept" }),
    }),
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

  const acceptedReplay = await app.request(
    new Request(`http://lore.local/api/v1/memory-proposals/${submitted.id}/review`, {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({ decision: "accept" }),
    }),
  );
  expect(acceptedReplay.status).toBe(200);
  await expect(acceptedReplay.json()).resolves.toMatchObject({
    memory: { id: accepted.memory.id },
    proposal: { id: submitted.id, status: "accepted" },
  });
  const oppositeDecision = await app.request(
    new Request(`http://lore.local/api/v1/memory-proposals/${submitted.id}/review`, {
      method: "POST",
      headers: humanHeaders,
      body: JSON.stringify({ decision: "reject" }),
    }),
  );
  expect(oppositeDecision.status).toBe(409);
  expect(oppositeDecision.headers.get("cache-control")).toBe("private, no-store");
  await expect(oppositeDecision.json()).resolves.toMatchObject({
    code: "proposal_review_conflict",
  });

  const listedMemories = await app.request(
    new Request("http://lore.local/api/v1/memories", { headers: humanHeaders }),
  );
  await expect(listedMemories.json()).resolves.toMatchObject([{ id: accepted.memory.id }]);

  const forgotten = await app.request(
    new Request(`http://lore.local/api/v1/memories/${accepted.memory.id}`, {
      method: "DELETE",
      headers: { ...humanHeaders, "if-match": '"memory-v1"' },
    }),
  );
  expect(forgotten.status).toBe(204);
  await expect(
    (
      await app.request(
        new Request("http://lore.local/api/v1/memory-proposals?status=accepted", {
          headers: humanHeaders,
        }),
      )
    ).json(),
  ).resolves.toEqual([]);
  await testContext.adminDatabase.transaction(async (transaction) => {
    await expect(
      // By content, not by the JSON path the scrub trigger itself matches.
      transaction.query(
        "SELECT id FROM request_idempotency_records WHERE strpos(response_body::text, $1) > 0",
        ["The assistant proposes this fact."],
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
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });
  const workspace = (await (
    await app.request(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Stale Proposal Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };

  const created = (await (
    await app.request(
      new Request("http://lore.local/api/v1/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "Launch Monday", scope: "private" }),
      }),
    )
  ).json()) as { id: string };
  const proposed = (await (
    await app.request(
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

  const changed = await app.request(
    new Request(`http://lore.local/api/v1/memories/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "if-match": '"memory-v1"' },
      body: JSON.stringify({ content: "Launch Wednesday" }),
    }),
  );
  expect(changed.status).toBe(200);

  const stale = await app.request(
    new Request(`http://lore.local/api/v1/memory-proposals/${proposed.id}/review`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "accept" }),
    }),
  );
  expect(stale.status).toBe(412);
  expect(stale.headers.get("cache-control")).toBe("private, no-store");
  await expect(stale.json()).resolves.toMatchObject({ code: "version_conflict" });
  await expect(
    (
      await app.request(
        new Request("http://lore.local/api/v1/memory-proposals?status=pending", { headers }),
      )
    ).json(),
  ).resolves.toMatchObject([{ id: proposed.id, status: "pending" }]);

  await testContext.close();
});

test("Proposal HTTP validation is bounded and stable", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "proposal-http-validation";
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
        body: JSON.stringify({ name: "Validation Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };

  const responses = await Promise.all([
    app.request(
      new Request("http://lore.local/api/v1/memory-proposals?status=unknown", { headers }),
    ),
    app.request(
      new Request("http://lore.local/api/v1/memory-proposals", {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "create" }),
      }),
    ),
    app.request(
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
    app.request(
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
    transaction.query<{ user_id: string }>(
      "SELECT user_id FROM memberships WHERE workspace_id = $1 AND role = 'owner'",
      [workspace.id],
    ),
  );
  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query(
      `INSERT INTO memory_proposals (
         id, workspace_id, owner_user_id, proposed_by_actor_kind,
         proposed_by_agent_id, kind, target_memory_id, base_memory_version,
         proposed_content, proposed_scope, proposed_metadata,
         changes_content, changes_scope, changes_metadata
       )
       SELECT gen_random_uuid(), $1, $2, 'human', NULL, 'create', NULL, NULL,
              'Pending HTTP proposal ' || ordinal, 'shared', '{}'::jsonb,
              true, true, true
       FROM generate_series(1, 100) ordinal`,
      [workspace.id, owner.rows[0].user_id],
    ),
  );
  const capacity = await app.request(
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

test("the Proposal rules the service owns answer HTTP as 400 invalid_request", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "proposal-http-rules";
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
        body: JSON.stringify({ name: "Proposal Rules" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };
  const created = (await (
    await app.request(
      new Request("http://lore.local/api/v1/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "Launch Monday" }),
      }),
    )
  ).json()) as { id: string };
  const propose = (body: Record<string, unknown>) =>
    app.request(
      new Request("http://lore.local/api/v1/memory-proposals", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );

  // These rules moved from the route into the Proposal service with the refactor.
  const unchanged = await propose({
    kind: "update",
    targetMemoryId: created.id,
    expectedVersion: 1,
  });
  expect(unchanged.status).toBe(400);
  await expect(unchanged.json()).resolves.toEqual({
    code: "invalid_request",
    error: "An update proposal must change content, scope, or metadata",
  });
  const evidenceId = (index: number) =>
    `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  // Each list stays within its own bound; together they exceed the shared one.
  const overCited = await propose({
    kind: "create",
    content: "Too much evidence",
    evidenceMemoryIds: Array.from({ length: 30 }, (_, index) => evidenceId(index)),
    evidenceObservationIds: Array.from({ length: 21 }, (_, index) => evidenceId(100 + index)),
  });
  expect(overCited.status).toBe(400);
  await expect(overCited.json()).resolves.toEqual({
    code: "invalid_request",
    error: "A Memory Proposal may cite at most 50 evidence records",
  });
  // Repeats count as the published per-list bound counts them.
  const repeatedInOneList = await propose({
    kind: "create",
    content: "Repeated evidence",
    evidenceMemoryIds: Array.from({ length: 51 }, () => created.id),
  });
  expect(repeatedInOneList.status).toBe(400);
  await expect(repeatedInOneList.json()).resolves.toEqual({
    code: "invalid_request",
    error: "evidenceMemoryIds exceeds 50 items",
  });
  const repeatedAcrossLists = await propose({
    kind: "create",
    content: "Repeated evidence",
    evidenceMemoryIds: Array.from({ length: 26 }, () => created.id),
    evidenceObservationIds: Array.from({ length: 25 }, () => evidenceId(200)),
  });
  expect(repeatedAcrossLists.status).toBe(400);
  await expect(repeatedAcrossLists.json()).resolves.toEqual({
    code: "invalid_request",
    error: "A Memory Proposal may cite at most 50 evidence records",
  });

  const listed = await app.request(
    new Request("http://lore.local/api/v1/memory-proposals", { headers }),
  );
  await expect(listed.json()).resolves.toEqual([]);
  await testContext.close();
});

test("Proposal route refusals name each published vocabulary and bound exactly", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "proposal-http-vocabulary";
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
        body: JSON.stringify({ name: "Proposal Vocabulary" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };
  const propose = (body: Record<string, unknown>) =>
    app.request(
      new Request("http://lore.local/api/v1/memory-proposals", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  const artifactId = "80000000-0000-4000-8000-000000000001";

  // Each message is built from the vocabulary or bound it enforces.
  for (const [response, error] of [
    [
      await app.request(
        new Request("http://lore.local/api/v1/memory-proposals?status=archived", { headers }),
      ),
      "status must be pending, accepted, or rejected",
    ],
    [await propose({ kind: "delete", content: "Unknown kind" }), "kind must be create or update"],
    [
      await propose({
        kind: "create",
        content: "Unknown relationship",
        codeEvidence: [
          { artifactId, relationship: "supports" },
          { artifactId, relationship: "cites" },
        ],
      }),
      "codeEvidence[1].relationship must be supports, contradicts, implements, or rationale",
    ],
    [
      await propose({
        kind: "create",
        content: "Too much Code evidence",
        codeEvidence: Array.from({ length: 51 }, () => ({ artifactId, relationship: "supports" })),
      }),
      "codeEvidence exceeds 50 items",
    ],
  ] as const) {
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "invalid_request", error });
  }
  await testContext.close();
});

test("a direct Proposal caller gets the relationship rule by its own entry, before any write", async () => {
  const testContext = await createMemoryTestContext();
  const proposals = createMemoryProposalsModule(testContext.database);
  const artifactId = "80000000-0000-4000-8000-000000000002";

  // The Proposal rule reports the requested index even when an earlier entry
  // repeats the same artifact, and it refuses before the Code Artifact lookup.
  const refused = await proposals
    .propose(testContext.alice, {
      kind: "create",
      content: "A direct caller's invalid relationship",
      codeEvidence: [
        { artifactId, relationship: "supports" },
        { artifactId, relationship: "supports" },
        { artifactId, relationship: "endorses" as "supports" },
      ],
    })
    .then(
      () => undefined,
      (cause: unknown) => cause,
    );
  expect(refused).toBeInstanceOf(MemoryProposalValidationError);
  expect(refused).toMatchObject({
    field: "codeEvidence[2].relationship",
    message: "codeEvidence[2].relationship must be supports, contradicts, implements, or rationale",
  });
  await expect(proposals.listProposals(testContext.alice)).resolves.toEqual([]);
  await testContext.close();
});
