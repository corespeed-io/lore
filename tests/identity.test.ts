import { sql } from "drizzle-orm";
import { expect, test } from "vitest";
import { AccessDeniedError, createAccessModule } from "@/lib/access";
import { installActorContext } from "@/lib/actor-context";
import { createIdentityModule } from "@/lib/identity";
import { createMemoryModule } from "@/lib/memory";
import { createMemoryTestContext } from "./support/memory-context";

test("Verified provider identity resolves to one stable internal User", async () => {
  const testContext = await createMemoryTestContext();
  const identities = createIdentityModule(testContext.database);

  const registered = await identities.register({
    provider: "oidc:https://identity.example",
    subject: "external-user-42",
    displayName: "Dana",
    email: "dana@example.com",
  });
  const repeated = await identities.register({
    provider: "oidc:https://identity.example",
    subject: "external-user-42",
    displayName: "Different claim value",
    email: "new-email@example.com",
  });

  expect(repeated.id).toBe(registered.id);
  await expect(
    identities.resolve("oidc:https://identity.example", "external-user-42"),
  ).resolves.toEqual(registered);
  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, {
      userId: registered.id,
      workspaceId: testContext.alice.workspaceId,
    });
    await expect(
      transaction.execute(sql.raw("SELECT provider, subject FROM identities")),
    ).resolves.toMatchObject({
      rows: [{ provider: "oidc:https://identity.example", subject: "external-user-42" }],
    });
  });
  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.bob);
    await expect(
      transaction.execute(sql.raw("SELECT provider, subject FROM identities")),
    ).resolves.toMatchObject({ rows: [] });
  });

  await testContext.close();
});

test("Authenticated User can create a Workspace and become its owner", async () => {
  const testContext = await createMemoryTestContext();
  const identities = createIdentityModule(testContext.database);
  const access = createAccessModule(testContext.database);
  const memories = createMemoryModule(testContext.database);
  const user = await identities.register({
    provider: "local",
    subject: "dana",
    displayName: "Dana",
  });

  const workspace = await access.createWorkspace({ userId: user.id }, { name: "Dana Lab" });
  const actor = { userId: user.id, workspaceId: workspace.id };

  await expect(
    memories.remember(actor, { content: "First Memory in Dana Lab." }),
  ).resolves.toMatchObject({ ownerUserId: user.id, workspaceId: workspace.id });

  await testContext.close();
});

test("Workspace owner can add an existing User as a member", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const memories = createMemoryModule(testContext.database);
  const shared = await memories.remember(testContext.alice, {
    content: "Operations handbook.",
  });

  const membership = await access.addMember(testContext.alice, testContext.carol.userId, {
    role: "member",
  });
  const carolInOperations = {
    userId: testContext.carol.userId,
    workspaceId: testContext.alice.workspaceId,
  };

  expect(membership).toMatchObject({
    workspaceId: testContext.alice.workspaceId,
    userId: testContext.carol.userId,
    role: "member",
    status: "active",
  });
  await expect(memories.retrieve(carolInOperations, shared.id)).resolves.not.toBeNull();

  await testContext.close();
});

test("Workspace member cannot add another member", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);

  await expect(
    access.addMember(testContext.bob, testContext.carol.userId, { role: "member" }),
  ).rejects.toBeInstanceOf(AccessDeniedError);

  await testContext.close();
});

test("User lists and selects only Workspaces with an active Membership", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);

  await expect(access.listWorkspaces({ userId: testContext.alice.userId })).resolves.toMatchObject([
    { id: testContext.alice.workspaceId, name: "Operations" },
  ]);
  await expect(
    access.selectWorkspace({ userId: testContext.alice.userId }, testContext.alice.workspaceId),
  ).resolves.toEqual(testContext.alice);
  await expect(
    access.selectWorkspace({ userId: testContext.alice.userId }, testContext.carol.workspaceId),
  ).resolves.toBeNull();

  await testContext.close();
});
