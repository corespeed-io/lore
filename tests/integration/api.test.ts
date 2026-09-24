import { afterEach, expect, test } from "vitest";
import { createCodeIndexModule } from "@/modules/code/indexing/service";
import { createApi } from "@/server/api/app";
import { createAccessModule } from "@/server/auth/access";
import { createMemoryTestContext } from "../support/memory-context";

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
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });

  const workspaceResponse = await app.request(
    new Request("http://lore.local/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "HTTP Lab" }),
    }),
  );
  const workspace = (await workspaceResponse.json()) as { id: string };

  const createResponse = await app.request(
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
  const listResponse = await app.request(
    new Request("http://lore.local/api/memories", {
      headers: { "x-lore-workspace-id": workspace.id },
    }),
  );
  const listed = (await listResponse.json()) as Array<{ id: string }>;
  const graphResponse = await app.request(
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

test("Memory HTTP rejects document-sized content as an invalid request", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-memory-limit-user";
  const testContext = await createMemoryTestContext();
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });

  const workspaceResponse = await app.request(
    new Request("http://lore.local/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "Bounded Memory" }),
    }),
  );
  const workspace = (await workspaceResponse.json()) as { id: string };

  const response = await app.request(
    new Request("http://lore.local/api/memories", {
      method: "POST",
      headers: { "x-lore-workspace-id": workspace.id },
      body: JSON.stringify({ content: "x".repeat(32_001) }),
    }),
  );

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    code: "invalid_request",
    error: "Memory content may contain at most 32000 Unicode characters",
  });
  await testContext.close();
});

test("Memory Proposal HTTP freezes typed Code Evidence from an active Artifact", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-proposal-code-user";
  const testContext = await createMemoryTestContext();
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });

  const code = createCodeIndexModule(testContext.database);
  const workspaceResponse = await app.request(
    new Request("http://lore.local/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "HTTP Code Evidence" }),
    }),
  );
  const workspace = (await workspaceResponse.json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };
  const actorResponse = await app.request(
    new Request("http://lore.local/api/v1/actor", { headers }),
  );
  const actor = (await actorResponse.json()) as { userId: string };
  const commitOid = "7".repeat(40);
  await code.indexRevision(
    { userId: actor.userId, workspaceId: workspace.id },
    {
      repositoryKey: "corespeed/http-code-evidence",
      displayName: "HTTP Code Evidence",
      commitOid,
      files: [{ path: "src/http.ts", content: "export const httpGuard = true;\n" }],
    },
  );
  const [artifact] = await code.search(
    { userId: actor.userId, workspaceId: workspace.id },
    {
      repositoryKey: "corespeed/http-code-evidence",
      commitOid,
      query: "httpGuard",
    },
  );
  if (!artifact) throw new Error("Expected HTTP Code Artifact");

  const response = await app.request(
    new Request("http://lore.local/api/v1/memory-proposals", {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "create",
        content: "httpGuard protects the HTTP path.",
        codeEvidence: [{ artifactId: artifact.id, relationship: "implements" }],
      }),
    }),
  );

  expect(response.status).toBe(201);
  await expect(response.json()).resolves.toMatchObject({
    status: "pending",
    codeEvidence: [
      {
        citedArtifactId: artifact.id,
        citedCommitOid: commitOid,
        citedPath: "src/http.ts",
        citedContentSha256: artifact.contentSha256,
        relationship: "implements",
      },
    ],
  });
  await testContext.close();
});

test("Workspace portability HTTP is RLS-scoped, dry-runnable, and human-only", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-portability-user";
  const testContext = await createMemoryTestContext();
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });

  const createWorkspace = async (name: string) =>
    (await (
      await app.request(
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
    await app.request(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers: sourceHeaders,
        body: JSON.stringify({ content: "Source-only private Memory.", scope: "private" }),
      }),
    )
  ).json()) as { id: string };
  const targetMemory = (await (
    await app.request(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers: targetHeaders,
        body: JSON.stringify({ content: "Target-only shared Memory." }),
      }),
    )
  ).json()) as { id: string };

  const sourceExportResponse = await app.request(
    new Request("http://lore.local/api/v1/workspaces/export", { headers: sourceHeaders }),
  );
  const sourceArchive = (await sourceExportResponse.json()) as {
    manifest: { checksum: string };
    memories: Array<{ id: string; ownerUserId: string }>;
  };
  const targetArchive = (await (
    await app.request(
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
  const humanActorResponse = await app.request(
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
  const dryRunResponse = await app.request(
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
  const beforeImport = await app.request(
    new Request("http://lore.local/api/memories", { headers: targetHeaders }),
  );
  await expect(beforeImport.json()).resolves.toHaveLength(1);

  const agent = (await (
    await app.request(
      new Request("http://lore.local/api/v1/agents", {
        method: "POST",
        headers: sourceHeaders,
        body: JSON.stringify({ name: "Portability probe" }),
      }),
    )
  ).json()) as { id: string };
  const credential = (await (
    await app.request(
      new Request(`http://lore.local/api/v1/agents/${agent.id}/credentials`, {
        method: "POST",
        headers: sourceHeaders,
      }),
    )
  ).json()) as { token: string };
  const agentHeaders = {
    authorization: `Bearer ${credential.token}`,
    "x-lore-workspace-id": sourceWorkspace.id,
  };
  const [agentActor, agentExport, agentImport] = await Promise.all([
    app.request(new Request("http://lore.local/api/v1/actor", { headers: agentHeaders })),
    app.request(
      new Request("http://lore.local/api/v1/workspaces/export", { headers: agentHeaders }),
    ),
    app.request(
      new Request("http://lore.local/api/v1/workspaces/import", {
        method: "POST",
        headers: agentHeaders,
        body: JSON.stringify({ ...importBody, dryRun: true }),
      }),
    ),
  ]);
  expect([agentActor.status, agentExport.status, agentImport.status]).toEqual([403, 403, 403]);

  const importResponse = await app.request(
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
  const afterImport = await app.request(
    new Request("http://lore.local/api/memories", { headers: targetHeaders }),
  );
  await expect(afterImport.json()).resolves.toHaveLength(2);

  await testContext.close();
});

test("Memory HTTP rejects content that would create whitespace-only evidence", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-memory-whitespace-user";
  const testContext = await createMemoryTestContext();
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });

  const workspaceResponse = await app.request(
    new Request("http://lore.local/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "Indexable Memory" }),
    }),
  );
  const workspace = (await workspaceResponse.json()) as { id: string };

  const response = await app.request(
    new Request("http://lore.local/api/memories", {
      method: "POST",
      headers: { "x-lore-workspace-id": workspace.id },
      body: JSON.stringify({ content: `a${" ".repeat(3_000)}b` }),
    }),
  );

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    code: "invalid_request",
    error: "Memory content would produce a whitespace-only chunk and cannot be indexed safely",
  });
  const listResponse = await app.request(
    new Request("http://lore.local/api/memories", {
      headers: { "x-lore-workspace-id": workspace.id },
    }),
  );
  await expect(listResponse.json()).resolves.toEqual([]);

  await testContext.close();
});

test("Capabilities verifies Agent credentials and Workspace grants in the handler", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const agent = await access.createAgent(testContext.alice, { name: "Capabilities Agent" });
  await access.grantAgent(testContext.alice, agent.id, { permission: "read" });
  const credential = await access.issueAgentCredential(testContext.alice, agent.id);
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });

  const request = (token: string) =>
    new Request("http://lore.local/api/v1/capabilities", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-lore-workspace-id": testContext.alice.workspaceId,
      },
    });

  const accepted = await app.request(request(credential.token));
  const shapeOnly = await app.request(request(`lore_agent_${"0".repeat(64)}`));
  await access.revokeAgentCredential(testContext.alice, credential.id);
  const revoked = await app.request(request(credential.token));

  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("cache-control")).toBe("private, no-store");
  await expect(accepted.json()).resolves.toMatchObject({ schemaRevision: 4 });
  expect(shapeOnly.status).toBe(403);
  await expect(shapeOnly.json()).resolves.toMatchObject({ code: "access_denied" });
  expect(revoked.status).toBe(403);
});

test("Memory HTTP resource supports retrieve, update, and forget", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-resource-user";
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
        body: JSON.stringify({ name: "Resource Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };
  const created = (await (
    await app.request(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "Draft resource Memory." }),
      }),
    )
  ).json()) as { id: string };

  const updateResponse = await app.request(
    new Request(`http://lore.local/api/memories/${created.id}`, {
      method: "PATCH",
      headers: { ...headers, "if-match": '"memory-v1"' },
      body: JSON.stringify({ content: "Confirmed resource Memory.", scope: "private" }),
    }),
  );
  const getResponse = await app.request(
    new Request(`http://lore.local/api/memories/${created.id}`, { headers }),
  );
  const deleteResponse = await app.request(
    new Request(`http://lore.local/api/memories/${created.id}`, {
      method: "DELETE",
      headers: { ...headers, "if-match": '"memory-v2"' },
    }),
  );
  const missingResponse = await app.request(
    new Request(`http://lore.local/api/memories/${created.id}`, { headers }),
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
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });
  const workspace = (await (
    await app.request(
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

  const requestBody = JSON.stringify({ content: "Replay this HTTP Memory." });

  const createResponse = await app.request(
    new Request("http://lore.local/api/memories", { method: "POST", headers, body: requestBody }),
  );
  const created = (await createResponse.json()) as { id: string; version: number };
  const replayResponse = await app.request(
    new Request("http://lore.local/api/memories", { method: "POST", headers, body: requestBody }),
  );
  await expect(replayResponse.json()).resolves.toMatchObject({ id: created.id });
  expect(createResponse.headers.get("etag")).toBe('"memory-v1"');
  expect(replayResponse.status).toBe(201);

  const changedReplay = await app.request(
    new Request("http://lore.local/api/memories", {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "A different request." }),
    }),
  );
  await expect(changedReplay.json()).resolves.toMatchObject({ code: "idempotency_conflict" });
  expect(changedReplay.status).toBe(409);

  const missingPrecondition = await app.request(
    new Request(`http://lore.local/api/memories/${created.id}`, {
      method: "PATCH",
      headers: { "x-lore-workspace-id": workspace.id },
      body: JSON.stringify({ scope: "private" }),
    }),
  );
  expect(missingPrecondition.status).toBe(428);

  const staleWrite = await app.request(
    new Request(`http://lore.local/api/memories/${created.id}`, {
      method: "PATCH",
      headers: { "x-lore-workspace-id": workspace.id, "if-match": '"memory-v2"' },
      body: JSON.stringify({ scope: "private" }),
    }),
  );
  await expect(staleWrite.json()).resolves.toMatchObject({ code: "version_conflict" });
  expect(staleWrite.status).toBe(412);

  const updateResponse = await app.request(
    new Request(`http://lore.local/api/memories/${created.id}`, {
      method: "PATCH",
      headers: { "x-lore-workspace-id": workspace.id, "if-match": '"memory-v1"' },
      body: JSON.stringify({ scope: "private" }),
    }),
  );
  expect(updateResponse.headers.get("etag")).toBe('"memory-v2"');

  const deleteHeaders = {
    "x-lore-workspace-id": workspace.id,
    "if-match": '"memory-v2"',
    "idempotency-key": "memory-delete-replay",
  };
  const deleted = await app.request(
    new Request(`http://lore.local/api/memories/${created.id}`, {
      method: "DELETE",
      headers: deleteHeaders,
    }),
  );
  const deleteReplay = await app.request(
    new Request(`http://lore.local/api/memories/${created.id}`, {
      method: "DELETE",
      headers: deleteHeaders,
    }),
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
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });
  const workspace = (await (
    await app.request(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Cursor Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };

  const memoryIds: string[] = [];
  for (const content of ["First cursor Memory.", "Second cursor Memory.", "Third cursor Memory."]) {
    const response = await app.request(
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
      await transaction.query(
        `UPDATE memories
         SET updated_at = $2::timestamptz
         WHERE id = $1`,
        [memoryId, `2026-08-07T12:00:00.12345${6 - index}Z`],
      );
    }
  });

  const firstPage = await app.request(
    new Request("http://lore.local/api/memories?limit=2", { headers }),
  );
  const cursor = firstPage.headers.get("x-lore-next-cursor");
  expect(cursor).toBeTruthy();
  const firstPageMemories = (await firstPage.json()) as Array<{ id: string }>;
  expect(firstPageMemories).toHaveLength(2);
  await testContext.adminDatabase.transaction((transaction) =>
    transaction.query(
      `UPDATE memories
       SET updated_at = '2026-08-07T13:00:00Z'
       WHERE id = $1`,
      [firstPageMemories[1].id],
    ),
  );
  const secondPage = await app.request(
    new Request(`http://lore.local/api/memories?limit=2&cursor=${cursor}`, { headers }),
  );
  await expect(secondPage.json()).resolves.toEqual([expect.objectContaining({ id: memoryIds[2] })]);
  expect(secondPage.headers.get("x-lore-next-cursor")).toBeNull();
  await testContext.close();
});

test("HTTP routes reject malformed UUIDs before Postgres", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  const testContext = await createMemoryTestContext();
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });
  const responses = await Promise.all([
    app.request("/api/v1/memories/not-a-uuid"),
    app.request("/api/v1/agents/not-a-uuid/credentials", { method: "POST" }),
    app.request("/api/v1/agent-credentials/not-a-uuid", { method: "DELETE" }),
    app.request("/api/v1/agents/not-a-uuid/grant", { method: "DELETE" }),
    app.request("/api/v1/evaluations/suites/not-a-uuid/runs", { method: "POST" }),
    app.request("/api/v1/evaluations/runs/not-a-uuid"),
    app.request(
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
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });

  const workspace = (await (
    await app.request(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Input Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };

  const responses = await Promise.all([
    app.request(new Request("http://lore.local/api/memories?q=%00secret", { headers })),
    app.request(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "before\0after" }),
      }),
    ),
    app.request(
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
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });
  const workspace = (await (
    await app.request(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Filter Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };

  const responses = await Promise.all([
    app.request(
      new Request("http://lore.local/api/memories?q=atlas&updated_after=not-a-date", {
        headers,
      }),
    ),
    app.request(
      new Request(
        "http://lore.local/api/memories?q=atlas&updated_after=2026-02-01T00%3A00%3A00Z&updated_before=2026-01-01T00%3A00%3A00Z",
        { headers },
      ),
    ),
    app.request(new Request("http://lore.local/api/memories?q=atlas&scope=workspace", { headers })),
    app.request(
      new Request("http://lore.local/api/memories?q=atlas&metadata=%7Bnot-json", { headers }),
    ),
    app.request(
      new Request("http://lore.local/api/memories?q=atlas&metadata=%5B1%2C2%5D", { headers }),
    ),
    app.request(new Request("http://lore.local/api/memories?limit=1.5", { headers })),
    app.request(new Request("http://lore.local/api/memories?limit=0", { headers })),
    app.request(new Request("http://lore.local/api/memories?offset=-1", { headers })),
    app.request(new Request("http://lore.local/api/memories?offset=1000001", { headers })),
  ]);

  expect(responses.map((response) => response.status)).toEqual([
    400, 400, 400, 400, 400, 400, 400, 400, 400,
  ]);
  await testContext.close();
});

test("Memory HTTP metadata accepts nested JSON and rejects excessive size", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-metadata-limits-user";
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
        body: JSON.stringify({ name: "Metadata Limits Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };

  let nested: Record<string, unknown> = { leaf: true };
  for (let depth = 0; depth < 34; depth += 1) nested = { child: nested };

  const responses = await Promise.all([
    app.request(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "deep", metadata: nested }),
      }),
    ),
    app.request(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "large", metadata: { value: "x".repeat(100_001) } }),
      }),
    ),
    ...[{ value: "bad\0" }, { value: "bad\ud800" }, { "bad\ud800": true }].map((metadata) =>
      app.request(
        new Request("http://lore.local/api/memories", {
          method: "POST",
          headers,
          body: JSON.stringify({ content: "invalid database text", metadata }),
        }),
      ),
    ),
  ]);

  expect(responses.map((response) => response.status)).toEqual([201, 400, 400, 400, 400]);
  const memory = (await responses[0]?.json()) as { id: string; version: number };

  // Exercise parser stack exhaustion under Bun while staying below the size limit.
  for (const nestedJson of [
    `${"[".repeat(40_000)}0${"]".repeat(40_000)}`,
    `${'{"x":'.repeat(16_000)}0${"}".repeat(16_000)}`,
  ]) {
    const body = `{"content":"must not be saved","metadata":{"value":${nestedJson}}}`;
    expect(body.length).toBeLessThan(100_000);
    const invalidResponses = await Promise.all([
      app.request(new Request("http://lore.local/api/memories", { method: "POST", headers, body })),
      app.request(
        new Request(`http://lore.local/api/memories/${memory.id}`, {
          method: "PATCH",
          headers: { ...headers, "if-match": `"memory-v${memory.version}"` },
          body,
        }),
      ),
    ]);
    for (const response of invalidResponses) {
      expect(response.status, `Nested JSON payload: ${nestedJson.length} characters`).toBe(400);
      expect(await response.json()).toEqual({
        code: "invalid_request",
        error: "Memory input is too deeply nested",
      });
    }
  }
  const stored = await app.request(new Request("http://lore.local/api/memories", { headers }));
  expect(await stored.json()).toEqual([
    expect.objectContaining({ id: memory.id, version: memory.version, content: "deep" }),
  ]);
  await testContext.close();
});

test("Agent HTTP resource provisions a grant and issues a revocable one-time token", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "http-agent-user";
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
        body: JSON.stringify({ name: "Agent Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };

  const createResponse = await app.request(
    new Request("http://lore.local/api/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Recall assistant", permission: "write" }),
    }),
  );
  const agent = (await createResponse.json()) as { id: string; permission: string };
  const listResponse = await app.request(new Request("http://lore.local/api/agents", { headers }));
  const defaultPermissionResponse = await app.request(
    new Request("http://lore.local/api/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Default reader" }),
    }),
  );
  const defaultPermissionAgent = (await defaultPermissionResponse.json()) as {
    permission: string;
  };
  const credentialResponse = await app.request(
    new Request(`http://lore.local/api/agents/${agent.id}/credentials`, {
      method: "POST",
      headers,
    }),
  );
  const credential = (await credentialResponse.json()) as { id: string; token: string };
  const credentialListResponse = await app.request(
    new Request(`http://lore.local/api/agents/${agent.id}/credentials`, { headers }),
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

  const revokeCredentialResponse = await app.request(
    new Request(`http://lore.local/api/agent-credentials/${credential.id}`, {
      method: "DELETE",
      headers,
    }),
  );
  expect(revokeCredentialResponse.status).toBe(204);

  const secondCredential = (await (
    await app.request(
      new Request(`http://lore.local/api/agents/${agent.id}/credentials`, {
        method: "POST",
        headers,
      }),
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
    app.request(new Request("http://lore.local/api/agents", { headers: agentHeaders })),
    app.request(
      new Request("http://lore.local/api/agents", {
        method: "POST",
        headers: agentHeaders,
        body: JSON.stringify({ name: "Forbidden assistant", permission: "read" }),
      }),
    ),
    app.request(
      new Request(`http://lore.local/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: agentHeaders,
        body: JSON.stringify({ name: "Forbidden rename" }),
      }),
    ),
    app.request(
      new Request(`http://lore.local/api/agents/${agent.id}`, {
        method: "DELETE",
        headers: agentHeaders,
      }),
    ),
    app.request(
      new Request(`http://lore.local/api/agents/${agent.id}/credentials`, {
        headers: agentHeaders,
      }),
    ),
    app.request(
      new Request(`http://lore.local/api/agents/${agent.id}/credentials`, {
        method: "POST",
        headers: agentHeaders,
      }),
    ),
    app.request(
      new Request(`http://lore.local/api/agent-credentials/${credential.id}`, {
        method: "DELETE",
        headers: agentHeaders,
      }),
    ),
    app.request(
      new Request(`http://lore.local/api/agents/${agent.id}/grant`, {
        method: "PUT",
        headers: agentHeaders,
        body: JSON.stringify({ permission: "read" }),
      }),
    ),
    app.request(
      new Request(`http://lore.local/api/agents/${agent.id}/grant`, {
        method: "DELETE",
        headers: agentHeaders,
      }),
    ),
  ]);
  expect(forbiddenAdministrationResponses.map((response) => response.status)).toEqual(
    Array(9).fill(403),
  );

  const revokeGrantResponse = await app.request(
    new Request(`http://lore.local/api/agents/${agent.id}/grant`, {
      method: "DELETE",
      headers,
    }),
  );
  expect(revokeGrantResponse.status).toBe(204);
  await expect(
    createAccessModule(testContext.database).authenticateAgent(
      secondCredential.token,
      workspace.id,
    ),
  ).resolves.toBeNull();

  const invalidRestoreResponse = await app.request(
    new Request(`http://lore.local/api/agents/${agent.id}/grant`, {
      method: "PUT",
      headers,
      body: JSON.stringify({}),
    }),
  );
  expect(invalidRestoreResponse.status).toBe(400);
  await expect(invalidRestoreResponse.json()).resolves.toEqual({
    code: "invalid_request",
    error: "permission must be read or write",
  });
  const afterInvalidRestoreResponse = await app.request(
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

  const restoreGrantResponse = await app.request(
    new Request(`http://lore.local/api/agents/${agent.id}/grant`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ permission: "read" }),
    }),
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
    app.request(
      new Request(`http://lore.local/api/agents/${agent.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({}),
      }),
    ),
    app.request(
      new Request(`http://lore.local/api/agents/${agent.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "paused" }),
      }),
    ),
    app.request(
      new Request("http://lore.local/api/agents/not-a-uuid", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "Invalid identifier" }),
      }),
    ),
    app.request(
      new Request(`http://lore.local/api/agents/${agent.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "Should not apply", permission: "write" }),
      }),
    ),
  ]);
  expect(invalidLifecycleResponses.map((response) => response.status)).toEqual([
    400, 400, 400, 400,
  ]);
  await expect(invalidLifecycleResponses[3]?.json()).resolves.toEqual({
    code: "invalid_request",
    error: "permission is not a supported Agent field",
  });

  const renamedResponse = await app.request(
    new Request(`http://lore.local/api/agents/${agent.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Deployment assistant" }),
    }),
  );
  expect(renamedResponse.status).toBe(200);
  expect(renamedResponse.headers.get("cache-control")).toBe("private, no-store");
  await expect(renamedResponse.json()).resolves.toMatchObject({
    id: agent.id,
    name: "Deployment assistant",
    status: "active",
  });

  const activeDeleteResponse = await app.request(
    new Request(`http://lore.local/api/agents/${agent.id}`, { method: "DELETE", headers }),
  );
  expect(activeDeleteResponse.status).toBe(409);
  expect(activeDeleteResponse.headers.get("cache-control")).toBe("private, no-store");
  await expect(activeDeleteResponse.json()).resolves.toEqual({
    code: "invalid_request",
    error: "Disable Agent before deleting it",
  });

  const disabledResponse = await app.request(
    new Request(`http://lore.local/api/agents/${agent.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "disabled" }),
    }),
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
      await app.request(
        new Request(`http://lore.local/api/agents/${agent.id}/credentials`, {
          method: "POST",
          headers,
        }),
      )
    ).status,
  ).toBe(403);

  const reenabledResponse = await app.request(
    new Request(`http://lore.local/api/agents/${agent.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "active" }),
    }),
  );
  expect(reenabledResponse.status).toBe(200);
  await expect(
    createAccessModule(testContext.database).authenticateAgent(
      secondCredential.token,
      workspace.id,
    ),
  ).resolves.toMatchObject({ agentId: agent.id });

  await app.request(
    new Request(`http://lore.local/api/agents/${agent.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "disabled" }),
    }),
  );
  const deleteResponse = await app.request(
    new Request(`http://lore.local/api/agents/${agent.id}`, { method: "DELETE", headers }),
  );
  expect(deleteResponse.status).toBe(204);
  const afterDeleteResponse = await app.request(
    new Request("http://lore.local/api/agents", { headers }),
  );
  await expect(afterDeleteResponse.json()).resolves.not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: agent.id })]),
  );

  const missingResponse = await app.request(
    new Request("http://lore.local/api/agents/30000000-0000-4000-8000-000000000099", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Missing assistant" }),
    }),
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
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });

  const workspace = (await (
    await app.request(
      new Request("http://lore.local/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Evaluation Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = { "x-lore-workspace-id": workspace.id };
  const memory = (await (
    await app.request(
      new Request("http://lore.local/api/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "Mercury is the closest planet to the Sun." }),
      }),
    )
  ).json()) as { id: string };
  const suiteResponse = await app.request(
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
  const runResponse = await app.request(
    new Request(`http://lore.local/api/evaluations/suites/${suite.id}/runs`, {
      method: "POST",
      headers,
    }),
  );
  const run = (await runResponse.json()) as { id: string; status: string };
  const getResponse = await app.request(
    new Request(`http://lore.local/api/evaluations/runs/${run.id}`, { headers }),
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
