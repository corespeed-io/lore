import { afterEach, expect, test, vi } from "vitest";
import { createMemoryModule } from "@/modules/memories/service";
import { createApi } from "@/server/api/app";
import { installActorContext } from "@/server/auth/actor-context";
import { createMemoryTestContext } from "../../support/memory-context";

afterEach(() => vi.unstubAllEnvs());

/** A local-mode API over a fresh test database, with one Workspace of its own. */
async function titledApi() {
  vi.stubEnv("AUTH_MODE", "none");
  vi.stubEnv("ALLOW_INSECURE", "1");
  vi.stubEnv("LORE_LOCAL_SUBJECT", "title-user");
  const context = await createMemoryTestContext();
  const app = createApi({
    database: () => context.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });
  const workspace = (await (
    await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Titles" }),
    })
  ).json()) as { id: string };
  const headers = { "content-type": "application/json", "x-lore-workspace-id": workspace.id };
  return { app, context, headers };
}

test("HTTP writes, trims, replays, changes, and removes a title", async () => {
  const { app, context, headers } = await titledApi();
  try {
    const create = () =>
      app.request("/api/v1/memories", {
        method: "POST",
        headers: { ...headers, "idempotency-key": "titled-create" },
        body: JSON.stringify({ content: "Pools open per request.", title: "  Pooling plan  " }),
      });
    const created = await create();
    expect(created.status).toBe(201);
    const memory = (await created.json()) as { id: string; title: string | null };
    // HTTP trims a title as it trims content.
    expect(memory.title).toBe("Pooling plan");
    // A replay answers the same body, title included.
    expect(await (await create()).json()).toEqual(memory);
    await expect(
      (await app.request(`/api/v1/memories/${memory.id}`, { headers })).json(),
    ).resolves.toMatchObject({ title: "Pooling plan", version: 1 });

    const renamed = await app.request(`/api/v1/memories/${memory.id}`, {
      method: "PATCH",
      headers: { ...headers, "if-match": '"memory-v1"' },
      body: JSON.stringify({ title: "Hyperdrive pooling plan" }),
    });
    expect(renamed.status).toBe(200);
    expect(renamed.headers.get("etag")).toBe('"memory-v2"');
    await expect(renamed.json()).resolves.toMatchObject({
      title: "Hyperdrive pooling plan",
      content: "Pools open per request.",
    });
    const listed = (await (await app.request("/api/v1/memories", { headers })).json()) as Array<{
      title: string | null;
    }>;
    expect(listed.map((item) => item.title)).toEqual(["Hyperdrive pooling plan"]);

    const removed = await app.request(`/api/v1/memories/${memory.id}`, {
      method: "PATCH",
      headers: { ...headers, "if-match": '"memory-v2"' },
      body: JSON.stringify({ title: null }),
    });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({ title: null, version: 3 });
  } finally {
    await context.close();
  }
});

test.each([
  ["a line break", "Two\nlines", "title must be one line without control characters"],
  ["a tab", "a\tb", "title must be one line without control characters"],
  ["only whitespace", " \u3000 ", "title must contain a character that is not whitespace"],
  ["too many characters", "🧭".repeat(257), "title may contain at most 256 characters"],
  ["a number", 42, "title must be a string"],
])("HTTP refuses a title with %s as 400 invalid_request", async (_name, title, message) => {
  const { app, context, headers } = await titledApi();
  try {
    const refused = await app.request("/api/v1/memories", {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "A fact.", title }),
    });
    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({
      code: "invalid_request",
      error: expect.stringContaining(message),
    });
  } finally {
    await context.close();
  }
});

test("search finds a Memory by its title, only where the caller may see it", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  // No word of either title appears in its content.
  const shared = await memories.remember(context.alice, {
    content: "Pools open per request.",
    title: "Hyperdrive pooling rollout",
  });
  const secret = await memories.remember(context.alice, {
    content: "Two attempts, then page.",
    title: "Hyperdrive escalation secrets",
    scope: "private",
  });
  const cjk = await memories.remember(context.alice, {
    content: "周日深夜执行。",
    title: "数据库每周备份计划",
  });
  const ids = async (actor: typeof context.alice, query: string) =>
    (await memories.search(actor, { query })).map((result) => result.memory.id);

  expect(await ids(context.alice, "Hyperdrive")).toEqual(
    expect.arrayContaining([shared.id, secret.id]),
  );
  expect(await ids(context.alice, "how is the pooling rollout going")).toContain(shared.id);
  // CJK titles match as CJK content does: by two or more of the query's 3-grams.
  expect(await ids(context.alice, "数据库每周备份")).toEqual([cjk.id]);
  // A co-member never finds a private Memory by its title; another Workspace finds nothing.
  expect(await ids(context.bob, "Hyperdrive")).toEqual([shared.id]);
  expect(await ids(context.bob, "escalation secrets")).toEqual([]);
  expect(await ids(context.carol, "Hyperdrive")).toEqual([]);
  // A title answers its Memory's first chunk, which search returns as evidence.
  const [hit] = await memories.search(context.alice, { query: "pooling rollout" });
  expect(hit).toMatchObject({ evidence: "Pools open per request." });
  await context.close();
});

test("the outbox names title and gloss among the changed fields, and never their text", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  const memory = await memories.remember(context.alice, {
    content: "Buoys are repainted before winter.",
    title: "Buoy paint",
  });
  await memories.update(
    context.alice,
    memory.id,
    { title: "Buoy repaint schedule" },
    { expectedVersion: 1 },
  );
  await memories.update(
    context.alice,
    memory.id,
    { title: null, content: "Buoys are repainted every autumn." },
    { expectedVersion: 2 },
  );
  const events = await context.database.transaction(async (transaction) => {
    installActorContext(transaction, context.alice);
    const result = await transaction.query<Record<string, unknown>>(
      "SELECT * FROM memory_events WHERE resource_id = $1 ORDER BY sequence",
      [memory.id],
    );
    return result.rows;
  });
  expect(events.map((event) => [event.event_type, event.changed_fields])).toEqual([
    ["memory.created", ["content", "metadata", "scope", "title", "gloss", "occurred_at"]],
    ["memory.updated", ["title"]],
    ["memory.updated", ["content", "title"]],
  ]);
  expect(JSON.stringify(events)).not.toContain("Buoy");
  await context.close();
});

test("HTTP writes, trims, changes, and removes an English gloss", async () => {
  const { app, context, headers } = await titledApi();
  try {
    const created = await app.request("/api/v1/memories", {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: "部署失败后先回滚，再排查。",
        title: "失败部署的处理",
        gloss: "  Roll back a failed deploy first, then investigate  ",
      }),
    });
    expect(created.status).toBe(201);
    const memory = (await created.json()) as { id: string; gloss: string | null };
    expect(memory.gloss).toBe("Roll back a failed deploy first, then investigate");

    const removed = await app.request(`/api/v1/memories/${memory.id}`, {
      method: "PATCH",
      headers: { ...headers, "if-match": '"memory-v1"' },
      body: JSON.stringify({ gloss: null }),
    });
    await expect(removed.json()).resolves.toMatchObject({
      gloss: null,
      title: "失败部署的处理",
      version: 2,
    });

    for (const [gloss, message] of [
      ["Two\nlines", "gloss must be one line without control characters"],
      ["x".repeat(513), "gloss may contain at most 512 characters"],
    ] as const) {
      const refused = await app.request("/api/v1/memories", {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "A fact.", gloss }),
      });
      expect(refused.status).toBe(400);
      await expect(refused.json()).resolves.toMatchObject({
        error: expect.stringContaining(message),
      });
    }
  } finally {
    await context.close();
  }
});

test("an English query finds a Memory in another language by its gloss, where visible", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  const glossed = await memories.remember(context.alice, {
    content: "部署失败后先回滚，再排查。",
    gloss: "Roll back a failed deploy first, then investigate",
  });
  const unglossed = await memories.remember(context.alice, {
    content: "回滚之后要通知值班的人。",
  });
  const secret = await memories.remember(context.alice, {
    content: "私人的回滚记录。",
    gloss: "Private log of each roll back",
    scope: "private",
  });
  const ids = async (actor: typeof context.alice, query: string) =>
    (await memories.search(actor, { query })).map((result) => result.memory.id);

  // Without an embedding provider only lexical channels run: English reaches a
  // Chinese Memory through its gloss alone.
  expect(await ids(context.alice, "what do we do after a failed deploy")).toEqual([glossed.id]);
  expect(await ids(context.alice, "roll back")).toEqual(
    expect.arrayContaining([glossed.id, secret.id]),
  );
  expect(await ids(context.alice, "roll back")).not.toContain(unglossed.id);
  // The Chinese content still answers Chinese queries, as before.
  expect(await ids(context.alice, "部署失败")).toEqual([glossed.id]);
  // A co-member finds the shared gloss but never the private one; another Workspace
  // finds neither.
  expect(await ids(context.bob, "roll back")).toEqual([glossed.id]);
  expect(await ids(context.carol, "roll back")).toEqual([]);
  // A gloss answers its Memory's first chunk, whose text search returns as evidence.
  const [hit] = await memories.search(context.alice, { query: "failed deploy" });
  expect(hit).toMatchObject({ evidence: "部署失败后先回滚，再排查。" });
  await context.close();
});
