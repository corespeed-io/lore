import { expect, test } from "vitest";
import { createCodeEvidenceModule } from "@/modules/code/evidence";
import { createCodeIndexModule } from "@/modules/code/indexing/service";
import { createApi } from "@/server/api/app";
import { AccessDeniedError, createAccessModule } from "@/server/auth/access";
import { createMemoryModule } from "../../src/modules/memories/service";
import { installActorContext } from "../../src/server/auth/actor-context";
import { createMemoryTestContext } from "../support/memory-context";

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

test("Agent management stays scoped when one User belongs to two Workspaces", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  await access.addMember(testContext.carol, testContext.alice.userId, { role: "member" });
  const researchAlice = {
    userId: testContext.alice.userId,
    workspaceId: testContext.carol.workspaceId,
  };
  const operationsAgent = await access.createAgentForWorkspace(testContext.alice, {
    name: "Operations assistant",
    permission: "write",
  });
  const researchAgent = await access.createAgentForWorkspace(researchAlice, {
    name: "Research assistant",
    permission: "read",
  });
  const credential = await access.issueAgentCredential(testContext.alice, operationsAgent.id);

  await expect(access.listAgents(testContext.alice)).resolves.toMatchObject([
    { id: operationsAgent.id },
  ]);
  await expect(access.listAgents(researchAlice)).resolves.toMatchObject([{ id: researchAgent.id }]);
  await expect(access.listAgentCredentials(researchAlice, operationsAgent.id)).resolves.toEqual([]);
  await expect(
    access.issueAgentCredential(researchAlice, operationsAgent.id),
  ).rejects.toBeInstanceOf(AccessDeniedError);
  await expect(access.revokeAgentCredential(researchAlice, credential.id)).resolves.toBe(false);

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
  await expect(access.listAgentCredentials(testContext.alice, agent.id)).resolves.toMatchObject([
    {
      id: credential.id,
      agentId: agent.id,
      prefix: credential.prefix,
      revokedAt: null,
    },
  ]);
  await expect(access.listAgentCredentials(testContext.bob, agent.id)).resolves.toEqual([]);
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

test("Disabled Agent cannot receive a new credential", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const agent = await access.createAgent(testContext.alice, { name: "Disabled assistant" });
  await access.grantAgent(testContext.alice, agent.id, { permission: "read" });
  await testContext.adminDatabase.transaction(async (transaction) => {
    await transaction.query("UPDATE agents SET status = 'disabled' WHERE id = $1", [agent.id]);
  });

  await expect(access.issueAgentCredential(testContext.alice, agent.id)).rejects.toBeInstanceOf(
    AccessDeniedError,
  );

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
  await expect(access.listAgentCredentials(testContext.alice, agent.id)).resolves.toHaveLength(2);

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
  await access.grantAgent(testContext.alice, aliceAgent.id, { permission: "write" });
  const credential = await access.issueAgentCredential(testContext.alice, aliceAgent.id);

  await expect(
    access.grantAgent(testContext.bob, aliceAgent.id, { permission: "write" }),
  ).rejects.toBeInstanceOf(AccessDeniedError);
  await expect(access.revokeAgentGrant(testContext.bob, aliceAgent.id)).resolves.toBe(false);
  await expect(access.revokeAgentCredential(testContext.bob, credential.id)).resolves.toBe(false);
  await expect(
    access.authenticateAgent(credential.token, testContext.alice.workspaceId),
  ).resolves.toMatchObject({ agentId: aliceAgent.id });

  await testContext.close();
});

test("Agent lifecycle updates require ownership and a grant in the active Workspace", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const agent = await access.createAgentForWorkspace(testContext.alice, {
    name: "Release assistant",
    permission: "write",
  });
  const credential = await access.issueAgentCredential(testContext.alice, agent.id);

  await expect(
    access.updateAgent(testContext.alice, agent.id, { name: "Deployment assistant" }),
  ).resolves.toMatchObject({
    id: agent.id,
    name: "Deployment assistant",
    status: "active",
    permission: "write",
    grantStatus: "active",
  });
  await expect(
    access.updateAgent(testContext.bob, agent.id, { status: "disabled" }),
  ).resolves.toBeNull();
  await expect(access.deleteAgent(testContext.bob, agent.id)).resolves.toBe("not_found");

  await access.addMember(testContext.carol, testContext.alice.userId, { role: "member" });
  const researchAlice = {
    userId: testContext.alice.userId,
    workspaceId: testContext.carol.workspaceId,
  };
  await expect(
    access.updateAgent(researchAlice, agent.id, { status: "disabled" }),
  ).resolves.toBeNull();
  await expect(access.deleteAgent(researchAlice, agent.id)).resolves.toBe("not_found");

  const disabled = await access.updateAgent(testContext.alice, agent.id, {
    status: "disabled",
  });
  expect(disabled).toMatchObject({ id: agent.id, status: "disabled" });
  await expect(
    access.authenticateAgent(credential.token, testContext.alice.workspaceId),
  ).resolves.toBeNull();

  const reenabled = await access.updateAgent(testContext.alice, agent.id, { status: "active" });
  expect(reenabled).toMatchObject({ id: agent.id, status: "active" });
  await expect(
    access.authenticateAgent(credential.token, testContext.alice.workspaceId),
  ).resolves.toMatchObject({ agentId: agent.id });

  await testContext.close();
});

test("Deleting a disabled Agent removes every grant and credential but preserves Memory", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const memories = createMemoryModule(testContext.database);
  const agent = await access.createAgentForWorkspace(testContext.alice, {
    name: "Retiring assistant",
    permission: "write",
  });
  const credential = await access.issueAgentCredential(testContext.alice, agent.id);
  const agentActor = await access.authenticateAgent(
    credential.token,
    testContext.alice.workspaceId,
  );
  if (!agentActor) throw new Error("Expected Agent credential to authenticate");
  const memory = await memories.remember(agentActor, {
    content: "The rollout completed successfully.",
    scope: "private",
  });

  await expect(
    testContext.database.transaction(async (transaction) => {
      await installActorContext(transaction, agentActor);
      await transaction.query("UPDATE memories SET created_by_agent_id = NULL WHERE id = $1", [
        memory.id,
      ]);
    }),
  ).rejects.toThrow(/Memory identity and provenance are immutable/);
  await expect(
    testContext.database.transaction(async (transaction) => {
      await installActorContext(transaction, testContext.alice);
      await transaction.query("UPDATE memories SET created_by_agent_id = NULL WHERE id = $1", [
        memory.id,
      ]);
    }),
  ).rejects.toThrow(/Memory identity and provenance are immutable/);
  await expect(memories.retrieve(testContext.alice, memory.id)).resolves.toMatchObject({
    createdByAgentId: agent.id,
  });

  await access.addMember(testContext.carol, testContext.alice.userId, { role: "member" });
  const researchAlice = {
    userId: testContext.alice.userId,
    workspaceId: testContext.carol.workspaceId,
  };
  await access.grantAgent(researchAlice, agent.id, { permission: "write" });
  const researchAgentActor = await access.authenticateAgent(
    credential.token,
    researchAlice.workspaceId,
  );
  if (!researchAgentActor) throw new Error("Expected Agent credential in second Workspace");
  const researchMemory = await memories.remember(researchAgentActor, {
    content: "The research plan remains available after Agent deletion.",
    scope: "private",
  });

  await expect(access.deleteAgent(testContext.alice, agent.id)).resolves.toBe("must_disable");
  await access.updateAgent(testContext.alice, agent.id, { status: "disabled" });
  await expect(access.deleteAgent(testContext.alice, agent.id)).resolves.toBe("deleted");

  await expect(access.listAgents(testContext.alice)).resolves.toEqual([]);
  await expect(access.listAgents(researchAlice)).resolves.toEqual([]);
  await expect(
    access.authenticateAgent(credential.token, testContext.alice.workspaceId),
  ).resolves.toBeNull();
  await expect(memories.retrieve(testContext.alice, memory.id)).resolves.toMatchObject({
    id: memory.id,
    content: memory.content,
    createdByAgentId: null,
    version: memory.version + 1,
    updatedAt: memory.updatedAt,
  });
  await expect(memories.retrieve(researchAlice, researchMemory.id)).resolves.toMatchObject({
    id: researchMemory.id,
    content: researchMemory.content,
    createdByAgentId: null,
    version: researchMemory.version + 1,
    updatedAt: researchMemory.updatedAt,
  });

  await testContext.close();
});

async function agentCitation() {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const memories = createMemoryModule(testContext.database);
  const code = createCodeIndexModule(testContext.database);
  const evidence = createCodeEvidenceModule(testContext.database);
  const agent = await access.createAgentForWorkspace(testContext.alice, {
    name: "Citing assistant",
    permission: "write",
  });
  const credential = await access.issueAgentCredential(testContext.alice, agent.id);
  const agentActor = await access.authenticateAgent(
    credential.token,
    testContext.alice.workspaceId,
  );
  if (!agentActor) throw new Error("Expected Agent credential to authenticate");
  const memory = await memories.remember(agentActor, {
    content: "The release guard is implemented in the cited declaration.",
    scope: "private",
  });
  const repositoryKey = "corespeed/agent-citation";
  const commitOid = "a".repeat(40);
  await code.indexRevision(testContext.alice, {
    repositoryKey,
    displayName: "Agent citation",
    commitOid,
    files: [{ path: "src/guard.ts", content: "export function releaseGuard() { return true; }\n" }],
  });
  const [artifact] = await code.search(testContext.alice, {
    repositoryKey,
    commitOid,
    query: "releaseGuard",
  });
  if (!artifact) throw new Error("Expected releaseGuard Artifact");
  const citation = await evidence.cite(agentActor, {
    memoryId: memory.id,
    artifactId: artifact.id,
    relationship: "supports",
  });
  expect(citation.createdByAgentId).toBe(agent.id);
  return { access, agent, citation, testContext };
}

// Every anchor column except created_by_agent_id, with a value that differs.
const anchorMutations = [
  ["id", "gen_random_uuid()"],
  ["workspace_id", "gen_random_uuid()"],
  ["memory_id", "gen_random_uuid()"],
  ["repository_id", "gen_random_uuid()"],
  ["cited_revision_id", "gen_random_uuid()"],
  ["cited_generation_id", "gen_random_uuid()"],
  ["cited_artifact_id", "gen_random_uuid()"],
  ["cited_commit_oid", "repeat('b', 40)"],
  ["relationship", "'contradicts'"],
  ["cited_path", "'src/other.ts'"],
  ["cited_symbol_key", "'src/other.ts#other'"],
  ["cited_declaration_key", "'src/other.ts#other@1'"],
  ["cited_declaration_chunk_ordinal", "7"],
  ["cited_declaration_context_sha256", "repeat('c', 64)"],
  ["cited_content_sha256", "repeat('d', 64)"],
  ["created_by_user_id", "'10000000-0000-4000-8000-000000000002'"],
  ["created_at", "created_at - interval '1 day'"],
] as const;

test("Deleting a disabled Agent that cited Code Evidence keeps the citation without provenance", async () => {
  const { access, agent, citation, testContext } = await agentCitation();

  // While the Agent exists, its provenance cannot be cleared by any role.
  for (const database of [testContext.database, testContext.adminDatabase]) {
    await expect(
      database.transaction(async (transaction) => {
        await installActorContext(transaction, testContext.alice);
        await transaction.query(
          "UPDATE memory_code_evidence SET created_by_agent_id = NULL WHERE id = $1",
          [citation.id],
        );
      }),
    ).rejects.toThrow(/Memory Code Evidence anchors are immutable/);
  }

  await access.updateAgent(testContext.alice, agent.id, { status: "disabled" });
  await expect(access.deleteAgent(testContext.alice, agent.id)).resolves.toBe("deleted");

  const surviving = await testContext.adminDatabase.transaction((transaction) =>
    transaction.query<{
      created_by_agent_id: string | null;
      created_by_user_id: string;
      cited_artifact_id: string;
    }>(
      `SELECT created_by_agent_id, created_by_user_id, cited_artifact_id
       FROM memory_code_evidence
       WHERE id = $1`,
      [citation.id],
    ),
  );
  expect(surviving.rows).toEqual([
    {
      created_by_agent_id: null,
      created_by_user_id: testContext.alice.userId,
      cited_artifact_id: citation.citedArtifactId,
    },
  ]);
  // A cleared reference cannot be pointed at another Agent afterwards.
  const other = await access.createAgentForWorkspace(testContext.alice, {
    name: "Other assistant",
    permission: "write",
  });
  await expect(
    testContext.adminDatabase.transaction((transaction) =>
      transaction.query("UPDATE memory_code_evidence SET created_by_agent_id = $1 WHERE id = $2", [
        other.id,
        citation.id,
      ]),
    ),
  ).rejects.toThrow(/Memory Code Evidence anchors are immutable/);
});

test.each(anchorMutations)(
  "Memory Code Evidence anchor column %s stays immutable",
  async (column, value) => {
    const { citation, testContext } = await agentCitation();
    await expect(
      testContext.adminDatabase.transaction((transaction) =>
        transaction.query(`UPDATE memory_code_evidence SET ${column} = ${value} WHERE id = $1`, [
          citation.id,
        ]),
      ),
    ).rejects.toThrow(/Memory Code Evidence anchors are immutable/);
  },
);

test("A suspended owner Membership denies the owner's Agents until it is reactivated", async () => {
  const testContext = await createMemoryTestContext();
  const access = createAccessModule(testContext.database);
  const agent = await access.createAgentForWorkspace(testContext.bob, {
    name: "Member assistant",
    permission: "write",
  });
  const credential = await access.issueAgentCredential(testContext.bob, agent.id);
  const app = createApi({
    database: () => testContext.database,
    memoryOptions: () => ({}),
    codeRepositories: () => ({}),
  });
  const capabilities = () =>
    app.request(
      new Request("http://lore.local/api/v1/capabilities", {
        headers: {
          authorization: `Bearer ${credential.token}`,
          "x-lore-workspace-id": testContext.bob.workspaceId,
        },
      }),
    );

  await expect(
    access.authenticateAgent(credential.token, testContext.bob.workspaceId),
  ).resolves.toMatchObject({ agentId: agent.id, userId: testContext.bob.userId });
  expect((await capabilities()).status).toBe(200);

  await testContext.suspendMembership(testContext.bob);
  await expect(
    access.authenticateAgent(credential.token, testContext.bob.workspaceId),
  ).resolves.toBeNull();
  const denied = await capabilities();
  expect(denied.status).toBe(403);
  await expect(denied.json()).resolves.toMatchObject({ code: "access_denied" });

  await access.addMember(testContext.alice, testContext.bob.userId, { role: "member" });
  await expect(
    access.authenticateAgent(credential.token, testContext.bob.workspaceId),
  ).resolves.toMatchObject({ agentId: agent.id });
  expect((await capabilities()).status).toBe(200);
});
