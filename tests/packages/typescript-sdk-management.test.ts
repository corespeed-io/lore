import type {
  AgentCredential,
  AgentWorkspaceGrant,
  HumanActor,
  IssuedAgentCredential,
  LoreWorkspaceClient,
  WorkspaceAgent,
  WorkspaceArchive,
  WorkspaceImportResult,
} from "@corespeed/lore-sdk";
import { LoreApiError, LoreClient } from "@corespeed/lore-sdk";
import { expect, test, vi } from "vitest";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "20000000-0000-4000-8000-000000000001";
const CREDENTIAL_ID = "30000000-0000-4000-8000-000000000001";
const USER_ID = "40000000-0000-4000-8000-000000000001";
const TIMESTAMP = "2026-09-15T00:00:00.000Z";
const actor: HumanActor = { kind: "human", userId: USER_ID };
const agent: WorkspaceAgent = {
  id: AGENT_ID,
  ownerUserId: USER_ID,
  name: "Reader",
  status: "active",
  permission: "read",
  grantStatus: "active",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const credential: AgentCredential = {
  id: CREDENTIAL_ID,
  agentId: AGENT_ID,
  prefix: "lore_agent_1234",
  createdAt: TIMESTAMP,
  lastUsedAt: null,
  revokedAt: null,
};
const issued: IssuedAgentCredential = {
  id: CREDENTIAL_ID,
  prefix: credential.prefix,
  token: `lore_agent_${"a".repeat(64)}`,
};
const grant: AgentWorkspaceGrant = {
  workspaceId: WORKSPACE_ID,
  agentId: AGENT_ID,
  permission: "write",
  status: "active",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const archive: WorkspaceArchive = {
  manifest: {
    checksum: "a".repeat(64),
    exportedAt: TIMESTAMP,
    format: "lore-workspace-v1",
    memoryCount: 0,
    linkCount: 0,
    sourceDeploymentId: WORKSPACE_ID,
    sourceWorkspaceId: WORKSPACE_ID,
    visibility: "actor-visible",
  },
  memories: [],
  links: [],
};
const importInput = {
  archive,
  conflictPolicy: "remap",
  dryRun: true,
  ownerMap: { [USER_ID]: USER_ID },
} as const;
const importResult: WorkspaceImportResult = {
  archiveChecksum: archive.manifest.checksum,
  dryRun: true,
  importedLinks: 0,
  importedMemories: 0,
  memoryIdMap: {},
  replayed: false,
  skippedMemories: 0,
};

const managementCalls: Array<{
  name: string;
  call: (workspace: LoreWorkspaceClient, signal: AbortSignal) => Promise<unknown>;
  path: string;
  method: string;
  body?: unknown;
  result?: unknown;
  status?: number;
}> = [
  {
    name: "human identity",
    call: (workspace, signal) => workspace.getCurrentHumanActor(signal),
    path: "actor",
    method: "GET",
    result: actor,
  },
  {
    name: "Agent listing",
    call: (workspace, signal) => workspace.listAgents(signal),
    path: "agents",
    method: "GET",
    result: [agent],
  },
  {
    name: "Agent creation",
    call: (workspace, signal) =>
      workspace.createAgent({ name: "Reader", permission: "read" }, signal),
    path: "agents",
    method: "POST",
    body: { name: "Reader", permission: "read" },
    result: agent,
    status: 201,
  },
  {
    name: "Agent update",
    call: (workspace, signal) => workspace.updateAgent(AGENT_ID, { status: "disabled" }, signal),
    path: `agents/${AGENT_ID}`,
    method: "PATCH",
    body: { status: "disabled" },
    result: { ...agent, status: "disabled" },
  },
  {
    name: "Agent deletion",
    call: (workspace, signal) => workspace.deleteAgent(AGENT_ID, signal),
    path: `agents/${AGENT_ID}`,
    method: "DELETE",
    status: 204,
  },
  {
    name: "credential listing",
    call: (workspace, signal) => workspace.listAgentCredentials(AGENT_ID, signal),
    path: `agents/${AGENT_ID}/credentials`,
    method: "GET",
    result: [credential],
  },
  {
    name: "credential issuance",
    call: (workspace, signal) => workspace.issueAgentCredential(AGENT_ID, signal),
    path: `agents/${AGENT_ID}/credentials`,
    method: "POST",
    result: issued,
    status: 201,
  },
  {
    name: "credential revocation",
    call: (workspace, signal) => workspace.revokeAgentCredential(CREDENTIAL_ID, signal),
    path: `agent-credentials/${CREDENTIAL_ID}`,
    method: "DELETE",
    status: 204,
  },
  {
    name: "grant update",
    call: (workspace, signal) => workspace.setAgentGrant(AGENT_ID, "write", signal),
    path: `agents/${AGENT_ID}/grant`,
    method: "PUT",
    body: { permission: "write" },
    result: grant,
  },
  {
    name: "grant revocation",
    call: (workspace, signal) => workspace.revokeAgentGrant(AGENT_ID, signal),
    path: `agents/${AGENT_ID}/grant`,
    method: "DELETE",
    status: 204,
  },
  {
    name: "Workspace export",
    call: (workspace, signal) => workspace.exportWorkspace(signal),
    path: "workspaces/export",
    method: "GET",
    result: archive,
  },
  {
    name: "Workspace import",
    call: (workspace, signal) => workspace.importWorkspace(importInput, signal),
    path: "workspaces/import",
    method: "POST",
    body: importInput,
    result: importResult,
  },
];

test.each(managementCalls)(
  "SDK $name preserves the management HTTP contract",
  async (operation) => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`https://lore.example.test/nested/api/v1/${operation.path}`);
      expect(init?.method ?? "GET").toBe(operation.method);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-lore-workspace-id")).toBe(WORKSPACE_ID);
      expect(headers.get("authorization")).toBe(`Basic ${btoa("lore:password")}`);
      expect(headers.get("content-type")).toBe(operation.body ? "application/json" : null);
      expect(init?.body ? JSON.parse(String(init.body)) : undefined).toEqual(operation.body);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return operation.status === 204
        ? new Response(null, { status: 204 })
        : Response.json(operation.result, { status: operation.status ?? 200 });
    });
    const workspace = new LoreClient({
      baseUrl: "https://lore.example.test/nested/",
      auth: { type: "basic", password: "password" },
      fetch,
    }).workspace(WORKSPACE_ID);

    await expect(operation.call(workspace, new AbortController().signal)).resolves.toEqual(
      operation.result,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test("human-only management leaves authorization to the server and preserves its error", async () => {
  const fetch = vi.fn(async () =>
    Response.json({ code: "access_denied", error: "Human Actor required" }, { status: 403 }),
  );
  const workspace = new LoreClient({
    baseUrl: "https://lore.example.test",
    auth: { type: "agent", token: issued.token },
    fetch,
  }).workspace(WORKSPACE_ID);

  await expect(workspace.getCurrentHumanActor()).rejects.toMatchObject({
    name: "LoreApiError",
    status: 403,
    code: "access_denied",
    message: "Human Actor required",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("credential issuance does not retry an ambiguous transport failure", async () => {
  const fetch = vi.fn(async () => {
    throw new TypeError("connection closed");
  });
  const workspace = new LoreClient({ baseUrl: "https://lore.example.test", fetch }).workspace(
    WORKSPACE_ID,
  );

  await expect(workspace.issueAgentCredential(AGENT_ID)).rejects.toBeInstanceOf(LoreApiError);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("management identifiers are validated before any request", async () => {
  const fetch = vi.fn();
  const workspace = new LoreClient({ baseUrl: "https://lore.example.test", fetch }).workspace(
    WORKSPACE_ID,
  );

  await expect(workspace.updateAgent("../other-agent", { name: "Reader" })).rejects.toThrow(
    "agentId must be a UUID",
  );
  await expect(workspace.revokeAgentCredential("../other-credential")).rejects.toThrow(
    "credentialId must be a UUID",
  );
  expect(fetch).not.toHaveBeenCalled();
});

test("Workspace export can read archives beyond the ordinary response cap while errors remain bounded", async () => {
  const headers = { "content-length": String(129 * 1024 * 1024) };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(archive, { headers }))
    .mockResolvedValueOnce(Response.json({ error: "failed" }, { headers, status: 500 }))
    .mockResolvedValueOnce(Response.json([], { headers }));
  const client = new LoreClient({ baseUrl: "https://lore.example.test", fetch });
  const workspace = client.workspace(WORKSPACE_ID);
  await expect(workspace.exportWorkspace()).resolves.toEqual(archive);
  await expect(workspace.exportWorkspace()).rejects.toMatchObject({
    status: 500,
    code: "invalid_response",
  });
  await expect(client.listWorkspaces()).rejects.toMatchObject({
    status: 200,
    code: "invalid_response",
  });
});
