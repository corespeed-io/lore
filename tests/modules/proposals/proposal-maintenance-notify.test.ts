import { createMemoryMaintenanceModule } from "@corespeed/lore-core";
import { expect, test } from "vitest";
import { createMemoryModule } from "@/modules/memories/service";
import { createMemoryProposalsModule } from "@/modules/proposals/service";
import { createMemoryTestContext } from "../../support/memory-context";

function fixtureProvider() {
  return {
    provider: "fixture",
    model: "fixture-embedding-v1",
    dimensions: 1024 as const,
    revision: "fixture-v1",
    async embed(texts: string[]) {
      return texts.map(() => Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0)));
    },
  };
}

// Accepting a metadata-only update used to notify only when chunks changed, so a
// job it inserted for a still-unembedded Memory waited for the scheduled sweep.
test("accepting a metadata-only update notifies maintenance exactly when it enqueues a job", async () => {
  const testContext = await createMemoryTestContext();
  const embeddingProvider = fixtureProvider();
  const notifications: string[] = [];
  const options = {
    embeddingProvider,
    maintenanceNotifier: { notify: ({ jobId }: { jobId: string }) => notifications.push(jobId) },
  };
  const memories = createMemoryModule(testContext.database, options);
  const proposals = createMemoryProposalsModule(testContext.database, options);
  const created = await memories.remember(testContext.alice, {
    content: "Proposal acceptance embedding is still pending.",
  });
  expect(notifications).toHaveLength(1);
  const acceptMetadata = async (metadata: Record<string, unknown>) => {
    const current = await memories.retrieve(testContext.alice, created.id);
    if (!current) throw new Error("Expected the target Memory");
    const proposal = await proposals.propose(testContext.alice, {
      kind: "update",
      targetMemoryId: created.id,
      expectedVersion: current.version,
      metadata,
    });
    await expect(
      proposals.reviewProposal(testContext.alice, proposal.id, "accept"),
    ).resolves.toMatchObject({ proposal: { status: "accepted" } });
  };

  // The creation job has not run, so the accepted version still lacks vectors.
  await acceptMetadata({ reviewed: true });
  expect(notifications).toHaveLength(2);
  const [creationJob, acceptanceJob] = notifications;
  expect(acceptanceJob).not.toBe(creationJob);
  const maintenance = createMemoryMaintenanceModule(testContext.maintenanceDatabase, {
    embeddingProvider,
  });
  await expect(maintenance.run(acceptanceJob)).resolves.toMatchObject({
    status: "complete",
    jobId: acceptanceJob,
  });

  // Once embedded, a metadata-only acceptance inserts no job and sends no wake-up.
  await acceptMetadata({ reviewed: false });
  expect(notifications).toHaveLength(2);
});
