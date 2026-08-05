import { expect, test } from "vitest";
import { AccessDeniedError, createAccessModule } from "@/lib/access";
import { installActorContext } from "@/lib/actor-context";
import { createMemoryTestContext } from "./support/memory-context";

test("User can create an Agent and grant it write access to their Workspace", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);

  const agent = await access.createAgent(testContext.alice, { name: "Release assistant" });
  const grant = await access.grantAgent(testContext.alice, agent.id, { permission: "write" });

  expect(agent).toMatchObject({
    ownerUserId: testContext.alice.userId,
    name: "Release assistant",
    status: "active",
  });
  expect(grant).toMatchObject({
    workspaceId: testContext.alice.workspaceId,
    agentId: agent.id,
    permission: "write",
    status: "active",
  });

  await testContext.close();
});

test("User can atomically provision and list Agents for the active Workspace", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);

  const provisioned = await access.createAgentForWorkspace(testContext.alice, {
    name: "Research assistant",
    permission: "read",
  });

  expect(provisioned).toMatchObject({
    name: "Research assistant",
    ownerUserId: testContext.alice.userId,
    permission: "read",
    grantStatus: "active",
  });
  await expect(access.listAgents(testContext.alice)).resolves.toEqual([provisioned]);
  await expect(access.listAgents(testContext.bob)).resolves.toEqual([]);

  await testContext.close();
});

test("RLS keeps a User's Agents and Workspace Grants private from other members", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const aliceAgent = await access.createAgentForWorkspace(testContext.alice, {
    name: "Private assistant",
    permission: "read",
  });

  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.bob);
    await expect(transaction.query("SELECT id FROM agents")).resolves.toMatchObject({ rows: [] });
    await expect(
      transaction.query("SELECT agent_id FROM agent_workspace_grants"),
    ).resolves.toMatchObject({ rows: [] });
  });

  await expect(access.listAgents(testContext.alice)).resolves.toMatchObject([
    { id: aliceAgent.id },
  ]);
  await testContext.close();
});

test("Agent credential resolves to the owning User and granted Workspace", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const agent = await access.createAgent(testContext.alice, { name: "Release assistant" });
  await access.grantAgent(testContext.alice, agent.id, { permission: "write" });

  const credential = await access.issueAgentCredential(testContext.alice, agent.id);

  expect(credential.token).toMatch(/^lore_agent_[A-Za-z0-9_-]+$/);
  await expect(
    access.authenticateAgent(credential.token, testContext.alice.workspaceId),
  ).resolves.toEqual({
    workspaceId: testContext.alice.workspaceId,
    userId: testContext.alice.userId,
    agentId: agent.id,
  });
  await expect(
    access.authenticateAgent("lore_agent_invalid", testContext.alice.workspaceId),
  ).resolves.toBeNull();
  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.alice);
    await expect(
      transaction.query("SELECT id, agent_id, secret_prefix FROM agent_credentials"),
    ).resolves.toMatchObject({ rows: [{ id: credential.id, agent_id: agent.id }] });
    await expect(transaction.query("SELECT secret_hash FROM agent_credentials")).rejects.toThrow(
      /permission denied/i,
    );
  });
  await testContext.database.transaction(async (transaction) => {
    await installActorContext(transaction, testContext.bob);
    await expect(
      transaction.query("SELECT id, agent_id, secret_prefix FROM agent_credentials"),
    ).resolves.toMatchObject({ rows: [] });
  });

  await testContext.close();
});

test("Revoked Agent credential can no longer authenticate", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const agent = await access.createAgent(testContext.alice, { name: "Release assistant" });
  await access.grantAgent(testContext.alice, agent.id, { permission: "read" });
  const credential = await access.issueAgentCredential(testContext.alice, agent.id);

  await expect(access.revokeAgentCredential(testContext.alice, credential.id)).resolves.toBe(true);
  await expect(
    access.authenticateAgent(credential.token, testContext.alice.workspaceId),
  ).resolves.toBeNull();

  await testContext.close();
});

test("Revoked Agent Workspace Grant invalidates every credential", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const agent = await access.createAgent(testContext.alice, { name: "Release assistant" });
  await access.grantAgent(testContext.alice, agent.id, { permission: "read" });
  const first = await access.issueAgentCredential(testContext.alice, agent.id);
  const second = await access.issueAgentCredential(testContext.alice, agent.id);

  await expect(access.revokeAgentGrant(testContext.alice, agent.id)).resolves.toBe(true);
  await expect(
    access.authenticateAgent(first.token, testContext.alice.workspaceId),
  ).resolves.toBeNull();
  await expect(
    access.authenticateAgent(second.token, testContext.alice.workspaceId),
  ).resolves.toBeNull();

  await testContext.close();
});

test("User can reactivate a revoked Agent Workspace Grant", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const agent = await access.createAgent(testContext.alice, { name: "Release assistant" });
  await access.grantAgent(testContext.alice, agent.id, { permission: "read" });
  const credential = await access.issueAgentCredential(testContext.alice, agent.id);
  await access.revokeAgentGrant(testContext.alice, agent.id);

  const reactivated = await access.grantAgent(testContext.alice, agent.id, {
    permission: "write",
  });

  expect(reactivated).toMatchObject({ status: "active", permission: "write" });
  await expect(
    access.authenticateAgent(credential.token, testContext.alice.workspaceId),
  ).resolves.toMatchObject({ agentId: agent.id });
});

test("Workspace owner can reactivate a suspended Membership", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  await testContext.suspendMembership(testContext.bob);

  const membership = await access.addMember(testContext.alice, testContext.bob.userId, {
    role: "member",
  });

  expect(membership).toMatchObject({
    userId: testContext.bob.userId,
    status: "active",
    role: "member",
  });
  await expect(
    access.selectWorkspace(
      { userId: testContext.bob.userId },
      testContext.bob.workspaceId.toUpperCase(),
    ),
  ).resolves.toEqual(testContext.bob);
});

test("User cannot grant another User's Agent", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const aliceAgent = await access.createAgent(testContext.alice, { name: "Alice assistant" });

  await expect(
    access.grantAgent(testContext.bob, aliceAgent.id, { permission: "write" }),
  ).rejects.toBeInstanceOf(AccessDeniedError);

  await testContext.close();
});
