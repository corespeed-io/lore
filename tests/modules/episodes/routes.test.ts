import { afterEach, expect, test } from "vitest";
import { createApi } from "@/server/api/app";

import { createMemoryTestContext } from "../../support/memory-context";

afterEach(() => {
  for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT"]) {
    delete process.env[key];
  }
});

test("v1 records, pages, reads, and forgets an Episode without making Memory", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "episode-http-owner";
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
        body: JSON.stringify({ name: "Evidence Lab" }),
      }),
    )
  ).json()) as { id: string };
  const headers = {
    "idempotency-key": "episode-http-1",
    "x-lore-workspace-id": workspace.id,
  };
  const body = {
    kind: "conversation",
    observations: [
      {
        kind: "message",
        content: "Use the west entrance.",
        metadata: { role: "user" },
        observedAt: "2026-08-10T20:00:00Z",
      },
    ],
  };

  const recordedResponse = await app.request(
    new Request("http://lore.local/api/v1/episodes", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  const recorded = (await recordedResponse.json()) as {
    id: string;
    scope: string;
    observations: Array<{ content: string }>;
  };

  expect(recordedResponse.status).toBe(201);
  expect(recordedResponse.headers.get("cache-control")).toBe("private, no-store");
  expect(recorded).toMatchObject({
    scope: "private",
    observations: [{ content: "Use the west entrance." }],
  });
  const replay = await app.request(
    new Request("http://lore.local/api/v1/episodes", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  await expect(replay.json()).resolves.toMatchObject({ id: recorded.id });

  const listedResponse = await app.request(
    new Request("http://lore.local/api/v1/episodes?limit=1&kind=conversation&scope=private", {
      headers: { "x-lore-workspace-id": workspace.id },
    }),
  );
  expect(listedResponse.status).toBe(200);
  expect(listedResponse.headers.get("cache-control")).toBe("private, no-store");
  await expect(listedResponse.json()).resolves.toMatchObject([
    { id: recorded.id, observationCount: 1 },
  ]);

  const detailResponse = await app.request(
    new Request(`http://lore.local/api/v1/episodes/${recorded.id}`, {
      headers: { "x-lore-workspace-id": workspace.id },
    }),
  );
  expect(detailResponse.status).toBe(200);
  await expect(detailResponse.json()).resolves.toMatchObject({ id: recorded.id });

  const observationId = (await (
    await app.request(
      new Request(`http://lore.local/api/v1/episodes/${recorded.id}`, {
        headers: { "x-lore-workspace-id": workspace.id },
      }),
    )
  ).json()) as { observations: Array<{ id: string }> };
  const evidenceResponse = await app.request(
    new Request(`http://lore.local/api/v1/observations?id=${observationId.observations[0].id}`, {
      headers: { "x-lore-workspace-id": workspace.id },
    }),
  );
  expect(evidenceResponse.status).toBe(200);
  expect(evidenceResponse.headers.get("cache-control")).toBe("private, no-store");
  await expect(evidenceResponse.json()).resolves.toMatchObject([
    { id: observationId.observations[0].id, content: "Use the west entrance." },
  ]);

  const deletedResponse = await app.request(
    new Request(`http://lore.local/api/v1/episodes/${recorded.id}`, {
      method: "DELETE",
      headers: {
        "idempotency-key": "episode-forget-1",
        "x-lore-workspace-id": workspace.id,
      },
    }),
  );
  expect(deletedResponse.status).toBe(204);
  const missingResponse = await app.request(
    new Request(`http://lore.local/api/v1/episodes/${recorded.id}`, {
      headers: { "x-lore-workspace-id": workspace.id },
    }),
  );
  expect(missingResponse.status).toBe(404);

  await testContext.close();
});

test("Episode HTTP input is bounded and returns stable 400 responses", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "episode-http-validation";
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
        body: JSON.stringify({ name: "Evidence validation" }),
      }),
    )
  ).json()) as { id: string };
  const response = await app.request(
    new Request("http://lore.local/api/v1/episodes", {
      method: "POST",
      headers: { "x-lore-workspace-id": workspace.id },
      body: JSON.stringify({
        kind: "conversation",
        observations: [{ kind: "message", content: "ok", observedAt: 123 }],
      }),
    }),
  );

  expect(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  await expect(response.json()).resolves.toMatchObject({ code: "invalid_request" });

  const preservedContent = "  preserve raw spacing\n";
  const preservedResponse = await app.request(
    new Request("http://lore.local/api/v1/episodes", {
      method: "POST",
      headers: { "x-lore-workspace-id": workspace.id },
      body: JSON.stringify({
        kind: "conversation",
        observations: [{ kind: "message", content: preservedContent }],
      }),
    }),
  );
  expect(preservedResponse.status).toBe(201);
  await expect(preservedResponse.json()).resolves.toMatchObject({
    observations: [{ content: preservedContent }],
  });

  const invalidResponses = await Promise.all(
    [
      {
        kind: "conversation",
        observations: Array.from({ length: 11 }, () => ({
          kind: "message",
          content: "a".repeat(100_000),
        })),
      },
      {
        kind: "conversation",
        observations: [{ kind: "message", content: "invalid \ud800 content" }],
      },
      {
        kind: "conversation",
        observations: [
          { kind: "message", content: "valid content", metadata: { invalid: "\ud800" } },
        ],
      },
      {
        kind: "conversation",
        observations: Array.from({ length: 11 }, () => ({
          kind: "message",
          content: "valid content",
          metadata: { payload: "m".repeat(99_000) },
        })),
      },
    ].map((body) =>
      app.request(
        new Request("http://lore.local/api/v1/episodes", {
          method: "POST",
          headers: { "x-lore-workspace-id": workspace.id },
          body: JSON.stringify(body),
        }),
      ),
    ),
  );
  expect(invalidResponses.map((invalidResponse) => invalidResponse.status)).toEqual([
    400, 400, 400, 400,
  ]);
  for (const invalidResponse of invalidResponses) {
    await expect(invalidResponse.json()).resolves.toMatchObject({ code: "invalid_request" });
  }

  await testContext.close();
});

test("Episode metadata budgets use the original JSON representation", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "episode-http-json-budget";
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
        body: JSON.stringify({ name: "Evidence JSON budget" }),
      }),
    )
  ).json()) as { id: string };
  const manyKeys = Object.fromEntries(
    Array.from({ length: 9_000 }, (_, index) => [`k${index}`, index % 10]),
  );
  const manyValues = { values: Array.from({ length: 4_900 }, () => 0) };
  expect(JSON.stringify(manyKeys).length).toBeLessThan(100_000);
  expect(JSON.stringify(manyValues).length * 100).toBeLessThan(1_000_000);

  const responses = await Promise.all(
    [
      [{ kind: "event", content: "Many metadata keys.", metadata: manyKeys }],
      Array.from({ length: 100 }, () => ({
        kind: "event",
        content: "Many aggregate metadata values.",
        metadata: manyValues,
      })),
    ].map((observations) =>
      app.request(
        new Request("http://lore.local/api/v1/episodes", {
          method: "POST",
          headers: { "x-lore-workspace-id": workspace.id },
          body: JSON.stringify({ kind: "event", observations }),
        }),
      ),
    ),
  );

  expect(responses.map((response) => response.status)).toEqual([201, 201]);
  await testContext.close();
});
