import { afterEach, expect, test } from "vitest";
import { createAccessModule } from "@/lib/access";
import { createRequestContextResolver } from "@/lib/request-context";
import { createMemoryTestContext } from "./support/memory-context";

afterEach(() => {
  for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT"]) {
    delete process.env[key];
  }
});

test("Human request resolves a verified internal User and active Workspace", async () => {
  process.env.AUTH_MODE = "none";
  process.env.ALLOW_INSECURE = "1";
  process.env.LORE_LOCAL_SUBJECT = "request-context-user";
  const testContext = await createMemoryTestContext();
  const resolver = createRequestContextResolver(testContext.database);
  const access = createAccessModule(testContext.database);
  const request = new Request("http://lore.local/api/workspaces");
  const user = await resolver.resolveUser(request);
  const workspace = await access.createWorkspace(user, { name: "Request Context Lab" });

  const actor = await resolver.resolveActor(
    new Request("http://lore.local/api/memories", {
      headers: { "x-lore-workspace-id": workspace.id },
    }),
  );

  expect(actor).toEqual({ userId: user.userId, workspaceId: workspace.id });
  await testContext.close();
});

test("Agent request resolves only through credential plus active Workspace Grant", async () => {
  const testContext = await createMemoryTestContext();
  const resolver = createRequestContextResolver(testContext.database);
  const access = createAccessModule(testContext.database);
  const agent = await access.createAgent(testContext.alice, { name: "Request Agent" });
  await access.grantAgent(testContext.alice, agent.id, { permission: "read" });
  const credential = await access.issueAgentCredential(testContext.alice, agent.id);

  const request = new Request("http://lore.local/api/memories", {
    headers: {
      authorization: `Bearer ${credential.token}`,
      "x-lore-workspace-id": testContext.alice.workspaceId,
    },
  });

  await expect(resolver.resolveActor(request)).resolves.toEqual({
    userId: testContext.alice.userId,
    workspaceId: testContext.alice.workspaceId,
    agentId: agent.id,
  });
  await testContext.close();
});
