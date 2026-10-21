import { LoreClient } from "@corespeed/lore-sdk";
import { afterEach, expect, test, vi } from "vitest";
import { createEpisodeEvidenceModule } from "@/modules/episodes/evidence";
import { createObservationModule } from "@/modules/episodes/service";
import { createMemoryModule } from "@/modules/memories/service";
import { createApi } from "@/server/api/app";
import { createMemoryTestContext } from "../../support/memory-context";

afterEach(() => vi.unstubAllEnvs());

// These databases have no embedding provider, so only lexical channels run: an
// English query can reach Chinese text only through a translation.

test("a translation finds what only its language says, in one ranking, where visible", async () => {
  const context = await createMemoryTestContext();
  const memories = createMemoryModule(context.database);
  const deploy = await memories.remember(context.alice, {
    content: "部署失败后先回滚，再排查原因。",
  });
  const backup = await memories.remember(context.alice, {
    content: "Database backups run every Sunday night.",
  });
  const secret = await memories.remember(context.alice, {
    content: "私人记录：部署失败三次。",
    scope: "private",
  });
  const ids = async (actor: typeof context.alice, query: string, translations?: string[]) =>
    (await memories.search(actor, { query, translations })).map((result) => result.memory.id);

  expect(await ids(context.alice, "failed deploy")).toEqual([]);
  expect(await ids(context.alice, "failed deploy", ["部署失败"])).toEqual(
    expect.arrayContaining([deploy.id, secret.id]),
  );
  // The query and its translation fuse into one ranking.
  expect(await ids(context.alice, "database backups after a failed deploy", ["部署失败"])).toEqual(
    expect.arrayContaining([backup.id, deploy.id]),
  );
  // A translation reaches only what the caller may see.
  expect(await ids(context.bob, "failed deploy", ["部署失败"])).toEqual([deploy.id]);
  expect(await ids(context.carol, "failed deploy", ["部署失败"])).toEqual([]);
  // A translation that repeats the query, in any case, searches it once.
  expect(await ids(context.alice, "Database backups", ["database BACKUPS"])).toEqual([backup.id]);
  // A Memory a translation found returns the chunk it matched as evidence.
  const [hit] = await memories.search(context.bob, {
    query: "failed deploy",
    translations: ["部署失败"],
  });
  expect(hit).toMatchObject({ evidence: "部署失败后先回滚，再排查原因。" });
  await context.close();
});

test("the planner rewrites only the query, and its rewrites run beside the translations", async () => {
  const context = await createMemoryTestContext();
  const plan = vi.fn(async () => ["database backups"]);
  const memories = createMemoryModule(context.database, {
    queryPlanningProvider: { plan },
    queryPlannerMaxQueries: 2,
  });
  const deploy = await memories.remember(context.alice, { content: "部署失败后先回滚。" });
  const backup = await memories.remember(context.alice, {
    content: "Database backups run every Sunday night.",
  });

  const results = await memories.search(context.alice, {
    query: "what happens on weekends",
    translations: ["部署失败"],
  });
  expect(plan).toHaveBeenCalledExactlyOnceWith({
    query: "what happens on weekends",
    maxQueries: 1,
  });
  expect(results.map((result) => result.memory.id)).toEqual(
    expect.arrayContaining([deploy.id, backup.id]),
  );
  await context.close();
});

test("Episode evidence search finds raw evidence through a translation, where visible", async () => {
  const context = await createMemoryTestContext();
  const observations = createObservationModule(context.database);
  const evidence = createEpisodeEvidenceModule(context.database);
  const episode = await observations.record(context.alice, {
    kind: "event",
    scope: "shared",
    observations: [{ kind: "event", content: "发版推迟到安全审查通过以后。" }],
  });
  await evidence.index(context.alice, { episodeId: episode.id });
  const episodeIds = async (actor: typeof context.alice, translations?: string[]) =>
    (await evidence.search(actor, { query: "release delayed", translations })).flatMap(
      (result) => result.episodeIds,
    );

  expect(await episodeIds(context.bob)).toEqual([]);
  expect(await episodeIds(context.bob, ["发版推迟"])).toEqual([episode.id]);
  expect(await episodeIds(context.carol, ["发版推迟"])).toEqual([]);
  await context.close();
});

/** A local-mode API over a fresh test database, with one Workspace of its own. */
async function translatedApi() {
  vi.stubEnv("AUTH_MODE", "none");
  vi.stubEnv("ALLOW_INSECURE", "1");
  vi.stubEnv("LORE_LOCAL_SUBJECT", "translation-user");
  const context = await createMemoryTestContext();
  const app = createApi({
    database: () => context.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });
  const client = new LoreClient({
    baseUrl: "http://lore.local",
    fetch: async (input, init) => app.request(new Request(input, init)),
  });
  const workspace = client.workspace((await client.createWorkspace("Translations")).id);
  const headers = {
    "content-type": "application/json",
    "x-lore-workspace-id": workspace.workspaceId,
  };
  return { app, context, headers, workspace };
}

test("HTTP Memory search takes repeated translation parameters and checks each", async () => {
  const { app, context, headers, workspace } = await translatedApi();
  try {
    const memory = await workspace.remember({ content: "部署失败后先回滚，再排查原因。" });
    expect(
      (await workspace.searchMemories({ query: "failed deploy", translations: ["部署失败"] })).map(
        (result) => result.memory.id,
      ),
    ).toEqual([memory.id]);

    const search = (query: string) => app.request(`/api/v1/memories?${query}`, { headers });
    const found = await search(`q=failed+deploy&translation=${encodeURIComponent("部署失败")}`);
    expect(found.status).toBe(200);
    await expect(found.json()).resolves.toEqual([
      expect.objectContaining({ memory: expect.objectContaining({ id: memory.id }) }),
    ]);
    for (const [query, message] of [
      [`translation=${encodeURIComponent("部署失败")}`, "translation requires q"],
      ["q=deploy&translation=a&translation=b&translation=c&translation=d", "at most 3 queries"],
      ["q=deploy&translation=%20", "translation must not hold an empty query"],
      ["q=deploy&translation=a%00b", "translation contains an invalid null character"],
      [`q=deploy&translation=${"t".repeat(10_001)}`, "translation exceeds 10000 characters"],
    ] as const) {
      const refused = await search(query);
      expect(refused.status).toBe(400);
      await expect(refused.json()).resolves.toMatchObject({
        code: "invalid_request",
        error: expect.stringContaining(message),
      });
    }
  } finally {
    await context.close();
  }
});

test("HTTP evidence search and context packets take translations and check them", async () => {
  const { app, context, headers, workspace } = await translatedApi();
  try {
    const memory = await workspace.remember({ content: "部署失败后先回滚，再排查原因。" });
    const episode = await workspace.recordEpisode({
      kind: "event",
      observations: [{ kind: "event", content: "发版推迟到安全审查通过以后。" }],
    });
    await workspace.indexEpisodeEvidence(episode.id);

    const evidence = await workspace.searchEpisodeEvidence({
      query: "release delayed",
      translations: ["发版推迟"],
    });
    expect(evidence.flatMap((result) => result.episodeIds)).toEqual([episode.id]);
    const query = "what do we do after a failed deploy";
    const packet = await workspace.retrieveContext({
      query,
      route: "memory-only",
      memoryTranslations: ["部署失败"],
    });
    expect(packet.memories.map((item) => item.id)).toEqual([memory.id]);
    // Without the translation the packet finds nothing to cite.
    expect((await workspace.retrieveContext({ query, route: "memory-only" })).memories).toEqual([]);

    for (const [path, body, message] of [
      [
        "/api/v1/episodes/search",
        { query: "release", translations: "发版" },
        "translations must be an array of strings",
      ],
      [
        "/api/v1/episodes/search",
        { query: "release", translations: ["a", "b", "c", "d"] },
        "translations may hold at most 3 queries",
      ],
      [
        "/api/v1/context/retrieve",
        { query: "release", memoryTranslations: [7] },
        "memoryTranslations must be an array of strings",
      ],
      [
        "/api/v1/context/retrieve",
        { query: "release", memoryTranslations: ["a", "b", "c", "d"] },
        "memoryTranslations may hold at most 3 queries",
      ],
      [
        "/api/v1/context/retrieve",
        { query: "release", memoryTranslations: [" "] },
        "memoryTranslations is invalid",
      ],
    ] as const) {
      const refused = await app.request(path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
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
