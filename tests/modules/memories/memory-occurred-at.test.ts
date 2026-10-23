import { afterEach, expect, test, vi } from "vitest";
import { createMemoryModule } from "@/modules/memories/service";
import { createApi } from "@/server/api/app";
import { installActorContext } from "@/server/auth/actor-context";
import { createMemoryTestContext } from "../../support/memory-context";

afterEach(() => vi.unstubAllEnvs());

/** A local-mode API over a fresh test database, with one Workspace of its own. */
async function datedApi() {
  vi.stubEnv("AUTH_MODE", "none");
  vi.stubEnv("ALLOW_INSECURE", "1");
  vi.stubEnv("LORE_LOCAL_SUBJECT", "occurred-at-user");
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
      body: JSON.stringify({ name: "Occurred" }),
    })
  ).json()) as { id: string };
  const headers = { "content-type": "application/json", "x-lore-workspace-id": workspace.id };
  return { app, context, headers };
}

test("HTTP writes, replays, changes, and removes when a Memory's event happened", async () => {
  const { app, context, headers } = await datedApi();
  try {
    const create = () =>
      app.request("/api/v1/memories", {
        method: "POST",
        headers: { ...headers, "idempotency-key": "dated-create" },
        body: JSON.stringify({
          content: "The launch moved to Friday.",
          occurredAt: "2023-05-26T18:00:00+08:00",
        }),
      });
    const created = await create();
    expect(created.status).toBe(201);
    const memory = (await created.json()) as {
      id: string;
      occurredAt: string | null;
      createdAt: string;
    };
    // Kept as its UTC instant, separate from when Lore recorded it.
    expect(memory.occurredAt).toBe("2023-05-26T10:00:00.000000Z");
    expect(memory.createdAt).not.toBe(memory.occurredAt);
    // A replay answers the same body, the time included.
    expect(await (await create()).json()).toEqual(memory);
    await expect(
      (await app.request(`/api/v1/memories/${memory.id}`, { headers })).json(),
    ).resolves.toMatchObject({ occurredAt: "2023-05-26T10:00:00.000000Z", version: 1 });

    // The same instant again, written with another offset, changes nothing.
    const same = await app.request(`/api/v1/memories/${memory.id}`, {
      method: "PATCH",
      headers: { ...headers, "if-match": '"memory-v1"' },
      body: JSON.stringify({ occurredAt: "2023-05-26T10:00:00Z" }),
    });
    expect(same.status).toBe(200);
    expect(same.headers.get("etag")).toBe('"memory-v1"');

    const moved = await app.request(`/api/v1/memories/${memory.id}`, {
      method: "PATCH",
      headers: { ...headers, "if-match": '"memory-v1"' },
      body: JSON.stringify({ occurredAt: "2023-05-27T09:30:00Z" }),
    });
    expect(moved.status).toBe(200);
    expect(moved.headers.get("etag")).toBe('"memory-v2"');
    await expect(moved.json()).resolves.toMatchObject({
      occurredAt: "2023-05-27T09:30:00.000000Z",
      content: "The launch moved to Friday.",
    });
    const listed = (await (await app.request("/api/v1/memories", { headers })).json()) as Array<{
      occurredAt: string | null;
    }>;
    expect(listed.map((item) => item.occurredAt)).toEqual(["2023-05-27T09:30:00.000000Z"]);
    const found = (await (
      await app.request("/api/v1/memories?q=launch%20Friday", { headers })
    ).json()) as Array<{ memory: { occurredAt: string | null } }>;
    expect(found.map((result) => result.memory.occurredAt)).toEqual([
      "2023-05-27T09:30:00.000000Z",
    ]);
    const packet = (await (
      await app.request("/api/v1/context/retrieve", {
        method: "POST",
        headers,
        body: JSON.stringify({ query: "When is the launch?", route: "memory-only" }),
      })
    ).json()) as { memories: Array<{ id: string; occurredAt: string | null }> };
    expect(packet.memories).toEqual([
      expect.objectContaining({ id: memory.id, occurredAt: "2023-05-27T09:30:00.000000Z" }),
    ]);

    const removed = await app.request(`/api/v1/memories/${memory.id}`, {
      method: "PATCH",
      headers: { ...headers, "if-match": '"memory-v2"' },
      body: JSON.stringify({ occurredAt: null }),
    });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({ occurredAt: null, version: 3 });
    // A Memory written without a time has none.
    const plain = await app.request("/api/v1/memories", {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "No time given." }),
    });
    await expect(plain.json()).resolves.toMatchObject({ occurredAt: null });
  } finally {
    await context.close();
  }
});

const FORMAT =
  "occurredAt must be an RFC 3339 date-time with an offset, such as 2023-05-26T10:00:00Z";

test.each([
  ["a date alone", "2023-05-26", FORMAT],
  ["no offset", "2023-05-26T10:00:00", FORMAT],
  ["a day the month lacks", "2023-02-29T00:00:00Z", FORMAT],
  ["prose", "last Friday", FORMAT],
  ["a five-digit year", "10000-01-01T00:00:00Z", FORMAT],
  [
    "an instant before year 1",
    "0001-01-01T00:30:00+01:00",
    "occurredAt must fall in the UTC years",
  ],
  ["a number", 1_685_095_200_000, "occurredAt must be a string"],
])(
  "HTTP refuses an occurredAt with %s as 400 invalid_request",
  async (_name, occurredAt, message) => {
    const { app, context, headers } = await datedApi();
    try {
      for (const request of [
        { method: "POST", path: "/api/v1/memories" },
        { method: "POST", path: "/api/v1/memory-proposals" },
      ]) {
        const refused = await app.request(request.path, {
          method: request.method,
          headers,
          body: JSON.stringify({ kind: "create", content: "A fact.", occurredAt }),
        });
        expect(refused.status, request.path).toBe(400);
        await expect(refused.json()).resolves.toMatchObject({
          code: "invalid_request",
          error: expect.stringContaining(message),
        });
      }
    } finally {
      await context.close();
    }
  },
);

test("a time is visible only with its Memory and moves with its scope", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  const secret = await memories.remember(context.alice, {
    content: "The vendor call slipped to Tuesday.",
    occurredAt: "2026-03-02T16:00:00Z",
    scope: "private",
  });
  const visible = async (actor: typeof context.alice) =>
    (await memories.search(actor, { query: "vendor call" })).map((result) => [
      result.memory.id,
      result.memory.occurredAt,
    ]);
  expect(await visible(context.alice)).toEqual([[secret.id, "2026-03-02T16:00:00.000000Z"]]);
  // A co-member sees neither the Memory nor its time; another Workspace sees nothing.
  expect(await visible(context.bob)).toEqual([]);
  expect(await visible(context.carol)).toEqual([]);
  // Sharing it shows the time with it; nothing about the time is stored apart from it.
  await memories.update(context.alice, secret.id, { scope: "shared" }, { expectedVersion: 1 });
  expect(await visible(context.bob)).toEqual([[secret.id, "2026-03-02T16:00:00.000000Z"]]);
  await context.close();
});

test("the outbox names occurred_at among the changed fields, and never the time", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  const memory = await memories.remember(context.alice, {
    content: "Buoys were repainted.",
    occurredAt: "2025-10-04T08:00:00Z",
  });
  await memories.update(
    context.alice,
    memory.id,
    { occurredAt: "2025-10-05T08:00:00Z" },
    { expectedVersion: 1 },
  );
  await memories.update(
    context.alice,
    memory.id,
    { occurredAt: null, content: "Buoys were repainted twice." },
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
    ["memory.updated", ["occurred_at"]],
    ["memory.updated", ["content", "occurred_at"]],
  ]);
  expect(JSON.stringify(events)).not.toMatch(/2025-10-0[45]/);
  await context.close();
});
