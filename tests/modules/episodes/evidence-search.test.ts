import { EPISODE_EVIDENCE_INDEX_REVISION } from "@corespeed/lore-core/episodes";
import { LoreClient } from "@corespeed/lore-sdk";
import { afterEach, expect, test } from "vitest";
import {
  createEpisodeEvidenceModule,
  EpisodeEvidenceAccessDeniedError,
} from "@/modules/episodes/evidence";
import { createObservationModule } from "@/modules/episodes/service";
import { createApi } from "@/server/api/app";
import { createAccessModule } from "../../support/access";
import { createMemoryTestContext } from "../../support/memory-context";

afterEach(() => {
  for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT"]) delete process.env[key];
});

test("SDK → HTTP records immediately searchable correction evidence without changing Memory", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "episode-search-http";
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
  const workspace = client.workspace((await client.createWorkspace("Raw evidence")).id);
  const memory = await workspace.remember({ content: "发版日期：下周五。", scope: "private" });
  const input = {
    kind: "conversation" as const,
    observations: [
      {
        kind: "message" as const,
        content: "发版安排在下周五。",
        observedAt: "2026-10-01T10:00:00Z",
        metadata: { project: "lore" },
      },
      {
        kind: "message" as const,
        content: "安全审查还没结束，发版推迟，日期等审查通过再定。",
        observedAt: "2026-10-02T11:00:00Z",
        metadata: { project: "lore" },
      },
    ],
  };
  const episode = await workspace.recordEpisode(input, { idempotencyKey: "correction-episode" });
  const replay = await workspace.recordEpisode(input, { idempotencyKey: "correction-episode" });
  expect(replay.id).toBe(episode.id);
  const results = await workspace.searchEpisodeEvidence({
    query: "发版",
    scope: "private",
    metadata: { project: "lore" },
  });
  expect(results).toHaveLength(1);
  expect(results[0]?.excerpts).toEqual([
    {
      indexRevision: EPISODE_EVIDENCE_INDEX_REVISION,
      episodeId: episode.id,
      observationId: episode.observations[1]?.id,
      observationOrdinal: 1,
      observedAt: "2026-10-02T11:00:00.000000Z",
      chunkStartOrdinal: 0,
      chunkEndOrdinal: 0,
      content: input.observations[1]?.content,
      metadata: { project: "lore" },
    },
  ]);
  expect(await workspace.getMemory(memory.id)).toMatchObject({
    content: memory.content,
    version: memory.version,
  });
  expect(
    (await workspace.searchMemories({ query: "发版" })).map((result) => result.memory.id),
  ).toEqual([memory.id]);
  expect(
    await workspace.searchEpisodeEvidence({ query: "发版", metadata: { project: "other" } }),
  ).toEqual([]);
  expect(await workspace.searchEpisodeEvidence({ query: "发版", scope: "shared" })).toEqual([]);
  // Rebuild an older Episode whose derived index is absent. Repeated builds do not duplicate chunks.
  await context.adminDatabase.transaction((tx) =>
    tx.query("DELETE FROM episode_evidence_chunks WHERE episode_id = $1", [episode.id]),
  );
  expect(await workspace.searchEpisodeEvidence({ query: "发版" })).toEqual([]);
  const indexed = await workspace.indexEpisodeEvidence(episode.id);
  expect(indexed.chunkCount).toBe(2);
  expect(await workspace.indexEpisodeEvidence(episode.id)).toEqual(indexed);
  expect(await workspace.searchEpisodeEvidence({ query: "发版" })).toHaveLength(1);
  for (const body of [
    { query: "发版", limit: 0 },
    { query: "发版", limit: 101 },
    { query: "发版", scope: "public" },
    { query: 1 },
    { query: "发版", metadata: [] },
  ]) {
    const response = await app.request("http://lore.local/api/v1/episodes/search", {
      method: "POST",
      headers: { "x-lore-workspace-id": episode.workspaceId },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  }
  await workspace.forgetEpisode(episode.id);
  expect(await workspace.searchEpisodeEvidence({ query: "发版" })).toEqual([]);
  expect((await workspace.getMemory(memory.id)).content).toBe(memory.content);
});

test("raw evidence applies Workspace, private/shared, metadata and Agent grants before top-k", async () => {
  const context = await createMemoryTestContext();
  const observations = createObservationModule(context.database);
  const evidence = createEpisodeEvidenceModule(context.database);
  const shared = await observations.record(context.alice, {
    kind: "event",
    scope: "shared",
    observations: [
      { kind: "event", content: "release 发版 approved", metadata: { project: "visible" } },
    ],
  });
  for (let i = 0; i < 5; i++)
    await observations.record(context.alice, {
      kind: "event",
      observations: [
        { kind: "event", content: "release 发版 private", metadata: { project: "hidden" } },
      ],
    });
  await observations.record(context.carol, {
    kind: "event",
    scope: "shared",
    observations: [{ kind: "event", content: "release 发版 cross-workspace" }],
  });
  for (const query of ["release", "发版"]) {
    expect((await evidence.search(context.bob, { query, limit: 1 }))[0]?.episodeIds).toEqual([
      shared.id,
    ]);
    expect(
      (
        await evidence.search(context.alice, {
          query,
          limit: 1,
          metadataFilter: { project: "visible" },
        })
      )[0]?.episodeIds,
    ).toEqual([shared.id]);
    expect(await evidence.search(context.bob, { query, scope: "private" })).toEqual([]);
  }
  await expect(evidence.index(context.bob, { episodeId: shared.id })).rejects.toBeInstanceOf(
    EpisodeEvidenceAccessDeniedError,
  );
  const access = createAccessModule(context.database);
  const reader = await access.createAgent(context.alice, { name: "Evidence reader" });
  await access.grantAgent(context.alice, reader.id, { permission: "read" });
  const actor = { ...context.alice, agentId: reader.id };
  expect(await evidence.search(actor, { query: "发版", scope: "private" })).toHaveLength(5);
  await expect(
    observations.record(actor, {
      kind: "event",
      observations: [{ kind: "event", content: "Forbidden" }],
    }),
  ).rejects.toThrow();
  await access.revokeAgentGrant(context.alice, reader.id);
  expect(await evidence.search(actor, { query: "发版" })).toEqual([]);
  await context.suspendMembership(context.bob);
  expect(await evidence.search(context.bob, { query: "发版" })).toEqual([]);
});

test("index admission failure rolls back Episode and Observations together", async () => {
  const context = await createMemoryTestContext();
  await context.adminDatabase.transaction((tx) =>
    tx.query("REVOKE INSERT ON episode_evidence_chunks FROM lore_app"),
  );
  await expect(
    createObservationModule(context.database).record(context.alice, {
      kind: "event",
      observations: [{ kind: "event", content: "Never partially admitted" }],
    }),
  ).rejects.toThrow();
  const counts = await context.adminDatabase.transaction((tx) =>
    tx.query<{ episodes: string; observations: string }>(
      "SELECT (SELECT count(*)::text FROM episodes) AS episodes, (SELECT count(*)::text FROM observations) AS observations",
    ),
  );
  expect(counts.rows).toEqual([{ episodes: "0", observations: "0" }]);
});
