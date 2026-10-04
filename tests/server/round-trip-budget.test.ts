import type { EmbeddingProvider, MemoryModuleOptions } from "@corespeed/lore-core";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, expect, test, vi } from "vitest";
import { createApi } from "@/server/api/app";
import { createPostgresDatabase } from "@/server/database/postgres";
import { createAccessModule } from "../support/access";
import { createMemoryTestContext } from "../support/memory-context";

// The real OSS adapter over the test's PGlite session. Only pg's socket is
// replaced; it counts statements, and a network wait whenever a statement goes out
// while nothing else is in flight, which is what pipelining saves.
const driver = vi.hoisted(() => ({
  postgres: undefined as PGlite | undefined,
  inFlight: 0,
  statements: 0,
  waits: 0,
}));

vi.mock("pg", () => ({
  Pool: class {
    on() {
      return this;
    }

    async connect() {
      return {
        async query(sql: string, params: unknown[] = []) {
          if (!driver.postgres) throw new Error("No PGlite session");
          driver.statements += 1;
          if (driver.inFlight === 0) driver.waits += 1;
          driver.inFlight += 1;
          try {
            return await driver.postgres.query(sql, params);
          } finally {
            driver.inFlight -= 1;
          }
        },
        release() {},
      };
    }

    async end() {}
  },
}));

afterEach(() => {
  for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT"]) {
    delete process.env[key];
  }
});

interface Measured {
  status: number;
  statements: number;
  waits: number;
  body: unknown;
}

async function budgetFixture(memoryOptions: MemoryModuleOptions = {}) {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "budget-human";
  const context = await createMemoryTestContext();
  driver.postgres = context.postgres;
  const database = createPostgresDatabase({});
  const app = createApi({
    database: () => database,
    memoryOptions: () => memoryOptions,
    codeRepositories: () => ({}),
  });

  async function measure(path: string, init: RequestInit = {}): Promise<Measured> {
    driver.statements = 0;
    driver.waits = 0;
    const response = await app.request(`http://lore.local${path}`, init);
    const text = await response.text();
    return {
      status: response.status,
      statements: driver.statements,
      waits: driver.waits,
      body: text ? JSON.parse(text) : null,
    };
  }

  const registered = await measure("/api/workspaces");
  const created = await measure("/api/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Budget Lab" }),
  });
  const workspaceId = (created.body as { id: string }).id;
  const actor = await measure("/api/v1/actor", { headers: { "x-lore-workspace-id": workspaceId } });
  const userId = (actor.body as { userId: string }).userId;
  return { context, measure, registered, workspaceId, userId, actor };
}

const cost = ({ status, statements, waits }: Measured) => ({ status, statements, waits });

test("hot human routes admit as a prefix: reads take one round trip, keyed writes two", async () => {
  const { measure, workspaceId, registered, actor } = await budgetFixture();
  const headers = { "x-lore-workspace-id": workspaceId };
  const json = { ...headers, "content-type": "application/json" };

  // A never-seen human registers within the Workspace list's own round trip.
  expect(cost(registered)).toEqual({ status: 200, statements: 5, waits: 1 });
  expect(cost(actor)).toEqual({ status: 200, statements: 5, waits: 1 });

  const remembered = await measure("/api/v1/memories", {
    method: "POST",
    headers: { ...json, "idempotency-key": "budget-create" },
    body: JSON.stringify({ content: "The harbor observatory opens at dawn." }),
  });
  const memory = remembered.body as { id: string; version: number };
  const replayed = await measure("/api/v1/memories", {
    method: "POST",
    headers: { ...json, "idempotency-key": "budget-create" },
    body: JSON.stringify({ content: "The harbor observatory opens at dawn." }),
  });
  const target = await measure("/api/v1/memories", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ content: "The midnight shift logs the tides." }),
  });
  const targetId = (target.body as { id: string }).id;

  const budgets = {
    remember: cost(remembered),
    replay: cost(replayed),
    rememberUnkeyed: cost(target),
    retrieve: cost(await measure(`/api/v1/memories/${memory.id}`, { headers })),
    list: cost(await measure("/api/v1/memories", { headers })),
    search: cost(await measure("/api/v1/memories?q=harbor%20observatory", { headers })),
    update: cost(
      await measure(`/api/v1/memories/${memory.id}`, {
        method: "PATCH",
        headers: { ...json, "if-match": '"memory-v1"', "idempotency-key": "budget-update" },
        body: JSON.stringify({ content: "The harbor observatory opens at midnight." }),
      }),
    ),
    link: cost(
      await measure(`/api/v1/memories/${memory.id}/links/${targetId}`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({}),
      }),
    ),
    links: cost(await measure(`/api/v1/memories/${memory.id}/links`, { headers })),
    graph: cost(await measure("/api/v1/graph", { headers })),
    unlink: cost(
      await measure(`/api/v1/memories/${memory.id}/links/${targetId}`, {
        method: "DELETE",
        headers,
      }),
    ),
    forget: cost(
      await measure(`/api/v1/memories/${memory.id}`, {
        method: "DELETE",
        headers: { ...headers, "if-match": '"memory-v2"', "idempotency-key": "budget-forget" },
      }),
    ),
    forgetUnkeyed: cost(
      await measure(`/api/v1/memories/${targetId}`, {
        method: "DELETE",
        headers: { ...headers, "if-match": '"memory-v1"' },
      }),
    ),
  };

  expect(budgets).toEqual({
    // BEGIN, role, admission (2), request id, claim and lookup; then the insert, its
    // chunks, the ledger completion, and COMMIT.
    remember: { status: 201, statements: 11, waits: 2 },
    replay: { status: 201, statements: 8, waits: 2 },
    rememberUnkeyed: { status: 201, statements: 8, waits: 2 },
    retrieve: { status: 200, statements: 6, waits: 1 },
    list: { status: 200, statements: 6, waits: 1 },
    search: { status: 200, statements: 6, waits: 1 },
    // The locking read travels with the stored-chunk read the diff needs.
    update: { status: 200, statements: 14, waits: 2 },
    link: { status: 201, statements: 8, waits: 2 },
    links: { status: 200, statements: 7, waits: 1 },
    graph: { status: 200, statements: 7, waits: 1 },
    unlink: { status: 204, statements: 7, waits: 1 },
    forget: { status: 204, statements: 11, waits: 2 },
    forgetUnkeyed: { status: 204, statements: 8, waits: 1 },
  });
});

test("hot Agent routes admit as a prefix, except where a snapshot or a provider needs it first", async () => {
  const { context, measure, workspaceId, userId } = await budgetFixture();
  const access = createAccessModule(context.database);
  const owner = { workspaceId, userId };
  const agent = await access.createAgentForWorkspace(owner, {
    name: "Budget Agent",
    permission: "write",
  });
  const credential = await access.issueAgentCredential(owner, agent.id);
  const headers = {
    "x-lore-workspace-id": workspaceId,
    authorization: `Bearer ${credential.token}`,
  };
  const json = { ...headers, "content-type": "application/json" };

  const remembered = await measure("/api/v1/memories", {
    method: "POST",
    headers: { ...json, "idempotency-key": "agent-create" },
    body: JSON.stringify({ content: "The agent filed the tide table." }),
  });
  const memory = remembered.body as { id: string; createdByAgentId: string };
  expect(memory.createdByAgentId).toBe(agent.id);

  expect({
    remember: cost(remembered),
    retrieve: cost(await measure(`/api/v1/memories/${memory.id}`, { headers })),
    search: cost(await measure("/api/v1/memories?q=tide%20table", { headers })),
    // The Graph reads one read-only snapshot, so the Agent is admitted before it.
    graph: cost(await measure("/api/v1/graph", { headers })),
    forget: cost(
      await measure(`/api/v1/memories/${memory.id}`, {
        method: "DELETE",
        headers: { ...headers, "if-match": '"memory-v1"', "idempotency-key": "agent-forget" },
      }),
    ),
  }).toEqual({
    remember: { status: 201, statements: 10, waits: 2 },
    retrieve: { status: 200, statements: 5, waits: 1 },
    search: { status: 200, statements: 5, waits: 1 },
    graph: { status: 200, statements: 9, waits: 2 },
    forget: { status: 204, statements: 10, waits: 2 },
  });
});

test("a refused Actor answers 403 and writes nothing", async () => {
  const { context, measure, workspaceId } = await budgetFixture();
  const other = { "x-lore-workspace-id": context.alice.workspaceId };
  const unknownAgent = {
    "x-lore-workspace-id": workspaceId,
    authorization: `Bearer lore_agent_${"0".repeat(64)}`,
  };

  expect(cost(await measure("/api/v1/memories", { headers: other }))).toEqual({
    status: 403,
    statements: 6,
    waits: 1,
  });
  expect(
    cost(
      await measure("/api/v1/memories", {
        method: "POST",
        headers: { ...other, "content-type": "application/json", "idempotency-key": "refused" },
        body: JSON.stringify({ content: "A non-member's write." }),
      }),
    ),
    // The claim travelled with the admission and is rolled back: ROLLBACK is the second.
  ).toMatchObject({ status: 403, waits: 2 });
  expect(cost(await measure("/api/v1/memories", { headers: unknownAgent }))).toMatchObject({
    status: 403,
    waits: 1,
  });
  const written = await context.adminDatabase.transaction((transaction) =>
    transaction.query<{ memories: number; claims: number }>(
      `SELECT (SELECT count(*)::integer FROM memories WHERE workspace_id = $1) AS memories,
              (SELECT count(*)::integer FROM request_idempotency_records) AS claims`,
      [context.alice.workspaceId],
    ),
  );
  expect(written.rows[0]).toEqual({ memories: 0, claims: 0 });
});

const embeddings: EmbeddingProvider = {
  provider: "fixture",
  model: "budget-v1",
  revision: "fixture-v1",
  dimensions: 1024,
  async embed(texts) {
    return texts.map(() => Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0)));
  },
};

test("search configurations stay within their budgets for humans and Agents", async () => {
  const configurations: Record<string, MemoryModuleOptions> = {
    dense: { embeddingProvider: embeddings },
    planned: {
      embeddingProvider: embeddings,
      queryPlanningProvider: { plan: async ({ query }) => [`${query} schedule`, `${query} log`] },
    },
    feedback: { retrievalFeedbackQueries: 1 },
    expansion: { contextGroupExpansion: { groupMetadataKey: "session" } },
  };
  const measured: Record<string, unknown> = {};
  for (const [name, options] of Object.entries(configurations)) {
    const { context, measure, workspaceId, userId } = await budgetFixture(options);
    const json = { "x-lore-workspace-id": workspaceId, "content-type": "application/json" };
    for (const [content, session] of [
      ["The harbor observatory opens at dawn. Its keeper logs the tides.", "s1"],
      ["The keeper logs the tides in the harbor ledger every night.", "s1"],
      ["The ledger moved to the lighthouse archive.", "s2"],
    ]) {
      await measure("/api/v1/memories", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ content, metadata: { session } }),
      });
    }
    const access = createAccessModule(context.database);
    const owner = { workspaceId, userId };
    const agent = await access.createAgentForWorkspace(owner, {
      name: "Budget Agent",
      permission: "read",
    });
    const credential = await access.issueAgentCredential(owner, agent.id);
    const search = "/api/v1/memories?q=harbor%20observatory";
    measured[name] = {
      human: cost(await measure(search, { headers: { "x-lore-workspace-id": workspaceId } })),
      agent: cost(
        await measure(search, {
          headers: {
            "x-lore-workspace-id": workspaceId,
            authorization: `Bearer ${credential.token}`,
          },
        }),
      ),
      context: cost(
        await measure("/api/v1/context/retrieve", {
          method: "POST",
          headers: json,
          body: JSON.stringify({ query: "What do we remember about the harbor observatory?" }),
        }),
      ),
    };
  }
  // Provider calls run before any statement. A human is admitted with the first pass;
  // an Agent pays for a provider only after its own admission (one more wait), and a
  // lexical search admits it with the first pass. Expansion and each feedback round
  // add one wait; a Memory-only context packet costs what its search does.
  const at = (statements: number, waits: number) => ({ status: 200, statements, waits });
  expect(measured).toEqual({
    dense: { human: at(6, 1), agent: at(8, 2), context: at(6, 1) },
    planned: { human: at(8, 1), agent: at(10, 2), context: at(8, 1) },
    feedback: { human: at(11, 2), agent: at(10, 2), context: at(11, 2) },
    expansion: { human: at(7, 2), agent: at(6, 2), context: at(7, 2) },
  });
});
