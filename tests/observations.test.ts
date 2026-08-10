import { expect, test } from "vitest";
import { createAccessModule } from "@/lib/access";
import { installActorContext } from "@/lib/actor-context";
import { purgeExpiredPortableCoreRecords } from "@/lib/maintenance";
import { createObservationModule, ObservationAccessDeniedError } from "@/lib/observations";
import { createMemoryTestContext } from "./support/memory-context";

test("An Episode records immutable ordered Observation evidence with private defaults", async () => {
  const testContext = await createMemoryTestContext();
  const observations = createObservationModule(testContext.database);
  const firstAt = "2026-08-10T18:00:00.000000Z";
  const secondAt = "2026-08-10T18:01:00.000000Z";

  const episode = await observations.record(testContext.alice, {
    kind: "conversation",
    observations: [
      {
        kind: "message",
        content: "The launch is Tuesday.",
        metadata: { role: "user" },
        observedAt: firstAt,
      },
      {
        kind: "tool_result",
        content: "Calendar confirms Tuesday at 09:00.",
        observedAt: secondAt,
      },
    ],
  });

  expect(episode).toMatchObject({
    ownerUserId: testContext.alice.userId,
    recordedByActorKind: "human",
    recordedByAgentId: null,
    kind: "conversation",
    scope: "private",
    startedAt: firstAt,
    endedAt: secondAt,
    observationCount: 2,
    observations: [
      {
        ordinal: 0,
        kind: "message",
        content: "The launch is Tuesday.",
        metadata: { role: "user" },
      },
      {
        ordinal: 1,
        kind: "tool_result",
        content: "Calendar confirms Tuesday at 09:00.",
      },
    ],
  });
  expect(episode.observations[0].payloadSha256).toMatch(/^[0-9a-f]{64}$/);
  await expect(observations.retrieve(testContext.alice, episode.id)).resolves.toEqual(episode);
  await expect(observations.list(testContext.alice)).resolves.toMatchObject([
    { id: episode.id, observationCount: 2 },
  ]);
  await expect(observations.retrieve(testContext.bob, episode.id)).resolves.toBeNull();
  await expect(observations.retrieve(testContext.carol, episode.id)).resolves.toBeNull();
  await expect(
    observations.retrieveObservations(testContext.alice, [
      episode.observations[1].id,
      episode.observations[0].id,
    ]),
  ).resolves.toMatchObject([
    { id: episode.observations[1].id },
    { id: episode.observations[0].id },
  ]);
  await expect(
    observations.retrieveObservations(testContext.bob, [episode.observations[0].id]),
  ).resolves.toEqual([]);
  await expect(
    observations.retrieveObservations(testContext.carol, [episode.observations[0].id]),
  ).resolves.toEqual([]);

  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    await expect(
      transaction.query("UPDATE observations SET observed_at = now() WHERE id = $1", [
        episode.observations[0].id,
      ]),
    ).rejects.toThrow();
  });

  await testContext.close();
});

test("Shared Episode evidence requires active Membership and remains writable only by its owner", async () => {
  const testContext = await createMemoryTestContext();
  const observations = createObservationModule(testContext.database);
  const episode = await observations.record(testContext.alice, {
    kind: "event",
    scope: "shared",
    observations: [{ kind: "event", content: "Deployment completed." }],
  });

  await expect(observations.retrieve(testContext.bob, episode.id)).resolves.toMatchObject({
    id: episode.id,
    observations: [{ content: "Deployment completed." }],
  });
  await expect(observations.forget(testContext.bob, episode.id)).resolves.toBe(false);
  await testContext.suspendMembership(testContext.bob);
  await expect(observations.retrieve(testContext.bob, episode.id)).resolves.toBeNull();
  await expect(
    observations.record(testContext.bob, {
      kind: "event",
      observations: [{ kind: "event", content: "Suspended members cannot record." }],
    }),
  ).rejects.toBeInstanceOf(ObservationAccessDeniedError);
  await expect(observations.forget(testContext.alice, episode.id)).resolves.toBe(true);
  await expect(observations.retrieve(testContext.alice, episode.id)).resolves.toBeNull();

  await testContext.close();
});

test("A writing Agent records private evidence for its owner and grant revocation is immediate", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const observations = createObservationModule(testContext.database);
  const writer = await access.createAgent(testContext.alice, { name: "Observer" });
  await access.grantAgent(testContext.alice, writer.id, { permission: "write" });
  const reader = await access.createAgent(testContext.alice, { name: "Reader" });
  await access.grantAgent(testContext.alice, reader.id, { permission: "read" });
  const writerActor = { ...testContext.alice, agentId: writer.id };
  const readerActor = { ...testContext.alice, agentId: reader.id };

  await expect(
    observations.record(readerActor, {
      kind: "workflow",
      observations: [{ kind: "event", content: "Read-only Agents cannot record." }],
    }),
  ).rejects.toBeInstanceOf(ObservationAccessDeniedError);

  const episode = await observations.record(writerActor, {
    kind: "workflow",
    observations: [{ kind: "tool_result", content: "Build passed." }],
  });

  expect(episode).toMatchObject({
    recordedByActorKind: "agent",
    recordedByAgentId: writer.id,
  });
  await expect(observations.retrieve(readerActor, episode.id)).resolves.toMatchObject({
    id: episode.id,
  });
  await access.revokeAgentGrant(testContext.alice, writer.id);
  await expect(
    observations.record(writerActor, {
      kind: "workflow",
      observations: [{ kind: "event", content: "Should be denied." }],
    }),
  ).rejects.toBeInstanceOf(ObservationAccessDeniedError);
  await expect(observations.retrieve(writerActor, episode.id)).resolves.toBeNull();

  await testContext.close();
});

test("Observation content remains durable across Portable Core retention purges", async () => {
  const testContext = await createMemoryTestContext();
  const observations = createObservationModule(testContext.database);
  const episode = await observations.record(testContext.alice, {
    kind: "document",
    observations: [{ kind: "document_fragment", content: "Temporary raw evidence." }],
  });
  const checksum = episode.observations[0].payloadSha256;

  await purgeExpiredPortableCoreRecords(testContext.maintenanceDatabase);

  await expect(observations.retrieve(testContext.alice, episode.id)).resolves.toMatchObject({
    id: episode.id,
    observationCount: 1,
    observations: [
      {
        payloadSha256: checksum,
        content: "Temporary raw evidence.",
        metadata: {},
      },
    ],
  });

  await testContext.close();
});

test("Episode listing remains scoped when one owner belongs to two Workspaces", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const observations = createObservationModule(testContext.database);
  await access.addMember(testContext.carol, testContext.alice.userId, { role: "member" });
  const researchAlice = {
    userId: testContext.alice.userId,
    workspaceId: testContext.carol.workspaceId,
  };
  const operations = await observations.record(testContext.alice, {
    kind: "event",
    observations: [{ kind: "event", content: "Operations." }],
  });
  const research = await observations.record(researchAlice, {
    kind: "event",
    observations: [{ kind: "event", content: "Research." }],
  });

  await expect(observations.list(testContext.alice)).resolves.toMatchObject([
    { id: operations.id },
  ]);
  await expect(observations.list(researchAlice)).resolves.toMatchObject([{ id: research.id }]);

  await testContext.close();
});
