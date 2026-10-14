import { partitionMemoryContent } from "@corespeed/lore-core";
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

test("SDK → HTTP indexes recorded correction evidence on request without changing Memory", async () => {
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
  // Recording builds no index; the owner builds it on request. Repeating it is safe.
  expect(await workspace.searchEpisodeEvidence({ query: "发版" })).toEqual([]);
  const indexed = await workspace.indexEpisodeEvidence(episode.id);
  expect(indexed.chunkCount).toBe(2);
  expect(await workspace.indexEpisodeEvidence(episode.id)).toEqual(indexed);
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
  // A rebuilt index, after its chunks are gone, is the same index.
  await context.adminDatabase.transaction((tx) =>
    tx.query("DELETE FROM episode_evidence_chunks WHERE episode_id = $1", [episode.id]),
  );
  expect(await workspace.searchEpisodeEvidence({ query: "发版" })).toEqual([]);
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
  const recordIndexed = async (...[actor, input]: Parameters<typeof observations.record>) => {
    const episode = await observations.record(actor, input);
    await evidence.index(actor, { episodeId: episode.id });
    return episode;
  };
  const shared = await recordIndexed(context.alice, {
    kind: "event",
    scope: "shared",
    observations: [
      { kind: "event", content: "release 发版 approved", metadata: { project: "visible" } },
    ],
  });
  for (let i = 0; i < 5; i++)
    await recordIndexed(context.alice, {
      kind: "event",
      observations: [
        { kind: "event", content: "release 发版 private", metadata: { project: "hidden" } },
      ],
    });
  await recordIndexed(context.carol, {
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

test("recording writes no index, and a failed index build leaves the Episode recorded", async () => {
  const context = await createMemoryTestContext();
  await context.adminDatabase.transaction((tx) =>
    tx.query("REVOKE INSERT ON episode_evidence_chunks FROM lore_app"),
  );
  const episode = await createObservationModule(context.database).record(context.alice, {
    kind: "event",
    observations: [{ kind: "event", content: "Recorded before any index" }],
  });
  await expect(
    createEpisodeEvidenceModule(context.database).index(context.alice, { episodeId: episode.id }),
  ).rejects.toThrow();
  const counts = await context.adminDatabase.transaction((tx) =>
    tx.query<{ episodes: string; observations: string; chunks: string }>(
      `SELECT (SELECT count(*)::text FROM episodes) AS episodes,
              (SELECT count(*)::text FROM observations) AS observations,
              (SELECT count(*)::text FROM episode_evidence_chunks) AS chunks`,
    ),
  );
  expect(counts.rows).toEqual([{ episodes: "1", observations: "1", chunks: "0" }]);
});

test("raw whitespace never blocks indexing, and excerpts stay exact spans", async () => {
  const context = await createMemoryTestContext();
  // Each holds a whitespace-only part no chunk row may carry. Indexing must
  // accept them and leave the recorded Observations exactly as written.
  const contents = [
    `begin${" ".repeat(2_400)}end`,
    `${"word ".repeat(100)}trailing${"\n".repeat(1_300)}`,
    `${" ".repeat(1_250)}leading\r\n${"\t".repeat(40)}tabs`,
  ];
  const episode = await createObservationModule(context.database).record(context.alice, {
    kind: "document",
    observations: contents.map((content) => ({ kind: "document_fragment" as const, content })),
  });
  expect(episode.observations.map((observation) => observation.content)).toEqual(contents);
  const evidence = createEpisodeEvidenceModule(context.database, { evidenceNeighborChunks: 2 });
  await evidence.index(context.alice, { episodeId: episode.id });

  const stored = await context.adminDatabase.transaction((tx) =>
    tx.query<{ observation_id: string; chunk_ordinal: number; content: string }>(
      `SELECT observation_id, chunk_ordinal, content FROM episode_evidence_chunks
       ORDER BY observation_ordinal, chunk_ordinal`,
    ),
  );
  for (const [index, content] of contents.entries()) {
    const parts = partitionMemoryContent(content);
    expect(parts.join("")).toBe(content);
    expect(parts.some((part) => !part.trim())).toBe(true);
    expect(
      stored.rows
        .filter((row) => row.observation_id === episode.observations[index]?.id)
        .map(({ chunk_ordinal, content }) => ({ chunk_ordinal, content })),
    ).toEqual(
      parts.flatMap((part, ordinal) =>
        part.trim() ? [{ chunk_ordinal: ordinal, content: part }] : [],
      ),
    );
  }

  expect(
    await evidence.index(context.alice, { episodeId: episode.id, mode: "verify" }),
  ).toMatchObject({ observationCount: 3, chunkCount: stored.rows.length });
  for (const term of ["begin", "end", "trailing", "tabs"]) {
    const [result] = await evidence.search(context.alice, { query: term });
    const excerpt = result?.excerpts[0];
    expect(excerpt?.content).toContain(term);
    const source = contents[episode.observations.findIndex((o) => o.id === excerpt?.observationId)];
    // Neighbors never join across a skipped part, so each excerpt is one span.
    expect(source).toContain(excerpt?.content);
  }
});
