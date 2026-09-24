import type { PostgresDatabase } from "@corespeed/lore-core";
import { afterEach, expect, test } from "vitest";
import { createAccessModule } from "@/server/auth/access";
import {
  createRequestContextResolver,
  RequestAuthenticationError,
  WorkspaceAccessError,
} from "@/server/auth/request-context";
import { createMemoryTestContext } from "../support/memory-context";

afterEach(() => {
  for (const key of ["AUTH_MODE", "ALLOW_INSECURE", "LORE_LOCAL_SUBJECT", "UI_PASSWORD"]) {
    delete process.env[key];
  }
});

function countingTransactions(database: PostgresDatabase) {
  const counter = { transactions: 0 };
  const counted: PostgresDatabase = {
    transaction: (use) => {
      counter.transactions += 1;
      return database.transaction(use);
    },
  };
  return { counter, database: counted };
}

const admitted = {
  provider: "cloudflare-access:lore-test.cloudflareaccess.com",
  subject: "admitted-subject",
  displayName: "Admitted User",
};

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

test("An admitted human resolves identity and Membership in one transaction", async () => {
  // Password mode with no credential: success proves the resolver reused the admitted
  // principal instead of verifying the request a second time.
  process.env.AUTH_MODE = "password";
  process.env.UI_PASSWORD = "secret";
  const testContext = await createMemoryTestContext();
  const setup = createRequestContextResolver(testContext.database);
  const user = await setup.resolveUser(new Request("http://lore.local/api/workspaces"), admitted);
  const workspace = await createAccessModule(testContext.database).createWorkspace(user, {
    name: "Admitted Lab",
  });
  const { counter, database } = countingTransactions(testContext.database);
  const resolver = createRequestContextResolver(database);

  await expect(
    resolver.resolveActor(
      new Request("http://lore.local/api/v1/memories", {
        headers: { "x-lore-workspace-id": workspace.id.toUpperCase() },
      }),
      admitted,
    ),
  ).resolves.toEqual({ userId: user.userId, workspaceId: workspace.id });
  expect(counter.transactions).toBe(1);
  await expect(
    resolver.resolveActor(
      new Request("http://lore.local/api/v1/memories", {
        headers: { "x-lore-workspace-id": workspace.id },
      }),
    ),
  ).rejects.toBeInstanceOf(RequestAuthenticationError);
});

test("One-transaction human resolution still denies other, unknown, and suspended Workspaces", async () => {
  const testContext = await createMemoryTestContext();
  const resolver = createRequestContextResolver(testContext.database);
  const request = (workspaceId: string) =>
    new Request("http://lore.local/api/v1/memories", {
      headers: { "x-lore-workspace-id": workspaceId },
    });
  const user = await resolver.resolveUser(
    new Request("http://lore.local/api/workspaces"),
    admitted,
  );
  const workspace = await createAccessModule(testContext.database).createWorkspace(user, {
    name: "Suspended Lab",
  });

  for (const workspaceId of [testContext.alice.workspaceId, crypto.randomUUID()]) {
    await expect(resolver.resolveActor(request(workspaceId), admitted)).rejects.toBeInstanceOf(
      WorkspaceAccessError,
    );
  }
  await testContext.suspendMembership({ userId: user.userId, workspaceId: workspace.id });
  await expect(resolver.resolveActor(request(workspace.id), admitted)).rejects.toBeInstanceOf(
    WorkspaceAccessError,
  );
  await expect(resolver.resolveActor(request("not-a-uuid"), admitted)).rejects.toThrow(
    "x-lore-workspace-id must be a UUID",
  );
});
