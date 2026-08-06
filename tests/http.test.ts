import { afterEach, expect, test } from "vitest";
import { createAccessModule } from "@/lib/access";
import {
  createAgentCredentialByIdHandlers,
  createAgentCredentialHandlers,
  createAgentGrantHandlers,
  createAgentHandlers,
  createEvaluationRunByIdHandlers,
  createEvaluationRunHandlers,
  createEvaluationSuiteHandlers,
  createGraphHandlers,
  createMemoryByIdHandlers,
  createMemoryHandlers,
  createWorkspaceHandlers,
} from "@/lib/http";
import { createMemoryTestContext } from "./support/memory-context";

afterEach(() => {
  for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT"]) {
    delete process.env[key];
  }
});

test("Human can create a Workspace then write and list native Memories over HTTP", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-user";
  const testContext = await createMemoryTestContext();
  const workspaces = createWorkspaceHandlers(testContext.database);
  const memories = createMemoryHandlers(testContext.database);
  const graph = createGraphHandlers(testContext.database);

  const workspaceResponse = await workspaces.POST(
    new Request("http://lore.local/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "HTTP Lab" }),
    }),
  );
  const workspace = (await workspaceResponse.json()) as { id: string };

  const createResponse = await memories.POST(
    new Request("http://lore.local/api/memories", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lore-workspace-id": workspace.id,
      },
      body: JSON.stringify({ content: "Native HTTP Memory.", scope: "private" }),
    }),
  );
  const created = (await createResponse.json()) as { id: string; scope: string };
  const listResponse = await memories.GET(
    new Request("http://lore.local/api/memories", {
      headers: { "x-lore-workspace-id": workspace.id },
    }),
  );
  const listed = (await listResponse.json()) as Array<{ id: string }>;
  const graphResponse = await graph.GET(
    new Request("http://lore.local/api/graph", {
      headers: { "x-lore-workspace-id": workspace.id },
    }),
  );

  expect(workspaceResponse.status).toBe(201);
  expect(createResponse.status).toBe(201);
  expect(created.scope).toBe("private");
  expect(listResponse.status).toBe(200);
  expect(listed.map((memory) => memory.id)).toEqual([created.id]);
  expect(graphResponse.status).toBe(200);
  expect(graphResponse.headers.get("cache-control")).toBe("private, no-store");
  await expect(graphResponse.json()).resolves.toMatchObject({
    nodes: [expect.objectContaining({ id: created.id, scope: "private" })],
    links: [],
  });
  await testContext.close();
});

test("Memory HTTP resource supports retrieve, update, and forget", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-resource-user";
  const testContext = await createMemoryTestContext();
  const workspaces = createWorkspaceHandlers(testContext.database);
  const memories = createMemoryHandlers(testContext.database);
  const memoryById = createMemoryByIdHandlers(testContext.database);
  const workspace = (await (
    await workspaces.POST(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Resource Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };
  const created = (await (
    await memories.POST(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "Draft resource Memory." }),
      }),
    )
  ).json()) as { id: string };

  const updateResponse = await memoryById.PATCH(
    new Request(`http://lore.local/api/memories/${created.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ content: "Confirmed resource Memory.", scope: "private" }),
    }),
    created.id,
  );
  const getResponse = await memoryById.GET(
    new Request(`http://lore.local/api/memories/${created.id}`, { headers }),
    created.id,
  );
  const deleteResponse = await memoryById.DELETE(
    new Request(`http://lore.local/api/memories/${created.id}`, { method: "DELETE", headers }),
    created.id,
  );
  const missingResponse = await memoryById.GET(
    new Request(`http://lore.local/api/memories/${created.id}`, { headers }),
    created.id,
  );

  await expect(updateResponse.json()).resolves.toMatchObject({
    content: "Confirmed resource Memory.",
    scope: "private",
  });
  await expect(getResponse.json()).resolves.toMatchObject({ id: created.id, version: 2 });
  expect(deleteResponse.status).toBe(204);
  expect(missingResponse.status).toBe(404);
  await testContext.close();
});

test("HTTP handlers reject malformed UUIDs and null characters before Postgres", async () => {
  const testContext = await createMemoryTestContext();
  const request = new Request("http://lore.local/api/resource", {
    headers: { "x-lore-workspace-id": testContext.alice.workspaceId },
  });

  const responses = await Promise.all([
    createMemoryByIdHandlers(testContext.database).GET(request, "not-a-uuid"),
    createAgentCredentialHandlers(testContext.database).POST(request, "not-a-uuid"),
    createAgentCredentialByIdHandlers(testContext.database).DELETE(request, "not-a-uuid"),
    createAgentGrantHandlers(testContext.database).DELETE(request, "not-a-uuid"),
    createEvaluationRunHandlers(testContext.database).POST(request, "not-a-uuid"),
    createEvaluationRunByIdHandlers(testContext.database).GET(request, "not-a-uuid"),
    createMemoryHandlers(testContext.database).GET(
      new Request("http://lore.local/api/memories", {
        headers: { "x-lore-workspace-id": "not-a-uuid" },
      }),
    ),
  ]);

  expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400, 400]);
});

test("Memory HTTP input rejects null characters in queries, content, and metadata", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-null-user";
  const testContext = await createMemoryTestContext();
  const workspaces = createWorkspaceHandlers(testContext.database);
  const memories = createMemoryHandlers(testContext.database);
  const workspace = (await (
    await workspaces.POST(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Input Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };

  const responses = await Promise.all([
    memories.GET(new Request("http://lore.local/api/memories?q=%00secret", { headers })),
    memories.POST(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "before\0after" }),
      }),
    ),
    memories.POST(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "valid", metadata: { note: "before\0after" } }),
      }),
    ),
  ]);

  expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
});

test("Agent HTTP resource provisions a grant and issues a revocable one-time token", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-agent-user";
  const testContext = await createMemoryTestContext();
  const workspaces = createWorkspaceHandlers(testContext.database);
  const agents = createAgentHandlers(testContext.database);
  const credentials = createAgentCredentialHandlers(testContext.database);
  const credentialById = createAgentCredentialByIdHandlers(testContext.database);
  const grants = createAgentGrantHandlers(testContext.database);
  const workspace = (await (
    await workspaces.POST(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Agent Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };

  const createResponse = await agents.POST(
    new Request("http://lore.local/api/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Recall assistant", permission: "write" }),
    }),
  );
  const agent = (await createResponse.json()) as { id: string; permission: string };
  const listResponse = await agents.GET(new Request("http://lore.local/api/agents", { headers }));
  const credentialResponse = await credentials.POST(
    new Request(`http://lore.local/api/agents/${agent.id}/credentials`, {
      method: "POST",
      headers,
    }),
    agent.id,
  );
  const credential = (await credentialResponse.json()) as { id: string; token: string };

  expect(createResponse.status).toBe(201);
  expect(agent.permission).toBe("write");
  await expect(listResponse.json()).resolves.toMatchObject([{ id: agent.id }]);
  expect(credentialResponse.status).toBe(201);
  expect(credential.token).toMatch(/^lore_agent_[a-f0-9]{64}$/);

  const revokeCredentialResponse = await credentialById.DELETE(
    new Request(`http://lore.local/api/agent-credentials/${credential.id}`, {
      method: "DELETE",
      headers,
    }),
    credential.id,
  );
  expect(revokeCredentialResponse.status).toBe(204);

  const secondCredential = (await (
    await credentials.POST(
      new Request(`http://lore.local/api/agents/${agent.id}/credentials`, {
        method: "POST",
        headers,
      }),
      agent.id,
    )
  ).json()) as { token: string };
  expect(
    await createAccessModule(testContext.database).authenticateAgent(
      secondCredential.token,
      workspace.id,
    ),
  ).not.toBeNull();

  const revokeGrantResponse = await grants.DELETE(
    new Request(`http://lore.local/api/agents/${agent.id}/grant`, {
      method: "DELETE",
      headers,
    }),
    agent.id,
  );
  expect(revokeGrantResponse.status).toBe(204);
  await expect(
    createAccessModule(testContext.database).authenticateAgent(
      secondCredential.token,
      workspace.id,
    ),
  ).resolves.toBeNull();

  await testContext.close();
});

test("Evaluation HTTP resource creates a deterministic suite and runs it", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-evaluation-user";
  const testContext = await createMemoryTestContext();
  const workspaces = createWorkspaceHandlers(testContext.database);
  const memories = createMemoryHandlers(testContext.database);
  const suites = createEvaluationSuiteHandlers(testContext.database);
  const runs = createEvaluationRunHandlers(testContext.database);
  const runById = createEvaluationRunByIdHandlers(testContext.database);
  const workspace = (await (
    await workspaces.POST(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Evaluation Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };
  const memory = (await (
    await memories.POST(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "Mercury is the closest planet to the Sun." }),
      }),
    )
  ).json()) as { id: string };
  const suiteResponse = await suites.POST(
    new Request("http://lore.local/api/evaluations/suites", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Planet recall",
        cases: [
          {
            query: "closest planet Sun",
            expectedMemoryIds: [memory.id],
            forbiddenMemoryIds: [],
            limit: 5,
          },
        ],
      }),
    }),
  );
  const suite = (await suiteResponse.json()) as { id: string };
  const runResponse = await runs.POST(
    new Request(`http://lore.local/api/evaluations/suites/${suite.id}/runs`, {
      method: "POST",
      headers,
    }),
    suite.id,
  );
  const run = (await runResponse.json()) as { id: string; status: string };
  const getResponse = await runById.GET(
    new Request(`http://lore.local/api/evaluations/runs/${run.id}`, { headers }),
    run.id,
  );

  expect(suiteResponse.status).toBe(201);
  expect(runResponse.status).toBe(201);
  expect(run.status).toBe("completed");
  await expect(getResponse.json()).resolves.toMatchObject({
    id: run.id,
    metrics: { recallAtK: 1, isolationPassed: true },
  });

  await testContext.close();
});
