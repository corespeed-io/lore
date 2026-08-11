import { sql } from "drizzle-orm";
import { afterEach, expect, test } from "vitest";
import { createAccessModule } from "@/lib/access";
import {
  createActorHandlers,
  createAgentByIdHandlers,
  createAgentCredentialByIdHandlers,
  createAgentCredentialHandlers,
  createAgentGrantHandlers,
  createAgentHandlers,
  createCapabilitiesHandlers,
  createEvaluationRunByIdHandlers,
  createEvaluationRunHandlers,
  createEvaluationSuiteHandlers,
  createGraphHandlers,
  createMemoryByIdHandlers,
  createMemoryHandlers,
  createPortabilityHandlers,
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

test("Workspace portability HTTP is RLS-scoped, dry-runnable, and human-only", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-portability-user";
  const testContext = await createMemoryTestContext();
  const workspaces = createWorkspaceHandlers(testContext.database);
  const memories = createMemoryHandlers(testContext.database);
  const agents = createAgentHandlers(testContext.database);
  const actorHandlers = createActorHandlers(testContext.database);
  const credentials = createAgentCredentialHandlers(testContext.database);
  const portability = createPortabilityHandlers(testContext.database);
  const createWorkspace = async (name: string) =>
    (await (
      await workspaces.POST(
        new Request("http://lore.local/api/workspaces", {
          method: "POST",
          body: JSON.stringify({ name }),
        }),
      )
    ).json()) as { id: string };
  const sourceWorkspace = await createWorkspace("Portability source");
  const targetWorkspace = await createWorkspace("Portability target");
  const sourceHeaders = { "x-lore-workspace-id": sourceWorkspace.id };
  const targetHeaders = { "x-lore-workspace-id": targetWorkspace.id };

  const sourceMemory = (await (
    await memories.POST(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers: sourceHeaders,
        body: JSON.stringify({ content: "Source-only private Memory.", scope: "private" }),
      }),
    )
  ).json()) as { id: string };
  const targetMemory = (await (
    await memories.POST(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers: targetHeaders,
        body: JSON.stringify({ content: "Target-only shared Memory." }),
      }),
    )
  ).json()) as { id: string };

  const sourceExportResponse = await portability.EXPORT(
    new Request("http://lore.local/api/v1/workspaces/export", { headers: sourceHeaders }),
  );
  const sourceArchive = (await sourceExportResponse.json()) as {
    manifest: { checksum: string };
    memories: Array<{ id: string; ownerUserId: string }>;
  };
  const targetArchive = (await (
    await portability.EXPORT(
      new Request("http://lore.local/api/v1/workspaces/export", { headers: targetHeaders }),
    )
  ).json()) as { memories: Array<{ id: string }> };

  expect(sourceExportResponse.status).toBe(200);
  expect(sourceExportResponse.headers.get("cache-control")).toBe("private, no-store");
  expect(sourceExportResponse.headers.get("content-disposition")).toContain(sourceWorkspace.id);
  expect(sourceArchive.memories.map((memory) => memory.id)).toEqual([sourceMemory.id]);
  expect(targetArchive.memories.map((memory) => memory.id)).toEqual([targetMemory.id]);

  const sourceOwnerId = sourceArchive.memories[0]?.ownerUserId;
  if (!sourceOwnerId) throw new Error("Expected the source archive owner");
  const humanActorResponse = await actorHandlers.GET(
    new Request("http://lore.local/api/v1/actor", { headers: targetHeaders }),
  );
  expect(humanActorResponse.status).toBe(200);
  expect(humanActorResponse.headers.get("cache-control")).toBe("private, no-store");
  await expect(humanActorResponse.json()).resolves.toEqual({
    kind: "human",
    userId: sourceOwnerId,
  });
  const importBody = {
    archive: sourceArchive,
    ownerMap: { [sourceOwnerId]: sourceOwnerId },
    conflictPolicy: "remap",
  };
  const dryRunResponse = await portability.IMPORT(
    new Request("http://lore.local/api/v1/workspaces/import", {
      method: "POST",
      headers: targetHeaders,
      body: JSON.stringify({ ...importBody, dryRun: true }),
    }),
  );
  expect(dryRunResponse.status).toBe(200);
  await expect(dryRunResponse.json()).resolves.toMatchObject({
    dryRun: true,
    importedMemories: 1,
  });
  const beforeImport = await memories.GET(
    new Request("http://lore.local/api/memories", { headers: targetHeaders }),
  );
  await expect(beforeImport.json()).resolves.toHaveLength(1);

  const agent = (await (
    await agents.POST(
      new Request("http://lore.local/api/v1/agents", {
        method: "POST",
        headers: sourceHeaders,
        body: JSON.stringify({ name: "Portability probe" }),
      }),
    )
  ).json()) as { id: string };
  const credential = (await (
    await credentials.POST(
      new Request(`http://lore.local/api/v1/agents/${agent.id}/credentials`, {
        method: "POST",
        headers: sourceHeaders,
      }),
      agent.id,
    )
  ).json()) as { token: string };
  const agentHeaders = {
    authorization: `Bearer ${credential.token}`,
    "x-lore-workspace-id": sourceWorkspace.id,
  };
  const [agentActor, agentExport, agentImport] = await Promise.all([
    actorHandlers.GET(new Request("http://lore.local/api/v1/actor", { headers: agentHeaders })),
    portability.EXPORT(
      new Request("http://lore.local/api/v1/workspaces/export", { headers: agentHeaders }),
    ),
    portability.IMPORT(
      new Request("http://lore.local/api/v1/workspaces/import", {
        method: "POST",
        headers: agentHeaders,
        body: JSON.stringify({ ...importBody, dryRun: true }),
      }),
    ),
  ]);
  expect([agentActor.status, agentExport.status, agentImport.status]).toEqual([403, 403, 403]);

  const importResponse = await portability.IMPORT(
    new Request("http://lore.local/api/v1/workspaces/import", {
      method: "POST",
      headers: targetHeaders,
      body: JSON.stringify({ ...importBody, dryRun: false }),
    }),
  );
  expect(importResponse.status).toBe(200);
  await expect(importResponse.json()).resolves.toMatchObject({
    dryRun: false,
    importedMemories: 1,
    replayed: false,
  });
  const afterImport = await memories.GET(
    new Request("http://lore.local/api/memories", { headers: targetHeaders }),
  );
  await expect(afterImport.json()).resolves.toHaveLength(2);

  await testContext.close();
});

test("Capabilities verifies Agent credentials and Workspace grants in the handler", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const agent = await access.createAgent(testContext.alice, { name: "Capabilities Agent" });
  await access.grantAgent(testContext.alice, agent.id, { permission: "read" });
  const credential = await access.issueAgentCredential(testContext.alice, agent.id);
  const capabilities = createCapabilitiesHandlers(testContext.database, {
    embeddingConfigured: false,
  });
  const request = (token: string) =>
    new Request("http://lore.local/api/v1/capabilities", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-lore-workspace-id": testContext.alice.workspaceId,
      },
    });

  const accepted = await capabilities.GET(request(credential.token));
  const shapeOnly = await capabilities.GET(request(`lore_agent_${"0".repeat(64)}`));
  await access.revokeAgentCredential(testContext.alice, credential.id);
  const revoked = await capabilities.GET(request(credential.token));

  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("cache-control")).toBe("private, no-store");
  await expect(accepted.json()).resolves.toMatchObject({ schemaRevision: 9 });
  expect(shapeOnly.status).toBe(403);
  await expect(shapeOnly.json()).resolves.toMatchObject({ code: "access_denied" });
  expect(revoked.status).toBe(403);
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
      headers: { ...headers, "if-match": '"memory-v1"' },
      body: JSON.stringify({ content: "Confirmed resource Memory.", scope: "private" }),
    }),
    created.id,
  );
  const getResponse = await memoryById.GET(
    new Request(`http://lore.local/api/memories/${created.id}`, { headers }),
    created.id,
  );
  const deleteResponse = await memoryById.DELETE(
    new Request(`http://lore.local/api/memories/${created.id}`, {
      method: "DELETE",
      headers: { ...headers, "if-match": '"memory-v2"' },
    }),
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

test("Memory HTTP exposes ETags, idempotent replay, and stale-write errors", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-portable-core-user";
  const testContext = await createMemoryTestContext();
  const workspace = (await (
    await createWorkspaceHandlers(testContext.database).POST(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Portable Core Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = {
    "x-lore-workspace-id": workspace.id,
    "idempotency-key": "memory-create-replay",
  };
  const memories = createMemoryHandlers(testContext.database);
  const memoryById = createMemoryByIdHandlers(testContext.database);
  const requestBody = JSON.stringify({ content: "Replay this HTTP Memory." });

  const createResponse = await memories.POST(
    new Request("http://lore.local/api/memories", { method: "POST", headers, body: requestBody }),
  );
  const created = (await createResponse.json()) as { id: string; version: number };
  const replayResponse = await memories.POST(
    new Request("http://lore.local/api/memories", { method: "POST", headers, body: requestBody }),
  );
  await expect(replayResponse.json()).resolves.toMatchObject({ id: created.id });
  expect(createResponse.headers.get("etag")).toBe('"memory-v1"');
  expect(replayResponse.status).toBe(201);

  const changedReplay = await memories.POST(
    new Request("http://lore.local/api/memories", {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "A different request." }),
    }),
  );
  await expect(changedReplay.json()).resolves.toMatchObject({ code: "idempotency_conflict" });
  expect(changedReplay.status).toBe(409);

  const missingPrecondition = await memoryById.PATCH(
    new Request(`http://lore.local/api/memories/${created.id}`, {
      method: "PATCH",
      headers: { "x-lore-workspace-id": workspace.id },
      body: JSON.stringify({ scope: "private" }),
    }),
    created.id,
  );
  expect(missingPrecondition.status).toBe(428);

  const staleWrite = await memoryById.PATCH(
    new Request(`http://lore.local/api/memories/${created.id}`, {
      method: "PATCH",
      headers: { "x-lore-workspace-id": workspace.id, "if-match": '"memory-v2"' },
      body: JSON.stringify({ scope: "private" }),
    }),
    created.id,
  );
  await expect(staleWrite.json()).resolves.toMatchObject({ code: "version_conflict" });
  expect(staleWrite.status).toBe(412);

  const updateResponse = await memoryById.PATCH(
    new Request(`http://lore.local/api/memories/${created.id}`, {
      method: "PATCH",
      headers: { "x-lore-workspace-id": workspace.id, "if-match": '"memory-v1"' },
      body: JSON.stringify({ scope: "private" }),
    }),
    created.id,
  );
  expect(updateResponse.headers.get("etag")).toBe('"memory-v2"');

  const deleteHeaders = {
    "x-lore-workspace-id": workspace.id,
    "if-match": '"memory-v2"',
    "idempotency-key": "memory-delete-replay",
  };
  const deleted = await memoryById.DELETE(
    new Request(`http://lore.local/api/memories/${created.id}`, {
      method: "DELETE",
      headers: deleteHeaders,
    }),
    created.id,
  );
  const deleteReplay = await memoryById.DELETE(
    new Request(`http://lore.local/api/memories/${created.id}`, {
      method: "DELETE",
      headers: deleteHeaders,
    }),
    created.id,
  );
  expect(deleted.status).toBe(204);
  expect(deleteReplay.status).toBe(204);
  await testContext.close();
});

test("Memory HTTP cursor advances within the authorized ordering", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-cursor-user";
  const testContext = await createMemoryTestContext();
  const workspace = (await (
    await createWorkspaceHandlers(testContext.database).POST(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Cursor Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };
  const memories = createMemoryHandlers(testContext.database);
  const memoryIds: string[] = [];
  for (const content of ["First cursor Memory.", "Second cursor Memory.", "Third cursor Memory."]) {
    const response = await memories.POST(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content }),
      }),
    );
    memoryIds.push(((await response.json()) as { id: string }).id);
  }
  await testContext.adminDatabase.transaction(async (transaction) => {
    for (const [index, memoryId] of memoryIds.entries()) {
      await transaction.execute(sql`UPDATE memories
         SET updated_at = ${`2026-08-07T12:00:00.12345${6 - index}Z`}::timestamptz
         WHERE id = ${memoryId}`);
    }
  });

  const firstPage = await memories.GET(
    new Request("http://lore.local/api/memories?limit=2", { headers }),
  );
  const cursor = firstPage.headers.get("x-lore-next-cursor");
  expect(cursor).toBeTruthy();
  const firstPageMemories = (await firstPage.json()) as Array<{ id: string }>;
  expect(firstPageMemories).toHaveLength(2);
  await testContext.adminDatabase.transaction((transaction) =>
    transaction.execute(sql`UPDATE memories
       SET updated_at = '2026-08-07T13:00:00Z'
       WHERE id = ${firstPageMemories[1].id}`),
  );
  const secondPage = await memories.GET(
    new Request(`http://lore.local/api/memories?limit=2&cursor=${cursor}`, { headers }),
  );
  await expect(secondPage.json()).resolves.toEqual([expect.objectContaining({ id: memoryIds[2] })]);
  expect(secondPage.headers.get("x-lore-next-cursor")).toBeNull();
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

test("Memory HTTP filters reject invalid or inverted time ranges", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-filter-user";
  const testContext = await createMemoryTestContext();
  const workspace = (await (
    await createWorkspaceHandlers(testContext.database).POST(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Filter Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };
  const memories = createMemoryHandlers(testContext.database);

  const responses = await Promise.all([
    memories.GET(
      new Request("http://lore.local/api/memories?q=atlas&updated_after=not-a-date", {
        headers,
      }),
    ),
    memories.GET(
      new Request(
        "http://lore.local/api/memories?q=atlas&updated_after=2026-02-01T00%3A00%3A00Z&updated_before=2026-01-01T00%3A00%3A00Z",
        { headers },
      ),
    ),
    memories.GET(
      new Request("http://lore.local/api/memories?q=atlas&scope=workspace", { headers }),
    ),
    memories.GET(
      new Request("http://lore.local/api/memories?q=atlas&metadata=%7Bnot-json", { headers }),
    ),
    memories.GET(
      new Request("http://lore.local/api/memories?q=atlas&metadata=%5B1%2C2%5D", { headers }),
    ),
    memories.GET(new Request("http://lore.local/api/memories?limit=1.5", { headers })),
    memories.GET(new Request("http://lore.local/api/memories?limit=0", { headers })),
    memories.GET(new Request("http://lore.local/api/memories?offset=-1", { headers })),
    memories.GET(new Request("http://lore.local/api/memories?offset=1000001", { headers })),
  ]);

  expect(responses.map((response) => response.status)).toEqual([
    400, 400, 400, 400, 400, 400, 400, 400, 400,
  ]);
  await testContext.close();
});

test("Memory HTTP metadata rejects excessive depth and size", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-metadata-limits-user";
  const testContext = await createMemoryTestContext();
  const workspace = (await (
    await createWorkspaceHandlers(testContext.database).POST(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Metadata Limits Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };
  const memories = createMemoryHandlers(testContext.database);
  let nested: Record<string, unknown> = { leaf: true };
  for (let depth = 0; depth < 34; depth += 1) nested = { child: nested };

  const responses = await Promise.all([
    memories.POST(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "deep", metadata: nested }),
      }),
    ),
    memories.POST(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "large", metadata: { value: "x".repeat(100_001) } }),
      }),
    ),
  ]);

  expect(responses.map((response) => response.status)).toEqual([400, 400]);
  await testContext.close();
});

test("Agent HTTP resource provisions a grant and issues a revocable one-time token", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-agent-user";
  const testContext = await createMemoryTestContext();
  const workspaces = createWorkspaceHandlers(testContext.database);
  const agents = createAgentHandlers(testContext.database);
  const agentById = createAgentByIdHandlers(testContext.database);
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
  const defaultPermissionResponse = await agents.POST(
    new Request("http://lore.local/api/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Default reader" }),
    }),
  );
  const defaultPermissionAgent = (await defaultPermissionResponse.json()) as {
    permission: string;
  };
  const credentialResponse = await credentials.POST(
    new Request(`http://lore.local/api/agents/${agent.id}/credentials`, {
      method: "POST",
      headers,
    }),
    agent.id,
  );
  const credential = (await credentialResponse.json()) as { id: string; token: string };
  const credentialListResponse = await credentials.GET(
    new Request(`http://lore.local/api/agents/${agent.id}/credentials`, { headers }),
    agent.id,
  );

  expect(createResponse.status).toBe(201);
  expect(createResponse.headers.get("cache-control")).toBe("private, no-store");
  expect(agent.permission).toBe("write");
  expect(defaultPermissionResponse.status).toBe(201);
  expect(defaultPermissionAgent.permission).toBe("read");
  expect(listResponse.headers.get("cache-control")).toBe("private, no-store");
  await expect(listResponse.json()).resolves.toMatchObject([{ id: agent.id }]);
  expect(credentialResponse.status).toBe(201);
  expect(credentialResponse.headers.get("cache-control")).toBe("private, no-store");
  expect(credential.token).toMatch(/^lore_agent_[a-f0-9]{64}$/);
  expect(credentialListResponse.headers.get("cache-control")).toBe("private, no-store");
  const credentialList = (await credentialListResponse.json()) as Array<Record<string, unknown>>;
  expect(credentialList).toMatchObject([
    {
      id: credential.id,
      agentId: agent.id,
      prefix: expect.any(String),
      revokedAt: null,
    },
  ]);
  expect(credentialList[0]).not.toHaveProperty("token");
  expect(credentialList[0]).not.toHaveProperty("secretHash");

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
  const agentHeaders = {
    authorization: `Bearer ${secondCredential.token}`,
    "x-lore-workspace-id": workspace.id,
  };
  const forbiddenAdministrationResponses = await Promise.all([
    agents.GET(new Request("http://lore.local/api/agents", { headers: agentHeaders })),
    agents.POST(
      new Request("http://lore.local/api/agents", {
        method: "POST",
        headers: agentHeaders,
        body: JSON.stringify({ name: "Forbidden assistant", permission: "read" }),
      }),
    ),
    agentById.PATCH(
      new Request(`http://lore.local/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: agentHeaders,
        body: JSON.stringify({ name: "Forbidden rename" }),
      }),
      agent.id,
    ),
    agentById.DELETE(
      new Request(`http://lore.local/api/agents/${agent.id}`, {
        method: "DELETE",
        headers: agentHeaders,
      }),
      agent.id,
    ),
    credentials.GET(
      new Request(`http://lore.local/api/agents/${agent.id}/credentials`, {
        headers: agentHeaders,
      }),
      agent.id,
    ),
    credentials.POST(
      new Request(`http://lore.local/api/agents/${agent.id}/credentials`, {
        method: "POST",
        headers: agentHeaders,
      }),
      agent.id,
    ),
    credentialById.DELETE(
      new Request(`http://lore.local/api/agent-credentials/${credential.id}`, {
        method: "DELETE",
        headers: agentHeaders,
      }),
      credential.id,
    ),
    grants.PUT(
      new Request(`http://lore.local/api/agents/${agent.id}/grant`, {
        method: "PUT",
        headers: agentHeaders,
        body: JSON.stringify({ permission: "read" }),
      }),
      agent.id,
    ),
    grants.DELETE(
      new Request(`http://lore.local/api/agents/${agent.id}/grant`, {
        method: "DELETE",
        headers: agentHeaders,
      }),
      agent.id,
    ),
  ]);
  expect(forbiddenAdministrationResponses.map((response) => response.status)).toEqual(
    Array(9).fill(403),
  );

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

  const invalidRestoreResponse = await grants.PUT(
    new Request(`http://lore.local/api/agents/${agent.id}/grant`, {
      method: "PUT",
      headers,
      body: JSON.stringify({}),
    }),
    agent.id,
  );
  expect(invalidRestoreResponse.status).toBe(400);
  await expect(invalidRestoreResponse.json()).resolves.toEqual({
    code: "invalid_request",
    error: "permission must be read or write",
  });
  const afterInvalidRestoreResponse = await agents.GET(
    new Request("http://lore.local/api/agents", { headers }),
  );
  expect(afterInvalidRestoreResponse.status).toBe(200);
  await expect(afterInvalidRestoreResponse.json()).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: agent.id,
        permission: "write",
        grantStatus: "revoked",
      }),
    ]),
  );
  await expect(
    createAccessModule(testContext.database).authenticateAgent(
      secondCredential.token,
      workspace.id,
    ),
  ).resolves.toBeNull();

  const restoreGrantResponse = await grants.PUT(
    new Request(`http://lore.local/api/agents/${agent.id}/grant`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ permission: "read" }),
    }),
    agent.id,
  );
  expect(restoreGrantResponse.status).toBe(200);
  expect(restoreGrantResponse.headers.get("cache-control")).toBe("private, no-store");
  await expect(restoreGrantResponse.json()).resolves.toMatchObject({
    agentId: agent.id,
    permission: "read",
    status: "active",
  });
  await expect(
    createAccessModule(testContext.database).authenticateAgent(
      secondCredential.token,
      workspace.id,
    ),
  ).resolves.toMatchObject({ agentId: agent.id });

  const invalidLifecycleResponses = await Promise.all([
    agentById.PATCH(
      new Request(`http://lore.local/api/agents/${agent.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({}),
      }),
      agent.id,
    ),
    agentById.PATCH(
      new Request(`http://lore.local/api/agents/${agent.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "paused" }),
      }),
      agent.id,
    ),
    agentById.PATCH(
      new Request("http://lore.local/api/agents/not-a-uuid", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "Invalid identifier" }),
      }),
      "not-a-uuid",
    ),
    agentById.PATCH(
      new Request(`http://lore.local/api/agents/${agent.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "Should not apply", permission: "write" }),
      }),
      agent.id,
    ),
  ]);
  expect(invalidLifecycleResponses.map((response) => response.status)).toEqual([
    400, 400, 400, 400,
  ]);
  await expect(invalidLifecycleResponses[3]?.json()).resolves.toEqual({
    code: "invalid_request",
    error: "permission is not a supported Agent field",
  });

  const renamedResponse = await agentById.PATCH(
    new Request(`http://lore.local/api/agents/${agent.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Deployment assistant" }),
    }),
    agent.id,
  );
  expect(renamedResponse.status).toBe(200);
  expect(renamedResponse.headers.get("cache-control")).toBe("private, no-store");
  await expect(renamedResponse.json()).resolves.toMatchObject({
    id: agent.id,
    name: "Deployment assistant",
    status: "active",
  });

  const activeDeleteResponse = await agentById.DELETE(
    new Request(`http://lore.local/api/agents/${agent.id}`, { method: "DELETE", headers }),
    agent.id,
  );
  expect(activeDeleteResponse.status).toBe(409);
  expect(activeDeleteResponse.headers.get("cache-control")).toBe("private, no-store");
  await expect(activeDeleteResponse.json()).resolves.toEqual({
    code: "invalid_request",
    error: "Disable Agent before deleting it",
  });

  const disabledResponse = await agentById.PATCH(
    new Request(`http://lore.local/api/agents/${agent.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "disabled" }),
    }),
    agent.id,
  );
  expect(disabledResponse.status).toBe(200);
  await expect(disabledResponse.json()).resolves.toMatchObject({ status: "disabled" });
  await expect(
    createAccessModule(testContext.database).authenticateAgent(
      secondCredential.token,
      workspace.id,
    ),
  ).resolves.toBeNull();
  expect(
    (
      await credentials.POST(
        new Request(`http://lore.local/api/agents/${agent.id}/credentials`, {
          method: "POST",
          headers,
        }),
        agent.id,
      )
    ).status,
  ).toBe(403);

  const reenabledResponse = await agentById.PATCH(
    new Request(`http://lore.local/api/agents/${agent.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "active" }),
    }),
    agent.id,
  );
  expect(reenabledResponse.status).toBe(200);
  await expect(
    createAccessModule(testContext.database).authenticateAgent(
      secondCredential.token,
      workspace.id,
    ),
  ).resolves.toMatchObject({ agentId: agent.id });

  await agentById.PATCH(
    new Request(`http://lore.local/api/agents/${agent.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "disabled" }),
    }),
    agent.id,
  );
  const deleteResponse = await agentById.DELETE(
    new Request(`http://lore.local/api/agents/${agent.id}`, { method: "DELETE", headers }),
    agent.id,
  );
  expect(deleteResponse.status).toBe(204);
  const afterDeleteResponse = await agents.GET(
    new Request("http://lore.local/api/agents", { headers }),
  );
  await expect(afterDeleteResponse.json()).resolves.not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: agent.id })]),
  );

  const missingResponse = await agentById.PATCH(
    new Request("http://lore.local/api/agents/30000000-0000-4000-8000-000000000099", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Missing assistant" }),
    }),
    "30000000-0000-4000-8000-000000000099",
  );
  expect(missingResponse.status).toBe(404);
  expect(missingResponse.headers.get("cache-control")).toBe("private, no-store");

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
